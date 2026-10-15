import { getProjectOrThrow, nextPlanVersion, planInputSnapshot, strategyForInput } from "../generation/bookHelpers.js";
import { storeEmbedding, strategyUsesSemanticMemory } from "../generation/embeddingWrites.js";
import {
  importChapterRows,
  importStats,
  mediaSettingsWithImportStyle,
  normalizeImportedLanguage,
  screenRestoredImportMatter,
  type RefusedImportMatterField
} from "./importBookSupport.js";
import { inputFromProject } from "../generation/projectInput.js";
import { createLoggedProviders } from "../providers/loggedAdapters.js";
import { createRunLogger } from "../providers/runLogging.js";
import { config } from "../runtime/config.js";
import { claimImportCompletion, importCompletion, ImportSupersededError } from "../runtime/importCompletion.js";
import type { JobCompletion } from "../runtime/jobTypes.js";
import { advanceJobStep } from "../runtime/jobLifecycle.js";
import {
  analyzeManuscriptStyle,
  bookMatterForImportedManuscript,
  createProviders,
  errorMessage,
  parseManuscript,
  segmentManuscript,
  synthesizeImportedBookPlan,
  type ManuscriptImportFormat
} from "@book-maker/core";
import { pageScope, Prisma, prisma } from "@book-maker/db";
import { readCopyrightRestrictionsEnabled } from "@book-maker/db/safetySettings";
import type { ImportBookJob } from "../runtime/jobPayloads.js";
import { objectKey, objectStore } from "@book-maker/storage";

/**
 * `import-book` job: parse an uploaded manuscript into chapters, pages and a plan.
 */

/** The run-log event a legacy import writes when it drops restored matter the screen refused. */
export const IMPORT_MATTER_REFUSED_EVENT = "import.matter_refused";

