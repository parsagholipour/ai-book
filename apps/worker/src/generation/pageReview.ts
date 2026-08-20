import { formatQualityFailure, parseChapterBrief, styleExcerptsForPage } from "./bookHelpers.js";
import { enqueueWorkerJob } from "../runtime/dispatch.js";
import { updateJobProgress } from "../runtime/jobLifecycle.js";
import { type IndexedPageDraft } from "../runtime/jobTypes.js";
import { uniqueStrings } from "../runtime/serialization.js";
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
import { loadQualityContext } from "./qualitySettings.js";
import {
  MAX_PAGE_QA_CANDIDATES,
  MAX_PAGE_QA_REWRITE_ATTEMPTS,
  MAX_PAGE_REVISE_RESTARTS,
  PAGE_QA_RECOVERY_CANDIDATE
} from "./tuning.js";
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
  type RevisePageOptions,
  type StyleAuditedScore,
  type TextModelAdapter
} from "@book-maker/core";
import { pageScope, Prisma, prisma } from "@book-maker/db";

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
};

/**
 * The one score → revise → re-score loop behind every page review: the
 * generate-page handler, the direct passes' per-page review, the chat page
 * rewrite and the final-QA repair in compile-export.
 *
 * The counting base is the caller's: the page loops count *candidates* from
 * the original draft (`maxCandidates` = MAX_PAGE_QA_CANDIDATES), while final
 * QA counts *attempts* from the first rewrite — one later — which is why it
 * passes `recoveryRevision: PAGE_QA_RECOVERY_CANDIDATE - 1`. Both enter
 * recovery mode at the third rewrite; collapsing the two numbers into one
 * constant silently delays that by a rewrite.
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
  chapterId?: string | null | undefined;
  pageIndex: number;
  draft: PageDraft;
  /** The initial draft's review, produced by the caller. */
  report: PageQualityReport;
  previousPages: PriorPageContext[];
  /** Prose that already exists after this page; set only when one is inserted. */
  nextPages?: PriorPageContext[] | undefined;
  continuityNotes: string[];
  textModel: TextModelAdapter;
  generationJobId?: string | undefined;
  maxCandidates: number;
  recoveryRevision?: number | undefined;
  /** Page loops repair a drifted page brief at the recovery candidate; final QA does not. */
  repairBrief?: boolean | undefined;
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
  /** Per-rewrite progress reporting, in the caller's own style. */
  onRewrite?: ((revision: number) => Promise<void>) | undefined;
  /**
   * Optional ownership fence. The loop itself writes nothing, but a brief
   * repair does — see `repairPageBriefForRecovery`.
   */
  assertOwnership?: (() => Promise<void>) | undefined;
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
        context: options.reviseContext,
        ...(options.assertOwnership ? { assertOwnership: options.assertOwnership } : {})
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
        report: pageRewriteReport(
          keepUserRequestApplied(report, options.userRequest),
          nextRevision,
          options.recoveryRevision ?? PAGE_QA_RECOVERY_CANDIDATE
        ),
        previousPages: options.previousPages,
        ...(options.nextPages && options.nextPages.length > 0 ? { nextPages: options.nextPages } : {}),
        continuityNotes: options.continuityNotes,
        textModel: options.textModel,
        ...(styleExcerpts.length > 0 ? { styleExcerpts } : {}),
        ...(await retrievedResearchForRevise(options, draft, report))
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
      ...(options.nextPages && options.nextPages.length > 0 ? { nextPages: options.nextPages } : {}),
      continuityNotes: options.continuityNotes,
      textModel: options.textModel,
      ...(styleExcerpts.length > 0 ? { styleExcerpts } : {})
    });
    report = await auditApproved(draft, report);
    best = bestDraftCandidate(best, { draft, revision, report });
  }

  if (report.approved) {
    return { approved: true, draft, report, revision, attempts: revision };
  }
  return { approved: false, draft: best.draft, report: best.report, revision: best.revision, attempts: revision };
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
   * Optional ownership fence for callers whose writes follow a durable lease.
   *
   * Called before the page upsert, and again before the semantic tail — see the
   * prepare/publish split below. It may throw, and a caller that fences with a
   * lease it has lost is expected to: the throw stands this delivery down before
   * it publishes anything, and the handler that owns the lease decides what that
   * means for the book. Callers with no lease pass nothing and are unchanged.
   */
  assertOwnership?: (() => Promise<void>) | undefined;
}): Promise<PriorPageContext> {
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
    ...(options.nextPages && options.nextPages.length > 0 ? { nextPages: options.nextPages } : {}),
    continuityNotes,
    textModel: options.providers.text,
    ...(styleExcerpts.length > 0 ? { styleExcerpts } : {})
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
    textModel: options.providers.text,
    generationJobId: options.generationJobId,
    maxCandidates: MAX_PAGE_QA_CANDIDATES,
    repairBrief: true,
    reviseContext: `Page ${options.draft.index}`,
    quality,
    ...(styleExcerpts.length > 0 ? { styleExcerpts } : {}),
    ...(quality.enabled("claimRetrieve")
      ? {
          retrieveResearch: (draft: PageDraft) =>
            retrieveSemanticResearchNotes({
              projectId: options.projectId,
              queryText: `${draft.title}\n${draft.summary}\n${draft.markdown}`.slice(0, 1200),
              embedding: options.providers.embedding,
              topK: 6
            })
        }
      : {}),
    onRewrite: (nextRevision) =>
      updateJobProgress(options.generationJobId, {
        message: pageRevisionMessage(options.draft.index, nextRevision, MAX_PAGE_QA_REWRITE_ATTEMPTS)
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

  const pageStatus = qualityReport.approved ? "COMPLETED" : "FAILED_QA";
  const assertOwnership = options.assertOwnership;
  await assertOwnership?.();
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

  const savedContext: PriorPageContext = {
    index: options.draft.index,
    title: draft.title,
    markdown: draft.markdown,
    summary: draft.summary
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

  if (keeperExtract) {
    await persistStoryExtract({
      projectId: options.projectId,
      pageIndex: options.draft.index,
      plan: options.plan,
      extract: keeperExtract
    });
  }

  if (!qualityReport.approved) {
    // Skip continuity notes, embeddings, and illustration for a flagged page;
    // the final review rewrites it and the repaired version feeds those steps.
    return savedContext;
  }

  if (draft.continuityNotes.length > 0) {
    await prisma.continuityNote.createMany({
      data: draft.continuityNotes.map((body) => ({
        projectId: options.projectId,
        pageId: page.id,
        scope: pageScope(options.draft.index),
        body,
        tags: ["page", String(options.draft.index), options.strategy.id]
      }))
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

  if (options.illustrate !== false && draft.imagePrompt && options.strategy.shouldIllustratePage(options.input, options.plan, options.draft.index)) {
    await enqueueWorkerJob({
      projectId: options.projectId,
      type: "GENERATE_IMAGE",
      payload: { pageId: page.id, planId: options.planId, prompt: draft.imagePrompt },
      dedupeKey: `generate-image:${page.id}:${options.planId}:${page.revision}`
    });
  }

  return savedContext;
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
  /** Ownership fence for the persisted repair; see the call site below. */
  assertOwnership?: (() => Promise<void>) | undefined;
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
    // The one write on the *drafting* side of the page save, and it is read back
    // by every other page in the chapter, so it is fenced for the same reason
    // the semantic tail is: the repair above is a model call, and a delivery
    // that lost the book across it must not leave its opinion of the chapter's
    // beats behind. The in-memory replacement above stays either way — it only
    // steers this page's own remaining rewrites, which nobody else can see.
    await options.assertOwnership?.();
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
 * per-entity continuity state in entityState.ts.
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
