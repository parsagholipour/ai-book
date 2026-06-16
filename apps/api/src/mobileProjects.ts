import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import { readFile } from "node:fs/promises";
import { extname, join } from "node:path";
import {
  AUTO_BOOK_GENERATION_STRATEGY_ID,
  CREDIT_COSTS,
  DEFAULT_BILLING_PRODUCTS,
  bookPlanSchema,
  createLanguageDetectionTextModel,
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
  recordVerifiedGooglePlayPurchase,
  refundCreditLedgerEntry,
  reserveCredits,
  type CreditLedgerEntryRecord
} from "@book-maker/db/billing";
import { z } from "zod";
import { buildProjectStatus, type PipelineStep } from "./projectStatus.js";
import type { AuthFailure } from "./mobileAuth.js";
import {
  enqueueGenerationJob,
  isBullJobActive,
  requeueGenerationJob,
  type GenerationJobType
} from "./queue.js";
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
import {
  GooglePlayBillingConfigError,
  GooglePlayVerificationError,
  createGooglePlayVerifierFromConfig,
  type GooglePlayVerifier
} from "./googlePlayBilling.js";
import {
  InMemoryRateLimiter,
  rateLimitKey,
  sendRateLimitError,
  type RateLimitConfig
} from "./rateLimit.js";
import {
  adviseMobileBook,
  composeMobileProjectPrompt,
  enrichAdvisorWithAi,
  enrichCreationTurnWithAi,
  greetingCreationTurn,
  mobileBookAdvisorBodySchema,
  mobileBookAdvisorResponseSchema,
  mobileBriefMetadata,
  mobileCreationBriefSchema,
  mobileCreationDraftPayloadSchema,
  mobileCreationMessageSchema,
  mobileCreationOptionalDetailsSchema,
  mobileCreationPresetsSchema,
  runCreationTurn,
  authorForMobilePayload,
  briefForMobilePayload,
  titleForMobilePayload,
  type MobileBookAdvisorResponse,
  type MobileCreationBrief,
  type MobileCreationDraftPayload,
  type MobileCreationMessage,
  type MobileCreationTurn,
  type MobileCreationTurnRequest
} from "./mobileCreation.js";

const mobileBookTypeSchema = z.enum(["lead_magnet", "workbook", "short_story"]);
const mobileLengthPresetSchema = z.enum(["short", "standard", "expanded"]);
const mobileQualityPresetSchema = z.enum(["fast", "balanced", "premium"]);
const idParamsSchema = z.object({ id: z.string().min(1) });
const assetParamsSchema = z.object({ id: z.string().min(1), assetId: z.string().min(1) });
const mobileAssetFilenameSchema = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,180}$/);
const retryablePlanningJobTypes: GenerationJobType[] = ["PLAN_BOOK", "REVISE_PLAN"];
const resumableJobTypes: GenerationJobType[] = ["GENERATE_PAGE", "GENERATE_IMAGE", "COMPILE_EXPORT"];
const restartableJobTypes: GenerationJobType[] = ["GENERATE_BOOK"];
const generationFailureJobTypes = [...retryablePlanningJobTypes, ...resumableJobTypes, ...restartableJobTypes];
const DEFAULT_GENERATION_RATE_LIMIT = { maxAttempts: 12, windowMs: 60 * 60 * 1000 };
const DEFAULT_BILLING_VERIFICATION_RATE_LIMIT = { maxAttempts: 20, windowMs: 60 * 60 * 1000 };
const DEFAULT_ADVISOR_RATE_LIMIT = { maxAttempts: 20, windowMs: 60 * 60 * 1000 };
const DEFAULT_DRAFT_RATE_LIMIT = { maxAttempts: 120, windowMs: 60 * 60 * 1000 };
const UNTITLED_MOBILE_PROJECT_TITLE = "Untitled Book";
const MOBILE_TITLE_SOURCE_PLANNER_PENDING = "planner_pending";

export type MobileBookType = z.infer<typeof mobileBookTypeSchema>;
export type MobileLengthPreset = z.infer<typeof mobileLengthPresetSchema>;
export type MobileQualityPreset = z.infer<typeof mobileQualityPresetSchema>;
type MobileJsonValue = string | number | boolean | null | MobileJsonValue[] | { [key: string]: MobileJsonValue };

export type MobileProjectCreateRequestDto = {
  bookType: MobileBookType;
  title?: string | undefined;
  authorName?: string | undefined;
  prompt: string;
  lengthPreset?: MobileLengthPreset | undefined;
  qualityPreset?: MobileQualityPreset | undefined;
  imagesEnabled?: boolean | undefined;
  language?: string | undefined;
  creationBrief?: MobileCreationBrief | undefined;
  creationPayload?: MobileCreationDraftPayload | undefined;
  advisor?: MobileBookAdvisorResponse | undefined;
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
  coverImage: MobileProjectImageDto | null;
};

export type MobileProjectCreateResponseDto = {
  project: MobileProjectDetailDto;
};

export type MobileCreationDraftDto = {
  id: string;
  status: string;
  payload: MobileCreationDraftPayload;
  advisorSnapshot: MobileBookAdvisorResponse | null;
  createdProjectId: string | null;
  createdAt: string;
  updatedAt: string;
};

export type MobileCreationDraftResponseDto = {
  draft: MobileCreationDraftDto | null;
};

export type MobileCreationSessionDto = {
  draftId: string;
  title: string;
  status: string;
  messages: MobileCreationMessage[];
  createdProjectId: string | null;
  updatedAt: string;
};

export type MobileCreationConversationResponseDto = {
  session: MobileCreationSessionDto | null;
  turn: MobileCreationTurn;
};

export type MobileBookAdvisorResponseDto = {
  advisor: MobileBookAdvisorResponse;
};

export type MobileCreationFinalizeResponseDto = {
  project: MobileProjectDetailDto;
  operation: MobilePlanOperationDto | null;
};

type FinalizeOutcome =
  | { ok: true; project: MobileProjectDetailDto; operation: MobilePlanOperationDto | null }
  | { ok: false; status: number; code: string; message: string }
  | { ok: false; insufficient: InsufficientCreditsError };

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
  previewText: string;
  status: string;
  image: MobileProjectImageDto | null;
};

