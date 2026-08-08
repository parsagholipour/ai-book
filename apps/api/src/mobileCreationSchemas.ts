import {
  CREATION_ATTACHMENT_MAX_COUNT,
  creationAttachmentKindSchema,
  creationAttachmentSchema
} from "@book-maker/core";
import { z } from "zod";
import { CHAT_REPLY_EXCERPT_MAX } from "./chatReplyQuote.js";
import { creationTurnQuestionSchema } from "./creationQuestion.js";

/**
 * The mobile creation flow's request/payload schema wall and the types drawn
 * from it. Split out of mobileCreation.ts, which re-exports everything here,
 * so importers of "mobileCreation.js" are unaffected.
 */

const mobileBookTypeSchema = z.enum(["lead_magnet", "workbook", "short_story"]);
export const mobileBookTypeChoiceSchema = z.enum([
  "auto",
  "lead_magnet",
  "practical_guide",
  "offer_guide",
  "workbook",
  "client_tool",
  "short_story",
  "adult_story",
  "children_story"
]);
const mobileLengthPresetSchema = z.enum(["short", "standard", "expanded"]);
const mobileQualityPresetSchema = z.enum(["fast", "balanced", "premium"]);
export const mobilePageCountModeSchema = z.enum(["auto", "custom"]);
export const mobilePageCountSourceSchema = z.enum(["chat", "settings", "recommended", "legacy"]);
export const mobileTargetPagesSchema = z.coerce.number().int().min(1).max(600);

export const mobileCreationIntentSchema = z.enum([
  "collect_leads",
  "teach_practice",
  "support_clients",
  "explain_offer",
  "short_story"
]);

export const mobileCreationLaneSchema = z.enum([
  "auto",
  "lead_magnet",
  "workbook",
  "client_tool",
  "offer_guide",
  "practical_guide",
  "adult_story",
  "children_story"
]);

const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .default("");

const optionalNamedText = (min: number, max: number) =>
  z.preprocess(
    (value) => {
      if (typeof value !== "string") {
        return value;
      }
      const trimmed = value.trim();
      return trimmed.length > 0 ? trimmed : undefined;
    },
    z.string().trim().min(min).max(max).optional()
  );

export const mobileCreationBriefSchema = z
  .object({
    intent: mobileCreationIntentSchema.default("collect_leads"),
    topic: optionalText(280),
    audience: optionalText(280),
    readerProblem: optionalText(500),
    desiredOutcome: optionalText(500),
    tone: optionalText(180),
    mustInclude: optionalText(1200),
    distributionUse: optionalText(220),
    title: optionalNamedText(2, 160),
    authorName: optionalNamedText(1, 120),
    sourceNotes: optionalText(12000)
  })
  .strict();

export const mobileCreationPresetsInputSchema = z
  .object({
    bookType: mobileBookTypeSchema,
    bookTypeChoice: mobileBookTypeChoiceSchema.optional(),
    lengthPreset: mobileLengthPresetSchema,
    qualityPreset: mobileQualityPresetSchema,
    /** @deprecated Send coverEnabled and illustrationsEnabled instead. */
    imagesEnabled: z.boolean().optional(),
    coverEnabled: z.boolean().optional(),
    illustrationsEnabled: z.boolean().optional(),
    pageCountMode: mobilePageCountModeSchema.optional(),
    targetPages: mobileTargetPagesSchema.optional(),
    pageCountSource: mobilePageCountSourceSchema.optional()
  })
  .strict();

export type MobileCreationPresetsInput = z.input<typeof mobileCreationPresetsInputSchema>;

/**
 * The one resolution of the image trio: either split field wins for itself,
 * the legacy `imagesEnabled` aggregate covers both, then the `base` (stored
 * presets when applying a change; on when creating). Every consumer routes
 * through here — a re-typed copy of this chain is how the fields drift.
 */
export function resolveMobileImageSettings(
  input: {
    imagesEnabled?: boolean | undefined;
    coverEnabled?: boolean | undefined;
    illustrationsEnabled?: boolean | undefined;
  },
  base?: { coverEnabled?: boolean | undefined; illustrationsEnabled?: boolean | undefined } | undefined
): { imagesEnabled: boolean; coverEnabled: boolean; illustrationsEnabled: boolean } {
  const coverEnabled = input.coverEnabled ?? input.imagesEnabled ?? base?.coverEnabled ?? true;
  const illustrationsEnabled = input.illustrationsEnabled ?? input.imagesEnabled ?? base?.illustrationsEnabled ?? true;
  return {
    coverEnabled,
    illustrationsEnabled,
    imagesEnabled: coverEnabled || illustrationsEnabled
  };
}

