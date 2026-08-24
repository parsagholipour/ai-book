import { config } from "../runtime/config.js";
import { updateJobProgress } from "../runtime/jobLifecycle.js";
import { isStopRequestedError, type ExportPageForRepair, type IndexedPageDraft } from "../runtime/jobTypes.js";
import { cleanOptionalText } from "../runtime/serialization.js";
import { finalQaMessagesForPage } from "./finalQaPageTargets.js";
import {
  chapterBriefSchema,
  exportProvenancePaths,
  missingStyleLockIndexes,
  normalizePlanPageTargets,
  pagesForStyleExcerpts,
  pinStyleExcerpts,
  resolveBookGenerationStrategy,
  reviewPageDraftLocally,
  sampleExcerptsFromInput,
  type BookGenerationStrategy,
  type BookPlan,
  type ChapterBrief,
  type ChapterPlan,
  type CreateProjectInput,
  type FinalBookQa,
  type GeneratedImageBytes,
  type OptimizedImage,
  type PageQualityReport,
  type PriorPageContext,
  type QualityFeatureId,
  type TextModelAdapter
} from "@book-maker/core";
import { Prisma, prisma } from "@book-maker/db";
import { rm } from "node:fs/promises";
import { join } from "node:path";

/**
 * Shared plan, page and export helpers used by more than one job handler.
 */

export async function getProjectOrThrow(projectId: string) {
  const project = await prisma.project.findUnique({ where: { id: projectId } });
  if (!project) {
    throw new Error(`Project ${projectId} not found`);
  }
  return project;
}

export function planInputSnapshot(input: CreateProjectInput): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(input)) as Prisma.InputJsonValue;
}

export function planMediaSettingsSnapshot(input: CreateProjectInput): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(input.mediaSettings)) as Prisma.InputJsonValue;
}

export function coverMetadataFromProject(
  project: { title: string; subtitle?: string | null; authorName?: string | null; coverTagline?: string | null },
  plan: BookPlan
) {
  return {
    title: cleanOptionalText(project.title) ?? plan.title,
    subtitle: cleanOptionalText(project.subtitle) ?? cleanOptionalText(plan.subtitle),
    authorName: cleanOptionalText(project.authorName),
    coverTagline: cleanOptionalText(project.coverTagline)
  };
}

export function strategyForInput(input: CreateProjectInput): BookGenerationStrategy {
  const resolved = resolveBookGenerationStrategy(input);
  for (const warning of resolved.warnings) {
    console.warn(`[strategy] ${warning}`);
  }
  return resolved.strategy;
}

/**
 * The number the project's next `PlanVersion` takes.
 *
 * `client` is how a caller derives it *inside* its own transaction, and the
 * default is the only reason it is optional. `@@unique([projectId, version])`
 * means this read and the `create` it feeds are one operation: read outside the
 * transaction that writes, and any plan version another writer commits in
 * between turns the create into a `23505` that rolls the whole transaction
 * back. `pageRestructure.ts` passes its `tx` for exactly that reason — see the
 * note above `applyStructuralPageChange`.
 */
export async function nextPlanVersion(
  projectId: string,
  client: Prisma.TransactionClient = prisma
): Promise<number> {
  const latest = await client.planVersion.findFirst({
    where: { projectId },
    orderBy: { version: "desc" }
  });
  return (latest?.version ?? 0) + 1;
}

export function chapterSetupsForPlan(
  plan: BookPlan,
  targetPages: number
): Array<{ chapter: ChapterPlan; startPage: number; endPage: number }> {
  let nextPageIndex = 1;
  return normalizedChapters(plan, targetPages).map((chapter) => {
    const startPage = nextPageIndex;
    const endPage = Math.min(targetPages, startPage + chapter.targetPages - 1);
    nextPageIndex = endPage + 1;
    return { chapter, startPage, endPage };
  });
}

export function normalizedChapters(plan: BookPlan, targetPages: number): ChapterPlan[] {
  return normalizePlanPageTargets(plan, targetPages).chapters;
}

export type ReviewedWholeBookPage = {
  draft: IndexedPageDraft;
  qualityReport: PageQualityReport;
  revision: number;
};

/**
 * Runs the deterministic local quality heuristics over a whole-book draft and
 * attempts one model revision for pages that fail, keeping whichever version
 * scores better. Reports stored on pages are honest rather than fabricated.
 */
