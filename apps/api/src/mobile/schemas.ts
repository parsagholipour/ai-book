import {
  mobileBookAdvisorResponseSchema,
  mobileBookTypeChoiceSchema,
  mobileCreationBriefSchema,
  mobileCreationDraftPayloadSchema,
  mobileCreationOptionalDetailsSchema,
  mobileCreationPresetsInputSchema,
  mobilePageCountModeSchema,
  mobilePageCountSourceSchema,
  mobileTargetPagesSchema,
  resolveMobileImageSettings
} from "../mobileCreation.js";
import { type GenerationJobType } from "../queue.js";
import { type MobileBookType, type MobileLengthPreset, type MobileQualityPreset } from "./dto.js";
import { PROJECT_PROMPT_MAX_LENGTH, type CreateProjectInput, type ModelTier, type ToneProfile } from "@book-maker/core";
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

export const creditLogQuerySchema = z.object({
  /** The id of the last entry already shown; the page resumes after it. */
  cursor: z.string().trim().min(1).max(128).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(30)
});

export const assetParamsSchema = z.object({ id: z.string().min(1), assetId: z.string().min(1) });

export const operationParamsSchema = z.object({ id: z.string().min(1), operationId: z.string().min(1) });

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

/**
 * Voice calls get their own budget rather than sharing the generation one.
 * Placing a call is cheap for us — the cost is metered in credits by the
 * minute — so the only job here is to stop a runaway client, not to ration a
 * feature the user has already paid for. Sharing the 12/hour generation budget
 * meant a few calls locked the user out of writing books.
 */
export const DEFAULT_VOICE_CALL_RATE_LIMIT = { maxAttempts: 40, windowMs: 60 * 60 * 1000 };

export const DEFAULT_ATTACHMENT_RATE_LIMIT = { maxAttempts: 60, windowMs: 60 * 60 * 1000 };

export const DEFAULT_CREATION_TURN_TIMEOUT_MS = 85_000;

export const UNTITLED_MOBILE_PROJECT_TITLE = "Untitled Book";

export const MOBILE_TITLE_SOURCE_PLANNER_PENDING = "planner_pending";

/**
 * What a client may type into the create-project body. Deliberately far below
 * the domain ceiling — a prompt the server composes from a creation chat is
 * validated by `mobileComposedProjectCreateSchema` instead.
 */
const MOBILE_TYPED_PROMPT_MAX = 5000;

const mobileProjectCreateFields = {
  bookType: mobileBookTypeSchema,
  bookTypeChoice: mobileBookTypeChoiceSchema.optional(),
  title: z.string().trim().min(2).max(160).optional(),
  authorName: z.string().trim().min(1).max(120).optional(),
  lengthPreset: mobileLengthPresetSchema.default("standard"),
  qualityPreset: mobileQualityPresetSchema.default("balanced"),
  /** @deprecated Send coverEnabled and illustrationsEnabled instead. */
  imagesEnabled: z.boolean().optional(),
  coverEnabled: z.boolean().optional(),
  illustrationsEnabled: z.boolean().optional(),
  pageCountMode: mobilePageCountModeSchema.default("auto"),
  targetPages: mobileTargetPagesSchema.optional(),
  pageCountSource: mobilePageCountSourceSchema.optional(),
  language: z.string().trim().min(2).max(40).default("en"),
  creationBrief: mobileCreationBriefSchema.optional(),
  creationPayload: mobileCreationDraftPayloadSchema.optional(),
  advisor: mobileBookAdvisorResponseSchema.optional()
} as const;

export const mobileProjectCreateBodySchema = z
  .object({
    ...mobileProjectCreateFields,
    prompt: z.string().trim().min(10).max(MOBILE_TYPED_PROMPT_MAX)
  })
  .strict()
  .transform((input) => ({ ...input, ...resolveMobileImageSettings(input) }));

/**
 * The same shape, but for a prompt the server composed rather than one a
 * client sent. `composeMobileProjectPrompt` folds the creation chat and its
 * web research into the prompt, so a session that ran a search clears
 * MOBILE_TYPED_PROMPT_MAX on its own; validating that against the typed-input
 * cap threw a ZodError out of the build route as a 500. The untrusted body is
 * still checked against the stricter schema at the route, before this runs.
 */