export type MobileProjectImageDto = {
  id: string;
  role: "cover" | "page_visual";
  url: string;
  contentType: string;
  altText: string;
  pageId: string | null;
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

export type MobileProjectRecoveryDto = {
  projectId: string;
  status: "recovery_started";
  currentAction: string;
  resumedActions: number;
  skippedActions: number;
  stoppingActions: number;
};

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
  [key: string]: MobileJsonValue;
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
  coverTagline: string | null;
  prompt: string;
  category: string;
  subcategory: string | null;
  targetPages: number;
  complexity: number;
  temperature: number;
  language: string;
  mediaSettings: unknown;
  status: string;
  currentPlanId: string | null;
  currentPlan?: MobilePlanRecord | null;
  pages?: MobilePageRecord[];
  images?: MobileImageRecord[];
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
  markdown: string;
  summary: string;
  status: string;
  images?: MobileImageRecord[];
};

type MobileImageRecord = {
  id: string;
  projectId: string;
  pageId: string | null;
  type: string;
  path: string;
  metadata: unknown;
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

export type MobileGooglePlayVerificationResponseDto = {
  purchase: {
    id: string;
    status: string;
    creditsGranted: number;
    subscriptionStatus: string | null;
    entitlementType: string | null;
  };
  billing: MobileBillingDto;
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
    language: z.string().trim().min(2).max(40).default("en"),
    creationBrief: mobileCreationBriefSchema.optional(),
    creationPayload: mobileCreationDraftPayloadSchema.optional(),
    advisor: mobileBookAdvisorResponseSchema.optional()
  })
  .strict();

const mobilePlanRevisionBodySchema = z
  .object({
    message: z.string().trim().min(1).max(5000)
  })
  .strict();

const mobileCreationMessageBodySchema = z
  .object({
    message: z.string().trim().min(1).max(4000),
    presets: mobileCreationPresetsSchema.optional(),
    sourceNotes: z.string().trim().max(12000).optional(),
    optionalDetails: mobileCreationOptionalDetailsSchema.optional()
  })
  .strict();

const mobileCreationSessionStartBodySchema = z
  .object({
    message: z.string().trim().min(1).max(4000).optional(),
    presets: mobileCreationPresetsSchema.optional(),
    sourceNotes: z.string().trim().max(12000).optional(),
    optionalDetails: mobileCreationOptionalDetailsSchema.optional()
  })
  .strict()
  .default({});

const mobileCreationBuildBodySchema = z
  .object({
    presets: mobileCreationPresetsSchema.optional(),
    sourceNotes: z.string().trim().max(12000).optional(),
    optionalDetails: mobileCreationOptionalDetailsSchema.optional(),
    language: z.string().trim().min(2).max(40).optional()
  })
  .strict();

const emptyMobilePlanBodySchema = z.object({}).strict().default({});
const mobileGooglePlayVerificationBodySchema = z
  .object({
    productId: z.string().trim().min(3).max(160),
    purchaseToken: z.string().trim().min(8).max(8000),
    transactionId: z.string().trim().min(1).max(240).optional(),
    purchaseStatus: z.enum(["purchased", "restored"]).optional(),
    projectId: z.string().trim().min(1).max(160).optional()
  })
  .strict();

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
    language: { type: "string", minLength: 2, maxLength: 40, default: "en" },
    creationBrief: { type: "object" },
    creationPayload: { type: "object" },
    advisor: { type: "object" }
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

export type MobileProjectRoutesOptions = {
  googlePlayVerifier?: GooglePlayVerifier | undefined;
  generationRateLimit?: Partial<RateLimitConfig>;
  billingVerificationRateLimit?: Partial<RateLimitConfig>;
  advisorRateLimit?: Partial<RateLimitConfig>;
  draftRateLimit?: Partial<RateLimitConfig>;
  advisorTimeoutMs?: number;
  advisorEnrichment?:
    | false
    | ((payload: MobileCreationDraftPayload, base: MobileBookAdvisorResponse) => Promise<Partial<MobileBookAdvisorResponse>>);
  creationTurnTimeoutMs?: number;
  creationEnrichment?:
    | false
    | ((request: MobileCreationTurnRequest, base: MobileCreationTurn) => Promise<Partial<MobileCreationTurn>>);
};

