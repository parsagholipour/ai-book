import {
  getProjectOrThrow,
  nextPlanVersion,
  planInputSnapshot,
  strategyForInput
} from "../generation/bookHelpers.js";
import { inputForPlanVersion, inputWithMessageMediaPreferences, inputWithMobileSourceMaterial } from "../generation/projectInput.js";
import {
  authoritativeReplanMessage,
  resolveEditPromptContext,
  splitLegacyCharacterContext
} from "../generation/editOperationContext.js";
import { createLoggedProviders } from "../providers/loggedAdapters.js";
import { config } from "../runtime/config.js";
import { canEnqueueProjectWork, dispatchWorkerGenerationJob } from "../runtime/dispatch.js";
import { currentGenerationAttemptId } from "../runtime/generationAttemptContext.js";
import { advanceJobStep } from "../runtime/jobLifecycle.js";
import { UnownedReplanDeliveryError } from "../runtime/jobTypes.js";
import { cleanTargetLanguage } from "../runtime/serialization.js";
import {
  acquireReplanStagingLeaseTx,
  releaseReplanStagingLeaseTx,
  renewReplanStagingLeaseTx,
  type ReplanStagingLeaseOperation,
  startReplanEditLeaseHeartbeat
} from "../generation/replanEditLease.js";
import {
  bookPlanSchema,
  createProviders,
  inputWithReplanSettings,
  jsonPayloadToRecord,
  type BookPlan,
  type CreateProjectInput
} from "@book-maker/core";
import { PAGE_RESTRUCTURE_TRANSACTION_OPTIONS, Prisma, prisma } from "@book-maker/db";
import { randomUUID } from "node:crypto";
import type { ReplanBookJob } from "../runtime/jobPayloads.js";

/**
 * `replan-book` job: replace a project's plan and regenerate affected pages.
 */

export async function replanBook(job: ReplanBookJob) {
  const { projectId, operationId, planId, sourceProjectId: queuedSourceProjectId, sourcePlanId, targetLanguage, targetPages } =
    job.data;
  const { generationJobId } = job.data;
  let stagingOwnerToken = randomUUID();
  let operation = await claimReplanStaging({ projectId, operationId, generationJobId, ownerToken: stagingOwnerToken });
  const { editInstruction, requestContext, characterContext } = resolveEditPromptContext(operation, job.data);
  const legacyRequest =
    splitLegacyCharacterContext(operation.request).text ||
    splitLegacyCharacterContext(job.data.request).text ||
    editInstruction;
  const sourceProjectId = resolveReplanSourceProjectId({
    targetProjectId: projectId,
    operationProjectId: operation.projectId,
    durableSourceProjectId: operation.sourceProjectId,
    queuedSourceProjectId
  });
  let stagedPlanId = stagedReplanId(operation.classifier);
  if (!stagedPlanId) {
    const heartbeat = startReplanEditLeaseHeartbeat(operationId, stagingOwnerToken);
    try {
      await advanceJobStep(generationJobId, "revise", 30, "Rebuilding book plan");
      const targetProject = await getProjectOrThrow(projectId);
      const sourceProject = sourceProjectId && sourceProjectId !== projectId
        ? await getProjectOrThrow(sourceProjectId)
        : targetProject;
      const currentPlanId = sourcePlanId ?? planId ?? sourceProject.currentPlanId;
      if (!currentPlanId) {
        throw new Error("Cannot replan without a current plan");
      }
      const planVersion = await prisma.planVersion.findUnique({ where: { id: currentPlanId }, include: { project: true } });
      if (!planVersion) {
        throw new Error("Current plan not found");
      }
      const requestedLanguage = cleanTargetLanguage(targetLanguage);
      // The plan is revised from the *source* book's input snapshot, so a replan
      // that resizes the book has to say so here: left to the snapshot the planner
      // is told to hit the old length, and normalizePlanPageTargets then pads the
      // revised chapters back up to it even when the model wrote fewer.
      const requestedPages =
        typeof targetPages === "number" && Number.isInteger(targetPages) && targetPages > 0 ? targetPages : null;
      const sourceInput = inputWithMessageMediaPreferences(
        inputForPlanVersion(sourceProject, planVersion.inputSnapshot),
        editInstruction
      );
      const input = inputWithReplanSettings(
        {
          ...sourceInput,
          ...(requestedLanguage ? { language: requestedLanguage } : {})
        },
        requestedPages === null ? null : { targetPages: requestedPages }
      );
      const strategy = strategyForInput(input);
      const providers = createLoggedProviders(job, createProviders(config, input), input);
      const currentPlan = bookPlanSchema.parse(planVersion.planningPackage);

      // The initial claim is intentionally repeated at the last possible point
      // before spending a provider call. Stop takes the same Project -> Job ->
      // Operation order, so a committed stop makes this assertion stand down.
      operation = await assertReplanStaging({
        projectId,
        operationId,
        generationJobId,
        ownerToken: stagingOwnerToken
      });
      const revised = await strategy.revisePlan({
        currentPlan,
        userMessage: authoritativeReplanMessage(editInstruction, requestContext, characterContext),
        textModel: providers.text,
        input: inputWithMobileSourceMaterial(input),
        targetPages: input.targetPages,
        temperature: input.temperature,
        language: input.language,
        toneProfile: input.mediaSettings.toneProfile
      });
      const priorMessages = Array.isArray(planVersion.messages) ? planVersion.messages : [];
      stagedPlanId = await stageOwnedReplan({
        projectId,
        operationId,
        generationJobId,
        ownerToken: stagingOwnerToken,
        editInstruction,
        sourceProjectId,
        currentPlanId,
        input,
        revised,
        priorMessages
      });
    } finally {
      await heartbeat.stop();
    }

    // Staging deliberately releases the provider-call lease. A crash after the
    // DRAFT commit can therefore replay immediately, while this delivery must
    // re-claim before it is allowed to create/link the successor.
    stagingOwnerToken = randomUUID();
    operation = await claimReplanStaging({ projectId, operationId, generationJobId, ownerToken: stagingOwnerToken });
    stagedPlanId = stagedReplanId(operation.classifier);
    if (!stagedPlanId) throw new UnownedReplanDeliveryError();
  }

  const enqueueHeartbeat = startReplanEditLeaseHeartbeat(operationId, stagingOwnerToken);
  try {
    await advanceJobStep(generationJobId, "generate", 85, "Queueing regenerated book");
    await enqueueStagedReplan(
      job,
      stagedPlanId,
      editInstruction,
      legacyRequest,
      sourceProjectId,
      stagingOwnerToken,
      characterContext
    );
  } finally {
    await enqueueHeartbeat.stop();
  }
}

