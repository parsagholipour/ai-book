import { getProjectOrThrow, nextPlanVersion, planInputSnapshot, strategyForInput } from "../generation/bookHelpers.js";
import { storeEmbedding, strategyUsesSemanticMemory } from "../generation/semanticMemory.js";
import { importChapterRows, importStats, mediaSettingsWithImportStyle, normalizeImportedLanguage } from "./importBookSupport.js";
import { inputFromProject } from "../generation/projectInput.js";
import { createLoggedProviders } from "../providers/loggedAdapters.js";
import { config } from "../runtime/config.js";
import { maybeEnqueueCompile } from "../runtime/dispatch.js";
import { advanceJobStep } from "../runtime/jobLifecycle.js";
import { errorMessage } from "../runtime/serialization.js";
import {
  analyzeManuscriptStyle,
  createProviders,
  parseManuscript,
  segmentManuscript,
  synthesizeImportedBookPlan,
  type ManuscriptImportFormat
} from "@book-maker/core";
import { Prisma, prisma } from "@book-maker/db";
import { Job } from "bullmq";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * `import-book` job: parse an uploaded manuscript into chapters, pages and a plan.
 */

export async function importBook(job: Job) {
  const { projectId, importId } = job.data as { projectId: string; importId: string };
  const generationJobId = job.data.generationJobId as string | undefined;
  const payloadLanguage =
    typeof job.data.language === "string" && job.data.language.trim() ? job.data.language.trim() : null;
  const bookImport = await prisma.bookImport.findUnique({ where: { id: importId } });
  if (!bookImport) {
    throw new Error("Book import not found");
  }
  const project = await getProjectOrThrow(projectId);
  try {
    await prisma.bookImport.update({ where: { id: importId }, data: { status: "PARSING", error: null } });
    await advanceJobStep(generationJobId, "read", 10, "Reading your manuscript");
    const data = await readFile(join(config.ATTACHMENT_STORAGE_DIR, importId, "source")).catch(() => null);
    if (!data) {
      throw new Error("The uploaded manuscript file is no longer available. Import the book again.");
    }
    const parsed = await parseManuscript({ data, format: bookImport.format as ManuscriptImportFormat });

    await advanceJobStep(generationJobId, "segment", 35, "Splitting into chapters");
    const input = inputFromProject(project);
    const providers = createLoggedProviders(job, createProviders(config, input), input);
    const segmented = await segmentManuscript(parsed, {
      chapterizeModel: providers.text,
      language: payloadLanguage ?? project.language
    });
    if (segmented.pageCount === 0) {
      throw new Error("No readable pages were found in that manuscript.");
    }

    await advanceJobStep(generationJobId, "analyze", 60, "Learning your writing style");
    const style = await analyzeManuscriptStyle(
      { text: parsed.text, language: payloadLanguage ?? undefined },
      { model: providers.text }
    );
    const plan = synthesizeImportedBookPlan({
      title: project.title,
      ...(project.subtitle ? { subtitle: project.subtitle } : {}),
      segmented,
      style
    });

    await advanceJobStep(generationJobId, "save", 85, "Saving your book");
    const rows = importChapterRows(segmented);
    const language = payloadLanguage ?? normalizeImportedLanguage(style.detectedLanguage, project.language);
    const mediaSettings = mediaSettingsWithImportStyle(project.mediaSettings, style);
    const updatedInput = inputFromProject({
      ...project,
      targetPages: segmented.pageCount,
      language,
      mediaSettings
    });
    const version = await nextPlanVersion(projectId);
    const planVersionId = await prisma.$transaction(
      async (tx) => {
        const planVersion = await tx.planVersion.create({
          data: {
            projectId,
            version,
            status: "APPROVED",
            approvedAt: new Date(),
            planningPackage: plan,
            inputSnapshot: planInputSnapshot(updatedInput),
            messages: []
          }
        });
        await tx.project.update({
          where: { id: projectId },
          data: {
            currentPlanId: planVersion.id,
            targetPages: segmented.pageCount,
            language,
            mediaSettings: mediaSettings as Prisma.InputJsonValue,
            contentRevision: { increment: 1 }
          }
        });
        for (const row of rows) {
          const chapter = await tx.chapter.create({
            data: {
              projectId,
              index: row.index,
              title: row.title,
              summary: row.summary,
              targetPages: row.targetPages,
              status: "COMPLETED"
            }
          });
          await tx.page.createMany({
            data: row.pages.map((page) => ({
              projectId,
              chapterId: chapter.id,
              index: page.index,
              title: page.title,
              markdown: page.markdown,
              summary: page.summary,
              status: "COMPLETED"
            }))
          });
        }
        await tx.bookImport.update({
          where: { id: importId },
          data: { status: "COMPLETE", stats: importStats(parsed, segmented) as Prisma.InputJsonValue }
        });
        return planVersion.id;
      },
      // Large manuscripts create hundreds of rows; give the transaction room.
      { timeout: 120_000 }
    );

    // Best-effort: page embeddings power "matching pages" edit targeting.
    const savedPages = await prisma.page.findMany({
      where: { projectId },
      select: { id: true, index: true, summary: true },
      orderBy: { index: "asc" }
    });
    // Only sequential-pages jobs query page embeddings; imported books whose
    // size routes elsewhere skip one embedding call per imported page.
    if (strategyUsesSemanticMemory(strategyForInput(input))) {
      for (const page of savedPages) {
        await storeEmbedding(projectId, `page:${page.index}`, page.id, page.summary, providers.embedding);
      }
    }

    await prisma.project.update({ where: { id: projectId }, data: { status: "COMPLETE" } });
    await maybeEnqueueCompile(projectId, planVersionId);
  } catch (error) {
    await prisma.bookImport
      .update({ where: { id: importId }, data: { status: "FAILED", error: errorMessage(error) } })
      .catch(() => undefined);
    throw error;
  }
}
