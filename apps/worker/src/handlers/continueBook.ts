import {
  continuationChapterPlans,
  continuationOutlineAiSchema,
  continuationPageIndexes,
  distributeContinuationPages,
  fallbackContinuationOutline,
  type ContinuationOutline,
  CONTINUATION_EXCERPT_GUARD
} from "./continueBookSupport.js";
import {
  getProjectOrThrow,
  invalidateProjectExports,
  nextPlanVersion,
  planInputSnapshot,
  strategyForInput,
  toPriorPageContext
} from "../generation/bookHelpers.js";
import { loadContinuityNotes } from "../generation/generationContext.js";
import { storeEmbedding } from "../generation/semanticMemory.js";
import { importStyleProfileFromMediaSettings } from "./importBookSupport.js";
import { inputForPlanVersion } from "../generation/projectInput.js";
import { createLoggedProviders } from "../providers/loggedAdapters.js";
import { config } from "../runtime/config.js";
import { maybeEnqueueCompile } from "../runtime/dispatch.js";
import { advanceJobStep } from "../runtime/jobLifecycle.js";
import { bookPlanSchema, createProviders, generateJsonWithRetry, type BookPlan, type TextModelAdapter } from "@book-maker/core";
import { prisma } from "@book-maker/db";
import { Job } from "bullmq";

/**
 * `continue-book` job: outline and write additional chapters onto a finished book.
 */

