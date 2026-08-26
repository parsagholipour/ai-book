import { formatQualityFailure, styleExcerptsForPage } from "./bookHelpers.js";
import { updateJobProgress } from "../runtime/jobLifecycle.js";
import { type IndexedPageDraft } from "../runtime/jobTypes.js";
import { loadContinuityNotes, loadResearchNotesForGeneration } from "./generationContext.js";
import {
  enrichPageQualityReport,
  keeperStoryExtractForSave,
  persistStoryExtract,
  revisedDraftStyleAuditor,
  type QualityGateContext
} from "./qualityEnrichment.js";
import { prepareEmbedding, strategyUsesSemanticMemory, writePreparedEmbedding } from "./embeddingWrites.js";
import { updateEntityStateFromPage } from "./entityState.js";
import { retrieveSemanticResearchNotes } from "./researchMemory.js";
import { validateSemanticResearchNotes } from "./researchSources.js";
import { loadQualityContext } from "./qualitySettings.js";
import {
  GeneratedPagePublicationClaimLostError,
  loadGeneratedPagePublicationSnapshot,
  publishStagedGeneratedPage,
  settledGeneratedPageContext,
  stageGeneratedPageAndBrief
} from "./pagePublication.js";
import { pageQaCandidatesFor, pageQaRewriteAttemptsFor } from "./tuning.js";
import { revisePageDraftWithRestart } from "./pageRevision.js";
import { reviewPageWithQualityGates } from "./pageQualityGateReview.js";
import {
  pageRevisionMessage,
  pageRewriteReport,
  recoveryRevisionForLoop,
  repairPageBriefForRecovery,
  shouldRepairPageBriefForRecovery,
  type RepairedPageBrief
} from "./pageReviewRecovery.js";
import {
  styleAuditedScoreBeats,
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
  type StyleAuditedScore,
  type TextModelAdapter
} from "@book-maker/core";
import { pageScope } from "@book-maker/db";

export { revisePageDraftWithRestart } from "./pageRevision.js";
export { pageReviewPassesFor, reviewPageWithQualityGates } from "./pageQualityGateReview.js";

/**
 * Page quality review loop: score a draft, revise it, and save the best candidate.
 */

export type DraftCandidate = { draft: PageDraft; revision: number; report: PageQualityReport };

/**
 * A rewrite is not guaranteed to improve: the sixth attempt can score below the
 * second. Every review loop keeps its keeper through this one comparison so a
 * failed page is saved at its strongest draft, not its latest. Only some
 * candidates are ever style-audited — the initial draft and reviewer-approved
 * revisions — so the comparison is `styleAuditedScoreBeats`, which counts the
 * audit's penalty only against another audited candidate: subtracted from
 * `score` itself, the penalty handed the keeper's seat to a rejected rewrite
 * the auditor never saw.
 */
export function bestDraftCandidate(best: DraftCandidate, candidate: DraftCandidate): DraftCandidate {
  return styleAuditedScoreBeats(candidate.report, best.report) ? candidate : best;
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
  /**
   * This chapter's brief with the page's brief repair merged in, present only
   * when the page kept a draft that repair briefed — the same condition the
   * durable `Chapter.productionBrief` write is taken on, decided once below.
   *
   * A caller that briefs the chapter's *other* pages from one copy of the brief
   * (the book passes, whose `ChapterSetup.brief` is one object per chapter; the
   * compile's repair pass, which parses one per chapter) rebinds its copy to
   * this and so hands the chapter's later pages the assignment this page
   * actually delivered. A caller drafting one page per job has nobody to tell
   * and ignores it. Absent is the safe answer either way: the caller keeps the
   * brief it had, which is what the row keeps too.
   */
  repairedChapterBrief?: ChapterBrief | undefined;
  /**
   * The durable half of a kept brief repair, present only when the caller asked
   * to publish it with its own page write. The function accepts that caller's
   * transaction client, keeping the CAS implementation behind this narrow
   * seam rather than exposing chapter-row details here.
   */
  pendingBriefRepair?: NonNullable<RepairedPageBrief["persist"]> | undefined;
};

