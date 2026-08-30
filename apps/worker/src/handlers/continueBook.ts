import {
  continuationChapterPlans,
  continuationContinuityNotes,
  continuationOutlineAiSchema,
  continuationPageIndexes,
  continuationPreviousPages,
  continuationProseApproved,
  continuationRepairReport,
  distributeContinuationPages,
  fallbackContinuationOutline,
  type ContinuationContextCandidate,
  type ContinuationOutline,
  CONTINUATION_EXCERPT_GUARD
} from "./continueBookSupport.js";
import {
  getProjectOrThrow,
  nextPlanVersion,
  planInputSnapshot,
  strategyForInput,
  styleExcerptsForPage,
  toPriorPageContext
} from "../generation/bookHelpers.js";
import { loadContinuityNotes, loadResearchNotesForGeneration } from "../generation/generationContext.js";
import {
  persistPreparedDeferredPageMemory,
  prepareDeferredPageMemory,
  prepareDeferredPageStoryContext,
  type PreparedDeferredPageMemory
} from "../generation/deferredPageMemory.js";
import { loadEntityStateLines } from "../generation/entityState.js";
import { reviewAndSaveGeneratedPage, revisePageDraftWithRestart } from "../generation/pageReview.js";
import { importStyleProfileFromMediaSettings } from "./importBookSupport.js";
import { continuationDeliveryProtocol } from "./continueBookProtocol.js";
import { inputForPlanVersion } from "../generation/projectInput.js";
import { resolveEditPromptContext } from "../generation/editOperationContext.js";
import { loadQualityContext } from "../generation/qualitySettings.js";
import { mergeEntityAndStoryStateLines } from "../generation/qualityEnrichment.js";
import { loadProjectStoryState } from "../generation/storyStateStore.js";
import {
  assertTextEditLeaseTx,
  isTextEditLeaseLostError,
  startTextEditLeaseHeartbeat,
  TextEditLeaseLostError,
  waitForTextEditLease,
  waitForTextEditLeaseCompletion
} from "../generation/textEditLease.js";
import {
  continuationFollowUpClassifier,
  continuationFollowUpCompletion,
  continuationFollowUpIdentityFromClassifier,
  type ContinuationFollowUpIdentity
} from "../generation/continuationFollowUp.js";
import { stampExportInvalidationBarrierTx } from "../generation/textEditFollowUp.js";
import { createLoggedProviders } from "../providers/loggedAdapters.js";
import { config } from "../runtime/config.js";
import { advanceJobStep } from "../runtime/jobLifecycle.js";
import {
  isStopRequestedError,
  UnownedTextEditDeliveryError,
  type JobCompletion
} from "../runtime/jobTypes.js";
import {
  bookPlanSchema,
  createProviders,
  generateJsonWithRetry,
  formatStoryStateLines,
  preEditProjectStatus,
  reviewAppliedBookEdit,
  type BookPlan,
  type EditAdherenceVerdict,
  type TextModelAdapter
} from "@book-maker/core";
import { EDIT_ADHERENCE_FAILED, ReaderEditFailure } from "@book-maker/core/editFailure";
import { MANUSCRIPT_PUBLICATION_TRANSACTION_OPTIONS, pageScope, Prisma, prisma } from "@book-maker/db";
import type { ContinueBookJob } from "../runtime/jobPayloads.js";
import { randomUUID } from "node:crypto";
import {
  claimDurableEditCompletionTx,
  settleDurableEditAttemptTx,
  type DurableEditCompletionClaim
} from "../runtime/durableEditCompletion.js";

/**
 * `continue-book` job: outline and write additional chapters onto a finished book.
 */