export async function continueBook(job: Job) {
  const { projectId, operationId, request, planId } = job.data as {
    projectId: string;
    operationId: string;
    request: string;
    planId?: string;
  };
  const generationJobId = job.data.generationJobId as string | undefined;
  const chapterCount = Math.min(8, Math.max(1, Math.floor(Number(job.data.chapterCount) || 1)));
  const requestedPageCount = Math.max(chapterCount, Math.floor(Number(job.data.newPageCount) || chapterCount * 5));

  const operation = await prisma.bookEditOperation.findUnique({ where: { id: operationId } });
  if (!operation) {
    throw new Error("Book edit operation not found");
  }
  await prisma.bookEditOperation.update({ where: { id: operationId }, data: { status: "ACTIVE" } });
  await prisma.project.update({ where: { id: projectId }, data: { status: "EDITING" } });
  await advanceJobStep(generationJobId, "outline", 15, "Outlining new chapters");

  const project = await getProjectOrThrow(projectId);
  const basePlanVersion = planId
    ? await prisma.planVersion.findUnique({ where: { id: planId } })
    : project.currentPlanId
      ? await prisma.planVersion.findUnique({ where: { id: project.currentPlanId } })
      : null;
  if (!basePlanVersion) {
    throw new Error("Current plan not found");
  }
  const input = inputForPlanVersion(project, basePlanVersion.inputSnapshot);
  const plan = bookPlanSchema.parse(basePlanVersion.planningPackage);
  const strategy = strategyForInput(input);
  const providers = createLoggedProviders(job, createProviders(config, input), input);

  const trailingPagesDesc = await prisma.page.findMany({
    where: { projectId, status: "COMPLETED" },
    orderBy: { index: "desc" },
    take: 12
  });
  if (trailingPagesDesc.length === 0) {
    throw new Error("This book has no finished pages to continue from");
  }
  const lastPageIndex =
    (await prisma.page.findFirst({ where: { projectId }, orderBy: { index: "desc" }, select: { index: true } }))
      ?.index ?? 0;
  const lastChapterIndex =
    (await prisma.chapter.findFirst({ where: { projectId }, orderBy: { index: "desc" }, select: { index: true } }))
      ?.index ?? plan.chapters.length;
  const startChapterIndex = Math.max(lastChapterIndex, plan.chapters.at(-1)?.index ?? 0) + 1;
  const trailingPages = [...trailingPagesDesc].reverse();
  const styleProfile = importStyleProfileFromMediaSettings(project.mediaSettings);

  const outline = await continuationOutlineWithModel({
    plan,
    request,
    chapterCount,
    styleProfile,
    trailingPages,
    language: project.language,
    textModel: providers.text
  });
  const pageDistribution = distributeContinuationPages(requestedPageCount, outline.chapters.length);
  const newChapterPlans = continuationChapterPlans(plan, outline, pageDistribution, startChapterIndex);
  const newPageIndexes = continuationPageIndexes(lastPageIndex, pageDistribution);
  const extendedPlan = bookPlanSchema.parse({ ...plan, chapters: [...plan.chapters, ...newChapterPlans] });
  const totalPages = lastPageIndex + newPageIndexes.length;

  const version = await nextPlanVersion(projectId);
  const newPlanVersion = await prisma.$transaction(async (tx) => {
    await tx.planVersion.update({ where: { id: basePlanVersion.id }, data: { status: "SUPERSEDED" } });
    const created = await tx.planVersion.create({
      data: {
        projectId,
        version,
        status: "APPROVED",
        approvedAt: new Date(),
        planningPackage: extendedPlan,
        inputSnapshot: planInputSnapshot({ ...input, targetPages: totalPages }),
        messages: [
          { role: "user", content: `Continue the book: ${request}`.slice(0, 2000), at: new Date().toISOString() }
        ]
      }
    });
    await tx.project.update({
      where: { id: projectId },
      data: { currentPlanId: created.id, targetPages: totalPages }
    });
    let pageCursor = lastPageIndex;
    for (const chapterPlan of newChapterPlans) {
      const chapter = await tx.chapter.create({
        data: {
          projectId,
          index: chapterPlan.index,
          title: chapterPlan.title,
          summary: chapterPlan.summary,
          targetPages: chapterPlan.targetPages,
          status: "PENDING"
        }
      });
      await tx.page.createMany({
        data: Array.from({ length: chapterPlan.targetPages }, (_, offset) => ({
          projectId,
          chapterId: chapter.id,
          index: pageCursor + offset + 1,
          title: `Page ${pageCursor + offset + 1}`,
          markdown: "",
          summary: "",
          status: "PENDING"
        }))
      });
      pageCursor += chapterPlan.targetPages;
    }
    return created;
  });

  try {
    await advanceJobStep(generationJobId, "draft", 30, "Writing new pages", {
      done: 0,
      total: newPageIndexes.length
    });
    const continuityNotes = await loadContinuityNotes(projectId);
    const earlierSummaries = await prisma.page.findMany({
      where: { projectId, index: { lte: lastPageIndex }, status: "COMPLETED" },
      orderBy: { index: "asc" },
      select: { summary: true }
    });
    const previousSummaries = earlierSummaries.map((page) => page.summary).filter(Boolean).slice(-40);
    const previousPages = trailingPages.map(toPriorPageContext);

    let drafted = 0;
    for (const chapterPlan of newChapterPlans) {
      const chapter = await prisma.chapter.findUnique({
        where: { projectId_index: { projectId, index: chapterPlan.index } }
      });
      for (let offset = 0; offset < chapterPlan.targetPages; offset += 1) {
        const pageIndex = newPageIndexes[drafted]!;
        await advanceJobStep(
          generationJobId,
          "draft",
          30 + Math.round((drafted / Math.max(newPageIndexes.length, 1)) * 45),
          `Writing page ${pageIndex}`,
          { done: drafted, total: newPageIndexes.length, pageIndex }
        );
        const draft = await strategy.generatePageDraft({
          input,
          plan: extendedPlan,
          chapter: chapterPlan,
          pageIndex,
          previousSummaries: [...previousSummaries, ...previousPages.map((page) => page.summary)].slice(-40),
          previousPages: previousPages.slice(-6),
          continuityNotes,
          researchNotes: [],
          textModel: providers.text
        });
        const saved = await prisma.page.update({
          where: { projectId_index: { projectId, index: pageIndex } },
          data: {
            title: draft.title,
            markdown: draft.markdown,
            summary: draft.summary,
            status: "COMPLETED"
          }
        });
        if (draft.continuityNotes.length > 0) {
          await prisma.continuityNote.createMany({
            data: draft.continuityNotes.map((body) => ({
              projectId,
              scope: `page:${pageIndex}:continue:${operationId}`,
              body,
              tags: ["page", String(pageIndex), "continue"]
            }))
          });
        }
        await storeEmbedding(projectId, `page:${pageIndex}`, saved.id, saved.summary, providers.embedding);
        previousPages.push({ index: pageIndex, title: saved.title, markdown: saved.markdown, summary: saved.summary });
        drafted += 1;
      }
      if (chapter) {
        await prisma.chapter.update({ where: { id: chapter.id }, data: { status: "COMPLETED" } });
      }
    }

    await advanceJobStep(generationJobId, "save", 82, "Saving chapters");
    await prisma.bookEditOperation.update({
      where: { id: operationId },
      data: { status: "APPLIED", affectedPageIndexes: newPageIndexes, appliedAt: new Date() }
    });
    await prisma.project.update({
      where: { id: projectId },
      data: { status: "COMPLETE", contentRevision: { increment: 1 } }
    });
    await advanceJobStep(generationJobId, "export", 90, "Refreshing exports");
    await invalidateProjectExports(projectId);
    await maybeEnqueueCompile(projectId, newPlanVersion.id);
  } catch (error) {
    // Roll the append back so a retry starts from the original book state.
    await prisma
      .$transaction(async (tx) => {
        await tx.page.deleteMany({ where: { projectId, index: { gt: lastPageIndex } } });
        await tx.chapter.deleteMany({ where: { projectId, index: { gte: startChapterIndex } } });
        await tx.embedding.deleteMany({
          where: { projectId, scope: { in: newPageIndexes.map((index) => `page:${index}`) } }
        });
        await tx.project.update({
          where: { id: projectId },
          data: { currentPlanId: basePlanVersion.id, targetPages: project.targetPages }
        });
        await tx.planVersion.update({ where: { id: basePlanVersion.id }, data: { status: "APPROVED" } });
        await tx.planVersion.delete({ where: { id: newPlanVersion.id } });
      })
      .catch((cleanupError) => {
        console.error(`Continuation cleanup failed for project ${projectId}`, cleanupError);
      });
    throw error;
  }
}