export const mobileProjectRoutes: FastifyPluginAsync<MobileProjectRoutesOptions> = async (fastify, options) => {
  await ensureSeedTemplates();
  await ensureDefaultProductCatalog();
  const appConfig = loadConfig();
  const googlePlayVerifier = options.googlePlayVerifier ?? createGooglePlayVerifierFromConfig(appConfig);
  const generationLimiter = new InMemoryRateLimiter({
    ...DEFAULT_GENERATION_RATE_LIMIT,
    ...options.generationRateLimit
  });
  const billingVerificationLimiter = new InMemoryRateLimiter({
    ...DEFAULT_BILLING_VERIFICATION_RATE_LIMIT,
    ...options.billingVerificationRateLimit
  });
  const advisorLimiter = new InMemoryRateLimiter({
    ...DEFAULT_ADVISOR_RATE_LIMIT,
    ...options.advisorRateLimit
  });
  const draftLimiter = new InMemoryRateLimiter({
    ...DEFAULT_DRAFT_RATE_LIMIT,
    ...options.draftRateLimit
  });
  const advisorEnrichment =
    options.advisorEnrichment === false
      ? undefined
      : options.advisorEnrichment ??
        ((payload: MobileCreationDraftPayload, base: MobileBookAdvisorResponse) =>
          enrichAdvisorWithAi(createLanguageDetectionTextModel(appConfig), payload, base));
  const creationEnrichment =
    options.creationEnrichment === false
      ? undefined
      : options.creationEnrichment ??
        ((request: MobileCreationTurnRequest, base: MobileCreationTurn) =>
          enrichCreationTurnWithAi(createLanguageDetectionTextModel(appConfig), request, base));

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

  fastify.post(
    "/api/mobile/billing/google-play/verify",
    {
      attachValidation: true,
      schema: {
        tags: ["mobile"],
        body: {
          type: "object",
          additionalProperties: false,
          properties: {
            productId: { type: "string", minLength: 3, maxLength: 160 },
            purchaseToken: { type: "string", minLength: 8, maxLength: 8000 },
            transactionId: { type: "string", minLength: 1, maxLength: 240 },
            purchaseStatus: { type: "string", enum: ["purchased", "restored"] },
            projectId: { type: "string", minLength: 1, maxLength: 160 }
          },
          required: ["productId", "purchaseToken"]
        },
        response: { 401: mobileAuthError }
      }
    },
    async (request, reply) => {
      const auth = await requireMobileAuth(request, reply);
      if (!auth) {
        return;
      }
      if (!hitAuthenticatedLimit(billingVerificationLimiter, request, reply, auth.user.id, "billing-verify")) {
        return;
      }
      const parsed = mobileGooglePlayVerificationBodySchema.safeParse(request.body);
      if (!parsed.success) {
        return sendMobileError(reply, 400, "VALIDATION_ERROR", "Send the Google Play product and purchase token.");
      }
      const product = await prisma.productCatalog.findUnique({
        where: { sku: parsed.data.productId },
        select: { sku: true, productType: true, active: true }
      });
      if (!product || !product.active) {
        return sendMobileError(reply, 400, "UNKNOWN_BILLING_PRODUCT", "This purchase is not available.");
      }

      try {
        const verification = await googlePlayVerifier.verifyPurchase({
          packageName: appConfig.GOOGLE_PLAY_PACKAGE_NAME ?? "",
          productId: product.sku,
          productType: product.productType,
          purchaseToken: parsed.data.purchaseToken
        });
        const purchase = await recordVerifiedGooglePlayPurchase({
          userId: auth.user.id,
          verification: {
            ...verification,
            metadata: {
              ...(verification.metadata ?? {}),
              clientTransactionId: parsed.data.transactionId ?? null,
              clientPurchaseStatus: parsed.data.purchaseStatus ?? null,
              projectId: parsed.data.projectId ?? null
            }
          }
        });
        return {
          purchase: {
            id: purchase.purchaseRecordId,
            status: purchase.status.toLowerCase(),
            creditsGranted: purchase.creditsGranted,
            subscriptionStatus: purchase.subscriptionStatus?.toLowerCase() ?? null,
            entitlementType: purchase.entitlementType
          },
          billing: await serializeMobileBilling(auth.user.id)
        } satisfies MobileGooglePlayVerificationResponseDto;
      } catch (error) {
        if (error instanceof GooglePlayBillingConfigError) {
          return sendMobileError(
            reply,
            503,
            error.code,
            "Google Play Billing is not configured on this backend yet."
          );
        }
        if (error instanceof GooglePlayVerificationError) {
          return sendMobileError(
            reply,
            502,
            error.code,
            "Google Play could not verify this purchase. Try restoring purchases in a moment."
          );
        }
        throw error;
      }
    }
  );

  fastify.get(
    "/api/mobile/creation-drafts/active",
    { schema: { tags: ["mobile"], response: { 401: mobileAuthError } } },
    async (request, reply) => {
      const auth = await requireMobileAuth(request, reply);
      if (!auth) {
        return;
      }
      const draft = await prisma.mobileCreationDraft.findFirst({
        where: { userId: auth.user.id, status: "ACTIVE" },
        orderBy: { updatedAt: "desc" }
      });
      return { draft: serializeCreationDraft(draft) } satisfies MobileCreationDraftResponseDto;
    }
  );

  fastify.post(
    "/api/mobile/creation-drafts",
    { attachValidation: true, schema: { tags: ["mobile"] } },
    async (request, reply) => {
      const auth = await requireMobileAuth(request, reply);
      if (!auth) {
        return;
      }
      if (!hitAuthenticatedLimit(draftLimiter, request, reply, auth.user.id, "creation-draft")) {
        return;
      }
      const parsed = mobileCreationDraftPayloadSchema.safeParse(request.body);
      if (!parsed.success) {
        return sendMobileError(reply, 400, "VALIDATION_ERROR", "Send a valid creation brief.");
      }
      const draft = await prisma.mobileCreationDraft.create({
        data: {
          userId: auth.user.id,
          status: "ACTIVE",
          payload: jsonInputValue(parsed.data)
        }
      });
      return reply.code(201).send({ draft: serializeCreationDraft(draft) } satisfies MobileCreationDraftResponseDto);
    }
  );

  fastify.patch(
    "/api/mobile/creation-drafts/:id",
    { attachValidation: true, schema: { tags: ["mobile"], response: { 401: mobileAuthError, 404: mobileAuthError, 409: mobileAuthError } } },
    async (request, reply) => {
      const auth = await requireMobileAuth(request, reply);
      if (!auth) {
        return;
      }
      if (!hitAuthenticatedLimit(draftLimiter, request, reply, auth.user.id, "creation-draft")) {
        return;
      }
      const { id } = idParamsSchema.parse(request.params);
      const parsed = mobileCreationDraftPayloadSchema.safeParse(request.body);
      if (!parsed.success) {
        return sendMobileError(reply, 400, "VALIDATION_ERROR", "Send a valid creation brief.");
      }
      const existing = await prisma.mobileCreationDraft.findFirst({
        where: { id, userId: auth.user.id }
      });
      if (!existing) {
        return sendMobileError(reply, 404, "DRAFT_NOT_FOUND", "Creation draft not found.");
      }
      if (existing.status !== "ACTIVE") {
        return sendMobileError(reply, 409, "DRAFT_NOT_ACTIVE", "This creation draft is no longer active.");
      }
      const draft = await prisma.mobileCreationDraft.update({
        where: { id },
        data: { payload: jsonInputValue(parsed.data) }
      });
      return { draft: serializeCreationDraft(draft) } satisfies MobileCreationDraftResponseDto;
    }
  );

  fastify.post(
    "/api/mobile/book-advisor",
    { attachValidation: true, schema: { tags: ["mobile"] } },
    async (request, reply) => {
      const auth = await requireMobileAuth(request, reply);
      if (!auth) {
        return;
      }
      if (!hitAuthenticatedLimit(advisorLimiter, request, reply, auth.user.id, "book-advisor")) {
        return;
      }
      const parsed = mobileBookAdvisorBodySchema.safeParse(request.body);
      if (!parsed.success) {
        return sendMobileError(reply, 400, "VALIDATION_ERROR", "Send a valid creation brief.");
      }
      const advisor = await adviseMobileBook(parsed.data, {
        enrich: advisorEnrichment,
        timeoutMs: options.advisorTimeoutMs
      });
      return { advisor } satisfies MobileBookAdvisorResponseDto;
    }
  );

  fastify.post(
    "/api/mobile/creation-drafts/:id/create-project",
    { attachValidation: true, schema: { tags: ["mobile"], response: { 201: {}, 401: mobileAuthError, 404: mobileAuthError, 409: mobileAuthError } } },
    async (request, reply) => {
      const auth = await requireMobileAuth(request, reply);
      if (!auth) {
        return;
      }
      if (!hitAuthenticatedLimit(generationLimiter, request, reply, auth.user.id, "creation-finalize")) {
        return;
      }
      const { id } = idParamsSchema.parse(request.params);
      return sendFinalizeOutcome(reply, await finalizeMobileCreationDraft(auth.user.id, id));
    }
  );

  fastify.get(
    "/api/mobile/creation-sessions",
    { schema: { tags: ["mobile"], response: { 401: mobileAuthError } } },
    async (request, reply) => {
      const auth = await requireMobileAuth(request, reply);
      if (!auth) {
        return;
      }
      const drafts = await prisma.mobileCreationDraft.findMany({
        where: { userId: auth.user.id },
        orderBy: { updatedAt: "desc" },
        take: 100
      });
      const sessions = drafts.flatMap((draft) => {
        const parsed = mobileCreationDraftPayloadSchema.safeParse(draft.payload);
        if (!parsed.success) return [];
        const payload = parsed.data;
        const messages = payload.messages ?? [];
        const title = _chatTitleForPayload(payload);
        const lastMsg = messages.length > 0 ? messages[messages.length - 1] : undefined;
        const preview = lastMsg ? lastMsg.content.trim().slice(0, 100) : "";
        return [{
          draftId: draft.id,
          title,
          preview,
          messageCount: messages.length,
          status: draft.status,
          createdProjectId: draft.createdProjectId,
          createdAt: draft.createdAt.toISOString(),
          updatedAt: draft.updatedAt.toISOString()
        }];
      });
      return { sessions };
    }
  );

  fastify.get(
    "/api/mobile/creation-sessions/active",
    { schema: { tags: ["mobile"], response: { 401: mobileAuthError } } },
    async (request, reply) => {
      const auth = await requireMobileAuth(request, reply);
      if (!auth) {
        return;
      }
      const draft = await prisma.mobileCreationDraft.findFirst({
        where: { userId: auth.user.id, status: "ACTIVE" },
        orderBy: { updatedAt: "desc" }
      });
      if (!draft) {
        return { session: null, turn: greetingCreationTurn() } satisfies MobileCreationConversationResponseDto;
      }
      const parsed = mobileCreationDraftPayloadSchema.safeParse(draft.payload);
      if (!parsed.success) {
        return { session: null, turn: greetingCreationTurn() } satisfies MobileCreationConversationResponseDto;
      }
      const messages = conversationMessagesFromPayload(parsed.data);
      const hasUserMessage = messages.some((message) => message.role === "user");
      const turn = hasUserMessage
        ? await runCreationTurn(turnRequestFromPayload(parsed.data, messages), {
            enrich: creationEnrichment,
            timeoutMs: options.creationTurnTimeoutMs
          })
        : greetingCreationTurn();
      return {
        session: serializeCreationSession(draft, messages),
        turn
      } satisfies MobileCreationConversationResponseDto;
    }
  );

  fastify.get(
    "/api/mobile/creation-sessions/:id",
    { schema: { tags: ["mobile"], response: { 401: mobileAuthError, 404: mobileAuthError } } },
    async (request, reply) => {
      const auth = await requireMobileAuth(request, reply);
      if (!auth) {
        return;
      }
      const { id } = idParamsSchema.parse(request.params);
      const draft = await prisma.mobileCreationDraft.findFirst({
        where: { id, userId: auth.user.id }
      });
      if (!draft) {
        return sendMobileError(reply, 404, "NOT_FOUND", "Chat session not found.");
      }
      const parsed = mobileCreationDraftPayloadSchema.safeParse(draft.payload);
      if (!parsed.success) {
        return sendMobileError(reply, 404, "NOT_FOUND", "Chat session could not be loaded.");
      }
      const messages = conversationMessagesFromPayload(parsed.data);
      const hasUserMessage = messages.some((message) => message.role === "user");
      const turn = hasUserMessage
        ? await runCreationTurn(turnRequestFromPayload(parsed.data, messages), {
            enrich: creationEnrichment,
            timeoutMs: options.creationTurnTimeoutMs
          })
        : greetingCreationTurn();
      return {
        session: serializeCreationSession(draft, messages),
        turn
      } satisfies MobileCreationConversationResponseDto;
    }
  );

  fastify.post(
    "/api/mobile/creation-sessions",
    { attachValidation: true, schema: { tags: ["mobile"], response: { 201: {}, 401: mobileAuthError } } },
    async (request, reply) => {
      const auth = await requireMobileAuth(request, reply);
      if (!auth) {
        return;
      }
      if (!hitAuthenticatedLimit(draftLimiter, request, reply, auth.user.id, "creation-session-start")) {
        return;
      }
      const parsedBody = mobileCreationSessionStartBodySchema.safeParse(request.body ?? {});
      if (!parsedBody.success) {
        return sendMobileError(reply, 400, "VALIDATION_ERROR", "Send a short message to start the chat.");
      }
      const greeting = greetingCreationTurn();
      const greetingMessages: MobileCreationMessage[] = [
        { role: "assistant" as const, content: greeting.assistantMessage }
      ];
      const firstMessage = parsedBody.data.message;
      let turn = greeting;
      let messages = greetingMessages;
      let payload: MobileCreationDraftPayload;
      if (firstMessage) {
        const nextMessages: MobileCreationMessage[] = [
          ...greetingMessages,
          { role: "user" as const, content: firstMessage }
        ].slice(-60);
        const turnRequest: MobileCreationTurnRequest = {
          messages: nextMessages,
          presets: parsedBody.data.presets,
          sourceNotes: parsedBody.data.sourceNotes,
          optionalDetails: parsedBody.data.optionalDetails
        };
        turn = await runCreationTurn(turnRequest, {
          enrich: creationEnrichment,
          timeoutMs: options.creationTurnTimeoutMs
        });
        messages = [
          ...nextMessages,
          { role: "assistant" as const, content: turn.assistantMessage }
        ].slice(-60);
        payload = mobileCreationDraftPayloadSchema.parse({
          payloadVersion: 3,
          rawIdea: userTextFromMessages(messages),
          optionalDetails: turnRequest.optionalDetails ?? { mustInclude: "", tone: "" },
          sourceNotes: turnRequest.sourceNotes ?? "",
          detectedLane: turn.brief.lane,
          recipe: turn.brief,
          selectedPresets: turn.presets,
          messages
        });
      } else {
        payload = mobileCreationDraftPayloadSchema.parse({ payloadVersion: 3, messages });
      }
      const draft = await prisma.mobileCreationDraft.create({
        data: {
          userId: auth.user.id,
          status: "ACTIVE",
          payload: jsonInputValue(payload)
        }
      });
      return reply.code(201).send({
        session: serializeCreationSession(draft, messages),
        turn
      } satisfies MobileCreationConversationResponseDto);
    }
  );

  fastify.post(
    "/api/mobile/creation-sessions/:id/messages",
    { attachValidation: true, schema: { tags: ["mobile"], response: { 401: mobileAuthError, 404: mobileAuthError, 409: mobileAuthError } } },
    async (request, reply) => {
      const auth = await requireMobileAuth(request, reply);
      if (!auth) {
        return;
      }
      if (!hitAuthenticatedLimit(advisorLimiter, request, reply, auth.user.id, "creation-session-message")) {
        return;
      }
      const { id } = idParamsSchema.parse(request.params);
      const parsedBody = mobileCreationMessageBodySchema.safeParse(request.body);
      if (!parsedBody.success) {
        return sendMobileError(reply, 400, "VALIDATION_ERROR", "Send a short message to continue the chat.");
      }
      const draft = await prisma.mobileCreationDraft.findFirst({
        where: { id, userId: auth.user.id }
      });
      if (!draft) {
        return sendMobileError(reply, 404, "SESSION_NOT_FOUND", "This book chat was not found.");
      }
      if (draft.status !== "ACTIVE") {
        return sendMobileError(reply, 409, "SESSION_NOT_ACTIVE", "This book chat has already been used to start a book.");
      }
      const parsedPayload = mobileCreationDraftPayloadSchema.safeParse(draft.payload);
      if (!parsedPayload.success) {
        return sendMobileError(reply, 400, "VALIDATION_ERROR", "This book chat needs to be restarted.");
      }

      const priorMessages = conversationMessagesFromPayload(parsedPayload.data);
      const nextMessages: MobileCreationMessage[] = [
        ...priorMessages,
        { role: "user" as const, content: parsedBody.data.message }
      ].slice(-60);
      const turnRequest: MobileCreationTurnRequest = {
        messages: nextMessages,
        brief: parsedPayload.data.recipe,
        presets: parsedBody.data.presets ?? parsedPayload.data.selectedPresets,
        sourceNotes: parsedBody.data.sourceNotes ?? parsedPayload.data.sourceNotes,
        optionalDetails: parsedBody.data.optionalDetails ?? parsedPayload.data.optionalDetails
      };
      const turn = await runCreationTurn(turnRequest, {
        enrich: creationEnrichment,
        timeoutMs: options.creationTurnTimeoutMs
      });
      const persistedMessages: MobileCreationMessage[] = [
        ...nextMessages,
        { role: "assistant" as const, content: turn.assistantMessage }
      ].slice(-60);
      const updatedPayload = mobileCreationDraftPayloadSchema.parse({
        payloadVersion: 3,
        rawIdea: userTextFromMessages(persistedMessages),
        optionalDetails: turnRequest.optionalDetails ?? { mustInclude: "", tone: "" },
        sourceNotes: turnRequest.sourceNotes ?? "",
        detectedLane: turn.brief.lane,
        recipe: turn.brief,
        selectedPresets: turn.presets,
        messages: persistedMessages
      });
      const updated = await prisma.mobileCreationDraft.update({
        where: { id },
        data: { payload: jsonInputValue(updatedPayload) }
      });
      return {
        session: serializeCreationSession(updated, persistedMessages),
        turn
      } satisfies MobileCreationConversationResponseDto;
    }
  );

  fastify.patch(
    "/api/mobile/creation-sessions/:id/title",
    { attachValidation: true, schema: { tags: ["mobile"], response: { 401: mobileAuthError, 404: mobileAuthError } } },
    async (request, reply) => {
      const auth = await requireMobileAuth(request, reply);
      if (!auth) {
        return;
      }
      const { id } = idParamsSchema.parse(request.params);
      const parsed = z.object({ title: z.string().trim().min(1).max(160) }).strict().safeParse(request.body);
      if (!parsed.success) {
        return sendMobileError(reply, 400, "VALIDATION_ERROR", "Provide a title between 1 and 160 characters.");
      }
      const draft = await prisma.mobileCreationDraft.findFirst({
        where: { id, userId: auth.user.id }
      });
      if (!draft) {
        return sendMobileError(reply, 404, "NOT_FOUND", "Chat session not found.");
      }
      const parsedPayload = mobileCreationDraftPayloadSchema.safeParse(draft.payload);
      if (!parsedPayload.success) {
        return sendMobileError(reply, 400, "VALIDATION_ERROR", "This chat session could not be updated.");
      }
      const updatedPayload = mobileCreationDraftPayloadSchema.parse({
        ...parsedPayload.data,
        optionalDetails: {
          ...parsedPayload.data.optionalDetails,
          title: parsed.data.title
        }
      });
      await prisma.mobileCreationDraft.update({
        where: { id },
        data: { payload: jsonInputValue(updatedPayload) }
      });
      return { ok: true };
    }
  );

  fastify.delete(
    "/api/mobile/creation-sessions/:id",
    { schema: { tags: ["mobile"], response: { 401: mobileAuthError, 404: mobileAuthError } } },
    async (request, reply) => {
      const auth = await requireMobileAuth(request, reply);
      if (!auth) {
        return;
      }
      const { id } = idParamsSchema.parse(request.params);
      const draft = await prisma.mobileCreationDraft.findFirst({
        where: { id, userId: auth.user.id },
        select: { id: true }
      });
      if (!draft) {
        return sendMobileError(reply, 404, "NOT_FOUND", "Chat session not found.");
      }
      await prisma.mobileCreationDraft.delete({ where: { id } });
      return { ok: true };
    }
  );

  fastify.post(
    "/api/mobile/creation-sessions/:id/build",
    { attachValidation: true, schema: { tags: ["mobile"], response: { 201: {}, 401: mobileAuthError, 404: mobileAuthError, 409: mobileAuthError } } },
    async (request, reply) => {
      const auth = await requireMobileAuth(request, reply);
      if (!auth) {
        return;
      }
      if (!hitAuthenticatedLimit(generationLimiter, request, reply, auth.user.id, "creation-session-build")) {
        return;
      }
      const { id } = idParamsSchema.parse(request.params);
      const parsedBody = mobileCreationBuildBodySchema.safeParse(request.body ?? {});
      if (!parsedBody.success) {
        return sendMobileError(reply, 400, "VALIDATION_ERROR", "These book settings are not supported.");
      }
      return sendFinalizeOutcome(
        reply,
        await finalizeMobileCreationDraft(auth.user.id, id, parsedBody.data)
      );
    }
  );

  async function finalizeMobileCreationDraft(
    userId: string,
    draftId: string,
    overrides: z.infer<typeof mobileCreationBuildBodySchema> = {}
  ): Promise<FinalizeOutcome> {
    const draft = await prisma.mobileCreationDraft.findFirst({
      where: { id: draftId, userId }
    });
    if (!draft) {
      return { ok: false, status: 404, code: "DRAFT_NOT_FOUND", message: "Creation draft not found." };
    }
    if (draft.status !== "ACTIVE") {
      return { ok: false, status: 409, code: "DRAFT_NOT_ACTIVE", message: "This creation draft has already been used." };
    }

    const parsedPayload = mobileCreationDraftPayloadSchema.safeParse(draft.payload);
    if (!parsedPayload.success) {
      return {
        ok: false,
        status: 400,
        code: "VALIDATION_ERROR",
        message: "This creation draft needs to be updated before it can create a project."
      };
    }

    const mergedPayload: MobileCreationDraftPayload = {
      ...parsedPayload.data,
      ...(overrides.presets ? { selectedPresets: overrides.presets } : {}),
      ...(overrides.sourceNotes !== undefined ? { sourceNotes: overrides.sourceNotes } : {}),
      ...(overrides.optionalDetails ? { optionalDetails: overrides.optionalDetails } : {})
    };
    const advisorFromDraft = mobileBookAdvisorResponseSchema.safeParse(draft.advisorSnapshot);
    const advisor = advisorFromDraft.success
      ? advisorFromDraft.data
      : await adviseMobileBook(mergedPayload, {
          enrich: advisorEnrichment,
          timeoutMs: options.advisorTimeoutMs
        });
    const selectedPresets = mergedPayload.selectedPresets ?? advisor.recommendation;
    const finalPayload = mobileCreationDraftPayloadSchema.parse({
      ...mergedPayload,
      selectedPresets,
      detectedLane: mergedPayload.detectedLane ?? advisor.detectedLane,
      recipe: mergedPayload.recipe ?? advisor.recipe
    });
    const finalAdvisor: MobileBookAdvisorResponse = {
      ...advisor,
      recommendation: selectedPresets,
      detectedLane: finalPayload.detectedLane ?? advisor.detectedLane,
      recipe: finalPayload.recipe ?? advisor.recipe
    };

    let project = draft.createdProjectId ? await loadMobileProjectDetail(userId, draft.createdProjectId) : null;
    if (draft.createdProjectId && !project) {
      return {
        ok: false,
        status: 409,
        code: "PROJECT_NOT_FOUND",
        message: "The project created from this draft is no longer available."
      };
    }
    if (!project) {
      const input = buildMobileCreateProjectInput({
        bookType: selectedPresets.bookType,
        lengthPreset: selectedPresets.lengthPreset,
        qualityPreset: selectedPresets.qualityPreset,
        imagesEnabled: selectedPresets.imagesEnabled,
        title: titleForMobilePayload(finalPayload, finalAdvisor),
        authorName: authorForMobilePayload(finalPayload),
        prompt: composeMobileProjectPrompt(finalPayload, finalAdvisor),
        language: overrides.language ?? "en",
        creationBrief: briefForMobilePayload(finalPayload, finalAdvisor),
        creationPayload: finalPayload,
        advisor: finalAdvisor
      });
      project = await createMobileProjectRecord(userId, input);
      await prisma.mobileCreationDraft.update({
        where: { id: draftId },
        data: {
          createdProjectId: project.id,
          advisorSnapshot: jsonInputValue(finalAdvisor)
        }
      });
    }

    let operation: MobilePlanOperationDto | null = null;
    try {
      operation =
        project.currentPlanId || project.status === "PLANNING"
          ? null
          : await queueInitialMobilePlan(userId, project.id, inputSnapshotFromProject(project));
    } catch (error) {
      if (error instanceof InsufficientCreditsError) {
        return { ok: false, insufficient: error };
      }
      throw error;
    }

    await prisma.mobileCreationDraft.update({
      where: { id: draftId },
      data: {
        status: "COMPLETED",
        advisorSnapshot: jsonInputValue(finalAdvisor),
        createdProjectId: project.id
      }
    });
    const refreshedProject = (await loadMobileProjectDetail(userId, project.id)) ?? project;
    return {
      ok: true,
      project: await serializeProjectDetail(refreshedProject, appConfig, userId),
      operation
    };
  }

  function sendFinalizeOutcome(reply: FastifyReply, outcome: FinalizeOutcome): FastifyReply {
    if (outcome.ok) {
      return reply.code(201).send({
        project: outcome.project,
        operation: outcome.operation
      } satisfies MobileCreationFinalizeResponseDto);
    }
    if ("insufficient" in outcome) {
      return sendInsufficientCredits(reply, outcome.insufficient);
    }
    return sendMobileError(reply, outcome.status, outcome.code, outcome.message);
  }

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
      if (!hitAuthenticatedLimit(generationLimiter, request, reply, auth.user.id, "create-project")) {
        return;
      }

      const parsed = mobileProjectCreateBodySchema.safeParse(request.body);
      if (!parsed.success) {
        return sendMobileError(reply, 400, "VALIDATION_ERROR", "Provide a book type, prompt, and supported mobile presets.");
      }

      const project = await createMobileProjectRecord(auth.user.id, buildMobileCreateProjectInput(parsed.data));

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
          pages: {
            orderBy: { index: "asc" },
            select: {
              id: true,
              index: true,
              title: true,
              markdown: true,
              summary: true,
              status: true,
              images: {
                select: { id: true, projectId: true, pageId: true, type: true, path: true, metadata: true },
                orderBy: { createdAt: "asc" }
              }
            }
          },
          images: { select: { id: true, projectId: true, pageId: true, type: true, path: true, metadata: true } },
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

  fastify.get(
    "/api/mobile/projects/:id/assets/:assetId",
    { schema: { tags: ["mobile"], response: { 401: mobileAuthError, 404: mobileAuthError } } },
    async (request, reply) => {
      const auth = await requireMobileAuth(request, reply);
      if (!auth) {
        return;
      }
      const { id, assetId } = assetParamsSchema.parse(request.params);
      const image = await prisma.imageAsset.findFirst({
        where: { id: assetId, projectId: id, project: { userId: auth.user.id } },
        select: { id: true, projectId: true, pageId: true, type: true, path: true, metadata: true }
      });
      if (!image) {
        return sendMobileError(reply, 404, "ASSET_NOT_FOUND", "Visual not found.");
      }
      const filename = mobileAssetFilenameFromPath(image.path, id);
      if (!filename) {
        return sendMobileError(reply, 404, "ASSET_NOT_FOUND", "Visual not found.");
      }

      try {
        const file = await readFile(join(appConfig.IMAGE_STORAGE_DIR, id, filename));
        reply.header("Cache-Control", "private, max-age=300");
        reply.type(imageContentType(image));
        return file;
      } catch {
        return sendMobileError(reply, 404, "ASSET_NOT_FOUND", "Visual not found.");
      }
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
  const mobileMetadata: MobileMediaMetadata = {
    bookType: parsed.bookType,
    lengthPreset: parsed.lengthPreset,
    qualityPreset: parsed.qualityPreset,
    imagesEnabled: parsed.imagesEnabled
  };
  if (parsed.creationBrief && parsed.advisor) {
    const legacyCreationPayload =
      parsed.creationPayload ??
      mobileCreationDraftPayloadSchema.parse({
        payloadVersion: 2,
        rawIdea: parsed.creationBrief.topic,
        optionalDetails: {
          title: parsed.creationBrief.title,
          authorName: parsed.creationBrief.authorName,
          mustInclude: parsed.creationBrief.mustInclude,
          tone: parsed.creationBrief.tone
        },
        sourceNotes: parsed.creationBrief.sourceNotes,
        selectedPresets: {
          bookType: parsed.bookType,
          lengthPreset: parsed.lengthPreset,
          qualityPreset: parsed.qualityPreset,
          imagesEnabled: parsed.imagesEnabled
        },
        brief: parsed.creationBrief
      });
    const metadata = mobileBriefMetadata(legacyCreationPayload, parsed.advisor);
    for (const [key, value] of Object.entries(metadata)) {
      mobileMetadata[key] = jsonValue(value);
    }
  } else if (parsed.creationPayload && parsed.advisor) {
    const metadata = mobileBriefMetadata(parsed.creationPayload, parsed.advisor);
    for (const [key, value] of Object.entries(metadata)) {
      mobileMetadata[key] = jsonValue(value);
    }
  } else {
    if (parsed.creationBrief) {
      mobileMetadata.brief = jsonValue(parsed.creationBrief);
    }
    if (parsed.creationPayload) {
      mobileMetadata.payloadVersion = 2;
      mobileMetadata.creationPayload = jsonValue(parsed.creationPayload);
    }
    if (parsed.advisor) {
      mobileMetadata.advisor = jsonValue(parsed.advisor);
    }
  }
  if (!parsed.title) {
    mobileMetadata.titleSource = MOBILE_TITLE_SOURCE_PLANNER_PENDING;
  }
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
    title: parsed.title ?? UNTITLED_MOBILE_PROJECT_TITLE,
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
      mobile: mobileMetadata
    }
  };
}

