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
import { type MobileBookType, type MobileLengthPreset, type MobileQualityPreset } from "./dto.js";
import { PROJECT_PROMPT_MAX_LENGTH, type CreateProjectInput, type ModelTier, type ToneProfile } from "@book-maker/core";
import { z } from "zod";

/**
 * Zod request schemas, generated OpenAPI body schemas, and the product/preset tables
 * that define what the mobile API accepts.
 */

export function toOpenApiRequestBody<Schema extends z.ZodType>(
  schema: Schema
): z.core.JSONSchema.ObjectSchema {
  const body = z.toJSONSchema(schema, { io: "input", target: "openapi-3.0" });
  if (body.type !== "object") {
    throw new TypeError("A request body schema must describe an object.");
  }
  // Fastify/Ajv rejects defaults at a schema root in strict mode. A root
  // default cannot supply an absent HTTP body anyway; property defaults stay.
  delete body.default;
  delete body.$schema;
  return body as z.core.JSONSchema.ObjectSchema;
}

export const mobileBookTypeSchema = z.enum(["lead_magnet", "workbook", "short_story"]);

export const mobileLengthPresetSchema = z.enum(["short", "standard", "expanded"]);

export const mobileQualityPresetSchema = z.enum(["fast", "balanced", "premium", "ultra"]);

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

/** The idempotency key a priced write may carry, shared by every request schema. */
export const REQUEST_ID_MIN_LENGTH = 8;
export const REQUEST_ID_MAX_LENGTH = 64;
export const requestIdSchema = z.string().trim().min(REQUEST_ID_MIN_LENGTH).max(REQUEST_ID_MAX_LENGTH);

export const operationRetryBodySchema = z
  .object({ requestId: requestIdSchema, retryToken: z.string().trim().min(16).max(128) })
  .strict();

export const generationRetryBodySchema = z
  .object({ requestId: requestIdSchema, retryToken: z.string().trim().min(16).max(128) })
  .strict();

export const mobileGenerationRetryOpenApiBody = toOpenApiRequestBody(generationRetryBodySchema);

export const mobileAssetFilenameSchema = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,180}$/);

// One definition, in a leaf: `projectStatus.ts` and `routes/projects.ts` carried
// byte-identical copies, and they cannot import them from here because this file
// reaches `projectStatus.ts` through `./dto.js`. Re-exported under the original
// names so every existing importer of this module is unaffected.
export {
  generationFailureJobTypes,
  restartableJobTypes,
  resumableJobTypes,
  retryablePlanningJobTypes
} from "../generationJobTypes.js";

export const DEFAULT_GENERATION_RATE_LIMIT = { maxAttempts: 12, windowMs: 60 * 60 * 1000 };

export const DEFAULT_BILLING_VERIFICATION_RATE_LIMIT = { maxAttempts: 20, windowMs: 60 * 60 * 1000 };

export const DEFAULT_ADVISOR_RATE_LIMIT = { maxAttempts: 20, windowMs: 60 * 60 * 1000 };

export const DEFAULT_DRAFT_RATE_LIMIT = { maxAttempts: 120, windowMs: 60 * 60 * 1000 };

/**
 * Emptying the character library gets its own budget rather than the drafting
 * one, and a more generous one.
 *
 * `DEFAULT_DRAFT_RATE_LIMIT` is sized for *typing* — chat turns, creation
 * drafts, character edits — where 120 an hour is far more than a person writes
 * and anything past it is a client in a loop. A cleanup is not typing. The
 * library caps at `LIBRARY_CHARACTER_LIMIT_PER_USER` (100, in
 * `characterSchemas.ts`; not imported here, because that module imports this
 * one), so emptying a full one is a hundred requests the reader confirmed one
 * by one — and on the shared `character-write` bucket the next few edits or
 * promotes then answered 429 on a destructive gesture, with nothing on the
 * character screen able to say why some rows went and some did not.
 *
 * It can afford to be generous because what makes a delete expensive is bounded
 * by the door in front of it rather than by this number: the costly path — two
 * transactions claiming the row plus every character whose description mentions
 * it — needs a row that still exists, and every one of those had to be created
 * through the 120/hour bucket above. A delete with nothing left to delete is one
 * indexed read and a 404. So this ceiling stops a runaway client; it is not
 * where the work is rationed. It is a bucket of its own so that a cleanup can
 * never spend the tokens the reader's next edit needs, in either direction.
 */
export const DEFAULT_CHARACTER_DELETE_RATE_LIMIT = { maxAttempts: 300, windowMs: 60 * 60 * 1000 };

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
    requestId: requestIdSchema.optional(),
    /**
     * The plan questions this revision answers, by their prompt text. The
     * reviser filters them from the next version's questions so the reader is
     * never re-asked something they already answered — the web operator path
     * has always sent this; without it the guarantee was prompt-only here.
     */
    respondedQuestionPrompts: z.array(z.string().trim().min(1).max(1000)).max(40).optional()
  })
  .strict();

