import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import {
  AUTO_BOOK_GENERATION_STRATEGY_ID,
  bookGenerationStrategies,
  createLanguageDetectionTextModel,
  createProjectSchema,
  createVoiceProvider,
  buildMarginEstimate,
  buildRealtimeGroupCharacterInstructions,
  buildRealtimeGroupListenerInstructions,
  detectPromptLanguage,
  estimateFullBookCreditCost,
  estimateProviderCostForProject,
  generateGeminiVoiceConversationTranscript,
  imageModelOptions,
  isEnglishLanguage,
  loadConfig,
  makeMockVoiceConversationTranscript,
  mediaSettingsSchema,
  normalizeProjectLanguage,
  normalizeVoiceProfile,
  publicAssetUrl,
  reinforceRealtimeCharacterRoleplay,
  resolveBookGenerationStrategy,
  resolveVoiceRtcConfig,
  synthesizeGeminiTtsConversation,
  textModelOptions,
  voiceConversationCharacterSnapshots,
  voiceConversationSpeakersForTranscript,
  voiceProviderOptions,
  voiceProfileSchema,
  type AppConfig,
  type CreateProjectInput,
  type ProjectCostSummary,
  type VoiceChatProviderId
} from "@book-maker/core";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { extname, join } from "node:path";
import { ensureSeedTemplates, PLAN_REVISION_AUTOMATIC_RETRY_LIMIT, Prisma, prisma } from "@book-maker/db";
import { jobsWithoutRefundedCharges } from "../resumeGuards.js";
import { buildProjectStatus, normalizeTokenUsage } from "../projectStatus.js";
import { loadProjectCostSummaries, loadProjectCostSummary } from "../projectCosts.js";
import { deleteProjectStorage } from "../projectStorage.js";
import {
  dispatchGenerationJob,
  enqueueGenerationJob,
  isBullJobActive,
  requeueGenerationJob,
  stopProjectGenerationJobs,
  type GenerationJobType
} from "../queue.js";
import { resolveProjectActor, sendProjectNotFound, type ProjectActor } from "../requestAuth.js";
import { ownedProjectWhere, registerProjectExportRoutes } from "./projectExports.js";

// The compiled-book helpers moved to ./projectExports.js; re-exported here
// because the mobile routes and serializers import them from this module.
export {
  compileProjectMarkdown,
  projectExportAvailability,
  sanitizeDownloadFilename,
  sendProjectEpubExport,
  sendProjectPdfExport,
  strategyForMediaSettings,
  type ProjectEpubExportSource,
  type ProjectExportFormat,
  type ProjectPdfExportSource
} from "./projectExports.js";
import { z } from "zod";
import {
  isVoiceConfigurationError,
  mockVoiceConversationWav,
  resolveInitialVoiceConversationSetup,
  resolveVoiceConversationContinuationSetup,
  sanitizeVoiceCallMetadata,
  sanitizeVoiceCallOptionalText,
  sanitizeVoiceCallText,
  serializeVoiceConversation,
  stringFromRecord
} from "./projectVoiceSupport.js";

const idParamsSchema = z.object({ id: z.string().min(1) });
const assetParamsSchema = z.object({
  projectId: z.string().min(1),
  filename: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,180}$/)
});
const planMessageParamsSchema = z.object({ id: z.string().min(1) });
const voiceCharacterParamsSchema = z.object({ id: z.string().min(1), characterId: z.string().min(1) });
const voiceCharacterIdParamsSchema = z.object({ characterId: z.string().min(1) });
const planMessageBodySchema = z.object({
  message: z.string().min(1).max(10000),
  respondedQuestionPrompts: z.array(z.string().min(1).max(1000)).max(40).optional()
});
const voiceProfilePatchSchema = voiceProfileSchema.partial();
const voiceCallReconnectContextSchema = z.string().trim().max(2000).optional();
const voiceCallModelSchema = z.string().trim().min(1).max(120).optional();
const voiceCallBodySchema = z.union([
  z.object({
    provider: z.literal("openai_realtime").default("openai_realtime"),
    transport: z.literal("webrtc_sdp").default("webrtc_sdp"),
    offerSdp: z.string().min(1),
    voiceModel: voiceCallModelSchema,
    reconnectContext: voiceCallReconnectContextSchema
  }),
  z.object({
    provider: z.literal("gemini_live"),
    transport: z.literal("gemini_live").default("gemini_live"),
    sessionHandle: z.string().trim().min(1).max(2048).optional(),
    voiceModel: voiceCallModelSchema,
    reconnectContext: voiceCallReconnectContextSchema
  })
]);
const voiceRoomParticipantOpenAISchema = z.object({
  characterId: z.string().min(1),
  offerSdp: z.string().min(1)
});
const voiceRoomParticipantGeminiSchema = z.object({
  characterId: z.string().min(1),
  sessionHandle: z.string().trim().min(1).max(2048).optional()
});
const voiceRoomSessionBodySchema = z.union([
  z.object({
    provider: z.literal("openai_realtime"),
    transport: z.literal("webrtc_sdp"),
    voiceModel: voiceCallModelSchema,
    listenerOfferSdp: z.string().min(1),
    participants: z.array(voiceRoomParticipantOpenAISchema).min(2).max(4)
  }),
  z.object({
    provider: z.literal("gemini_live"),
    transport: z.literal("gemini_live"),
    voiceModel: voiceCallModelSchema,
    listenerSessionHandle: z.string().trim().min(1).max(2048).optional(),
    participants: z.array(voiceRoomParticipantGeminiSchema).min(2).max(4)
  })
]);
const voiceConversationBodySchema = z
  .object({
    prompt: z.string().trim().min(1).max(2000),
    characterIds: z.array(z.string().min(1)).length(2).optional(),
    continuationOfConversationId: z.string().trim().min(1).optional()
  })
  .refine((value) => Boolean(value.continuationOfConversationId) !== Boolean(value.characterIds), {
    message: "Provide either characterIds or continuationOfConversationId."
  })
  .strict();
const voiceCallEventPhaseSchema = z.enum([
  "connect_start",
  "connected",
  "disconnected",
  "reconnect_start",
  "reconnect_success",
  "reconnect_failed",
  "failed",
  "ended"
]);
const voiceCallEventTextSchema = z.string().trim().min(1).max(500);
const voiceCallEventOptionalTextSchema = z.string().trim().max(500).optional();
const voiceCallEventBodySchema = z
  .object({
    clientCallId: voiceCallEventTextSchema.max(128),
    phase: voiceCallEventPhaseSchema,
    attempt: z.number().int().min(1).max(100).optional(),
    elapsedMs: z.number().int().min(0).max(86_400_000).optional(),
    connectionState: voiceCallEventOptionalTextSchema,
    iceConnectionState: voiceCallEventOptionalTextSchema,
    iceGatheringState: voiceCallEventOptionalTextSchema,
    candidatePairType: voiceCallEventOptionalTextSchema,
    candidateProtocol: voiceCallEventOptionalTextSchema,
    currentRoundTripTimeMs: z.number().int().min(0).max(600_000).optional(),
    packetsLost: z.number().int().min(0).max(1_000_000_000).optional(),
    jitterMs: z.number().int().min(0).max(600_000).optional(),
    error: voiceCallEventOptionalTextSchema,
    metadata: z
      .record(z.string().trim().min(1).max(64), z.union([z.string().max(500), z.number(), z.boolean(), z.null()]))
      .default({})
  })
  .strict();