async function createMobileProjectRecord(userId: string, input: MobileCreateProjectInput): Promise<MobileProjectRecord> {
  const template = await prisma.template.findFirst({
    where: input.templateSlug ? { slug: input.templateSlug } : { category: input.category }
  });
  return (await prisma.project.create({
    data: {
      userId,
      title: input.title ?? UNTITLED_MOBILE_PROJECT_TITLE,
      ...(input.authorName ? { authorName: input.authorName } : {}),
      prompt: input.prompt,
      category: input.category,
      ...(input.subcategory ? { subcategory: input.subcategory } : {}),
      targetPages: input.targetPages,
      complexity: input.complexity,
      temperature: input.temperature,
      language: input.language,
      mediaSettings: jsonInputValue(input.mediaSettings),
      ...(template ? { templateId: template.id } : {})
    },
    include: mobileProjectDetailInclude()
  })) as MobileProjectRecord;
}

async function loadMobileProjectDetail(userId: string, projectId: string): Promise<MobileProjectRecord | null> {
  return (await prisma.project.findFirst({
    where: { id: projectId, userId },
    include: mobileProjectDetailInclude()
  })) as MobileProjectRecord | null;
}

function mobileProjectDetailInclude() {
  return {
    currentPlan: true,
    pages: {
      orderBy: { index: "asc" },
      select: {
        id: true,
        index: true,
        title: true,
        markdown: true,
        summary: true,
        status: true,
        images: {
          select: { id: true, projectId: true, pageId: true, type: true, path: true, metadata: true },
          orderBy: { createdAt: "asc" }
        }
      }
    },
    images: { select: { id: true, projectId: true, pageId: true, type: true, path: true, metadata: true } },
    _count: { select: { pages: true, images: true, jobs: true } }
  } as const;
}