export async function continuationOutlineWithModel(options: {
  plan: BookPlan;
  request: string;
  chapterCount: number;
  styleProfile: Record<string, unknown> | null;
  trailingPages: Array<{ index: number; title: string; markdown: string; summary: string }>;
  language: string;
  textModel: TextModelAdapter;
}): Promise<ContinuationOutline> {
  const excerpt = options.trailingPages
    .slice(-2)
    .map((page) => `Page ${page.index} — ${page.title}\n${page.markdown}`)
    .join("\n\n")
    .slice(-6000);
  const recentSummaries = options.trailingPages.map((page) => `${page.index}: ${page.summary}`).join("\n");
  try {
    const result = await generateJsonWithRetry(options.textModel, {
      purpose: "generate-chapter-brief",
      temperature: 0.4,
      maxTokens: 1600,
      schema: continuationOutlineAiSchema,
      messages: [
        {
          role: "system",
          content:
            `You outline the next chapters of an existing book so a writer can continue it in the author's voice. Propose exactly ${options.chapterCount} new chapter(s) that pick up where the book ends and satisfy the author's directive. Write titles and summaries in the book's language ("${options.language}"). ${CONTINUATION_EXCERPT_GUARD}`
        },
        {
          role: "user",
          content: JSON.stringify({
            premise: options.plan.premise,
            voiceGuide: options.plan.voiceGuide,
            existingChapters: options.plan.chapters.map((chapter) => ({
              index: chapter.index,
              title: chapter.title,
              summary: chapter.summary
            })),
            styleProfile: options.styleProfile,
            recentPageSummaries: recentSummaries,
            finalPagesExcerpt: excerpt,
            authorDirective: options.request
          })
        }
      ]
    });
    if (result.data.chapters.length > 0) {
      return { chapters: result.data.chapters.slice(0, options.chapterCount) };
    }
  } catch (error) {
    console.warn(`Continuation outline model call failed; using fallback`, error);
  }
  return fallbackContinuationOutline(options.request, options.chapterCount);
}