/**
 * The one score → revise → re-score loop behind every page review: the
 * generate-page handler, the direct passes' per-page review, the chat page
 * rewrite and the final-QA repair in compile-export.
 *
 * The counting base is the caller's: the page loops count *candidates* from
 * the original draft (`maxCandidates` = `pageQaCandidatesFor`), while final
 * QA counts *attempts* from the first rewrite — one later — which is why it
 * passes `recoveryRevision: PAGE_QA_RECOVERY_CANDIDATE - 1`. Both enter
 * recovery mode at the third rewrite; collapsing the two numbers into one
 * constant silently delays that by a rewrite. Whatever the caller asks for,
 * `recoveryRevisionForLoop` fits it to this loop's tier-scaled budget — down to
 * the last candidate for a budget that would never reach it, but never onto a
 * loop's first rewrite, and `undefined` for a loop that has no recovery at
 * all.
 *
 * **The style audit is the loop's, not the caller's.** Every caller used to
 * hand-assemble the same triple — a `styleExcerpts` array, a
 * `revisedDraftStyleAuditor` built from exactly those excerpts, and (in the two
 * callers whose seed report comes straight off `reviewPageDraft`) a duplicated
 * pre-loop "if the seed was approved, audit it too" block. Four copies of a
 * pair that is only meaningful when both halves name the *same* array: an audit
 * against excerpts the rewrite was not written from measures nothing, and the
 * only thing keeping them equal was that each copy happened to derive them the
 * same way. So the loop takes the excerpts and the quality gates and builds the
 * auditor itself, and audits **every** approved report it sees, the seed
 * included. A seed that has already been audited says so — see
 * `alreadyStyleAudited` — which is what keeps `enrichPageQualityReport`'s audit
 * of the initial draft from being paid for twice.
 */
