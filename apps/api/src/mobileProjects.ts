import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { extname, join } from "node:path";
import {
  AUTO_BOOK_GENERATION_STRATEGY_ID,
  CREDIT_COSTS,
  DEFAULT_BILLING_PRODUCTS,
  bookPlanSchema,
  createFastRoutingTextModel,
  createLanguageDetectionTextModel,
  createProjectSchema,
  creditCostForOperation,
  estimateFullBookCreditCost,
  generateJsonWithRetry,
  loadConfig,
  mediaSettingsSchema,
  type BookPlan,
  type CreateProjectInput,
  type ModelTier,
  type TextModelAdapter,
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
  explicitTargetPagesForMobilePayload,
  greetingCreationTurn,
  mobileBookAdvisorBodySchema,
  mobileBookAdvisorResponseSchema,
  mobileBookTypeChoiceSchema,
  mobileBriefMetadata,
  mobileCreationBriefSchema,
  mobileCreationDraftPayloadSchema,
  mobileCreationMessageSchema,
  mobileCreationOptionalDetailsSchema,
  mobilePageCountModeSchema,
  mobilePageCountSourceSchema,
  mobileCreationPresetsSchema,
  mobileTargetPagesSchema,
  runCreationTurn,
  authorForMobilePayload,
  briefForMobilePayload,
  titleForMobilePayload,
  type MobileBookAdvisorResponse,
  type MobileBookTypeChoice,
  type MobileCreationBrief,
  type MobileCreationDraftPayload,
  type MobileCreationMessage,
  type MobilePageCountMode,
  type MobilePageCountSource,
  type MobileCreationTurn,
  type MobileCreationTurnRequest
} from "./mobileCreation.js";
import {
  bookEditScopeFromMessage,
  classifyProjectChatMessage,
  isBookEditScopeOnlyMessage,
  messageWithScope,
  quotedTexts,
  replacementTermsFromMessage,
  type BookEditChapterContext,
  type BookEditIntent,
  type BookEditIntentKind,
  type BookEditPageContext,
  type BookEditProjectStage,
  type BookEditScope
} from "./bookEditIntent.js";

const mobileBookTypeSchema = z.enum(["lead_magnet", "workbook", "short_story"]);
const mobileLengthPresetSchema = z.enum(["short", "standard", "expanded"]);
const mobileQualityPresetSchema = z.enum(["fast", "balanced", "premium"]);
const idParamsSchema = z.object({ id: z.string().min(1) });
const assetParamsSchema = z.object({ id: z.string().min(1), assetId: z.string().min(1) });
const mobileAssetFilenameSchema = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,180}$/);
const retryablePlanningJobTypes: GenerationJobType[] = ["PLAN_BOOK", "REVISE_PLAN"];
const resumableJobTypes: GenerationJobType[] = ["GENERATE_PAGE", "GENERATE_IMAGE", "COMPILE_EXPORT", "APPLY_BOOK_EDIT"];
const restartableJobTypes: GenerationJobType[] = ["GENERATE_BOOK", "REPLAN_BOOK"];
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
  bookTypeChoice?: MobileBookTypeChoice | undefined;
  title?: string | undefined;
  authorName?: string | undefined;
  prompt: string;
  lengthPreset?: MobileLengthPreset | undefined;
  qualityPreset?: MobileQualityPreset | undefined;
  imagesEnabled?: boolean | undefined;
  pageCountMode?: MobilePageCountMode | undefined;
  targetPages?: number | undefined;
  pageCountSource?: MobilePageCountSource | undefined;
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
  activeProjectId: string | null;
  outputs: MobileCreationOutputDto[];
  updatedAt: string;
};

export type MobileCreationOutputDto = {
  id: string;
  draftId: string;
  projectId: string;
  title: string;
  sequence: number;
  createdAt: string;
  updatedAt: string;
};

export type MobileCreationConversationResponseDto = {
  session: MobileCreationSessionDto | null;
  turn: MobileCreationTurn;
};

export type MobileBookAdvisorResponseDto = {
  advisor: MobileBookAdvisorResponse;
};

export type MobilePageCountRecommendationDto = {
  targetPages: number;
  label: string;
  description: string;
};

export type MobileCreationBuildPreflightResponseDto = {
  requiresPageCount: boolean;
  detectedPageCount: { targetPages: number; source: MobilePageCountSource } | null;
  recommendations: MobilePageCountRecommendationDto[];
};

export type MobileCreationFinalizeResponseDto = {
  project: MobileProjectDetailDto;
  output: MobileCreationOutputDto;
  operation: MobilePlanOperationDto | null;
};

type FinalizeOutcome =
  | { ok: true; project: MobileProjectDetailDto; output: MobileCreationOutputDto; operation: MobilePlanOperationDto | null }
  | { ok: false; status: number; code: string; message: string }
  | { ok: false; insufficient: InsufficientCreditsError };

type MobilePageCountResolution =
  | { resolved: true; targetPages: number; source: MobilePageCountSource; mode: MobilePageCountMode }
  | { resolved: false };

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

export type MobileProjectChatMessageDto = {
  id: string;
  projectId: string;
  parentId: string | null;
  role: "user" | "assistant" | "system";
  content: string;
  operationId: string | null;
  metadata: MobileJsonValue;
  branch: MobileProjectChatBranchDto | null;
  createdAt: string;
};

export type MobileProjectChatBranchDto = {
  index: number;
  total: number;
  canGoPrevious: boolean;
  canGoNext: boolean;
};

export type MobileBookEditOperationDto = {
  id: string;
  projectId: string;
  kind: "plan_revision" | "local_patch" | "page_rewrite" | "chapter_regenerate" | "book_replan";
  status: "queued" | "active" | "applied" | "failed" | "canceled";
  affectedPageIndexes: number[];
  creditsCharged: number;
  currentAction: string;
  error: string | null;
  job: MobileQueuedJobDto | null;
  createdAt: string;
  appliedAt: string | null;
};

export type MobileProjectChatResponseDto = {
  messages: MobileProjectChatMessageDto[];
  plans: MobilePlanDto[];
  operations: MobileBookEditOperationDto[];
};

export type MobileProjectChatMessageResponseDto = MobileProjectChatResponseDto & {
  reply: MobileProjectChatMessageDto;
  operation: MobileBookEditOperationDto | null;
};

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
  bookType: MobileBookType | "custom";
  bookTypeChoice: MobileBookTypeChoice;
  lengthPreset: MobileLengthPreset | "custom";
  qualityPreset: MobileQualityPreset;
  imagesEnabled: boolean;
  pageCountMode: MobilePageCountMode;
  targetPages: number;
  pageCountSource: MobilePageCountSource;
};

type MobileCreateProjectInput = CreateProjectInput & {
  mediaSettings: CreateProjectInput["mediaSettings"] & {
    mobile: MobileMediaMetadata;
  };
};