const retryablePlanningJobTypes: GenerationJobType[] = ["PLAN_BOOK", "REVISE_PLAN"];
const resumableJobTypes: GenerationJobType[] = ["GENERATE_PAGE", "GENERATE_IMAGE", "COMPILE_EXPORT", "APPLY_BOOK_EDIT"];
const restartableJobTypes: GenerationJobType[] = ["GENERATE_BOOK", "REPLAN_BOOK"];
const generationFailureJobTypes = [...retryablePlanningJobTypes, ...resumableJobTypes, ...restartableJobTypes];
const MIME_BY_EXT: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".wav": "audio/wav",
  ".mp3": "audio/mpeg",
  ".m4a": "audio/mp4",
  ".ogg": "audio/ogg"
};
type ResumeContext = {
  currentPlanId: string | null;
  currentPlanCreatedAt: Date | null;
  existingPages: number;
  pageIds: Set<string>;
};


export const projectRoutes: FastifyPluginAsync = async (fastify) => {
  await ensureSeedTemplates();
  const appConfig = loadConfig();

  fastify.get("/api/health", async () => ({ ok: true, mockAi: appConfig.MOCK_AI }));

  fastify.get("/assets/images/:projectId/:filename", async (request, reply) => {
    const { projectId, filename } = assetParamsSchema.parse(request.params);
    return sendOwnedProjectAsset(request, reply, {
      projectId,
      filename,
      storageDir: appConfig.IMAGE_STORAGE_DIR,
      missingLabel: "Image not found"
    });
  });

  fastify.get("/assets/voice/:projectId/:filename", async (request, reply) => {
    const { projectId, filename } = assetParamsSchema.parse(request.params);
    return sendOwnedProjectAsset(request, reply, {
      projectId,
      filename,
      storageDir: appConfig.VOICE_STORAGE_DIR,
      missingLabel: "Voice file not found"
    });
  });

  fastify.get("/api/voice/rtc-config", async () => resolveVoiceRtcConfig(appConfig));

  fastify.get("/api/voice/providers", async () => voiceProviderOptions(appConfig));

  fastify.get("/api/runtime", async () => ({
    mockAi: appConfig.MOCK_AI,
    providers: {
      text: appConfig.MOCK_AI ? "fake" : "deepseek",
      research: appConfig.MOCK_AI ? "fake" : "gemini",
      image: appConfig.MOCK_AI ? "fake" : "gemini",
      embedding: appConfig.MOCK_AI ? "fake" : "gemini"
    },
    models: {
      text: appConfig.MOCK_AI ? "fake-model" : appConfig.DEEPSEEK_MODEL,
      fastText: appConfig.MOCK_AI ? "fake-model" : appConfig.DEEPSEEK_FAST_MODEL,
      research: appConfig.MOCK_AI ? "fake-model" : appConfig.GEMINI_TEXT_MODEL,
      image: appConfig.MOCK_AI ? "fake-image" : appConfig.GEMINI_IMAGE_MODEL,
      embedding: appConfig.MOCK_AI ? "fake-embedding" : appConfig.GEMINI_EMBEDDING_MODEL
    },
    textModelOptions: appConfig.MOCK_AI
      ? [{ provider: "deepseek", model: "fake-model", label: "Mock text model" }]
      : textModelOptions(appConfig),
    imageModelOptions: imageModelOptions(appConfig),
    generationStrategies: [
      {
        id: AUTO_BOOK_GENERATION_STRATEGY_ID,
        label: "Auto (recommended)",
        strengthScore: 10,
        recommendedPageRange: { min: 1, max: 600 }
      },
      ...bookGenerationStrategies.map((strategy) => ({
        id: strategy.id,
        label: strategy.label,
        strengthScore: strategy.strengthScore,
        recommendedPageRange: strategy.recommendedPageRange
      }))
    ]
  }));

  fastify.get("/api/templates", async (request, reply) => {
    const actor = await resolveProjectActor(request, reply);
    if (!actor) {
      return;
    }
    return prisma.template.findMany({ orderBy: [{ category: "asc" }, { name: "asc" }] });
  });

  fastify.get("/api/projects", async (request, reply) => {
    const actor = await resolveProjectActor(request, reply);
    if (!actor) {
      return;
    }
    const projects = await prisma.project.findMany({
      where: { userId: actor.userId },
      orderBy: { updatedAt: "desc" },
      include: {
        template: true,
        currentPlan: true,
        _count: { select: { pages: true, images: true, jobs: true } }
      }
    });
    const projectIds = projects.map((project) => project.id);
    const [tokenRows, costsByProjectId] = await Promise.all([
      projectIds.length > 0
        ? prisma.providerCallLog.groupBy({
            by: ["projectId"],
            where: { projectId: { in: projectIds } },
            _sum: { promptTokens: true, outputTokens: true, cacheHitTokens: true }
          })
        : Promise.resolve([]),
      loadProjectCostSummaries(projectIds)
    ]);
    const tokensByProjectId = new Map(
      tokenRows.flatMap((row) =>
        row.projectId ? [[row.projectId, normalizeTokenUsage(row._sum)] as const] : []
      )
    );

    return projects.map((project) => ({
      ...project,
      tokens: tokensByProjectId.get(project.id) ?? normalizeTokenUsage(),
      cost: costsByProjectId.get(project.id),
      billing: projectBillingSummary(project, costsByProjectId.get(project.id))
    }));
  });

  fastify.get("/api/projects/:id", async (request, reply) => {
    const { id } = idParamsSchema.parse(request.params);
    const actor = await resolveProjectActor(request, reply);
    if (!actor) {
      return;
    }
    const project = await prisma.project.findFirst({
      where: ownedProjectWhere(id, actor),
      include: {
        template: true,
        currentPlan: true,
        chapters: { orderBy: { index: "asc" } },
        pages: { orderBy: { index: "asc" } },
        images: true,
        research: true
      }
    });
    if (!project) {
      return reply.code(404).send({ error: "Project not found" });
    }
    const [tokenLogs, cost] = await Promise.all([
      prisma.providerCallLog.aggregate({
        where: { projectId: id },
        _sum: { promptTokens: true, outputTokens: true, cacheHitTokens: true }
      }),
      loadProjectCostSummary(id)
    ]);
    return {
      ...project,
      tokens: normalizeTokenUsage(tokenLogs._sum),
      cost,
      billing: projectBillingSummary(project, cost)
    };
  });

  fastify.post("/api/projects", async (request, reply) => {
    const actor = await resolveProjectActor(request, reply);
    if (!actor) {
      return;
    }
    const input = await inputWithDetectedLanguage(createProjectSchema.parse(request.body), request.body, appConfig);
    const template = await prisma.template.findFirst({
      where: input.templateSlug ? { slug: input.templateSlug } : { category: input.category }
    });
    const title = input.title ?? deriveTitle(input.prompt);
    const subtitle = cleanOptionalText(input.subtitle);
    const authorName = cleanOptionalText(input.authorName);
    const coverTagline = cleanOptionalText(input.coverTagline);
    const subcategory = cleanOptionalText(input.subcategory);

    const project = await prisma.project.create({
      data: {
        userId: actor.userId,
        title,
        ...(subtitle ? { subtitle } : {}),
        ...(authorName ? { authorName } : {}),
        ...(coverTagline ? { coverTagline } : {}),
        prompt: input.prompt,
        category: input.category,
        ...(subcategory ? { subcategory } : {}),
        targetPages: input.targetPages,
        complexity: input.complexity,
        temperature: input.temperature,
        language: input.language,
        mediaSettings: mediaSettingsSchema.parse(input.mediaSettings),
        ...(template ? { templateId: template.id } : {})
      },
      include: { template: true }
    });

    return reply.code(201).send(project);
  });

  fastify.post("/api/projects/:id/plan", async (request, reply) => {
    const { id } = idParamsSchema.parse(request.params);
    const actor = await resolveProjectActor(request, reply);
    if (!actor) {
      return;
    }
    const input =
      request.body === undefined
        ? null
        : await inputWithDetectedLanguage(createProjectSchema.parse(request.body), request.body, appConfig);
    const project = await prisma.project.findFirst({ where: ownedProjectWhere(id, actor) });
    if (!project) {
      return reply.code(404).send({ error: "Project not found" });
    }

    const template = input
      ? await prisma.template.findFirst({
          where: input.templateSlug ? { slug: input.templateSlug } : { category: input.category }
        })
      : null;

    const transactionResult = await prisma.$transaction(async (tx) => {
      await tx.project.update({
        where: { id },
        data: {
          ...(input ? projectUpdateDataFromInput(input, template?.id ?? null) : {}),
          status: "PLANNING"
        }
      });
      const job = await enqueueGenerationJob({
        projectId: id,
        type: "PLAN_BOOK",
        dedupeKey: `plan-book:${id}:${stablePayloadHash(input ? jsonPayload(input) : {})}`,
        payload: input ? { inputSnapshot: jsonPayload(input) } : {},
        transaction: tx,
        dispatch: false
      });
      return { job };
    });
    await dispatchGenerationJob(transactionResult.job.id);
    return reply.code(202).send(transactionResult.job);
  });

  fastify.post("/api/plans/:id/messages", async (request, reply) => {
    const { id } = planMessageParamsSchema.parse(request.params);
    const actor = await resolveProjectActor(request, reply);
    if (!actor) {
      return;
    }
    const body = planMessageBodySchema.parse(request.body);
    const plan = await prisma.planVersion.findFirst({ where: ownedPlanWhere(id, actor) });
    if (!plan) {
      return reply.code(404).send({ error: "Plan not found" });
    }

    if (plan.status === "APPROVED") {
      return reply.code(400).send({ error: "Approved plans cannot be revised. Create a new plan version first." });
    }

    const directRevisionRequestId = stablePayloadHash({ planId: id, message: body.message, responded: body.respondedQuestionPrompts ?? [] });
    const existingOperation = await prisma.bookEditOperation.findUnique({
      where: { projectId_requestId: { projectId: plan.projectId, requestId: directRevisionRequestId } },
      include: { generationJob: true }
    });
    if (existingOperation?.generationJob) {
      return reply.code(202).send(existingOperation.generationJob);
    }
    const transactionResult = await prisma.$transaction(async (tx) => {
      const operation = await tx.bookEditOperation.create({
        data: {
          projectId: plan.projectId,
          requestId: directRevisionRequestId,
          kind: "PLAN_REVISION",
          status: "QUEUED",
          request: body.message,
          classifier: { kind: "plan_revision", source: "web" },
          affectedPageIndexes: [],
          creditsCharged: 0,
          automaticRetryLimit: PLAN_REVISION_AUTOMATIC_RETRY_LIMIT
        }
      });
      const job = await enqueueGenerationJob({
        projectId: plan.projectId,
        type: "REVISE_PLAN",
        dedupeKey: `revise-plan:${plan.projectId}:${id}:${directRevisionRequestId}`,
        dispatch: false,
        transaction: tx,
        payload: {
          planId: id,
          message: body.message,
          editOperationId: operation.id,
          ...(body.respondedQuestionPrompts?.length
            ? { respondedQuestionPrompts: body.respondedQuestionPrompts }
            : {})
        }
      });
      await tx.bookEditOperation.update({ where: { id: operation.id }, data: { generationJobId: job.id } });
      await tx.project.update({ where: { id: plan.projectId }, data: { status: "PLANNING" } });
      return { job };
    });
    await dispatchGenerationJob(transactionResult.job.id);
    return reply.code(202).send(transactionResult.job);
  });

  fastify.post("/api/plans/:id/approve", async (request, reply) => {
    const { id } = planMessageParamsSchema.parse(request.params);
    const actor = await resolveProjectActor(request, reply);
    if (!actor) {
      return;
    }
    const plan = await prisma.planVersion.findFirst({ where: ownedPlanWhere(id, actor), include: { project: true } });
    if (!plan) {
      return reply.code(404).send({ error: "Plan not found" });
    }

    const approvalDedupeKey = `generate-book:${plan.projectId}:${id}`;
    const existingApprovalJob = await prisma.generationJob.findUnique({ where: { dedupeKey: approvalDedupeKey } });
    if (existingApprovalJob) {
      return reply.code(202).send(existingApprovalJob);
    }

    const resolvedStrategy = resolveBookGenerationStrategy(planInputForStrategy(plan.inputSnapshot, plan.project));

    const transactionResult = await prisma.$transaction(async (tx) => {
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
      const job = await enqueueGenerationJob({
        projectId: plan.projectId,
        type: "GENERATE_BOOK",
        dedupeKey: approvalDedupeKey,
        payload: { planId: id },
        transaction: tx,
        dispatch: false
      });
      return { job };
    });
    await dispatchGenerationJob(transactionResult.job.id);
    return reply.code(202).send({
      ...transactionResult.job,
      strategy: {
        id: resolvedStrategy.strategy.id,
        requestedId: resolvedStrategy.requestedId,
        autoSelected: resolvedStrategy.autoSelected,
        switched: resolvedStrategy.switched,
        warnings: resolvedStrategy.warnings
      }
    });
  });

  fastify.post("/api/projects/:id/cover", async (request, reply) => {
    const { id } = idParamsSchema.parse(request.params);
    const actor = await resolveProjectActor(request, reply);
    if (!actor) {
      return;
    }
    const project = await prisma.project.findFirst({ where: ownedProjectWhere(id, actor), include: { currentPlan: true } });
    if (!project) {
      return reply.code(404).send({ error: "Project not found" });
    }
    if (!project.currentPlanId) {
      return reply.code(400).send({ error: "A project needs an approved plan before generating a cover." });
    }

    await prisma.project.update({ where: { id }, data: { status: "GENERATING" } });
    // Sequenced like the page-retry key rather than the worker's plain
    // `generate-cover:project:plan` key: a dedupe row is adopted forever, so a
    // stable key would make regenerating a finished cover impossible, while no
    // key at all let a double-tap run two racing cover jobs. Terminal jobs
    // advance the sequence; two rapid requests read the same count and
    // collapse onto one row.
    const priorCoverJobs = await prisma.generationJob.findMany({
      where: { projectId: id, type: "GENERATE_IMAGE", status: { in: ["COMPLETED", "FAILED", "CANCELED"] } },
      select: { payload: true }
    });
    const coverSequence = priorCoverJobs.filter((coverJob) => {
      const payload = coverJob.payload as { assetType?: unknown } | null;
      return payload?.assetType === "COVER";
    }).length;
    const job = await enqueueGenerationJob({
      projectId: id,
      type: "GENERATE_IMAGE",
      dedupeKey: `generate-cover:${id}:${project.currentPlanId}:regen-${coverSequence}`,
      payload: { planId: project.currentPlanId, assetType: "COVER" }
    });
    return reply.code(202).send(job);
  });

  fastify.post("/api/projects/:id/resume", async (request, reply) => {
    const { id } = idParamsSchema.parse(request.params);
    const actor = await resolveProjectActor(request, reply);
    if (!actor) {
      return;
    }
    const project = await prisma.project.findFirst({ where: ownedProjectWhere(id, actor), include: { currentPlan: true } });
    if (!project) {
      return reply.code(404).send({ error: "Project not found" });
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
      select: { id: true, status: true, revision: true, qualityReport: true }
    });
    const resumeContext = {
      currentPlanId: project.currentPlanId,
      currentPlanCreatedAt: project.currentPlan?.createdAt ?? null,
      existingPages: pages.length,
      pageIds: new Set(pages.map((page) => page.id))
    };
    // Refunded rows recover through the mobile paid-retry route, never a free
    // requeue; the guard's reasoning lives with jobsWithoutRefundedCharges.
    const recoveryCandidates = (await jobsWithoutRefundedCharges(failedJobs)).filter((job) =>
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
      return reply.code(409).send({
        error:
          stoppingJobs > 0
            ? "Stopped generation jobs are still winding down. Try resume again in a moment."
            : "No failed jobs are available to retry or resume for this project."
      });
    }

    const nextStatus = jobsReadyToResume.every((job) => isPlanningRecoveryJob(job.type as GenerationJobType))
      ? "PLANNING"
      : "GENERATING";
    await prisma.project.update({ where: { id }, data: { status: nextStatus } });
    const resumedJobs = [];
    for (const job of jobsReadyToResume) {
      resumedJobs.push(
        await requeueGenerationJob({
          id: job.id,
          projectId: job.projectId,
          type: job.type as GenerationJobType,
          payload: recoveryPayload(job.type as GenerationJobType, job.payload, project.currentPlanId)
        })
      );
    }

    return reply.code(202).send({
      resumedJobs: resumedJobs.length,
      skippedJobs: failedJobs.length - jobsForRecovery.length,
      stoppingJobs,
      jobs: resumedJobs
    });
  });

  fastify.post("/api/projects/:id/pages/:pageId/retry", async (request, reply) => {
    const { id, pageId } = z.object({ id: z.string().min(1), pageId: z.string().min(1) }).parse(request.params);
    const actor = await resolveProjectActor(request, reply);
    if (!actor) {
      return;
    }
    const [project, page] = await Promise.all([
      prisma.project.findFirst({ where: ownedProjectWhere(id, actor), select: { id: true, currentPlanId: true } }),
      prisma.page.findUnique({ where: { id: pageId }, select: { id: true, projectId: true, index: true, status: true, revision: true } })
    ]);
    if (!project || !page || page.projectId !== id) {
      return reply.code(404).send({ error: "Page not found" });
    }
    if (!project.currentPlanId) {
      return reply.code(400).send({ error: "A project needs an approved plan before pages can be retried." });
    }
    if (page.status !== "FAILED_QA") {
      return reply.code(400).send({ error: "Only pages that failed quality review can be retried." });
    }

    const openJobs = await prisma.generationJob.findMany({
      where: { projectId: id, type: "GENERATE_PAGE", status: { in: ["QUEUED", "ACTIVE"] } },
      select: { payload: true }
    });
    if (openJobs.some((job) => jsonPayloadToRecord(job.payload).pageId === pageId)) {
      return reply.code(409).send({ error: "This page is already being regenerated." });
    }

    await prisma.$transaction([
      prisma.page.update({ where: { id: pageId }, data: { status: "PENDING" } }),
      prisma.project.update({ where: { id }, data: { status: "GENERATING" } })
    ]);
    const job = await enqueueGenerationJob({
      projectId: id,
      type: "GENERATE_PAGE",
      dedupeKey: `generate-page:${pageId}:${project.currentPlanId}:retry-${page.revision + 1}`,
      payload: { pageId, planId: project.currentPlanId }
    });
    return reply.code(202).send(job);
  });

  fastify.post("/api/projects/:id/stop", async (request, reply) => {
    const { id } = idParamsSchema.parse(request.params);
    const actor = await resolveProjectActor(request, reply);
    if (!actor) {
      return;
    }
    const project = await prisma.project.findFirst({ where: ownedProjectWhere(id, actor), select: { id: true } });
    if (!project) {
      return reply.code(404).send({ error: "Project not found" });
    }

    const result = await stopProjectGenerationJobs(id);
    return reply.code(202).send(result);
  });

  fastify.delete("/api/projects/:id", async (request, reply) => {
    const { id } = idParamsSchema.parse(request.params);
    const actor = await resolveProjectActor(request, reply);
    if (!actor) {
      return;
    }
    const project = await prisma.project.findFirst({ where: ownedProjectWhere(id, actor), select: { id: true } });
    if (!project) {
      return reply.code(404).send({ error: "Project not found" });
    }

    let stoppedJobs: Awaited<ReturnType<typeof stopProjectGenerationJobs>> | null = null;
    try {
      stoppedJobs = await stopProjectGenerationJobs(id);
    } catch (error) {
      request.log.warn({ err: error, projectId: id }, "Could not stop project jobs before deletion");
    }

    await prisma.project.delete({ where: { id } });
    const assetCleanup = await deleteProjectStorage(appConfig, id, request);
    return {
      ok: true,
      deletedProjectId: id,
      stoppedJobs,
      assetCleanup,
      retainedLogs: "Provider call logs are retained for cost/provider diagnostics with project/job references cleared by database delete rules."
    };
  });

  fastify.get("/api/projects/:id/status", async (request, reply) => {
    const { id } = idParamsSchema.parse(request.params);
    const actor = await resolveProjectActor(request, reply);
    if (!actor) {
      return;
    }
    const project = await prisma.project.findFirst({ where: ownedProjectWhere(id, actor), select: { id: true } });
    if (!project) {
      return reply.code(404).send({ error: "Project not found" });
    }
    const status = await buildProjectStatus(id);
    if (!status) {
      return reply.code(404).send({ error: "Project not found" });
    }
    return status;
  });

  fastify.get("/api/projects/:id/voice-characters", async (request, reply) => {
    const { id } = idParamsSchema.parse(request.params);
    const actor = await resolveProjectActor(request, reply);
    if (!actor) {
      return;
    }
    const project = await prisma.project.findFirst({ where: ownedProjectWhere(id, actor), select: { id: true } });
    if (!project) {
      return reply.code(404).send({ error: "Project not found" });
    }

    const [characters, profileImages] = await Promise.all([
      prisma.voiceCharacter.findMany({
        where: { projectId: id },
        orderBy: [{ status: "asc" }, { createdAt: "asc" }]
      }),
      prisma.imageAsset.findMany({
        where: { projectId: id, type: "CHARACTER_PROFILE" },
        orderBy: { createdAt: "desc" }
      })
    ]);
    const imagesByCharacterId = new Map(
      profileImages.flatMap((image) => {
        const voiceCharacterId = stringFromRecord(image.metadata, "voiceCharacterId");
        return voiceCharacterId ? [[voiceCharacterId, image] as const] : [];
      })
    );
    const defaultVoiceProvider =
      voiceProviderOptions(appConfig).find((option) => option.default) ?? voiceProviderOptions(appConfig)[0];

    return characters.map((character) => ({
      ...character,
      voiceProfile: normalizeVoiceProfile(character.voiceProfile),
      callProvider: defaultVoiceProvider?.id ?? appConfig.VOICE_CHAT_PROVIDER,
      callTransport: defaultVoiceProvider?.transport ?? "webrtc_sdp",
      profileImage: character.profileImageAssetId
        ? profileImages.find((image) => image.id === character.profileImageAssetId) ?? imagesByCharacterId.get(character.id) ?? null
        : imagesByCharacterId.get(character.id) ?? null
    }));
  });

  fastify.post("/api/projects/:id/voice-characters/:characterId/approve", async (request, reply) => {
    const { id, characterId } = voiceCharacterParamsSchema.parse(request.params);
    const actor = await resolveProjectActor(request, reply);
    if (!actor) {
      return;
    }
    const character = await prisma.voiceCharacter.findFirst({
      where: ownedVoiceCharacterWhere(characterId, actor),
      include: { project: { select: { id: true, status: true } } }
    });
    if (!character || character.projectId !== id) {
      return reply.code(404).send({ error: "Voice character not found" });
    }
    if (character.project.status !== "COMPLETE") {
      return reply.code(400).send({ error: "Voice characters can be approved after the book is complete." });
    }
    if (character.status === "REJECTED") {
      return reply.code(400).send({ error: "Rejected voice characters cannot be approved." });
    }

    const updated = await prisma.voiceCharacter.update({
      where: { id: character.id },
      data: {
        status: character.status === "READY" ? "READY" : "APPROVED",
        approvedAt: character.approvedAt ?? new Date(),
        error: null
      }
    });

    if (updated.status !== "READY") {
      const openBuildJobs = await prisma.generationJob.count({
        where: {
          projectId: id,
          type: "BUILD_CHARACTER_PERSONA",
          status: { in: ["QUEUED", "ACTIVE"] },
          payload: { path: ["voiceCharacterId"], equals: character.id }
        }
      });
      if (openBuildJobs === 0) {
        await enqueueGenerationJob({
          projectId: id,
          type: "BUILD_CHARACTER_PERSONA",
          dedupeKey: `build-character:${id}:${character.id}`,
          payload: { voiceCharacterId: character.id }
        });
      }
    }

    return updated;
  });

  fastify.post("/api/projects/:id/voice-characters/:characterId/reject", async (request, reply) => {
    const { id, characterId } = voiceCharacterParamsSchema.parse(request.params);
    const actor = await resolveProjectActor(request, reply);
    if (!actor) {
      return;
    }
    const character = await prisma.voiceCharacter.findFirst({ where: ownedVoiceCharacterWhere(characterId, actor) });
    if (!character || character.projectId !== id) {
      return reply.code(404).send({ error: "Voice character not found" });
    }
    if (character.status === "BUILDING") {
      return reply.code(409).send({ error: "This character is already being built." });
    }
    return prisma.voiceCharacter.update({
      where: { id: character.id },
      data: { status: "REJECTED", error: null }
    });
  });

  fastify.patch("/api/projects/:id/voice-characters/:characterId/voice-profile", async (request, reply) => {
    const { id, characterId } = voiceCharacterParamsSchema.parse(request.params);
    const actor = await resolveProjectActor(request, reply);
    if (!actor) {
      return;
    }
    const patch = voiceProfilePatchSchema.parse(request.body);
    const character = await prisma.voiceCharacter.findFirst({ where: ownedVoiceCharacterWhere(characterId, actor) });
    if (!character || character.projectId !== id) {
      return reply.code(404).send({ error: "Voice character not found" });
    }
    if (character.status === "BUILDING" || character.status === "REJECTED") {
      return reply.code(409).send({ error: "This character's voice profile cannot be edited right now." });
    }

    const voiceProfile = normalizeVoiceProfile({ ...normalizeVoiceProfile(character.voiceProfile), ...patch });
    const selection = createVoiceProvider(appConfig).selectVoice(voiceProfile);
    return prisma.voiceCharacter.update({
      where: { id: character.id },
      data: {
        voiceProfile,
        voiceProvider: selection.provider,
        voiceModel: selection.model,
        voiceId: selection.voiceId,
        providerMetadata: {
          ...jsonPayloadToRecord(character.providerMetadata),
          ...selection.metadata,
          manuallyEdited: true
        }
      }
    });
  });

  fastify.post("/api/voice-characters/:characterId/calls", async (request, reply) => {
    const { characterId } = voiceCharacterIdParamsSchema.parse(request.params);
    const actor = await resolveProjectActor(request, reply);
    if (!actor) {
      return;
    }
    const body = voiceCallBodySchema.parse(request.body);
    const character = await prisma.voiceCharacter.findFirst({
      where: ownedVoiceCharacterWhere(characterId, actor),
      include: { project: { select: { status: true } } }
    });
    if (!character) {
      return reply.code(404).send({ error: "Voice character not found" });
    }
    if (character.project.status !== "COMPLETE" || character.status !== "READY") {
      return reply.code(409).send({ error: "Voice character is not ready for calls." });
    }
    const persona = jsonPayloadToRecord(character.persona);
    const baseInstructions =
      typeof persona.instructions === "string" && persona.instructions.trim()
        ? persona.instructions
        : [
            `You are ${character.name}, speaking from inside this finished book.`,
            `Role: ${character.role}.`,
            `Description: ${character.description}.`,
            "Keep responses conversational, concise, and suitable for a voice call."
          ].join("\n");
    const instructions = reinforceRealtimeCharacterRoleplay(baseInstructions, character.name);
    const requestedProvider: VoiceChatProviderId = body.provider;
    const providerInfo = voiceProviderOptions(appConfig).find((option) => option.id === requestedProvider);
    if (!providerInfo) {
      return reply.code(400).send({ error: `Unsupported voice provider: ${requestedProvider}` });
    }
    if (!providerInfo.configured) {
      return reply.code(400).send({ error: `${providerInfo.label} is not configured.` });
    }
    const requestedModel = body.voiceModel;
    if (requestedModel && !providerInfo.modelOptions.some((option) => option.model === requestedModel)) {
      return reply.code(400).send({ error: `${providerInfo.label} model is not available: ${requestedModel}` });
    }

    try {
      const provider = createVoiceProvider(appConfig, requestedProvider);
      const session = await provider.createRealtimeSession({
        ...("offerSdp" in body ? { offerSdp: body.offerSdp } : {}),
        ...("sessionHandle" in body && body.sessionHandle ? { sessionHandle: body.sessionHandle } : {}),
        characterName: character.name,
        instructions,
        voiceProfile: normalizeVoiceProfile(character.voiceProfile),
        voiceModel: requestedModel,
        reconnectContext: body.reconnectContext
      });
      return session;
    } catch (error) {
      const message = error instanceof Error ? error.message : "Voice call could not be started.";
      if (isVoiceConfigurationError(message)) {
        return reply.code(400).send({ error: message });
      }
      throw error;
    }
  });

  fastify.post("/api/projects/:id/voice-rooms/sessions", async (request, reply) => {
    const { id } = idParamsSchema.parse(request.params);
    const actor = await resolveProjectActor(request, reply);
    if (!actor) {
      return;
    }
    const body = voiceRoomSessionBodySchema.parse(request.body);
    const participantIds = body.participants.map((participant) => participant.characterId);
    if (new Set(participantIds).size !== participantIds.length) {
      return reply.code(400).send({ error: "Voice room participants must be unique." });
    }

    const requestedProvider: VoiceChatProviderId = body.provider;
    const providerInfo = voiceProviderOptions(appConfig).find((option) => option.id === requestedProvider);
    if (!providerInfo) {
      return reply.code(400).send({ error: `Unsupported voice provider: ${requestedProvider}` });
    }
    if (!providerInfo.configured) {
      return reply.code(400).send({ error: `${providerInfo.label} is not configured.` });
    }
    const requestedModel = body.voiceModel;
    if (requestedModel && !providerInfo.modelOptions.some((option) => option.model === requestedModel)) {
      return reply.code(400).send({ error: `${providerInfo.label} model is not available: ${requestedModel}` });
    }

    const [project, characters] = await Promise.all([
      prisma.project.findFirst({ where: ownedProjectWhere(id, actor), select: { id: true, status: true } }),
      prisma.voiceCharacter.findMany({
        where: { id: { in: participantIds } }
      })
    ]);
    if (!project) {
      return reply.code(404).send({ error: "Project not found" });
    }
    if (project.status !== "COMPLETE") {
      return reply.code(409).send({ error: "Voice rooms can be started after the book is complete." });
    }

    const charactersById = new Map(characters.map((character) => [character.id, character]));
    const orderedCharacters = participantIds.flatMap((characterId) => {
      const character = charactersById.get(characterId);
      return character ? [character] : [];
    });
    if (
      orderedCharacters.length !== participantIds.length ||
      orderedCharacters.some((character) => character.projectId !== id)
    ) {
      return reply.code(404).send({ error: "Voice room character not found." });
    }
    if (orderedCharacters.some((character) => character.status !== "READY")) {
      return reply.code(409).send({ error: "All voice room characters must be ready." });
    }

    const participantNames = orderedCharacters.map((character) => character.name);
    const provider = createVoiceProvider(appConfig, requestedProvider);
    try {
      const listener = await provider.createRealtimeSession({
        ...("listenerOfferSdp" in body ? { offerSdp: body.listenerOfferSdp } : {}),
        ...("listenerSessionHandle" in body && body.listenerSessionHandle ? { sessionHandle: body.listenerSessionHandle } : {}),
        characterName: "Voice room listener",
        instructions: buildRealtimeGroupListenerInstructions(participantNames),
        voiceProfile: normalizeVoiceProfile({}),
        voiceModel: requestedModel,
        manualTurnControl: true,
        outputAudio: false,
        inputAudioTranscription: true,
        sessionMode: "group_listener"
      });
      const participants = await Promise.all(
        body.participants.map(async (participant) => {
          const character = charactersById.get(participant.characterId)!;
          const persona = jsonPayloadToRecord(character.persona);
          const baseInstructions =
            typeof persona.instructions === "string" && persona.instructions.trim()
              ? persona.instructions
              : [
                  `You are ${character.name}, speaking from inside this finished book.`,
                  `Role: ${character.role}.`,
                  `Description: ${character.description}.`,
                  "Keep responses conversational, concise, and suitable for a voice call."
                ].join("\n");
          const instructions = buildRealtimeGroupCharacterInstructions({
            baseInstructions,
            characterName: character.name,
            participantNames
          });
          const session = await provider.createRealtimeSession({
            ...("offerSdp" in participant ? { offerSdp: participant.offerSdp } : {}),
            ...("sessionHandle" in participant && participant.sessionHandle ? { sessionHandle: participant.sessionHandle } : {}),
            characterName: character.name,
            instructions,
            voiceProfile: normalizeVoiceProfile(character.voiceProfile),
            voiceModel: requestedModel,
            manualTurnControl: true,
            outputAudio: true,
            inputAudioTranscription: false,
            sessionMode: "group_character"
          });
          return { characterId: character.id, session };
        })
      );

      return {
        provider: requestedProvider,
        voiceModel: listener.model,
        listener,
        participants
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : "Voice room could not be started.";
      if (isVoiceConfigurationError(message)) {
        return reply.code(400).send({ error: message });
      }
      throw error;
    }
  });

  fastify.get("/api/projects/:id/voice-conversations", async (request, reply) => {
    const { id } = idParamsSchema.parse(request.params);
    const actor = await resolveProjectActor(request, reply);
    if (!actor) {
      return;
    }
    const project = await prisma.project.findFirst({ where: ownedProjectWhere(id, actor), select: { id: true } });
    if (!project) {
      return reply.code(404).send({ error: "Project not found" });
    }
    const conversations = await prisma.voiceConversation.findMany({
      where: { projectId: id },
      orderBy: { createdAt: "desc" },
      take: 20
    });
    return conversations.map(serializeVoiceConversation);
  });

  fastify.post("/api/projects/:id/voice-conversations", async (request, reply) => {
    const { id } = idParamsSchema.parse(request.params);
    const actor = await resolveProjectActor(request, reply);
    if (!actor) {
      return;
    }
    const parsedBody = voiceConversationBodySchema.safeParse(request.body);
    if (!parsedBody.success) {
      return reply.code(400).send({ error: "Voice conversations require a prompt and exactly 2 character IDs." });
    }
    const body = parsedBody.data;
    if (!appConfig.MOCK_AI && !appConfig.GEMINI_API_KEY?.trim()) {
      return reply.code(400).send({ error: "GEMINI_API_KEY is required for scripted voice conversations." });
    }
    if (body.characterIds && new Set(body.characterIds).size !== body.characterIds.length) {
      return reply.code(400).send({ error: "Voice conversation characters must be unique." });
    }

    const project = await prisma.project.findFirst({
      where: ownedProjectWhere(id, actor),
      select: {
        id: true,
        title: true,
        prompt: true,
        status: true,
        currentPlan: { select: { planningPackage: true } }
      }
    });
    if (!project) {
      return reply.code(404).send({ error: "Project not found" });
    }
    if (project.status !== "COMPLETE") {
      return reply.code(409).send({ error: "Voice conversations can be generated after the book is complete." });
    }

    const setup = body.continuationOfConversationId
      ? await resolveVoiceConversationContinuationSetup(id, body.continuationOfConversationId)
      : await resolveInitialVoiceConversationSetup(id, body.characterIds ?? []);
    if ("error" in setup) {
      return reply.code(setup.statusCode).send({ error: setup.error });
    }

    try {
      const transcript = appConfig.MOCK_AI
        ? makeMockVoiceConversationTranscript(setup.speakers, body.prompt, setup.previousConversations)
        : await generateGeminiVoiceConversationTranscript({
            apiKey: appConfig.GEMINI_API_KEY,
            model: appConfig.GEMINI_TEXT_MODEL,
            project: {
              title: project.title,
              prompt: project.prompt,
              plan: project.currentPlan?.planningPackage
            },
            userPrompt: body.prompt,
            speakers: setup.speakers,
            previousConversations: setup.previousConversations
          });
      const conversationSpeakers = voiceConversationSpeakersForTranscript(setup.speakers, transcript);
      const synthesis = appConfig.MOCK_AI
        ? {
            audio: mockVoiceConversationWav(),
            mimeType: "audio/wav" as const,
            provider: "gemini_tts" as const,
            model: appConfig.GEMINI_TTS_MODEL,
            durationMs: 1000,
            metadata: { mock: true }
          }
        : await synthesizeGeminiTtsConversation({
            apiKey: appConfig.GEMINI_API_KEY,
            model: appConfig.GEMINI_TTS_MODEL,
            transcript,
            speakers: conversationSpeakers
          });

      const conversationId = randomUUID();
      const filename = `${safePathPart(conversationId)}.wav`;
      const projectVoiceDir = join(appConfig.VOICE_STORAGE_DIR, id);
      await mkdir(projectVoiceDir, { recursive: true });
      await writeFile(join(projectVoiceDir, filename), synthesis.audio);
      const audioPath = publicAssetUrl(appConfig.PUBLIC_API_URL, `/assets/voice/${id}/${filename}`);
      const conversation = await prisma.voiceConversation.create({
        data: {
          id: conversationId,
          projectId: id,
          parentConversationId: setup.parentConversationId,
          rootConversationId: setup.rootConversationId ?? conversationId,
          prompt: body.prompt,
          characterSnapshots: jsonInputValue(voiceConversationCharacterSnapshots(conversationSpeakers)),
          transcript: jsonInputValue(transcript),
          provider: synthesis.provider,
          model: synthesis.model,
          audioPath,
          durationMs: synthesis.durationMs,
          metadata: jsonInputValue(synthesis.metadata)
        }
      });
      return serializeVoiceConversation(conversation);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Voice conversation could not be generated.";
      if (isVoiceConfigurationError(message) || /Gemini|transcript|speaker|audio|TTS/i.test(message)) {
        request.log.warn({ err: error, projectId: id }, "Voice conversation generation failed");
        return reply.code(400).send({ error: message });
      }
      throw error;
    }
  });

  fastify.post("/api/voice-characters/:characterId/call-events", async (request, reply) => {
    const { characterId } = voiceCharacterIdParamsSchema.parse(request.params);
    const actor = await resolveProjectActor(request, reply);
    if (!actor) {
      return;
    }
    const body = voiceCallEventBodySchema.parse(request.body);
    const character = await prisma.voiceCharacter.findFirst({
      where: ownedVoiceCharacterWhere(characterId, actor),
      select: { id: true, projectId: true }
    });
    if (!character) {
      return reply.code(404).send({ error: "Voice character not found" });
    }

    await prisma.voiceCallEvent.create({
      data: {
        projectId: character.projectId,
        characterId: character.id,
        clientCallId: sanitizeVoiceCallText(body.clientCallId, 128),
        phase: body.phase,
        attempt: body.attempt ?? null,
        elapsedMs: body.elapsedMs ?? null,
        connectionState: sanitizeVoiceCallOptionalText(body.connectionState) ?? null,
        iceConnectionState: sanitizeVoiceCallOptionalText(body.iceConnectionState) ?? null,
        iceGatheringState: sanitizeVoiceCallOptionalText(body.iceGatheringState) ?? null,
        candidatePairType: sanitizeVoiceCallOptionalText(body.candidatePairType) ?? null,
        candidateProtocol: sanitizeVoiceCallOptionalText(body.candidateProtocol) ?? null,
        currentRoundTripTimeMs: body.currentRoundTripTimeMs ?? null,
        packetsLost: body.packetsLost ?? null,
        jitterMs: body.jitterMs ?? null,
        error: sanitizeVoiceCallOptionalText(body.error) ?? null,
        metadata: sanitizeVoiceCallMetadata(body.metadata) as Prisma.InputJsonValue
      }
    });

    return reply.code(202).send({ ok: true });
  });

  fastify.get("/api/projects/:id/events", async (request, reply) => {
    const { id } = idParamsSchema.parse(request.params);
    const actor = await resolveProjectActor(request, reply);
    if (!actor) {
      return;
    }
    const project = await prisma.project.findFirst({ where: ownedProjectWhere(id, actor), select: { id: true } });
    if (!project) {
      return reply.code(404).send({ error: "Project not found" });
    }
    const origin = request.headers.origin;
    const corsHeaders = origin
      ? {
          "Access-Control-Allow-Origin": origin,
          "Access-Control-Allow-Credentials": "true",
          Vary: "Origin"
        }
      : {};

    reply.hijack();
    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      ...corsHeaders
    });

    const send = async () => {
      const status = await buildProjectStatus(id);
      if (status) {
        reply.raw.write(`event: status\ndata: ${JSON.stringify(status)}\n\n`);
      }
    };

    await send();
    const timer = setInterval(send, 1000);
    request.raw.on("close", () => {
      clearInterval(timer);
      reply.raw.end();
    });
  });

  registerProjectExportRoutes(fastify, appConfig);
};