async function enqueueStagedReplan(
  job: ReplanBookJob,
  planId: string,
  editInstruction: string,
  legacyRequest: string,
  sourceProjectId: string,
  ownerToken: string,
  characterContext?: string | undefined
): Promise<void> {
  const { projectId, operationId, generationJobId } = job.data;
  // The same refusal `enqueueWorkerJob` makes: a FAILED project takes no new
  // work, and a durable row created under one would only be republished by
  // reconciliation forever.
  if (!(await canEnqueueProjectWork(projectId))) {
    throw new UnownedReplanDeliveryError();
  }
  const successorJobId = await linkReplanSuccessor({
    projectId,
    operationId,
    predecessorJobId: generationJobId,
    ownerToken,
    planId,
    editInstruction,
    sourceProjectId,
    payload: {
      planId,
      replanOperationId: operationId,
      sourceProjectId,
      editInstruction,
      request: legacyRequest,
      ...(characterContext ? { characterContext } : {}),
      ...(job.data.billingLedgerEntryId ? { billingLedgerEntryId: job.data.billingLedgerEntryId } : {})
    }
  });
  // Published only once the linkage it will be judged on is committed. The
  // successor's own pre-ACTIVE guard proves the operation names *this* row, so
  // a job on Redis ahead of that write is one a worker reads as an impostor,
  // cancels and refunds — and the linkage behind it then finds no open row left
  // to claim, wedging the replan on a dedupe key nothing can reuse. A row
  // committed but not yet published is the state
  // `reconcileUndispatchedWorkerJobs` exists to finish.
  await dispatchWorkerGenerationJob(successorJobId);
}

/**
 * Attempt-scoped identity for the book a staged replan regenerates.
 *
 * Mirrors `enqueueWorkerJob`'s own key scoping: a paid retry is a new attempt
 * and stages its own successor, while redelivery within one attempt collapses
 * onto the row a previous delivery already created and linked.
 */