async function queueInitialMobilePlan(
  userId: string,
  projectId: string,
  inputSnapshot: Record<string, unknown>
): Promise<MobilePlanOperationDto> {
  const planCost = creditCostForOperation("PLAN_GENERATION");
  let planReservation: CreditLedgerEntryRecord | null = null;
  let committedPlanCharge: CreditLedgerEntryRecord | null = null;
  try {
    planReservation = await reserveCredits({
      userId,
      projectId,
      operation: "PLAN_GENERATION",
      amountCredits: planCost,
      idempotencyKey: `mobile:project:${projectId}:plan`,
      description: "Mobile plan generation"
    });
    await prisma.project.update({ where: { id: projectId }, data: { status: "PLANNING" } });
    committedPlanCharge = planReservation ? await commitReservedCredits(planReservation.id) : null;
    const job = await enqueueGenerationJob({
      projectId,
      type: "PLAN_BOOK",
      payload: {
        inputSnapshot,
        ...(committedPlanCharge ? { billingLedgerEntryId: committedPlanCharge.id } : {})
      }
    });
    return planOperation("planning_queued", projectId, null, job, "Creating your book plan.");
  } catch (error) {
    const entryToRefund = committedPlanCharge ?? planReservation;
    if (entryToRefund) {
      await refundCreditLedgerEntry(entryToRefund.id, "Plan generation could not be queued.");
    }
    throw error;
  }
}