function projectBillingSummary(
  project: {
    title: string;
    subtitle: string | null;
    authorName: string | null;
    coverTagline: string | null;
    prompt: string;
    category: string;
    subcategory: string | null;
    targetPages: number;
    complexity: number;
    temperature: number;
    language: string;
    mediaSettings: unknown;
  },
  cost: ProjectCostSummary | undefined
) {
  const input = createProjectSchema.parse({
    title: project.title,
    ...(project.subtitle ? { subtitle: project.subtitle } : {}),
    ...(project.authorName ? { authorName: project.authorName } : {}),
    ...(project.coverTagline ? { coverTagline: project.coverTagline } : {}),
    prompt: project.prompt,
    category: project.category,
    ...(project.subcategory ? { subcategory: project.subcategory } : {}),
    targetPages: project.targetPages,
    complexity: project.complexity,
    temperature: project.temperature,
    language: project.language,
    mediaSettings: mediaSettingsSchema.parse(project.mediaSettings)
  });
  const creditEstimate = estimateFullBookCreditCost(input);
  const providerEstimate = estimateProviderCostForProject(input);
  return {
    creditEstimate,
    providerEstimate,
    margin: buildMarginEstimate({
      creditEstimate,
      providerEstimate,
      actualProviderCostUsd: cost?.totalUsd ?? null
    })
  };
}

