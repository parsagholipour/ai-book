import { chapterSetupForPage, loadContinuityNotes, loadResearchNotesForGeneration } from "./generationContext.js";
import { resolveEditPromptContext } from "./editOperationContext.js";
import { styleExcerptsForPage, toPriorPageContext } from "./bookHelpers.js";
import { prepareChapterSetups } from "./bookState.js";
import {
  prepareDeferredPageStoryContext,
  type PreparedDeferredPageMemory
} from "./deferredPageMemory.js";
import { prepareEmbedding, strategyUsesSemanticMemory } from "./embeddingWrites.js";
import { reviewAndSaveGeneratedPage, revisePageDraftWithRestart } from "./pageReview.js";
import { enqueueRevisionOwnedReplanIllustrations } from "./replanPageIllustrationDispatch.js";
import { type QualityGateContext } from "./qualityEnrichment.js";
import { loadQualityContext } from "./qualitySettings.js";
import {
  isReplanEditLeaseLostError,
  releaseReplanEditTailLease,
  startReplanEditLeaseHeartbeat,
  startReplanEditTailLeaseHeartbeat,
  waitForReplanEditLease,
  waitForReplanEditLeaseCompletion
} from "./replanEditLease.js";
import {
  assertActiveReplanEditLeaseTx,
  publishReplannedBook,
  type ReplanAudit,
  type ReplanCandidate,
  type SourcePage
} from "./replanPublication.js";
import {
  replanFollowUpIdentityFromClassifier,
  replannedBookFollowUpCompletion,
  type ReplanFollowUpIdentity
} from "./replanFollowUp.js";
import { advanceJobStep } from "../runtime/jobLifecycle.js";
import { UnownedReplanDeliveryError, type ChapterSetup, type JobCompletion } from "../runtime/jobTypes.js";
import {
  formatStoryStateLines,
  reviewAppliedBookEdit,
  seedStoryStateFromPromises,
  type BookGenerationStrategy,
  type BookPlan,
  type CreateProjectInput,
  type EditAdherenceVerdict,
  type PageDraft,
  type PageQualityReport,
  type PriorPageContext,
  type ProviderSet,
  type StoryState
} from "@book-maker/core";
import { EDIT_ADHERENCE_FAILED, ReaderEditFailure } from "@book-maker/core/editFailure";
import { Prisma, prisma } from "@book-maker/db";
import { randomUUID } from "node:crypto";

/**
 * One page's story extract, kept beside the exact draft and the exact incoming
 * story state it was asked about.
 *
 * The drafting loop already buys an extract per page — it is what advances
 * `inMemoryStoryState`, which briefs the next page — and the publication needs
 * the same extracts, in the same order, over the same states. Re-deriving them
 * was a second model call per page asking an identical question: a 40-page
 * replan spent 80 extracts on 40 pages of work. Reuse is decided by identity,
 * not by page number: a candidate an adherence-repair round replaced is a
 * different draft object, and every page after it is offered a different
 * incoming state, so both miss and are re-asked.
 */
type ReplanPageStoryContext = Awaited<ReturnType<typeof prepareDeferredPageStoryContext>> & {
  draft: PageDraft;
  fromState: StoryState;
};

