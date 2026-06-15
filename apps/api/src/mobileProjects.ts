import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import {
  AUTO_BOOK_GENERATION_STRATEGY_ID,
  CREDIT_COSTS,
  DEFAULT_BILLING_PRODUCTS,
  bookPlanSchema,
  createProjectSchema,
  creditCostForOperation,
  estimateFullBookCreditCost,
  loadConfig,
  mediaSettingsSchema,
  type BookPlan,
  type CreateProjectInput,
  type ToneProfile
} from "@book-maker/core";
import { ensureSeedTemplates, Prisma, prisma } from "@book-maker/db";
import {
  InsufficientCreditsError,
  commitReservedCredits,
  ensureDefaultProductCatalog,
  ensureProjectExportEntitlementOrSpend,
  getCreditBalance,
  grantProjectEntitlement,
  hasActiveProjectEntitlement,
  listActiveUserEntitlements,
  refundCreditLedgerEntry,
  reserveCredits,
  type CreditLedgerEntryRecord
} from "@book-maker/db/billing";
import { z } from "zod";
import { buildProjectStatus, type PipelineStep } from "./projectStatus.js";
import type { AuthFailure } from "./mobileAuth.js";
import { enqueueGenerationJob, type GenerationJobType } from "./queue.js";
import {
  authenticateMobileBearer,
  sendMobileAuthFailure,
  type MobileAuthContext
} from "./requestAuth.js";
import {
  projectExportAvailability,
  sendProjectEpubExport,
  sendProjectPdfExport,
  type ProjectExportFormat
} from "./routes/projects.js";

const mobileBookTypeSchema = z.enum(["lead_magnet", "workbook", "short_story"]);
const mobileLengthPresetSchema = z.enum(["short", "standard", "expanded"]);
const mobileQualityPresetSchema = z.enum(["fast", "balanced", "premium"]);
const idParamsSchema = z.object({ id: z.string().min(1) });

export type MobileBookType = z.infer<typeof mobileBookTypeSchema>;
export type MobileLengthPreset = z.infer<typeof mobileLengthPresetSchema>;
export type MobileQualityPreset = z.infer<typeof mobileQualityPresetSchema>;

export type MobileProjectCreateRequestDto = {
  bookType: MobileBookType;
  title?: string | undefined;
  authorName?: string | undefined;
  prompt: string;
  lengthPreset?: MobileLengthPreset | undefined;
  qualityPreset?: MobileQualityPreset | undefined;
  imagesEnabled?: boolean | undefined;
  language?: string | undefined;
};

export type MobileProjectSummaryDto = {
  id: string;
  title: string;
  subtitle: string | null;
  authorName: string | null;
  bookType: MobileBookType | "custom";
  lengthPreset: MobileLengthPreset | "custom";
  qualityPreset: MobileQualityPreset | "custom";
  imagesEnabled: boolean;
  status: string;
  statusLabel: string;
  progressPercent: number;
  currentAction: string;
  promptPreview: string;
  targetPages: number;
  pageCount: number;
  imageCount: number;
  hasPlan: boolean;
  exports: MobileExportSetDto;
  createdAt: string;
  updatedAt: string;
};

export type MobileProjectDetailDto = MobileProjectSummaryDto & {
  prompt: string;
  language: string;
  plan: MobilePlanDto | null;
  pages: MobileProjectPageDto[];
};

export type MobileProjectCreateResponseDto = {
  project: MobileProjectDetailDto;
};

export type MobilePlanDto = {
  id: string;
  projectId: string;
  version: number;
  status: "draft" | "approved" | "superseded";
  title: string;
  subtitle: string | null;
  premise: string;
  audience: string;
  questions: Array<{ prompt: string; options: string[]; allowCustom: boolean }>;
  chapters: Array<{ index: number; title: string; summary: string; targetPages: number }>;
  createdAt: string;
  updatedAt: string;
  approvedAt: string | null;
};

export type MobileProjectPageDto = {
  id: string;
  index: number;
  title: string;
  summary: string;
  status: string;
};

export type MobilePlanRevisionRequestDto = {
  message: string;
};

export type MobilePlanOperationDto = {
  projectId: string;
  planId: string | null;
  status: "planning_queued" | "revision_queued" | "generation_queued";
  currentAction: string;
  job: MobileQueuedJobDto;
};

export type MobilePlanRevisionResponseDto = MobilePlanOperationDto;

export type MobileQueuedJobDto = {
  id: string;
  status: "queued" | "active" | "completed" | "failed";
  currentAction: string;
};

export type MobileProjectStatusDto = {
  projectId: string;
  status: string;
  statusLabel: string;
  progressPercent: number;
  currentAction: string;
  failureMessage: string | null;
  retryAvailable: boolean;
  steps: Array<{
    key: "plan" | "write" | "visuals" | "export";
    label: string;
    status: "pending" | "active" | "done" | "failed";
    detail: string | null;
  }>;
  pageProgress: {
    completed: number;
    target: number;
  };
  imageCount: number;
  exports: MobileExportSetDto;
  updatedAt: string;
};

export type MobileExportAvailabilityDto = {
  format: ProjectExportFormat;
  available: boolean;
  unlocked: boolean;
  creditsRequired: number;
  downloadUrl: string;
  filename: string;
  contentType: string;
};