export async function continueBook(job: ContinueBookJob): Promise<JobCompletion> {
  const { projectId, operationId, planId, generationJobId, attemptId } = job.data;
  const settledStatus = preEditProjectStatus(job.data);
  const chapterCount = Math.min(8, Math.max(1, Math.floor(Number(job.data.chapterCount) || 1)));
  const requestedPageCount = Math.max(chapterCount, Math.floor(Number(job.data.newPageCount) || chapterCount * 5));

  const operation = await prisma.bookEditOperation.findUnique({ where: { id: operationId } });
  if (!operation) {
    throw new Error("Book edit operation not found");
  }
  const publicationProtocol = continuationDeliveryProtocol(operation, job.data);
  const { editInstruction, requestContext, characterContext } = resolveEditPromptContext(operation, job.data);
  const ownerToken = randomUUID();
  const claim = await waitForTextEditLease(operationId, ownerToken);
  if (claim.outcome === "completed" || claim.outcome === "settled") {
    return {};
  }
  if (claim.outcome === "abandoned") {
    throw new UnownedTextEditDeliveryError();
  }
  const heartbeat = startTextEditLeaseHeartbeat(operationId, ownerToken);

  try {
    if (claim.phase === "tail") {
      return await replayAppliedContinuation({
        projectId,
        operationId,
        ownerToken,
        settledStatus
      });
    }

    // Match Stop's root lock before touching the operation row. Whichever
    // transaction commits first owns the outcome: a stopped operation cannot
    // be resurrected ACTIVE, and this delivery cannot restore EDITING over a
    // cancellation that already refunded it.
    await prisma.$transaction(async (tx) => {
      await tx.project.update({
        where: { id: projectId },
        data: { status: "EDITING", contentRevision: { increment: 0 } }
      });
      await assertActiveContinuationLeaseTx(tx, operationId, ownerToken);
    });
    await advanceJobStep(generationJobId, "outline", 15, "Outlining new chapters");

    let project = await getProjectOrThrow(projectId);
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
    const quality = await loadQualityContext(input);

    // Compatibility cleanup is legacy-only. A marked delivery promises that
    // nothing manuscript-shaped exists before publication, so entering a
    // partial-write cleanup mode would make its Stop safety depend on mutable
    // book state instead of the durable protocol that authorized restoration.
    const baseChapterBoundary = plan.chapters.at(-1)?.index ?? 0;
    const strandedChapters = await prisma.chapter.findMany({
      where: { projectId, index: { gt: baseChapterBoundary } },
      select: { id: true }
    });
    if (publicationProtocol === "atomic" &&
      (project.currentPlanId !== basePlanVersion.id || strandedChapters.length > 0)) {
      throw new Error("Atomic continuation protocol found durable pre-publication manuscript state");
    }
    if (publicationProtocol === "legacy" && strandedChapters.length > 0) {
      const strandedChapterIds = strandedChapters.map((chapter) => chapter.id);
      const strandedPages = await prisma.page.findMany({
        where: { projectId, chapterId: { in: strandedChapterIds } },
        select: { index: true }
      });
      const strandedPlanId =
        project.currentPlanId && project.currentPlanId !== basePlanVersion.id ? project.currentPlanId : null;
      if (strandedPlanId) {
        const strandedPlan = await prisma.planVersion.findUnique({
          where: { id: strandedPlanId },
          select: { messages: true }
        });
        // The crashed delivery spelled this message from the payload's own
        // `request`, which before the instruction/canon split was the reader's
        // words *plus* the mentioned characters' sheets — exactly the block
        // `resolveEditPromptContext` now strips back off. Only the composed
        // spelling can match a legacy append that named a library character,
        // so the marker set carries it alongside the separated ones.
        const markers = new Set(
          [editInstruction, requestContext, job.data.request].map(
            (value) => `Continue the book: ${value}`.slice(0, 2000)
          )
        );
        const strandedMessages = strandedPlan && Array.isArray(strandedPlan.messages) ? strandedPlan.messages : [];
        const looksLikeOwnAppend = strandedMessages.some(
          (message) =>
            typeof message === "object" &&
            message !== null &&
            markers.has(String((message as { content?: unknown }).content ?? ""))
        );
        if (!looksLikeOwnAppend) {
          throw new Error("Found chapters past the current plan that this continuation does not own");
        }
      }
      await prisma.$transaction(async (tx) => {
        await tx.project.update({
          where: { id: projectId },
          data: { contentRevision: { increment: 0 } }
        });
        await assertActiveContinuationLeaseTx(tx, operationId, ownerToken);
        await tx.page.deleteMany({ where: { projectId, chapterId: { in: strandedChapterIds } } });
        await tx.chapter.deleteMany({ where: { projectId, index: { gt: baseChapterBoundary } } });
        await tx.embedding.deleteMany({
          where: { projectId, scope: { in: strandedPages.map((page) => pageScope(page.index)) } }
        });
        await tx.project.update({
          where: { id: projectId },
          data: { currentPlanId: basePlanVersion.id, targetPages: input.targetPages }
        });
        await tx.planVersion.update({ where: { id: basePlanVersion.id }, data: { status: "APPROVED" } });
        if (strandedPlanId) {
          await tx.planVersion.deleteMany({ where: { id: strandedPlanId, projectId } });
        }
      });
      project = await getProjectOrThrow(projectId);
    }

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
    const outline = await continuationOutlineWithModel({
      plan,
      editInstruction,
      requestContext,
      ...(characterContext ? { characterContext } : {}),
      chapterCount,
      styleProfile: importStyleProfileFromMediaSettings(project.mediaSettings),
      trailingPages,
      language: project.language,
      textModel: providers.text
    });
    await heartbeat.assertHeld();
    const pageDistribution = distributeContinuationPages(requestedPageCount, outline.chapters.length);
    const newChapterPlans = continuationChapterPlans(plan, outline, pageDistribution, startChapterIndex);
    const newPageIndexes = continuationPageIndexes(lastPageIndex, pageDistribution);
    const extendedPlan = bookPlanSchema.parse({ ...plan, chapters: [...plan.chapters, ...newChapterPlans] });
    const totalPages = lastPageIndex + newPageIndexes.length;

    await advanceJobStep(generationJobId, "draft", 30, "Writing new pages", {
      done: 0,
      total: newPageIndexes.length
    });
    // Whole book: a continuation is written past the last page, so nothing the
    // project holds is ahead of it.
    const continuityNotes = await loadContinuityNotes(projectId, { beforePageIndex: null });
    const earlierSummaries = await prisma.page.findMany({
      where: { projectId, index: { lte: lastPageIndex }, status: "COMPLETED" },
      orderBy: { index: "asc" },
      select: { summary: true }
    });
    const previousSummaries = earlierSummaries.map((page) => page.summary).filter(Boolean).slice(-40);
    const previousPages = trailingPages.map(toPriorPageContext);
    const inMemoryContinuityNotes = [...continuityNotes];
    const baseStoryState = await loadProjectStoryState(projectId, extendedPlan.promises ?? []);
    let inMemoryStoryState = baseStoryState;
    const durableEntityStateLines = await loadEntityStateLines(projectId, extendedPlan);

    let drafted = 0;
    const candidates = new Map<number, ContinuationCandidate>();
    for (const chapterPlan of newChapterPlans) {
      const researchNotes = await loadResearchNotesForGeneration(projectId, strategy, chapterPlan);
      for (let offset = 0; offset < chapterPlan.targetPages; offset += 1) {
        await heartbeat.assertHeld();
        const pageIndex = newPageIndexes[drafted]!;
        await advanceJobStep(
          generationJobId,
          "draft",
          30 + Math.round((drafted / Math.max(newPageIndexes.length, 1)) * 45),
          `Writing page ${pageIndex}`,
          { done: drafted, total: newPageIndexes.length, pageIndex }
        );
        const priorPageContext = previousPages.slice(-6);
        const pageContinuityNotes = [...inMemoryContinuityNotes];
        const styleExcerpts = await styleExcerptsForPage({
          projectId,
          pageIndex,
          recencyPages: priorPageContext,
          input,
          quality
        });
        const draft = await strategy.generatePageDraft({
          input,
          plan: extendedPlan,
          chapter: chapterPlan,
          pageIndex,
          editInstruction,
          ...(characterContext ? { characterContext } : {}),
          previousSummaries: [...previousSummaries, ...previousPages.map((page) => page.summary)].slice(-40),
          previousPages: priorPageContext,
          continuityNotes: pageContinuityNotes,
          researchNotes,
          entityState: mergeEntityAndStoryStateLines(
            durableEntityStateLines,
            formatStoryStateLines(inMemoryStoryState)
          ),
          textModel: providers.text,
          ...(styleExcerpts.length > 0 ? { styleExcerpts } : {})
        });
        // The same review → revise loop, honest FAILED_QA status, continuity
        // notes and entity state every generated page gets — a continuation
        // used to skip all of it and save drafts sight unseen. Illustration
        // stays off: the continuation charge never priced images.
        const saved = await reviewAndSaveGeneratedPage({
          projectId,
          planId: basePlanVersion.id,
          input,
          plan: extendedPlan,
          providers,
          strategy,
          draft: { ...draft, index: pageIndex },
          chapterId: null,
          chapter: chapterPlan,
          previousPages: previousPages.slice(-18),
          generationJobId,
          illustrate: false,
          deferPublication: true,
          editInstruction,
          ...(characterContext ? { characterContext } : {}),
          maxCandidates: 1,
          assertOwnership: heartbeat.assertHeld
        });
        if (!saved.candidate) {
          throw new Error(`Deferred continuation review for page ${pageIndex} returned no candidate`);
        }
        candidates.set(pageIndex, {
          pageIndex,
          chapterId: null,
          chapter: chapterPlan,
          draft: saved.candidate.draft,
          qualityReport: saved.candidate.qualityReport,
          previousPages: previousPages.slice(-18),
          continuityNotes: pageContinuityNotes,
          researchNotes
        });
        inMemoryContinuityNotes.push(...saved.candidate.draft.continuityNotes);
        inMemoryStoryState = (
          await prepareDeferredPageStoryContext({
            projectId,
            input,
            plan: extendedPlan,
            providers,
            quality,
            currentStoryState: inMemoryStoryState,
            candidate: { pageIndex, draft: saved.candidate.draft }
          })
        ).nextStoryState;
        previousPages.push(saved.page);
        drafted += 1;
      }
    }

    const audit = await reviewContinuationCandidates({
      projectId,
      planId: basePlanVersion.id,
      editInstruction,
      ...(characterContext ? { characterContext } : {}),
      input,
      plan: extendedPlan,
      providers,
      strategy,
      candidates,
      generationJobId,
      assertLease: heartbeat.assertHeld
    });
    // Adherence only. A continuation page that still fails review after the
    // whole-set repair budget is published FAILED_QA, the way every generated
    // page is; refunding the whole continuation over it kept none of the
    // chapters the reader paid for and told them the change could not be
    // applied as requested when it had.
    if (!audit.verdict.satisfied && audit.verdict.basis !== "unverified") {
      await prisma.$transaction(async (tx) => {
        await assertActiveContinuationLeaseTx(tx, operationId, ownerToken);
        await tx.bookEditOperation.update({
          where: { id: operationId },
          data: { editInstruction, adherenceAudit: audit as unknown as Prisma.InputJsonValue }
        });
      });
      throw new ReaderEditFailure(EDIT_ADHERENCE_FAILED);
    }
    const preparedMemory = await prepareDeferredPageMemory({
      projectId,
      input,
      plan: extendedPlan,
      providers,
      strategy,
      quality,
      initialStoryState: baseStoryState,
      candidates: [...candidates.values()],
      assertOwnership: heartbeat.assertHeld
    });

    await advanceJobStep(generationJobId, "save", 82, "Saving chapters");
    await advanceJobStep(generationJobId, "export", 90, "Refreshing exports");
    await heartbeat.assertHeld();
    const followUpIdentity = await publishContinuation({
      projectId,
      operationId,
      generationJobId,
      attemptId,
      ownerToken,
      settledStatus,
      editInstruction,
      basePlanVersionId: basePlanVersion.id,
      input,
      extendedPlan,
      strategyId: strategy.id,
      totalPages,
      newChapterPlans,
      newPageIndexes,
      candidates,
      preparedMemory,
      audit
    });
    return continuationFollowUpCompletion(followUpIdentity, ownerToken);
  } catch (error) {
    if (!isTextEditLeaseLostError(error)) throw error;
    if ((await waitForTextEditLeaseCompletion(operationId)) === "abandoned") {
      throw new UnownedTextEditDeliveryError();
    }
    return {};
  } finally {
    await heartbeat.stop();
  }
}