export async function generateReplannedBook(options: {
  projectId: string;
  sourceProjectId?: string | undefined;
  planId: string;
  operationId: string;
  input: CreateProjectInput;
  plan: BookPlan;
  providers: ProviderSet;
  strategy: BookGenerationStrategy;
  generationJobId?: string | undefined;
  attemptId?: string | undefined;
  queuedEditInstruction?: string | undefined;
  queuedRequest?: string | undefined;
  queuedCharacterContext?: string | undefined;
}): Promise<JobCompletion> {
  const operation = await prisma.bookEditOperation.findUnique({ where: { id: options.operationId } });
  if (!operation) throw new Error("Book edit operation not found");
  const { editInstruction, characterContext } = resolveEditPromptContext(operation, {
    editInstruction: options.queuedEditInstruction,
    request: options.queuedRequest,
    characterContext: options.queuedCharacterContext
  });
  const sourceProjectId = resolveCandidateSourceProjectId({
    targetProjectId: options.projectId,
    queuedSourceProjectId: options.sourceProjectId,
    operationProjectId: operation.projectId,
    durableSourceProjectId: operation.sourceProjectId
  });
  const ownerToken = randomUUID();
  const knownTailIdentity = operation.status === "APPLIED"
    ? replanFollowUpIdentityFromClassifier(operation.classifier, {
        projectId: options.projectId,
        operationId: options.operationId
      })
    : null;
  // The claim's tail-identity check locks Project and re-asserts this
  // unheartbeated token, so losing the lease there is the same supersession
  // verdict as losing it mid-delivery — and outside the guard below it reached
  // `markFailed`, refunding a replan already APPLIED in the reader's hands.
  const claim = await waitForReplanEditLease(options.operationId, ownerToken, knownTailIdentity).catch(
    (error: unknown) => (isReplanEditLeaseLostError(error) ? standDownReplanDelivery(options.operationId) : Promise.reject(error))
  );
  if (claim.outcome === "completed") return {};
  if (claim.outcome === "settled" || claim.outcome === "abandoned") {
    throw new UnownedReplanDeliveryError();
  }
  const heartbeat = startReplanEditLeaseHeartbeat(options.operationId, ownerToken);

  try {
    if (claim.phase === "tail") {
      const appliedOperation = await prisma.bookEditOperation.findUnique({
        where: { id: options.operationId },
        select: { classifier: true }
      });
      const identity = replanFollowUpIdentityFromClassifier(appliedOperation?.classifier, {
        projectId: options.projectId,
        operationId: options.operationId
      });
      if (!identity) throw new UnownedReplanDeliveryError();
      return replannedBookDeliveryCompletion(options, identity, ownerToken);
    }
    const identity = await generateOwnedReplannedBook({
      ...options,
      editInstruction,
      ...(characterContext ? { characterContext } : {}),
      sourceProjectId,
      ownerToken,
      assertLease: heartbeat.assertHeld
    });
    return replannedBookDeliveryCompletion(options, identity, ownerToken);
  } catch (error) {
    if (error instanceof UnownedReplanDeliveryError) throw error;
    if (!isReplanEditLeaseLostError(error)) {
      try {
        await heartbeat.assertHeld();
      } catch (ownershipError) {
        if (!isReplanEditLeaseLostError(ownershipError)) throw error;
        await standDownReplanDelivery(options.operationId);
      }
      throw error;
    }
    return standDownReplanDelivery(options.operationId);
  } finally {
    await heartbeat.stop();
  }
}

/**
 * The published manuscript's tail, with its page illustrations queued in front
 * of it.
 *
 * Inside `afterJobCompleted`, and ahead of the follow-up's own steps, for two
 * reasons. The delivery is already COMPLETED and settled, so an enqueue outage
 * must not reach the failure/refund boundary — Bull replays this tail instead,
 * and the enqueue is idempotent under its keeper-tokened dedupe key. And the
 * follow-up's compile step has to *see* those jobs open, so it answers
 * `waiting` and lets the last illustration's fan-in own the export, rather than
 * publishing a book whose pictures are still being drawn.
 *
 * Being *ahead* of them is what makes the heartbeat and the release this
 * function's own to open. `generateReplannedBook`'s drafting heartbeat has
 * already stopped when the caller invokes this, and
 * `replannedBookFollowUpCompletion` starts the tail's only as its first
 * statement — so this loop sat between the two, renewing nothing, and its throw
 * escaped past the catch that releases. A queue outage on page 40 of 200 left
 * the tail lease held with nothing behind it: exports never retired, cover and
 * compile never queued, and every rival delivery waiting out the full TTL for an
 * owner that had already given up. One heartbeat per delivery either way — this
 * one is stopped before the follow-up's starts.
 */