function replanSuccessorDedupeKey(projectId: string, planId: string, attemptId: string | null): string {
  const base = `generate-book:${projectId}:${planId}`;
  return attemptId ? `${base}:attempt:${attemptId}` : base;
}

class ReplanStagingClaimLostError extends Error {}

async function claimReplanStaging(options: {
  projectId: string;
  operationId: string;
  generationJobId: string;
  ownerToken: string;
}): Promise<ReplanStagingLeaseOperation> {
  return replanStagingTransaction(async (tx) => {
    await lockReplanProjectAndJob(tx, options);
    const operation = await acquireReplanStagingLeaseTx(tx, options);
    if (!operation) throw new ReplanStagingClaimLostError();
    await tx.project.update({ where: { id: options.projectId }, data: { status: "EDITING" } });
    return operation;
  });
}

async function assertReplanStaging(options: {
  projectId: string;
  operationId: string;
  generationJobId: string;
  ownerToken: string;
}): Promise<ReplanStagingLeaseOperation> {
  return replanStagingTransaction(async (tx) => {
    await lockReplanProjectAndJob(tx, options);
    return renewAndLoadStagingOperation(tx, options);
  });
}

async function stageOwnedReplan(options: {
  projectId: string;
  operationId: string;
  generationJobId: string;
  ownerToken: string;
  editInstruction: string;
  sourceProjectId: string;
  currentPlanId: string;
  input: CreateProjectInput;
  revised: BookPlan;
  priorMessages: unknown[];
}): Promise<string> {
  return replanStagingTransaction(async (tx) => {
    await lockReplanProjectAndJob(tx, options);
    const operation = await renewAndLoadStagingOperation(tx, options);
    const version = await nextPlanVersion(options.projectId, tx);
    const newPlan = await tx.planVersion.create({
      data: {
        projectId: options.projectId,
        version,
        status: "DRAFT",
        planningPackage: options.revised,
        inputSnapshot: planInputSnapshot(options.input),
        messages: [
          ...options.priorMessages,
          { role: "user", content: options.editInstruction, at: new Date().toISOString(), source: "book_replan" }
        ] as Prisma.InputJsonValue
      }
    });
    const staged = await tx.bookEditOperation.updateMany({
      where: {
        id: options.operationId,
        generationJobId: options.generationJobId,
        status: "ACTIVE",
        structuralLeaseToken: options.ownerToken,
        structuralLeaseCompletedAt: null
      },
      data: {
        editInstruction: options.editInstruction,
        sourceProjectId: options.sourceProjectId,
        classifier: {
          ...jsonPayloadToRecord(operation.classifier),
          replanStagedPlanId: newPlan.id,
          replanSourcePlanId: options.currentPlanId
        } as Prisma.InputJsonValue
      }
    });
    if (staged.count !== 1) throw new ReplanStagingClaimLostError();
    if (!(await releaseReplanStagingLeaseTx(tx, options))) throw new ReplanStagingClaimLostError();
    return newPlan.id;
  });
}

/**
 * Creates the successor row and the linkage that names it in one commit.
 *
 * The row is deliberately *not* created by `enqueueWorkerJob`: that helper
 * publishes to Redis as part of creating the row, and this successor is only
 * legible to a worker once the operation points at it. Creating it here keeps
 * the two facts in one transaction, so no reconciliation sweep or rival
 * delivery can ever observe an unlinked successor. Returns its id for the
 * caller to publish after the commit.
 */