function _chatTitleForPayload(payload: MobileCreationDraftPayload): string {
  if (payload.optionalDetails?.title?.trim()) return payload.optionalDetails.title.trim();
  if (payload.recipe?.title?.trim()) return payload.recipe.title.trim();
  if (payload.brief?.topic?.trim()) return payload.brief.topic.trim();
  const firstUser = payload.messages?.find((m) => m.role === "user");
  if (firstUser?.content?.trim()) return firstUser.content.trim().slice(0, 60);
  return "New book";
}

function serializeCreationDraft(draft: {
  id: string;
  payload: unknown;
  advisorSnapshot: unknown;
  createdProjectId: string | null;
  status: string;
  createdAt: Date;
  updatedAt: Date;
} | null): MobileCreationDraftDto | null {
  if (!draft) {
    return null;
  }
  const payload = mobileCreationDraftPayloadSchema.safeParse(draft.payload);
  if (!payload.success) {
    return null;
  }
  const advisor = mobileBookAdvisorResponseSchema.safeParse(draft.advisorSnapshot);
  return {
    id: draft.id,
    status: draft.status,
    payload: payload.data,
    advisorSnapshot: advisor.success ? advisor.data : null,
    createdProjectId: draft.createdProjectId,
    createdAt: draft.createdAt.toISOString(),
    updatedAt: draft.updatedAt.toISOString()
  };
}

