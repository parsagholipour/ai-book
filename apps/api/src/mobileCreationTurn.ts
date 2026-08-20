import { type CreationAttachment } from "@book-maker/core";
import { z } from "zod";
import {
  creationTurnQuestionSchema,
  normalizeCreationQuestion,
  type MobileCreationTurnQuestion
} from "./creationQuestion.js";
import { laneFromBookTypeChoice, productBookTypeForLane } from "./mobileCreationLanes.js";
import {
  mobileBookRecipeSchema,
  mobileCreationDraftPayloadSchema,
  mobileCreationLaneSchema,
  mobileCreationPresetsSchema,
  mobileCreationResearchSchema,
  type MobileBookRecipe,
  type MobileCreationDraftPayload,
  type MobileCreationMessage,
  type MobileCreationOptionalDetails,
  type MobileCreationPresets
} from "./mobileCreationSchemas.js";

/**
 * The creation-chat turn contract: the turn and AI-patch schemas, patch
 * cleaning/merging, and the request-to-payload conversion every turn shares.
 * Split out of mobileCreation.ts, which re-exports the public pieces so the
 * `./mobileCreation.js` surface is unchanged.
 */

/** Catalog palettes are hex today, but the shape is the catalog's to change. */
const coverPreviewColor = z.string().trim().min(4).max(32);

export const mobileCreationTurnSchema = z
  .object({
    // Branch navigation intentionally returns no new chat bubble.
    assistantMessage: z.string().trim().max(900),
    brief: mobileBookRecipeSchema,
    presets: mobileCreationPresetsSchema,
    detectedLane: mobileCreationLaneSchema,
    quickReplies: z.array(z.string().trim().min(1).max(80)).max(4).default([]),
    question: creationTurnQuestionSchema.nullable().default(null),
    readiness: z
      .object({
        score: z.number().int().min(0).max(100),
        canBuild: z.boolean(),
        missing: z.array(z.string().trim().min(1).max(80)).max(4).default([])
      })
      .strict(),
    titleSuggestions: z.array(z.string().trim().min(1).max(160)).max(5).default([]),
    shapePreview: z.array(z.string().trim().min(1).max(160)).min(1).max(8),
    warnings: z.array(z.string().trim().min(1).max(280)).max(5).default([]),
    // A deterministic glimpse of the designed cover this brief would earn
    // today (see mobileCreationCoverPreview.ts). Derived at every
    // finalization site, never patched by the model. Optional because every
    // draft's stored `lastTurn` written before the field existed must keep
    // parsing.
    coverPreview: z
      .object({
        designId: z.string().trim().min(1).max(80),
        template: z.string().trim().min(1).max(40),
        palette: z.tuple([coverPreviewColor, coverPreviewColor, coverPreviewColor])
      })
      .strict()
      .optional(),
    // Grounded web evidence used for this answer, if the turn searched.
    research: mobileCreationResearchSchema.optional(),
    // Detected or confirmed book language for this conversation ("fa", "es", ...).
    language: z.string().trim().min(2).max(40).optional(),
    // Byline and title captured from chat, merged into the draft's
    // optionalDetails so Advanced settings shows them. Both are settable only
    // through the update_settings tool, never through the finish_turn patch,
    // so a model cannot invent a byline without an explicit user statement.
    authorName: z.string().trim().min(1).max(120).optional(),
    title: z.string().trim().min(2).max(160).optional(),
    // True when the user asked to build the plan from chat ("ok build it").
    buildRequested: z.boolean().default(false)
  })
  .strict();

const creationTurnAiPatchObjectSchema = z
  .object({
    // These two fields are a coherence pair. Requiring an explicit question
    // state keeps a localized assistant reply from silently inheriting the
    // deterministic English question card when the model omits `question`.
    assistantMessage: z.string().trim().max(900),
    brief: mobileBookRecipeSchema.optional(),
    presets: mobileCreationPresetsSchema.optional(),
    quickReplies: z.array(z.string()).max(4).optional(),
    question: creationTurnQuestionSchema.nullable(),
    titleSuggestions: z.array(z.string()).max(5).optional(),
    shapePreview: z.array(z.string()).min(1).max(8).optional(),
    warnings: z.array(z.string()).max(5).optional(),
    language: z.string().trim().min(2).max(40).optional(),
    buildRequested: z.boolean().optional()
  })
  .strict();

