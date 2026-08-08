import {
  dispatchGenerationJob,
  enqueueGenerationJob,
  isBullJobActive,
  type GenerationJobType
} from "../../queue.js";
import { type MobileProjectRecoveryDto } from "../dto.js";
import { queueDirectPlanRevision } from "../editOperations.js";
import { retryPlanRevisionOperation } from "../planRevisionRetries.js";
import {
  hitTieredLimit,
  requireMobileAuth,
  sendImageLimitReached,
  sendInsufficientCredits,
  sendMobileError
} from "../httpErrors.js";
import { serializeBookEditOperation } from "../projectChat.js";
import { isValidGenerationRetryToken } from "../generationRetryQuote.js";
import { queueInitialMobilePlan } from "../projectRecords.js";
import {
  canRecoverGenerationJob,
  inputSnapshotFromProject,
  isPlanningRecoveryJob,
  planOperation,
  recoveryPayload
} from "../projectSerializers.js";
import {
  emptyMobilePlanBodySchema,
  generationFailureJobTypes,
  generationRetryBodySchema,
  idParamsSchema,
  mobileAuthError,
  mobileOperationRetryOpenApiBody,
  mobileGenerationRetryOpenApiBody,
  mobilePlanApprovalBodySchema,
  mobilePlanApprovalOpenApiBody,
  mobilePlanRevisionBodySchema,
  mobilePlanRevisionOpenApiBody,
  operationRetryBodySchema
} from "../schemas.js";
import { fingerprintGenerationRequest, hashString, jsonRecord } from "../support.js";
import { createProjectSchema, estimateFullBookCreditCost } from "@book-maker/core";
import { Prisma, prisma } from "@book-maker/db";
import {
  GenerationAttemptConflictError,
  GenerationQuotaExceededError,
  InsufficientCreditsError,
  getImageQuota,
  startGenerationAttempt
} from "@book-maker/db/billing";
import { type FastifyReply, type FastifyRequest } from "fastify";
import { z } from "zod";
import type { FastifyInstance } from "fastify";
import type { MobileRouteContext } from "../routeContext.js";
import { enforceContentRestrictions } from "../../contentRestrictions.js";

/**
 * Plan revision/approval, operation retries, and stalled-generation resume.
 */