function replannedBookDeliveryCompletion(
  options: Parameters<typeof replannedBookFollowUpCompletion>[0],
  identity: ReplanFollowUpIdentity,
  ownerToken: string
): JobCompletion {
  const completion = replannedBookFollowUpCompletion(options, identity, ownerToken);
  return {
    ...completion,
    afterJobCompleted: async () => {
      const heartbeat = startReplanEditTailLeaseHeartbeat(identity, ownerToken);
      try {
        await enqueueRevisionOwnedReplanIllustrations({
          projectId: identity.projectId,
          planVersionId: identity.planVersionId,
          publicationRevision: identity.publicationRevision,
          input: options.input,
          plan: options.plan,
          strategy: options.strategy,
          assertLease: heartbeat.assertHeld
        });
      } catch (error) {
        console.error("Replan page illustration dispatch failed", {
          event: "generation.replan_illustration_dispatch_failed",
          operationId: identity.operationId,
          projectId: identity.projectId,
          error
        });
        await releaseReplanEditTailLease(identity, ownerToken).catch((releaseError: unknown) => {
          console.error("Could not release the replan tail after an illustration dispatch failure", {
            event: "generation.replan_follow_up_release_failed",
            operationId: identity.operationId,
            error: releaseError
          });
        });
        throw error;
      } finally {
        await heartbeat.stop();
      }
      await completion.afterJobCompleted?.();
    }
  };
}

/**
 * Which page of the rewrite is being worked on, and what is being done to it.
 *
 * A replan drafts and reviews every page of the book and may then walk the whole
 * set twice more, which on a sixty-page book is many minutes. It reported once,
 * at zero, and next moved when the manuscript was published — the sibling
 * `restructurePagesDrafting.ts` calls its own `reportPage` at the top of both of
 * its loops for the same span of work.
 *
 * The key is `setup`, "Create pages" in this job's own `JOB_STEP_TEMPLATES`
 * entry. It used to be `generate`, which is a `REPLAN_BOOK` step key — this runs
 * on the successor `GENERATE_BOOK` row, whose steps are `briefs`/`setup`/
 * `enqueue` — and `advanceJobStep` marks *every* step done when it cannot find
 * the one named, dropping the counters on the floor with them. So the one call
 * that existed reported a finished job with no active step for the whole
 * rewrite.
 */
async function reportReplanDraftPage(
  generationJobId: string | undefined,
  phase: "draft" | "revise",
  done: number,
  total: number,
  pageIndex?: number,
  repairRound = 1
): Promise<void> {
  // Drafting owns most of the setup band. The two possible adherence-repair
  // rounds own the remaining five points each, so discovering more work can
  // never move the durable job's percentage backwards.
  const progressStart = phase === "draft" ? 35 : 60 + Math.min(Math.max(repairRound, 1), 2) * 5;
  const progressSpan = phase === "draft" ? 30 : 5;
  await advanceJobStep(
    generationJobId,
    "setup",
    progressStart + Math.round((done / Math.max(total, 1)) * progressSpan),
    phase === "draft" ? "Drafting revised manuscript" : "Revising the rewritten pages",
    { done, total, phase, ...(pageIndex === undefined ? {} : { pageIndex }) }
  );
}

async function standDownReplanDelivery(operationId: string): Promise<never> {
  await waitForReplanEditLeaseCompletion(operationId).catch((error: unknown) => {
    console.error("Could not observe the winning replan delivery before standing down",
      { event: "generation.replan_lease_stand_down_wait_failed", operationId, error });
  });
  throw new UnownedReplanDeliveryError();
}