function serializeCreationSession(
  draft: { id: string; status: string; payload: unknown; createdProjectId: string | null; updatedAt: Date },
  messages: MobileCreationMessage[]
): MobileCreationSessionDto {
  const payload = mobileCreationDraftPayloadSchema.safeParse(draft.payload);
  return {
    draftId: draft.id,
    title: payload.success ? _chatTitleForPayload(payload.data) : "New book",
    status: draft.status,
    messages,
    createdProjectId: draft.createdProjectId,
    updatedAt: draft.updatedAt.toISOString()
  };
}

function conversationMessagesFromPayload(payload: MobileCreationDraftPayload): MobileCreationMessage[] {
  if (payload.messages && payload.messages.length > 0) {
    return payload.messages;
  }
  // Migrate an in-progress wizard draft (V2) into the chat by seeding the idea as the first message.
  const idea = payload.rawIdea.trim();
  return idea ? [{ role: "user" as const, content: idea.slice(0, 4000) }] : [];
}

function turnRequestFromPayload(
  payload: MobileCreationDraftPayload,
  messages: MobileCreationMessage[]
): MobileCreationTurnRequest {
  return {
    messages,
    brief: payload.recipe,
    presets: payload.selectedPresets,
    sourceNotes: payload.sourceNotes,
    optionalDetails: payload.optionalDetails
  };
}