export const mobileCreationPresetsSchema = mobileCreationPresetsInputSchema.transform((presets) => ({
  ...presets,
  ...resolveMobileImageSettings(presets)
}));

/**
 * Merge a complete preset echo onto a stored split media choice. Old clients
 * only know `imagesEnabled`; when they echo the unchanged aggregate, retain
 * the exact stored pair. Changing the aggregate still intentionally changes
 * both choices, while either new field always wins for that field.
 */
export function mergeMobileCreationPresets(
  stored: MobileCreationPresets | undefined,
  incoming: MobileCreationPresetsInput
): MobileCreationPresets {
  const parsed = mobileCreationPresetsInputSchema.parse(incoming);
  const normalized = mobileCreationPresetsSchema.parse(parsed);
  if (!stored) {
    return normalized;
  }
  const hasCover = Object.hasOwn(parsed, "coverEnabled");
  const hasIllustrations = Object.hasOwn(parsed, "illustrationsEnabled");
  const hasLegacyAggregate = Object.hasOwn(parsed, "imagesEnabled");
  const aggregateChanged = hasLegacyAggregate && parsed.imagesEnabled !== stored.imagesEnabled;
  const aggregateChoice = aggregateChanged ? parsed.imagesEnabled! : undefined;
  const coverEnabled = hasCover ? parsed.coverEnabled! : aggregateChoice ?? stored.coverEnabled;
  const illustrationsEnabled = hasIllustrations
    ? parsed.illustrationsEnabled!
    : aggregateChoice ?? stored.illustrationsEnabled;
  return {
    ...normalized,
    coverEnabled,
    illustrationsEnabled,
    imagesEnabled: coverEnabled || illustrationsEnabled
  };
}

export const mobileCreationOptionalDetailsSchema = z
  .object({
    title: optionalNamedText(2, 160),
    authorName: optionalNamedText(1, 120),
    mustInclude: optionalText(1200),
    tone: optionalText(180)
  })
  .strict();

export const mobileBookRecipeSchema = z
  .object({
    lane: mobileCreationLaneSchema,
    title: optionalText(160),
    artifact: optionalText(120),
    audience: optionalText(280),
    promise: optionalText(500),
    tone: optionalText(180),
    mainCharacter: optionalText(280),
    conflict: optionalText(500),
    ending: optionalText(400),
    theme: optionalText(400),
    nextStep: optionalText(400),
    exercises: optionalText(500),
    mustInclude: optionalText(1200)
  })
  .strict();

export const mobileCreationMessageRoleSchema = z.enum(["user", "assistant"]);

export const mobileCreationResearchSourceSchema = z
  .object({
    title: z.string().trim().min(1).max(240),
    url: z.string().url().max(2000).optional(),
    summary: z.string().trim().max(700),
    publishedAt: z.string().trim().max(80).optional()
  })
  .strict();

export const mobileCreationResearchSchema = z
  .object({
    query: z.string().trim().min(1).max(600),
    summary: z.string().trim().min(1).max(4000),
    sources: z.array(mobileCreationResearchSourceSchema).max(6).default([])
  })
  .strict();

/**
 * The localized controls that accompanied an assistant message. Keeping this
 * small snapshot on the message lets branch navigation restore the exact
 * question without another model call or an English deterministic fallback.
 */
const mobileCreationMessageTurnUiSchema = z
  .object({
    quickReplies: z.array(z.string().trim().min(1).max(80)).max(4).default([]),
    question: creationTurnQuestionSchema.nullable().default(null)
  })
  .strict();

/** Lightweight reference from a chat message to an uploaded attachment. */
export const mobileCreationMessageAttachmentSchema = z
  .object({
    id: z.string().trim().min(1).max(64),
    kind: creationAttachmentKindSchema,
    name: z.string().trim().min(1).max(200)
  })
  .strict();

export const mobileCreationMessageSchema = z
  .object({
    role: mobileCreationMessageRoleSchema,
    // Attachment-only messages carry empty text, so emptiness is checked below.
    content: z.string().trim().max(4000),
    attachments: z.array(mobileCreationMessageAttachmentSchema).max(6).optional(),
    // Grounded web research attached to an assistant answer. It travels with
    // the branch so edited-away research cannot leak into the active book.
    research: mobileCreationResearchSchema.optional(),
    // Branching fields (optional so legacy flat transcripts keep parsing).
    // Ids are server-generated; siblings under one parent are alternative
    // branches and isActiveChild marks the selected one.
    id: z.string().trim().min(1).max(64).optional(),
    requestId: z.string().trim().min(8).max(64).optional(),
    parentId: z.string().trim().min(1).max(64).nullable().optional(),
    isActiveChild: z.boolean().optional(),
    // The earlier message this turn replies to, snapshotted at send time so it
    // still renders after the transcript cap folds the original into the
    // summary. See chatReplyQuote.ts.
    replyTo: z
      .object({
        messageId: z.string().trim().min(1).max(64),
        role: z.enum(["user", "assistant"]),
        excerpt: z.string().trim().min(1).max(CHAT_REPLY_EXCERPT_MAX)
      })
      .strict()
      .optional(),
    // Server-only UI state for restoring a branch. It is deliberately not
    // included in the serialized message DTO sent to the mobile client.
    turnUi: mobileCreationMessageTurnUiSchema.optional()
  })
  .strict()
  .refine((message) => message.content.length > 0 || (message.attachments?.length ?? 0) > 0, {
    message: "A chat message needs text or an attachment."
  });