async function generateOwnedReplannedBook(options: {
  projectId: string;
  sourceProjectId: string;
  planId: string;
  operationId: string;
  input: CreateProjectInput;
  plan: BookPlan;
  providers: ProviderSet;
  strategy: BookGenerationStrategy;
  generationJobId?: string | undefined;
  attemptId?: string | undefined;
  editInstruction: string;
  characterContext?: string | undefined;
  ownerToken: string;
  assertLease: () => Promise<void>;
}): Promise<ReplanFollowUpIdentity> {
  await options.assertLease();

  const sourcePages = (await prisma.page.findMany({
    where: { projectId: options.sourceProjectId },
    orderBy: { index: "asc" },
    select: {
      id: true,
      index: true,
      title: true,
      markdown: true,
      summary: true,
      imagePrompt: true,
      revision: true
    }
  })).sort((left, right) => left.index - right.index);
  if (sourcePages.length === 0) {
    throw new Error("Cannot review a replan against an empty source manuscript");
  }
  const sourceByIndex = new Map(sourcePages.map((page) => [page.index, page]));
  await options.assertLease();
  const setups = await prepareChapterSetups(options);
  await options.assertLease();
  const quality = await loadQualityContext(options.input);
  const continuityNotes = await loadContinuityNotes(options.projectId, { beforePageIndex: null });
  const inMemoryContinuityNotes = [...continuityNotes];
  const baseStoryState = seedStoryStateFromPromises(options.plan.promises ?? []);
  let inMemoryStoryState = baseStoryState;
  const researchByChapter = new Map<number, string[]>();
  const candidates = new Map<number, ReplanCandidate>();
  const storyContexts = new Map<number, ReplanPageStoryContext>();

  for (let pageIndex = 1; pageIndex <= options.input.targetPages; pageIndex += 1) {
    await options.assertLease();
    await reportReplanDraftPage(options.generationJobId, "draft", pageIndex - 1, options.input.targetPages, pageIndex);
    const setup = chapterSetupForPage(setups, pageIndex);
    if (!setup) throw new Error(`No revised chapter owns page ${pageIndex}`);
    const previousPages = candidateContexts(candidates, pageIndex);
    const pageContinuityNotes = [...inMemoryContinuityNotes];
    let researchNotes = researchByChapter.get(setup.chapter.index);
    if (!researchNotes) {
      researchNotes = await loadResearchNotesForGeneration(options.projectId, options.strategy, setup.chapter);
      researchByChapter.set(setup.chapter.index, researchNotes);
    }
    const styleExcerpts = await styleExcerptsForPage({
      projectId: options.projectId,
      pageIndex,
      recencyPages: previousPages,
      input: options.input,
      quality
    });
    await options.assertLease();
    const draft = await options.strategy.generatePageDraft({
      input: options.input,
      plan: options.plan,
      chapter: setup.chapter,
      chapterBrief: setup.brief,
      pageIndex,
      editInstruction: options.editInstruction,
      ...(options.characterContext ? { characterContext: options.characterContext } : {}),
      previousSummaries: previousPages.map((page) => page.summary).slice(-40),
      previousPages: previousPages.slice(-6),
      continuityNotes: pageContinuityNotes,
      researchNotes,
      entityState: formatStoryStateLines(inMemoryStoryState),
      textModel: options.providers.text,
      ...(styleExcerpts.length ? { styleExcerpts } : {})
    });
    await options.assertLease();
    const candidate = await reviewReplanCandidate({
      ...options,
      editInstruction: options.editInstruction,
      setup,
      sourcePage: sourceByIndex.get(pageIndex),
      pageIndex,
      draft,
      previousPages,
      continuityNotes: pageContinuityNotes,
      researchNotes,
      styleExcerpts,
      assertLease: options.assertLease
    });
    candidates.set(pageIndex, candidate);
    inMemoryContinuityNotes.push(...candidate.draft.continuityNotes);
    const storyContext = await prepareDeferredPageStoryContext({
      projectId: options.projectId,
      input: options.input,
      plan: options.plan,
      providers: options.providers,
      quality,
      currentStoryState: inMemoryStoryState,
      candidate
    });
    // Kept for the publication's own memory pass, which asks the same question
    // of the same draft over the same state — see `ReplanPageStoryContext`.
    storyContexts.set(pageIndex, { ...storyContext, draft: candidate.draft, fromState: inMemoryStoryState });
    inMemoryStoryState = storyContext.nextStoryState;
  }
  await options.assertLease();
  await reportReplanDraftPage(
    options.generationJobId,
    "draft",
    options.input.targetPages,
    options.input.targetPages
  );

  const audit = await repairReplanCandidates({ ...options, sourcePages, candidates });
  // Adherence only: a rebuilt book publishes its stubborn pages FAILED_QA the
  // way generation does, and folding page QA in here refunded a hundred-page
  // replan over one page the reviewer would not pass.
  if (!audit.verdict.satisfied && audit.verdict.basis !== "unverified") {
    await prisma.$transaction(async (tx) => {
      await assertActiveReplanEditLeaseTx(tx, options.operationId, options.ownerToken);
      await tx.bookEditOperation.update({
        where: { id: options.operationId },
        data: { adherenceAudit: audit as unknown as Prisma.InputJsonValue }
      });
    });
    throw new ReaderEditFailure(EDIT_ADHERENCE_FAILED);
  }

  const preparedMemory = await prepareReplanPageMemory({
    projectId: options.projectId,
    input: options.input,
    plan: options.plan,
    providers: options.providers,
    strategy: options.strategy,
    quality,
    initialStoryState: baseStoryState,
    candidates: [...candidates.values()],
    storyContexts,
    assertOwnership: options.assertLease
  });
  await options.assertLease();
  return publishReplannedBook({ ...options, candidates, setups, preparedMemory, audit });
}

