import {
  mobileBookAdvisorResponseSchema,
  mobileBookTypeChoiceSchema,
  mobileCreationBriefSchema,
  mobileCreationDraftPayloadSchema,
  mobileCreationOptionalDetailsSchema,
  mobileCreationPresetsSchema,
  mobilePageCountModeSchema,
  mobilePageCountSourceSchema,
  mobileTargetPagesSchema
} from "../mobileCreation.js";
import { type GenerationJobType } from "../queue.js";
import { type MobileBookType, type MobileLengthPreset, type MobileQualityPreset } from "./dto.js";
import { type CreateProjectInput, type ModelTier, type ToneProfile } from "@book-maker/core";
import { z } from "zod";

/**
 * Zod request schemas, OpenAPI body fragments, and the product/preset tables
 * that define what the mobile API accepts.
 */

export const mobileBookTypeSchema = z.enum(["lead_magnet", "workbook", "short_story"]);

export const mobileLengthPresetSchema = z.enum(["short", "standard", "expanded"]);

export const mobileQualityPresetSchema = z.enum(["fast", "balanced", "premium"]);

export const idParamsSchema = z.object({ id: z.string().min(1) });

export const projectChatQuerySchema = z.object({
  beforeMessageId: z.string().trim().min(1).max(128).optional(),
  limit: z.coerce.number().int().min(1).max(150).default(150)
});

export const assetParamsSchema = z.object({ id: z.string().min(1), assetId: z.string().min(1) });

export const attachmentParamsSchema = z.object({ id: z.string().min(1), attachmentId: z.string().min(1).max(64) });

export const attachmentUploadQuerySchema = z.object({
  filename: z.string().trim().min(1).max(300),
  mimeType: z.string().trim().max(160).optional(),
  expectedRevision: z.coerce.number().int().positive().optional()
});

export const creationMutationQuerySchema = z.object({
  expectedRevision: z.coerce.number().int().positive().optional()
});

export const requestIdSchema = z.string().trim().min(8).max(64);

export const operationRetryBodySchema = z.object({ requestId: requestIdSchema }).strict();

export const mobileAssetFilenameSchema = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,180}$/);

export const retryablePlanningJobTypes: GenerationJobType[] = ["PLAN_BOOK", "REVISE_PLAN"];

export const resumableJobTypes: GenerationJobType[] = ["GENERATE_PAGE", "GENERATE_IMAGE", "COMPILE_EXPORT", "APPLY_BOOK_EDIT"];

export const restartableJobTypes: GenerationJobType[] = ["GENERATE_BOOK", "REPLAN_BOOK"];

export const generationFailureJobTypes = [...retryablePlanningJobTypes, ...resumableJobTypes, ...restartableJobTypes];

export const DEFAULT_GENERATION_RATE_LIMIT = { maxAttempts: 12, windowMs: 60 * 60 * 1000 };

export const DEFAULT_BILLING_VERIFICATION_RATE_LIMIT = { maxAttempts: 20, windowMs: 60 * 60 * 1000 };

export const DEFAULT_ADVISOR_RATE_LIMIT = { maxAttempts: 20, windowMs: 60 * 60 * 1000 };

export const DEFAULT_DRAFT_RATE_LIMIT = { maxAttempts: 120, windowMs: 60 * 60 * 1000 };

export const DEFAULT_ATTACHMENT_RATE_LIMIT = { maxAttempts: 60, windowMs: 60 * 60 * 1000 };

export const DEFAULT_CREATION_TURN_TIMEOUT_MS = 85_000;

export const UNTITLED_MOBILE_PROJECT_TITLE = "Untitled Book";

export const MOBILE_TITLE_SOURCE_PLANNER_PENDING = "planner_pending";

export const mobileProjectCreateBodySchema = z
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

export const mobilePlanRevisionBodySchema = z
  .object({
    message: z.string().trim().min(1).max(5000),
    requestId: requestIdSchema.optional()
  })
  .strict();

export const mobilePlanApprovalBodySchema = z.object({ requestId: requestIdSchema.optional() }).strict().default({});

export const mobileProjectChatMessageBodySchema = z
  .object({
    message: z.string().trim().min(1).max(5000),
    editMessageId: z.string().trim().min(1).max(128).optional(),
    requestId: requestIdSchema.optional()
  })
  .strict();

export const mobileEditProposalActionBodySchema = z
  .object({
    proposalId: z.string().uuid(),
    requestId: requestIdSchema.optional()
  })
  .strict();

export const mobileChatUndoBodySchema = z
  .object({
    requestId: requestIdSchema.optional()
  })
  .strict()
  .default({});

export const mobileProjectChatBranchBodySchema = z
  .object({
    messageId: z.string().trim().min(1).max(128),
    direction: z.enum(["previous", "next"])
  })
  .strict();

export const mobileCreationBranchBodySchema = mobileProjectChatBranchBodySchema.extend({
  expectedRevision: z.number().int().positive().optional()
});

export const mobileManualBookEditBodySchema = z
  .object({
    pages: z
      .array(
        z
          .object({
            id: z.string().trim().min(1).max(128),
            title: z.string().trim().min(1).max(300),
            markdown: z.string().min(1).max(60000),
            baseRevision: z.number().int().min(1)
          })
          .strict()
      )
      .min(1)
      .max(200),
    savedExportMessageId: z.string().trim().min(1).max(128).optional(),
    requestId: requestIdSchema.optional()
  })
  .strict();