export async function importBook(job: ImportBookJob): Promise<JobCompletion> {
  const { projectId, importId, generationJobId } = job.data;
  const payloadLanguage = job.data.language?.trim() || null;
  const bookImport = await prisma.bookImport.findUnique({ where: { id: importId } });
  if (!bookImport) {
    throw new Error("Book import not found");
  }
  if (bookImport.status === "COMPLETE") {
    return importCompletion(job, Boolean((bookImport.stats as Record<string, unknown> | null)?.completion));
  }
  const project = await getProjectOrThrow(projectId);
  try {
    await prisma.bookImport.updateMany({ where: { id: importId, status: { not: "COMPLETE" } }, data: { status: "PARSING", error: null } });
    await advanceJobStep(generationJobId, "read", 10, "Reading your manuscript");
    const data = await objectStore().get(objectKey("attachments", importId, "source"));
    if (!data) {
      throw new Error("The uploaded manuscript file is no longer available. Import the book again.");
    }
    // Keep the upload's exact hints, including an empty list. Presentation
    // edits may have changed the byline while this import waited or retried.
    // Legacy jobs have no snapshot; preserve their existing best-effort hint.
    const knownAuthors = job.data.knownAuthors ?? (project.authorName?.trim() ? [project.authorName.trim()] : []);
    const parsed = await parseManuscript({
      data,
      format: bookImport.format as ManuscriptImportFormat,
      knownAuthors
    });

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
    await advanceJobStep(generationJobId, "save", 85, "Saving your book");
    const rows = importChapterRows(segmented);
    const language = payloadLanguage ?? normalizeImportedLanguage(style.detectedLanguage, project.language);
    const version = await nextPlanVersion(projectId);
    // Only legacy jobs can restore matter here; current uploads already stored
    // their screened snapshot. Read policy before opening the publication lock.
    const copyrightRestrictions = job.data.knownAuthors === undefined
      ? await readCopyrightRestrictionsEnabled(prisma)
      : false;
    const { refusedMatter } = await prisma.$transaction(
      async (tx) => {
        // Matter edits take this same lock. Parsing can outlast a reader edit,
        // so merge only onto the row that actually owns the publication.
        await tx.$queryRaw`SELECT "id" FROM "Project" WHERE "id" = ${projectId} FOR UPDATE`;
        const live = await tx.project.findUniqueOrThrow({ where: { id: projectId } });
        // Another delivery may have committed while this one parsed. The
        // receipt and lifecycle verdict survive together; never insert twice.
        const receipt = await tx.bookImport.findUnique({ where: { id: importId } });
        if (receipt?.status === "COMPLETE") return { refusedMatter: [] };
        await claimImportCompletion(tx, job, project, live);
        // The old upload API saved no extracted metadata. New uploads carry
        // knownAuthors (even []), and have already saved their own matter.
        // Any non-null legacy matter, including {}, is a reader's snapshot;
        // missing fields in it may be intentional clears and must stay absent.
        const extracted = job.data.knownAuthors === undefined && live.bookMatter === null
          ? bookMatterForImportedManuscript({}, {
              ...parsed.matter,
              // Copyright holder omission means "use the book's byline".
              // Normalize against the byline we will keep, so retaining a
              // reader's name cannot change the manuscript's © attribution.
              ...(live.authorName !== null ? { byline: live.authorName } : {})
            })
          : {};
        // The live row decides what is restored. Screen only that write, so an
        // intentionally cleared/replaced field cannot be resurrected or refused
        // because of obsolete text still present in the uploaded source. A
        // refused field is dropped alone; the import goes on. The screen is a
        // pure pass over capped fields — its one read, the flag, ran above.
        const screened = screenRestoredImportMatter({
          ...(live.authorName === null && extracted.authorName ? { authorName: extracted.authorName } : {}),
          ...(live.subtitle === null && extracted.subtitle ? { subtitle: extracted.subtitle } : {}),
          ...(extracted.bookMatter ? { bookMatter: extracted.bookMatter } : {})
        }, copyrightRestrictions);
        const restored = screened.restored;
        const imported = { ...live, ...restored };
        const mediaSettings = mediaSettingsWithImportStyle(live.mediaSettings, style);
        const updatedInput = inputFromProject({
          ...imported,
          targetPages: segmented.pageCount,
          language,
          mediaSettings
        });
        const plan = synthesizeImportedBookPlan({
          title: imported.title,
          ...(imported.subtitle ? { subtitle: imported.subtitle } : {}),
          segmented,
          style
        });
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
            ...restored,
            status: "COMPLETE",
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
          data: {
            status: "COMPLETE", error: null,
            stats: {
              ...importStats(parsed, segmented),
              completion: { planVersionId: planVersion.id, contentRevision: live.contentRevision + 1 }
            } as Prisma.InputJsonValue
          }
        });
        return { refusedMatter: screened.refused };
      },
      // Large manuscripts create hundreds of rows; give the transaction room.
      { timeout: 120_000 }
    );
    if (refusedMatter.length > 0) {
      await recordRefusedImportMatter(job, refusedMatter);
    }

    // The import is delivered. Neither optional retrieval I/O nor processor
    // bookkeeping may fail/refund its already committed pages.
    try {
      if (strategyUsesSemanticMemory(strategyForInput(input))) {
        const savedPages = await prisma.page.findMany({
          where: { projectId },
          select: { id: true, index: true, summary: true },
          orderBy: { index: "asc" }
        });
        for (const page of savedPages) {
          await storeEmbedding({ projectId, scope: pageScope(page.index), sourceId: page.id, text: page.summary }, providers.embedding);
        }
      }
    } catch (error) {
      console.error(`Optional import embeddings failed for ${importId}`, error);
    }
    return importCompletion(job);
  } catch (error) {
    if (error instanceof ImportSupersededError) throw error;
    await prisma.bookImport
      .updateMany({ where: { id: importId, status: { not: "COMPLETE" } }, data: { status: "FAILED", error: errorMessage(error) } })
      .catch(() => undefined);
    throw error;
  }
}

/**
 * Says which restored fields the screen dropped, by field and reason only —
 * the refused words stay out of the log. Never throws: the import is committed.
 */
async function recordRefusedImportMatter(job: ImportBookJob, refused: RefusedImportMatterField[]): Promise<void> {
  try {
    await createRunLogger(job).append(IMPORT_MATTER_REFUSED_EVENT, { fields: refused });
  } catch (error) {
    // `append` swallows its own write failures; building the logger can still throw on a malformed job.
    console.error(`Failed to write the ${IMPORT_MATTER_REFUSED_EVENT} run-log event`, error);
  }
}