export async function reviewWholeBookDraftPages(options: {
  input: CreateProjectInput;
  plan: BookPlan;
  strategy: BookGenerationStrategy;
  textModel: TextModelAdapter;
  pages: IndexedPageDraft[];
  generationJobId?: string | undefined;
}): Promise<ReviewedWholeBookPage[]> {
  const reviewed: ReviewedWholeBookPage[] = [];
  const previousPages: PriorPageContext[] = [];

  for (const pageDraft of options.pages) {
    let draft: IndexedPageDraft = pageDraft;
    let revision = 1;
    let report = reviewPageDraftLocally({
      input: options.input,
      plan: options.plan,
      pageIndex: pageDraft.index,
      draft,
      previousPages,
      continuityNotes: []
    });

    if (!report.approved) {
      await updateJobProgress(options.generationJobId, {
        message: `Page ${pageDraft.index} failed local quality checks; revising.`
      });
      try {
        const revisedDraft = await options.strategy.revisePageDraft({
          input: options.input,
          plan: options.plan,
          pageIndex: pageDraft.index,
          draft,
          report,
          previousPages,
          continuityNotes: [],
          textModel: options.textModel
        });
        const revisedReport = reviewPageDraftLocally({
          input: options.input,
          plan: options.plan,
          pageIndex: pageDraft.index,
          draft: revisedDraft,
          previousPages,
          continuityNotes: []
        });
        if (revisedReport.score >= report.score) {
          draft = { ...revisedDraft, index: pageDraft.index };
          report = revisedReport;
          revision = 2;
        }
      } catch (error) {
        if (isStopRequestedError(error)) {
          throw error;
        }
        // Keep the original draft with its honest (failing) report.
      }
    }

    reviewed.push({ draft, qualityReport: report, revision });
    previousPages.push({ index: draft.index, title: draft.title, markdown: draft.markdown, summary: draft.summary });
  }

  return reviewed;
}

export async function loadPagesForExport(projectId: string): Promise<ExportPageForRepair[]> {
  return prisma.page.findMany({
    where: { projectId },
    orderBy: { index: "asc" },
    include: { images: true, chapter: true }
  });
}

/**
 * The manuscript as text, for a reader that only has to tell two versions of it
 * apart.
 *
 * `pagesTheCompileNoLongerSpeaksFor` (`handlers/compileExportStandDown.ts`)
 * compares four scalars per page and took the whole of `loadPagesForExport` to
 * get them: every page's body, plus an `images` and a `chapter` join per row.
 * On a 300-page book that is the entire book and two relation joins, issued at
 * the one moment the compile which superseded this one is trying to publish
 * against the same database — for a `Set<number>` of moved indexes.
 *
 * The body is not the part to drop. `markdown` is *compared*, not tested for
 * emptiness: `revision` catches a rewrite that produced identical text, and the
 * text catches a writer that did not touch the counter, and a stand-down needs
 * both. What it never reads is the illustrations, the chapter row, or the
 * status and summary columns.
 *
 * It lives beside the shared loader rather than replacing it, because the two
 * other callers need what it drops: `repairPagesFromFinalQa` returns
 * `loadPagesForExport`'s answer as the manuscript the render is built from, and
 * `markdownPages` reads `page.images[0]` off every row of it. Narrowing the
 * shared one would take the pictures out of the book.
 */
export type PageTextSnapshot = {
  index: number;
  title: string;
  markdown: string;
  revision: number;
};

export async function loadPageTextSnapshot(projectId: string): Promise<PageTextSnapshot[]> {
  return prisma.page.findMany({
    where: { projectId },
    orderBy: { index: "asc" },
    select: { index: true, title: true, markdown: true, revision: true }
  });
}

export function toPriorPageContext(page: { index: number; title: string; markdown: string; summary: string }): PriorPageContext {
  return {
    index: page.index,
    title: page.title,
    markdown: page.markdown,
    summary: page.summary
  };
}

/**
 * The accepted style-lock pages (1–2) when the recency window no longer
 * reaches them, so `pinStyleExcerpts` pins the book's opening voice rather
 * than whatever the window happens to start at. Shared by the generate-page
 * handler and the finished-book rewrite paths (chat page edits, final-QA
 * repair), which used to review without any style anchor at all.
 */
export async function loadStyleLockPages(
  projectId: string,
  pageIndex: number,
  recencyPages: PriorPageContext[]
): Promise<PriorPageContext[]> {
  const missing = missingStyleLockIndexes(recencyPages, pageIndex);
  if (missing.length === 0) {
    return [];
  }
  const loaded = await prisma.page.findMany({
    where: { projectId, index: { in: missing }, status: "COMPLETED" }
  });
  return loaded.map(toPriorPageContext);
}