export async function runPageQualityLoop(options: {
  projectId: string;
  strategy: BookGenerationStrategy;
  input: CreateProjectInput;
  plan: BookPlan;
  chapter?: ChapterPlan | undefined;
  chapterBrief?: ChapterBrief | undefined;
  pageBrief?: PageProductionBeat | undefined;
  chapterPageStart?: number | undefined;
  chapterPageEnd?: number | undefined;
  /** The gate on the brief repair's durable write; see the take below the loop. */
  chapterId?: string | null | undefined;
  pageIndex: number;
  draft: PageDraft;
  /** The initial draft's review, produced by the caller. */
  report: PageQualityReport;
  previousPages: PriorPageContext[];
  /** Prose that already exists after this page; set only when one is inserted. */
  nextPages?: PriorPageContext[] | undefined;
  continuityNotes: string[];
  /** Citeable notes loaded for this page; empty is an explicit citation gate. */
  researchNotes?: string[] | undefined;
  textModel: TextModelAdapter;
  generationJobId?: string | undefined;
  maxCandidates: number;
  recoveryRevision?: number | undefined;
  /**
   * Repair a conflicting page brief at the recovery candidate. Both the page
   * loops and the final-QA repair set this: a page whose brief collides with
   * a beat the book already covered fails review the same way on every
   * rewrite, so re-executing the brief unchanged spends the whole budget on
   * the one complaint a rewrite cannot answer. It buys **one** repair per
   * page however long the budget is — see the latch at the call site — and its
   * durable half is spent later still, only on a page that keeps a draft the
   * repair briefed.
   */
  repairBrief?: boolean | undefined;
  /**
   * Leave a kept repair staged for a caller that owns the corresponding page
   * publication. Direct loop callers default to the established standalone
   * CAS; `reviewAndSaveGeneratedPage` opts in so the page and chapter move in
   * one transaction.
   */
  deferBriefRepairPersistence?: boolean | undefined;
  reviseContext: string;
  reviseProgress?: number | undefined;
  /**
   * The pinned style lock. One array, three readers — the rewrite, the review
   * and the audit the loop builds below — because a second derivation of it is
   * a comparison against prose the draft was never written from.
   */
  styleExcerpts?: string[] | undefined;
  /** The operator's gate configuration; the loop reads `styleAuditor` off it. */
  quality: QualityGateContext;
  /**
   * The reader's own edit request, set only when this loop is repairing a page
   * they asked to change. It reaches two places, and both are load-bearing.
   * Every rewrite briefing gets "keep the requested edit applied", so a quality
   * revision cannot quietly undo what was paid for. And the style auditor is
   * told the change was requested: without it, "make page 12 more dramatic"
   * lands as a register shift away from the opening-pages excerpts, the audit
   * flips the reviewer's approval, the small user-edit budget burns pulling the
   * page back toward the voice it was asked to leave, and the edit is delivered
   * FAILED_QA — which then feeds the next compile's repair pass.
   */
  userRequest?: string | undefined;
  retrieveResearch?: ((draft: PageDraft, report: PageQualityReport) => Promise<string[]>) | undefined;
  /**
   * Per-rewrite progress reporting, in the caller's own style. The loop hands
   * over the recovery index it resolved as well as the revision it is about to
   * spend, because the two callers that render a message from it used to derive
   * that index themselves — `pageQaRecoveryRevision(pageQaCandidatesFor(input))`
   * at each call site — from an input that says nothing about `userRequest`.
   * A loop pinned to a reader's own edit opts out of recovery entirely (below),
   * so those call sites were one `onRewrite` away from telling an operator
   * "Quality recovery rewrite page 12" about a loop that will never write a
   * replacement page. The number the message reads has to be the number the
   * rewrites were briefed against, and one derivation is the only way to say so.
   */
  onRewrite?: ((revision: number, recoveryRevision: number | undefined) => Promise<void>) | undefined;
  /**
   * Optional ownership fence. A standalone kept repair is fenced here; a
   * deferred one is fenced by the caller's combined publication phase.
   */
  assertOwnership?: () => Promise<void>;
}): Promise<PageQualityLoopOutcome> {
  const styleExcerpts = options.styleExcerpts ?? [];
  const auditApprovedRevision = revisedDraftStyleAuditor({
    projectId: options.projectId,
    plan: options.plan,
    textModel: options.textModel,
    styleExcerpts,
    quality: options.quality,
    ...(options.userRequest ? { userRequest: options.userRequest } : {})
  });
  const auditApproved = async (candidate: PageDraft, candidateReport: PageQualityReport) =>
    auditApprovedRevision && candidateReport.approved && !alreadyStyleAudited(candidateReport)
      ? auditApprovedRevision(options.pageIndex, candidate, candidateReport)
      : candidateReport;

  let draft = options.draft;
  // Before `best` is seeded, not after: the audit may flip the seed's approval
  // and stamp its penalty, and a keeper comparison run against the pre-audit
  // copy would hand the page's seat to a rewrite on scores from two scales.
  let report = await auditApproved(draft, options.report);
  let pageBrief = options.pageBrief;
  /**
   * The loop's own, because a brief repair replaces it. The caller's object is
   * never written to: a book pass hands the same `ChapterSetup.brief` to every
   * page of a chapter, so a repair written through it would brief that
   * chapter's remaining pages against an assignment nothing had yet decided
   * this page would keep — see `repairPageBriefForRecovery`.
   */
  let chapterBrief = options.chapterBrief;
  // Spent by the *attempt*, and at most once per page — see the loop below.
  let briefRepairSpent = false;
  /**
   * The brief repair, held back until the page keeps a draft that was briefed
   * against it — both the durable write and the merged brief the caller's own
   * copy may become. See the take below the loop.
   */
  let deferredBriefRepair: {
    fromRevision: number;
    chapterBrief: ChapterBrief | undefined;
    persist: RepairedPageBrief["persist"];
  } | null = null;
  let revision = 1;
  let best: DraftCandidate = { draft, revision, report };
  const maxCandidates = options.quality.enabled("pageQaRewrite") ? options.maxCandidates : 1;
  // Fitted to this loop's budget at both ends, and `undefined` for a loop that
  // has no recovery at all — `recoveryRevisionForLoop` owns both answers, and
  // it is what `onRewrite` is handed, so a progress message cannot disagree
  // with the rewrite it is announcing about which mode this loop is in.
  const recoveryRevision = recoveryRevisionForLoop({
    maxCandidates,
    ...(options.recoveryRevision !== undefined ? { requested: options.recoveryRevision } : {}),
    ...(options.userRequest ? { userRequest: options.userRequest } : {})
  });

  while (!report.approved && revision < maxCandidates) {
    const nextRevision = revision + 1;
    await options.onRewrite?.(nextRevision, recoveryRevision);
    if (
      options.repairBrief &&
      !briefRepairSpent &&
      shouldRepairPageBriefForRecovery(nextRevision, report, pageBrief, recoveryRevision)
    ) {
      // One repair per page, and the latch is the only thing making it one.
      // `shouldRepairPageBriefForRecovery` asks about the *report*, and the
      // report is why this page is still in the loop: a reviewer answering
      // `repetitionOk: false` — the commonest way a page reaches recovery —
      // answers it the same way on every rewrite left, so the predicate alone
      // reads "repair from the recovery candidate onwards". On an ultra book
      // that is `finalQaRevisionsFor` 10 against a recovery fitted to 3:
      // rewrites 3 through 10 each spent a `repairPageBrief` planner call
      // nothing budgeted and, wherever a `chapterId` is supplied, wrote a
      // *different* beat into `Chapter.productionBrief` behind it — eight
      // model calls and eight durable chapter rewrites for one page, on a
      // compile repairing fifteen, with every other page of that chapter
      // reading the last one back. Nor is repetition a cheaper version of the
      // idea: the repair exists to hand the *remaining* rewrites a fresh
      // assignment, so re-running it on that assignment's own rejection asks
      // the planner to disown the beat it wrote one rewrite ago.
      //
      // Closed before the call, so a repair the provider refuses spends it
      // too: `embeddingRepair.ts`'s bargain at loop scale — a refusal not
      // written down is paid for again — and the page that draws a refusal is
      // exactly the page whose reviewer keeps flagging the same thing, so a
      // latch conditioned on the repair *working* would never close in the
      // case it was added for. A rewrite that could not be re-briefed still
      // carries the recovery instruction, which is the move that changes it.
      briefRepairSpent = true;
      const repair = await repairPageBriefForRecovery({
        strategy: options.strategy,
        input: options.input,
        plan: options.plan,
        chapter: options.chapter,
        chapterBrief,
        chapterPageStart: options.chapterPageStart,
        chapterPageEnd: options.chapterPageEnd,
        chapterId: options.chapterId,
        pageBrief,
        pageIndex: options.pageIndex,
        draft,
        qualityReport: report,
        previousPages: options.previousPages,
        continuityNotes: options.continuityNotes,
        researchNotes: options.researchNotes,
        textModel: options.textModel,
        generationJobId: options.generationJobId,
        context: options.reviseContext,
        ...(options.assertOwnership ? { assertOwnership: options.assertOwnership } : {})
      });
      // The rebind is the whole of the repair's in-memory reach: this loop's
      // remaining rewrites and reviews, and nothing the caller holds.
      pageBrief = repair.beat;
      chapterBrief = repair.chapterBrief;
      deferredBriefRepair = { fromRevision: nextRevision, chapterBrief: repair.chapterBrief, persist: repair.persist };
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
        chapterBrief,
        pageBrief,
        chapterPageStart: options.chapterPageStart,
        chapterPageEnd: options.chapterPageEnd,
        pageIndex: options.pageIndex,
        draft,
        report: pageRewriteReport(
          keepUserRequestApplied(report, options.userRequest),
          nextRevision,
          recoveryRevision
        ),
        previousPages: options.previousPages,
        ...(options.nextPages && options.nextPages.length > 0 ? { nextPages: options.nextPages } : {}),
        continuityNotes: options.continuityNotes,
        researchNotes: options.researchNotes,
        textModel: options.textModel,
        ...(styleExcerpts.length > 0 ? { styleExcerpts } : {}),
        ...(await retrievedResearchForRevise(options, draft, report))
      }
    });
    revision = nextRevision;
    report = await reviewPageWithQualityGates({
      strategy: options.strategy,
      quality: options.quality,
      reviewOptions: {
        input: options.input,
        plan: options.plan,
        chapter: options.chapter,
        chapterBrief,
        pageBrief,
        chapterPageStart: options.chapterPageStart,
        chapterPageEnd: options.chapterPageEnd,
        pageIndex: options.pageIndex,
        draft,
        previousPages: options.previousPages,
        ...(options.nextPages && options.nextPages.length > 0 ? { nextPages: options.nextPages } : {}),
        continuityNotes: options.continuityNotes,
        researchNotes: options.researchNotes,
        textModel: options.textModel,
        ...(styleExcerpts.length > 0 ? { styleExcerpts } : {})
      }
    });
    report = await auditApproved(draft, report);
    best = bestDraftCandidate(best, { draft, revision, report });
  }

  // ---- The repaired brief, taken only if the page kept a draft it briefed. ----
  //
  // `repairPageBriefForRecovery` re-plans the beat and hands the write back
  // rather than making it, because the rewrite that beat briefs has not been
  // judged yet and the write outlives this whole loop:
  // `Chapter.productionBrief` is what every later drafting job — a
  // continuation, a page regeneration, a replan — reads back as
  // `previousChapterPageBriefs`. Committed at the repair, a rejected rewrite
  // left the chapter permanently claiming a beat the shipped page never
  // delivers, and later pages then steered away from material the book still
  // contains. The last attempt is where that is ordinary rather than rare:
  // `finalQaRevisionsFor` is 3 on both fast and balanced and
  // `pageQaRecoveryRevision(3, 3)` is 3, so recovery lands on the final rewrite
  // and exactly one candidate is ever briefed against the repair. Nor could the
  // page save take it back — the chapter row committed under its own earlier
  // assertion, so a stand-down between the two leaves the brief changed and the
  // page unchanged.
  //
  // The same take decides the **merged brief** this loop hands back, for a
  // caller that briefs the chapter's other pages from one copy of it: the book
  // passes reuse one `ChapterSetup.brief` per chapter, and the final-QA repair
  // parses one per chapter. That copy and the row have to agree about whether
  // the repair was earned — agreeing by construction is what one condition
  // buys, and it is the whole reason `repairPageBriefForRecovery` writes into
  // nobody's object on the way past.
  //
  // *Kept*, not *approved*: a page that fails QA still ships its best draft,
  // and a chapter describing the assignment that draft was written to is right
  // for the same reason an approved one is. The test is the keeper's candidate
  // number against the rewrite the repair briefed — every candidate from that
  // one on was written against the fresh beat — and a keeper below it means the
  // page is shipping prose from before the repair, so the beat goes no further
  // than this loop's own memory. The latch above is spent either way: the call
  // was paid for, and a page whose reviewer keeps blaming its brief is exactly
  // the page that would buy a second planner call on the strength of the first
  // one's answer having been thrown away.
  const keptRevision = report.approved ? revision : best.revision;
  const keptBriefRepair =
    deferredBriefRepair && keptRevision >= deferredBriefRepair.fromRevision ? deferredBriefRepair : null;
  const pendingBriefRepair = keptBriefRepair?.persist ?? undefined;
  // A loop caller that does not own the page's durable publication keeps the
  // established standalone CAS. The explicit fence stays immediately before
  // it, a whole page of provider work after the repair's stand-down assertion.
  // A caller that *does* own publication takes both later — see the page/brief
  // transaction in `reviewAndSaveGeneratedPage`.
  let standaloneBriefRepairWritten = false;
  if (pendingBriefRepair && !options.deferBriefRepairPersistence) {
    await options.assertOwnership?.();
    standaloneBriefRepairWritten = (await pendingBriefRepair()) === "written";
  }
  const mayCarryBriefRepair = options.deferBriefRepairPersistence
    ? pendingBriefRepair !== undefined || keptBriefRepair !== null
    : pendingBriefRepair
      ? standaloneBriefRepairWritten
      : keptBriefRepair !== null;
  const carried = mayCarryBriefRepair && keptBriefRepair?.chapterBrief
    ? { repairedChapterBrief: keptBriefRepair.chapterBrief }
    : {};
  const pending = pendingBriefRepair && options.deferBriefRepairPersistence
    ? { pendingBriefRepair }
    : {};

  if (report.approved) {
    return { approved: true, draft, report, revision, attempts: revision, ...carried, ...pending };
  }
  return {
    approved: false,
    draft: best.draft,
    report: best.report,
    revision: best.revision,
    attempts: revision,
    ...carried,
    ...pending
  };
}