/**
 * The deferred page memory for the manuscript about to be published, reusing
 * the drafting loop's own extracts.
 *
 * Identical in shape to `prepareDeferredPageMemory` — extracts in page order,
 * each one seeing the state the earlier keepers accepted, one embedding per
 * page, and an ownership fence on both sides of the spend — with the drafting
 * loop's cache in front of the model call. A page whose draft or incoming state
 * has changed since it was drafted falls through to the same call the shared
 * helper would have made.
 */
async function prepareReplanPageMemory(options: {
  projectId: string;
  input: CreateProjectInput;
  plan: BookPlan;
  providers: ProviderSet;
  strategy: BookGenerationStrategy;
  quality: QualityGateContext;
  initialStoryState: StoryState;
  candidates: readonly ReplanCandidate[];
  storyContexts: ReadonlyMap<number, ReplanPageStoryContext>;
  assertOwnership: () => Promise<void>;
}): Promise<PreparedDeferredPageMemory[]> {
  let currentState = options.initialStoryState;
  const prepared: PreparedDeferredPageMemory[] = [];
  for (const candidate of [...options.candidates].sort((left, right) => left.pageIndex - right.pageIndex)) {
    await options.assertOwnership();
    const cached = options.storyContexts.get(candidate.pageIndex);
    const storyContext =
      cached && cached.draft === candidate.draft && cached.fromState === currentState
        ? cached
        : await prepareDeferredPageStoryContext({
            projectId: options.projectId,
            input: options.input,
            plan: options.plan,
            providers: options.providers,
            quality: options.quality,
            currentStoryState: currentState,
            candidate
          });
    currentState = storyContext.nextStoryState;
    const preparedEmbedding = strategyUsesSemanticMemory(options.strategy)
      ? await prepareEmbedding(candidate.draft.summary, options.providers.embedding)
      : null;
    await options.assertOwnership();
    prepared.push({
      pageIndex: candidate.pageIndex,
      draft: candidate.draft,
      preparedEmbedding,
      storyExtract: storyContext.storyExtract
    });
  }
  return prepared;
}