export const mobileComposedProjectCreateSchema = z
  .object({
    ...mobileProjectCreateFields,
    prompt: z.string().trim().min(10).max(PROJECT_PROMPT_MAX_LENGTH)
  })
  .strict()
  .transform((input) => ({ ...input, ...resolveMobileImageSettings(input) }));

export const mobilePlanRevisionBodySchema = z
  .object({
    message: z.string().trim().min(1).max(5000),
    requestId: requestIdSchema.optional()
  })
  .strict();

export const mobilePlanApprovalBodySchema = z.object({ requestId: requestIdSchema.optional() }).strict().default({});

export const mobileAudiobookStartBodySchema = z
  .object({
    voice: z.string().trim().min(1).max(60),
    /** Required to re-narrate a book that already has a finished audiobook. */
    replace: z.boolean().optional(),
    requestId: requestIdSchema.optional()
  })
  .strict();

export const mobileAudiobookChapterParamsSchema = z.object({
  id: z.string().min(1),
  index: z.coerce.number().int().min(0).max(10_000)
});

export const mobileVoiceSampleParamsSchema = z.object({ voice: z.string().trim().min(1).max(60) });

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
    presets: mobileCreationPresetsInputSchema.optional(),
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
    presets: mobileCreationPresetsInputSchema.optional(),
    sourceNotes: z.string().trim().max(12000).optional(),
    optionalDetails: mobileCreationOptionalDetailsSchema.optional(),
    requestId: requestIdSchema.optional()
  })
  .strict()
  .default({});

export const mobileCreationBuildBodySchema = z
  .object({
    presets: mobileCreationPresetsInputSchema.optional(),
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
    imagesEnabled: {
      type: "boolean",
      default: true,
      deprecated: true,
      description: "Compatibility aggregate. Prefer coverEnabled and illustrationsEnabled."
    },
    coverEnabled: { type: "boolean", default: true },
    illustrationsEnabled: { type: "boolean", default: true },
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

export const mobileAudiobookStartOpenApiBody = {
  type: "object",
  additionalProperties: false,
  properties: {
    voice: { type: "string", minLength: 1, maxLength: 60 },
    replace: { type: "boolean" },
    requestId: { type: "string", minLength: 8, maxLength: 64 }
  },
  required: ["voice"]
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

export const voiceCharacterParamsSchema = z.object({
  id: z.string().min(1),
  characterId: z.string().min(1)
});

export const voiceCallParamsSchema = z.object({ callId: z.string().min(1) });

/**
 * `pageIndex` is where the reader was when they placed the call. It scopes what
 * the character is told about the book, which is what keeps a call from the
 * middle of a story free of spoilers.
 */
export const mobileVoiceCallStartBodySchema = z
  .object({
    pageIndex: z.number().int().min(0).max(5000).optional()
  })
  .strict();

/**
 * `messages` is the stretch of transcript the app heard since its last report.
 *
 * It is sent in batches rather than all at once at the end because the app
 * keeps only a screenful of captions, and because a call that dies with the app
 * never gets to send an end. What arrives is appended to the call, and read
 * back the next time the reader rings the same character.
 */
export const mobileVoiceCallProgressBodySchema = z
  .object({
    elapsedSeconds: z.number().int().min(0).max(24 * 60 * 60),
    reason: z.string().trim().min(1).max(60).optional(),
    messages: z
      .array(
        z
          .object({
            speaker: z.enum(["caller", "character"]),
            text: z.string().trim().min(1).max(2000)
          })
          .strict()
      )
      .max(60)
      .optional()
  })
  .strict();

export const mobileVoiceCallStartOpenApiBody = {
  type: "object",
  additionalProperties: false,
  properties: {
    pageIndex: { type: "integer", minimum: 0, maximum: 5000 }
  }
} as const;

export const mobileVoiceCallProgressOpenApiBody = {
  type: "object",
  additionalProperties: false,
  properties: {
    elapsedSeconds: { type: "integer", minimum: 0 },
    reason: { type: "string", minLength: 1, maxLength: 60 },
    messages: {
      type: "array",
      maxItems: 60,
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          speaker: { type: "string", enum: ["caller", "character"] },
          text: { type: "string", minLength: 1, maxLength: 2000 }
        },
        required: ["speaker", "text"]
      }
    }
  },
  required: ["elapsedSeconds"]
} as const;
