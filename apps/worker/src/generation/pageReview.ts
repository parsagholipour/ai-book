import { quickDraftPageQuality } from "./quickDraftReviewPolicy.js";
import { changedCandidateGrounding } from "./changedCandidateGrounding.js";
import { formatQualityFailure } from "./bookHelpers.js";
import { updateJobProgress } from "../runtime/jobLifecycle.js";
import { type IndexedPageDraft } from "../runtime/jobTypes.js";
import { loadContinuityNotes, loadResearchNotesForGeneration } from "./generationContext.js";
import { revisedDraftStyleAuditor, type QualityGateContext } from "./qualityEnrichment.js";
import { prepareEmbedding, strategyUsesSemanticMemory, writePreparedEmbedding } from "./embeddingWrites.js";
import { updateEntityStateFromPage } from "./entityState.js";
import { loadQualityContext } from "./qualitySettings.js";
import {
  GeneratedPagePublicationClaimLostError,
  loadGeneratedPagePublicationSnapshot,
  publishStagedGeneratedPage,
  settledGeneratedPageContext,
  stageGeneratedPageAndBrief
} from "./pagePublication.js";
import { revisePageDraftWithRestart } from "./pageRevision.js";
import { reviewPageWithQualityGates } from "./pageQualityGateReview.js";
import {
  hasSmartUnslopCandidates, smartUnslopResolved,
  type DecisionModelRoute,
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
import { bestDraftCandidate, type DraftCandidate, type PageQualityLoopOutcome } from "./pageReviewCandidates.js";
export { bestDraftCandidate, type DraftCandidate, type PageQualityLoopOutcome } from "./pageReviewCandidates.js";
import type { QualityFeatureId } from "@book-maker/core/qualityGates";

export { revisePageDraftWithRestart } from "./pageRevision.js";
export { pageReviewPassesFor, reviewPageWithQualityGates } from "./pageQualityGateReview.js";

/**
 * The one score → revise → re-score loop, and a reader's chat page rewrite
 * (`textEditRewrite.ts`) is its only caller. Since 2026-10-16 no generated
 * page enters it: a page job, a book pass, a continuation, an insert and a
 * replan save the draft with its local checks (`withoutPageReview`, E4 and E5).
 * The branches only those callers reached went with them that day — the brief
 * repair and its durable chapter write, the recovery rewrites, the
 * sentence-length repair, the failed-claim research retrieve, the
 * no-improvement stop and the saved-keeper seed (E6).
 *
 * `maxCandidates` counts candidates from the rewrite the caller hands in, so a
 * budget of 1 reviews and audits that draft and rewrites nothing; with
 * `pageQaRewrite` off the loop never rewrites whatever the budget says.
 *
 * **The style audit is the loop's, not the caller's.** Every caller used to
 * hand-assemble the same triple — a `styleExcerpts` array, a
 * `revisedDraftStyleAuditor` built from exactly those excerpts, and a
 * duplicated pre-loop "if the seed was approved, audit it too" block — and an
 * audit against excerpts the rewrite was not written from measures nothing. So
 * the loop takes the excerpts and the quality gates, builds the auditor
 * itself, and audits **every** approved report it sees, the seed included. A
 * seed that has already been audited says so — see `alreadyStyleAudited`.
 */
export async function runPageQualityLoop(options: {
  projectId: string;
  strategy: BookGenerationStrategy;
  input: CreateProjectInput;
  plan: BookPlan;
  chapter?: ChapterPlan | undefined;
  chapterBrief?: ChapterBrief | undefined;
  pageBrief?: PageProductionBeat | undefined;
  pageIndex: number;
  draft: PageDraft;
  /** The page before the reader's edit; grounding and the reviewer compare against it. */
  originalDraft?: Pick<PageDraft, "title" | "markdown"> | undefined;
  /** The initial draft's review, produced by the caller. */
  report: PageQualityReport;
  previousPages: PriorPageContext[];
  continuityNotes: string[];
  /** Citeable notes loaded for this page; empty is an explicit citation gate. */
  researchNotes?: string[] | undefined;
  textModel: TextModelAdapter;
  decisions?: DecisionModelRoute | undefined;
  generationJobId?: string | undefined;
  maxCandidates: number;
  reviseContext: string;
  reviseProgress?: number | undefined;
  /**
   * The pinned style lock. One array, three readers — the rewrite, the review
   * and the audit the loop builds below — because a second derivation of it is
   * a comparison against prose the draft was never written from.
   */
  styleExcerpts?: string[] | undefined;
  /** Operator gates for rewrites, style audits, and changed-candidate grounding. */
  quality: QualityGateContext;
  /**
   * The reader's own edit request. It reaches two places, and both are
   * load-bearing. Every rewrite briefing gets "keep the requested edit
   * applied", so a quality revision cannot quietly undo what was paid for. And
   * the style auditor is told the change was requested: without it, "make page
   * 12 more dramatic" lands as a register shift away from the opening-pages
   * excerpts, the audit flips the reviewer's approval, the small user-edit
   * budget burns pulling the page back toward the voice it was asked to leave,
   * and the edit is delivered FAILED_QA.
   */
  userRequest?: string | undefined;
  characterContext?: string | undefined;
  /** Supplemental page-local guidance kept beside the authoritative userRequest. */
  pageEditGuidance?: string | undefined;
  /** Forwarded to every revise this loop spends; see `RevisePageOptions.figures`. */
  figures?: "keep" | "hold";
  /** Called before each rewrite with the candidate number it is about to spend. */
  onRewrite?: ((revision: number) => Promise<void>) | undefined;
}): Promise<PageQualityLoopOutcome> {
  const styleExcerpts = options.styleExcerpts ?? [];
  const auditApprovedRevision = revisedDraftStyleAuditor({
    ...(options.decisions ? { decisions: options.decisions } : {}),
    projectId: options.projectId,
    plan: options.plan,
    textModel: options.textModel,
    styleExcerpts,
    quality: options.quality,
    targetPages: options.input.targetPages,
    ...(options.userRequest ? { userRequest: options.userRequest } : {})
  });
  const auditApproved = async (candidate: PageDraft, candidateReport: PageQualityReport) =>
    auditApprovedRevision && candidateReport.approved && !alreadyStyleAudited(candidateReport)
      ? auditApprovedRevision(options.pageIndex, candidate, candidateReport)
      : candidateReport;

  const checkGrounding = changedCandidateGrounding({ ...options, original: options.originalDraft });
  const researchNotes = options.researchNotes;
  let draft = options.draft;
  // Before `best` is seeded, not after: the audit may flip the seed's approval
  // and stamp its penalty, and a keeper comparison run against the pre-audit
  // copy would hand the page's seat to a rewrite on scores from two scales.
  let report = await auditApproved(draft, await checkGrounding(draft, options.report, researchNotes ?? []));
  let revision = 1;
  let best: DraftCandidate = { draft, revision, report };
  // A deterministic candidate cluster buys one contextual rewrite. If the
  // writer returns the page unchanged because every match is protected, the
  // same scanner result must not burn the rest of this page's rewrite budget.
  let smartUnslopSpent = smartUnslopResolved(report);
  const maxCandidates = options.quality.enabled("pageQaRewrite") ? options.maxCandidates : 1;

  while (!report.approved && revision < maxCandidates) {
    const resolvesSmartUnslop =
      !smartUnslopSpent && hasSmartUnslopCandidates(report);
    const nextRevision = revision + 1;
    await options.onRewrite?.(nextRevision);
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
        pageBrief: options.pageBrief,
        pageIndex: options.pageIndex, qaCandidateNumber: nextRevision,
        draft,
        report: keepUserRequestApplied(report, options.userRequest),
        ...(options.userRequest ? { editInstruction: options.userRequest } : {}),
        ...(options.characterContext ? { characterContext: options.characterContext } : {}),
        ...(options.pageEditGuidance ? { pageEditGuidance: options.pageEditGuidance } : {}),
        ...(options.figures ? { figures: options.figures } : {}),
        previousPages: options.previousPages,
        continuityNotes: options.continuityNotes,
        researchNotes,
        textModel: options.textModel,
        ...(styleExcerpts.length > 0 ? { styleExcerpts } : {})
      }
    });
    revision = nextRevision;
    report = await reviewPageWithQualityGates({
      strategy: options.strategy,
      quality: options.quality,
      ...(options.decisions ? { decisions: options.decisions } : {}),
      ...(options.userRequest ? { userRequest: options.userRequest } : {}),
      allowSmartUnslop: !smartUnslopSpent && !resolvesSmartUnslop,
      reviewOptions: {
        repairOriginalMarkdown: (options.originalDraft ?? options.draft).markdown,
        input: options.input,
        plan: options.plan,
        chapter: options.chapter,
        chapterBrief: options.chapterBrief,
        pageBrief: options.pageBrief,
        pageIndex: options.pageIndex,
        draft,
        previousPages: options.previousPages,
        continuityNotes: options.continuityNotes,
        researchNotes,
        textModel: options.textModel,
        ...(styleExcerpts.length > 0 ? { styleExcerpts } : {})
      }
    });
    if (resolvesSmartUnslop || smartUnslopResolved(report)) {
      smartUnslopSpent = true;
    }
    report = await auditApproved(draft, await checkGrounding(draft, report, researchNotes ?? []));
    best = bestDraftCandidate(best, { draft, revision, report });
  }

  // Every candidate was grounded before entering selection, including failures.
  // A fallback therefore carries its own cached verdict. A failed page keeps
  // its strongest draft and honest report under the existing publication policy.
  if (report.approved) {
    return { approved: true, draft, report, revision, attempts: revision };
  }
  return {
    approved: false,
    draft: best.draft,
    report: best.report,
    revision: best.revision,
    attempts: revision
  };
}