function resolveCandidateSourceProjectId(options: {
  targetProjectId: string;
  queuedSourceProjectId?: string | undefined;
  operationProjectId?: string | null | undefined;
  durableSourceProjectId?: string | null | undefined;
}): string {
  const durable = options.durableSourceProjectId?.trim();
  if (durable) return durable;

  const operationOwner = options.operationProjectId?.trim();
  if (operationOwner && operationOwner !== options.targetProjectId) return operationOwner;

  const queued = options.queuedSourceProjectId?.trim();
  if (queued && queued !== options.targetProjectId) return queued;

  return operationOwner || queued || options.targetProjectId;
}

async function reviewReplanCandidate(options: {
  projectId: string;
  planId: string;
  input: CreateProjectInput;
  plan: BookPlan;
  providers: ProviderSet;
  strategy: BookGenerationStrategy;
  generationJobId?: string | undefined;
  editInstruction: string;
  characterContext?: string | undefined;
  setup: ChapterSetup;
  sourcePage: SourcePage | undefined;
  pageIndex: number;
  draft: PageDraft;
  previousPages: PriorPageContext[];
  continuityNotes: string[];
  researchNotes: string[];
  styleExcerpts: string[];
  assertLease: () => Promise<void>;
}): Promise<ReplanCandidate> {
  await options.assertLease();
  const reviewed = await reviewAndSaveGeneratedPage({
    projectId: options.projectId,
    planId: options.planId,
    input: options.input,
    plan: options.plan,
    providers: options.providers,
    strategy: options.strategy,
    draft: { ...options.draft, index: options.pageIndex },
    chapterId: null,
    chapter: options.setup.chapter,
    chapterBrief: options.setup.brief,
    chapterPageStart: options.setup.startPage,
    chapterPageEnd: options.setup.endPage,
    previousPages: options.previousPages,
    generationJobId: options.generationJobId,
    deferPublication: true,
    editInstruction: options.editInstruction,
    ...(options.characterContext ? { characterContext: options.characterContext } : {}),
    maxCandidates: 1,
    assertOwnership: options.assertLease,
    ...(options.sourcePage
      ? {
          settledPageToReplace: {
            ...toPriorPageContext(options.sourcePage),
            imagePrompt: options.sourcePage.imagePrompt
          }
        }
      : {})
  });
  if (!reviewed.candidate) {
    throw new Error(`Deferred replan review for page ${options.pageIndex} returned no candidate`);
  }
  // The same take the book passes make: one `ChapterSetup.brief` briefs every
  // page of a chapter here too, so a page that bought a brief repair and kept a
  // draft written to it has to tell the chapter's remaining pages what it now
  // covers, or they are briefed to write around an assignment nothing
  // delivered. `chapterId` is null through this path — the replacement chapter
  // rows do not exist until publication — so `pendingBriefRepair` is always
  // absent and this carried copy is the repair's only way out of the page's own
  // loop. The publication writes these same setups' briefs into
  // `Chapter.productionBrief`, which is what later drafting jobs read back.
  if (reviewed.repairedChapterBrief) {
    options.setup.brief = reviewed.repairedChapterBrief;
  }
  return {
    pageIndex: options.pageIndex,
    setup: options.setup,
    sourcePage: options.sourcePage,
    draft: reviewed.candidate.draft,
    qualityReport: reviewed.candidate.qualityReport,
    previousPages: options.previousPages,
    continuityNotes: options.continuityNotes,
    researchNotes: options.researchNotes,
    styleExcerpts: options.styleExcerpts
  };
}