function ownedPlanWhere(planId: string, actor: ProjectActor): Prisma.PlanVersionWhereInput {
  return { id: planId, project: { userId: actor.userId } };
}

function ownedVoiceCharacterWhere(characterId: string, actor: ProjectActor): Prisma.VoiceCharacterWhereInput {
  return { id: characterId, project: { userId: actor.userId } };
}

async function sendOwnedProjectAsset(
  request: FastifyRequest,
  reply: FastifyReply,
  options: {
    projectId: string;
    filename: string;
    storageDir: string;
    missingLabel: string;
  }
) {
  const actor = await resolveProjectActor(request, reply);
  if (!actor) {
    return;
  }
  const project = await prisma.project.findFirst({
    where: ownedProjectWhere(options.projectId, actor),
    select: { id: true }
  });
  if (!project) {
    return sendProjectNotFound(reply, options.missingLabel);
  }

  const filePath = join(options.storageDir, options.projectId, options.filename);
  try {
    const file = await readFile(filePath);
    reply.type(mimeTypeForPath(filePath));
    reply.header("Cache-Control", "private, max-age=300");
    return file;
  } catch {
    return sendProjectNotFound(reply, options.missingLabel);
  }
}

function mimeTypeForPath(filePath: string): string {
  return MIME_BY_EXT[extname(filePath).toLowerCase()] ?? "application/octet-stream";
}



