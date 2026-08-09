import { formatQualityFailure, parseChapterBrief } from "./bookHelpers.js";
import { enqueueWorkerJob } from "../runtime/dispatch.js";
import { updateJobProgress } from "../runtime/jobLifecycle.js";
import { type IndexedPageDraft } from "../runtime/jobTypes.js";
import { uniqueStrings } from "../runtime/serialization.js";
import { loadContinuityNotes } from "./generationContext.js";
import { storeEmbedding, updateEntityStateFromPage } from "./semanticMemory.js";
import {
  MAX_PAGE_QA_CANDIDATES,
  MAX_PAGE_QA_REWRITE_ATTEMPTS,
  MAX_PAGE_REVISE_RESTARTS,
  PAGE_QA_RECOVERY_CANDIDATE
} from "./tuning.js";
import {
  type BookGenerationStrategy,
  type BookPlan,
  type ChapterBrief,
  type ChapterPlan,
  type CreateProjectInput,
  type PageDraft,
  type PageProductionBeat,
  type PageQualityReport,
  type PriorPageContext,
  type ProviderSet,
  type RevisePageOptions,
  type TextModelAdapter
} from "@book-maker/core";
import { Prisma, prisma } from "@book-maker/db";

/**
 * Page quality review loop: score a draft, revise it, and save the best candidate.
 */

export type DraftCandidate = { draft: PageDraft; revision: number; report: PageQualityReport };

/**
 * A rewrite is not guaranteed to improve: the sixth attempt can score below the
 * second. Every review loop keeps its keeper through this one comparison so a
 * failed page is saved at its strongest draft, not its latest.
 */
export function bestDraftCandidate(best: DraftCandidate, candidate: DraftCandidate): DraftCandidate {
  return candidate.report.score > best.report.score ? candidate : best;
}

export type PageQualityLoopOutcome = {
  approved: boolean;
  /** The draft to keep: the approved one, or the best-scoring failure. */
  draft: PageDraft;
  report: PageQualityReport;
  /** The kept draft's candidate number (the best candidate's when not approved). */
  revision: number;
  /** Total candidates/attempts consumed, whichever draft was kept. */
  attempts: number;
};

/**
 * The one score → revise → re-score loop behind every page review: the
 * generate-page handler, the direct passes' per-page review, and the final-QA
 * repair in compile-export.
 *
 * The counting base is the caller's: the page loops count *candidates* from
 * the original draft (`maxCandidates` = MAX_PAGE_QA_CANDIDATES), while final
 * QA counts *attempts* from the first rewrite — one later — which is why it
 * passes `recoveryRevision: PAGE_QA_RECOVERY_CANDIDATE - 1`. Both enter
 * recovery mode at the third rewrite; collapsing the two numbers into one
 * constant silently delays that by a rewrite.
 */