export async function registerMobilePlanRoutes(fastify: FastifyInstance, context: MobileRouteContext): Promise<void> {
  const { generationLimiter } = context;

  fastify.post(
    "/api/mobile/projects/:id/plan",
    {
      attachValidation: true,
      schema: { tags: ["mobile"], body: { type: "object", additionalProperties: false } }
    },
    async (request, reply) => {
      const auth = await requireMobileAuth(request, reply);
      if (!auth) {
        return;
      }
      if (!(await hitTieredLimit(generationLimiter, request, reply, auth.user.id, "plan"))) {
        return;
      }
      const { id } = idParamsSchema.parse(request.params);
      const parsed = emptyMobilePlanBodySchema.safeParse(request.body ?? {});
      if (!parsed.success) {
        return sendMobileError(reply, 400, "VALIDATION_ERROR", "Planning from mobile does not accept advanced generation settings.");
      }

      const project = await prisma.project.findFirst({
        where: { id, userId: auth.user.id },
        select: {
          id: true,
          title: true,
          subtitle: true,
          authorName: true,
          coverTagline: true,
          prompt: true,
          category: true,
          subcategory: true,
          targetPages: true,
          complexity: true,
          temperature: true,
          language: true,
          mediaSettings: true
        }
      });
      if (!project) {
        return sendMobileError(reply, 404, "PROJECT_NOT_FOUND", "Project not found.");
      }
      if (!(await enforceContentRestrictions(reply, project.prompt))) {
        return;
      }

      try {
        return reply
          .code(202)
          .send(await queueInitialMobilePlan(auth.user.id, id, inputSnapshotFromProject(project)));
      } catch (error) {
        if (error instanceof InsufficientCreditsError) {
          return sendInsufficientCredits(reply, error);
        }
        throw error;
      }
    }
  );

  fastify.post(
    "/api/mobile/plans/:id/revise",
    {
      attachValidation: true,
      schema: {
        tags: ["mobile"],
        body: mobilePlanRevisionOpenApiBody
      }
    },
    async (request, reply) => {
      const auth = await requireMobileAuth(request, reply);
      if (!auth) {
        return;
      }
      if (!(await hitTieredLimit(generationLimiter, request, reply, auth.user.id, "revise-plan"))) {
        return;
      }
      const { id } = idParamsSchema.parse(request.params);
      const parsed = mobilePlanRevisionBodySchema.safeParse(request.body);
      if (!parsed.success) {
        return sendMobileError(reply, 400, "VALIDATION_ERROR", "Provide a short revision request.");
      }
      if (!(await enforceContentRestrictions(reply, parsed.data.message))) {
        return;
      }
      const plan = await prisma.planVersion.findFirst({
        where: { id, project: { userId: auth.user.id } },
        select: { id: true, projectId: true, status: true }
      });
      if (!plan) {
        return sendMobileError(reply, 404, "PLAN_NOT_FOUND", "Plan not found.");
      }
      if (plan.status === "APPROVED") {
        return sendMobileError(reply, 400, "PLAN_ALREADY_APPROVED", "Approved plans cannot be revised.");
      }

      try {
        const { operation, job } = await queueDirectPlanRevision({
          userId: auth.user.id,
          projectId: plan.projectId,
          planId: id,
          message: parsed.data.message,
          requestId: parsed.data.requestId ?? hashString(parsed.data.message)
        });
        request.log.info(
          { event: "plan_revision.queued", projectId: plan.projectId, operationId: operation.id, generationJobId: job.id, source: "direct" },
          "Plan revision queued"
        );
        return reply.code(202).send(planOperation("revision_queued", plan.projectId, id, job, "Revising your book plan."));
      } catch (error) {
        if (error instanceof InsufficientCreditsError) {
          return sendInsufficientCredits(reply, error);
        }
        throw error;
      }
    }
  );

  const retryOperationHandler = async (request: FastifyRequest, reply: FastifyReply) => {
    const auth = await requireMobileAuth(request, reply);
    if (!auth) return;
    const params = z.object({ id: z.string().min(1), projectId: z.string().min(1).optional() }).parse(request.params);
    const parsed = operationRetryBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return sendMobileError(
        reply,
        400,
        "RETRY_CONFIRMATION_REQUIRED",
        "Refresh the project and confirm the current retry price before retrying."
      );
    }
    let result;
    try {
      result = await retryPlanRevisionOperation({
        userId: auth.user.id,
        ...(params.projectId ? { projectId: params.projectId } : {}),
        operationId: params.id,
        requestId: parsed.data.requestId,
        retryToken: parsed.data.retryToken,
        automatic: false,
        log: request.log
      });
    } catch (error) {
      if (error instanceof InsufficientCreditsError) {
        return sendInsufficientCredits(reply, error);
      }
      if (error instanceof GenerationAttemptConflictError) {
        return sendMobileError(reply, 409, "RETRY_NOT_AVAILABLE", error.message);
      }
      throw error;
    }
    if (result.kind === "not_found") {
      return sendMobileError(reply, 404, "OPERATION_NOT_FOUND", "Plan revision operation not found.");
    }
    if (result.kind === "conflict") {
      return sendMobileError(reply, 409, "RETRY_NOT_AVAILABLE", result.reason);
    }
    return reply.code(202).send({ operation: serializeBookEditOperation(result.operation) });
  };

  fastify.post(
    "/api/mobile/projects/:projectId/operations/:id/retry",
    { attachValidation: true, schema: { tags: ["mobile"], body: mobileOperationRetryOpenApiBody } },
    retryOperationHandler
  );

  // Backward-compatible alias for clients released before retries were scoped
  // by project in the public mobile API.
  fastify.post(
    "/api/mobile/book-edit-operations/:id/retry",
    { attachValidation: true, schema: { tags: ["mobile"], body: mobileOperationRetryOpenApiBody } },
    retryOperationHandler
  );

  fastify.post(
    "/api/mobile/plans/:id/approve",
    { attachValidation: true, schema: { tags: ["mobile"], body: mobilePlanApprovalOpenApiBody } },
    async (request, reply) => {
      const auth = await requireMobileAuth(request, reply);
      if (!auth) {
        return;
      }
      const { id } = idParamsSchema.parse(request.params);
      const approvalBody = mobilePlanApprovalBodySchema.safeParse(request.body ?? {});
      if (!approvalBody.success) {
        return sendMobileError(reply, 400, "VALIDATION_ERROR", "This approval request is invalid.");
      }
      const plan = await prisma.planVersion.findFirst({
        where: { id, project: { userId: auth.user.id } },
        include: { project: true }
      });
      if (!plan) {
        return sendMobileError(reply, 404, "PLAN_NOT_FOUND", "Plan not found.");
      }
      // Approving a superseded version would charge a second full-book package
      // for a project that already committed to another plan. The in-transaction
      // guard below is the authoritative check; this is the readable answer.
      if (plan.status === "SUPERSEDED") {
        return sendMobileError(reply, 409, "PLAN_SUPERSEDED", "A newer plan replaced this one. Approve the latest plan instead.");
      }

      const approvalDedupeKey = `generate-book:${plan.projectId}:${id}`;

      // A plan approved before the attempt ledger existed (migration 000039
      // backfills nothing) already owns this dedupe key with no attempt behind
      // it. Re-approving must replay that job — charging first and then finding
      // the existing job would debit a second time for no new work.
      const legacyApprovalJob = await prisma.generationJob.findUnique({ where: { dedupeKey: approvalDedupeKey } });
      if (legacyApprovalJob && !legacyApprovalJob.attemptId) {
        const job =
          legacyApprovalJob.status === "QUEUED" && !legacyApprovalJob.bullJobId
            ? (await dispatchGenerationJob(legacyApprovalJob.id)) ?? legacyApprovalJob
            : legacyApprovalJob;
        return reply
          .code(202)
          .send(planOperation("generation_queued", plan.projectId, id, job, "Starting full book generation."));
      }

      // An explicit "continue without illustrations" choice, made when the
      // free tier's monthly image budget refused the illustrated approval.
      // Written to the project row (what this route prices from) *and* the
      // plan's frozen inputSnapshot (what the worker generates from) before
      // either is read, so the charge and the book can never disagree. Raw
      // spreads, not a schema round-trip, so unknown mediaSettings keys —
      // mobile metadata among them — survive untouched.
      if (approvalBody.data.disableIllustrations) {
        const rawSettings = { ...jsonRecord(plan.project.mediaSettings), fullIllustrations: false };
        const rawSnapshot = plan.inputSnapshot ? jsonRecord(plan.inputSnapshot) : null;
        plan.project.mediaSettings = rawSettings as Prisma.JsonValue;
        if (rawSnapshot) {
          plan.inputSnapshot = {
            ...rawSnapshot,
            mediaSettings: { ...jsonRecord(rawSnapshot.mediaSettings), fullIllustrations: false }
          } as Prisma.JsonValue;
        }
      }

      const generationInput = createProjectSchema.parse(inputSnapshotFromProject(plan.project));
      if (!(await enforceContentRestrictions(reply, generationInput.prompt))) {
        return;
      }
      const creditEstimate = estimateFullBookCreditCost(generationInput);

      const imageQuota =
        creditEstimate.assumptions.estimatedInteriorImages > 0 ? await getImageQuota(auth.user.id) : null;
      try {
        const started = await startGenerationAttempt({
          userId: auth.user.id,
          commandKey: `mobile:plan-approval:${id}`,
          requestFingerprint: fingerprintGenerationRequest({ planId: id, generationInput }),
          projectId: plan.projectId,
          operation: "FULL_BOOK_GENERATION",
          quotedCredits: creditEstimate.totalCredits,
          description: "Mobile full book generation package",
          metadata: { planId: id, creditEstimate },
          imageQuotaLimit: imageQuota?.limit ?? null,
          grantExportEntitlement: true,
          create: async (tx, { attemptId, ledgerEntry }) => {
            if (approvalBody.data.disableIllustrations) {
              await tx.project.update({
                where: { id: plan.projectId },
                data: { mediaSettings: plan.project.mediaSettings as Prisma.InputJsonValue }
              });
              if (plan.inputSnapshot) {
                await tx.planVersion.update({
                  where: { id },
                  data: { inputSnapshot: plan.inputSnapshot as Prisma.InputJsonValue }
                });
              }
            }
            const job = await enqueueGenerationJob({
              projectId: plan.projectId,
              type: "GENERATE_BOOK",
              dedupeKey: approvalDedupeKey,
              transaction: tx,
              dispatch: false,
              attemptId,
              payload: {
                planId: id,
                ...(ledgerEntry ? { billingLedgerEntryId: ledgerEntry.id } : {})
              }
            });
            // The conditional write is the one-approval-per-project guard:
            // concurrent approvals of two versions each supersede the other, so
            // under the serializable transaction the loser matches zero rows
            // here and rolls its charge back instead of committing a second
            // full-book package for the same project.
            const approved = await tx.planVersion.updateMany({
              where: { id, status: { not: "SUPERSEDED" } },
              data: { status: "APPROVED", approvedAt: new Date() }
            });
            if (approved.count !== 1) {
              throw new GenerationAttemptConflictError("A newer plan replaced this one. Approve the latest plan instead.");
            }
            await tx.planVersion.updateMany({
              where: { projectId: plan.projectId, id: { not: id } },
              data: { status: "SUPERSEDED" }
            });
            await tx.project.update({
              where: { id: plan.projectId },
              data: { currentPlanId: id, status: "GENERATING" }
            });
            return { projectId: plan.projectId, primaryJobId: job.id };
          }
        });
        const job = started.attempt.primaryJobId
          ? await dispatchGenerationJob(started.attempt.primaryJobId)
          : null;
        if (!job) {
          throw new Error("Generation attempt has no primary job.");
        }
        return reply.code(202).send(planOperation("generation_queued", plan.projectId, id, job, "Starting full book generation."));
      } catch (error) {
        if (error instanceof GenerationQuotaExceededError) {
          return sendImageLimitReached(reply, error.claim);
        }
        if (error instanceof InsufficientCreditsError) {
          return sendInsufficientCredits(reply, error);
        }
        if (error instanceof GenerationAttemptConflictError) {
          return sendMobileError(reply, 409, error.code, error.message);
        }
        throw error;
      }
    }
  );

  fastify.post(
    "/api/mobile/projects/:id/resume",
    {
      attachValidation: true,
      schema: {
        tags: ["mobile"],
        body: mobileGenerationRetryOpenApiBody,
        response: { 202: {}, 401: mobileAuthError, 404: mobileAuthError, 409: mobileAuthError }
      }
    },
    async (request, reply) => {
      const auth = await requireMobileAuth(request, reply);
      if (!auth) {
        return;
      }
      const { id } = idParamsSchema.parse(request.params);
      const retryBody = generationRetryBodySchema.safeParse(request.body ?? {});
      if (!retryBody.success) {
        return sendMobileError(
          reply,
          409,
          "RETRY_CONFIRMATION_REQUIRED",
          "Confirm the displayed retry price before retrying generation."
        );
      }
      const project = await prisma.project.findFirst({
        where: { id, userId: auth.user.id },
        include: { currentPlan: true }
      });
      if (!project) {
        return sendMobileError(reply, 404, "PROJECT_NOT_FOUND", "Project not found.");
      }

      const failedJobs = await prisma.generationJob.findMany({
        where: {
          projectId: id,
          status: "FAILED",
          type: { in: generationFailureJobTypes }
        },
        orderBy: { createdAt: "asc" }
      });
      const pages = await prisma.page.findMany({
        where: { projectId: id },
        select: { id: true }
      });
      const resumeContext = {
        currentPlanId: project.currentPlanId,
        currentPlanCreatedAt: project.currentPlan?.createdAt ?? null,
        pageIds: new Set(pages.map((page) => page.id))
      };
      const recoveryCandidates = failedJobs.filter((job) =>
        canRecoverGenerationJob(job.type as GenerationJobType, job.payload, resumeContext, job.createdAt)
      );
      const planningRecoveryCandidates = recoveryCandidates.filter((job) =>
        isPlanningRecoveryJob(job.type as GenerationJobType)
      );
      const jobsForRecovery = planningRecoveryCandidates.length > 0 ? planningRecoveryCandidates : recoveryCandidates;
      const jobsReadyToResume: typeof failedJobs = [];
      let stoppingJobs = 0;
      for (const job of jobsForRecovery) {
        if (await isBullJobActive(job.bullJobId)) {
          stoppingJobs += 1;
        } else {
          jobsReadyToResume.push(job);
        }
      }

      if (jobsReadyToResume.length === 0) {
        return sendMobileError(
          reply,
          409,
          "RECOVERY_NOT_AVAILABLE",
          stoppingJobs > 0
            ? "Generation is still winding down. Try again in a moment."
            : "There is nothing ready to retry for this book."
        );
      }

      const sourceAttemptIds = [...new Set(jobsReadyToResume.flatMap((job) => (job.attemptId ? [job.attemptId] : [])))];
      if (sourceAttemptIds.length === 0) {
        return sendMobileError(
          reply,
          409,
          "RETRY_CONFIRMATION_REQUIRED",
          "This older generation cannot be charged again without a confirmed retry quote."
        );
      }
      const sourceAttempts = await prisma.generationAttempt.findMany({
        where: {
          id: { in: sourceAttemptIds },
          userId: auth.user.id,
          projectId: id,
          status: { in: ["FAILED", "CANCELED"] },
          refundPending: false
        }
      });
      const sourceAttempt = sourceAttempts.find((attempt) =>
        isValidGenerationRetryToken(attempt, retryBody.data.retryToken)
      );
      if (!sourceAttempt) {
        return sendMobileError(reply, 409, "RETRY_QUOTE_INVALID", "Refresh the book and confirm the current retry price.");
      }

      const sourceJobs = jobsReadyToResume.filter((job) => job.attemptId === sourceAttempt.id);
      if (sourceJobs.length === 0) {
        return sendMobileError(reply, 409, "RECOVERY_NOT_AVAILABLE", "There is nothing ready to retry for this book.");
      }
      const nextStatus = jobsReadyToResume.every((job) => isPlanningRecoveryJob(job.type as GenerationJobType))
        ? "PLANNING"
        : "GENERATING";
      // A confirmed retry re-charges the full package, so it must also carry
      // the package's benefits: refunding the failed attempt revoked the export
      // entitlement and released the illustrated-book slot, and a retry that
      // skipped them would deliver a paid book with locked exports while
      // bypassing the free tier's image budget.
      const isFullBookRetry = sourceAttempt.operation === "FULL_BOOK_GENERATION";
      let imageQuotaLimit: number | null = null;
      if (isFullBookRetry) {
        const generationInput = createProjectSchema.parse(inputSnapshotFromProject(project));
        if (estimateFullBookCreditCost(generationInput).assumptions.estimatedInteriorImages > 0) {
          imageQuotaLimit = (await getImageQuota(auth.user.id))?.limit ?? null;
        }
      }
      let started;
      try {
        started = await startGenerationAttempt({
          userId: auth.user.id,
          commandKey: `mobile:generation-retry:${sourceAttempt.id}:${retryBody.data.requestId}`,
          requestFingerprint: fingerprintGenerationRequest({
            sourceAttemptId: sourceAttempt.id,
            jobs: sourceJobs.map((job) => ({ id: job.id, type: job.type, payload: job.payload }))
          }),
          projectId: id,
          retryOfAttemptId: sourceAttempt.id,
          operation: sourceAttempt.operation,
          quotedCredits: sourceAttempt.quotedCredits,
          description: "Confirmed mobile generation retry",
          metadata: { sourceAttemptId: sourceAttempt.id, retryRequestId: retryBody.data.requestId },
          imageQuotaLimit,
          grantExportEntitlement: isFullBookRetry,
          create: async (tx, { attemptId, ledgerEntry }) => {
            let primaryJobId: string | null = null;
            for (const sourceJob of sourceJobs) {
              const payload = recoveryPayload(sourceJob.type as GenerationJobType, sourceJob.payload, project.currentPlanId);
              delete payload.billingLedgerEntryId;
              const job = await enqueueGenerationJob({
                projectId: id,
                type: sourceJob.type as GenerationJobType,
                dedupeKey: `generation-retry:${sourceAttempt.id}:${sourceJob.id}`,
                transaction: tx,
                dispatch: false,
                attemptId,
                payload: { ...payload, ...(ledgerEntry ? { billingLedgerEntryId: ledgerEntry.id } : {}) }
              });
              primaryJobId ??= job.id;
            }
            if (!primaryJobId) {
              throw new Error("Confirmed retry created no generation job.");
            }
            await tx.project.update({ where: { id }, data: { status: nextStatus } });
            return { projectId: id, primaryJobId };
          }
        });
      } catch (error) {
        if (error instanceof GenerationQuotaExceededError) {
          return sendImageLimitReached(reply, error.claim);
        }
        if (error instanceof InsufficientCreditsError) {
          return sendInsufficientCredits(reply, error);
        }
        if (error instanceof GenerationAttemptConflictError) {
          return sendMobileError(reply, 409, error.code, error.message);
        }
        throw error;
      }
      const attemptJobs = await prisma.generationJob.findMany({
        where: { attemptId: started.attempt.id },
        select: { id: true, status: true }
      });
      const retryJobs = attemptJobs.filter((job) => job.status === "QUEUED");
      for (const job of retryJobs) {
        await dispatchGenerationJob(job.id);
      }
      // A replayed retry with nothing left to run is spent — its jobs already
      // failed or finished. A 202 here would strand the app on a quote whose
      // confirmation queues zero actions forever.
      if (
        started.replayed &&
        retryJobs.length === 0 &&
        !attemptJobs.some((job) => job.status === "ACTIVE")
      ) {
        return sendMobileError(
          reply,
          409,
          "RETRY_NOT_AVAILABLE",
          "That retry already ran. Refresh the book to see the current retry option."
        );
      }

      return reply.code(202).send({
        projectId: id,
        status: "recovery_started",
        currentAction: nextStatus === "PLANNING" ? "Retrying your book plan." : "Picking up your book generation.",
        resumedActions: retryJobs.length,
        skippedActions: failedJobs.length - jobsForRecovery.length,
        stoppingActions: stoppingJobs
      } satisfies MobileProjectRecoveryDto);
    }
  );
}