type ProjectStrategySource = {
  title: string;
  subtitle?: string | null;
  authorName?: string | null;
  coverTagline?: string | null;
  prompt: string;
  category: string;
  subcategory?: string | null;
  targetPages: number;
  complexity: number;
  temperature: number;
  language: string;
  mediaSettings: unknown;
};

function planInputForStrategy(inputSnapshot: unknown, project: ProjectStrategySource): CreateProjectInput {
  const fromSnapshot = createProjectSchema.safeParse(inputSnapshot);
  if (fromSnapshot.success) {
    return fromSnapshot.data;
  }
  return createProjectSchema.parse({
    title: project.title,
    subtitle: project.subtitle ?? undefined,
    authorName: project.authorName ?? undefined,
    coverTagline: project.coverTagline ?? undefined,
    prompt: project.prompt,
    category: project.category,
    subcategory: project.subcategory ?? undefined,
    targetPages: project.targetPages,
    complexity: project.complexity,
    temperature: project.temperature,
    language: project.language,
    mediaSettings: mediaSettingsSchema.parse(project.mediaSettings)
  });
}


function safePathPart(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 120) || "asset";
}

function deriveTitle(prompt: string): string {
  return prompt
    .split(/[.!?\n]/)[0]
    ?.replace(/\s+/g, " ")
    .trim()
    .slice(0, 90) || "Untitled Book";
}