/**
 * Whether this exact report has already been through the style auditor.
 *
 * `withStyleAudit` stamps `stylePenalty` on everything it returns — zero when
 * the audit passed — precisely so a report can say it was audited at all, which
 * is what `styleAuditedScoreBeats` compares candidates on. The seed report a
 * page job hands this loop has been audited by `enrichPageQualityReport`
 * already; the seed a chat rewrite or a final-QA repair hands in comes straight
 * off `reviewPageDraft` and has not. That difference is the whole of who owes a
 * seed audit, and reading it off the report is what lets one rule serve both.
 * The field travels *beside* `PageQualityReport` rather than inside its schema,
 * hence the narrowing.
 */
function alreadyStyleAudited(report: PageQualityReport): boolean {
  return (report as StyleAuditedScore).stylePenalty !== undefined;
}

/**
 * A quality rewrite of a page the reader asked to change must repair the page
 * *around* their edit, never back out of it — the request is already in the
 * draft, and the rewrite is being asked for because something else about the
 * page failed review.
 */
function keepUserRequestApplied(report: PageQualityReport, userRequest: string | undefined): PageQualityReport {
  const instruction = userRequest ? `Keep the user's requested edit applied: ${userRequest}` : "";
  if (!instruction || report.requiredRevisions.includes(instruction)) {
    return report;
  }
  return { ...report, requiredRevisions: [instruction, ...report.requiredRevisions] };
}