export async function runPageQualityLoop(options: {
  strategy: BookGenerationStrategy;
  input: CreateProjectInput;
  plan: BookPlan;
  chapter?: ChapterPlan | undefined;
  chapterBrief?: ChapterBrief | undefined;
  pageBrief?: PageProductionBeat | undefined;
  chapterPageStart?: number | undefined;
  chapterPageEnd?: number | undefined;
  chapterId?: string | null | undefined;
  pageIndex: number;
  draft: PageDraft;
  /** The initial draft's review, produced by the caller. */
  report: PageQualityReport;
  previousPages: PriorPageContext[];
  continuityNotes: string[];
  textModel: TextModelAdapter;
  generationJobId?: string | undefined;
  maxCandidates: number;
  recoveryRevision?: number | undefined;
  /** Page loops repair a drifted page brief at the recovery candidate; final QA does not. */
  repairBrief?: boolean | undefined;
  reviseContext: string;
  reviseProgress?: number | undefined;
  /** Per-rewrite progress reporting, in the caller's own style. */
  onRewrite?: ((revision: number) => Promise<void>) | undefined;
}): Promise<PageQualityLoopOutcome> {
  let draft = options.draft;
  let report = options.report;
  let pageBrief = options.pageBrief;
  let revision = 1;
  let best: DraftCandidate = { draft, revision, report };

  while (!report.approved && revision < options.maxCandidates) {
    const nextRevision = revision + 1;
    await options.onRewrite?.(nextRevision);
    if (options.repairBrief && shouldRepairPageBriefForRecovery(nextRevision, report, pageBrief)) {
      pageBrief = await repairPageBriefForRecovery({
        strategy: options.strategy,
        input: options.input,
        plan: options.plan,
        chapter: options.chapter,
        chapterBrief: options.chapterBrief,
        chapterPageStart: options.chapterPageStart,
        chapterPageEnd: options.chapterPageEnd,
        chapterId: options.chapterId,
        pageBrief,
        pageIndex: options.pageIndex,
        draft,
        qualityReport: report,
        previousPages: options.previousPages,
        continuityNotes: options.continuityNotes,
        textModel: options.textModel,
        generationJobId: options.generationJobId,
        context: options.reviseContext
      });
    }
    draft = await revisePageDraftWithRestart({
      strategy: options.strategy,
      generationJobId: options.generationJobId,
      ...(options.reviseProgress !== undefined ? { progress: options.reviseProgress } : {}),
      context: options.reviseContext,
      reviseOptions: {
        input: options.input,
        plan: options.plan,
        chapter: options.chapter,
        chapterBrief: options.chapterBrief,
        pageBrief,
        chapterPageStart: options.chapterPageStart,
        chapterPageEnd: options.chapterPageEnd,
        pageIndex: options.pageIndex,
        draft,
        report: pageRewriteReport(report, nextRevision, options.recoveryRevision ?? PAGE_QA_RECOVERY_CANDIDATE),
        previousPages: options.previousPages,
        continuityNotes: options.continuityNotes,
        textModel: options.textModel
      }
    });
    revision = nextRevision;
    report = await options.strategy.reviewPageDraft({
      input: options.input,
      plan: options.plan,
      chapter: options.chapter,
      chapterBrief: options.chapterBrief,
      pageBrief,
      chapterPageStart: options.chapterPageStart,
      chapterPageEnd: options.chapterPageEnd,
      pageIndex: options.pageIndex,
      draft,
      previousPages: options.previousPages,
      continuityNotes: options.continuityNotes,
      textModel: options.textModel
    });
    best = bestDraftCandidate(best, { draft, revision, report });
  }

  if (report.approved) {
    return { approved: true, draft, report, revision, attempts: revision };
  }
  return { approved: false, draft: best.draft, report: best.report, revision: best.revision, attempts: revision };
}