export type MobileExportSetDto = {
  pdf: MobileExportAvailabilityDto;
  epub: MobileExportAvailabilityDto;
};

type MobileMediaMetadata = {
  bookType: MobileBookType;
  lengthPreset: MobileLengthPreset;
  qualityPreset: MobileQualityPreset;
  imagesEnabled: boolean;
};

type MobileCreateProjectInput = CreateProjectInput & {
  mediaSettings: CreateProjectInput["mediaSettings"] & {
    mobile: MobileMediaMetadata;
  };
};

type MobileProjectRecord = {
  id: string;
  title: string;
  subtitle: string | null;
  authorName: string | null;
  prompt: string;
  category: string;
  subcategory: string | null;
  targetPages: number;
  language: string;
  mediaSettings: unknown;
  status: string;
  currentPlanId: string | null;
  currentPlan?: MobilePlanRecord | null;
  pages?: MobilePageRecord[];
  _count?: {
    pages?: number;
    images?: number;
    jobs?: number;
  };
  createdAt: Date;
  updatedAt: Date;
};

type MobilePlanRecord = {
  id: string;
  projectId: string;
  version: number;
  status: string;
  planningPackage: unknown;
  approvedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

type MobilePageRecord = {
  id: string;
  index: number;
  title: string;
  summary: string;
  status: string;
};

type ProjectStatusResult = NonNullable<Awaited<ReturnType<typeof buildProjectStatus>>>;

export type MobileBillingDto = {
  credits: {
    available: number;
    reserved: number;
    lifetimeGranted: number;
    lifetimeSpent: number;
  };
  entitlements: Array<{
    id: string;
    type: string;
    projectId: string | null;
    status: string;
    source: string;
    creditsCost: number;
    startsAt: string;
    expiresAt: string | null;
  }>;
  creditCosts: typeof CREDIT_COSTS;
  products: Array<{
    sku: string;
    title: string;
    description: string;
    productType: string;
    creditAmount: number;
    priceMicros: number;
    currency: string;
  }>;
};

const mobileProjectCreateBodySchema = z
  .object({
    bookType: mobileBookTypeSchema,
    title: z.string().trim().min(2).max(160).optional(),
    authorName: z.string().trim().min(1).max(120).optional(),
    prompt: z.string().trim().min(10).max(5000),
    lengthPreset: mobileLengthPresetSchema.default("standard"),
    qualityPreset: mobileQualityPresetSchema.default("balanced"),
    imagesEnabled: z.boolean().default(true),
    language: z.string().trim().min(2).max(40).default("en")
  })
  .strict();

const mobilePlanRevisionBodySchema = z
  .object({
    message: z.string().trim().min(1).max(5000)
  })
  .strict();

const emptyMobilePlanBodySchema = z.object({}).strict().default({});

const MOBILE_BOOK_TYPE_SETTINGS: Record<
  MobileBookType,
  {
    category: CreateProjectInput["category"];
    templateSlug: string;
    subcategory: string;
    coverTemplate: "business" | "minimal" | "fiction";
    toneProfile: ToneProfile;
    targetPages: Record<MobileLengthPreset, number>;
  }
> = {
  lead_magnet: {
    category: "BUSINESS",
    templateSlug: "business-career",
    subcategory: "Lead Magnet Ebook",
    coverTemplate: "business",
    toneProfile: "confident",
    targetPages: { short: 12, standard: 18, expanded: 24 }
  },
  workbook: {
    category: "EDUCATION",
    templateSlug: "education-how-to",
    subcategory: "Workbook or Study Guide",
    coverTemplate: "minimal",
    toneProfile: "neutral",
    targetPages: { short: 16, standard: 28, expanded: 40 }
  },
  short_story: {
    category: "STORY",
    templateSlug: "story-novel",
    subcategory: "Short Story",
    coverTemplate: "fiction",
    toneProfile: "narrative",
    targetPages: { short: 8, standard: 16, expanded: 24 }
  }
};

export const MOBILE_PRODUCT_PRESETS: Record<
  MobileQualityPreset,
  {
    label: string;
    complexity: number;
    temperature: number;
    finalReview: boolean;
    draftCandidates: 1 | 2;
    parallelPageGeneration?: boolean;
  }
> = {
  fast: {
    label: "Fast",
    complexity: 4,
    temperature: 0.65,
    finalReview: false,
    draftCandidates: 1,
    parallelPageGeneration: true
  },
  balanced: {
    label: "Balanced",
    complexity: 5,
    temperature: 0.65,
    finalReview: true,
    draftCandidates: 1,
    parallelPageGeneration: true
  },
  premium: {
    label: "Premium",
    complexity: 6,
    temperature: 0.55,
    finalReview: true,
    draftCandidates: 2,
    parallelPageGeneration: false
  }
};

const mobileAuthError = {
  type: "object",
  properties: {
    error: {
      type: "object",
      properties: {
        code: { type: "string" },
        message: { type: "string" }
      },
      required: ["code", "message"]
    }
  },
  required: ["error"]
} as const;

const mobileProjectCreateOpenApiBody = {
  type: "object",
  additionalProperties: false,
  properties: {
    bookType: { type: "string", enum: mobileBookTypeSchema.options },
    title: { type: "string", minLength: 2, maxLength: 160 },
    authorName: { type: "string", minLength: 1, maxLength: 120 },
    prompt: { type: "string", minLength: 10, maxLength: 5000 },
    lengthPreset: { type: "string", enum: mobileLengthPresetSchema.options, default: "standard" },
    qualityPreset: { type: "string", enum: mobileQualityPresetSchema.options, default: "balanced" },
    imagesEnabled: { type: "boolean", default: true },
    language: { type: "string", minLength: 2, maxLength: 40, default: "en" }
  },
  required: ["bookType", "prompt"]
} as const;

const mobilePlanRevisionOpenApiBody = {
  type: "object",
  additionalProperties: false,
  properties: {
    message: { type: "string", minLength: 1, maxLength: 5000 }
  },
  required: ["message"]
} as const;

export const mobileProjectRoutes: FastifyPluginAsync = async (fastify) => {
  await ensureSeedTemplates();
  await ensureDefaultProductCatalog();
  const appConfig = loadConfig();

  fastify.get(
    "/api/mobile/me",
    { schema: { tags: ["mobile"], response: { 401: mobileAuthError } } },
    async (request, reply) => {
      const auth = await requireMobileAuth(request, reply);
      if (!auth) {
        return;
      }
      return { user: auth.user };
    }
  );

  fastify.get(
    "/api/mobile/billing",
    { schema: { tags: ["mobile"], response: { 401: mobileAuthError } } },
    async (request, reply) => {
      const auth = await requireMobileAuth(request, reply);
      if (!auth) {
        return;
      }
      return { billing: await serializeMobileBilling(auth.user.id) };
    }
  );

  fastify.get(
    "/api/mobile/projects",
    { schema: { tags: ["mobile"], response: { 401: mobileAuthError } } },
    async (request, reply) => {
      const auth = await requireMobileAuth(request, reply);
      if (!auth) {
        return;
      }

      const projects = (await prisma.project.findMany({
        where: { userId: auth.user.id },
        orderBy: { updatedAt: "desc" },
        include: {
          currentPlan: true,
          _count: { select: { pages: true, images: true, jobs: true } }
        }
      })) as MobileProjectRecord[];

      return {
        projects: await Promise.all(projects.map((project) => serializeProjectSummary(project, appConfig, auth.user.id)))
      };
    }
  );

  fastify.post(
    "/api/mobile/projects",
    {
      attachValidation: true,
      schema: {
        tags: ["mobile"],
        body: mobileProjectCreateOpenApiBody
      }
    },
    async (request, reply) => {
      const auth = await requireMobileAuth(request, reply);
      if (!auth) {
        return;
      }

      const parsed = mobileProjectCreateBodySchema.safeParse(request.body);
      if (!parsed.success) {
        return sendMobileError(reply, 400, "VALIDATION_ERROR", "Provide a book type, prompt, and supported mobile presets.");
      }

      const input = buildMobileCreateProjectInput(parsed.data);
      const template = await prisma.template.findFirst({
        where: input.templateSlug ? { slug: input.templateSlug } : { category: input.category }
      });
      const project = (await prisma.project.create({
        data: {
          userId: auth.user.id,
          title: input.title ?? deriveTitle(input.prompt),
          ...(input.authorName ? { authorName: input.authorName } : {}),
          prompt: input.prompt,
          category: input.category,
          ...(input.subcategory ? { subcategory: input.subcategory } : {}),
          targetPages: input.targetPages,
          complexity: input.complexity,
          temperature: input.temperature,
          language: input.language,
          mediaSettings: input.mediaSettings as Prisma.InputJsonValue,
          ...(template ? { templateId: template.id } : {})
        },
        include: {
          currentPlan: true,
          pages: { orderBy: { index: "asc" }, select: { id: true, index: true, title: true, summary: true, status: true } },
          _count: { select: { pages: true, images: true, jobs: true } }
        }
      })) as MobileProjectRecord;

      return reply.code(201).send({ project: await serializeProjectDetail(project, appConfig, auth.user.id) } satisfies MobileProjectCreateResponseDto);
    }
  );

  fastify.get(
    "/api/mobile/projects/:id",
    { schema: { tags: ["mobile"], response: { 401: mobileAuthError, 404: mobileAuthError } } },
    async (request, reply) => {
      const auth = await requireMobileAuth(request, reply);
      if (!auth) {
        return;
      }
      const { id } = idParamsSchema.parse(request.params);
      const project = (await prisma.project.findFirst({
        where: { id, userId: auth.user.id },
        include: {
          currentPlan: true,
          pages: { orderBy: { index: "asc" }, select: { id: true, index: true, title: true, summary: true, status: true } },
          _count: { select: { pages: true, images: true, jobs: true } }
        }
      })) as MobileProjectRecord | null;
      if (!project) {
        return sendMobileError(reply, 404, "PROJECT_NOT_FOUND", "Project not found.");
      }
      return { project: await serializeProjectDetail(project, appConfig, auth.user.id) };
    }
  );

  fastify.get(
    "/api/mobile/projects/:id/status",
    { schema: { tags: ["mobile"], response: { 401: mobileAuthError, 404: mobileAuthError } } },
    async (request, reply) => {
      const auth = await requireMobileAuth(request, reply);
      if (!auth) {
        return;
      }
      const { id } = idParamsSchema.parse(request.params);
      const project = await prisma.project.findFirst({
        where: { id, userId: auth.user.id },
        select: { id: true }
      });
      if (!project) {
        return sendMobileError(reply, 404, "PROJECT_NOT_FOUND", "Project not found.");
      }
      const status = await buildProjectStatus(id);
      if (!status) {
        return sendMobileError(reply, 404, "PROJECT_NOT_FOUND", "Project not found.");
      }
      const exports = await serializeExportSet(id, status.project.title, appConfig, auth.user.id);
      return { status: serializeProjectStatus(status, exports) };
    }
  );

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

      const inputSnapshot = inputSnapshotFromProject(project);
      const planCost = creditCostForOperation("PLAN_GENERATION");
      let planReservation: CreditLedgerEntryRecord | null = null;
      try {
        planReservation = await reserveCredits({
          userId: auth.user.id,
          projectId: id,
          operation: "PLAN_GENERATION",
          amountCredits: planCost,
          idempotencyKey: `mobile:project:${id}:plan`,
          description: "Mobile plan generation"
        });
      } catch (error) {
        if (error instanceof InsufficientCreditsError) {
          return sendInsufficientCredits(reply, error);
        }
        throw error;
      }
      let committedPlanCharge: CreditLedgerEntryRecord | null = null;
      try {
        await prisma.project.update({ where: { id }, data: { status: "PLANNING" } });
        committedPlanCharge = planReservation ? await commitReservedCredits(planReservation.id) : null;
        const job = await enqueueGenerationJob({
          projectId: id,
          type: "PLAN_BOOK",
          payload: {
            inputSnapshot,
            ...(committedPlanCharge ? { billingLedgerEntryId: committedPlanCharge.id } : {})
          }
        });
        return reply.code(202).send(planOperation("planning_queued", id, null, job, "Creating your book plan."));
      } catch (error) {
        const entryToRefund = committedPlanCharge ?? planReservation;
        if (entryToRefund) {
          await refundCreditLedgerEntry(entryToRefund.id, "Plan generation could not be queued.");
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
      const { id } = idParamsSchema.parse(request.params);
      const parsed = mobilePlanRevisionBodySchema.safeParse(request.body);
      if (!parsed.success) {
        return sendMobileError(reply, 400, "VALIDATION_ERROR", "Provide a short revision request.");
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

      const job = await enqueueGenerationJob({
        projectId: plan.projectId,
        type: "REVISE_PLAN",
        payload: { planId: id, message: parsed.data.message }
      });
      return reply.code(202).send(planOperation("revision_queued", plan.projectId, id, job, "Revising your book plan."));
    }
  );

  fastify.post(
    "/api/mobile/plans/:id/approve",
    { schema: { tags: ["mobile"] } },
    async (request, reply) => {
      const auth = await requireMobileAuth(request, reply);
      if (!auth) {
        return;
      }
      const { id } = idParamsSchema.parse(request.params);
      const plan = await prisma.planVersion.findFirst({
        where: { id, project: { userId: auth.user.id } },
        include: { project: true }
      });
      if (!plan) {
        return sendMobileError(reply, 404, "PLAN_NOT_FOUND", "Plan not found.");
      }

      const generationInput = createProjectSchema.parse(inputSnapshotFromProject(plan.project));
      const creditEstimate = estimateFullBookCreditCost(generationInput);
      let reservation: CreditLedgerEntryRecord | null = null;
      let spend: CreditLedgerEntryRecord | null = null;
      try {
        reservation = await reserveCredits({
          userId: auth.user.id,
          projectId: plan.projectId,
          operation: "FULL_BOOK_GENERATION",
          amountCredits: creditEstimate.totalCredits,
          idempotencyKey: `mobile:plan:${id}:approve`,
          description: "Mobile full book generation package",
          metadata: {
            creditEstimate
          }
        });

        await prisma.$transaction([
          prisma.planVersion.updateMany({
            where: { projectId: plan.projectId, id: { not: id } },
            data: { status: "SUPERSEDED" }
          }),
          prisma.planVersion.update({
            where: { id },
            data: { status: "APPROVED", approvedAt: new Date() }
          }),
          prisma.project.update({
            where: { id: plan.projectId },
            data: { currentPlanId: id, status: "GENERATING" }
          })
        ]);

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

        const job = await enqueueGenerationJob({
          projectId: plan.projectId,
          type: "GENERATE_BOOK",
          payload: {
            planId: id,
            ...(spend ? { billingLedgerEntryId: spend.id } : {})
          }
        });
        return reply.code(202).send(planOperation("generation_queued", plan.projectId, id, job, "Starting full book generation."));
      } catch (error) {
        const entryToRefund = spend ?? reservation;
        if (entryToRefund) {
          await refundCreditLedgerEntry(entryToRefund.id, "Full generation could not be queued.");
        }
        if (error instanceof InsufficientCreditsError) {
          return sendInsufficientCredits(reply, error);
        }
        throw error;
      }
    }
  );

  fastify.get(
    "/api/mobile/projects/:id/export/pdf",
    { schema: { tags: ["mobile"], response: { 401: mobileAuthError, 404: mobileAuthError } } },
    async (request, reply) => {
      const auth = await requireMobileAuth(request, reply);
      if (!auth) {
        return;
      }
      const { id } = idParamsSchema.parse(request.params);
      const project = await prisma.project.findFirst({
        where: { id, userId: auth.user.id },
        select: { title: true, status: true, currentPlanId: true, mediaSettings: true }
      });
      if (!project) {
        return sendMobileError(reply, 404, "PROJECT_NOT_FOUND", "Project not found.");
      }
      const availability = await projectExportAvailability(appConfig, id, "pdf");
      if (!availability.available && project.status !== "COMPLETE") {
        return sendMobileError(reply, 404, "EXPORT_NOT_READY", "This export is not ready yet.");
      }
      const entitlement = await ensureExportEntitlementForDownload(reply, auth.user.id, id);
      if (!entitlement) {
        return;
      }
      return sendProjectPdfExport({ request, reply, appConfig, projectId: id, project });
    }
  );

  fastify.get(
    "/api/mobile/projects/:id/export/epub",
    { schema: { tags: ["mobile"], response: { 401: mobileAuthError, 404: mobileAuthError } } },
    async (request, reply) => {
      const auth = await requireMobileAuth(request, reply);
      if (!auth) {
        return;
      }
      const { id } = idParamsSchema.parse(request.params);
      const project = await prisma.project.findFirst({
        where: { id, userId: auth.user.id },
        select: { title: true, language: true, status: true, currentPlanId: true }
      });
      if (!project) {
        return sendMobileError(reply, 404, "PROJECT_NOT_FOUND", "Project not found.");
      }
      const availability = await projectExportAvailability(appConfig, id, "epub");
      if (!availability.available && project.status !== "COMPLETE") {
        return sendMobileError(reply, 404, "EXPORT_NOT_READY", "This export is not ready yet.");
      }
      const entitlement = await ensureExportEntitlementForDownload(reply, auth.user.id, id);
      if (!entitlement) {
        return;
      }
      return sendProjectEpubExport({ request, reply, appConfig, projectId: id, project });
    }
  );
};

export function buildMobileCreateProjectInput(input: MobileProjectCreateRequestDto): MobileCreateProjectInput {
  const parsed = mobileProjectCreateBodySchema.parse(input);
  const bookType = MOBILE_BOOK_TYPE_SETTINGS[parsed.bookType];
  const quality = MOBILE_PRODUCT_PRESETS[parsed.qualityPreset];
  const baseMediaSettings = mediaSettingsSchema.parse({
    fullIllustrations: parsed.imagesEnabled,
    illustrationCadence: parsed.imagesEnabled ? "template-driven" : "manual",
    includeCover: parsed.imagesEnabled,
    coverTemplate: bookType.coverTemplate,
    finalReview: quality.finalReview,
    lessCensored: false,
    toneProfile: bookType.toneProfile,
    generationStrategy: AUTO_BOOK_GENERATION_STRATEGY_ID,
    parallelPageGeneration: quality.parallelPageGeneration,
    draftCandidates: quality.draftCandidates
  });
  const projectInput = createProjectSchema.parse({
    ...(parsed.title ? { title: parsed.title } : {}),
    ...(parsed.authorName ? { authorName: parsed.authorName } : {}),
    prompt: parsed.prompt,
    category: bookType.category,
    subcategory: bookType.subcategory,
    templateSlug: bookType.templateSlug,
    targetPages: bookType.targetPages[parsed.lengthPreset],
    complexity: quality.complexity,
    temperature: quality.temperature,
    language: parsed.language,
    mediaSettings: baseMediaSettings
  });

  return {
    ...projectInput,
    mediaSettings: {
      ...projectInput.mediaSettings,
      mobile: {
        bookType: parsed.bookType,
        lengthPreset: parsed.lengthPreset,
        qualityPreset: parsed.qualityPreset,
        imagesEnabled: parsed.imagesEnabled
      }
    }
  };
}

async function requireMobileAuth(request: FastifyRequest, reply: FastifyReply): Promise<MobileAuthContext | null> {
  const auth = await authenticateMobileBearer(request);
  if (!auth) {
    sendMobileError(reply, 401, "AUTH_REQUIRED", "Sign in to continue.");
    return null;
  }
  if (isAuthFailure(auth)) {
    sendMobileAuthFailure(reply, auth);
    return null;
  }
  return auth;
}

function isAuthFailure(auth: MobileAuthContext | AuthFailure): auth is AuthFailure {
  return "ok" in auth && auth.ok === false;
}

function sendMobileError(reply: FastifyReply, statusCode: number, code: string, message: string): FastifyReply {
  return reply.code(statusCode).send({
    error: {
      code,
      message
    }
  });
}

function sendInsufficientCredits(reply: FastifyReply, error: InsufficientCreditsError): FastifyReply {
  return reply.code(402).send({
    error: {
      code: error.code,
      message: "You need more credits for this action.",
      requiredCredits: error.requiredCredits,
      availableCredits: error.availableCredits,
      reservedCredits: error.reservedCredits
    }
  });
}

async function ensureExportEntitlementForDownload(
  reply: FastifyReply,
  userId: string,
  projectId: string
): Promise<true | null> {
  try {
    await ensureProjectExportEntitlementOrSpend({
      userId,
      projectId,
      idempotencyKey: `mobile:project:${projectId}:export-unlock`
    });
    return true;
  } catch (error) {
    if (error instanceof InsufficientCreditsError) {
      sendInsufficientCredits(reply, error);
      return null;
    }
    throw error;
  }
}

async function serializeMobileBilling(userId: string): Promise<MobileBillingDto> {
  const [balance, entitlements] = await Promise.all([
    getCreditBalance(userId),
    listActiveUserEntitlements(userId)
  ]);
  return {
    credits: {
      available: balance.availableCredits,
      reserved: balance.reservedCredits,
      lifetimeGranted: balance.lifetimeCreditsGranted,
      lifetimeSpent: balance.lifetimeCreditsSpent
    },
    entitlements: entitlements.map((entitlement) => ({
      id: entitlement.id,
      type: entitlement.type,
      projectId: entitlement.projectId,
      status: entitlement.status,
      source: entitlement.source,
      creditsCost: entitlement.creditsCost,
      startsAt: entitlement.startsAt.toISOString(),
      expiresAt: entitlement.expiresAt?.toISOString() ?? null
    })),
    creditCosts: CREDIT_COSTS,
    products: DEFAULT_BILLING_PRODUCTS.map((product) => ({
      sku: product.sku,
      title: product.title,
      description: product.description,
      productType: product.productType,
      creditAmount: product.creditAmount,
      priceMicros: product.priceMicros,
      currency: product.currency
    }))
  };
}

async function serializeProjectSummary(
  project: MobileProjectRecord,
  appConfig: ReturnType<typeof loadConfig>,
  userId: string
): Promise<MobileProjectSummaryDto> {
  const mobile = mobileMetadataFromMediaSettings(project.mediaSettings);
  const pageCount = project._count?.pages ?? project.pages?.length ?? 0;
  const imageCount = project._count?.images ?? 0;
  const progressPercent = projectProgressPercent(project.status, pageCount, project.targetPages);

  return {
    id: project.id,
    title: project.title,
    subtitle: project.subtitle ?? null,
    authorName: project.authorName ?? null,
    bookType: mobile?.bookType ?? inferBookType(project.category, project.subcategory),
    lengthPreset: mobile?.lengthPreset ?? "custom",
    qualityPreset: mobile?.qualityPreset ?? "custom",
    imagesEnabled: mobile?.imagesEnabled ?? imagesEnabledFromMediaSettings(project.mediaSettings),
    status: normalizeProjectStatus(project.status),
    statusLabel: statusLabel(project.status),
    progressPercent,
    currentAction: currentActionForProject(project.status, progressPercent),
    promptPreview: previewText(project.prompt),
    targetPages: project.targetPages,
    pageCount,
    imageCount,
    hasPlan: Boolean(project.currentPlanId || project.currentPlan),
    exports: await serializeExportSet(project.id, project.title, appConfig, userId),
    createdAt: project.createdAt.toISOString(),
    updatedAt: project.updatedAt.toISOString()
  };
}

async function serializeProjectDetail(
  project: MobileProjectRecord,
  appConfig: ReturnType<typeof loadConfig>,
  userId: string
): Promise<MobileProjectDetailDto> {
  const summary = await serializeProjectSummary(project, appConfig, userId);
  return {
    ...summary,
    prompt: project.prompt,
    language: project.language,
    plan: project.currentPlan ? serializePlan(project.currentPlan) : null,
    pages: (project.pages ?? []).map((page) => ({
      id: page.id,
      index: page.index,
      title: page.title,
      summary: page.summary,
      status: page.status.toLowerCase()
    }))
  };
}

function serializePlan(planVersion: MobilePlanRecord): MobilePlanDto {
  const parsed = bookPlanSchema.safeParse(planVersion.planningPackage);
  const plan = parsed.success ? parsed.data : fallbackPlan(planVersion.planningPackage);
  return {
    id: planVersion.id,
    projectId: planVersion.projectId,
    version: planVersion.version,
    status: normalizePlanStatus(planVersion.status),
    title: plan.title,
    subtitle: plan.subtitle ?? null,
    premise: plan.premise,
    audience: plan.audience,
    questions: plan.questions.map((question) => ({
      prompt: question.prompt,
      options: question.options,
      allowCustom: question.allowCustom
    })),
    chapters: plan.chapters.map((chapter) => ({
      index: chapter.index,
      title: chapter.title,
      summary: chapter.summary,
      targetPages: chapter.targetPages
    })),
    createdAt: planVersion.createdAt.toISOString(),
    updatedAt: planVersion.updatedAt.toISOString(),
    approvedAt: planVersion.approvedAt?.toISOString() ?? null
  };
}

function fallbackPlan(value: unknown): BookPlan {
  const record = jsonRecord(value);
  return {
    title: stringField(record, "title") ?? "Book plan",
    premise: stringField(record, "premise") ?? "",
    audience: stringField(record, "audience") ?? "",
    writingComplexity: 5,
    voiceGuide: ["Follow the requested book voice."],
    antiAiRules: ["Avoid generic filler."],
    questions: [],
    chapters: [],
    characters: [],
    locations: [],
    continuityRules: [],
    researchQueries: [],
    researchNotes: [],
    illustrationPlan: {
      cadence: "template-driven",
      globalStyle: "",
      characterReferencePrompts: [],
      pageRules: []
    }
  };
}

async function serializeExportSet(
  projectId: string,
  title: string,
  appConfig: ReturnType<typeof loadConfig>,
  userId: string
): Promise<MobileExportSetDto> {
  const [pdf, epub, unlocked] = await Promise.all([
    projectExportAvailability(appConfig, projectId, "pdf"),
    projectExportAvailability(appConfig, projectId, "epub"),
    hasActiveProjectEntitlement({ userId, projectId, type: "EXPORT_UNLOCK" })
  ]);
  return {
    pdf: serializeExport(projectId, title, "pdf", pdf.available, unlocked),
    epub: serializeExport(projectId, title, "epub", epub.available, unlocked)
  };
}

function serializeExport(
  projectId: string,
  title: string,
  format: ProjectExportFormat,
  available: boolean,
  unlocked: boolean
): MobileExportAvailabilityDto {
  return {
    format,
    available,
    unlocked,
    creditsRequired: unlocked ? 0 : creditCostForOperation("EXPORT_UNLOCK"),
    downloadUrl: `/api/mobile/projects/${encodeURIComponent(projectId)}/export/${format}`,
    filename: `${sanitizeDownloadFilename(title)}.${format}`,
    contentType: format === "pdf" ? "application/pdf" : "application/epub+zip"
  };
}

function serializeProjectStatus(status: ProjectStatusResult, exports: MobileExportSetDto): MobileProjectStatusDto {
  const project = status.project;
  const steps = status.progress.pipeline.map(mobileStepFromPipeline);
  const failedJob = project.jobs.find((job) => job.status === "FAILED");
  const progressPercent = statusProgressPercent(status);

  return {
    projectId: project.id,
    status: normalizeProjectStatus(project.status),
    statusLabel: statusLabel(project.status),
    progressPercent,
    currentAction: currentActionFromSteps(project.status, steps, progressPercent),
    failureMessage: failedJob ? failureMessageForJob(failedJob.type as GenerationJobType, failedJob.error) : null,
    retryAvailable: status.progress.resumableFailedJobs > 0,
    steps,
    pageProgress: {
      completed: status.progress.pages.complete,
      target: status.progress.pages.target
    },
    imageCount: status.progress.images,
    exports,
    updatedAt: project.updatedAt.toISOString()
  };
}

function mobileStepFromPipeline(step: PipelineStep): MobileProjectStatusDto["steps"][number] {
  const keyByPipelineKey = {
    plan: "plan",
    pages: "write",
    images: "visuals",
    export: "export"
  } as const satisfies Record<PipelineStep["key"], MobileProjectStatusDto["steps"][number]["key"]>;
  const labelByPipelineKey = {
    plan: "Plan",
    pages: "Write",
    images: "Visuals",
    export: "Export"
  } as const satisfies Record<PipelineStep["key"], string>;

  return {
    key: keyByPipelineKey[step.key],
    label: labelByPipelineKey[step.key],
    status: step.status,
    detail: step.detail ?? null
  };
}

function statusProgressPercent(status: ProjectStatusResult): number {
  const projectStatus = status.project.status;
  if (projectStatus === "COMPLETE") {
    return 100;
  }
  if (projectStatus === "DRAFT") {
    return 0;
  }
  if (projectStatus === "PLANNING") {
    return 10;
  }
  if (projectStatus === "PLAN_READY") {
    return 20;
  }

  const pageTarget = Math.max(1, status.progress.pages.target);
  const pageRatio = Math.max(0, Math.min(1, status.progress.pages.complete / pageTarget));
  const pagesPercent = 20 + Math.round(pageRatio * 60);
  const visualsDone = status.progress.pipeline.find((step) => step.key === "images")?.status === "done";
  const exportDone = status.progress.pipeline.find((step) => step.key === "export")?.status === "done";
  return Math.max(pagesPercent, visualsDone ? 88 : 0, exportDone ? 96 : 0);
}

function projectProgressPercent(status: string, completePages: number, targetPages: number): number {
  if (status === "COMPLETE") {
    return 100;
  }
  if (status === "DRAFT") {
    return 0;
  }
  if (status === "PLANNING") {
    return 10;
  }
  if (status === "PLAN_READY") {
    return 20;
  }
  const pageRatio = Math.max(0, Math.min(1, completePages / Math.max(targetPages, 1)));
  return status === "GENERATING" ? 20 + Math.round(pageRatio * 60) : Math.round(pageRatio * 80);
}

function currentActionFromSteps(
  status: string,
  steps: MobileProjectStatusDto["steps"],
  progressPercent: number
): string {
  const activeStep = steps.find((step) => step.status === "active");
  if (activeStep?.key === "plan") {
    return "Creating your book plan.";
  }
  if (activeStep?.key === "write") {
    return "Writing your book pages.";
  }
  if (activeStep?.key === "visuals") {
    return "Creating visuals.";
  }
  if (activeStep?.key === "export") {
    return "Preparing downloads.";
  }
  return currentActionForProject(status, progressPercent);
}

function currentActionForProject(status: string, progressPercent: number): string {
  switch (status) {
    case "DRAFT":
      return "Ready to create a book plan.";
    case "PLANNING":
      return "Creating your book plan.";
    case "PLAN_READY":
      return "Ready for review.";
    case "GENERATING":
      return progressPercent >= 90 ? "Preparing downloads." : "Writing your book.";
    case "COMPLETE":
      return "Ready to download.";
    case "FAILED":
      return "Needs attention.";
    default:
      return "Working on your book.";
  }
}

function statusLabel(status: string): string {
  switch (status) {
    case "DRAFT":
      return "Draft saved";
    case "PLANNING":
      return "Building your outline";
    case "PLAN_READY":
      return "Review your book plan";
    case "GENERATING":
      return "Generating your book";
    case "COMPLETE":
      return "Ready to export";
    case "FAILED":
      return "Needs attention";
    default:
      return "Working";
  }
}

function failureMessageForJob(type: GenerationJobType, rawError: string | null): string {
  const phase = {
    PLAN_BOOK: "creating your plan",
    REVISE_PLAN: "revising your plan",
    GENERATE_BOOK: "starting book generation",
    GENERATE_PAGE: "writing a page",
    GENERATE_IMAGE: "creating a visual",
    COMPILE_EXPORT: "preparing downloads",
    PREPARE_CHARACTER_CANDIDATES: "preparing voice characters",
    BUILD_CHARACTER_PERSONA: "building a voice character",
    RESEARCH: "checking research"
  } satisfies Record<GenerationJobType, string>;
  const detail = rawError?.replace(/\s+/g, " ").trim();
  return detail ? `We hit a problem while ${phase[type]}: ${detail.slice(0, 240)}` : `We hit a problem while ${phase[type]}.`;
}

function planOperation(
  status: MobilePlanOperationDto["status"],
  projectId: string,
  planId: string | null,
  job: { id: string; status: string },
  currentAction: string
): MobilePlanOperationDto {
  return {
    projectId,
    planId,
    status,
    currentAction,
    job: {
      id: job.id,
      status: normalizeJobStatus(job.status),
      currentAction
    }
  };
}

function inputSnapshotFromProject(project: {
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
}): Record<string, unknown> {
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
  return JSON.parse(JSON.stringify(input)) as Record<string, unknown>;
}

function mobileMetadataFromMediaSettings(mediaSettings: unknown): MobileMediaMetadata | null {
  const metadata = jsonRecord(jsonRecord(mediaSettings).mobile);
  const bookType = mobileBookTypeSchema.safeParse(metadata.bookType);
  const lengthPreset = mobileLengthPresetSchema.safeParse(metadata.lengthPreset);
  const qualityPreset = mobileQualityPresetSchema.safeParse(metadata.qualityPreset);
  if (!bookType.success || !lengthPreset.success || !qualityPreset.success || typeof metadata.imagesEnabled !== "boolean") {
    return null;
  }
  return {
    bookType: bookType.data,
    lengthPreset: lengthPreset.data,
    qualityPreset: qualityPreset.data,
    imagesEnabled: metadata.imagesEnabled
  };
}

function inferBookType(category: string, subcategory: string | null): MobileProjectSummaryDto["bookType"] {
  if (subcategory === "Lead Magnet Ebook" || category === "BUSINESS" || category === "SELF_HELP") {
    return "lead_magnet";
  }
  if (subcategory === "Workbook or Study Guide" || category === "EDUCATION") {
    return "workbook";
  }
  if (subcategory === "Short Story" || category === "STORY") {
    return "short_story";
  }
  return "custom";
}

function imagesEnabledFromMediaSettings(mediaSettings: unknown): boolean {
  const parsed = mediaSettingsSchema.safeParse(mediaSettings);
  return parsed.success ? parsed.data.fullIllustrations || parsed.data.includeCover : true;
}

function normalizeProjectStatus(status: string): string {
  return status.toLowerCase();
}

function normalizePlanStatus(status: string): MobilePlanDto["status"] {
  if (status === "APPROVED") {
    return "approved";
  }
  if (status === "SUPERSEDED") {
    return "superseded";
  }
  return "draft";
}

function normalizeJobStatus(status: string): MobileQueuedJobDto["status"] {
  if (status === "ACTIVE") {
    return "active";
  }
  if (status === "COMPLETED") {
    return "completed";
  }
  if (status === "FAILED") {
    return "failed";
  }
  return "queued";
}

function previewText(value: string): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= 180) {
    return normalized;
  }
  const clipped = normalized.slice(0, 180);
  const lastSpace = clipped.lastIndexOf(" ");
  return `${clipped.slice(0, lastSpace > 120 ? lastSpace : 180).trim()}...`;
}

function deriveTitle(prompt: string): string {
  return prompt
    .split(/[.!?\n]/)[0]
    ?.replace(/\s+/g, " ")
    .trim()
    .slice(0, 90) || "Untitled Book";
}

function sanitizeDownloadFilename(title: string): string {
  const clean = title
    .trim()
    .replace(/[^\w\s-]+/g, "")
    .replace(/\s+/g, "-")
    .slice(0, 80);
  return clean || "book";
}

function stringField(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function jsonRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}