/**
 * What one drafted page leaves behind for the pages after it.
 *
 * `page` is the saved keeper as the next pages read it back.
 * `repairedChapterBrief` is this chapter's brief with the page's brief repair
 * merged in, and it is present only when the page kept a draft that repair
 * briefed — see the take in `runPageQualityLoop`. A caller that briefs a
 * chapter's pages from one copy of its brief (the book passes, one
 * `ChapterSetup.brief` per chapter) rebinds that copy to it, so the chapter's
 * remaining pages are told what this page actually delivered; a caller drafting
 * a page into a finished book has nobody to tell and ignores it.
 */
export type SavedGeneratedPage = {
  page: PriorPageContext;
  repairedChapterBrief?: ChapterBrief | undefined;
};

/**
 * Reviews a drafted page, saves the keeper, and publishes everything the *next*
 * pages read back from it: the keeper's story delta, its continuity notes, its
 * entity state and its page embedding.
 *
 * That tail is why `assertOwnership` exists and why the function is shaped in
 * two halves. A structural insert drafts under a durable delivery lease
 * (`generation/structuralPageLease.ts`) which a stalled delivery can lose to a
 * replacement mid-page, and the tail used to run entirely between the caller's
 * fences: the fence sat before the page upsert and the caller's next one after
 * the whole function, with a story-extract model call, an embedding call and
 * four writes in between. A loser therefore published semantic state into a book
 * another delivery owned, and later pages consumed it — the winner's manuscript
 * carrying the loser's facts, notes and vectors, none of which the reader will
 * ever see on a page. The page row itself is the one thing that does not matter
 * there: it is keyed on project+index and the winner drafts the same ids.
 *
 * So every provider call the tail owes happens first, holding its result in
 * memory and writing nothing; then one assertion; then only writes, with
 * nothing slow between them. A delivery that has lost the lease stands down at
 * an assertion having published none of it.
 */
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
  /**
   * Prose that already exists after this page and is not being rewritten. Empty
   * for a book written front to back; set when a page is inserted into a
   * finished one, so the draft lands into what the reader already has.
   */
  nextPages?: PriorPageContext[] | undefined;
  generationJobId?: string | undefined;
  /**
   * Callers whose charge never priced images (book continuation) opt out; the
   * page is still reviewed and saved identically.
   */
  illustrate?: boolean | undefined;
  /**
   * Chapter/batch resume regenerates the whole unit containing the first
   * missing page. Its already-settled prefix must therefore accept the new
   * unit draft instead of treating this call as a redelivery of the old one.
   * Ordinary per-page redeliveries leave this false and remain idempotent.
   */
  settledPageToReplace?: (PriorPageContext & { imagePrompt: string | null }) | undefined;
  /**
   * Optional ownership fence for callers whose writes follow a durable lease.
   *
   * Called before the page upsert, and again before the semantic tail — see the
   * prepare/publish split below. It may throw, and a caller that fences with a
   * lease it has lost is expected to: the throw stands this delivery down before
   * it publishes anything, and the handler that owns the lease decides what that
   * means for the book. Callers with no lease pass nothing and are unchanged.
   */
  assertOwnership?: () => Promise<void>;
}): Promise<SavedGeneratedPage> {
  // Pin optimistic ownership before any review/rewrite provider call. A retry
  // of an already-settled page replays nothing, while a row that changes under
  // the paid work makes the publication claim below miss instead of letting an
  // older delivery overwrite the winner.
  const existingPage = await loadGeneratedPagePublicationSnapshot(options.projectId, options.draft.index);
  const settledPage = settledGeneratedPageContext(existingPage, options.draft.index);
  const replacesExpectedSettledPage =
    settledPage !== undefined &&
    options.settledPageToReplace?.index === settledPage.index &&
    options.settledPageToReplace.title === settledPage.title &&
    options.settledPageToReplace.markdown === settledPage.markdown &&
    options.settledPageToReplace.summary === settledPage.summary &&
    options.settledPageToReplace.imagePrompt === existingPage?.imagePrompt;
  if (settledPage && !replacesExpectedSettledPage) {
    return { page: settledPage };
  }
  const pageBrief = options.chapterBrief?.pages.find((brief) => brief.pageIndex === options.draft.index);
  // Whole book on purpose: this reviews a draft against the facts the book
  // currently holds, and a page inserted into finished prose (the caller that
  // passes `nextPages`) must be checked against what comes after it too.
  const continuityNotes = await loadContinuityNotes(options.projectId, { beforePageIndex: null });
  const researchNotes = await loadResearchNotesForGeneration(options.projectId, options.strategy, options.chapter);
  const quality = await loadQualityContext(options.input);
  // The book's own opening voice, not whatever the caller's window happens to
  // start at. This path had no lock at all, so `enrichPageQualityReport` fell
  // back to pinning from `previousPages` — and `continueBook` passes the last
  // eighteen pages, so a continuation drafted at page 41 was audited and
  // revised against pages 23 and 24. The initial `reviewPageDraft` used to
  // omit the lock even after the enrich/loop gained it, so on balanced the
  // auditor flipped a page the first reviewer had never compared to pages 1–2.
  const styleExcerpts = await styleExcerptsForPage({
    projectId: options.projectId,
    pageIndex: options.draft.index,
    recencyPages: options.previousPages,
    input: options.input,
    quality
  });
  const initialReport = await reviewPageWithQualityGates({
    strategy: options.strategy,
    quality,
    reviewOptions: {
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
      ...(options.nextPages && options.nextPages.length > 0 ? { nextPages: options.nextPages } : {}),
      continuityNotes,
      researchNotes,
      textModel: options.providers.text,
      ...(styleExcerpts.length > 0 ? { styleExcerpts } : {})
    }
  });
  const enriched = await enrichPageQualityReport({
    input: options.input,
    plan: options.plan,
    pageIndex: options.draft.index,
    draft: options.draft,
    report: initialReport,
    previousPages: options.previousPages,
    researchNotes,
    textModel: options.providers.text,
    projectId: options.projectId,
    quality,
    styleExcerpts
  });

  const outcome = await runPageQualityLoop({
    projectId: options.projectId,
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
    report: enriched.report,
    previousPages: options.previousPages,
    ...(options.nextPages && options.nextPages.length > 0 ? { nextPages: options.nextPages } : {}),
    continuityNotes,
    researchNotes,
    textModel: options.providers.text,
    generationJobId: options.generationJobId,
    maxCandidates: pageQaCandidatesFor(options.input),
    repairBrief: true,
    // This function owns the page write, so it also owns when the accepted
    // chapter repair becomes durable. The loop returns the CAS for the
    // transaction below instead of committing it ahead of the page fence.
    deferBriefRepairPersistence: true,
    reviseContext: `Page ${options.draft.index}`,
    quality,
    ...(styleExcerpts.length > 0 ? { styleExcerpts } : {}),
    ...(quality.enabled("claimRetrieve")
      ? {
          retrieveResearch: async (draft: PageDraft) =>
            validateSemanticResearchNotes(
              await retrieveSemanticResearchNotes({
                projectId: options.projectId,
                queryText: `${draft.title}\n${draft.summary}\n${draft.markdown}`.slice(0, 1200),
                embedding: options.providers.embedding,
                topK: 6
              }),
              researchNotes
            )
        }
      : {}),
    onRewrite: (nextRevision, recoveryRevision) =>
      updateJobProgress(options.generationJobId, {
        message: pageRevisionMessage(
          options.draft.index,
          nextRevision,
          pageQaRewriteAttemptsFor(options.input),
          recoveryRevision
        )
      }),
    ...(options.assertOwnership ? { assertOwnership: options.assertOwnership } : {})
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

  const pageStatus = qualityReport.approved ? "GENERATING" : "FAILED_QA";
  const assertOwnership = options.assertOwnership;
  await assertOwnership?.();
  const page = await stageGeneratedPageAndBrief({
    projectId: options.projectId,
    chapterId: options.chapterId,
    pageIndex: options.draft.index,
    draft,
    revision,
    qualityReport,
    status: pageStatus,
    pendingBriefRepair: outcome.pendingBriefRepair,
    existingPage,
    ...(assertOwnership ? { assertOwnership } : {})
  });

  // The page, and the chapter brief the pass may now brief this chapter's other
  // pages from. The repair reaches it only through the loop's own take — the
  // caller's brief was never written to — so a page that shipped its pre-repair
  // prose leaves the chapter exactly as it found it.
  const savedContext: SavedGeneratedPage = {
    page: {
      index: options.draft.index,
      title: draft.title,
      markdown: draft.markdown,
      summary: draft.summary
    },
    ...(outcome.repairedChapterBrief ? { repairedChapterBrief: outcome.repairedChapterBrief } : {})
  };

  // Nothing semantic is even *computed* for a delivery that has already lost the
  // row: the two provider calls below would be pure waste for it, and a barrier
  // is one statement. The publish barrier further down is the load-bearing one.
  await assertOwnership?.();

  // ---- Prepare: every provider call the tail owes, and not one write. ----
  //
  // Story state, continuity notes, entity state and the page embedding are read
  // back by *later* pages, so a delivery that has lost its lease publishing any
  // of them poisons the winner's book with prose the reader will never see. The
  // upsert above is the winner's to redo (it is keyed on project+index, and the
  // winner drafts the same page ids); these are not — the notes and the
  // embedding are appended, and the story state is merged. So the calls that
  // take time happen here, holding their results in memory, and the writes all
  // happen after one fresh assertion with nothing slow between them.
  const keeperExtract = await keeperStoryExtractForSave({
    projectId: options.projectId,
    pageIndex: options.draft.index,
    draft,
    textModel: options.providers.text,
    plan: options.plan,
    input: options.input,
    previousExtract: enriched.extract,
    keeperWasRevised: revision > 1,
    currentState: enriched.storyState,
    quality
  });
  // Embeddings and entity state are only read by sequential-pages jobs; the
  // direct modes writing them paid one embedding per page for nothing.
  const usesSemanticMemory = qualityReport.approved && strategyUsesSemanticMemory(options.strategy);
  const preparedEmbedding = usesSemanticMemory
    ? await prepareEmbedding(draft.summary, options.providers.embedding)
    : null;

  // ---- Publish: one verified claim, and then only writes. ----
  await assertOwnership?.();

  if (!qualityReport.approved) {
    // Skip continuity notes, embeddings, and illustration for a flagged page;
    // the final review rewrites it and the repaired version feeds those steps.
    if (keeperExtract) {
      await persistStoryExtract({
        projectId: options.projectId,
        pageIndex: options.draft.index,
        plan: options.plan,
        extract: keeperExtract
      });
    }
    return savedContext;
  }

  const willIllustrate =
    options.illustrate !== false &&
    Boolean(draft.imagePrompt) &&
    options.strategy.shouldIllustratePage(options.input, options.plan, options.draft.index);
  const publication = await publishStagedGeneratedPage({
    projectId: options.projectId,
    planId: options.planId,
    pageIndex: options.draft.index,
    draft,
    stagedPage: page,
    willIllustrate,
    continuityTags: ["page", String(options.draft.index), options.strategy.id]
  });
  // A declined enqueue leaves this staged keeper authoritative and retryable,
  // so later pages may still use the prose that is durable on its row. A lost
  // completion claim is different: this delivery's prose and repaired brief
  // have been superseded and may not escape into the caller's generation
  // context. Give a lease-backed caller's domain-specific stand-down error the
  // first chance to win, then stand the caller down. A direct pass has to
  // restart from durable chapter state as well as the winning page; returning
  // the page alone could still carry a brief that disagrees with its winner.
  if (publication === "enqueue-declined") {
    return savedContext;
  }
  if (publication === "superseded") {
    await assertOwnership?.();
    throw new GeneratedPagePublicationClaimLostError(options.draft.index);
  }

  if (keeperExtract) {
    await persistStoryExtract({
      projectId: options.projectId,
      pageIndex: options.draft.index,
      plan: options.plan,
      extract: keeperExtract
    });
  }

  if (usesSemanticMemory) {
    if (draft.continuityNotes.length > 0) {
      await updateEntityStateFromPage(options.projectId, options.draft.index, draft.continuityNotes);
    }
    if (preparedEmbedding) {
      await writePreparedEmbedding(
        { projectId: options.projectId, scope: pageScope(options.draft.index), sourceId: page.id, text: draft.summary },
        preparedEmbedding
      );
    }
  }

  return savedContext;
}

async function retrievedResearchForRevise(
  options: {
    retrieveResearch?: ((draft: PageDraft, report: PageQualityReport) => Promise<string[]>) | undefined;
  },
  draft: PageDraft,
  report: PageQualityReport
): Promise<{ retrievedResearch: string[] } | Record<string, never>> {
  if (!options.retrieveResearch || report.groundedOk !== false) {
    return {};
  }
  try {
    const notes = await options.retrieveResearch(draft, report);
    return notes.length > 0 ? { retrievedResearch: notes } : {};
  } catch (error) {
    console.warn("Failed-claim research retrieve skipped", error);
    return {};
  }
}