export const mobileCreationDraftPayloadSchema = z
  .object({
    // Version 2 = wizard drafts, version 3 = conversational (chat) drafts. Both resume.
    payloadVersion: z.union([z.literal(2), z.literal(3)]).default(2),
    rawIdea: optionalText(2000),
    optionalDetails: mobileCreationOptionalDetailsSchema.default({
      mustInclude: "",
      tone: ""
    }),
    sourceNotes: optionalText(12000),
    detectedLane: mobileCreationLaneSchema.optional(),
    recipe: mobileBookRecipeSchema.optional(),
    selectedPresets: mobileCreationPresetsSchema.optional(),
    // Book language detected from chat or chosen in settings ("fa", "es", ...).
    language: z.string().trim().min(2).max(40).optional(),
    // Compact summary of chat turns that were dropped past the transcript cap.
    conversationSummary: z.string().trim().max(2400).optional(),
    // Server-set time of the last conversation turn. The sessions list sorts
    // by this, so builds/copies touching the row don't reorder the drawer.
    lastMessageAt: z.iso.datetime().optional(),
    // Chat transcript tree for the conversational Book Studio (version 3
    // payloads). Holds all branches; the active path is capped separately.
    messages: z.array(mobileCreationMessageSchema).max(240).optional(),
    // Files uploaded into the chat, already digested into text at upload time.
    attachments: z.array(creationAttachmentSchema).max(CREATION_ATTACHMENT_MAX_COUNT).optional(),
    // Legacy V2 payloads are accepted so active drafts made before V3 can resume.
    brief: mobileCreationBriefSchema.optional()
  })
  .strict();

export const mobileBookAdvisorBodySchema = mobileCreationDraftPayloadSchema;

export const mobileBookAdvisorResponseSchema = z
  .object({
    recommendation: mobileCreationPresetsSchema,
    detectedLane: mobileCreationLaneSchema,
    recipe: mobileBookRecipeSchema,
    briefScore: z.number().int().min(0).max(100),
    missingFields: z.array(z.string()).default([]),
    warnings: z.array(z.string()).default([]),
    followUpSuggestions: z.array(z.string()).max(5).default([]),
    bookShapePreview: z.array(z.string()).min(1).max(8),
    titleSuggestions: z.array(z.string()).max(5).default([]),
    rationale: z.string().max(600)
  })
  .strict();

export const aiAdvisorPatchSchema = z
  .object({
    recipe: mobileBookRecipeSchema.optional(),
    warnings: z.array(z.string()).max(5).optional(),
    followUpSuggestions: z.array(z.string()).max(5).optional(),
    bookShapePreview: z.array(z.string()).min(1).max(8).optional(),
    titleSuggestions: z.array(z.string()).max(5).optional(),
    rationale: z.string().max(600).optional()
  })
  .strict();

export type MobileCreationBrief = z.infer<typeof mobileCreationBriefSchema>;
export type MobileCreationLane = z.infer<typeof mobileCreationLaneSchema>;
export type MobileBookRecipe = z.infer<typeof mobileBookRecipeSchema>;
export type MobileCreationPresets = z.infer<typeof mobileCreationPresetsSchema>;
export type MobileBookTypeChoice = z.infer<typeof mobileBookTypeChoiceSchema>;
export type MobilePageCountMode = z.infer<typeof mobilePageCountModeSchema>;
export type MobilePageCountSource = z.infer<typeof mobilePageCountSourceSchema>;
export type MobileCreationOptionalDetails = z.infer<typeof mobileCreationOptionalDetailsSchema>;
export type MobileCreationMessage = z.infer<typeof mobileCreationMessageSchema>;
export type MobileCreationMessageAttachment = z.infer<typeof mobileCreationMessageAttachmentSchema>;
export type MobileCreationDraftPayload = z.infer<typeof mobileCreationDraftPayloadSchema>;
export type MobileBookAdvisorResponse = z.infer<typeof mobileBookAdvisorResponseSchema>;