export const mobilePlanApprovalBodySchema = z
  .object({
    requestId: requestIdSchema.optional(),
    /**
     * Explicit reader choice to generate without interior illustrations —
     * offered when the free tier's monthly illustrated-book budget is spent.
     * Never inferred: the server refuses with IMAGE_LIMIT_REACHED and only the
     * reader's tap sets this, because a silent downgrade would deliver a
     * different book than the plan promised.
     */
    disableIllustrations: z.boolean().optional()
  })
  .strict()
  .default({});

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
    // The earlier message this one is a reply to. Any role can be replied to.
    // It is quoted for the model only — never folded into the routed text.
    replyToMessageId: z.string().trim().min(1).max(128).optional(),
    // Library characters @-mentioned in this message. Their sheets ride the
    // stored edit request, never the routed text or the visible transcript.
    mentionedCharacterIds: z.array(z.string().trim().min(1).max(64)).max(10).optional(),
    // Where in the book a reader-selection message was composed: the book page
    // the app's locator resolved (authoritative for targeting), the physical
    // PDF sheet the reader saw, and the identity of the file they were reading
    // it in — so the server never re-guesses a position the app already knows.
    // `pdfPage` is a sheet number in one exact PDF, so it travels with that
    // file's `pdfDigest`: a repair republishes the same `contentRevision` over
    // different bytes, and without the digest the sheet would be translated
    // through the replacement's map. Both identity fields are required before
    // `pdfPage` is read at all — see `modelPageForReaderContext`.
    readerContext: z
      .object({
        pageIndex: z.number().int().min(1).max(10_000).optional(),
        pdfPage: z.number().int().min(1).max(20_000).optional(),
        contentRevision: z.number().int().min(0).optional(),
        pdfDigest: z.string().trim().min(1).max(128).optional()
      })
      .strict()
      .optional(),
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
  expectedRevision: z.number().int().min(1).optional()
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
    // Library characters @-mentioned in this message.
    mentionedCharacterIds: z.array(z.string().trim().min(1).max(64)).max(10).optional(),
    presets: mobileCreationPresetsInputSchema.optional(),
    sourceNotes: z.string().trim().max(12000).optional(),
    optionalDetails: mobileCreationOptionalDetailsSchema.optional(),
    requestId: requestIdSchema.optional(),
    expectedRevision: z.number().int().min(1).optional(),
    // When set, the message replaces a prior user message as a new branch.
    editMessageId: z.string().trim().min(1).max(64).optional(),
    // When set, the message is a reply quoting an earlier turn of either role.
    replyToMessageId: z.string().trim().min(1).max(64).optional(),
    // The message is a question-skip tap; excluded from rawIdea server-side.
    skippedQuestion: z.boolean().optional()
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
    // Library characters @-mentioned in the opening message.
    mentionedCharacterIds: z.array(z.string().trim().min(1).max(64)).max(10).optional(),
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
    expectedRevision: z.number().int().min(1).optional()
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
    // Not 2: every mobile length routes to a strategy that never reads
    // best-of drafting, so the knob only distorted the premium price. The
    // tier's value is the premium model routing, which applies everywhere.
    draftCandidates: 1,
    modelTier: "premium"
  },
  ultra: {
    label: "Ultra effort",
    complexity: 7,
    temperature: 0.55,
    finalReview: true,
    draftCandidates: 2,
    modelTier: "ultra"
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

export const mobileProjectCreateOpenApiBody = toOpenApiRequestBody(mobileProjectCreateBodySchema);
export const mobileAudiobookStartOpenApiBody = toOpenApiRequestBody(mobileAudiobookStartBodySchema);
export const mobilePlanApprovalOpenApiBody = toOpenApiRequestBody(mobilePlanApprovalBodySchema);
export const mobileOperationRetryOpenApiBody = toOpenApiRequestBody(operationRetryBodySchema);
export const mobilePlanRevisionOpenApiBody = toOpenApiRequestBody(mobilePlanRevisionBodySchema);
export const mobileProjectChatMessageOpenApiBody = toOpenApiRequestBody(mobileProjectChatMessageBodySchema);
export const mobileProjectChatBranchOpenApiBody = toOpenApiRequestBody(mobileProjectChatBranchBodySchema);
export const mobileCreationBranchOpenApiBody = toOpenApiRequestBody(mobileCreationBranchBodySchema);
export const mobileCreationSessionStartOpenApiBody = toOpenApiRequestBody(mobileCreationSessionStartBodySchema);
export const mobileCreationMessageOpenApiBody = toOpenApiRequestBody(mobileCreationMessageBodySchema);
export const mobileCreationBuildOpenApiBody = toOpenApiRequestBody(mobileCreationBuildBodySchema);
export const mobileEditProposalActionOpenApiBody = toOpenApiRequestBody(mobileEditProposalActionBodySchema);
export const mobileChatUndoOpenApiBody = toOpenApiRequestBody(mobileChatUndoBodySchema);
export const mobileManualBookEditOpenApiBody = toOpenApiRequestBody(mobileManualBookEditBodySchema);

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

export const mobileVoiceCallStartOpenApiBody = toOpenApiRequestBody(mobileVoiceCallStartBodySchema);
export const mobileVoiceCallProgressOpenApiBody = toOpenApiRequestBody(mobileVoiceCallProgressBodySchema);