export const mobileCreationMessageBodySchema = z
  .object({
    // Empty text is allowed when the message carries attachments.
    message: z.string().trim().max(4000).default(""),
    attachmentIds: z.array(z.string().trim().min(1).max(64)).max(6).optional(),
    presets: mobileCreationPresetsSchema.optional(),
    sourceNotes: z.string().trim().max(12000).optional(),
    optionalDetails: mobileCreationOptionalDetailsSchema.optional(),
    requestId: requestIdSchema.optional(),
    expectedRevision: z.number().int().positive().optional(),
    // When set, the message replaces a prior user message as a new branch.
    editMessageId: z.string().trim().min(1).max(64).optional()
  })
  .strict()
  .refine((body) => body.message.length > 0 || (body.attachmentIds?.length ?? 0) > 0, {
    message: "Send a message or an attachment."
  });

export const mobileCreationSessionStartBodySchema = z
  .object({
    message: z.string().trim().min(1).max(4000).optional(),
    presets: mobileCreationPresetsSchema.optional(),
    sourceNotes: z.string().trim().max(12000).optional(),
    optionalDetails: mobileCreationOptionalDetailsSchema.optional(),
    requestId: requestIdSchema.optional()
  })
  .strict()
  .default({});

export const mobileCreationBuildBodySchema = z
  .object({
    presets: mobileCreationPresetsSchema.optional(),
    sourceNotes: z.string().trim().max(12000).optional(),
    optionalDetails: mobileCreationOptionalDetailsSchema.optional(),
    language: z.string().trim().min(2).max(40).optional(),
    requestId: requestIdSchema.optional(),
    expectedRevision: z.number().int().positive().optional()
  })
  .strict();

export const mobilePageCountRecommendationSchema = z
  .object({
    targetPages: mobileTargetPagesSchema,
    label: z.string().trim().min(1).max(80),
    description: z.string().trim().min(1).max(180)
  })
  .strict();

export const mobilePageCountRecommendationAiSchema = z
  .object({
    recommendations: z.array(mobilePageCountRecommendationSchema).min(2).max(4)
  })
  .strict();

export const emptyMobilePlanBodySchema = z.object({}).strict().default({});

export const mobileGooglePlayVerificationBodySchema = z
  .object({
    productId: z.string().trim().min(3).max(160),
    purchaseToken: z.string().trim().min(8).max(8000),
    transactionId: z.string().trim().min(1).max(240).optional(),
    purchaseStatus: z.enum(["purchased", "restored"]).optional(),
    projectId: z.string().trim().min(1).max(160).optional()
  })
  .strict();

export const MOBILE_BOOK_TYPE_SETTINGS: Record<
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

export const MOBILE_AUTO_BOOK_TYPE_SETTINGS = {
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

export const mobileAuthError = {
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

export const mobileProjectCreateOpenApiBody = {
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

export const mobilePlanRevisionOpenApiBody = {
  type: "object",
  additionalProperties: false,
  properties: {
    message: { type: "string", minLength: 1, maxLength: 5000 },
    requestId: { type: "string", minLength: 8, maxLength: 64 }
  },
  required: ["message"]
} as const;

export const mobileProjectChatMessageOpenApiBody = {
  type: "object",
  additionalProperties: false,
  properties: {
    message: { type: "string", minLength: 1, maxLength: 5000 },
    editMessageId: { type: "string", minLength: 1, maxLength: 128 },
    requestId: { type: "string", minLength: 8, maxLength: 64 }
  },
  required: ["message"]
} as const;

export const mobileProjectChatBranchOpenApiBody = {
  type: "object",
  additionalProperties: false,
  properties: {
    messageId: { type: "string", minLength: 1, maxLength: 128 },
    direction: { type: "string", enum: ["previous", "next"] }
  },
  required: ["messageId", "direction"]
} as const;

export const mobileEditProposalActionOpenApiBody = {
  type: "object",
  additionalProperties: false,
  properties: {
    proposalId: { type: "string", format: "uuid" },
    requestId: { type: "string", minLength: 8, maxLength: 64 }
  },
  required: ["proposalId"]
} as const;

export const mobileChatUndoOpenApiBody = {
  type: "object",
  additionalProperties: false,
  properties: {
    requestId: { type: "string", minLength: 8, maxLength: 64 }
  }
} as const;

export const mobileManualBookEditOpenApiBody = {
  type: "object",
  additionalProperties: false,
  properties: {
    pages: {
      type: "array",
      minItems: 1,
      maxItems: 200,
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          id: { type: "string", minLength: 1, maxLength: 128 },
          title: { type: "string", minLength: 1, maxLength: 300 },
          markdown: { type: "string", minLength: 1, maxLength: 60000 },
          baseRevision: { type: "integer", minimum: 1 }
        },
        required: ["id", "title", "markdown", "baseRevision"]
      }
    },
    savedExportMessageId: { type: "string", minLength: 1, maxLength: 128 },
    requestId: { type: "string", minLength: 8, maxLength: 64 }
  },
  required: ["pages"]
} as const;