/**
 * Models sometimes return the book language under the input field name
 * `bookLanguage`, or emit explicit nulls for fields they have no opinion on.
 * Rejecting the whole patch for that silently downgrades the turn to the
 * canned fallback interviewer, so normalize instead: keep only known keys,
 * drop nulls (except `question`, where null means "stop asking"), and accept
 * `bookLanguage` as an alias for `language`.
 */
export const creationTurnAiPatchSchema = z.preprocess((value) => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return value;
  }
  const raw = value as Record<string, unknown>;
  const known = new Set(Object.keys(creationTurnAiPatchObjectSchema.shape));
  const normalized: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(raw)) {
    if (!known.has(key) || (entry === null && key !== "question")) {
      continue;
    }
    normalized[key] = entry;
  }
  if (normalized.language === undefined && typeof raw.bookLanguage === "string" && raw.bookLanguage.trim()) {
    normalized.language = raw.bookLanguage;
  }
  return normalized;
}, creationTurnAiPatchObjectSchema);

export type CreationTurnAiPatch = Partial<z.infer<typeof creationTurnAiPatchSchema>>;

export type MobileCreationTurn = z.infer<typeof mobileCreationTurnSchema>;
export type MobileCreationCoverPreview = NonNullable<MobileCreationTurn["coverPreview"]>;
export type MobileCreationResearch = z.infer<typeof mobileCreationResearchSchema>;
export type { MobileCreationTurnQuestion };

/** A library character sheet riding one turn, re-read fresh from the library. */
export type CreationTurnCharacter = {
  id: string;
  name: string;
  description: string;
  appearance?: string | undefined;
  fields: Array<{ key: string; value: string }>;
};

export type MobileCreationTurnRequest = {
  messages: MobileCreationMessage[];
  brief?: MobileBookRecipe | undefined;
  presets?: MobileCreationPresets | undefined;
  optionalDetails?: MobileCreationOptionalDetails | undefined;
  sourceNotes?: string | undefined;
  /** Digested uploads for this chat; summaries/excerpts feed every turn. */
  attachments?: CreationAttachment[] | undefined;
  /** Library characters @-mentioned on the active branch (messages reference them by name). */
  characters?: CreationTurnCharacter[] | undefined;
  language?: string | undefined;
  conversationSummary?: string | undefined;
};

/** Per-turn budget for attachment excerpts sent to the chat model. */
const TURN_ATTACHMENT_EXCERPT_MAX = 2500;
const TURN_ATTACHMENT_EXCERPT_TOTAL_MAX = 7500;

/**
 * Compact attachment view for every chat turn: summaries always, excerpts
 * within a fixed budget (newest files first) so turn cost stays flat no
 * matter how much material was uploaded.
 */
export function attachmentContextForTurn(attachments: CreationAttachment[] | undefined): Array<{
  name: string;
  kind: string;
  pages?: number | undefined;
  summary: string;
  excerpt: string;
  excerptTruncated: boolean;
}> {
  if (!attachments || attachments.length === 0) {
    return [];
  }
  let remaining = TURN_ATTACHMENT_EXCERPT_TOTAL_MAX;
  // Newest uploads get excerpt budget first; older ones may fall back to summary only.
  const byNewest = [...attachments].reverse();
  const contexts = byNewest.map((attachment) => {
    const budget = Math.min(TURN_ATTACHMENT_EXCERPT_MAX, remaining);
    const excerpt = attachment.content.slice(0, budget);
    remaining -= excerpt.length;
    return {
      name: attachment.name,
      kind: attachment.kind,
      ...(attachment.pages ? { pages: attachment.pages } : {}),
      summary: attachment.summary,
      excerpt,
      excerptTruncated: attachment.truncated || excerpt.length < attachment.content.length
    };
  });
  return contexts.reverse();
}

/**
 * Folds a byline or title captured by the chat onto the optional details the
 * client sent. Everything else in `optionalDetails` stays client-owned; these
 * two are the only fields the interviewer can set, and they are what makes a
 * name stated in chat show up in Advanced settings instead of surviving only
 * as free text in the transcript.
 */