async function repairReplanCandidates(options: {
  projectId: string;
  planId: string;
  operationId: string;
  input: CreateProjectInput;
  plan: BookPlan;
  providers: ProviderSet;
  strategy: BookGenerationStrategy;
  generationJobId?: string | undefined;
  editInstruction: string;
  characterContext?: string | undefined;
  sourcePages: SourcePage[];
  candidates: Map<number, ReplanCandidate>;
  assertLease: () => Promise<void>;
}): Promise<ReplanAudit> {
  let verdict = await ownedReplanVerdict(options);
  let attempts = 1;
  let proseApproved = allReplanProseApproved(options.candidates);
  while ((!verdict.satisfied || !proseApproved) && attempts < 3) {
    attempts += 1;
    const repairRound = attempts - 1;
    // A verdict the reviewer never reached says nothing about which pages are
    // wrong or what would fix them, so it flags nobody and repairs to nothing.
    // The re-ask at the bottom of this round is the whole of the response.
    const unverified = replanVerdictIsUnverified(verdict);
    if (unverified) {
      console.warn("Replan adherence review could not be verified; re-asking without redrafting", {
        event: "generation.consistency_warning",
        warning: "replan_adherence_unverified",
        projectId: options.projectId,
        operationId: options.operationId,
        attempt: attempts
      });
    }
    const flagged = new Set(unverified ? [] : verdict.pageIndexesToRevise);
    for (const candidate of options.candidates.values()) {
      if (!candidate.qualityReport.approved) flagged.add(candidate.pageIndex);
    }
    if (flagged.size === 0 && !unverified) {
      for (const pageIndex of options.candidates.keys()) flagged.add(pageIndex);
    }
    const adherenceRepair = unverified ? [] : [...verdict.missingRequirements, ...verdict.contradictions];
    const repairCandidates = [...options.candidates.values()]
      .filter((candidate) => flagged.has(candidate.pageIndex))
      .sort((left, right) => left.pageIndex - right.pageIndex);
    let revisedSoFar = 0;
    for (const candidate of repairCandidates) {
      await options.assertLease();
      await reportReplanDraftPage(
        options.generationJobId,
        "revise",
        revisedSoFar,
        repairCandidates.length,
        candidate.pageIndex,
        repairRound
      );
      const previousPages = candidateContexts(options.candidates, candidate.pageIndex);
      const continuityNotes = replanCandidateContinuityNotes(candidate, options.candidates);
      await options.assertLease();
      const draft = await revisePageDraftWithRestart({
        strategy: options.strategy,
        generationJobId: options.generationJobId,
        context: `Replanned page ${candidate.pageIndex}`,
        reviseOptions: {
          input: options.input,
          plan: options.plan,
          chapter: candidate.setup.chapter,
          chapterBrief: candidate.setup.brief,
          pageIndex: candidate.pageIndex,
          draft: candidate.draft,
          report: repairReport(candidate.qualityReport, adherenceRepair),
          editInstruction: options.editInstruction,
          ...(options.characterContext ? { characterContext: options.characterContext } : {}),
          adherenceRepair,
          previousPages,
          continuityNotes,
          researchNotes: candidate.researchNotes,
          textModel: options.providers.text,
          ...(candidate.styleExcerpts.length ? { styleExcerpts: candidate.styleExcerpts } : {})
        }
      });
      await options.assertLease();
      const repaired = await reviewReplanCandidate({
        ...options,
        setup: candidate.setup,
        sourcePage: candidate.sourcePage,
        pageIndex: candidate.pageIndex,
        draft,
        previousPages,
        continuityNotes,
        researchNotes: candidate.researchNotes,
        styleExcerpts: candidate.styleExcerpts,
        assertLease: options.assertLease
      });
      options.candidates.set(candidate.pageIndex, repaired);
      revisedSoFar += 1;
    }
    if (repairCandidates.length > 0) {
      await options.assertLease();
      await reportReplanDraftPage(
        options.generationJobId,
        "revise",
        revisedSoFar,
        repairCandidates.length,
        undefined,
        repairRound
      );
    }
    verdict = await ownedReplanVerdict(options);
    proseApproved = allReplanProseApproved(options.candidates);
  }
  return {
    verdict,
    attempts,
    missingRequirements: verdict.missingRequirements,
    checkedAt: new Date().toISOString(),
    proseApproved
  };
}