export async function reviewAndSaveGeneratedPage(options: {
  projectId: string;
  planId: string;
  input: CreateProjectInput;
  plan: BookPlan;
  providers: ProviderSet;
  strategy: BookGenerationStrategy;
  draft: IndexedPageDraft;
  chapterId: string | null;
  chapter?: ChapterPlan | undefined;
  chapterBrief?: ChapterBrief | undefined;
  chapterPageStart?: number | undefined;
  chapterPageEnd?: number | undefined;
  previousPages: PriorPageContext[];
  generationJobId?: string | undefined;
}): Promise<PriorPageContext> {
  const pageBrief = options.chapterBrief?.pages.find((brief) => brief.pageIndex === options.draft.index);
  const continuityNotes = await loadContinuityNotes(options.projectId);
  const initialReport = await options.strategy.reviewPageDraft({
    input: options.input,
    plan: options.plan,
    chapter: options.chapter,
    chapterBrief: options.chapterBrief,
    pageBrief,
    chapterPageStart: options.chapterPageStart,
    chapterPageEnd: options.chapterPageEnd,
    pageIndex: options.draft.index,
    draft: options.draft,
    previousPages: options.previousPages,
    continuityNotes,
    textModel: options.providers.text
  });

  const outcome = await runPageQualityLoop({
    strategy: options.strategy,
    input: options.input,
    plan: options.plan,
    chapter: options.chapter,
    chapterBrief: options.chapterBrief,
    pageBrief,
    chapterPageStart: options.chapterPageStart,
    chapterPageEnd: options.chapterPageEnd,
    chapterId: options.chapterId,
    pageIndex: options.draft.index,
    draft: options.draft,
    report: initialReport,
    previousPages: options.previousPages,
    continuityNotes,
    textModel: options.providers.text,
    generationJobId: options.generationJobId,
    maxCandidates: MAX_PAGE_QA_CANDIDATES,
    repairBrief: true,
    reviseContext: `Page ${options.draft.index}`,
    onRewrite: (nextRevision) =>
      updateJobProgress(options.generationJobId, {
        message: pageRevisionMessage(options.draft.index, nextRevision, MAX_PAGE_QA_REWRITE_ATTEMPTS)
      })
  });
  const { draft, revision, report: qualityReport } = outcome;

  if (!qualityReport.approved) {
    // Page-level failure isolation: keep the best draft with its honest
    // report, flag the page, and let the rest of the book continue. The
    // compile-time final review repairs FAILED_QA pages before export.
    await updateJobProgress(options.generationJobId, {
      message: `Page ${options.draft.index} kept its best draft but failed quality review; the final review will repair it. ${formatQualityFailure(options.draft.index, qualityReport)}`
    });
  }

  const pageStatus = qualityReport.approved ? "COMPLETED" : "FAILED_QA";
  const page = await prisma.page.upsert({
    where: { projectId_index: { projectId: options.projectId, index: options.draft.index } },
    create: {
      projectId: options.projectId,
      chapterId: options.chapterId,
      index: options.draft.index,
      title: draft.title,
      markdown: draft.markdown,
      summary: draft.summary,
      imagePrompt: draft.imagePrompt ?? null,
      status: pageStatus,
      revision,
      qualityReport: qualityReport as Prisma.InputJsonValue
    },
    update: {
      chapterId: options.chapterId,
      title: draft.title,
      markdown: draft.markdown,
      summary: draft.summary,
      imagePrompt: draft.imagePrompt ?? null,
      status: pageStatus,
      revision,
      qualityReport: qualityReport as Prisma.InputJsonValue
    }
  });

  if (!qualityReport.approved) {
    // Skip continuity notes, embeddings, and illustration for a flagged page;
    // the final review rewrites it and the repaired version feeds those steps.
    return {
      index: options.draft.index,
      title: draft.title,
      markdown: draft.markdown,
      summary: draft.summary
    };
  }

  if (draft.continuityNotes.length > 0) {
    await prisma.continuityNote.createMany({
      data: draft.continuityNotes.map((body) => ({
        projectId: options.projectId,
        scope: `page:${options.draft.index}`,
        body,
        tags: ["page", String(options.draft.index), options.strategy.id]
      }))
    });
    await updateEntityStateFromPage(options.projectId, options.draft.index, draft.continuityNotes);
  }

  await storeEmbedding(options.projectId, `page:${options.draft.index}`, page.id, draft.summary, options.providers.embedding);

  if (draft.imagePrompt && options.strategy.shouldIllustratePage(options.input, options.plan, options.draft.index)) {
    await enqueueWorkerJob({
      projectId: options.projectId,
      type: "GENERATE_IMAGE",
      name: "generate-image",
      payload: { pageId: page.id, planId: options.planId, prompt: draft.imagePrompt },
      dedupeKey: `generate-image:${page.id}:${options.planId}:${page.revision}`
    });
  }

  return {
    index: options.draft.index,
    title: draft.title,
    markdown: draft.markdown,
    summary: draft.summary
  };
}