function projectUpdateDataFromInput(input: CreateProjectInput, templateId: string | null) {
  const subtitle = cleanOptionalText(input.subtitle);
  const authorName = cleanOptionalText(input.authorName);
  const coverTagline = cleanOptionalText(input.coverTagline);
  const subcategory = cleanOptionalText(input.subcategory);

  return {
    title: input.title ?? deriveTitle(input.prompt),
    subtitle: subtitle ?? null,
    authorName: authorName ?? null,
    coverTagline: coverTagline ?? null,
    prompt: input.prompt,
    category: input.category,
    subcategory: subcategory ?? null,
    targetPages: input.targetPages,
    complexity: input.complexity,
    temperature: input.temperature,
    language: input.language,
    mediaSettings: mediaSettingsSchema.parse(input.mediaSettings),
    ...(templateId ? { templateId } : {})
  };
}

async function inputWithDetectedLanguage(
  input: CreateProjectInput,
  rawBody: unknown,
  appConfig: AppConfig
): Promise<CreateProjectInput> {
  const explicitLanguage = explicitLanguageFromBody(rawBody);
  if (explicitLanguage && !isEnglishLanguage(explicitLanguage)) {
    return { ...input, language: normalizeProjectLanguage(explicitLanguage) };
  }
  const fallbackLanguage = explicitLanguage ? normalizeProjectLanguage(explicitLanguage) : input.language;

  try {
    return {
      ...input,
      language: await detectPromptLanguage(createLanguageDetectionTextModel(appConfig), input.prompt)
    };
  } catch {
    return { ...input, language: fallbackLanguage };
  }
}

