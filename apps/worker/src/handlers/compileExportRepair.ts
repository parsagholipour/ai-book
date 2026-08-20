import {
  extractRepairPageIndexes,
  formatQualityFailure,
  loadPagesForExport,
  loadStyleLockPages,
  pageReportFromFinalQa,
  parseChapterBrief,
  toPriorPageContext
} from "../generation/bookHelpers.js";
import { loadContinuityNotes } from "../generation/generationContext.js";
import { revisePageDraftWithRestart, runPageQualityLoop } from "../generation/pageReview.js";
import { persistKeeperStoryDelta, type QualityGateContext } from "../generation/qualityEnrichment.js";
import { rebuildStoryStateFromPages } from "../generation/storyStateStore.js";
import { storeEmbedding, strategyUsesSemanticMemory } from "../generation/embeddingWrites.js";
import { MAX_FINAL_QA_REVISIONS_PER_PAGE, PAGE_QA_RECOVERY_CANDIDATE } from "../generation/tuning.js";
import { advanceJobStep, updateJobProgress } from "../runtime/jobLifecycle.js";
import type { ExportPageForRepair } from "../runtime/jobTypes.js";
import {
  pagesForStyleExcerpts,
  pinStyleExcerpts,
  sampleExcerptsFromInput,
  type BookGenerationStrategy,
  type BookPlan,
  type CreateProjectInput,
  type FinalBookQa,
  type PriorPageContext,
  type ProviderSet
} from "@book-maker/core";
import { pageScope, Prisma, prisma } from "@book-maker/db";

/**
 * The compile-time final-QA repair pass: the global editor sweep that rewrites
 * every page final QA flagged before a book ships. Split out of
 * compileExport.ts along the seam its size budget named.
 */