export async function revisePageDraftWithRestart(options: {
  strategy: BookGenerationStrategy;
  reviseOptions: RevisePageOptions;
  context: string;
  generationJobId?: string | undefined;
  progress?: number | undefined;
  maxRestarts?: number | undefined;
}): Promise<PageDraft> {
  const maxRestarts = options.maxRestarts ?? MAX_PAGE_REVISE_RESTARTS;
  let lastError: unknown;

  for (let attempt = 1; attempt <= maxRestarts + 1; attempt += 1) {
    try {
      return await options.strategy.revisePageDraft(options.reviseOptions);
    } catch (error) {
      lastError = error;
      if (attempt > maxRestarts) {
        throw error;
      }

      await updateJobProgress(options.generationJobId, {
        ...(options.progress !== undefined ? { progress: options.progress } : {}),
        message: `${options.context} revise failed; restarting with the generated page and revision (${attempt + 1}/${
          maxRestarts + 1
        }).`
      });
    }
  }

  throw lastError instanceof Error ? lastError : new Error(`${options.context} revise failed.`);
}

export function pageRevisionMessage(pageIndex: number, revision: number, maxRewriteAttempts: number): string {
  const phase = revision >= PAGE_QA_RECOVERY_CANDIDATE ? "Quality recovery rewrite" : "Revising";
  const rewriteAttempt = Math.max(1, revision - 1);
  return `${phase} page ${pageIndex} (rewrite ${rewriteAttempt}/${maxRewriteAttempts})`;
}

export function pageRewriteReport(
  report: PageQualityReport,
  revision: number,
  recoveryRevision = PAGE_QA_RECOVERY_CANDIDATE
): PageQualityReport {
  if (revision < recoveryRevision) {
    return report;
  }

  const recoveryInstructions = [
    `Previous rewrite attempts still failed QA; produce a complete replacement page for attempt ${revision}.`,
    "Use the rejected page only as diagnostic context, not as prose to preserve.",
    "Do not relax quality: satisfy the page brief, advance beyond prior pages, avoid repetition, and keep the page reader-ready."
  ];

  return {
    ...report,
    issues: [...report.issues, "Earlier generated replacements for this page were still rejected by QA."],
    requiredRevisions: [...report.requiredRevisions, ...recoveryInstructions],
    notes: [report.notes, "Quality recovery mode: make a structural replacement rather than a light edit."]
      .filter(Boolean)
      .join(" ")
  };
}

export function shouldRepairPageBriefForRecovery(
  revision: number,
  report: PageQualityReport,
  pageBrief: PageProductionBeat | undefined
): pageBrief is PageProductionBeat {
  if (!pageBrief || revision < PAGE_QA_RECOVERY_CANDIDATE) {
    return false;
  }

  if (!report.checks.repetitionOk || !report.checks.progressionOk) {
    return true;
  }

  const feedback = [...report.issues, ...report.requiredRevisions, report.notes].join(" ").toLowerCase();
  return /brief|assignment|repeat|repetition|already covered|same (argument|beat|point|scene)|stalled|does not progress|new distinct|fresh angle/.test(
    feedback
  );
}