function explicitLanguageFromBody(rawBody: unknown): string | undefined {
  if (!rawBody || typeof rawBody !== "object" || Array.isArray(rawBody)) {
    return undefined;
  }
  const language = (rawBody as Record<string, unknown>).language;
  return typeof language === "string" && language.trim() ? language : undefined;
}

function jsonPayload(input: CreateProjectInput): Record<string, unknown> {
  return JSON.parse(JSON.stringify(input)) as Record<string, unknown>;
}

function jsonInputValue(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}

function payloadPlanId(payload: unknown): string | null {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return null;
  }

  const value = (payload as Record<string, unknown>).planId;
  return typeof value === "string" ? value : null;
}

function canRecoverGenerationJob(
  type: GenerationJobType,
  payload: unknown,
  context: ResumeContext,
  jobCreatedAt: Date
): boolean {
  const payloadRecord = jsonPayloadToRecord(payload);

  if (type === "PLAN_BOOK") {
    return !context.currentPlanCreatedAt || jobCreatedAt > context.currentPlanCreatedAt;
  }

  if (type === "REVISE_PLAN") {
    return (
      typeof payloadRecord.planId === "string" &&
      payloadRecord.planId === context.currentPlanId &&
      typeof payloadRecord.message === "string" &&
      payloadRecord.message.trim().length > 0
    );
  }

  if (!context.currentPlanId) {
    return false;
  }

  const planId = payloadPlanId(payloadRecord);
  if (planId && planId !== context.currentPlanId) {
    return false;
  }

  if (type === "GENERATE_BOOK") {
    return planId === context.currentPlanId;
  }

  if (type === "GENERATE_PAGE") {
    return isCurrentPagePayload(payloadRecord, context);
  }

  if (type === "GENERATE_IMAGE") {
    return (
      isCurrentCoverPayload(payloadRecord, context) ||
      (isCurrentPagePayload(payloadRecord, context) && typeof payloadRecord.prompt === "string")
    );
  }

  return type === "COMPILE_EXPORT" || type === "APPLY_BOOK_EDIT" || type === "REPLAN_BOOK";
}