export function mergeCreationOptionalDetails(
  details: MobileCreationOptionalDetails | undefined,
  turn: Pick<MobileCreationTurn, "authorName" | "title">
): MobileCreationOptionalDetails {
  return {
    ...(details ?? { mustInclude: "", tone: "" }),
    ...(turn.authorName ? { authorName: turn.authorName } : {}),
    ...(turn.title ? { title: turn.title } : {})
  };
}

export function payloadFromTurnRequest(request: MobileCreationTurnRequest): MobileCreationDraftPayload {
  const forcedLane = laneFromBookTypeChoice(request.presets?.bookTypeChoice);
  const unresolvedAuto = !forcedLane && (!request.presets || request.presets.bookTypeChoice === "auto");
  const lane = forcedLane ?? (unresolvedAuto ? "auto" : request.brief?.lane);
  const recipe = request.brief
    ? {
        ...request.brief,
        ...(lane ? { lane } : {})
      }
    : undefined;
  const userText = request.messages
    .filter((message) => message.role === "user")
    .map((message) => message.content.trim())
    .filter(Boolean)
    .join("\n")
    .slice(0, 2000);
  return mobileCreationDraftPayloadSchema.parse({
    payloadVersion: 3,
    rawIdea: userText,
    optionalDetails: request.optionalDetails ?? { mustInclude: "", tone: "" },
    sourceNotes: request.sourceNotes ?? "",
    ...(lane ? { detectedLane: lane } : {}),
    recipe,
    selectedPresets: request.presets,
    ...(request.attachments && request.attachments.length > 0 ? { attachments: request.attachments } : {}),
    ...(request.language ? { language: request.language } : {}),
    ...(request.conversationSummary ? { conversationSummary: request.conversationSummary } : {}),
    messages: request.messages
  });
}

export function turnHasEnoughSubstance(request: MobileCreationTurnRequest): boolean {
  return (
    request.messages.some(
      (message) =>
        message.role === "user" && (message.content.trim().length >= 2 || (message.attachments?.length ?? 0) > 0)
    ) || (request.attachments?.length ?? 0) > 0
  );
}

/** Empty enrichment patch — nothing to merge onto the deterministic turn. */
export function creationEnrichmentIsEmpty(patch: Partial<MobileCreationTurn>): boolean {
  return (
    !patch.assistantMessage?.trim() &&
    patch.question === undefined &&
    !patch.research &&
    patch.buildRequested !== true &&
    patch.presets === undefined &&
    patch.brief === undefined &&
    !patch.language?.trim() &&
    patch.quickReplies === undefined &&
    patch.titleSuggestions === undefined &&
    patch.shapePreview === undefined &&
    patch.warnings === undefined
  );
}

export function cleanCreationTurnPatch(
  patch: CreationTurnAiPatch | Partial<MobileCreationTurn>
): Partial<MobileCreationTurn> {
  const cleaned: Partial<MobileCreationTurn> = {};
  const research = "research" in patch ? patch.research : undefined;
  if (patch.assistantMessage?.trim()) {
    cleaned.assistantMessage = patch.assistantMessage.trim();
  }
  if (patch.brief) {
    cleaned.brief = patch.brief;
  }
  if (patch.presets) {
    cleaned.presets = patch.presets;
  }
  if (patch.quickReplies) {
    cleaned.quickReplies = patch.quickReplies.map((item) => item.trim()).filter(Boolean).slice(0, 4);
  }
  if (patch.question !== undefined) {
    cleaned.question = normalizeCreationQuestion(patch.question);
  }
  if (patch.titleSuggestions) {
    cleaned.titleSuggestions = patch.titleSuggestions.map((item) => item.trim()).filter(Boolean).slice(0, 5);
  }
  if (patch.shapePreview) {
    cleaned.shapePreview = patch.shapePreview.map((item) => item.trim()).filter(Boolean).slice(0, 8);
  }
  if (patch.warnings) {
    cleaned.warnings = patch.warnings.map((item) => item.trim()).filter(Boolean).slice(0, 5);
  }
  if (patch.language?.trim()) {
    cleaned.language = patch.language.trim().toLowerCase();
  }
  if ("authorName" in patch && patch.authorName?.trim()) {
    cleaned.authorName = patch.authorName.trim();
  }
  if ("title" in patch && patch.title?.trim()) {
    cleaned.title = patch.title.trim();
  }
  if (research) {
    cleaned.research = mobileCreationResearchSchema.parse(research);
  }
  if (patch.buildRequested !== undefined) {
    cleaned.buildRequested = patch.buildRequested;
  }
  return cleaned;
}