async function linkReplanSuccessor(options: {
  projectId: string;
  operationId: string;
  predecessorJobId: string;
  ownerToken: string;
  planId: string;
  editInstruction: string;
  sourceProjectId: string;
  payload: Record<string, unknown>;
}): Promise<string> {
  const attemptId = currentGenerationAttemptId();
  const dedupeKey = replanSuccessorDedupeKey(options.projectId, options.planId, attemptId);
  return replanStagingTransaction(async (tx) => {
    await lockReplanProjectAndJob(tx, {
      projectId: options.projectId,
      generationJobId: options.predecessorJobId
    });
    const claimed = await tx.generationJob.upsert({
      where: { dedupeKey },
      create: {
        projectId: options.projectId,
        type: "GENERATE_BOOK",
        status: "QUEUED",
        progress: 0,
        message: "Queued",
        dedupeKey,
        ...(attemptId ? { attemptId } : {}),
        payload: options.payload as Prisma.InputJsonValue
      },
      update: {},
      select: { id: true }
    });
    const successor = await tx.generationJob.updateMany({
      where: {
        id: claimed.id,
        projectId: options.projectId,
        type: "GENERATE_BOOK",
        status: { in: ["QUEUED", "ACTIVE"] }
      },
      data: { dispatchAttempts: { increment: 0 } }
    });
    if (successor.count !== 1) throw new ReplanStagingClaimLostError();
    const operation = await renewAndLoadStagingOperation(tx, {
      operationId: options.operationId,
      generationJobId: options.predecessorJobId,
      ownerToken: options.ownerToken
    });
    if (stagedReplanId(operation.classifier) !== options.planId) throw new ReplanStagingClaimLostError();
    const linked = await tx.bookEditOperation.updateMany({
      where: {
        id: options.operationId,
        generationJobId: options.predecessorJobId,
        status: "ACTIVE",
        structuralLeaseToken: options.ownerToken,
        structuralLeaseCompletedAt: null
      },
      data: {
        generationJobId: claimed.id,
        editInstruction: options.editInstruction,
        sourceProjectId: options.sourceProjectId,
        classifier: {
          ...jsonPayloadToRecord(operation.classifier),
          replanSuccessorJobId: claimed.id
        } as Prisma.InputJsonValue
      }
    });
    if (linked.count !== 1) throw new ReplanStagingClaimLostError();
    if (
      !(await releaseReplanStagingLeaseTx(tx, {
        operationId: options.operationId,
        generationJobId: claimed.id,
        ownerToken: options.ownerToken
      }))
    ) {
      throw new ReplanStagingClaimLostError();
    }
    return claimed.id;
  });
}

async function lockReplanProjectAndJob(
  tx: Prisma.TransactionClient,
  options: { projectId: string; generationJobId: string }
): Promise<void> {
  await tx.project.update({
    where: { id: options.projectId },
    data: { contentRevision: { increment: 0 } }
  });
  const job = await tx.generationJob.updateMany({
    where: {
      id: options.generationJobId,
      projectId: options.projectId,
      type: "REPLAN_BOOK",
      status: "ACTIVE"
    },
    data: { dispatchAttempts: { increment: 0 } }
  });
  if (job.count !== 1) throw new ReplanStagingClaimLostError();
}

async function renewAndLoadStagingOperation(
  tx: Prisma.TransactionClient,
  options: { operationId: string; generationJobId: string; ownerToken: string }
): Promise<ReplanStagingLeaseOperation> {
  const operation = await renewReplanStagingLeaseTx(tx, options);
  if (!operation) throw new ReplanStagingClaimLostError();
  return operation;
}

async function replanStagingTransaction<T>(run: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
  try {
    return await prisma.$transaction(run, PAGE_RESTRUCTURE_TRANSACTION_OPTIONS);
  } catch (error) {
    if (error instanceof ReplanStagingClaimLostError) throw new UnownedReplanDeliveryError();
    throw error;
  }
}

function resolveReplanSourceProjectId(options: {
  targetProjectId: string;
  operationProjectId?: string | null | undefined;
  durableSourceProjectId?: string | null | undefined;
  queuedSourceProjectId?: string | undefined;
}): string {
  const durable = options.durableSourceProjectId?.trim();
  if (durable) return durable;

  // Replan-copy operations have always lived on the source project. Prefer
  // that durable owner over a stale or reconstructed queue payload.
  const operationOwner = options.operationProjectId?.trim();
  if (operationOwner && operationOwner !== options.targetProjectId) return operationOwner;

  const queued = options.queuedSourceProjectId?.trim();
  if (queued && queued !== options.targetProjectId) return queued;

  // Legacy in-place replans legitimately use the same project as source and
  // target. Candidate generation separately refuses an empty source set, so a
  // copy cannot silently turn this fallback into an empty comparison.
  return operationOwner || queued || options.targetProjectId;
}

function stagedReplanId(classifier: unknown): string | null {
  const value = jsonPayloadToRecord(classifier).replanStagedPlanId;
  return typeof value === "string" && value.trim() ? value : null;
}