/**
 * A quality rewrite of a page the reader asked to change must repair the page
 * *around* their edit, never back out of it — the request is already in the
 * draft, and the rewrite is being asked for because something else about the
 * page failed review.
 */
export function keepUserRequestApplied(report: PageQualityReport, userRequest: string | undefined): PageQualityReport {
  const instruction = userRequest ? `Keep the user's requested edit applied: ${userRequest}` : "";
  if (!instruction || report.requiredRevisions.includes(instruction)) {
    return report;
  }
  return { ...report, requiredRevisions: [instruction, ...report.requiredRevisions] };
}

/**
 * Whether this exact report has already been through the style auditor.
 *
 * `withStyleAudit` stamps `stylePenalty` on everything it returns — zero when
 * the audit passed — precisely so a report can say it was audited at all, which
 * is what `styleAuditedScoreBeats` compares candidates on. A seed that comes
 * straight off `reviewPageDraft` — the chat rewrite's — has not been, and owes
 * the audit; reading that off the report keeps the rule in one place.
 * The field travels *beside* `PageQualityReport` rather than inside its schema,
 * hence the narrowing.
 */
function alreadyStyleAudited(report: PageQualityReport): boolean {
  return (report as StyleAuditedScore).stylePenalty !== undefined;
}

/**
 * What one drafted page leaves behind for the pages after it: `page` is the
 * saved keeper as the next pages read it back.
 */