/**
 * The generate-page composition: recency plus any loaded pages 1–2, then
 * `pinStyleExcerpts`. One function so a writer and the review that scores it
 * cannot silently pin different prose — the continue-book path used to draft
 * from the recency window and audit against the opening lock.
 */
export async function styleExcerptsForPage(options: {
  projectId: string;
  pageIndex: number;
  recencyPages: PriorPageContext[];
  input: CreateProjectInput;
  quality: { enabled: (feature: QualityFeatureId) => boolean };
}): Promise<string[]> {
  if (!options.quality.enabled("styleExcerpts")) {
    return [];
  }
  const styleLockPages = await loadStyleLockPages(options.projectId, options.pageIndex, options.recencyPages);
  return pinStyleExcerpts(
    pagesForStyleExcerpts(options.recencyPages, styleLockPages),
    sampleExcerptsFromInput(options.input)
  );
}

export function toFinalQaPage(page: { index: number; title: string; markdown: string; summary: string }) {
  return {
    index: page.index,
    title: page.title,
    markdown: page.markdown,
    summary: page.summary
  };
}

export function pageReportFromFinalQa(finalQa: FinalBookQa, pageIndex: number, lastPage: number): PageQualityReport {
  const scopedMessages = finalQaMessagesForPage(finalQa, pageIndex, lastPage);
  const issueText = scopedMessages.join(" ");
  const repetitionOk = !/(repeat|overlap|same|redundan|duplicate)/i.test(issueText);
  const progressionOk = !/(progress|restat|vague|ending|resolution|incomplete|commitment|decision)/i.test(issueText);

  return {
    approved: false,
    score: Math.min(finalQa.score, 60),
    issues: scopedMessages.length > 0 ? scopedMessages : finalQa.issues,
    requiredRevisions: scopedMessages.length > 0 ? scopedMessages : finalQa.requiredFixes,
    notes: finalQa.notes || "Final QA requested a targeted page repair.",
    groundedOk: true,
    unsupportedClaims: [],
    checks: {
      placeholderFree: true,
      promptLeakFree: true,
      titleClean: true,
      repetitionOk,
      progressionOk,
      styleNatural: true
    }
  };
}

export function parseChapterBrief(value: unknown): ChapterBrief | undefined {
  if (!value) {
    return undefined;
  }
  return chapterBriefSchema.parse(value);
}

export function formatQualityFailure(pageIndex: number, report: PageQualityReport): string {
  const issues = report.issues.length > 0 ? report.issues.join(" ") : "Unknown quality failure.";
  const revisions =
    report.requiredRevisions.length > 0 ? ` Required revisions: ${report.requiredRevisions.join(" ")}` : "";
  return `Page ${pageIndex} failed quality review after rewrite attempts. ${issues}${revisions}`;
}

export function imageStorageMetadata(image: OptimizedImage): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries({
      mimeType: image.mimeType,
      originalMimeType: image.originalMimeType,
      optimized: image.optimized,
      maxWidth: image.maxWidth,
      originalBytes: image.originalBytes,
      outputBytes: image.outputBytes,
      originalWidth: image.originalWidth,
      originalHeight: image.originalHeight,
      width: image.width,
      height: image.height
    }).filter(([, value]) => value !== undefined)
  );
}

export function imageGenerationMetadata(image: GeneratedImageBytes): Record<string, unknown> {
  return image.fallback ? { fallback: image.fallback } : {};
}

/**
 * Drops the compiled book so downloads report "preparing" until the recompile
 * this edit queued lands.
 *
 * The provenance records go with the files: they identify bytes rather than a
 * revision, so one left behind could only describe a file that is no longer
 * there. Harmless either way — the next publication overwrites its own, and a
 * digest matching nothing is reported as matching nothing — but a record with
 * no file has nothing to say.
 */
export async function invalidateProjectExports(projectId: string): Promise<void> {
  const projectDir = join(config.BOOK_STORAGE_DIR, projectId);
  await Promise.all(
    [
      ...["book.md", "README.md", "book.pdf", "book.epub"].map((filename) => join(projectDir, filename)),
      ...exportProvenancePaths(projectDir)
    ].map((path) => rm(path, { force: true }).catch(() => undefined))
  );
}