async function assertActiveContinuationLeaseTx(
  tx: Prisma.TransactionClient,
  operationId: string,
  ownerToken: string
): Promise<void> {
  const owned = await assertTextEditLeaseTx(tx, operationId, ownerToken);
  if (owned.status !== "ACTIVE") {
    throw new TextEditLeaseLostError();
  }
}

async function replayAppliedContinuation(options: {
  projectId: string;
  operationId: string;
  ownerToken: string;
  settledStatus: ReturnType<typeof preEditProjectStatus>;
}): Promise<JobCompletion> {
  let legacy = false;
  const identity = await prisma.$transaction(async (tx) => {
    const project = await tx.project.update({
      where: { id: options.projectId },
      data: { contentRevision: { increment: 0 } },
      select: { currentPlanId: true, contentRevision: true }
    });
    const owned = await assertTextEditLeaseTx(tx, options.operationId, options.ownerToken);
    if (owned.status !== "APPLIED") {
      throw new TextEditLeaseLostError();
    }
    const durable = continuationFollowUpIdentityFromClassifier(owned.classifier, {
      projectId: options.projectId,
      operationId: options.operationId
    });
    if (durable) return durable;
    // Only `publishContinuation` settles the durable job and the paid attempt
    // in the manuscript transaction, so only its checkpoint proves it happened.
    // The pre-checkpoint worker left `markCompleted` to `processJob`.
    legacy = true;
    if (!project.currentPlanId) throw new Error("Current plan not found");
    const operation = await tx.bookEditOperation.findUnique({
      where: { id: options.operationId },
      select: { publicationRevision: true, classifier: true }
    });
    const publicationRevision = operation?.publicationRevision ?? project.contentRevision;
    const legacyIdentity: ContinuationFollowUpIdentity = {
      projectId: options.projectId,
      operationId: options.operationId,
      planVersionId: project.currentPlanId,
      publicationRevision,
      fallbackStatus: options.settledStatus
    };
    await tx.bookEditOperation.update({
      where: { id: options.operationId },
      data: { classifier: continuationFollowUpClassifier(operation?.classifier, legacyIdentity) }
    });
    return legacyIdentity;
  });
  return continuationFollowUpCompletion(identity, options.ownerToken, {
    durableCompletionCommitted: !legacy
  });
}

