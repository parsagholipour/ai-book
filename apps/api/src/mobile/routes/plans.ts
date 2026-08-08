import {
  dispatchGenerationJob,
  enqueueGenerationJob,
  isBullJobActive,
  requeueGenerationJob,
  type GenerationJobType
} from "../../queue.js";
import { type MobileProjectRecoveryDto } from "../dto.js";
import { queueDirectPlanRevision } from "../editOperations.js";
import { retryPlanRevisionOperation } from "../planRevisionRetries.js";
import {
  hitAuthenticatedLimit,
  requireMobileAuth,
  sendImageLimitReached,
  sendInsufficientCredits,
  sendMobileError
} from "../httpErrors.js";
import { serializeBookEditOperation } from "../projectChat.js";
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
  idParamsSchema,
  mobileAuthError,
  mobileOperationRetryOpenApiBody,
  mobilePlanApprovalBodySchema,
  mobilePlanApprovalOpenApiBody,
  mobilePlanRevisionBodySchema,
  mobilePlanRevisionOpenApiBody,
  operationRetryBodySchema
} from "../schemas.js";
import { hashString } from "../support.js";
import { randomUUID } from "node:crypto";
import { createProjectSchema, estimateFullBookCreditCost } from "@book-maker/core";
import { prisma } from "@book-maker/db";
import {
  InsufficientCreditsError,
  commitReservedCredits,
  consumeIllustratedBookUse,
  getImageQuota,
  grantProjectEntitlement,
  refundCreditLedgerEntry,
  releaseIllustratedBookUse,
  reserveCredits,
  type CreditLedgerEntryRecord
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
      if (!hitAuthenticatedLimit(generationLimiter, request, reply, auth.user.id, "plan")) {
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
      if (!hitAuthenticatedLimit(generationLimiter, request, reply, auth.user.id, "revise-plan")) {
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
      return sendMobileError(reply, 400, "VALIDATION_ERROR", "Provide an idempotency request ID.");
    }
    const result = await retryPlanRevisionOperation({
      userId: auth.user.id,
      ...(params.projectId ? { projectId: params.projectId } : {}),
      operationId: params.id,
      requestId: parsed.data.requestId,
      automatic: false,
      log: request.log
    });
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

      const approvalDedupeKey = `generate-book:${plan.projectId}:${id}`;
      const existingApprovalJob = await prisma.generationJob.findUnique({
        where: { dedupeKey: approvalDedupeKey }
      });
      if (existingApprovalJob) {
        return reply
          .code(202)
          .send(planOperation("generation_queued", plan.projectId, id, existingApprovalJob, "Full book generation is already scheduled."));
      }

      const generationInput = createProjectSchema.parse(inputSnapshotFromProject(plan.project));
      if (!(await enforceContentRestrictions(reply, generationInput.prompt))) {
        return;
      }
      const creditEstimate = estimateFullBookCreditCost(generationInput);

      // This is the only route that starts an illustrated generation, so it is
      // the only place the free tier's monthly image budget has to be claimed.
      // Claimed before the charge, and handed back with it if the refund path
      // ever runs — see `metadata.imageQuota` below.
      let quotaPeriodKey: string | null = null;
      if (creditEstimate.assumptions.estimatedInteriorImages > 0) {
        const quota = await getImageQuota(auth.user.id);
        if (quota) {
          const claim = await consumeIllustratedBookUse({ userId: auth.user.id, limit: quota.limit });
          if (!claim.allowed) {
            return sendImageLimitReached(reply, claim);
          }
          quotaPeriodKey = claim.periodKey;
        }
      }

      let reservation: CreditLedgerEntryRecord | null = null;
      let spend: CreditLedgerEntryRecord | null = null;
      try {
        reservation = await reserveCredits({
          userId: auth.user.id,
          projectId: plan.projectId,
          operation: "FULL_BOOK_GENERATION",
          amountCredits: creditEstimate.totalCredits,
          // A fixed fallback key recreates the documented reserve-after-refund
          // hazard (see reserveCredits): approve → fail → refund → retry found
          // the reversed row and did the work for free. A client that sends no
          // requestId gets a fresh key — no replay protection, but no free run.
          idempotencyKey: `mobile:plan:${id}:approve:${approvalBody.data.requestId ?? randomUUID()}`,
          description: "Mobile full book generation package",
          metadata: {
            creditEstimate,
            ...(quotaPeriodKey ? { imageQuota: { periodKey: quotaPeriodKey } } : {})
          }
        });

        spend = reservation ? await commitReservedCredits(reservation.id) : null;
        if (spend) {
          await grantProjectEntitlement({
            userId: auth.user.id,
            projectId: plan.projectId,
            type: "EXPORT_UNLOCK",
            source: "full_generation_credits",
            creditsCost: creditEstimate.totalCredits,
            relatedLedgerEntryId: spend.id,
            metadata: {
              planId: id,
              includedInFullGenerationPackage: true
            }
          });
        }

        const transactionResult = await prisma.$transaction(async (tx) => {
          const job = await enqueueGenerationJob({
            projectId: plan.projectId,
            type: "GENERATE_BOOK",
            dedupeKey: approvalDedupeKey,
            transaction: tx,
            dispatch: false,
            payload: {
              planId: id,
              ...(spend ? { billingLedgerEntryId: spend.id } : {})
            }
          });
          await tx.planVersion.updateMany({
            where: { projectId: plan.projectId, id: { not: id } },
            data: { status: "SUPERSEDED" }
          });
          await tx.planVersion.update({
            where: { id },
            data: { status: "APPROVED", approvedAt: new Date() }
          });
          await tx.project.update({
            where: { id: plan.projectId },
            data: { currentPlanId: id, status: "GENERATING" }
          });
          if (spend) {
            await tx.creditLedgerEntry.update({
              where: { id: spend.id },
              data: { projectId: plan.projectId, generationJobId: job.id }
            });
          }
          return { job };
        });
        await dispatchGenerationJob(transactionResult.job.id);
        return reply.code(202).send(planOperation("generation_queued", plan.projectId, id, transactionResult.job, "Starting full book generation."));
      } catch (error) {
        const entryToRefund = spend ?? reservation;
        if (entryToRefund) {
          // The refund releases the quota slot too, because the entry carries
          // the period it was claimed against.
          await refundCreditLedgerEntry(entryToRefund.id, "Full generation could not be queued.");
        } else if (quotaPeriodKey) {
          // Nothing was ever charged — the reservation itself threw — so the
          // slot has to be handed back here.
          await releaseIllustratedBookUse(auth.user.id, quotaPeriodKey);
        }
        if (error instanceof InsufficientCreditsError) {
          return sendInsufficientCredits(reply, error);
        }
        throw error;
      }
    }
  );

  fastify.post(
    "/api/mobile/projects/:id/resume",
    { schema: { tags: ["mobile"], response: { 202: {}, 401: mobileAuthError, 404: mobileAuthError, 409: mobileAuthError } } },
    async (request, reply) => {
      const auth = await requireMobileAuth(request, reply);
      if (!auth) {
        return;
      }
      const { id } = idParamsSchema.parse(request.params);
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

      const nextStatus = jobsReadyToResume.every((job) => isPlanningRecoveryJob(job.type as GenerationJobType))
        ? "PLANNING"
        : "GENERATING";
      await prisma.project.update({ where: { id }, data: { status: nextStatus } });
      for (const job of jobsReadyToResume) {
        await requeueGenerationJob({
          id: job.id,
          projectId: job.projectId,
          type: job.type as GenerationJobType,
          payload: recoveryPayload(job.type as GenerationJobType, job.payload, project.currentPlanId)
        });
      }

      return reply.code(202).send({
        projectId: id,
        status: "recovery_started",
        currentAction: nextStatus === "PLANNING" ? "Retrying your book plan." : "Picking up your book generation.",
        resumedActions: jobsReadyToResume.length,
        skippedActions: failedJobs.length - jobsForRecovery.length,
        stoppingActions: stoppingJobs
      } satisfies MobileProjectRecoveryDto);
    }
  );
}