export async function repairPageBriefForRecovery(options: {
  strategy: BookGenerationStrategy;
  input: CreateProjectInput;
  plan: BookPlan;
  chapter?: ChapterPlan | undefined;
  chapterBrief?: ChapterBrief | undefined;
  chapterPageStart?: number | undefined;
  chapterPageEnd?: number | undefined;
  chapterId?: string | null | undefined;
  pageBrief: PageProductionBeat;
  pageIndex: number;
  draft: PageDraft;
  qualityReport: PageQualityReport;
  previousPages: PriorPageContext[];
  continuityNotes: string[];
  textModel: TextModelAdapter;
  generationJobId?: string | undefined;
  context: string;
}): Promise<PageProductionBeat> {
  await updateJobProgress(options.generationJobId, {
    message: `${options.context} brief conflict detected; repairing page brief before recovery rewrite.`
  });

  const repaired = await options.strategy.repairPageBrief({
    input: options.input,
    plan: options.plan,
    chapter: options.chapter,
    chapterBrief: options.chapterBrief,
    pageBrief: options.pageBrief,
    chapterPageStart: options.chapterPageStart,
    chapterPageEnd: options.chapterPageEnd,
    pageIndex: options.pageIndex,
    draft: options.draft,
    report: options.qualityReport,
    previousPages: options.previousPages,
    continuityNotes: options.continuityNotes,
    textModel: options.textModel
  });

  // Local mutation for the rest of *this* page's own loop: the remaining
  // rewrite/review calls below pass `options.chapterBrief` straight through,
  // and they need to see the repaired beat regardless of what a concurrent
  // sibling page does to the persisted row.
  replacePageBriefInChapterBrief(options.chapterBrief, repaired);

  if (options.chapterId) {
    await casUpdateChapterProductionBrief(options.chapterId, repaired);
  }

  return repaired;
}

const CHAPTER_BRIEF_CAS_ATTEMPTS = 3;

/**
 * Chapters in the same wave can have several pages hit brief-repair recovery
 * concurrently (one job per page). A blind `chapter.update` here would let
 * whichever write lands second silently discard the first page's repair, so
 * this merges the repaired beat into a freshly-read row and writes it back
 * conditioned on the row still holding the state just read — retrying against
 * the winner's brief on a miss, the same compare-and-swap shape used for
 * per-entity continuity state in semanticMemory.ts.
 */
async function casUpdateChapterProductionBrief(chapterId: string, repaired: PageProductionBeat): Promise<void> {
  let current = await prisma.chapter.findUnique({ where: { id: chapterId }, select: { productionBrief: true } });
  for (let attempt = 0; attempt < CHAPTER_BRIEF_CAS_ATTEMPTS; attempt += 1) {
    const currentBrief = parseChapterBrief(current?.productionBrief);
    if (!currentBrief) {
      return;
    }
    // A shallow copy, not `currentBrief` itself: `replacePageBriefInChapterBrief`
    // mutates whatever object it's given, and `currentBrief` still has to serve
    // as the untouched "expected previous state" for the CAS below.
    const updated = replacePageBriefInChapterBrief({ ...currentBrief }, repaired);
    if (!updated) {
      return;
    }
    const claimed = await prisma.chapter.updateMany({
      where: { id: chapterId, productionBrief: { equals: currentBrief as unknown as Prisma.InputJsonValue } },
      data: { productionBrief: updated as Prisma.InputJsonValue }
    });
    if (claimed.count === 1) {
      return;
    }
    current = await prisma.chapter.findUnique({ where: { id: chapterId }, select: { productionBrief: true } });
  }
  console.warn(`Chapter production brief update for ${chapterId} lost the CAS race ${CHAPTER_BRIEF_CAS_ATTEMPTS} times in a row`);
}

export function replacePageBriefInChapterBrief(
  chapterBrief: ChapterBrief | undefined,
  repaired: PageProductionBeat
): ChapterBrief | undefined {
  if (!chapterBrief) {
    return undefined;
  }

  const replaced = chapterBrief.pages.some((page) => page.pageIndex === repaired.pageIndex);
  const updated: ChapterBrief = {
    ...chapterBrief,
    pages: replaced
      ? chapterBrief.pages.map((page) => (page.pageIndex === repaired.pageIndex ? repaired : page))
      : [...chapterBrief.pages, repaired].sort((a, b) => a.pageIndex - b.pageIndex),
    continuityFocus: uniqueStrings([...chapterBrief.continuityFocus, ...repaired.requiredContinuity]).slice(0, 20)
  };
  Object.assign(chapterBrief, updated);
  return updated;
}