async function publishContinuation(options: {
  projectId: string;
  operationId: string;
  generationJobId: string;
  attemptId?: string | undefined;
  ownerToken: string;
  settledStatus: ReturnType<typeof preEditProjectStatus>;
  editInstruction: string;
  basePlanVersionId: string;
  input: ReturnType<typeof inputForPlanVersion>;
  extendedPlan: BookPlan;
  strategyId: string;
  totalPages: number;
  newChapterPlans: BookPlan["chapters"];
  newPageIndexes: number[];
  candidates: Map<number, ContinuationCandidate>;
  preparedMemory: PreparedDeferredPageMemory[];
  audit: ContinuationAdherenceAudit;
}): Promise<ContinuationFollowUpIdentity> {
  return prisma.$transaction(async (tx) => {
    // Stop uses this exact Project -> GenerationJob -> BookEditOperation lock
    // order. The job CAS is part of publication, not an advisory preflight: a
    // committed CANCELED/FAILED row means its attempt was refunded and this
    // transaction must publish nothing even if its provider calls succeeded.
    await tx.project.update({
      where: { id: options.projectId },
      data: { contentRevision: { increment: 0 } }
    });
    const durableCompletion: DurableEditCompletionClaim = {
      generationJobId: options.generationJobId,
      projectId: options.projectId,
      operationId: options.operationId,
      attemptId: options.attemptId,
      type: "CONTINUE_BOOK",
      message: "Continuation published"
    };
    if (!(await claimDurableEditCompletionTx(tx, durableCompletion))) {
      throw new TextEditLeaseLostError();
    }
    const owned = await assertTextEditLeaseTx(tx, options.operationId, options.ownerToken);
    if (owned.status !== "ACTIVE" || (owned.generationJobId && owned.generationJobId !== options.generationJobId)) {
      throw new TextEditLeaseLostError();
    }

    const version = await nextPlanVersion(options.projectId, tx);
    await tx.planVersion.update({ where: { id: options.basePlanVersionId }, data: { status: "SUPERSEDED" } });
    const created = await tx.planVersion.create({
      data: {
        projectId: options.projectId,
        version,
        status: "APPROVED",
        approvedAt: new Date(),
        planningPackage: options.extendedPlan,
        inputSnapshot: planInputSnapshot({ ...options.input, targetPages: options.totalPages }),
        messages: [
          {
            role: "user",
            content: `Continue the book: ${options.editInstruction}`.slice(0, 2000),
            at: new Date().toISOString()
          }
        ]
      }
    });
    for (const chapterPlan of options.newChapterPlans) {
      const chapter = await tx.chapter.create({
        data: {
          projectId: options.projectId,
          index: chapterPlan.index,
          title: chapterPlan.title,
          summary: chapterPlan.summary,
          targetPages: chapterPlan.targetPages,
          status: "COMPLETED"
        }
      });
      const chapterCandidates = [...options.candidates.values()]
        .filter((candidate) => candidate.chapter.index === chapterPlan.index)
        .sort((left, right) => left.pageIndex - right.pageIndex);
      await tx.page.createMany({
        data: chapterCandidates.map((candidate) => ({
          projectId: options.projectId,
          chapterId: chapter.id,
          index: candidate.pageIndex,
          title: candidate.draft.title,
          markdown: candidate.draft.markdown,
          summary: candidate.draft.summary,
          imagePrompt: candidate.draft.imagePrompt ?? null,
          qualityReport: candidate.qualityReport as Prisma.InputJsonValue,
          // The review loop's verdict, saved honestly. A FAILED_QA page still
          // counts as terminal for the export (`terminalSavedPageCount`), and
          // the continuation's own recompile runs full QA, so the repair pass
          // has a target instead of the page passing silently.
          status: candidate.qualityReport.approved ? ("COMPLETED" as const) : ("FAILED_QA" as const),
          revision: 1
        }))
      });
    }
    const createdPages = await tx.page.findMany({
      where: { projectId: options.projectId, index: { in: options.newPageIndexes } },
      select: { id: true, index: true }
    });
    const pageIds = new Map(createdPages.map((page) => [page.index, page.id]));
    if (pageIds.size !== options.newPageIndexes.length) {
      throw new Error("Continuation publication could not resolve every appended page");
    }
    const published = await tx.project.update({
      where: { id: options.projectId },
      data: {
        currentPlanId: created.id,
        targetPages: options.totalPages,
        // The continuation is delivered, but the old export is not. The
        // checkpointed tail (or the compile it queues) owns the transition
        // back to a settled reader-visible status.
        status: "EDITING",
        contentRevision: { increment: 1 }
      },
      select: { contentRevision: true }
    });
    // Same transaction as the bump: no reader sees the new revision unbarriered.
    await stampExportInvalidationBarrierTx(tx, options.projectId, published.contentRevision);
    await persistPreparedDeferredPageMemory({
      tx,
      projectId: options.projectId,
      plan: options.extendedPlan,
      strategyId: options.strategyId,
      pageIds,
      prepared: options.preparedMemory,
      tags: ["edit", "continuation"]
    });
    await tx.bookEditOperation.update({
      where: { id: options.operationId },
      data: {
        status: "APPLIED",
        publicationRevision: published.contentRevision,
        editInstruction: options.editInstruction,
        adherenceAudit: options.audit as unknown as Prisma.InputJsonValue,
        affectedPageIndexes: options.newPageIndexes,
        classifier: continuationFollowUpClassifier(owned.classifier, {
          projectId: options.projectId,
          operationId: options.operationId,
          planVersionId: created.id,
          publicationRevision: published.contentRevision,
          fallbackStatus: options.settledStatus
        }),
        appliedAt: new Date()
      }
    });
    if (!(await settleDurableEditAttemptTx(tx, durableCompletion))) {
      throw new TextEditLeaseLostError();
    }
    return {
      projectId: options.projectId,
      operationId: options.operationId,
      planVersionId: created.id,
      publicationRevision: published.contentRevision,
      fallbackStatus: options.settledStatus
    };
  }, MANUSCRIPT_PUBLICATION_TRANSACTION_OPTIONS);
}