type MobileProjectRecord = {
  id: string;
  userId?: string;
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
  templateId?: string | null;
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

type MobileCreationOutputRecord = {
  id: string;
  draftId: string;
  projectId: string;
  title: string;
  sequence: number;
  createdAt: Date;
  updatedAt: Date;
  project?: { title: string; updatedAt?: Date } | null;
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

type MobileProjectChatMessageRecord = {
  id: string;
  projectId: string;
  parentId?: string | null;
  role: string;
  content: string;
  operationId: string | null;
  metadata: unknown;
  isActiveChild?: boolean;
  createdAt: Date;
};

type MobileBookEditOperationRecord = {
  id: string;
  projectId: string;
  userMessageId?: string | null;
  assistantMessageId?: string | null;
  kind: string;
  status: string;
  affectedPageIndexes: number[];
  creditsCharged: number;
  error?: string | null;
  generationJob?: { id: string; status: string } | null;
  createdAt: Date;
  appliedAt: Date | null;
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
    bookTypeChoice: mobileBookTypeChoiceSchema.optional(),
    title: z.string().trim().min(2).max(160).optional(),
    authorName: z.string().trim().min(1).max(120).optional(),
    prompt: z.string().trim().min(10).max(5000),
    lengthPreset: mobileLengthPresetSchema.default("standard"),
    qualityPreset: mobileQualityPresetSchema.default("balanced"),
    imagesEnabled: z.boolean().default(true),
    pageCountMode: mobilePageCountModeSchema.default("auto"),
    targetPages: mobileTargetPagesSchema.optional(),
    pageCountSource: mobilePageCountSourceSchema.optional(),
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

const mobileProjectChatMessageBodySchema = z
  .object({
    message: z.string().trim().min(1).max(5000),
    editMessageId: z.string().trim().min(1).max(128).optional()
  })
  .strict();

const mobileProjectChatBranchBodySchema = z
  .object({
    messageId: z.string().trim().min(1).max(128),
    direction: z.enum(["previous", "next"])
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

const mobilePageCountRecommendationSchema = z
  .object({
    targetPages: mobileTargetPagesSchema,
    label: z.string().trim().min(1).max(80),
    description: z.string().trim().min(1).max(180)
  })
  .strict();

const mobilePageCountRecommendationAiSchema = z
  .object({
    recommendations: z.array(mobilePageCountRecommendationSchema).min(2).max(4)
  })
  .strict();

type MobileCreationBuildOverrides = z.infer<typeof mobileCreationBuildBodySchema>;

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
    coverTemplate: "auto" | "business" | "minimal" | "fiction";
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

const MOBILE_AUTO_BOOK_TYPE_SETTINGS = {
  category: "CUSTOM",
  templateSlug: "general-book",
  subcategory: "Auto",
  coverTemplate: "auto",
  toneProfile: "neutral",
  targetPages: { short: 12, standard: 18, expanded: 24 }
} as const satisfies {
  category: CreateProjectInput["category"];
  templateSlug: string;
  subcategory: string;
  coverTemplate: "auto";
  toneProfile: ToneProfile;
  targetPages: Record<MobileLengthPreset, number>;
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
    modelTier: ModelTier;
  }
> = {
  fast: {
    label: "Fast",
    complexity: 4,
    temperature: 0.65,
    finalReview: false,
    draftCandidates: 1,
    parallelPageGeneration: true,
    modelTier: "fast"
  },
  balanced: {
    label: "Balanced",
    complexity: 5,
    temperature: 0.65,
    finalReview: true,
    draftCandidates: 1,
    parallelPageGeneration: true,
    modelTier: "balanced"
  },
  premium: {
    label: "Premium",
    complexity: 6,
    temperature: 0.55,
    finalReview: true,
    draftCandidates: 2,
    parallelPageGeneration: false,
    modelTier: "premium"
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
    bookTypeChoice: { type: "string", enum: mobileBookTypeChoiceSchema.options },
    title: { type: "string", minLength: 2, maxLength: 160 },
    authorName: { type: "string", minLength: 1, maxLength: 120 },
    prompt: { type: "string", minLength: 10, maxLength: 5000 },
    lengthPreset: { type: "string", enum: mobileLengthPresetSchema.options, default: "standard" },
    qualityPreset: { type: "string", enum: mobileQualityPresetSchema.options, default: "balanced" },
    imagesEnabled: { type: "boolean", default: true },
    pageCountMode: { type: "string", enum: mobilePageCountModeSchema.options, default: "auto" },
    targetPages: { type: "integer", minimum: 1, maximum: 600 },
    pageCountSource: { type: "string", enum: mobilePageCountSourceSchema.options },
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

const mobileProjectChatMessageOpenApiBody = {
  type: "object",
  additionalProperties: false,
  properties: {
    message: { type: "string", minLength: 1, maxLength: 5000 },
    editMessageId: { type: "string", minLength: 1, maxLength: 128 }
  },
  required: ["message"]
} as const;

const mobileProjectChatBranchOpenApiBody = {
  type: "object",
  additionalProperties: false,
  properties: {
    messageId: { type: "string", minLength: 1, maxLength: 128 },
    direction: { type: "string", enum: ["previous", "next"] }
  },
  required: ["messageId", "direction"]
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
  pageCountRecommendationTimeoutMs?: number;
};

export const mobileProjectRoutes: FastifyPluginAsync<MobileProjectRoutesOptions> = async (fastify, options) => {
  await ensureSeedTemplates();
  await ensureDefaultProductCatalog();
  const appConfig = loadConfig();
  const safeFastRoutingTextModel = (): TextModelAdapter | undefined => {
    try {
      return createFastRoutingTextModel(appConfig);
    } catch {
      return undefined;
    }
  };
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
        take: 100,
        include: mobileCreationDraftOutputsInclude()
      });
      const sessions = drafts.flatMap((draft) => {
        const parsed = mobileCreationDraftPayloadSchema.safeParse(draft.payload);
        if (!parsed.success) return [];
        const payload = parsed.data;
        const messages = payload.messages ?? [];
        const title = _chatTitleForPayload(payload);
        const lastMsg = messages.length > 0 ? messages[messages.length - 1] : undefined;
        const preview = lastMsg ? lastMsg.content.trim().slice(0, 100) : "";
        const outputs = creationOutputsForDraft(draft, payload);
        return [{
          draftId: draft.id,
          title,
          preview,
          messageCount: messages.length,
          status: draft.status,
          createdProjectId: draft.createdProjectId,
          activeProjectId: activeProjectIdForDraft(draft, outputs),
          outputs,
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
        orderBy: { updatedAt: "desc" },
        include: mobileCreationDraftOutputsInclude()
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
        where: { id, userId: auth.user.id },
        include: mobileCreationDraftOutputsInclude()
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
          ...(turn.language ? { language: turn.language } : {}),
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
        where: { id, userId: auth.user.id },
        include: mobileCreationDraftOutputsInclude()
      });
      if (!draft) {
        return sendMobileError(reply, 404, "SESSION_NOT_FOUND", "This book chat was not found.");
      }
      const parsedPayload = mobileCreationDraftPayloadSchema.safeParse(draft.payload);
      if (!parsedPayload.success) {
        return sendMobileError(reply, 400, "VALIDATION_ERROR", "This book chat needs to be restarted.");
      }

      const priorMessages = conversationMessagesFromPayload(parsedPayload.data);
      const incoming = foldCreationTranscript(
        [...priorMessages, { role: "user" as const, content: parsedBody.data.message }],
        parsedPayload.data.conversationSummary
      );
      const turnRequest: MobileCreationTurnRequest = {
        messages: incoming.messages,
        brief: parsedPayload.data.recipe,
        presets: parsedBody.data.presets ?? persistedPresetsForTurn(parsedPayload.data),
        sourceNotes: parsedBody.data.sourceNotes ?? parsedPayload.data.sourceNotes,
        optionalDetails: parsedBody.data.optionalDetails ?? parsedPayload.data.optionalDetails,
        language: parsedPayload.data.language,
        conversationSummary: incoming.conversationSummary
      };
      const turn = await runCreationTurn(turnRequest, {
        enrich: creationEnrichment,
        timeoutMs: options.creationTurnTimeoutMs
      });
      const persisted = foldCreationTranscript(
        [...incoming.messages, { role: "assistant" as const, content: turn.assistantMessage }],
        incoming.conversationSummary
      );
      const language = turn.language ?? parsedPayload.data.language;
      const updatedPayload = mobileCreationDraftPayloadSchema.parse({
        payloadVersion: 3,
        rawIdea: userTextFromMessages(persisted.messages),
        optionalDetails: turnRequest.optionalDetails ?? { mustInclude: "", tone: "" },
        sourceNotes: turnRequest.sourceNotes ?? "",
        detectedLane: turn.brief.lane,
        recipe: turn.brief,
        selectedPresets: turn.presets,
        ...(language ? { language } : {}),
        ...(persisted.conversationSummary ? { conversationSummary: persisted.conversationSummary } : {}),
        messages: persisted.messages
      });
      const updated = await prisma.mobileCreationDraft.update({
        where: { id },
        data: { payload: jsonInputValue(updatedPayload), status: "ACTIVE" }
      });
      return {
        session: serializeCreationSession({ ...updated, outputs: draft.outputs }, persisted.messages),
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
    "/api/mobile/creation-sessions/:id/preflight",
    { attachValidation: true, schema: { tags: ["mobile"], response: { 401: mobileAuthError, 404: mobileAuthError, 409: mobileAuthError } } },
    async (request, reply) => {
      const auth = await requireMobileAuth(request, reply);
      if (!auth) {
        return;
      }
      if (!hitAuthenticatedLimit(advisorLimiter, request, reply, auth.user.id, "creation-session-preflight")) {
        return;
      }
      const { id } = idParamsSchema.parse(request.params);
      const parsedBody = mobileCreationBuildBodySchema.safeParse(request.body ?? {});
      if (!parsedBody.success) {
        return sendMobileError(reply, 400, "VALIDATION_ERROR", "These book settings are not supported.");
      }
      const prepared = await prepareMobileCreationBuild(auth.user.id, id, parsedBody.data);
      if (!prepared.ok) {
        return sendMobileError(reply, prepared.status, prepared.code, prepared.message);
      }
      const recommendations = await pageCountRecommendationsForPreflight(prepared.finalPayload, prepared.finalAdvisor);
      return {
        requiresPageCount: !prepared.pageCount.resolved,
        detectedPageCount: prepared.pageCount.resolved
          ? { targetPages: prepared.pageCount.targetPages, source: prepared.pageCount.source }
          : null,
        recommendations
      } satisfies MobileCreationBuildPreflightResponseDto;
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
        await finalizeMobileCreationDraft(auth.user.id, id, parsedBody.data, { requireResolvedPageCount: true })
      );
    }
  );

  async function prepareMobileCreationBuild(
    userId: string,
    draftId: string,
    overrides: MobileCreationBuildOverrides = {}
  ) {
    const draft = await prisma.mobileCreationDraft.findFirst({
      where: { id: draftId, userId },
      include: mobileCreationDraftOutputsInclude()
    });
    if (!draft) {
      return { ok: false as const, status: 404, code: "DRAFT_NOT_FOUND", message: "Creation draft not found." };
    }
    if (draft.status !== "ACTIVE" && draft.status !== "COMPLETED") {
      return { ok: false as const, status: 409, code: "DRAFT_NOT_ACTIVE", message: "This creation draft is not available for building." };
    }

    const parsedPayload = mobileCreationDraftPayloadSchema.safeParse(draft.payload);
    if (!parsedPayload.success) {
      return {
        ok: false as const,
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
    const unresolvedAuto = selectedPresets.bookTypeChoice === "auto";
    const effectiveAdvisor = unresolvedAuto && advisor.detectedLane !== "auto"
      ? await adviseMobileBook(
          mobileCreationDraftPayloadSchema.parse({
            ...mergedPayload,
            selectedPresets: { ...selectedPresets, bookTypeChoice: "auto" },
            detectedLane: "auto",
            recipe: undefined
          }),
          { enrich: advisorEnrichment, timeoutMs: options.advisorTimeoutMs }
        )
      : advisor;
    const finalPayload = mobileCreationDraftPayloadSchema.parse({
      ...mergedPayload,
      selectedPresets,
      detectedLane: unresolvedAuto ? effectiveAdvisor.detectedLane : mergedPayload.detectedLane ?? effectiveAdvisor.detectedLane,
      recipe: unresolvedAuto ? effectiveAdvisor.recipe : mergedPayload.recipe ?? effectiveAdvisor.recipe
    });
    const finalAdvisor: MobileBookAdvisorResponse = {
      ...effectiveAdvisor,
      recommendation: selectedPresets,
      detectedLane: finalPayload.detectedLane ?? effectiveAdvisor.detectedLane,
      recipe: finalPayload.recipe ?? effectiveAdvisor.recipe
    };
    return {
      ok: true as const,
      draft,
      selectedPresets,
      finalPayload,
      finalAdvisor,
      pageCount: resolveMobilePageCount(finalPayload, selectedPresets)
    };
  }

  async function finalizeMobileCreationDraft(
    userId: string,
    draftId: string,
    overrides: MobileCreationBuildOverrides = {},
    options: { requireResolvedPageCount?: boolean } = {}
  ): Promise<FinalizeOutcome> {
    const prepared = await prepareMobileCreationBuild(userId, draftId, overrides);
    if (!prepared.ok) {
      return prepared;
    }
    if (options.requireResolvedPageCount && !prepared.pageCount.resolved) {
      return { ok: false, status: 409, code: "PAGE_COUNT_REQUIRED", message: "Choose how many pages this book should be before building the plan." };
    }

    const { draft } = prepared;
    const selectedPresets = presetsWithResolvedPageCount(prepared.selectedPresets, prepared.pageCount);
    const finalPayload = mobileCreationDraftPayloadSchema.parse({
      ...prepared.finalPayload,
      selectedPresets
    });
    const finalAdvisor: MobileBookAdvisorResponse = {
      ...prepared.finalAdvisor,
      recommendation: selectedPresets
    };

    const input = buildMobileCreateProjectInput({
      bookType: selectedPresets.bookType,
      bookTypeChoice: selectedPresets.bookTypeChoice,
      lengthPreset: selectedPresets.lengthPreset,
      qualityPreset: selectedPresets.qualityPreset,
      imagesEnabled: selectedPresets.imagesEnabled,
      pageCountMode: selectedPresets.pageCountMode,
      targetPages: selectedPresets.targetPages,
      pageCountSource: selectedPresets.pageCountSource,
      title: titleForMobilePayload(finalPayload, finalAdvisor),
      authorName: authorForMobilePayload(finalPayload),
      prompt: composeMobileProjectPrompt(finalPayload, finalAdvisor),
      language: overrides.language ?? prepared.finalPayload.language ?? "en",
      creationBrief: briefForMobilePayload(finalPayload, finalAdvisor),
      creationPayload: finalPayload,
      advisor: finalAdvisor
    });
    const project = await createMobileProjectRecord(userId, input);
    const output = await createCreationOutputForProject({
      draftId,
      projectId: project.id,
      title: project.title,
      existingOutputs: creationOutputsForDraft(draft, finalPayload)
    });

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
        status: "ACTIVE",
        advisorSnapshot: jsonInputValue(finalAdvisor),
        createdProjectId: project.id
      }
    });
    const refreshedProject = (await loadMobileProjectDetail(userId, project.id)) ?? project;
    return {
      ok: true,
      project: await serializeProjectDetail(refreshedProject, appConfig, userId),
      output: serializeCreationOutput(output),
      operation
    };
  }

  async function pageCountRecommendationsForPreflight(
    payload: MobileCreationDraftPayload,
    advisor: MobileBookAdvisorResponse
  ): Promise<MobilePageCountRecommendationDto[]> {
    const fallback = deterministicPageCountRecommendations(payload, advisor);
    try {
      const textModel = createFastRoutingTextModel(appConfig);
      const result = await promiseWithTimeout(
        generateJsonWithRetry(textModel, {
          purpose: "mobile-page-count-preflight",
          temperature: 0.2,
          maxTokens: 700,
          schema: mobilePageCountRecommendationAiSchema,
          messages: [
            {
              role: "system",
              content:
                "Recommend 2-4 practical page counts for a mobile book creator. Keep options concise. Do not mention AI models, providers, tokens, billing, or internal systems."
            },
            {
              role: "user",
              content: JSON.stringify(
                {
                  chat: payload.messages?.slice(-20) ?? [],
                  rawIdea: payload.rawIdea,
                  sourceNotesPreview: payload.sourceNotes.slice(0, 600),
                  detectedLane: advisor.detectedLane,
                  recipe: advisor.recipe,
                  fallback
                },
                null,
                2
              )
            }
          ]
        }),
        options.pageCountRecommendationTimeoutMs ?? 2500
      );
      return normalizePageCountRecommendations(result.data.recommendations, fallback);
    } catch {
      return fallback;
    }
  }

  function sendFinalizeOutcome(reply: FastifyReply, outcome: FinalizeOutcome): FastifyReply {
    if (outcome.ok) {
      return reply.code(201).send({
        project: outcome.project,
        output: outcome.output,
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
    "/api/mobile/projects/:id/chat",
    { schema: { tags: ["mobile"], response: { 401: mobileAuthError, 404: mobileAuthError } } },
    async (request, reply) => {
      const auth = await requireMobileAuth(request, reply);
      if (!auth) {
        return;
      }
      const { id } = idParamsSchema.parse(request.params);
      const project = await prisma.project.findFirst({ where: { id, userId: auth.user.id }, select: { id: true } });
      if (!project) {
        return sendMobileError(reply, 404, "PROJECT_NOT_FOUND", "Project not found.");
      }
      return loadProjectChatResponse(id);
    }
  );

  fastify.post(
    "/api/mobile/projects/:id/chat/messages",
    {
      attachValidation: true,
      schema: {
        tags: ["mobile"],
        body: mobileProjectChatMessageOpenApiBody,
        response: { 401: mobileAuthError, 404: mobileAuthError }
      }
    },
    async (request, reply) => {
      const auth = await requireMobileAuth(request, reply);
      if (!auth) {
        return;
      }
      if (!hitAuthenticatedLimit(draftLimiter, request, reply, auth.user.id, "project-chat")) {
        return;
      }
      const { id } = idParamsSchema.parse(request.params);
      const parsed = mobileProjectChatMessageBodySchema.safeParse(request.body);
      if (!parsed.success) {
        return sendMobileError(reply, 400, "VALIDATION_ERROR", "Send a chat message.");
      }

      const project = await loadProjectForChat(auth.user.id, id);
      if (!project) {
        return sendMobileError(reply, 404, "PROJECT_NOT_FOUND", "Project not found.");
      }

      const editMessageId = parsed.data.editMessageId;
      const editedMessage = editMessageId
        ? await prisma.projectChatMessage.findFirst({
            where: { id: editMessageId, projectId: id, role: "USER" }
          })
        : null;
      if (editMessageId && !editedMessage) {
        return sendMobileError(reply, 404, "MESSAGE_NOT_FOUND", "That chat message was not found.");
      }

      const activeMessages = await loadActiveProjectChatMessages(id);
      const activeEditedMessage = editedMessage
        ? activeMessages.find((message) => message.id === editedMessage.id)
        : null;
      const parentId = editedMessage
        ? activeEditedMessage?.parentId ?? editedMessage.parentId ?? null
        : activeProjectChatLeafId(activeMessages);
      const pendingScope = editMessageId ? null : await findPendingScopeClarification(id, parsed.data.message);
      const currentScope = bookEditScopeFromMessage(parsed.data.message);
      const pendingResolutionScope = currentScope !== "none" ? currentScope : pendingScope?.scope ?? "none";
      // Busy-queued edits carry their full target already; a bare confirmation
      // ("apply it") is enough to resume them. Scope clarifications still need
      // an actual scope answer.
      const resolvesPendingScope = Boolean(
        pendingScope &&
          (pendingScope.clarification === "busy"
            ? isPendingEditConfirmationMessage(parsed.data.message) || currentScope !== "none"
            : currentScope !== "none" ||
              (pendingResolutionScope !== "none" && isPendingEditConfirmationMessage(parsed.data.message)))
      );
      const resolvedPendingEdit =
        pendingScope && resolvesPendingScope
          ? {
              request: pendingScope.request,
              scope: pendingResolutionScope,
              scopeMessage: parsed.data.message
            }
          : null;
      const resolvedMessage = resolvedPendingEdit
        ? pendingScope?.clarification === "busy" && resolvedPendingEdit.scope === "none"
          ? resolvedPendingEdit.request
          : messageWithScope(resolvedPendingEdit.request, resolvedPendingEdit.scope)
        : parsed.data.message;

      const userMessage = await createUserProjectChatMessage({
        projectId: id,
        parentId,
        content: parsed.data.message,
        metadata: resolvedPendingEdit
          ? { resolvedPendingEdit }
          : editedMessage
            ? { editedFromMessageId: editedMessage.id }
            : {},
        selectSibling: Boolean(editedMessage)
      });

      if (pendingScope && !resolvesPendingScope && isPendingEditNudgeMessage(parsed.data.message)) {
        const replyMessage = await createAssistantChatMessage({
          projectId: id,
          parentId: userMessage.id,
          content: pendingScopeRecoveryMessage(pendingScope),
          metadata: {
            pendingEdit: { request: pendingScope.request, clarification: "scope" },
            recoveredPendingScope: pendingScope.scope,
            charged: false
          }
        });
        return {
          ...(await loadProjectChatResponse(id)),
          reply: serializeProjectChatMessage(replyMessage),
          operation: null
        } satisfies MobileProjectChatMessageResponseDto;
      }

      const pages = chatPagesForProject(project);
      const stage = chatStageForProject(project.status, project.currentPlan);
      const routingTextModel = safeFastRoutingTextModel();
      const intent = await classifyProjectChatMessage({
        message: resolvedMessage,
        stage,
        pages,
        chapters: chatChaptersForProject(project),
        planSummary: project.currentPlan ? planSummaryForClassifier(project.currentPlan) : undefined,
        textModel: routingTextModel
      });

      // Answering questions and reading content are always allowed while a job
      // runs; edit requests get saved as the project's one pending edit and can
      // be applied with a quick confirmation once the work settles.
      const openEditBlocked = await hasOpenProjectWork(id);
      const alwaysAllowedWhileBusy = ["answer", "clarify", "show_content"];
      if (openEditBlocked && !alwaysAllowedWhileBusy.includes(intent.kind)) {
        const replyMessage = await createAssistantChatMessage({
          projectId: id,
          parentId: userMessage.id,
          content:
            "This book is still being worked on, so I saved that request. Say “apply it” once the current job finishes and I’ll run it. You can keep asking questions in the meantime.",
          metadata: {
            intent,
            blockedByActiveJob: true,
            charged: false,
            pendingEdit: { request: resolvedMessage, clarification: "busy" }
          }
        });
        return {
          ...(await loadProjectChatResponse(id)),
          reply: serializeProjectChatMessage(replyMessage),
          operation: null
        } satisfies MobileProjectChatMessageResponseDto;
      }

      const outcome = await handleProjectChatIntent({
        userId: auth.user.id,
        project,
        userMessageId: userMessage.id,
        message: resolvedMessage,
        intent
      });

      return {
        ...(await loadProjectChatResponse(id)),
        reply: serializeProjectChatMessage(outcome.reply),
        operation: outcome.operation ? serializeBookEditOperation(outcome.operation) : null
      } satisfies MobileProjectChatMessageResponseDto;
    }
  );

  fastify.post(
    "/api/mobile/projects/:id/chat/branches",
    {
      attachValidation: true,
      schema: {
        tags: ["mobile"],
        body: mobileProjectChatBranchOpenApiBody,
        response: { 401: mobileAuthError, 404: mobileAuthError }
      }
    },
    async (request, reply) => {
      const auth = await requireMobileAuth(request, reply);
      if (!auth) {
        return;
      }
      const { id } = idParamsSchema.parse(request.params);
      const parsed = mobileProjectChatBranchBodySchema.safeParse(request.body);
      if (!parsed.success) {
        return sendMobileError(reply, 400, "VALIDATION_ERROR", "Choose a chat branch.");
      }
      const project = await prisma.project.findFirst({ where: { id, userId: auth.user.id }, select: { id: true } });
      if (!project) {
        return sendMobileError(reply, 404, "PROJECT_NOT_FOUND", "Project not found.");
      }

      const switched = await switchProjectChatBranch({
        projectId: id,
        messageId: parsed.data.messageId,
        direction: parsed.data.direction
      });
      if (!switched) {
        return sendMobileError(reply, 404, "MESSAGE_NOT_FOUND", "That chat branch was not found.");
      }
      return loadProjectChatResponse(id);
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
      const status = await loadSerializedProjectStatus(id, appConfig, auth.user.id);
      if (!status) {
        return sendMobileError(reply, 404, "PROJECT_NOT_FOUND", "Project not found.");
      }
      return { status };
    }
  );

  fastify.get(
    "/api/mobile/projects/:id/status/events",
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

      reply.hijack();
      reply.raw.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no"
      });

      let closed = false;
      let sending = false;
      let timer: ReturnType<typeof setInterval> | null = null;
      const close = () => {
        if (closed) return;
        closed = true;
        if (timer) {
          clearInterval(timer);
          timer = null;
        }
        reply.raw.end();
      };

      const sendStatus = async () => {
        if (closed || sending) {
          return;
        }
        sending = true;
        try {
          const status = await loadSerializedProjectStatus(id, appConfig, auth.user.id);
          if (!status) {
            reply.raw.write(`event: error\ndata: ${JSON.stringify({ code: "PROJECT_NOT_FOUND" })}\n\n`);
            close();
            return;
          }
          reply.raw.write(`event: status\ndata: ${JSON.stringify({ status })}\n\n`);
          if (!isLiveProjectStatus(status.status)) {
            close();
          }
        } catch (error) {
          request.log.warn({ err: error, projectId: id }, "Could not stream mobile project status");
          reply.raw.write(`event: error\ndata: ${JSON.stringify({ code: "STATUS_STREAM_ERROR" })}\n\n`);
        } finally {
          sending = false;
        }
      };

      request.raw.on("close", close);
      await sendStatus();
      if (!closed) {
        timer = setInterval(sendStatus, 1000);
      }
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

      try {
        const { job } = await queueChargedPlanRevision({
          userId: auth.user.id,
          projectId: plan.projectId,
          planId: id,
          message: parsed.data.message,
          idempotencyKey: `mobile:plan:${id}:revision:${hashString(parsed.data.message)}`
        });
        return reply.code(202).send(planOperation("revision_queued", plan.projectId, id, job, "Revising your book plan."));
      } catch (error) {
        if (error instanceof InsufficientCreditsError) {
          return sendInsufficientCredits(reply, error);
        }
        throw error;
      }
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
  const bookTypeChoice = bookTypeChoiceForMobileCreate(parsed);
  const isAutoBookType = bookTypeChoice === "auto";
  const bookType = isAutoBookType ? MOBILE_AUTO_BOOK_TYPE_SETTINGS : MOBILE_BOOK_TYPE_SETTINGS[parsed.bookType];
  const quality = MOBILE_PRODUCT_PRESETS[parsed.qualityPreset];
  const exactTargetPages = parsed.pageCountMode === "custom" && parsed.targetPages ? parsed.targetPages : undefined;
  const targetPages = exactTargetPages ?? bookType.targetPages[parsed.lengthPreset];
  const pageCountMode: MobilePageCountMode = exactTargetPages ? "custom" : parsed.pageCountMode;
  const pageCountSource: MobilePageCountSource = exactTargetPages ? parsed.pageCountSource ?? "settings" : parsed.pageCountSource ?? "legacy";
  const mobileMetadata: MobileMediaMetadata = {
    bookType: isAutoBookType ? "custom" : parsed.bookType,
    bookTypeChoice: bookTypeChoice ?? parsed.bookType,
    lengthPreset: exactTargetPages ? "custom" : parsed.lengthPreset,
    qualityPreset: parsed.qualityPreset,
    imagesEnabled: parsed.imagesEnabled,
    pageCountMode,
    targetPages,
    pageCountSource
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
          ...(bookTypeChoice ? { bookTypeChoice } : {}),
          lengthPreset: parsed.lengthPreset,
          qualityPreset: parsed.qualityPreset,
          imagesEnabled: parsed.imagesEnabled,
          pageCountMode,
          targetPages,
          pageCountSource
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
    toneProfile: bookType.toneProfile,
    generationStrategy: AUTO_BOOK_GENERATION_STRATEGY_ID,
    parallelPageGeneration: quality.parallelPageGeneration,
    draftCandidates: quality.draftCandidates,
    modelTier: quality.modelTier
  });
  const projectInput = createProjectSchema.parse({
    title: parsed.title ?? UNTITLED_MOBILE_PROJECT_TITLE,
    ...(parsed.authorName ? { authorName: parsed.authorName } : {}),
    prompt: parsed.prompt,
    category: bookType.category,
    subcategory: bookType.subcategory,
    templateSlug: bookType.templateSlug,
    targetPages,
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

function bookTypeChoiceForMobileCreate(parsed: z.infer<typeof mobileProjectCreateBodySchema>): MobileBookTypeChoice | undefined {
  return parsed.bookTypeChoice ?? parsed.creationPayload?.selectedPresets?.bookTypeChoice ?? parsed.advisor?.recommendation.bookTypeChoice;
}

function resolveMobilePageCount(
  payload: MobileCreationDraftPayload,
  selectedPresets: MobileCreationDraftPayload["selectedPresets"]
): MobilePageCountResolution {
  if (selectedPresets?.pageCountMode === "custom" && selectedPresets.targetPages) {
    return {
      resolved: true,
      targetPages: selectedPresets.targetPages,
      source: selectedPresets.pageCountSource ?? "settings",
      mode: "custom"
    };
  }
  const explicitTargetPages = explicitTargetPagesForMobilePayload(payload);
  if (explicitTargetPages) {
    return { resolved: true, targetPages: explicitTargetPages, source: "chat", mode: "custom" };
  }
  return { resolved: false };
}

function presetsWithResolvedPageCount(
  presets: MobileCreationDraftPayload["selectedPresets"],
  pageCount: MobilePageCountResolution
): NonNullable<MobileCreationDraftPayload["selectedPresets"]> {
  if (!presets) {
    throw new Error("Cannot resolve page count without selected mobile presets.");
  }
  if (!pageCount.resolved) {
    return { ...presets, pageCountMode: presets.pageCountMode ?? "auto", pageCountSource: presets.pageCountSource ?? "legacy" };
  }
  return {
    ...presets,
    pageCountMode: "custom",
    targetPages: pageCount.targetPages,
    pageCountSource: pageCount.source
  };
}

function deterministicPageCountRecommendations(
  payload: MobileCreationDraftPayload,
  advisor: MobileBookAdvisorResponse
): MobilePageCountRecommendationDto[] {
  const lane = advisor.recipe.lane === "auto" ? advisor.detectedLane : advisor.recipe.lane;
  const bookType = advisor.recommendation.bookType;
  if (lane === "workbook" || lane === "client_tool" || bookType === "workbook") {
    return [
      { targetPages: 16, label: "16 pages", description: "A focused workbook with a few exercises." },
      { targetPages: 28, label: "28 pages", description: "Recommended for lessons, examples, and practice." },
      { targetPages: 40, label: "40 pages", description: "A fuller workbook with more sections." }
    ];
  }
  if (lane === "children_story" || lane === "adult_story" || bookType === "short_story") {
    return [
      { targetPages: 4, label: "4 pages", description: "Very short and simple." },
      { targetPages: 8, label: "8 pages", description: "Recommended for a compact story arc." },
      { targetPages: 12, label: "12 pages", description: "More room for scenes and details." }
    ];
  }
  const hasLongNotes = payload.sourceNotes.trim().length > 1200;
  return [
    { targetPages: 8, label: "8 pages", description: "A quick, concise read." },
    { targetPages: hasLongNotes ? 18 : 12, label: hasLongNotes ? "18 pages" : "12 pages", description: "Recommended for a useful first draft." },
    { targetPages: 24, label: "24 pages", description: "More space for examples and depth." }
  ];
}

function normalizePageCountRecommendations(
  recommendations: MobilePageCountRecommendationDto[],
  fallback: MobilePageCountRecommendationDto[]
): MobilePageCountRecommendationDto[] {
  const seen = new Set<number>();
  const cleaned: MobilePageCountRecommendationDto[] = [];
  for (const item of recommendations) {
    const parsed = mobilePageCountRecommendationSchema.safeParse(item);
    if (!parsed.success || seen.has(parsed.data.targetPages)) {
      continue;
    }
    seen.add(parsed.data.targetPages);
    cleaned.push(parsed.data);
    if (cleaned.length >= 4) {
      break;
    }
  }
  return cleaned.length >= 2 ? cleaned : fallback;
}

function promiseWithTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Timed out.")), timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timeout);
        resolve(value);
      },
      (error) => {
        clearTimeout(timeout);
        reject(error);
      }
    );
  });
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

async function createReplanProjectCopy(options: {
  userId: string;
  sourceProject: ProjectForChat;
  request: string;
  operationId: string;
  targetLanguage?: string | null;
}): Promise<MobileProjectRecord> {
  const source = options.sourceProject;
  const targetLanguage = cleanTargetLanguage(options.targetLanguage);
  const sourceMediaSettings = mediaSettingsSchema.parse(source.mediaSettings);
  const mobileMetadata = jsonRecord(sourceMediaSettings.mobile);
  const copyMediaSettings = mediaSettingsSchema.parse({
    ...sourceMediaSettings,
    mobile: {
      ...mobileMetadata,
      revisionOfProjectId: source.id,
      revisionOperationId: options.operationId,
      revisionRequest: options.request,
      revisionSource: "project_chat_book_replan",
      ...(targetLanguage ? { revisionTargetLanguage: targetLanguage } : {})
    }
  });
  const copy = (await prisma.project.create({
    data: {
      userId: options.userId,
      title: revisedCopyTitle(source.title),
      ...(source.subtitle ? { subtitle: source.subtitle } : {}),
      ...(source.authorName ? { authorName: source.authorName } : {}),
      ...(source.coverTagline ? { coverTagline: source.coverTagline } : {}),
      prompt: source.prompt,
      category: source.category,
      ...(source.subcategory ? { subcategory: source.subcategory } : {}),
      targetPages: source.targetPages,
      complexity: source.complexity,
      temperature: source.temperature,
      language: targetLanguage ?? source.language,
      mediaSettings: jsonInputValue(copyMediaSettings),
      status: "EDITING",
      ...(source.templateId ? { templateId: source.templateId } : {})
    },
    include: mobileProjectDetailInclude()
  })) as MobileProjectRecord;

  await attachReplanCopyToCreationSession({
    sourceProjectId: source.id,
    copyProjectId: copy.id,
    copyTitle: copy.title
  });
  return copy;
}

async function attachReplanCopyToCreationSession(options: {
  sourceProjectId: string;
  copyProjectId: string;
  copyTitle: string;
}): Promise<void> {
  const sourceOutput = await prisma.mobileCreationOutput.findFirst({
    where: { projectId: options.sourceProjectId },
    include: { draft: { include: mobileCreationDraftOutputsInclude() } },
    orderBy: { createdAt: "desc" }
  });
  if (!sourceOutput?.draft) {
    return;
  }
  const parsed = mobileCreationDraftPayloadSchema.safeParse(sourceOutput.draft.payload);
  if (!parsed.success) {
    return;
  }
  await createCreationOutputForProject({
    draftId: sourceOutput.draftId,
    projectId: options.copyProjectId,
    title: options.copyTitle,
    existingOutputs: creationOutputsForDraft(sourceOutput.draft, parsed.data)
  });
  await prisma.mobileCreationDraft.update({
    where: { id: sourceOutput.draftId },
    data: { createdProjectId: options.copyProjectId, status: "ACTIVE" }
  });
}

function revisedCopyTitle(title: string): string {
  const suffix = " (Revised)";
  if (title.endsWith(suffix)) {
    return title;
  }
  return `${title.slice(0, 160 - suffix.length)}${suffix}`;
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

function mobileCreationDraftOutputsInclude() {
  return {
    outputs: {
      orderBy: { sequence: "asc" },
      include: { project: { select: { title: true, updatedAt: true } } }
    }
  } as const;
}

function creationOutputsForDraft(
  draft: { id: string; createdProjectId: string | null; updatedAt: Date; outputs?: MobileCreationOutputRecord[] },
  payload: MobileCreationDraftPayload
): MobileCreationOutputDto[] {
  const outputs = (draft.outputs ?? []).map((output) => serializeCreationOutput(output));
  if (outputs.length > 0 || !draft.createdProjectId) {
    return outputs;
  }
  return [
    {
      id: `legacy:${draft.id}:${draft.createdProjectId}`,
      draftId: draft.id,
      projectId: draft.createdProjectId,
      title: _chatTitleForPayload(payload),
      sequence: 1,
      createdAt: draft.updatedAt.toISOString(),
      updatedAt: draft.updatedAt.toISOString()
    }
  ];
}

function activeProjectIdForDraft(
  draft: { createdProjectId: string | null },
  outputs: MobileCreationOutputDto[]
): string | null {
  return outputs.at(-1)?.projectId ?? draft.createdProjectId;
}

function serializeCreationOutput(output: MobileCreationOutputRecord): MobileCreationOutputDto {
  return {
    id: output.id,
    draftId: output.draftId,
    projectId: output.projectId,
    title: output.project?.title ?? output.title,
    sequence: output.sequence,
    createdAt: output.createdAt.toISOString(),
    updatedAt: (output.project?.updatedAt ?? output.updatedAt).toISOString()
  };
}

async function createCreationOutputForProject(options: {
  draftId: string;
  projectId: string;
  title: string;
  existingOutputs: MobileCreationOutputDto[];
}): Promise<MobileCreationOutputRecord> {
  const nextSequence =
    options.existingOutputs.reduce((max, output) => Math.max(max, output.sequence), 0) + 1;
  return prisma.mobileCreationOutput.create({
    data: {
      draftId: options.draftId,
      projectId: options.projectId,
      title: options.title,
      sequence: nextSequence
    },
    include: { project: { select: { title: true, updatedAt: true } } }
  });
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
  draft: {
    id: string;
    status: string;
    payload: unknown;
    createdProjectId: string | null;
    updatedAt: Date;
    outputs?: MobileCreationOutputRecord[];
  },
  messages: MobileCreationMessage[]
): MobileCreationSessionDto {
  const payload = mobileCreationDraftPayloadSchema.safeParse(draft.payload);
  const outputs = payload.success ? creationOutputsForDraft(draft, payload.data) : [];
  return {
    draftId: draft.id,
    title: payload.success ? _chatTitleForPayload(payload.data) : "New book",
    status: draft.status,
    messages,
    createdProjectId: draft.createdProjectId,
    activeProjectId: activeProjectIdForDraft(draft, outputs),
    outputs,
    updatedAt: draft.updatedAt.toISOString()
  };
}

async function loadProjectChatResponse(projectId: string): Promise<MobileProjectChatResponseDto> {
  const [messages, planVersions, operations] = await Promise.all([
    prisma.projectChatMessage.findMany({
      where: { projectId },
      orderBy: { createdAt: "asc" },
      take: 500
    }),
    prisma.planVersion.findMany({
      where: { projectId },
      orderBy: { version: "asc" },
      take: 50
    }),
    prisma.bookEditOperation.findMany({
      where: { projectId },
      orderBy: { createdAt: "desc" },
      take: 50,
      include: { generationJob: { select: { id: true, status: true } } }
    })
  ]);
  const activeChat = linearizeProjectChatMessages(messages);
  const exposedMessages = activeChat.messages.slice(0, 150);
  const activeMessageIds = new Set(activeChat.messages.map((message) => message.id));
  return {
    messages: exposedMessages.map((message) => serializeProjectChatMessage(message, activeChat.branches.get(message.id) ?? null)),
    plans: planVersions.map((planVersion) => serializePlan(planVersion)),
    operations: operations
      .filter((operation) => shouldExposeChatOperation(operation, planVersions))
      .filter((operation) => shouldExposeChatOperationForBranch(operation, activeMessageIds))
      .map((operation) => serializeBookEditOperation(operation))
  };
}

async function loadActiveProjectChatMessages(projectId: string): Promise<MobileProjectChatMessageRecord[]> {
  const messages = await prisma.projectChatMessage.findMany({
    where: { projectId },
    orderBy: { createdAt: "asc" },
    take: 500
  });
  return linearizeProjectChatMessages(messages).messages;
}

function shouldExposeChatOperationForBranch(
  operation: MobileBookEditOperationRecord,
  activeMessageIds: Set<string>
): boolean {
  if (activeMessageIds.size === 0) {
    return true;
  }
  const userMessageId = operation.userMessageId ?? null;
  const assistantMessageId = operation.assistantMessageId ?? null;
  if (!userMessageId && !assistantMessageId) {
    return true;
  }
  return Boolean(
    (userMessageId && activeMessageIds.has(userMessageId)) ||
      (assistantMessageId && activeMessageIds.has(assistantMessageId))
  );
}

function activeProjectChatLeafId(messages: MobileProjectChatMessageRecord[]): string | null {
  return messages.at(-1)?.id ?? null;
}

function linearizeProjectChatMessages(messages: MobileProjectChatMessageRecord[]): {
  messages: MobileProjectChatMessageRecord[];
  branches: Map<string, MobileProjectChatBranchDto>;
} {
  const sorted = normalizeLegacyProjectChatParents([...messages].sort(compareProjectChatMessages));
  const childrenByParent = new Map<string, MobileProjectChatMessageRecord[]>();
  const branches = new Map<string, MobileProjectChatBranchDto>();

  for (const message of sorted) {
    const key = projectChatParentKey(message.parentId ?? null);
    const siblings = childrenByParent.get(key) ?? [];
    siblings.push(message);
    childrenByParent.set(key, siblings);
  }

  for (const siblings of childrenByParent.values()) {
    siblings.sort(compareProjectChatMessages);
    if (siblings.length <= 1) {
      continue;
    }
    siblings.forEach((message, index) => {
      branches.set(message.id, {
        index: index + 1,
        total: siblings.length,
        canGoPrevious: index > 0,
        canGoNext: index < siblings.length - 1
      });
    });
  }

  const linearized: MobileProjectChatMessageRecord[] = [];
  const visited = new Set<string>();
  let next = selectedProjectChatChild(childrenByParent.get(projectChatParentKey(null)) ?? []);
  while (next && !visited.has(next.id)) {
    linearized.push(next);
    visited.add(next.id);
    next = selectedProjectChatChild(childrenByParent.get(projectChatParentKey(next.id)) ?? []);
  }

  return { messages: linearized, branches };
}

function normalizeLegacyProjectChatParents(
  messages: MobileProjectChatMessageRecord[]
): MobileProjectChatMessageRecord[] {
  if (messages.length <= 1 || messages.some((message) => message.parentId != null)) {
    return messages;
  }
  return messages.map((message, index) =>
    index === 0
      ? { ...message, parentId: null }
      : { ...message, parentId: messages[index - 1]!.id, isActiveChild: message.isActiveChild ?? true }
  );
}

function selectedProjectChatChild(siblings: MobileProjectChatMessageRecord[]): MobileProjectChatMessageRecord | null {
  if (siblings.length === 0) {
    return null;
  }
  return [...siblings].reverse().find((message) => message.isActiveChild !== false) ?? siblings.at(-1)!;
}

function compareProjectChatMessages(a: MobileProjectChatMessageRecord, b: MobileProjectChatMessageRecord): number {
  const byCreatedAt = a.createdAt.getTime() - b.createdAt.getTime();
  if (byCreatedAt !== 0) {
    return byCreatedAt;
  }
  return a.id.localeCompare(b.id);
}

function projectChatParentKey(parentId: string | null): string {
  return parentId ?? "__project_chat_root__";
}

async function createUserProjectChatMessage(options: {
  projectId: string;
  parentId: string | null;
  content: string;
  metadata: Record<string, unknown>;
  selectSibling?: boolean;
}): Promise<MobileProjectChatMessageRecord> {
  const data = {
    projectId: options.projectId,
    parentId: options.parentId,
    role: "USER" as const,
    content: options.content,
    metadata: jsonInputValue(options.metadata),
    isActiveChild: true
  };
  if (!options.selectSibling) {
    return prisma.projectChatMessage.create({ data });
  }
  return prisma.$transaction(async (tx) => {
    await tx.projectChatMessage.updateMany({
      where: projectChatSiblingWhere(options.projectId, options.parentId),
      data: { isActiveChild: false }
    });
    return tx.projectChatMessage.create({ data });
  });
}

async function switchProjectChatBranch(options: {
  projectId: string;
  messageId: string;
  direction: "previous" | "next";
}): Promise<boolean> {
  const messages = await prisma.projectChatMessage.findMany({
    where: { projectId: options.projectId },
    orderBy: { createdAt: "asc" },
    take: 500
  });
  const current = messages.find((message) => message.id === options.messageId);
  if (!current) {
    return false;
  }
  const parentId = current.parentId ?? null;
  const siblings = messages
    .filter((message) => (message.parentId ?? null) === parentId)
    .sort(compareProjectChatMessages);
  if (siblings.length <= 1) {
    return true;
  }
  const currentIndex = siblings.findIndex((message) => message.id === current.id);
  const targetIndex = options.direction === "previous" ? currentIndex - 1 : currentIndex + 1;
  const target = siblings[targetIndex];
  if (!target) {
    return true;
  }
  await selectProjectChatSibling(options.projectId, parentId, target.id);
  return true;
}

async function selectProjectChatSibling(projectId: string, parentId: string | null, messageId: string): Promise<void> {
  await prisma.$transaction(async (tx) => {
    await tx.projectChatMessage.updateMany({
      where: projectChatSiblingWhere(projectId, parentId),
      data: { isActiveChild: false }
    });
    await tx.projectChatMessage.updateMany({
      where: { projectId, id: messageId },
      data: { isActiveChild: true }
    });
  });
}

function projectChatSiblingWhere(projectId: string, parentId: string | null): { projectId: string; parentId: string | null } {
  return { projectId, parentId };
}

function shouldExposeChatOperation(
  operation: MobileBookEditOperationRecord,
  planVersions: Array<{ createdAt: Date }>
): boolean {
  if (operation.kind !== "PLAN_REVISION" || operation.status !== "FAILED") {
    return true;
  }
  return !planVersions.some((planVersion) => planVersion.createdAt > operation.createdAt);
}

async function findPendingScopeClarification(
  projectId: string,
  currentMessage: string
): Promise<{ request: string; scope: BookEditScope; clarification: "scope" | "busy" } | null> {
  const currentScope = bookEditScopeFromMessage(currentMessage);
  const messages = (await loadActiveProjectChatMessages(projectId)).reverse().slice(0, 24);
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index]!;
    if (message.role === "USER" && jsonRecord(jsonRecord(message.metadata).resolvedPendingEdit).request !== undefined) {
      // The most recent pending edit was already applied; don't re-apply it.
      return null;
    }
    if (message.role !== "ASSISTANT") {
      continue;
    }
    const metadata = jsonRecord(message.metadata);
    const pending = jsonRecord(metadata.pendingEdit);
    const request = typeof pending.request === "string" ? pending.request.trim() : "";
    if ((pending.clarification === "scope" || pending.clarification === "busy") && request.length > 0) {
      return {
        request,
        scope: currentScope !== "none" ? currentScope : scopeFromRecentUserMessages(messages.slice(0, index)),
        clarification: pending.clarification
      };
    }
    if (isScopeClarificationAssistantMessage(message.content)) {
      const priorUser = messages
        .slice(index + 1)
        .find((candidate) => candidate.role === "USER" && !isBookEditScopeOnlyMessage(candidate.content));
      const priorRequest = priorUser?.content.trim();
      if (priorRequest) {
        return {
          request: priorRequest,
          scope: currentScope !== "none" ? currentScope : scopeFromRecentUserMessages(messages.slice(0, index)),
          clarification: "scope"
        };
      }
    }
  }
  return null;
}

function scopeFromRecentUserMessages(messages: MobileProjectChatMessageRecord[]): BookEditScope {
  for (const message of messages) {
    if (message.role !== "USER" || !isBookEditScopeOnlyMessage(message.content)) {
      continue;
    }
    const scope = bookEditScopeFromMessage(message.content);
    if (scope !== "none") {
      return scope;
    }
  }
  return "none";
}

function isPendingEditConfirmationMessage(message: string): boolean {
  return /^(?:ok|okay|yes|yep|yeah|sure|do it|apply it|go ahead|please do|start|run it)$/i.test(
    normalizeShortFollowUpMessage(message)
  );
}

function isPendingEditNudgeMessage(message: string): boolean {
  const normalized = normalizeShortFollowUpMessage(message);
  return isPendingEditConfirmationMessage(message) ||
    /^(?:wow|come on|seriously|same thing|again|i already said it|i said it|why)$/i.test(normalized) ||
    /^i\s+(?:already\s+)?said\b/i.test(normalized);
}

function normalizeShortFollowUpMessage(message: string): string {
  return message
    .toLowerCase()
    .replace(/[.!?]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function pendingScopeRecoveryMessage(pending: { request: string; scope: BookEditScope }): string {
  if (pending.scope === "all_pages") {
    return `I still have your earlier edit: “${pending.request}”, and I saw that you want it for the whole book. Say “apply it” to start that edit, or send a new edit.`;
  }
  return `I still have your earlier edit: “${pending.request}”. Should I apply it to the whole book, matching text, or a specific page?`;
}

function isScopeClarificationAssistantMessage(content: string): boolean {
  return /which\s+page\s+or\s+exact\s+phrase\s+should\s+i\s+(?:change|edit)/i.test(content) ||
    /should\s+i\s+(?:change|edit|rewrite)\s+(?:a\s+)?specific\s+page/i.test(content);
}

async function loadProjectForChat(userId: string, projectId: string) {
  return prisma.project.findFirst({
    where: { id: projectId, userId },
    include: {
      currentPlan: true,
      chapters: {
        orderBy: { index: "asc" },
        select: { id: true, index: true, title: true, summary: true }
      },
      pages: {
        orderBy: { index: "asc" },
        select: {
          id: true,
          index: true,
          title: true,
          markdown: true,
          summary: true,
          status: true,
          chapter: { select: { index: true } }
        }
      }
    }
  });
}

function chatChaptersForProject(project: ProjectForChat): BookEditChapterContext[] {
  return project.chapters.map((chapter) => ({
    index: chapter.index,
    title: chapter.title,
    pageIndexes: project.pages
      .filter((page) => page.chapter?.index === chapter.index)
      .map((page) => page.index)
      .sort((a, b) => a - b)
  }));
}

type ProjectForChat = NonNullable<Awaited<ReturnType<typeof loadProjectForChat>>>;

async function handleProjectChatIntent(options: {
  userId: string;
  project: ProjectForChat;
  userMessageId: string;
  message: string;
  intent: BookEditIntent;
}): Promise<{ reply: MobileProjectChatMessageRecord; operation: MobileBookEditOperationRecord | null }> {
  const { userId, project, userMessageId, message, intent } = options;
  if (intent.kind === "answer" || intent.kind === "clarify") {
    const reply = await createAssistantChatMessage({
      projectId: project.id,
      parentId: userMessageId,
      content: intent.assistantMessage,
      metadata: {
        intent,
        charged: false,
        ...(intent.kind === "clarify" && intent.clarification === "scope"
          ? { pendingEdit: { request: message, clarification: "scope" } }
          : {})
      }
    });
    return { reply, operation: null };
  }

  if (intent.kind === "show_content") {
    const reply = await replyWithContentCard(project, intent, userMessageId);
    return { reply, operation: null };
  }

  if (intent.kind === "undo_last_edit") {
    const reply = await undoLastBookEdit(project, intent, userMessageId);
    return { reply, operation: null };
  }

  if (intent.kind === "plan_revision") {
    if (!project.currentPlan) {
      const reply = await createAssistantChatMessage({
        projectId: project.id,
        parentId: userMessageId,
        content: "I need a saved book plan before I can revise it.",
        metadata: { intent, charged: false }
      });
      return { reply, operation: null };
    }
    return queueChatPlanRevision({ userId, project, userMessageId, message, intent });
  }

  if (project.status !== "COMPLETE") {
    const reply = await createAssistantChatMessage({
      projectId: project.id,
      parentId: userMessageId,
      content: "Book text edits are available after the latest book has finished generating.",
      metadata: { intent, charged: false }
    });
    return { reply, operation: null };
  }

  return queueChatBookEdit({ userId, project, userMessageId, message, intent });
}

async function queueChatPlanRevision(options: {
  userId: string;
  project: ProjectForChat;
  userMessageId: string;
  message: string;
  intent: BookEditIntent;
}): Promise<{ reply: MobileProjectChatMessageRecord; operation: MobileBookEditOperationRecord | null }> {
  const { userId, project, userMessageId, message, intent } = options;
  const planId = project.currentPlan!.id;
  const credits = creditCostForOperation("PLAN_REVISION");
  const operation = await prisma.bookEditOperation.create({
    data: {
      projectId: project.id,
      userMessageId,
      kind: "PLAN_REVISION",
      status: "QUEUED",
      request: message,
      classifier: jsonInputValue(intent),
      affectedPageIndexes: [],
      creditsCharged: 0
    }
  });
  try {
    const { job, ledgerEntry } = await queueChargedPlanRevision({
      userId,
      projectId: project.id,
      planId,
      message,
      operationId: operation.id,
      idempotencyKey: `mobile:project-chat:${project.id}:${operation.id}:plan-revision`
    });
    const updated = await prisma.bookEditOperation.update({
      where: { id: operation.id },
      data: {
        generationJobId: job.id,
        ledgerEntryId: ledgerEntry?.id ?? null,
        creditsCharged: credits
      },
      include: { generationJob: { select: { id: true, status: true } } }
    });
    const reply = await createAssistantChatMessage({
      projectId: project.id,
      parentId: userMessageId,
      operationId: operation.id,
      content:
        project.currentPlan?.status === "APPROVED"
          ? `I’ll revise the approved plan and reopen it for review. This uses ${credits} credits.`
          : `I’ll revise the plan now. This uses ${credits} credits.`,
      metadata: { intent, charged: true, creditsCharged: credits }
    });
    await prisma.bookEditOperation.update({
      where: { id: operation.id },
      data: { assistantMessageId: reply.id }
    });
    return { reply, operation: updated };
  } catch (error) {
    await prisma.bookEditOperation.update({
      where: { id: operation.id },
      data: { status: "FAILED", error: errorMessage(error) }
    });
    if (error instanceof InsufficientCreditsError) {
      const reply = await insufficientCreditsChatMessage(project.id, userMessageId, intent, error);
      return { reply, operation: null };
    }
    throw error;
  }
}

async function queueChatBookReplanCopy(options: {
  userId: string;
  project: ProjectForChat;
  userMessageId: string;
  message: string;
  intent: BookEditIntent;
}): Promise<{ reply: MobileProjectChatMessageRecord; operation: MobileBookEditOperationRecord | null }> {
  const { userId, project, userMessageId, message, intent } = options;
  const cost = bookEditCreditCost(intent.kind, 0, project);
  const targetLanguage = cleanTargetLanguage(intent.targetLanguage);
  const operation = await prisma.bookEditOperation.create({
    data: {
      projectId: project.id,
      userMessageId,
      kind: "BOOK_REPLAN",
      status: "QUEUED",
      request: message,
      classifier: jsonInputValue(intent),
      affectedPageIndexes: [],
      creditsCharged: 0
    }
  });

  let reservation: CreditLedgerEntryRecord | null = null;
  let spend: CreditLedgerEntryRecord | null = null;
  let copy: MobileProjectRecord | null = null;
  try {
    reservation = await reserveCredits({
      userId,
      projectId: project.id,
      operation: "BOOK_REPLAN",
      amountCredits: cost,
      idempotencyKey: `mobile:project-chat:${project.id}:${operation.id}:book-replan`,
      description: "Mobile book replan copy",
      metadata: {
        intent,
        sourceProjectId: project.id,
        operationId: operation.id,
        ...(targetLanguage ? { targetLanguage } : {})
      }
    });
    copy = await createReplanProjectCopy({
      userId,
      sourceProject: project,
      request: message,
      operationId: operation.id,
      targetLanguage
    });
    spend = reservation ? await commitReservedCredits(reservation.id) : null;
    const job = await enqueueGenerationJob({
      projectId: copy.id,
      type: "REPLAN_BOOK",
      payload: {
        operationId: operation.id,
        sourceProjectId: project.id,
        sourcePlanId: project.currentPlanId,
        request: message,
        affectedPageIndexes: [],
        intentKind: intent.kind,
        ...(targetLanguage ? { targetLanguage } : {}),
        ...(spend ? { billingLedgerEntryId: spend.id } : {})
      }
    });
    const updated = await prisma.bookEditOperation.update({
      where: { id: operation.id },
      data: {
        generationJobId: job.id,
        ledgerEntryId: spend?.id ?? null,
        creditsCharged: cost,
        classifier: jsonInputValue({
          ...intent,
          replanCopy: { sourceProjectId: project.id, targetProjectId: copy.id, ...(targetLanguage ? { targetLanguage } : {}) }
        })
      },
      include: { generationJob: { select: { id: true, status: true } } }
    });
    const reply = await createAssistantChatMessage({
      projectId: project.id,
      parentId: userMessageId,
      operationId: operation.id,
      content: `I created a new${targetLanguage ? ` ${languageDisplayName(targetLanguage)}` : ""} copy and I’ll rebuild the plan and book there. This book stays unchanged. This uses ${cost} credits.`,
      metadata: {
        intent,
        charged: true,
        creditsCharged: cost,
        replanCopy: { sourceProjectId: project.id, targetProjectId: copy.id, ...(targetLanguage ? { targetLanguage } : {}) }
      }
    });
    await prisma.bookEditOperation.update({
      where: { id: operation.id },
      data: { assistantMessageId: reply.id }
    });
    return { reply, operation: updated };
  } catch (error) {
    const entryToRefund = spend ?? reservation;
    if (entryToRefund) {
      await refundCreditLedgerEntry(entryToRefund.id, "Book replan copy could not be queued.");
    }
    await prisma.bookEditOperation.update({
      where: { id: operation.id },
      data: { status: "FAILED", error: errorMessage(error) }
    });
    if (copy) {
      await prisma.project.update({ where: { id: copy.id }, data: { status: "FAILED" } }).catch(() => undefined);
    }
    if (error instanceof InsufficientCreditsError) {
      const reply = await insufficientCreditsChatMessage(project.id, userMessageId, intent, error);
      return { reply, operation: null };
    }
    throw error;
  }
}

async function queueChatBookEdit(options: {
  userId: string;
  project: ProjectForChat;
  userMessageId: string;
  message: string;
  intent: BookEditIntent;
}): Promise<{ reply: MobileProjectChatMessageRecord; operation: MobileBookEditOperationRecord | null }> {
  const { userId, project, userMessageId, message, intent } = options;
  if (intent.kind === "book_replan") {
    return queueChatBookReplanCopy({ userId, project, userMessageId, message, intent });
  }

  const affectedPageIndexes = affectedPagesForIntent(intent, message, project.pages);
  if (affectedPageIndexes.length === 0) {
    const reply = await createAssistantChatMessage({
      projectId: project.id,
      parentId: userMessageId,
      content:
        intent.kind === "chapter_regenerate"
          ? `I couldn’t find chapter ${intent.affectedChapterIndex ?? ""} in this book. Which chapter or pages should I rewrite?`.replace("  ", " ")
          : "Which page or exact phrase should I edit?",
      metadata: {
        intent: { ...intent, kind: "clarify", affectedPageIndexes, clarification: "scope" },
        pendingEdit: { request: message, clarification: "scope" },
        charged: false
      }
    });
    return { reply, operation: null };
  }

  const cost = bookEditCreditCost(intent.kind, affectedPageIndexes.length, project);
  const operationKind = operationKindForIntent(intent.kind);
  const billingOperation = billingOperationForIntent(intent.kind);
  const operation = await prisma.bookEditOperation.create({
    data: {
      projectId: project.id,
      userMessageId,
      kind: operationKind,
      status: "QUEUED",
      request: message,
      classifier: jsonInputValue(intent),
      affectedPageIndexes,
      creditsCharged: 0
    }
  });

  let reservation: CreditLedgerEntryRecord | null = null;
  let spend: CreditLedgerEntryRecord | null = null;
  try {
    reservation = await reserveCredits({
      userId,
      projectId: project.id,
      operation: billingOperation,
      amountCredits: cost,
      idempotencyKey: `mobile:project-chat:${project.id}:${operation.id}:charge`,
      description: `Mobile ${operationKind.toLowerCase().replaceAll("_", " ")} edit`,
      metadata: { intent, affectedPageIndexes }
    });
    spend = reservation ? await commitReservedCredits(reservation.id) : null;
    await prisma.project.update({ where: { id: project.id }, data: { status: "EDITING" } });
    const job = await enqueueGenerationJob({
      projectId: project.id,
      type: "APPLY_BOOK_EDIT",
      payload: {
        operationId: operation.id,
        request: message,
        affectedPageIndexes,
        intentKind: intent.kind,
        ...(project.currentPlanId ? { planId: project.currentPlanId } : {}),
        ...(spend ? { billingLedgerEntryId: spend.id } : {}),
        ...(exactReplacementFromMessage(message) ? { exactReplacement: exactReplacementFromMessage(message) } : {})
      }
    });
    const updated = await prisma.bookEditOperation.update({
      where: { id: operation.id },
      data: {
        generationJobId: job.id,
        ledgerEntryId: spend?.id ?? null,
        creditsCharged: cost
      },
      include: { generationJob: { select: { id: true, status: true } } }
    });
    const reply = await createAssistantChatMessage({
      projectId: project.id,
      parentId: userMessageId,
      operationId: operation.id,
      content: operationQueuedMessage(intent.kind, affectedPageIndexes, cost, intent),
      metadata: { intent, charged: true, creditsCharged: cost }
    });
    await prisma.bookEditOperation.update({
      where: { id: operation.id },
      data: { assistantMessageId: reply.id }
    });
    return { reply, operation: updated };
  } catch (error) {
    const entryToRefund = spend ?? reservation;
    if (entryToRefund) {
      await refundCreditLedgerEntry(entryToRefund.id, "Book edit could not be queued.");
    }
    await prisma.bookEditOperation.update({
      where: { id: operation.id },
      data: { status: "FAILED", error: errorMessage(error) }
    });
    await prisma.project.update({ where: { id: project.id }, data: { status: "COMPLETE" } }).catch(() => undefined);
    if (error instanceof InsufficientCreditsError) {
      const reply = await insufficientCreditsChatMessage(project.id, userMessageId, intent, error);
      return { reply, operation: null };
    }
    throw error;
  }
}

async function queueChargedPlanRevision(options: {
  userId: string;
  projectId: string;
  planId: string;
  message: string;
  idempotencyKey: string;
  operationId?: string | undefined;
}): Promise<{ job: Awaited<ReturnType<typeof enqueueGenerationJob>>; ledgerEntry: CreditLedgerEntryRecord | null }> {
  const amountCredits = creditCostForOperation("PLAN_REVISION");
  let reservation: CreditLedgerEntryRecord | null = null;
  let spend: CreditLedgerEntryRecord | null = null;
  try {
    reservation = await reserveCredits({
      userId: options.userId,
      projectId: options.projectId,
      operation: "PLAN_REVISION",
      amountCredits,
      idempotencyKey: options.idempotencyKey,
      description: "Mobile plan revision",
      metadata: {
        planId: options.planId,
        ...(options.operationId ? { operationId: options.operationId } : {})
      }
    });
    spend = reservation ? await commitReservedCredits(reservation.id) : null;
    await prisma.project.update({ where: { id: options.projectId }, data: { status: "PLANNING" } });
    const job = await enqueueGenerationJob({
      projectId: options.projectId,
      type: "REVISE_PLAN",
      payload: {
        planId: options.planId,
        message: options.message,
        ...(spend ? { billingLedgerEntryId: spend.id } : {}),
        ...(options.operationId ? { editOperationId: options.operationId } : {})
      }
    });
    return { job, ledgerEntry: spend };
  } catch (error) {
    const entryToRefund = spend ?? reservation;
    if (entryToRefund) {
      await refundCreditLedgerEntry(entryToRefund.id, "Plan revision could not be queued.");
    }
    throw error;
  }
}

type MobileContentCard = {
  type: "outline" | "chapter" | "page";
  title: string;
  sections: Array<{ label: string; body: string }>;
};

/**
 * Free read-only replies: outline, chapter, or page content rendered by the
 * mobile app as a structured content card.
 */
async function replyWithContentCard(
  project: ProjectForChat,
  intent: BookEditIntent,
  parentId: string
): Promise<MobileProjectChatMessageRecord> {
  const target = intent.contentTarget ?? { type: "outline" as const };
  const card = contentCardForTarget(project, target);
  if (!card) {
    return createAssistantChatMessage({
      projectId: project.id,
      parentId,
      content:
        target.type === "page"
          ? "I couldn’t find that page yet. Pages appear here once they’re generated."
          : target.type === "chapter"
            ? "I couldn’t find that chapter yet."
            : "There’s no plan outline for this book yet.",
      metadata: { intent, charged: false }
    });
  }
  return createAssistantChatMessage({
    projectId: project.id,
    parentId,
    content: intent.assistantMessage,
    metadata: { intent, charged: false, contentCard: card }
  });
}

function contentCardForTarget(
  project: ProjectForChat,
  target: NonNullable<BookEditIntent["contentTarget"]>
): MobileContentCard | null {
  if (target.type === "outline") {
    const plan = project.currentPlan ? bookPlanSchema.safeParse(project.currentPlan.planningPackage) : null;
    if (plan?.success) {
      return {
        type: "outline",
        title: plan.data.title || project.title,
        sections: plan.data.chapters.map((chapter) => ({
          label: `${chapter.index}. ${chapter.title}`,
          body: chapter.summary
        }))
      };
    }
    if (project.chapters.length > 0) {
      return {
        type: "outline",
        title: project.title,
        sections: project.chapters.map((chapter) => ({
          label: `${chapter.index}. ${chapter.title}`,
          body: chapter.summary
        }))
      };
    }
    return null;
  }
  if (target.type === "chapter") {
    const chapter = project.chapters.find((candidate) => candidate.index === target.index);
    const chapterPages = project.pages.filter((page) => page.chapter?.index === target.index);
    if (!chapter && chapterPages.length === 0) {
      return null;
    }
    return {
      type: "chapter",
      title: chapter ? `Chapter ${target.index}: ${chapter.title}` : `Chapter ${target.index}`,
      sections:
        chapterPages.length > 0
          ? chapterPages.map((page) => ({
              label: `Page ${page.index}${page.title ? ` — ${page.title}` : ""}`,
              body: page.summary || page.markdown.slice(0, 280)
            }))
          : [{ label: chapter!.title, body: chapter!.summary }]
    };
  }
  const page = project.pages.find((candidate) => candidate.index === target.index);
  if (!page) {
    return null;
  }
  return {
    type: "page",
    title: `Page ${page.index}${page.title ? `: ${page.title}` : ""}`,
    sections: [{ label: page.title || `Page ${page.index}`, body: page.markdown.slice(0, 6000) }]
  };
}

const UNDOABLE_EDIT_KINDS = ["LOCAL_PATCH", "PAGE_REWRITE", "CHAPTER_REGENERATE"] as const;

/**
 * Restores the before-snapshots of the most recent applied text edit, then
 * queues an export refresh. Free: nothing is regenerated.
 */
async function undoLastBookEdit(
  project: ProjectForChat,
  intent: BookEditIntent,
  parentId: string
): Promise<MobileProjectChatMessageRecord> {
  const recentOperations = await prisma.bookEditOperation.findMany({
    where: {
      projectId: project.id,
      status: "APPLIED",
      kind: { in: [...UNDOABLE_EDIT_KINDS] }
    },
    orderBy: [{ appliedAt: "desc" }, { createdAt: "desc" }],
    take: 10,
    include: { snapshots: true }
  });
  const operation = recentOperations.find(
    (candidate) => candidate.snapshots.length > 0 && jsonRecord(candidate.classifier).undoneAt === undefined
  );
  if (!operation) {
    return createAssistantChatMessage({
      projectId: project.id,
      parentId,
      content: "There’s no recent text edit I can undo on this book.",
      metadata: { intent, charged: false }
    });
  }

  const restoredPageIndexes: number[] = [];
  await prisma.$transaction(async (tx) => {
    for (const snapshot of operation.snapshots) {
      await tx.page.update({
        where: { id: snapshot.pageId },
        data: {
          title: snapshot.titleBefore,
          markdown: snapshot.markdownBefore,
          summary: snapshot.summaryBefore,
          status: "COMPLETED",
          revision: { increment: 1 }
        }
      });
      restoredPageIndexes.push(snapshot.pageIndex);
    }
    await tx.bookEditOperation.update({
      where: { id: operation.id },
      data: {
        classifier: jsonInputValue({
          ...jsonRecord(operation.classifier),
          undoneAt: new Date().toISOString()
        })
      }
    });
  });
  restoredPageIndexes.sort((a, b) => a - b);

  if (project.currentPlanId) {
    await enqueueGenerationJob({
      projectId: project.id,
      type: "COMPILE_EXPORT",
      payload: { planId: project.currentPlanId }
    }).catch(() => undefined);
  }

  const pageText =
    restoredPageIndexes.length === 1
      ? `page ${restoredPageIndexes[0]}`
      : `pages ${restoredPageIndexes.join(", ")}`;
  return createAssistantChatMessage({
    projectId: project.id,
    parentId,
    content: `Done - I restored ${pageText} to how they were before “${operation.request.slice(0, 120)}” and I’m refreshing the exports. Undo is free.`,
    metadata: {
      intent,
      charged: false,
      undo: { operationId: operation.id, restoredPageIndexes }
    }
  });
}

async function createAssistantChatMessage(options: {
  projectId: string;
  parentId: string;
  content: string;
  metadata: Record<string, unknown>;
  operationId?: string | undefined;
}): Promise<MobileProjectChatMessageRecord> {
  return prisma.projectChatMessage.create({
    data: {
      projectId: options.projectId,
      parentId: options.parentId,
      role: "ASSISTANT",
      content: options.content,
      ...(options.operationId ? { operationId: options.operationId } : {}),
      metadata: jsonInputValue(options.metadata)
    }
  });
}

async function insufficientCreditsChatMessage(
  projectId: string,
  parentId: string,
  intent: BookEditIntent,
  error: InsufficientCreditsError
): Promise<MobileProjectChatMessageRecord> {
  return createAssistantChatMessage({
    projectId,
    parentId,
    content: `You need ${error.requiredCredits} credits for that edit, but you have ${error.availableCredits}. Add credits, then send the edit again.`,
    metadata: {
      intent,
      charged: false,
      insufficientCredits: {
        requiredCredits: error.requiredCredits,
        availableCredits: error.availableCredits,
        reservedCredits: error.reservedCredits
      }
    }
  });
}

function serializeProjectChatMessage(
  message: MobileProjectChatMessageRecord,
  branch: MobileProjectChatBranchDto | null = null
): MobileProjectChatMessageDto {
  return {
    id: message.id,
    projectId: message.projectId,
    parentId: message.parentId ?? null,
    role: message.role.toLowerCase() as MobileProjectChatMessageDto["role"],
    content: message.content,
    operationId: message.operationId,
    metadata: jsonValue(message.metadata),
    branch,
    createdAt: message.createdAt.toISOString()
  };
}

function serializeBookEditOperation(operation: MobileBookEditOperationRecord): MobileBookEditOperationDto {
  return {
    id: operation.id,
    projectId: operation.projectId,
    kind: operation.kind.toLowerCase() as MobileBookEditOperationDto["kind"],
    status: operation.status.toLowerCase() as MobileBookEditOperationDto["status"],
    affectedPageIndexes: operation.affectedPageIndexes,
    creditsCharged: operation.creditsCharged,
    currentAction: currentActionForEditOperation(operation),
    error: operation.error ?? null,
    job: operation.generationJob
      ? {
          id: operation.generationJob.id,
          status: normalizeJobStatus(operation.generationJob.status),
          currentAction: currentActionForEditOperation(operation)
        }
      : null,
    createdAt: operation.createdAt.toISOString(),
    appliedAt: operation.appliedAt?.toISOString() ?? null
  };
}

function chatPagesForProject(project: ProjectForChat): BookEditPageContext[] {
  return project.pages.map((page) => ({
    id: page.id,
    index: page.index,
    title: page.title,
    summary: page.summary,
    previewText: generatedPagePreview(page.markdown, page.summary)
  }));
}

function chatStageForProject(status: string, currentPlan: ProjectForChat["currentPlan"]): BookEditProjectStage {
  if (status === "COMPLETE") {
    return "complete";
  }
  if (currentPlan?.status === "APPROVED") {
    return "approved_plan";
  }
  if (currentPlan || status === "PLAN_READY") {
    return "plan_ready";
  }
  return "other";
}

function planSummaryForClassifier(planVersion: { planningPackage: unknown }): string {
  const parsed = bookPlanSchema.safeParse(planVersion.planningPackage);
  if (!parsed.success) {
    return "";
  }
  return [
    parsed.data.title,
    parsed.data.premise,
    parsed.data.audience,
    ...parsed.data.chapters.slice(0, 8).map((chapter) => `${chapter.index}. ${chapter.title}: ${chapter.summary}`)
  ]
    .filter(Boolean)
    .join("\n")
    .slice(0, 3000);
}

async function hasOpenProjectWork(projectId: string): Promise<boolean> {
  const count = await prisma.generationJob.count({
    where: {
      projectId,
      status: { in: ["QUEUED", "ACTIVE"] },
      type: { notIn: ["PREPARE_CHARACTER_CANDIDATES", "BUILD_CHARACTER_PERSONA", "RESEARCH"] }
    }
  });
  return count > 0;
}

function affectedPagesForIntent(
  intent: BookEditIntent,
  message: string,
  pages: ProjectForChat["pages"]
): number[] {
  const available = new Set(pages.map((page) => page.index));
  if (intent.kind === "chapter_regenerate" && intent.affectedChapterIndex) {
    return pages
      .filter((page) => page.chapter?.index === intent.affectedChapterIndex)
      .map((page) => page.index)
      .sort((a, b) => a - b);
  }
  const explicit = intent.affectedPageIndexes.filter((index) => available.has(index));
  if (explicit.length > 0) {
    return [...new Set(explicit)].sort((a, b) => a - b);
  }
  if (intent.kind === "book_replan") {
    return [];
  }
  if (intent.scope === "all_pages") {
    return pages.map((page) => page.index).sort((a, b) => a - b);
  }
  if (intent.scope === "matching_pages") {
    return pagesMatchingEditText(message, pages);
  }
  const quotedMatches = pagesMatchingQuotedText(message, pages);
  if (quotedMatches.length > 0) {
    return quotedMatches;
  }
  return [];
}

function bookEditCreditCost(kind: BookEditIntentKind, affectedPageCount: number, project: ProjectForChat): number {
  if (kind === "local_patch") {
    return CREDIT_COSTS.bookTextEditBase + Math.max(1, affectedPageCount) * CREDIT_COSTS.bookTextEditPerPage;
  }
  // Chapter regeneration is priced like a multi-page rewrite of that chapter.
  if (kind === "page_rewrite" || kind === "chapter_regenerate") {
    return Math.max(1, affectedPageCount) * CREDIT_COSTS.pageRegenerationPerPage;
  }
  if (kind === "book_replan") {
    const input = createProjectSchema.parse(inputSnapshotFromProject(project));
    return CREDIT_COSTS.bookReplanBase + estimateFullBookCreditCost(input).totalCredits;
  }
  return creditCostForOperation("PLAN_REVISION");
}

function operationKindForIntent(
  kind: BookEditIntentKind
): "LOCAL_PATCH" | "PAGE_REWRITE" | "CHAPTER_REGENERATE" | "BOOK_REPLAN" {
  if (kind === "page_rewrite") {
    return "PAGE_REWRITE";
  }
  if (kind === "chapter_regenerate") {
    return "CHAPTER_REGENERATE";
  }
  if (kind === "book_replan") {
    return "BOOK_REPLAN";
  }
  return "LOCAL_PATCH";
}

function billingOperationForIntent(kind: BookEditIntentKind): "BOOK_TEXT_EDIT" | "PAGE_REGENERATION" | "BOOK_REPLAN" {
  if (kind === "page_rewrite" || kind === "chapter_regenerate") {
    return "PAGE_REGENERATION";
  }
  if (kind === "book_replan") {
    return "BOOK_REPLAN";
  }
  return "BOOK_TEXT_EDIT";
}

function exactReplacementFromMessage(message: string): { from: string; to: string } | null {
  return replacementTermsFromMessage(message);
}

function pagesMatchingEditText(message: string, pages: ProjectForChat["pages"]): number[] {
  const replacement = replacementTermsFromMessage(message);
  if (replacement) {
    return pagesMatchingNeedle(replacement.from, pages);
  }
  return pagesMatchingQuotedText(message, pages);
}

function pagesMatchingQuotedText(message: string, pages: ProjectForChat["pages"]): number[] {
  const quotes = quotedTexts(message);
  if (quotes.length === 0) {
    return [];
  }
  return pagesMatchingNeedle(quotes[0]!, pages);
}

function pagesMatchingNeedle(needleSource: string, pages: ProjectForChat["pages"]): number[] {
  const needle = needleSource.toLowerCase();
  if (!needle) {
    return [];
  }
  return pages
    .filter((page) =>
      [page.markdown, page.title, page.summary].some((value) => value.toLowerCase().includes(needle))
    )
    .map((page) => page.index)
    .sort((a, b) => a - b);
}

function operationQueuedMessage(kind: BookEditIntentKind, affectedPageIndexes: number[], credits: number, intent: BookEditIntent): string {
  if (kind === "book_replan") {
    return `I’ll rebuild the plan and regenerate the book. This uses ${credits} credits.`;
  }
  if (kind === "chapter_regenerate") {
    const chapterText = intent.affectedChapterIndex ? `chapter ${intent.affectedChapterIndex}` : "that chapter";
    return `I’ll rewrite ${chapterText} (${affectedPageIndexes.length} page${affectedPageIndexes.length === 1 ? "" : "s"}) with that direction and refresh the exports. This uses ${credits} credits.`;
  }
  const pageText =
    intent.scope === "all_pages"
      ? "the whole book"
      : intent.scope === "matching_pages"
        ? affectedPageIndexes.length === 1
          ? `the matching text on page ${affectedPageIndexes[0]}`
          : `matching text on pages ${affectedPageIndexes.join(", ")}`
        : affectedPageIndexes.length === 1
      ? `page ${affectedPageIndexes[0]}`
      : `pages ${affectedPageIndexes.join(", ")}`;
  return kind === "page_rewrite"
    ? `I’ll rewrite ${pageText} and refresh the exports. This uses ${credits} credits.`
    : `I’ll edit ${pageText} and refresh the exports. This uses ${credits} credits.`;
}

function cleanTargetLanguage(language: string | null | undefined): string | null {
  const trimmed = language?.trim();
  return trimmed ? trimmed.slice(0, 40) : null;
}

function languageDisplayName(language: string): string {
  return language === "en" ? "English" : language;
}

function currentActionForEditOperation(operation: MobileBookEditOperationRecord): string {
  if (operation.status === "FAILED") {
    if (operation.kind === "PLAN_REVISION") {
      return "Plan revision failed.";
    }
    return "Edit failed.";
  }
  if (operation.status === "APPLIED") {
    return "Edit applied.";
  }
  if (operation.kind === "BOOK_REPLAN") {
    return "Rebuilding a new copy.";
  }
  if (operation.kind === "PAGE_REWRITE") {
    return "Rewriting selected pages.";
  }
  if (operation.kind === "CHAPTER_REGENERATE") {
    return "Rewriting the chapter.";
  }
  if (operation.kind === "PLAN_REVISION") {
    return "Revising the plan.";
  }
  return "Applying text edits.";
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
    presets: persistedPresetsForTurn(payload),
    sourceNotes: payload.sourceNotes,
    optionalDetails: payload.optionalDetails,
    language: payload.language,
    conversationSummary: payload.conversationSummary
  };
}

const CREATION_TRANSCRIPT_CAP = 60;
const CREATION_SUMMARY_MAX = 2400;

/**
 * Folds messages that fall past the transcript cap into a compact rolling
 * summary instead of silently dropping them, so long chats keep their context.
 */
function foldCreationTranscript(
  messages: MobileCreationMessage[],
  existingSummary: string | undefined
): { messages: MobileCreationMessage[]; conversationSummary: string | undefined } {
  if (messages.length <= CREATION_TRANSCRIPT_CAP) {
    return { messages, conversationSummary: existingSummary };
  }
  const dropped = messages.slice(0, messages.length - CREATION_TRANSCRIPT_CAP);
  const kept = messages.slice(-CREATION_TRANSCRIPT_CAP);
  const droppedLines = dropped
    .map((message) => `${message.role === "user" ? "User" : "Assistant"}: ${message.content.replace(/\s+/g, " ").slice(0, 160)}`)
    .join("\n");
  const combined = [existingSummary?.trim(), droppedLines].filter(Boolean).join("\n");
  // Keep the newest folded content when the summary itself overflows.
  const conversationSummary = combined.length > CREATION_SUMMARY_MAX ? combined.slice(-CREATION_SUMMARY_MAX) : combined;
  return { messages: kept, conversationSummary: conversationSummary || undefined };
}

function persistedPresetsForTurn(payload: MobileCreationDraftPayload): MobileCreationDraftPayload["selectedPresets"] {
  return payload.selectedPresets;
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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown error";
}

function hashString(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 24);
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
  const hasExistingPlan = Boolean(project.currentPlanId || project.currentPlan);

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
    currentAction: currentActionForProject(project.status, progressPercent, { hasExistingPlan }),
    promptPreview: previewText(project.prompt),
    targetPages: project.targetPages,
    pageCount,
    imageCount,
    hasPlan: hasExistingPlan,
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

async function loadSerializedProjectStatus(
  projectId: string,
  appConfig: ReturnType<typeof loadConfig>,
  userId: string
): Promise<MobileProjectStatusDto | null> {
  const status = await buildProjectStatus(projectId);
  if (!status) {
    return null;
  }
  const exports = await serializeExportSet(projectId, status.project.title, appConfig, userId);
  return serializeProjectStatus(status, exports);
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
  if (projectStatus === "EDITING") {
    return 92;
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
  if (status === "EDITING") {
    return 92;
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

function currentActionForProject(
  status: string,
  progressPercent: number,
  options: { hasExistingPlan?: boolean } = {}
): string {
  switch (status) {
    case "DRAFT":
      return "Ready to create a book plan.";
    case "PLANNING":
      return options.hasExistingPlan ? "Revising your book plan." : "Creating your book plan.";
    case "PLAN_READY":
      return "Ready for review.";
    case "GENERATING":
      return progressPercent >= 90 ? "Preparing downloads." : "Writing your book.";
    case "EDITING":
      return "Editing your book.";
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
    case "EDITING":
      return "Editing your book";
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
    APPLY_BOOK_EDIT: "editing your book",
    REPLAN_BOOK: "rebuilding your book plan",
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
  const bookType = z.union([mobileBookTypeSchema, z.literal("custom")]).safeParse(metadata.bookType);
  const bookTypeChoice = mobileBookTypeChoiceSchema.optional().safeParse(metadata.bookTypeChoice);
  const lengthPreset = z.union([mobileLengthPresetSchema, z.literal("custom")]).safeParse(metadata.lengthPreset);
  const qualityPreset = mobileQualityPresetSchema.safeParse(metadata.qualityPreset);
  const pageCountMode = mobilePageCountModeSchema.default("auto").safeParse(metadata.pageCountMode);
  const targetPages = mobileTargetPagesSchema.safeParse(metadata.targetPages);
  const pageCountSource = mobilePageCountSourceSchema.default("legacy").safeParse(metadata.pageCountSource);
  if (
    !bookType.success ||
    !bookTypeChoice.success ||
    !lengthPreset.success ||
    !qualityPreset.success ||
    !pageCountMode.success ||
    !pageCountSource.success ||
    typeof metadata.imagesEnabled !== "boolean"
  ) {
    return null;
  }
  return {
    bookType: bookType.data,
    bookTypeChoice: bookTypeChoice.data ?? (bookType.data === "custom" ? "auto" : bookType.data),
    lengthPreset: lengthPreset.data,
    qualityPreset: qualityPreset.data,
    imagesEnabled: metadata.imagesEnabled,
    pageCountMode: pageCountMode.data,
    targetPages: targetPages.success ? targetPages.data : 0,
    pageCountSource: pageCountSource.data
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

function isLiveProjectStatus(status: string): boolean {
  return status === "planning" || status === "generating" || status === "editing";
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