/**
 * A verdict `reviewAppliedBookEdit` fell closed on rather than reached.
 *
 * Its catch turns every non-cancellation failure — a 500, a rate limit, a
 * truncated reply, any of the guards inside the hierarchical reviewer — into a
 * verdict that is unsatisfied, names one generic requirement, and flags *every*
 * changed page. Read as a repair instruction, one provider blip on a hundred-page
 * replan therefore bought two full redraft-and-review rounds of all hundred
 * pages, plus a second story extract for each of them (page 1 being repaired
 * misses `prepareReplanPageMemory`'s identity cache, and every page behind it
 * then sees a different incoming state), and raised `EDIT_ADHERENCE_FAILED`
 * anyway. None of that work could help, because the "missing requirement" is not
 * a requirement.
 *
 * `basis` is that module's own answer to the question, so this asks it rather
 * than inferring it: `failClosedVerdict` is the only producer of `"unverified"`,
 * `normalizeVerdict` the only producer of `"reviewed"`, and the response schema
 * stays `.strict()` without the field, so neither a reviewer nor a provider can
 * claim a basis of its own. A computed exact replacement reports `"reviewed"`
 * deliberately — it is the most certain verification the module performs, not
 * the absence of one.
 *
 * This replaced a five-field shape match that stood in until the signal existed.
 * One of its terms was `pageIndexesToRevise.length === candidates.size`, true
 * only because the sentinel skips `normalizeVerdict` and flags every changed
 * page: a coincidence of the caller's own page count, which is exactly what a
 * durable signal should not have to depend on.
 */
function replanVerdictIsUnverified(verdict: EditAdherenceVerdict): boolean {
  return verdict.basis === "unverified";
}

async function ownedReplanVerdict(options: {
  editInstruction: string;
  characterContext?: string | undefined;
  sourcePages: SourcePage[];
  candidates: Map<number, ReplanCandidate>;
  providers: ProviderSet;
  assertLease: () => Promise<void>;
}): Promise<EditAdherenceVerdict> {
  await options.assertLease();
  const verdict = await replanVerdict(options);
  await options.assertLease();
  return verdict;
}

function replanVerdict(options: {
  editInstruction: string;
  sourcePages: SourcePage[];
  candidates: Map<number, ReplanCandidate>;
  providers: ProviderSet;
}): Promise<EditAdherenceVerdict> {
  return reviewAppliedBookEdit({
    instruction: options.editInstruction,
    beforePages: options.sourcePages.map(({ index, title, markdown, summary }) => ({ index, title, markdown, summary })),
    afterPages: [...options.candidates.values()]
      .sort((left, right) => left.pageIndex - right.pageIndex)
      .map(({ pageIndex: index, draft }) => ({ index, title: draft.title, markdown: draft.markdown, summary: draft.summary })),
    textModel: options.providers.text
  });
}

function candidateContexts(candidates: Map<number, ReplanCandidate>, beforeIndex: number): PriorPageContext[] {
  return [...candidates.values()]
    .filter((candidate) => candidate.pageIndex < beforeIndex)
    .sort((left, right) => left.pageIndex - right.pageIndex)
    .slice(-18)
    .map(({ pageIndex: index, draft }) => ({ index, title: draft.title, markdown: draft.markdown, summary: draft.summary }));
}

function replanCandidateContinuityNotes(
  candidate: ReplanCandidate,
  candidates: Map<number, ReplanCandidate>
): string[] {
  return [...new Set([
    ...candidate.continuityNotes,
    ...[...candidates.values()]
      .filter((previous) => previous.pageIndex < candidate.pageIndex)
      .flatMap((previous) => previous.draft.continuityNotes)
  ])];
}

function repairReport(report: PageQualityReport, requirements: string[]): PageQualityReport {
  return {
    ...report,
    approved: false,
    requiredRevisions: [
      ...requirements.map((requirement) => `Apply this missing approved requirement: ${requirement}`),
      ...report.requiredRevisions
    ]
  };
}

function allReplanProseApproved(candidates: Map<number, ReplanCandidate>): boolean {
  return [...candidates.values()].every((candidate) => candidate.qualityReport.approved);
}
