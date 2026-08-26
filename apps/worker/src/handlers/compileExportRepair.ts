import {
  formatQualityFailure,
  loadPagesForExport,
  loadStyleLockPages,
  pageReportFromFinalQa,
  parseChapterBrief,
  toPriorPageContext
} from "../generation/bookHelpers.js";
import { extractRepairPageIndexes, lastPageIndex } from "../generation/finalQaPageTargets.js";
import { loadContinuityNotes } from "../generation/generationContext.js";
import {
  revisePageDraftWithRestart,
  runPageQualityLoop,
  type PageQualityLoopOutcome
} from "../generation/pageReview.js";
import {
  keeperStoryExtractForSave,
  type QualityGateContext
} from "../generation/qualityEnrichment.js";
import { rebuildStoryStateFromPages } from "../generation/storyStateStore.js";
import {
  ExportRepairFenceUnreadableError,
  ExportRepairSupersededError,
  fenceUnreadableAfter
} from "./compileExportFence.js";
import {
  persistFinalQaPageSemantics,
  type FinalQaOwnershipClaim,
  type FinalQaOwnershipClient
} from "./compileExportRepairSemantics.js";
import {
  prepareEmbedding,
  strategyUsesSemanticMemory
} from "../generation/embeddingWrites.js";
import {
  nextPageVersion,
  pageIllustrationKeeperToken,
  retireGeneratedPageIllustrations,
  type PageIllustrationKeeper
} from "../generation/pageIllustrationOwnership.js";
import { finalQaRevisionsFor, PAGE_QA_RECOVERY_CANDIDATE } from "../generation/tuning.js";
import { advanceJobStep, updateJobProgress } from "../runtime/jobLifecycle.js";
import { dispatchWorkerGenerationJob } from "../runtime/dispatch.js";
import { currentGenerationAttemptId } from "../runtime/generationAttemptContext.js";
import type { ExportPageForRepair } from "../runtime/jobTypes.js";
import {
  pagesForStyleExcerpts,
  pinStyleExcerpts,
  sampleExcerptsFromInput,
  type BookGenerationStrategy,
  type BookPlan,
  type ChapterBrief,
  type CreateProjectInput,
  type FinalBookQa,
  type PriorPageContext,
  type ProviderSet
} from "@book-maker/core";
import { Prisma, prisma } from "@book-maker/db";

/**
 * The compile-time final-QA repair pass: the global editor sweep that rewrites
 * every page final QA flagged before a book ships. Split out of
 * compileExport.ts along the seam its size budget named.
 */

/** Current compile must finish before the replacement image can fan back in. */
export class ExportRepairIllustrationDeferredError extends ExportRepairSupersededError {
  constructor() {
    super();
    this.name = "ExportRepairIllustrationDeferredError";
  }
}