function isPlanningRecoveryJob(type: GenerationJobType): boolean {
  return type === "PLAN_BOOK" || type === "REVISE_PLAN";
}

function recoveryPayload(
  type: GenerationJobType,
  payload: unknown,
  currentPlanId: string | null
): Record<string, unknown> {
  if (isPlanningRecoveryJob(type)) {
    return jsonPayloadToRecord(payload);
  }
  if (!currentPlanId) {
    return jsonPayloadToRecord(payload);
  }
  return payloadWithCurrentPlan(payload, currentPlanId);
}

function payloadWithCurrentPlan(payload: unknown, currentPlanId: string): Record<string, unknown> {
  return {
    ...jsonPayloadToRecord(payload),
    planId: currentPlanId
  };
}

function isCurrentPagePayload(payload: Record<string, unknown>, context: ResumeContext): boolean {
  return typeof payload.pageId === "string" && context.pageIds.has(payload.pageId);
}

function isCurrentCoverPayload(payload: Record<string, unknown>, context: ResumeContext): boolean {
  return payload.assetType === "COVER" && payloadPlanId(payload) === context.currentPlanId;
}

function cleanOptionalText(value: string | undefined): string | undefined {
  const trimmed = value?.replace(/\s+/g, " ").trim();
  return trimmed || undefined;
}

function stablePayloadHash(value: unknown): string {
  const serialized = typeof value === "string" ? value : JSON.stringify(value);
  return createHash("sha256").update(serialized).digest("hex").slice(0, 24);
}

function jsonPayloadToRecord(payload: unknown): Record<string, unknown> {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return {};
  }

  return payload as Record<string, unknown>;
}