export async function continuationOutlineWithModel(options: {
  plan: BookPlan;
  editInstruction: string;
  requestContext?: string | undefined;
  characterContext?: string | undefined;
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
            approvedEditInstruction: options.editInstruction,
            ...(options.characterContext ? { characterContext: options.characterContext } : {}),
            ...(options.requestContext && options.requestContext !== options.editInstruction
              ? { originalRequestContext: options.requestContext }
              : {})
          })
        }
      ]
    });
    if (result.data.chapters.length > 0) {
      return { chapters: result.data.chapters.slice(0, options.chapterCount) };
    }
  } catch (error) {
    if (isStopRequestedError(error)) {
      throw error;
    }
    console.warn(`Continuation outline model call failed; using fallback`, error);
  }
  return fallbackContinuationOutline(options.editInstruction, options.chapterCount);
}

type ContinuationCandidate = ContinuationContextCandidate & {
  chapterId: string | null;
  chapter: BookPlan["chapters"][number];
  researchNotes: string[];
};

type ContinuationAdherenceAudit = {
  verdict: EditAdherenceVerdict;
  attempts: number;
  missingRequirements: string[];
  checkedAt: string;
  proseApproved: boolean;
};

async function reviewContinuationCandidates(options: {
  projectId: string;
  planId: string;
  editInstruction: string;
  characterContext?: string | undefined;
  input: ReturnType<typeof inputForPlanVersion>;
  plan: BookPlan;
  providers: ReturnType<typeof createLoggedProviders>;
  strategy: ReturnType<typeof strategyForInput>;
  candidates: Map<number, ContinuationCandidate>;
  generationJobId?: string | undefined;
  assertLease: () => Promise<void>;
}): Promise<ContinuationAdherenceAudit> {
  await options.assertLease();
  let verdict = await continuationAdherenceVerdict(options);
  await options.assertLease();
  let attempts = 1;
  let proseApproved = continuationProseApproved(options.candidates);
  while ((!verdict.satisfied || !proseApproved) && attempts < 3) {
    attempts += 1;
    // An unverified review never reached a content decision. Re-ask it after
    // this round, while allowing page QA (which did run) to repair its own
    // failures without turning the review sentinel into an edit instruction.
    const unverified = verdict.basis === "unverified";
    const flagged = new Set(unverified ? [] : verdict.pageIndexesToRevise);
    for (const candidate of options.candidates.values()) {
      if (!candidate.qualityReport.approved) flagged.add(candidate.pageIndex);
    }
    if (flagged.size === 0 && !unverified) {
      for (const pageIndex of options.candidates.keys()) flagged.add(pageIndex);
    }
    const adherenceRepair = unverified ? [] : [...verdict.missingRequirements, ...verdict.contradictions];
    for (const candidate of [...options.candidates.values()].sort((left, right) => left.pageIndex - right.pageIndex)) {
      if (!flagged.has(candidate.pageIndex)) continue;
      await options.assertLease();
      const previousPages = continuationPreviousPages(candidate, options.candidates);
      const pageContinuityNotes = continuationContinuityNotes(candidate, options.candidates);
      const revised = await revisePageDraftWithRestart({
        strategy: options.strategy,
        generationJobId: options.generationJobId,
        context: `Continuation page ${candidate.pageIndex}`,
        reviseOptions: {
          input: options.input,
          plan: options.plan,
          chapter: candidate.chapter,
          pageIndex: candidate.pageIndex,
          draft: candidate.draft,
          report: continuationRepairReport(candidate.qualityReport, adherenceRepair),
          editInstruction: options.editInstruction,
          ...(options.characterContext ? { characterContext: options.characterContext } : {}),
          adherenceRepair,
          previousPages,
          continuityNotes: pageContinuityNotes,
          researchNotes: candidate.researchNotes,
          textModel: options.providers.text
        }
      });
      const reviewed = await reviewAndSaveGeneratedPage({
        projectId: options.projectId,
        planId: options.planId,
        input: options.input,
        plan: options.plan,
        providers: options.providers,
        strategy: options.strategy,
        draft: { ...revised, index: candidate.pageIndex },
        chapterId: candidate.chapterId,
        chapter: candidate.chapter,
        previousPages,
        generationJobId: options.generationJobId,
        illustrate: false,
        deferPublication: true,
        editInstruction: options.editInstruction,
        ...(options.characterContext ? { characterContext: options.characterContext } : {}),
        maxCandidates: 1,
        assertOwnership: options.assertLease
      });
      if (!reviewed.candidate) {
        throw new Error(`Deferred continuation repair for page ${candidate.pageIndex} returned no candidate`);
      }
      options.candidates.set(candidate.pageIndex, {
        ...candidate,
        draft: reviewed.candidate.draft,
        qualityReport: reviewed.candidate.qualityReport,
        previousPages,
        continuityNotes: pageContinuityNotes
      });
    }
    await options.assertLease();
    verdict = await continuationAdherenceVerdict(options);
    await options.assertLease();
    proseApproved = continuationProseApproved(options.candidates);
  }
  return {
    verdict,
    attempts,
    missingRequirements: verdict.missingRequirements,
    checkedAt: new Date().toISOString(),
    proseApproved
  };
}

function continuationAdherenceVerdict(options: {
  editInstruction: string;
  providers: ReturnType<typeof createLoggedProviders>;
  candidates: Map<number, ContinuationCandidate>;
}): Promise<EditAdherenceVerdict> {
  return reviewAppliedBookEdit({
    instruction: options.editInstruction,
    beforePages: [],
    afterPages: [...options.candidates.values()]
      .sort((left, right) => left.pageIndex - right.pageIndex)
      .map((candidate) => ({
        index: candidate.pageIndex,
        title: candidate.draft.title,
        markdown: candidate.draft.markdown,
        summary: candidate.draft.summary
      })),
    textModel: options.providers.text
  });
}