export async function repairPagesFromFinalQa(options: {
  projectId: string;
  /** Plan-version identity carried into any replacement illustration job. */
  planId: string;
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
  /** Citeable notes available to reviewer, reviser, and brief recovery. */
  researchNotes?: string[] | undefined;
  /** Additional page indexes to repair (e.g. pages that failed page-level QA). */
  extraPageIndexes?: number[] | undefined;
  /**
   * Whether this compile may still leave a durable opinion of the book behind,
   * and the fence that keeps asking.
   *
   * **This pass writes the manuscript, not just its own opinion of it**, and the
   * fence covers all of it: the page row in either branch, the keeper's story
   * delta, the repaired page's continuity notes and its embedding, and the
   * chapter brief the recovery rewrite repairs. It was threaded only into
   * `runPageQualityLoop` at first, which forwards it to
   * `repairPageBriefForRecovery` alone — so a page whose loop approved before
   * the third rewrite never reached the one caller that asked, and the pass
   * carried on saving pages into a book it no longer owned. That is the
   * expensive miss, not the brief: a compile holds a `pages` snapshot taken
   * minutes earlier, and the reader can chat-edit a finished book the whole time
   * it works. `applyBookEdit` writes their paid rewrite, bumps
   * `contentRevision` and queues its own recompile; this pass then reached the
   * same page and replaced it with a repair of the prose they had just paid to
   * replace.
   *
   * So each page is published the way `reviewAndSaveGeneratedPage` publishes a
   * drafted one — every provider call first, holding its result in memory, then
   * one assertion, then only writes — with the one difference that the **page
   * row is inside** the fence here. There it is deliberately outside it, because
   * the row is keyed on project+index and the winner redrafts it; here the
   * winner is a reader edit that is not going to write this page again.
   *
   * With no fence the pass still repairs and still saves — that is the whole of
   * its job, and it is what it did before any of this existed. The one write it
   * declines instead is the chapter brief: the recovery rewrite's brief repair
   * compare-and-swaps the repaired beat into `Chapter.productionBrief`, where
   * every *later drafting job* reads it, so it outlives the compile entirely and
   * is documented as fenced. A compile has no lease to fence it with, which
   * makes the fence the caller's to supply and supplying it what buys the write:
   * with no `assertOwnership` this pass passes no `chapterId` and the repair
   * stays in memory, steering only the pages this pass is about to rewrite.
   * Calls without a client are advisory work barriers. The publication call
   * supplies its transaction client and must bind the ownership claim through
   * that client; `exportRepairOwnershipFence` does so with the project revision
   * CAS that makes the following page and brief writes atomic with the claim.
   */
  assertOwnership?: FinalQaOwnershipClaim | undefined;
  generationJobId?: string | undefined;
}): Promise<ExportPageForRepair[] | undefined> {
  // Global editor pass: every flagged page is eligible for repair, not just
  // the first few — large books get the same treatment as short ones.
  //
  // In the manuscript's own page numbers, not the plan's: `input.targetPages`
  // is what the plan asked for, and a book that drafted a different count (or
  // whose plan-version snapshot lags a structural insert) had every complaint
  // about its tail dropped — an ending complaint redrafting the plan's last
  // page instead of the book's, or nothing at all. The same bound reaches
  // `pageReportFromFinalQa`, which decides which complaints each repaired page
  // is answering, so both halves read one number.
  const lastPage = lastPageIndex(options.pages);
  const repairPageIndexes = [
    ...new Set([...(options.extraPageIndexes ?? []), ...extractRepairPageIndexes(options.finalQa, lastPage)])
  ].sort((first, second) => first - second);
  // Resolved to rows once, and the loop below walks the rows rather than the
  // indexes, because "the pages this pass set out to repair" is a claim the
  // manuscript has to be able to answer for. Not every named index is a page:
  // `extraPageIndexes` carries the `affectedPageIndexes` of every
  // error-severity deterministic issue, the verdict's own indexes are bounded
  // only by the book's *highest* index, and a manuscript with a gap in its
  // numbering — the thing `PAGE_INDEX_INVALID` exists to report — holds neither
  // end of one. The loop used to answer that with a `find` and a `continue`
  // while the denominator counted the raw list, which is the same arithmetic
  // error `barriersCleared` was demoted for: a 15-index verdict of which 14
  // were real, stopped after 7 pages, reported "repaired 7 of 15" and an
  // operator read eight unrepaired pages where there were seven. One
  // resolution, so the skip and the count cannot disagree — there is no longer
  // a skip for them to disagree about.
  //
  // Resolvable here rather than per iteration because each index is visited
  // once, in ascending order, and the only row this loop replaces is the one it
  // has just repaired: the row for index *i* is untouched until *i* comes up.
  const targetPages = repairPageIndexes.flatMap((pageIndex) => {
    const page = options.pages.find((candidate) => candidate.index === pageIndex);
    return page ? [page] : [];
  });
  // A pass with nothing real to repair is not a truncated pass or an empty one,
  // it is not a pass: returning `undefined` is what keeps the caller from
  // re-running `runFinalBookQa` — a whole model call over the book — to grade a
  // manuscript no page of which was rewritten.
  if (targetPages.length === 0) {
    return undefined;
  }

  await advanceJobStep(
    options.generationJobId,
    "qa",
    35,
    `Repairing pages ${targetPages.map((page) => page.index).join(", ")} after final QA`
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
  // Pages whose repair ran all the way to its writes, which is the only measure
  // of this pass anybody downstream can act on.
  //
  // The fence counts its own reads and cannot count these: it is asked twice
  // per repaired page and once more for any page that reaches a brief repair
  // (after the planner call; the CAS shares the page's publication fence), so no
  // arithmetic over that tally recovers a page number — a 15-page pass that
  // stopped on page 7 read as one that stopped around page 6, and
  // `recordTruncatedRepairPass` printed exactly that. This frame is the one
  // that knows both halves of the honest sentence: how many pages of the book
  // the verdict named — `targetPages`, resolved above, never the raw index list
  // — and how many of them this pass saw through.
  let pagesRepaired = 0;
  let queuedReplacementIllustrations = 0;
  // The caller's fence, plus the only thing the caller cannot know. Wrapping it
  // here rather than catching around the loop is what covers every ask site
  // with one stamp — the two below and the repair's post-planner stand-down,
  // which this pass hands the same closure to —
  // and it stamps at the throw, where `pagesRepaired` is still exactly what it
  // was when the database went quiet. Every other error travels untouched,
  // `StopRequestedError` and `ExportRepairSupersededError` included.
  const callerFence = options.assertOwnership;
  const assertOwnership = callerFence
    ? async (client?: FinalQaOwnershipClient): Promise<void> => {
        try {
          await callerFence(client);
        } catch (error) {
          if (error instanceof ExportRepairFenceUnreadableError) {
            throw fenceUnreadableAfter(
              error,
              { pagesRepaired, pagesTargeted: targetPages.length },
              queuedReplacementIllustrations > 0
            );
          }
          throw error;
        }
      }
    : undefined;
  let currentState = await rebuildStoryStateFromPages(options.projectId, options.plan.promises ?? []);
  // One parsed brief per chapter for the whole pass, not one per page. A page
  // whose brief collides with an earlier beat gets it repaired in the loop, and
  // the next flagged page of that chapter has to be briefed against the repair
  // rather than against the assignment it replaced. Re-parsing
  // `page.chapter.productionBrief` per page handed every later page the pre-loop
  // snapshot instead: it was told to stay clear of an assignment the earlier
  // page no longer had, and left free to collide with the fresh one — the
  // collision this pass had just paid a model call to remove.
  //
  // Independent of whether the repair also *persists*. The durable write is
  // compare-and-swapped onto a freshly-read row and cannot be read back in-pass
  // without a query per page; this map is what carries the repair across the
  // chapter either way, and it is the only carrier when the compile is not
  // allowed the durable write at all.
  //
  // **A repair reaches it on the same condition it reaches the row**, and that
  // condition is decided inside the loop rather than here. This map first held
  // the very object the loop's brief repair mutated, which quietly promoted a
  // page-local edit to a pass-wide one: pages 10 and 14 of a chapter both
  // flagged, page 10's post-repair rewrite rejected, its durable write correctly
  // declined, page 10 shipping the prose it always had — and page 14 briefed
  // against a chapter claiming page 10 covers a beat page 10 never wrote. That
  // was a defect in the repair, not in this pass, so it is fixed there:
  // `repairPageBriefForRecovery` writes into nothing it is handed and
  // `runPageQualityLoop` answers with the merged brief only for a page that kept
  // a draft it briefed. This map takes that answer below, so a page can be
  // handed the shared brief with nothing to guard against. An *accepted* repair
  // reaching the chapter's later pages is the whole point of the map;
  // acceptance is the gate.
  const chapterBriefs = new Map<string, ChapterBrief | undefined>();
  const chapterBriefFor = (page: ExportPageForRepair): ChapterBrief | undefined => {
    const chapterId = page.chapter?.id;
    if (!chapterId) {
      return parseChapterBrief(page.chapter?.productionBrief);
    }
    if (!chapterBriefs.has(chapterId)) {
      chapterBriefs.set(chapterId, parseChapterBrief(page.chapter?.productionBrief));
    }
    return chapterBriefs.get(chapterId);
  };

  for (const page of targetPages) {
    const pageIndex = page.index;
    // Nothing is even *drafted* for a book this compile has already lost. A page
    // costs a rewrite, a review and up to a tier's worth of loop attempts — the
    // most expensive thing in the compile — against one indexed single-column
    // read here, and the pass repairs pages in ascending order, so this is the
    // barrier that stops at the page after the edit rather than at the end of
    // the book. The pages already rewritten stay written; see the handler's own
    // catch in `compileExport.ts`.
    await assertOwnership?.();

    const chapterPlan = page.chapter
      ? options.plan.chapters.find((chapter) => chapter.index === page.chapter?.index)
      : undefined;
    const chapterBrief = chapterBriefFor(page);
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
    const finalQaReport = pageReportFromFinalQa(options.finalQa, pageIndex, lastPage);
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
        researchNotes: options.researchNotes,
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
      researchNotes: options.researchNotes,
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
      // `chapterId` and the fence travel together, because `chapterId` is the
      // whole gate on the staged chapter write. A caller that answered for
      // ownership gets the durable repair — published with the page below — so
      // every later drafting job reads the beat this pass paid to fix instead
      // of throwing it away at the end of the compile. A caller that did not
      // gets the in-memory one.
      // Either way the loop, not the repair, decides whether that write is ever
      // made: this tier's budget can put recovery on the *last* attempt, and a
      // page whose final rewrite is rejected ships its pre-repair prose, which
      // is not what the chapter may go on claiming its assignment is.
      ...(assertOwnership ? { chapterId: page.chapter?.id ?? null, assertOwnership } : {}),
      pageIndex,
      draft,
      report: initialReport,
      previousPages,
      continuityNotes,
      researchNotes: options.researchNotes,
      textModel: options.providers.text,
      generationJobId: options.generationJobId,
      maxCandidates: finalQaRevisionsFor(options.input),
      // This loop counts attempts from the first rewrite; the page loops
      // count candidates from the original draft, one earlier. Both enter
      // recovery mode at the third rewrite (clamped to the tier's budget).
      recoveryRevision: PAGE_QA_RECOVERY_CANDIDATE - 1,
      // The repair pass exists because a page keeps failing the same review,
      // and the commonest such page is one whose brief collides with a beat
      // an earlier page already covered — rewriting the page re-executes the
      // collision, so every attempt fails identically. Repairing the brief is
      // the one move that gives the remaining rewrites a fresh assignment, and
      // "one" is literal: the loop latches it to a single repair per page, so
      // this tier's ten attempts buy one planner call and one chapter write
      // rather than one of each per rewrite from the recovery candidate on.
      repairBrief: true,
      // This pass owns the page update below. A kept chapter repair stays in
      // memory until that update, so one ownership barrier and one transaction
      // publish both or neither.
      deferBriefRepairPersistence: true,
      reviseContext: `Final QA repair for page ${pageIndex}`,
      quality: options.quality,
      ...(styleExcerpts.length > 0 ? { styleExcerpts } : {})
    });
    draft = outcome.draft;
    const qualityReport = outcome.report;
    const revisionAttempts = outcome.attempts;
    // The pass's memory of the chapter, moved on the one condition the durable
    // row moves on: the loop answers with the merged brief only for a page that
    // kept a draft the repair briefed, so a rejected repair reaches neither and
    // an accepted one reaches both. A page in no chapter carries nothing
    // forward — `chapterBriefFor` parses one per page for those, and nothing
    // else is briefed off it.
    const repairedChapterBrief = outcome.repairedChapterBrief;
    const repairedChapterId = page.chapter?.id;
    if (repairedChapterBrief && repairedChapterId) {
      chapterBriefs.set(repairedChapterId, repairedChapterBrief);
    }

    // ---- Prepare: every provider call this page's save owes, and not one write. ----
    //
    // Both halves of the save are model calls with a write behind them, and both
    // are split at that seam for exactly this caller —
    // `keeperStoryExtractForSave` and `prepareEmbedding` say so in their own
    // docstrings. Spending them here leaves nothing slow between the assertion
    // below and the writes, so the window in which the manuscript can change
    // hands under a half-published page is a few statements rather than two
    // provider round trips.
    const keeperExtract = await keeperStoryExtractForSave({
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
    // Only an approved page earns memory: one this pass could not fix keeps its
    // best draft as FAILED_QA, and an embedding of prose the book is still
    // flagging is what later pages would recall it by. Asking that here rather
    // than inside the branch is what lets the call be spent before the barrier.
    const usesSemanticMemory = qualityReport.approved && strategyUsesSemanticMemory(options.strategy);
    const preparedEmbedding =
      usesSemanticMemory
        ? await prepareEmbedding(draft.summary, options.providers.embedding)
        : null;

    const imagePrompt = draft.imagePrompt ?? page.imagePrompt;
    const revision = (Number.isInteger(page.revision) ? page.revision : 0) + revisionAttempts;
    const priorVersion = pageVersion(page);
    const stagedVersion = nextPageVersion(priorVersion);
    const priorKeeper = illustrationKeeper(options.projectId, page, {
      title: page.title,
      markdown: page.markdown,
      summary: page.summary,
      imagePrompt: page.imagePrompt,
      revision: page.revision
    });
    const nextKeeper = illustrationKeeper(options.projectId, page, {
      title: draft.title,
      markdown: draft.markdown,
      summary: draft.summary,
      imagePrompt,
      revision
    });
    const replacementKeeper = pageIllustrationKeeperToken(priorKeeper) !== pageIllustrationKeeperToken(nextKeeper);
    const willIllustrate =
      qualityReport.approved &&
      replacementKeeper &&
      Boolean(imagePrompt) &&
      options.strategy.shouldIllustratePage(options.input, options.plan, page.index);

    // ---- Publish: one verified claim, and then only writes. ----
    // The binding claim is the first statement in the transaction below. The
    // advisory read at the top of this page stops wasted model work, but an edit
    // can commit after it answers; only the revision CAS beside the page write
    // closes that gap.

    const publicationStatus = qualityReport.approved ? (willIllustrate ? "GENERATING" : "COMPLETED") : "FAILED_QA";
    const completedVersion = willIllustrate ? nextPageVersion(stagedVersion) : stagedVersion;
    let replacementImageJobId: string | undefined;
    const publishedPage = await publishFinalQaPageAndBrief(
      assertOwnership,
      outcome.pendingBriefRepair,
      async (client) => {
        let updated: ExportPageForRepair;
        try {
          updated = await client.page.update({
            // `contentRevision` fences reader edits which move the project, but
            // it does not distinguish two deliveries repairing the same
            // revision. Claim the exact page snapshot too: a sibling repair,
            // image transition or hand-requeued compile which already moved
            // this row wins without letting stale prose mint another image
            // owner over it.
            where: {
              id: page.id,
              status: page.status,
              title: page.title,
              markdown: page.markdown,
              summary: page.summary,
              imagePrompt: page.imagePrompt,
              revision: page.revision,
              updatedAt: priorVersion
            },
            data: {
              title: draft.title,
              markdown: draft.markdown,
              summary: draft.summary,
              imagePrompt,
              status: publicationStatus,
              revision: { increment: revisionAttempts },
              qualityReport: qualityReport as Prisma.InputJsonValue,
              updatedAt: stagedVersion
            },
            include: { images: true, chapter: true }
          });
        } catch (error) {
          // Prisma reports an extended-where unique update miss as P2025. It is
          // the page half of the same stand-down as a missed project-revision
          // CAS, not a database failure which should fail and refund the book.
          if (prismaErrorCode(error) === "P2025") {
            throw new ExportRepairSupersededError();
          }
          throw error;
        }
        if (replacementKeeper) {
          await retireGeneratedPageIllustrations(client, {
            pageIndex: page.index,
            priorKeeper
          });
        }
        if (willIllustrate) {
          replacementImageJobId = await claimFinalQaIllustrationJob(client, {
            projectId: options.projectId,
            planId: options.planId,
            pageId: page.id,
            prompt: imagePrompt!,
            keeperToken: pageIllustrationKeeperToken(nextKeeper),
            revision
          });
          // Still inside the page/brief transaction: there must be no durable
          // crash window in which the job exists but the page is left
          // GENERATING forever. The statements remain ordered stage -> exact
          // job -> terminal, while the transaction exposes all three together.
          await completeFinalQaIllustratedKeeper(client, {
            projectId: options.projectId,
            planId: options.planId,
            imageJobId: replacementImageJobId,
            pageId: page.id,
            title: draft.title,
            markdown: draft.markdown,
            summary: draft.summary,
            imagePrompt: imagePrompt!,
            keeperToken: pageIllustrationKeeperToken(nextKeeper),
            revision,
            stagedVersion,
            completedVersion
          });
        }
        return updated;
      }
    );

    if (replacementImageJobId) {
      try {
        await dispatchWorkerGenerationJob(replacementImageJobId);
      } catch (error) {
        // The transaction above already made the GenerationJob row durable.
        // Reconciliation dispatches QUEUED rows with no Bull id, so Redis being
        // unavailable here is a defer, not a licence to export the old image.
        console.warn("Final-QA illustration dispatch deferred to reconciliation", {
          projectId: options.projectId,
          pageId: page.id,
          generationJobId: replacementImageJobId,
          error
        });
      }
      queuedReplacementIllustrations += 1;
    }

    const finalStatus = qualityReport.approved ? "COMPLETED" : "FAILED_QA";
    const semanticState = await persistFinalQaPageSemantics({
      ...(assertOwnership ? { assertOwnership } : {}),
      projectId: options.projectId,
      pageId: page.id,
      pageIndex,
      title: draft.title,
      markdown: draft.markdown,
      summary: draft.summary,
      imagePrompt,
      revision,
      status: finalStatus,
      updatedAt: completedVersion,
      plan: options.plan,
      keeperExtract,
      continuityNotes: qualityReport.approved ? draft.continuityNotes : [],
      usesSemanticMemory,
      preparedEmbedding
    });
    currentState = semanticState ?? currentState;

    const updatedPage = {
      ...page,
      ...publishedPage,
      title: draft.title,
      markdown: draft.markdown,
      summary: draft.summary,
      imagePrompt,
      revision,
      status: finalStatus,
      updatedAt: completedVersion
    };
    // Later repairs must see both the rewrite's prose and its honest status.
    pages = pages.map((candidate) => (candidate.index === page.index ? updatedPage : candidate));

    if (!qualityReport.approved) {
      await updateJobProgress(options.generationJobId, {
        message: `Final QA repair could not fully fix page ${pageIndex}; exporting its best draft. ${formatQualityFailure(pageIndex, qualityReport)}`
      });
    }
    pagesRepaired += 1;
  }

  // A page can become terminal once its tokened job is durable, but this
  // compile must not render before that job settles. Completing this compile
  // empty lets the image job's normal fan-in enqueue the next compile; the old
  // generated asset has already been retired, so no export can pair it with
  // the new prose in the meantime.
  if (queuedReplacementIllustrations > 0) {
    throw new ExportRepairIllustrationDeferredError();
  }

  return loadPagesForExport(options.projectId);
}

type FinalQaPageWriteClient = Pick<
  Prisma.TransactionClient,
  "page" | "imageAsset" | "generationJob"
>;

/** Publishes the page, generated-asset/job transition and repaired brief atomically. */
async function publishFinalQaPageAndBrief<T>(
  assertOwnership: FinalQaOwnershipClaim | undefined,
  pendingBriefRepair: PageQualityLoopOutcome["pendingBriefRepair"],
  writePage: (client: FinalQaPageWriteClient) => Promise<T>
): Promise<T> {
  return prisma.$transaction(async (tx) => {
    await assertOwnership?.(tx);
    const page = await writePage(tx);
    await pendingBriefRepair?.(tx);
    return page;
  });
}

function pageVersion(page: ExportPageForRepair): Date {
  const updatedAt = (page as ExportPageForRepair & { updatedAt?: unknown }).updatedAt;
  return updatedAt instanceof Date ? updatedAt : new Date(0);
}

function prismaErrorCode(error: unknown): string | undefined {
  if (!error || typeof error !== "object") {
    return undefined;
  }
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}

function illustrationKeeper(
  projectId: string,
  page: Pick<ExportPageForRepair, "id">,
  keeper: Omit<PageIllustrationKeeper, "projectId" | "pageId">
): PageIllustrationKeeper {
  return { projectId, pageId: page.id, ...keeper };
}

async function claimFinalQaIllustrationJob(
  client: Pick<Prisma.TransactionClient, "generationJob">,
  options: {
    projectId: string;
    planId: string;
    pageId: string;
    prompt: string;
    keeperToken: string;
    revision: number;
  }
): Promise<string> {
  const attemptId = currentGenerationAttemptId();
  const baseDedupeKey = `generate-image:${options.pageId}:${options.planId}:${options.revision}:${options.keeperToken}`;
  const dedupeKey = attemptId ? `${baseDedupeKey}:attempt:${attemptId}` : baseDedupeKey;
  const payload = {
    pageId: options.pageId,
    planId: options.planId,
    prompt: options.prompt,
    keeperToken: options.keeperToken
  };
  const job = await client.generationJob.upsert({
    where: { dedupeKey },
    create: {
      projectId: options.projectId,
      type: "GENERATE_IMAGE",
      status: "QUEUED",
      progress: 0,
      message: "Queued",
      dedupeKey,
      ...(attemptId ? { attemptId } : {}),
      ownsQualityVerdict: false,
      payload: payload as Prisma.InputJsonValue
    },
    update: {},
    select: { id: true, status: true }
  });
  return job.id;
}

async function completeFinalQaIllustratedKeeper(
  client: Pick<Prisma.TransactionClient, "generationJob" | "page">,
  options: {
    projectId: string;
    planId: string;
    imageJobId: string;
    pageId: string;
    title: string;
    markdown: string;
    summary: string;
    imagePrompt: string;
    keeperToken: string;
    revision: number;
    stagedVersion: Date;
    completedVersion: Date;
  }
): Promise<void> {
  const imageJob = await client.generationJob.findUnique({
    where: { id: options.imageJobId },
    select: { projectId: true, type: true, status: true, payload: true }
  });
  const payload = jsonRecord(imageJob?.payload);
  if (
    !imageJob ||
    imageJob.projectId !== options.projectId ||
    imageJob.type !== "GENERATE_IMAGE" ||
    !["QUEUED", "ACTIVE", "COMPLETED"].includes(imageJob.status) ||
    payload?.pageId !== options.pageId ||
    payload.planId !== options.planId ||
    payload.prompt !== options.imagePrompt ||
    payload.keeperToken !== options.keeperToken
  ) {
    throw new ExportRepairSupersededError();
  }
  const completed = await client.page.updateMany({
    where: {
      id: options.pageId,
      status: "GENERATING",
      updatedAt: options.stagedVersion,
      title: options.title,
      markdown: options.markdown,
      summary: options.summary,
      imagePrompt: options.imagePrompt,
      revision: options.revision
    },
    data: { status: "COMPLETED", updatedAt: options.completedVersion }
  });
  if (completed.count !== 1) {
    throw new ExportRepairSupersededError();
  }
}

function jsonRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}