export function applyCreationTurnPatch(base: MobileCreationTurn, patch: Partial<MobileCreationTurn>): MobileCreationTurn {
  // The AI may switch the book type mid-chat (e.g. "actually make it a
  // children's story"). Accept the switch when its patched presets name a
  // concrete bookTypeChoice different from the base; the prompt instructs it
  // to confirm ambiguous switches with a question first.
  const patchedChoice = patch.presets?.bookTypeChoice;
  const laneFromPatch =
    patchedChoice && patchedChoice !== "auto" && patchedChoice !== base.presets.bookTypeChoice
      ? laneFromBookTypeChoice(patchedChoice)
      : undefined;
  // "You pick the type" is a real answer, not a no-op: storing it as "auto"
  // is what makes the build's advisor re-resolve the lane. Dropping it left
  // the model confirming a hand-off the stored state contradicted.
  const patchedToAuto = patchedChoice === "auto" && base.presets.bookTypeChoice !== "auto";
  const detectedLane = laneFromPatch ?? base.detectedLane;
  // The brief's title means "stated by the user". A stated title arrives on
  // the update_settings channel (patch.title, folded into optionalDetails by
  // the route); the base carries any previously stated one. A title the model
  // writes into its brief patch instead is an invention — the prompt forbids
  // it — and would show in the app as the book's working name.
  const brief = mobileBookRecipeSchema.parse({
    ...(patch.brief ?? base.brief),
    title: patch.title ?? base.brief.title,
    lane: detectedLane
  });
  const patchedPresets = patch.presets
    ? mobileCreationPresetsSchema.parse({
        ...patch.presets,
        bookType: laneFromPatch ? productBookTypeForLane(laneFromPatch) : base.presets.bookType,
        bookTypeChoice: laneFromPatch ? patchedChoice : patchedToAuto ? "auto" : base.presets.bookTypeChoice
      })
    : base.presets;
  const buildRequested = patch.buildRequested ?? base.buildRequested;
  const question = patch.question ?? null;
  const quickReplies =
    patch.quickReplies !== undefined
      ? patch.quickReplies
      : patch.question !== undefined || patch.assistantMessage !== undefined
        ? []
        : base.quickReplies;
  // An open question never blocks the build: every clarification the model asks
  // is optional by policy, so the app keeps offering "Skip and build the plan"
  // and lists the prompt under "Helpful to add". Only a chat with nothing to
  // build from — the greeting, before any usable idea — stays unbuildable,
  // which is what the deterministic base already decided.
  const readiness = {
    ...base.readiness,
    canBuild: base.readiness.canBuild || buildRequested,
    missing: question ? [stripTrailingPunctuation(question.prompt)] : []
  };
  // The base message embeds the base question's wording; if the patch swaps
  // the question without its own message, echo the new prompt instead of
  // pairing the old sentence with a different question card.
  const assistantMessage =
    patch.assistantMessage ?? (patch.question ? patch.question.prompt : base.assistantMessage);
  return {
    assistantMessage,
    brief,
    presets: patchedPresets,
    detectedLane,
    quickReplies,
    question,
    readiness,
    titleSuggestions: patch.titleSuggestions ?? base.titleSuggestions,
    shapePreview: patch.shapePreview && patch.shapePreview.length > 0 ? patch.shapePreview : base.shapePreview,
    warnings: patch.warnings ?? base.warnings,
    ...(patch.research ? { research: patch.research } : base.research ? { research: base.research } : {}),
    ...(patch.language ?? base.language ? { language: patch.language ?? base.language } : {}),
    // Only carried when this turn captured one. A byline is not sticky state
    // on the turn — the draft's optionalDetails owns it — so echoing the base
    // forever would let an old capture overwrite a name edited in the sheet.
    ...(patch.authorName ? { authorName: patch.authorName } : {}),
    ...(patch.title ? { title: patch.title } : {}),
    buildRequested
  };
}

function stripTrailingPunctuation(value: string): string {
  return value.replace(/[?.!:\s]+$/g, "").trim() || value.trim();
}