function userTextFromMessages(messages: MobileCreationMessage[]): string {
  return messages
    .filter((message) => message.role === "user")
    .map((message) => message.content.trim())
    .filter(Boolean)
    .join("\n")
    .slice(0, 2000);
}

function jsonInputValue(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}

function jsonValue(value: unknown): MobileJsonValue {
  return JSON.parse(JSON.stringify(value)) as MobileJsonValue;
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

function hitAuthenticatedLimit(
  limiter: InMemoryRateLimiter,
  request: FastifyRequest,
  reply: FastifyReply,
  userId: string,
  action: string
): boolean {
  const limit = limiter.hit(rateLimitKey(request, userId, action));
  if (limit.allowed) {
    return true;
  }
  sendRateLimitError(reply, limit.retryAfterSeconds);
  return false;
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
  const coverImage = project.images?.find((image) => image.type === "COVER") ?? null;
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
      previewText: generatedPagePreview(page.markdown, page.summary),
      status: page.status.toLowerCase(),
      image: serializeImage(page.images?.[0] ?? null, "page_visual", `Visual for ${page.title}`)
    })),
    coverImage: serializeImage(coverImage, "cover", `Cover for ${project.title}`)
  };
}

function serializeImage(
  image: MobileImageRecord | null,
  role: MobileProjectImageDto["role"],
  altText: string
): MobileProjectImageDto | null {
  if (!image) {
    return null;
  }
  return {
    id: image.id,
    role,
    url: `/api/mobile/projects/${encodeURIComponent(image.projectId)}/assets/${encodeURIComponent(image.id)}`,
    contentType: imageContentType(image),
    altText,
    pageId: image.pageId
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
  const mediaSettings = mediaSettingsSchema.parse(project.mediaSettings);
  const title = hasPlannerPendingMobileTitle(mediaSettings) ? undefined : project.title;
  const input = createProjectSchema.parse({
    ...(title ? { title } : {}),
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
    mediaSettings
  });
  return JSON.parse(JSON.stringify(input)) as Record<string, unknown>;
}

function hasPlannerPendingMobileTitle(mediaSettings: unknown): boolean {
  return stringField(jsonRecord(jsonRecord(mediaSettings).mobile), "titleSource") === MOBILE_TITLE_SOURCE_PLANNER_PENDING;
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
  return clipText(value, 180);
}

function generatedPagePreview(markdown: string, summary: string): string {
  const plain = markdownPlainText(markdown);
  return clipText(plain || summary, 900);
}

function markdownPlainText(markdown: string): string {
  return markdown
    .replace(/!\[[^\]]*]\([^)]+\)/g, "")
    .replace(/\[([^\]]+)]\([^)]+\)/g, "$1")
    .replace(/[`*_>#-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function clipText(value: string, maxLength: number): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLength) {
    return normalized;
  }
  const clipped = normalized.slice(0, maxLength);
  const lastSpace = clipped.lastIndexOf(" ");
  const minBreak = Math.floor(maxLength * 0.65);
  return `${clipped.slice(0, lastSpace > minBreak ? lastSpace : maxLength).trim()}...`;
}

function imageContentType(image: { path: string; metadata: unknown }): string {
  const mimeType = stringField(jsonRecord(image.metadata), "mimeType");
  if (mimeType?.startsWith("image/")) {
    return mimeType;
  }
  return (
    {
      ".png": "image/png",
      ".jpg": "image/jpeg",
      ".jpeg": "image/jpeg",
      ".webp": "image/webp",
      ".gif": "image/gif"
    } satisfies Record<string, string>
  )[extname(image.path).toLowerCase()] ?? "application/octet-stream";
}

function mobileAssetFilenameFromPath(path: string, projectId: string): string | null {
  let pathname = path;
  try {
    pathname = new URL(path).pathname;
  } catch {
    // Relative asset paths are supported below.
  }
  const prefix = `/assets/images/${projectId}/`;
  const index = pathname.indexOf(prefix);
  if (index === -1) {
    return null;
  }
  const filename = decodeURIComponent(pathname.slice(index + prefix.length));
  return mobileAssetFilenameSchema.safeParse(filename).success ? filename : null;
}

function canRecoverGenerationJob(
  type: GenerationJobType,
  payload: unknown,
  context: { currentPlanId: string | null; currentPlanCreatedAt: Date | null; pageIds: Set<string> },
  jobCreatedAt: Date
): boolean {
  const payloadRecord = jsonRecord(payload);

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

  return type === "COMPILE_EXPORT";
}

function isPlanningRecoveryJob(type: GenerationJobType): boolean {
  return type === "PLAN_BOOK" || type === "REVISE_PLAN";
}

function recoveryPayload(
  type: GenerationJobType,
  payload: unknown,
  currentPlanId: string | null
): Record<string, unknown> {
  if (isPlanningRecoveryJob(type) || !currentPlanId) {
    return jsonRecord(payload);
  }
  return {
    ...jsonRecord(payload),
    planId: currentPlanId
  };
}

function payloadPlanId(payload: Record<string, unknown>): string | null {
  return typeof payload.planId === "string" ? payload.planId : null;
}

function isCurrentPagePayload(
  payload: Record<string, unknown>,
  context: { pageIds: Set<string> }
): boolean {
  return typeof payload.pageId === "string" && context.pageIds.has(payload.pageId);
}

function isCurrentCoverPayload(
  payload: Record<string, unknown>,
  context: { currentPlanId: string | null }
): boolean {
  return payload.assetType === "COVER" && payloadPlanId(payload) === context.currentPlanId;
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