export type SavedGeneratedPage = {
  page: PriorPageContext;
  /** Always present for a `deferPublication` caller — which publishes this page itself, so a settled row it does not own throws rather than returning a candidate-less shape four call sites each invent an answer to. */
  candidate?: { draft: PageDraft; qualityReport: PageQualityReport } | undefined;
};

/**
 * Checks a drafted page locally, saves it, and publishes its continuity
 * notes, entity state and embedding. Provider calls first,
 * then one ownership assertion, then only writes — a lost lease publishes
 * none of that tail. See generation/CLAUDE.md.
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
  /** Check, publishing nothing until an operation-level gate passes. */
  deferPublication?: boolean | undefined;
  /**
   * The edit request a continuation, insert or replan drafted this page for. It
   * keeps Quick Draft's page gates undeferred (`quickDraftPageQuality`); no
   * model reviews the page either way.
   */
  editInstruction?: string | undefined;
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
    // A deferred caller publishes this page itself, so a row somebody else
    // settled is a lost claim rather than its replay; its own fence speaks first.
    if (!options.deferPublication) return { page: settledPage };
    await options.assertOwnership?.();
    throw new GeneratedPagePublicationClaimLostError(options.draft.index);
  }
  const pageBrief = options.chapterBrief?.pages.find((brief) => brief.pageIndex === options.draft.index);
  // Whole book on purpose: this reviews a draft against the facts the book
  // currently holds, and a page inserted into finished prose (the caller that
  // passes `nextPages`) must be checked against what comes after it too.
  const continuityNotes = await loadContinuityNotes(options.projectId, { beforePageIndex: null });
  const researchNotes = await loadResearchNotesForGeneration(options.projectId, options.strategy, options.chapter);
  const quality = withoutPageReview(
    quickDraftPageQuality(options.input, await loadQualityContext(options.input), options.editInstruction)
  );
  // The deterministic local checks, and nothing a model reads or rewrites: see
  // `withoutPageReview`. The page is saved as drafted, with its report.
  const qualityReport = await reviewPageWithQualityGates({
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
      textModel: options.providers.text
    }
  });
  const draft = options.draft;
  const revision = 1;

  const pageContext: PriorPageContext = {
    index: options.draft.index,
    title: draft.title,
    markdown: draft.markdown,
    summary: draft.summary
  };
  if (options.deferPublication) {
    return { page: pageContext, candidate: { draft, qualityReport } };
  }

  if (!qualityReport.approved) {
    // Page-level failure isolation: keep the draft with its honest report,
    // flag the page, and let the rest of the book continue.
    await updateJobProgress(options.generationJobId, {
      message: `Page ${options.draft.index} kept its draft but failed its local checks. ${formatQualityFailure(options.draft.index, qualityReport)}`
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
    existingPage,
    illustrationContext: { input: options.input, plan: options.plan, planId: options.planId },
    ...(assertOwnership ? { assertOwnership } : {})
  });

  const savedContext: SavedGeneratedPage = { page: pageContext };

  // Nothing semantic is even *computed* for a delivery that has already lost the
  // row: the provider call below would be pure waste for it, and a barrier
  // is one statement. The publish barrier further down is the load-bearing one.
  await assertOwnership?.();

  // ---- Prepare: every provider call the tail owes, and not one write. ----
  //
  // Continuity notes, entity state and the page embedding are read back by
  // *later* pages, so a delivery that has lost its lease publishing any of them
  // poisons the winner's book with prose the reader will never see. The upsert
  // above is the winner's to redo (it is keyed on project+index, and the winner
  // drafts the same page ids); these are not — the notes and the embedding are
  // appended. So the call that takes time happens here, holding its result in
  // memory, and the writes all happen after one fresh assertion with nothing
  // slow between them. No story extract: no generated page pays for story
  // memory (E6, 2026-10-16).
  // Embeddings and entity state are only read by sequential-pages jobs; the
  // direct modes writing them paid one embedding per page for nothing.
  const usesSemanticMemory = qualityReport.approved && strategyUsesSemanticMemory(options.strategy);
  const preparedEmbedding = usesSemanticMemory
    ? await prepareEmbedding(draft.summary, options.providers.embedding)
    : null;

  // ---- Publish: one verified claim, and then only writes. ----
  await assertOwnership?.();

  if (!qualityReport.approved) {
    // Skip continuity notes, embeddings, and illustration for a flagged page.
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

/**
 * The page review gates no generated page answers to, on any tier: a page a book
 * pass, a page job, a continuation, a structural insert or a replan drafts keeps
 * the deterministic local checks only, and is saved as drafted. E4 measured the
 * chain on short books (polish and every review against the raw draft: 3 wins / 7
 * ties / 7 losses, gpt-6-luna, which drafts every tier), and E5
 * (`.scratch/eval-data/reports/e5-final-review-sweep.md`) applied it to every
 * other page generation drafts, where no stored arm existed to measure. The
 * owner's rule (2026-10-16): a review that improves books by 5–10% or not at all
 * is removed, Premium and Ultra included. These gates still switch a reader's
 * chat page rewrite (`textEditRewrite.ts`), and `pageQaRewrite` the compile's
 * scoped repair and the composed finalize's integrity revise. (Story memory,
 * `storyExtractAudit`, is not here because it was removed outright on
 * 2026-10-16, E6.)
 */
const PAGE_REVIEW_GATES = new Set<QualityFeatureId>([
  "pageModelReview", "pageQaRewrite", "smartUnslop", "styleAuditor", "changedCandidateGrounding"
]);

/** A generated page's quality context: every gate but the page review ones above. */
export function withoutPageReview<T extends QualityGateContext>(quality: T): T {
  return { ...quality, enabled: (feature: QualityFeatureId) => !PAGE_REVIEW_GATES.has(feature) && quality.enabled(feature) };
}