export async function repairPagesFromFinalQa(options: {
  projectId: string;
  input: CreateProjectInput;
  plan: BookPlan;
  providers: ProviderSet;
  strategy: BookGenerationStrategy;
  /**
   * The compile's own quality context. Handed in rather than loaded here so
   * this pass and the integrity pass after it read one operator revision — a
   * Quality-tab save landing between two loads would otherwise run a single
   * compile under two different gate configurations.
   */
  quality: QualityGateContext;
  pages: ExportPageForRepair[];
  finalQa: FinalBookQa;
  /** Additional page indexes to repair (e.g. pages that failed page-level QA). */
  extraPageIndexes?: number[] | undefined;
  generationJobId?: string | undefined;
}): Promise<ExportPageForRepair[] | undefined> {
  // Global editor pass: every flagged page is eligible for repair, not just
  // the first few — large books get the same treatment as short ones.
  const repairPageIndexes = [
    ...new Set([...(options.extraPageIndexes ?? []), ...extractRepairPageIndexes(options.finalQa, options.input.targetPages)])
  ].sort((first, second) => first - second);
  if (repairPageIndexes.length === 0) {
    return undefined;
  }

  await advanceJobStep(
    options.generationJobId,
    "qa",
    35,
    `Repairing pages ${repairPageIndexes.join(", ")} after final QA`
  );

  // Whole book: the final-QA repair rewrites a page inside a finished
  // manuscript and must not contradict the pages after it.
  const continuityNotes = await loadContinuityNotes(options.projectId, { beforePageIndex: null });
  const pinsStyleLock = options.quality.enabled("styleExcerpts");
  const sampleExcerpts = sampleExcerptsFromInput(options.input);
  // `pinStyleExcerpts` sorts its input ascending and keeps the first two
  // substantial pages, so the lock stops moving the moment two *pages* have
  // supplied it: the repairs run in ascending index order and each rewrites
  // only the page it is on, so every repair after that one pins the same two.
  // Until then — page 1, page 2, an opening too short to pin — the candidate
  // set is still growing and the import samples still fill the lock in, so it
  // is answered per page.
  //
  // The candidates are the **accepted** pages, through the same
  // `loadStyleLockPages` / `pagesForStyleExcerpts` composition the generate-page
  // handler and the chat rewrite pin from. This pass reads
  // `loadPagesForExport`, which has no status filter, so a FAILED_QA page 1 or
  // 2 — a best draft the QA pipeline *rejected* — became the voice every
  // repaired page in the book was rewritten and audited against, on the last
  // writer before the book ships. The shared loader answers with COMPLETED
  // pages only, and an opening it cannot supply falls back to the import
  // samples exactly as an empty one does.
  let pinnedStyleLock: string[] | undefined;
  const styleLockFor = async (acceptedPages: PriorPageContext[], pageIndex: number): Promise<string[]> => {
    if (pinnedStyleLock) {
      return pinnedStyleLock;
    }
    const lockPages = await loadStyleLockPages(options.projectId, pageIndex, acceptedPages);
    const candidates = pagesForStyleExcerpts(acceptedPages, lockPages);
    const fromPages = pinStyleExcerpts(candidates);
    if (fromPages.length === 2) {
      pinnedStyleLock = fromPages;
      return pinnedStyleLock;
    }
    return pinStyleExcerpts(candidates, sampleExcerpts);
  };
  let pages = [...options.pages];
  let currentState = await rebuildStoryStateFromPages(options.projectId, options.plan.promises ?? []);

  for (const pageIndex of repairPageIndexes) {
    const page = pages.find((candidate) => candidate.index === pageIndex);
    if (!page) {
      continue;
    }

    const chapterPlan = page.chapter
      ? options.plan.chapters.find((chapter) => chapter.index === page.chapter?.index)
      : undefined;
    const chapterBrief = parseChapterBrief(page.chapter?.productionBrief);
    const pageBrief = chapterBrief?.pages.find((brief) => brief.pageIndex === page.index);
    const previousPages = pages.filter((candidate) => candidate.index < page.index).map(toPriorPageContext);
    // Every earlier page is prior *context* — a flagged page is still in the
    // book the repair must not contradict — but only the accepted ones may
    // anchor the style lock. This is the last writer before a book ships, and
    // it used to replace flagged prose with no style anchor at all.
    const acceptedPreviousPages = pages
      .filter((candidate) => candidate.index < page.index && candidate.status === "COMPLETED")
      .map(toPriorPageContext);
    const styleExcerpts = pinsStyleLock ? await styleLockFor(acceptedPreviousPages, page.index) : [];
    const finalQaReport = pageReportFromFinalQa(options.finalQa, pageIndex, options.input.targetPages);
    let draft = await revisePageDraftWithRestart({
      strategy: options.strategy,
      generationJobId: options.generationJobId,
      context: `Final QA repair for page ${pageIndex}`,
      reviseOptions: {
        input: options.input,
        plan: options.plan,
        chapter: chapterPlan,
        chapterBrief,
        pageBrief,
        pageIndex,
        draft: {
          title: page.title,
          markdown: page.markdown,
          summary: page.summary,
          continuityNotes: []
        },
        report: finalQaReport,
        previousPages,
        continuityNotes,
        textModel: options.providers.text,
        ...(styleExcerpts.length > 0 ? { styleExcerpts } : {})
      }
    });

    // The repair's first rewrite is already a revision, so it owes the audit a
    // generated page's initial draft gets from `enrichPageQualityReport` — and
    // the loop is what pays it, on this seed report the same way it does on
    // every rewrite after it.
    const initialReport = await options.strategy.reviewPageDraft({
      input: options.input,
      plan: options.plan,
      chapter: chapterPlan,
      chapterBrief,
      pageBrief,
      pageIndex,
      draft,
      previousPages,
      continuityNotes,
      textModel: options.providers.text,
      ...(styleExcerpts.length > 0 ? { styleExcerpts } : {})
    });
    const outcome = await runPageQualityLoop({
      projectId: options.projectId,
      strategy: options.strategy,
      input: options.input,
      plan: options.plan,
      chapter: chapterPlan,
      chapterBrief,
      pageBrief,
      pageIndex,
      draft,
      report: initialReport,
      previousPages,
      continuityNotes,
      textModel: options.providers.text,
      generationJobId: options.generationJobId,
      maxCandidates: MAX_FINAL_QA_REVISIONS_PER_PAGE,
      // This loop counts attempts from the first rewrite; the page loops
      // count candidates from the original draft, one earlier. Both enter
      // recovery mode at the third rewrite.
      recoveryRevision: PAGE_QA_RECOVERY_CANDIDATE - 1,
      reviseContext: `Final QA repair for page ${pageIndex}`,
      quality: options.quality,
      ...(styleExcerpts.length > 0 ? { styleExcerpts } : {})
    });
    draft = outcome.draft;
    const qualityReport = outcome.report;
    const revisionAttempts = outcome.attempts;

    if (!qualityReport.approved) {
      // Keep the best draft and an honest report; the page stays flagged but
      // does not block the rest of the export.
      const failedPage = await prisma.page.update({
        where: { id: page.id },
        data: {
          title: draft.title,
          markdown: draft.markdown,
          summary: draft.summary,
          imagePrompt: draft.imagePrompt ?? page.imagePrompt,
          status: "FAILED_QA",
          revision: { increment: revisionAttempts },
          qualityReport: qualityReport as Prisma.InputJsonValue
        }
      });
      // Later repairs must see both the failed rewrite's prose and its rejected
      // status. Keeping the old COMPLETED entry here lets it become the pinned
      // style voice for the rest of this same pass.
      pages = pages.map((candidate) =>
        candidate.index === page.index ? { ...candidate, ...failedPage } : candidate
      );
      const failedKeeperState = await persistKeeperStoryDelta({
        projectId: options.projectId,
        pageIndex,
        draft,
        textModel: options.providers.text,
        plan: options.plan,
        input: options.input,
        previousExtract: null,
        keeperWasRevised: true,
        currentState,
        quality: options.quality
      });
      if (failedKeeperState) {
        currentState = failedKeeperState;
      }
      await updateJobProgress(options.generationJobId, {
        message: `Final QA repair could not fully fix page ${pageIndex}; exporting its best draft. ${formatQualityFailure(pageIndex, qualityReport)}`
      });
      continue;
    }

    const updatedPage = await prisma.page.update({
      where: { id: page.id },
      data: {
        title: draft.title,
        markdown: draft.markdown,
        summary: draft.summary,
        imagePrompt: draft.imagePrompt ?? page.imagePrompt,
        status: "COMPLETED",
        revision: { increment: revisionAttempts },
        qualityReport: qualityReport as Prisma.InputJsonValue
      },
      include: { images: true, chapter: true }
    });
    const keptKeeperState = await persistKeeperStoryDelta({
      projectId: options.projectId,
      pageIndex,
      draft,
      textModel: options.providers.text,
      plan: options.plan,
      input: options.input,
      previousExtract: null,
      keeperWasRevised: true,
      currentState,
      quality: options.quality
    });
    if (keptKeeperState) {
      currentState = keptKeeperState;
    }

    if (draft.continuityNotes.length > 0) {
      await prisma.continuityNote.createMany({
        data: draft.continuityNotes.map((body) => ({
          projectId: options.projectId,
          pageId: page.id,
          scope: pageScope(page.index),
          body,
          tags: ["page", String(page.index), "final-qa-repair"]
        }))
      });
    }

    if (strategyUsesSemanticMemory(options.strategy)) {
      await storeEmbedding(
        { projectId: options.projectId, scope: pageScope(page.index), sourceId: page.id, text: draft.summary },
        options.providers.embedding
      );
    }
    pages = pages.map((candidate) => (candidate.index === page.index ? updatedPage : candidate));
  }

  return loadPagesForExport(options.projectId);
}
