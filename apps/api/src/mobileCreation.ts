import {
  generateJsonWithRetry,
  type TextModelAdapter
} from "@book-maker/core";
import { z } from "zod";

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

export const mobileCreationPresetsSchema = z
  .object({
    bookType: mobileBookTypeSchema,
    bookTypeChoice: mobileBookTypeChoiceSchema.optional(),
    lengthPreset: mobileLengthPresetSchema,
    qualityPreset: mobileQualityPresetSchema,
    imagesEnabled: z.boolean(),
    pageCountMode: mobilePageCountModeSchema.optional(),
    targetPages: mobileTargetPagesSchema.optional(),
    pageCountSource: mobilePageCountSourceSchema.optional()
  })
  .strict();

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

export const mobileCreationMessageSchema = z
  .object({
    role: mobileCreationMessageRoleSchema,
    content: z.string().trim().min(1).max(4000)
  })
  .strict();

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
    // Chat transcript for the conversational Book Studio (version 3 payloads).
    messages: z.array(mobileCreationMessageSchema).max(80).optional(),
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

const aiAdvisorPatchSchema = z
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
export type MobileCreationDraftPayload = z.infer<typeof mobileCreationDraftPayloadSchema>;
export type MobileBookAdvisorResponse = z.infer<typeof mobileBookAdvisorResponseSchema>;

type AdvisorOptions = {
  enrich?: ((payload: MobileCreationDraftPayload, base: MobileBookAdvisorResponse) => Promise<Partial<MobileBookAdvisorResponse>>) | undefined;
  timeoutMs?: number | undefined;
};

export async function adviseMobileBook(
  payload: MobileCreationDraftPayload,
  options: AdvisorOptions = {}
): Promise<MobileBookAdvisorResponse> {
  const parsed = mobileCreationDraftPayloadSchema.parse(payload);
  const base = deterministicAdvisor(parsed);
  if (!options.enrich || !payloadHasEnoughSubstance(parsed)) {
    return base;
  }

  try {
    const patch = await withTimeout(options.enrich(parsed, base), options.timeoutMs ?? 2500);
    const cleaned = cleanAdvisorPatch(patch);
    const recipe = cleaned.recipe ? mobileBookRecipeSchema.parse({ ...cleaned.recipe, lane: base.detectedLane }) : base.recipe;
    return mobileBookAdvisorResponseSchema.parse({
      ...base,
      ...cleaned,
      recipe,
      recommendation: base.recommendation,
      detectedLane: base.detectedLane,
      briefScore: base.briefScore,
      missingFields: base.missingFields
    });
  } catch {
    return base;
  }
}

export function deterministicAdvisor(payload: MobileCreationDraftPayload): MobileBookAdvisorResponse {
  const normalized = normalizePayload(payload);
  const detectedLane = laneForPayload(normalized);
  const recipe = completeRecipe(normalized, detectedLane);
  const recommendation = resolveCreationPresets(
    normalized.selectedPresets,
    detectedLane,
    recommendedPresets(detectedLane, normalized)
  );
  const warnings = warningMessages(normalized, detectedLane);
  const followUpSuggestions = followUpSuggestionsFor(recipe);
  const briefScore = recipeStrengthScore(normalized, recipe, warnings);
  const bookShapePreview = shapePreview(recipe, recommendation);
  const titleSuggestions = titleSuggestionsFor(recipe, recommendation.bookType);
  return {
    recommendation,
    detectedLane,
    recipe,
    briefScore,
    missingFields: [],
    warnings,
    followUpSuggestions,
    bookShapePreview,
    titleSuggestions,
    rationale: rationaleFor(detectedLane)
  };
}

export function explicitTargetPagesForMobilePayload(payload: MobileCreationDraftPayload): number | undefined {
  const normalized = normalizePayload(payload);
  const searchText = pageCountSearchText(normalized);
  const matches = [
    ...capturePageCounts(searchText, /\b(\d{1,3})\s*[- ]?\s*(?:page|pages|pg|pgs)\s*(?:book|ebook|story|guide|workbook|project|plan)?\b/gi),
    ...capturePageCounts(searchText, /\b(?:make|create|write|build|draft|set|keep|turn)\s+(?:it|this|the\s+book|the\s+story|the\s+guide)?\s*(?:to|at|as)?\s*(\d{1,3})\s*(?:page|pages|pg|pgs)\b/gi),
    ...capturePageCounts(searchText, /\b(?:page|pages|pg|pgs)\s*(?:count|length)?\s*(?:is|=|:|to|should\s+be)?\s*(\d{1,3})\b/gi)
  ];
  for (const value of matches.reverse()) {
    const parsed = mobileTargetPagesSchema.safeParse(value);
    if (parsed.success) {
      return parsed.data;
    }
  }
  return undefined;
}

export async function enrichAdvisorWithAi(
  textModel: TextModelAdapter,
  payload: MobileCreationDraftPayload,
  base: MobileBookAdvisorResponse
): Promise<Partial<MobileBookAdvisorResponse>> {
  const result = await generateJsonWithRetry(textModel, {
    purpose: "mobile-book-advisor",
    temperature: 0.2,
    maxTokens: 1200,
    schema: aiAdvisorPatchSchema,
    messages: [
      {
        role: "system",
        content:
          "You are a practical book packaging advisor. Improve the recipe, follow-up suggestions, warnings, book-shape preview, rationale, and title suggestions for creators, teachers, coaches, consultants, adult fiction writers, and child/family story writers. Do not mention AI models, providers, billing internals, or safety-system internals."
      },
      {
        role: "user",
        content: JSON.stringify({ payload, base }, null, 2)
      }
    ]
  });
  return cleanAdvisorPatch(result.data);
}

const creationTurnQuestionSchema = z
  .object({
    prompt: z.string().trim().min(1).max(280),
    options: z.array(z.string().trim().min(1).max(80)).max(4).default([]),
    allowCustom: z.boolean().default(true)
  })
  .strict();

export const mobileCreationTurnSchema = z
  .object({
    assistantMessage: z.string().trim().min(1).max(900),
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
    warnings: z.array(z.string().trim().min(1).max(280)).max(5).default([])
  })
  .strict();

const creationTurnAiPatchSchema = z
  .object({
    assistantMessage: z.string().trim().max(900).optional(),
    brief: mobileBookRecipeSchema.optional(),
    presets: mobileCreationPresetsSchema.optional(),
    quickReplies: z.array(z.string()).max(4).optional(),
    question: creationTurnQuestionSchema.nullable().optional(),
    titleSuggestions: z.array(z.string()).max(5).optional(),
    shapePreview: z.array(z.string()).min(1).max(8).optional(),
    warnings: z.array(z.string()).max(5).optional()
  })
  .strict();

export type MobileCreationTurn = z.infer<typeof mobileCreationTurnSchema>;
export type MobileCreationTurnQuestion = z.infer<typeof creationTurnQuestionSchema>;

export type MobileCreationTurnRequest = {
  messages: MobileCreationMessage[];
  brief?: MobileBookRecipe | undefined;
  presets?: MobileCreationPresets | undefined;
  optionalDetails?: MobileCreationOptionalDetails | undefined;
  sourceNotes?: string | undefined;
};

type CreationTurnOptions = {
  enrich?:
    | ((request: MobileCreationTurnRequest, base: MobileCreationTurn) => Promise<Partial<MobileCreationTurn>>)
    | undefined;
  timeoutMs?: number | undefined;
};

export async function runCreationTurn(
  request: MobileCreationTurnRequest,
  options: CreationTurnOptions = {}
): Promise<MobileCreationTurn> {
  const base = deterministicCreationTurn(request);
  if (!options.enrich || !turnHasEnoughSubstance(request)) {
    return base;
  }
  try {
    const patch = await withTimeout(options.enrich(request, base), options.timeoutMs ?? 8000);
    return mobileCreationTurnSchema.parse(applyCreationTurnPatch(base, cleanCreationTurnPatch(patch)));
  } catch {
    return base;
  }
}

export function greetingCreationTurn(): MobileCreationTurn {
  const base = deterministicCreationTurn({ messages: [] });
  return mobileCreationTurnSchema.parse({
    ...base,
    assistantMessage:
      "Hi! Tell me about the book you want to make. Describe your idea in a sentence or two, or tap an example to start.",
    quickReplies: [
      "Bedtime story for 5 year olds",
      "Lead magnet about pricing",
      "Workbook for new coaches",
      "Short story about a garden mystery"
    ],
    question: null,
    readiness: { score: 0, canBuild: false, missing: [] }
  });
}

export function deterministicCreationTurn(request: MobileCreationTurnRequest): MobileCreationTurn {
  const payload = payloadFromTurnRequest(request);
  const base = deterministicAdvisor(payload);
  const presets = base.recommendation;
  const userTurns = request.messages.filter((message) => message.role === "user").length;
  const hasIdea = payload.rawIdea.trim().length >= 3;
  const question = hasIdea ? questionForTurn(base.detectedLane, userTurns) : null;
  const readiness = {
    score: base.briefScore,
    canBuild: hasIdea,
    missing: question ? [stripTrailingPunctuation(question.prompt)] : []
  };
  return mobileCreationTurnSchema.parse({
    assistantMessage: deterministicAssistantMessage(base, question, hasIdea),
    brief: base.recipe,
    presets,
    detectedLane: base.detectedLane,
    quickReplies: deterministicQuickReplies(question),
    question,
    readiness,
    titleSuggestions: base.titleSuggestions,
    shapePreview: base.bookShapePreview,
    warnings: base.warnings
  });
}

export async function enrichCreationTurnWithAi(
  textModel: TextModelAdapter,
  request: MobileCreationTurnRequest,
  base: MobileCreationTurn
): Promise<Partial<MobileCreationTurn>> {
  const result = await generateJsonWithRetry(textModel, {
    purpose: "mobile-book-conversation",
    temperature: 0.5,
    maxTokens: 1500,
    schema: creationTurnAiPatchSchema,
    messages: [
      {
        role: "system",
        content:
          "You are a warm, concise book creation assistant for an AI book maker app. You help one person turn a rough idea into a clear book brief through a short chat. " +
          "Rules: reply in 1-3 short sentences with no jargon. Ask AT MOST ONE focused follow-up question per turn, and always give 2-4 short tappable options plus allow a custom answer. " +
          "Never block the user; they can build the plan whenever they want, so do not insist on more detail. Once the brief is clear, set question to null and encourage them to build the plan. " +
          "Support every kind of book: children's stories, adult short stories, lead magnets, offer guides, client tools, workbooks, and practical guides. If currentPresets.bookTypeChoice is auto, keep the book type unresolved and ask neutral book-shaping questions instead of declaring a genre. Keep refining the structured brief from the whole conversation. " +
          "If the user asks for a different format, length, or visuals, update presets accordingly. Never mention AI models, providers, credits, billing, or safety systems."
      },
      {
        role: "user",
        content: JSON.stringify(
          {
            conversation: request.messages,
            currentBrief: base.brief,
            currentPresets: base.presets,
            detectedLane: base.detectedLane,
            deterministicSuggestion: {
              assistantMessage: base.assistantMessage,
              question: base.question,
              quickReplies: base.quickReplies,
              shapePreview: base.shapePreview,
              titleSuggestions: base.titleSuggestions
            }
          },
          null,
          2
        )
      }
    ]
  });
  return cleanCreationTurnPatch(result.data);
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
    messages: request.messages
  });
}

function turnHasEnoughSubstance(request: MobileCreationTurnRequest): boolean {
  return request.messages.some((message) => message.role === "user" && message.content.trim().length >= 2);
}

function questionForTurn(lane: MobileCreationLane, userTurns: number): MobileCreationTurnQuestion | null {
  const sequence = questionSequenceForLane(lane);
  const index = userTurns - 1;
  if (index < 0 || index >= sequence.length) {
    return null;
  }
  return creationTurnQuestionSchema.parse(sequence[index]);
}

function questionSequenceForLane(lane: MobileCreationLane): MobileCreationTurnQuestion[] {
  if (lane === "auto") {
    return [
      { prompt: "Who is this book for?", options: ["Young readers", "Clients or students", "General readers"], allowCustom: true },
      { prompt: "What should the book feel like?", options: ["Warm and simple", "Practical and clear", "Imaginative and fun"], allowCustom: true },
      { prompt: "What should the reader remember?", options: ["A useful lesson", "A clear next step", "A memorable ending"], allowCustom: true }
    ];
  }
  if (lane === "children_story") {
    return [
      { prompt: "Who is this story for?", options: ["3-4 year olds", "5-6 year olds", "7-8 year olds"], allowCustom: true },
      { prompt: "Who is the main character?", options: ["A curious child", "A gentle animal", "A magical friend"], allowCustom: true },
      { prompt: "How should it end?", options: ["Cozy and reassuring", "Happy and funny", "A gentle lesson"], allowCustom: true }
    ];
  }
  if (lane === "adult_story") {
    return [
      { prompt: "Who is this story for?", options: ["Mystery lovers", "Hopeful literary readers", "Romance readers"], allowCustom: true },
      { prompt: "Who is the main character?", options: ["An ordinary person facing a choice", "A reluctant hero", "A pair with a secret"], allowCustom: true },
      { prompt: "What is the central conflict?", options: ["A hidden truth surfaces", "A hard decision", "A race against time"], allowCustom: true }
    ];
  }
  if (lane === "workbook" || lane === "client_tool") {
    return [
      { prompt: "Who will use this workbook?", options: ["Beginners", "Clients or students", "A team"], allowCustom: true },
      { prompt: "What should they be able to do after?", options: ["Follow a clear plan", "Practice a skill", "Make a decision"], allowCustom: true },
      { prompt: "What practice should it include?", options: ["Checklists", "Reflection prompts", "Step-by-step exercises"], allowCustom: true }
    ];
  }
  return [
    { prompt: "Who is this guide for?", options: ["Solo founders", "Coaches and consultants", "Beginners in the topic"], allowCustom: true },
    { prompt: "What is the main win for the reader?", options: ["A quick practical result", "A clear framework", "Confidence to act"], allowCustom: true },
    { prompt: "What next step should it point to?", options: ["Book a call", "Use a checklist", "Try the method"], allowCustom: true }
  ];
}

function deterministicAssistantMessage(
  base: MobileBookAdvisorResponse,
  question: MobileCreationTurnQuestion | null,
  hasIdea: boolean
): string {
  if (!hasIdea) {
    return "Tell me about the book you want to make, or tap an example to start.";
  }
  if (base.detectedLane === "auto") {
    if (question) {
      return `Got it. ${question.prompt}`;
    }
    return "This is shaping up well. When you're ready, tap Build the plan and I'll choose the best book shape from this chat.";
  }
  const lane = laneLabel(base.detectedLane).toLowerCase();
  if (question) {
    return `Got it - this sounds like a ${lane}. ${question.prompt}`;
  }
  return "This is shaping up well. When you're ready, tap Build the plan and I'll draft chapters you can refine.";
}

function deterministicQuickReplies(question: MobileCreationTurnQuestion | null): string[] {
  if (question) {
    return ["You decide"];
  }
  return ["Make it longer", "Add more detail"];
}

function cleanCreationTurnPatch(patch: z.infer<typeof creationTurnAiPatchSchema>): Partial<MobileCreationTurn> {
  const cleaned: Partial<MobileCreationTurn> = {};
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
    cleaned.question = patch.question;
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
  return cleaned;
}

function applyCreationTurnPatch(base: MobileCreationTurn, patch: Partial<MobileCreationTurn>): MobileCreationTurn {
  const brief = mobileBookRecipeSchema.parse({ ...(patch.brief ?? base.brief), lane: base.detectedLane });
  const patchedPresets = patch.presets
    ? mobileCreationPresetsSchema.parse({
        ...patch.presets,
        bookType: base.presets.bookType,
        bookTypeChoice: base.presets.bookTypeChoice
      })
    : base.presets;
  return {
    assistantMessage: patch.assistantMessage ?? base.assistantMessage,
    brief,
    presets: patchedPresets,
    detectedLane: base.detectedLane,
    quickReplies: patch.quickReplies ?? base.quickReplies,
    question: patch.question !== undefined ? patch.question : base.question,
    readiness: base.readiness,
    titleSuggestions: patch.titleSuggestions ?? base.titleSuggestions,
    shapePreview: patch.shapePreview && patch.shapePreview.length > 0 ? patch.shapePreview : base.shapePreview,
    warnings: patch.warnings ?? base.warnings
  };
}

function stripTrailingPunctuation(value: string): string {
  return value.replace(/[?.!:\s]+$/g, "").trim() || value.trim();
}

export function composeMobileProjectPrompt(
  payload: MobileCreationDraftPayload,
  advisor: MobileBookAdvisorResponse
): string {
  const normalized = normalizePayload(payload);
  const recipe = normalized.recipe ?? advisor.recipe;
  const autoMode = recipe.lane === "auto" || normalized.selectedPresets?.bookTypeChoice === "auto";
  const lines = [
    autoMode
      ? "Create the best-fitting book from the user's creation chat. Decide the real book shape during planning; do not rely on the neutral project category."
      : `Create a ${laneLabel(recipe.lane).toLowerCase()}.`,
    fieldLine("Original idea", normalized.rawIdea),
    fieldLine("Book type choice", autoMode ? "Auto - decide during planning" : laneLabel(recipe.lane)),
    fieldLine("Creation chat", chatTranscriptForPrompt(normalized.messages)),
    fieldLine("Artifact", recipe.artifact),
    fieldLine("Audience or reader", recipe.audience),
    fieldLine("Promise or story shape", recipe.promise),
    fieldLine("Tone or vibe", recipe.tone),
    fieldLine("Main character", recipe.mainCharacter),
    fieldLine("Conflict", recipe.conflict),
    fieldLine("Theme", recipe.theme),
    fieldLine("Ending feel", recipe.ending),
    fieldLine("Next step", recipe.nextStep),
    fieldLine("Exercises", recipe.exercises),
    fieldLine("Must include", recipe.mustInclude || normalized.optionalDetails.mustInclude),
    normalized.sourceNotes.trim()
      ? "Use the pasted source notes stored in the mobile creation metadata as private reference material. Preserve user intent, but do not invent unsupported factual claims."
      : "",
    autoMode
      ? "Planning instruction: choose the most appropriate shape directly, such as children's fable, short story, workbook, practical guide, client tool, offer guide, or lead magnet, based on the chat history."
      : `Recommended shape: ${advisor.bookShapePreview.join(" ")}`
  ].filter(Boolean);
  return lines.join("\n");
}

export function mobileBriefMetadata(
  payload: MobileCreationDraftPayload,
  advisor: MobileBookAdvisorResponse
): Record<string, unknown> {
  const normalized = normalizePayload(payload);
  const recipe = normalized.recipe ?? advisor.recipe;
  return {
    payloadVersion: 2,
    rawIdea: normalized.rawIdea,
    optionalDetails: normalized.optionalDetails,
    sourceNotes: normalized.sourceNotes,
    messages: normalized.messages ?? [],
    detectedLane: recipe.lane,
    recipe,
    selectedPresets: normalized.selectedPresets ?? advisor.recommendation,
    brief: briefForMobilePayload(normalized, advisor),
    advisor: {
      recommendation: advisor.recommendation,
      detectedLane: advisor.detectedLane,
      recipe: advisor.recipe,
      briefScore: advisor.briefScore,
      missingFields: advisor.missingFields,
      warnings: advisor.warnings,
      followUpSuggestions: advisor.followUpSuggestions,
      bookShapePreview: advisor.bookShapePreview,
      titleSuggestions: advisor.titleSuggestions,
      rationale: advisor.rationale
    }
  };
}

export function titleForMobilePayload(
  payload: MobileCreationDraftPayload,
  _advisor: MobileBookAdvisorResponse
): string | undefined {
  const normalized = normalizePayload(payload);
  return explicitTitleForMobilePayload(normalized) ?? explicitTitleFromText(normalized.rawIdea);
}

export function titleForMobileBrief(
  brief: MobileCreationBrief,
  _advisor: MobileBookAdvisorResponse
): string | undefined {
  return brief.title ?? explicitTitleFromText(brief.topic);
}

export function authorForMobilePayload(payload: MobileCreationDraftPayload): string | undefined {
  const normalized = normalizePayload(payload);
  return normalized.optionalDetails.authorName || normalized.brief?.authorName;
}

export function briefForMobilePayload(
  payload: MobileCreationDraftPayload,
  advisor?: MobileBookAdvisorResponse
): MobileCreationBrief {
  const normalized = normalizePayload(payload);
  if (normalized.brief && !normalized.rawIdea.trim() && !normalized.recipe) {
    return normalized.brief;
  }
  const recipe = normalized.recipe ?? advisor?.recipe ?? completeRecipe(normalized, normalized.detectedLane ?? "auto");
  return mobileCreationBriefSchema.parse({
    intent: intentForLane(recipe.lane),
    topic: normalized.rawIdea || recipe.title || recipe.artifact,
    audience: recipe.audience,
    readerProblem: recipe.conflict,
    desiredOutcome: recipe.promise || recipe.nextStep || recipe.ending,
    tone: recipe.tone || normalized.optionalDetails.tone,
    mustInclude: recipe.mustInclude || normalized.optionalDetails.mustInclude,
    distributionUse: recipe.lane === "lead_magnet" ? "lead magnet or opt-in" : "",
    title: explicitTitleForMobilePayload(normalized) ?? undefined,
    authorName: normalized.optionalDetails.authorName || undefined,
    sourceNotes: normalized.sourceNotes
  });
}

function explicitTitleForMobilePayload(payload: MobileCreationDraftPayload): string | undefined {
  return (
    cleanExplicitTitle(payload.optionalDetails.title) ??
    cleanExplicitTitle(payload.brief?.title) ??
    explicitTitleFromMessages(payload.messages ?? [])
  );
}

function explicitTitleFromMessages(messages: MobileCreationMessage[]): string | undefined {
  return explicitTitleFromText(
    messages
      .filter((message) => message.role === "user")
      .map((message) => message.content)
      .join("\n")
  );
}

function explicitTitleFromText(text: string | undefined): string | undefined {
  const source = text?.trim();
  if (!source) {
    return undefined;
  }

  for (const line of source.split(/\r?\n/)) {
    const lineTitle = line.match(/^\s*(?:book\s+)?title\s*[:=-]\s*(.+?)\s*$/i)?.[1];
    const cleaned = cleanExplicitTitle(lineTitle);
    if (cleaned) {
      return cleaned;
    }
  }

  const quotedTitle =
    source.match(/\b(?:title\s+(?:is|should\s+be)|called|titled|named)\s+["']([^"'\n]{2,160})["']/i)?.[1] ??
    source.match(/\b(?:called|titled|named)\s+'([^'\n]{2,160})'/i)?.[1];
  return cleanExplicitTitle(quotedTitle);
}

function cleanExplicitTitle(value: string | undefined): string | undefined {
  const cleaned = value
    ?.trim()
    .replace(/^["']+|["']+$/g, "")
    .replace(/\.$/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned && cleaned.length >= 2 ? cleaned.slice(0, 160) : undefined;
}

function normalizePayload(payload: MobileCreationDraftPayload): MobileCreationDraftPayload {
  if (payload.rawIdea.trim() || !payload.brief) {
    return payload;
  }
  const brief = payload.brief;
  const lane = laneForLegacyIntent(brief.intent);
  return mobileCreationDraftPayloadSchema.parse({
    payloadVersion: 2,
    rawIdea: brief.topic,
    sourceNotes: brief.sourceNotes,
    optionalDetails: {
      title: brief.title,
      authorName: brief.authorName,
      mustInclude: brief.mustInclude,
      tone: brief.tone
    },
    detectedLane: lane,
    recipe: {
      lane,
      title: brief.title ?? "",
      audience: brief.audience,
      promise: brief.desiredOutcome,
      tone: brief.tone,
      conflict: brief.readerProblem,
      nextStep: brief.distributionUse,
      mustInclude: brief.mustInclude
    },
    selectedPresets: payload.selectedPresets,
    brief
  });
}

function laneForPayload(payload: MobileCreationDraftPayload): MobileCreationLane {
  const forcedLane = laneFromBookTypeChoice(payload.selectedPresets?.bookTypeChoice);
  if (forcedLane) {
    return forcedLane;
  }
  if (payload.selectedPresets?.bookTypeChoice === "auto") {
    return "auto";
  }
  if (payload.selectedPresets) {
    return laneFromProductBookType(payload.selectedPresets.bookType);
  }
  if (!payload.selectedPresets && payload.payloadVersion === 3) {
    return "auto";
  }
  return payload.detectedLane ?? payload.recipe?.lane ?? "auto";
}

function completeRecipe(payload: MobileCreationDraftPayload, lane: MobileCreationLane): MobileBookRecipe {
  const existing = payload.recipe;
  const rawIdea = payload.rawIdea.trim() || payload.brief?.topic.trim() || "A useful book";
  const details = payload.optionalDetails;
  const audience = existing?.audience || audienceFor(rawIdea, lane) || payload.brief?.audience || audienceFallback(lane);
  const title = details.title || existing?.title || payload.brief?.title || titleFromIdea(rawIdea, lane);
  const tone = details.tone || existing?.tone || payload.brief?.tone || toneFallback(lane);
  const promise = existing?.promise || payload.brief?.desiredOutcome || promiseFallback(rawIdea, lane);
  return mobileBookRecipeSchema.parse({
    lane,
    title,
    artifact: existing?.artifact || artifactForLane(lane),
    audience,
    promise,
    tone,
    mainCharacter: existing?.mainCharacter || mainCharacterFor(rawIdea, lane),
    conflict: existing?.conflict || payload.brief?.readerProblem || conflictFallback(lane),
    ending: existing?.ending || endingFallback(lane),
    theme: existing?.theme || themeFallback(lane),
    nextStep: existing?.nextStep || nextStepFallback(lane),
    exercises: existing?.exercises || exercisesFallback(lane),
    mustInclude: existing?.mustInclude || details.mustInclude || payload.brief?.mustInclude || ""
  });
}

function recommendedPresets(
  lane: MobileCreationLane,
  payload: MobileCreationDraftPayload
): MobileCreationPresets {
  const explicitTargetPages = explicitTargetPagesForMobilePayload(payload);
  if (lane === "auto") {
    return presetsWithPageCount({
      bookType: "lead_magnet",
      bookTypeChoice: "auto",
      lengthPreset: payload.sourceNotes.length > 1200 ? "standard" : "short",
      qualityPreset: "balanced",
      imagesEnabled: true
    }, explicitTargetPages);
  }
  if (lane === "workbook" || lane === "client_tool") {
    return presetsWithPageCount(
      { bookType: "workbook", bookTypeChoice: "auto", lengthPreset: "standard", qualityPreset: "balanced", imagesEnabled: true },
      explicitTargetPages
    );
  }
  if (lane === "adult_story" || lane === "children_story") {
    return presetsWithPageCount({
      bookType: "short_story",
      bookTypeChoice: "auto",
      lengthPreset: payload.sourceNotes.length > 800 ? "standard" : "short",
      qualityPreset: "balanced",
      imagesEnabled: true
    }, explicitTargetPages);
  }
  return presetsWithPageCount({
    bookType: "lead_magnet",
    bookTypeChoice: "auto",
    lengthPreset: payload.sourceNotes.length > 1200 || lane === "offer_guide" || lane === "practical_guide" ? "standard" : "short",
    qualityPreset: lane === "offer_guide" ? "premium" : "balanced",
    imagesEnabled: true
  }, explicitTargetPages);
}

function presetsWithPageCount(
  presets: Omit<MobileCreationPresets, "pageCountMode" | "targetPages" | "pageCountSource">,
  targetPages: number | undefined
): MobileCreationPresets {
  return targetPages
    ? { ...presets, pageCountMode: "custom", targetPages, pageCountSource: "chat" }
    : { ...presets, pageCountMode: "auto" };
}

function resolveCreationPresets(
  selectedPresets: MobileCreationPresets | undefined,
  lane: MobileCreationLane,
  fallback: MobileCreationPresets
): MobileCreationPresets {
  if (!selectedPresets) {
    return fallback;
  }
  const forcedLane = laneFromBookTypeChoice(selectedPresets.bookTypeChoice);
  const selectedPageCount = selectedPresets.pageCountMode === "custom" && selectedPresets.targetPages
    ? {
        pageCountMode: "custom" as const,
        targetPages: selectedPresets.targetPages,
        pageCountSource: selectedPresets.pageCountSource ?? "settings" as const
      }
    : undefined;
  if (selectedPresets.bookTypeChoice === "auto") {
    return {
      ...fallback,
      lengthPreset: selectedPresets.lengthPreset,
      qualityPreset: selectedPresets.qualityPreset,
      imagesEnabled: selectedPresets.imagesEnabled,
      bookTypeChoice: "auto",
      ...selectedPageCount
    };
  }
  if (forcedLane) {
    return {
      ...selectedPresets,
      bookType: productBookTypeForLane(forcedLane),
      bookTypeChoice: selectedPresets.bookTypeChoice
    };
  }
  return {
    ...selectedPresets,
    bookType: selectedPresets.bookType ?? productBookTypeForLane(lane)
  };
}

function recipeStrengthScore(
  payload: MobileCreationDraftPayload,
  recipe: MobileBookRecipe,
  warnings: string[]
): number {
  let score = payload.rawIdea.trim().length >= 8 ? 55 : 35;
  if (recipe.audience.trim()) score += 10;
  if (recipe.promise.trim() || recipe.conflict.trim()) score += 10;
  if (recipe.tone.trim()) score += 5;
  if (recipe.mainCharacter.trim() || recipe.nextStep.trim() || recipe.exercises.trim()) score += 8;
  if (payload.sourceNotes.trim()) score += 7;
  score -= Math.min(15, warnings.length * 5);
  return Math.max(0, Math.min(100, score));
}

function warningMessages(payload: MobileCreationDraftPayload, lane: MobileCreationLane): string[] {
  const warnings: string[] = [];
  const text = searchableText(payload);
  if (payload.sourceNotes.length > 9000) {
    warnings.push("The pasted notes are long. The planner will treat them as reference material, not a full manuscript.");
  }
  if (looksFactualOrCurrent(text) && !payload.sourceNotes.trim()) {
    warnings.push("This sounds factual or current. Add source notes if exact claims matter.");
  }
  if (wordCount(payload.rawIdea) < 3 && lane !== "children_story" && lane !== "auto") {
    warnings.push("This is enough to start, but one more detail would make the recipe sharper.");
  }
  return warnings;
}

function followUpSuggestionsFor(recipe: MobileBookRecipe): string[] {
  if (recipe.lane === "auto") {
    return ["Want to improve this? Add who it is for.", "Want to sharpen it? Add the feeling or outcome you want."];
  }
  if (recipe.lane === "children_story") {
    return ["Want to improve this? Add the ending feel.", "Want to tune it? Add the read-aloud vibe."];
  }
  if (recipe.lane === "adult_story") {
    return ["Want to improve this? Add the central conflict.", "Want to sharpen it? Add the ending mood."];
  }
  if (recipe.lane === "workbook" || recipe.lane === "client_tool") {
    return ["Want to improve this? Add one exercise readers should complete.", "Want to sharpen it? Add the learner's current struggle."];
  }
  return ["Want to sharpen this? Add who the guide is for.", "Want to improve this? Add the next step readers should take."];
}

function shapePreview(recipe: MobileBookRecipe, recommendation: MobileCreationPresets): string[] {
  if (recipe.lane === "auto") {
    return ["Planner chooses the best book shape", "Structure follows the chat history", "Pages stay Auto until you choose or mention them", "Tone and visuals follow your details"];
  }
  if (recipe.lane === "children_story") {
    return ["Gentle opening and character setup", "Small problem or adventure", "Warm lesson or emotional turn", "Reassuring read-aloud ending"];
  }
  if (recipe.lane === "adult_story" || recommendation.bookType === "short_story") {
    return ["Hook and main character setup", "Escalating turn or mystery", "Revelation, choice, or emotional pivot", "Clean ending with a memorable final image"];
  }
  if (recommendation.bookType === "workbook") {
    return ["Opening promise and reader checkpoint", "3-5 short lessons or framework steps", "Exercises, reflection prompts, and examples", "Recap checklist and next steps"];
  }
  return ["Clear reader promise", "Problem framing and quick diagnostic", "Practical framework with examples", "Checklist and call-to-action"];
}

function titleSuggestionsFor(
  recipe: MobileBookRecipe,
  bookType: MobileCreationPresets["bookType"]
): string[] {
  const topic = cleanTitlePart(recipe.title || recipe.promise || recipe.artifact) || fallbackTopic(bookType);
  if (recipe.lane === "auto") {
    return [`${topic}`, `${topic} Book`, `${topic} Story`];
  }
  if (recipe.lane === "children_story") {
    return [`${topic}`, `${topic} at Bedtime`, `The Little ${topic}`];
  }
  if (bookType === "workbook") {
    return [`${topic} Workbook`, `${topic} Practice Guide`, `${topic} Action Plan`];
  }
  if (bookType === "short_story") {
    return [`The ${topic}`, `${topic} at First Light`, `${topic} and the Last Turn`];
  }
  return [`${topic} Guide`, `${topic} Checklist`, `${topic} Field Guide`];
}

function rationaleFor(lane: MobileCreationLane): string {
  if (lane === "auto") {
    return "Auto is selected, so the planner will choose the best book shape from the full chat history.";
  }
  if (lane === "children_story") {
    return "Best fit because the idea names a young reader and needs a simple, read-aloud story shape.";
  }
  if (lane === "adult_story") {
    return "Best fit because the idea needs a compact story arc with a clear turn and ending.";
  }
  if (lane === "workbook" || lane === "client_tool") {
    return "Best fit because the idea points to guided practice, exercises, or client follow-through.";
  }
  if (lane === "offer_guide") {
    return "Best fit because the idea needs a polished practical guide before a sales or service conversation.";
  }
  return "Best fit because the idea needs a focused, useful reader win.";
}

function cleanAdvisorPatch(
  patch: z.infer<typeof aiAdvisorPatchSchema>
): Partial<MobileBookAdvisorResponse> {
  const cleaned: Partial<MobileBookAdvisorResponse> = {};
  if (patch.recipe) {
    cleaned.recipe = patch.recipe;
  }
  if (patch.warnings) {
    cleaned.warnings = patch.warnings.map((item) => item.trim()).filter(Boolean).slice(0, 5);
  }
  if (patch.followUpSuggestions) {
    cleaned.followUpSuggestions = patch.followUpSuggestions.map((item) => item.trim()).filter(Boolean).slice(0, 5);
  }
  if (patch.bookShapePreview) {
    cleaned.bookShapePreview = patch.bookShapePreview.map((item) => item.trim()).filter(Boolean).slice(0, 8);
  }
  if (patch.titleSuggestions) {
    cleaned.titleSuggestions = patch.titleSuggestions.map((item) => item.trim()).filter(Boolean).slice(0, 5);
  }
  if (patch.rationale?.trim()) {
    cleaned.rationale = patch.rationale.trim();
  }
  return cleaned;
}

function payloadHasEnoughSubstance(payload: MobileCreationDraftPayload): boolean {
  return [payload.rawIdea, payload.sourceNotes, payload.optionalDetails.mustInclude].join(" ").trim().length >= 80;
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Advisor timed out.")), timeoutMs);
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

function fieldLine(label: string, value: string | undefined): string {
  const text = value?.trim();
  return text ? `${label}: ${text}` : "";
}

function chatTranscriptForPrompt(messages: MobileCreationMessage[] | undefined): string {
  const transcript = messages
    ?.slice(-40)
    .map((message) => `${message.role === "assistant" ? "Assistant" : "User"}: ${message.content.trim()}`)
    .filter((line) => line.length > 0)
    .join("\n")
    .trim();
  return transcript ? transcript.slice(0, 2200) : "";
}

function searchableText(payload: MobileCreationDraftPayload): string {
  return [
    payload.rawIdea,
    payload.sourceNotes,
    payload.optionalDetails.mustInclude,
    payload.optionalDetails.tone,
    payload.brief?.topic,
    payload.brief?.audience,
    payload.brief?.desiredOutcome
  ]
    .filter(Boolean)
    .join(" ");
}

function pageCountSearchText(payload: MobileCreationDraftPayload): string {
  const userMessages =
    payload.messages
      ?.filter((message) => message.role === "user")
      .map((message) => message.content)
      .join("\n") ?? "";
  return [
    userMessages,
    payload.rawIdea,
    payload.optionalDetails.mustInclude,
    payload.brief?.topic,
    payload.brief?.desiredOutcome,
    payload.sourceNotes
  ]
    .filter(Boolean)
    .join("\n")
    .slice(-6000);
}

function capturePageCounts(text: string, pattern: RegExp): number[] {
  const matches: number[] = [];
  for (const match of text.matchAll(pattern)) {
    const value = Number.parseInt(match[1] ?? "", 10);
    if (Number.isFinite(value)) {
      matches.push(value);
    }
  }
  return matches;
}

function audienceFor(rawIdea: string, lane: MobileCreationLane): string {
  const age = rawIdea.match(/\b([2-9]|10|11|12)\s*(-| )?(year|yr)s?\s*olds?\b/i)?.[0];
  if (age) {
    return age.replace(/\s+/g, " ");
  }
  const forMatch = rawIdea.match(/\bfor\s+([^,.!?;]+)/i)?.[1]?.trim();
  if (forMatch) {
    return forMatch;
  }
  return audienceFallback(lane);
}

function audienceFallback(lane: MobileCreationLane): string {
  return {
    auto: "readers implied by the idea",
    children_story: "young children",
    adult_story: "adult fiction readers",
    workbook: "learners",
    client_tool: "clients",
    offer_guide: "prospective clients",
    lead_magnet: "ideal readers",
    practical_guide: "readers who want a practical next step"
  }[lane];
}

function titleFromIdea(rawIdea: string, lane: MobileCreationLane): string {
  const cleaned = cleanTitlePart(rawIdea);
  if (cleaned) {
    return cleaned;
  }
  return fallbackTopic(lane === "workbook" || lane === "client_tool" ? "workbook" : lane.includes("story") ? "short_story" : "lead_magnet");
}

function artifactForLane(lane: MobileCreationLane): string {
  return {
    auto: "Book",
    children_story: "Children's story",
    adult_story: "Short story",
    workbook: "Workbook",
    client_tool: "Client workbook",
    offer_guide: "Offer guide",
    lead_magnet: "Lead magnet",
    practical_guide: "Practical guide"
  }[lane];
}

function toneFallback(lane: MobileCreationLane): string {
  return {
    auto: "clear and fitted to the intended book shape",
    children_story: "warm, simple, and read-aloud friendly",
    adult_story: "immersive and emotionally clear",
    workbook: "clear, encouraging, and practical",
    client_tool: "supportive and action-oriented",
    offer_guide: "polished and credible",
    lead_magnet: "concise, useful, and confident",
    practical_guide: "plainspoken and helpful"
  }[lane];
}

function promiseFallback(rawIdea: string, lane: MobileCreationLane): string {
  if (lane === "auto") return `become the best-fitting book for ${cleanTitlePart(rawIdea).toLowerCase() || "the idea"}`;
  if (lane === "children_story") return "a gentle story children can follow and enjoy";
  if (lane === "adult_story") return "a compact story with a clear emotional turn";
  if (lane === "workbook" || lane === "client_tool") return "complete useful practice and leave with a next step";
  if (lane === "offer_guide") return "understand the offer and decide what to do next";
  return `get a useful first step for ${cleanTitlePart(rawIdea).toLowerCase() || "the topic"}`;
}

function mainCharacterFor(rawIdea: string, lane: MobileCreationLane): string {
  if (lane === "children_story") return "a curious child or gentle animal";
  if (lane === "adult_story") return "a character facing a meaningful choice";
  return "";
}

function conflictFallback(lane: MobileCreationLane): string {
  if (lane === "children_story") return "a small worry, surprise, or adventure";
  if (lane === "adult_story") return "a problem that forces a choice";
  return "";
}

function endingFallback(lane: MobileCreationLane): string {
  if (lane === "children_story") return "warm, reassuring, and memorable";
  if (lane === "adult_story") return "satisfying with a clear final image";
  return "";
}

function themeFallback(lane: MobileCreationLane): string {
  if (lane === "children_story") return "kindness, courage, curiosity, or bedtime calm";
  if (lane === "adult_story") return "change, repair, courage, or second chances";
  return "";
}

function nextStepFallback(lane: MobileCreationLane): string {
  if (lane === "lead_magnet") return "invite the reader to take one clear next step";
  if (lane === "offer_guide") return "book a call, compare options, or understand the method";
  if (lane === "workbook" || lane === "client_tool") return "finish a checklist or action plan";
  return "";
}

function exercisesFallback(lane: MobileCreationLane): string {
  if (lane === "workbook" || lane === "client_tool") return "short exercises, reflection prompts, and a recap checklist";
  return "";
}

function laneForLegacyIntent(intent: MobileCreationBrief["intent"]): MobileCreationLane {
  const lanes = {
    collect_leads: "lead_magnet",
    teach_practice: "workbook",
    support_clients: "client_tool",
    explain_offer: "offer_guide",
    short_story: "adult_story"
  } as const satisfies Record<MobileCreationBrief["intent"], MobileCreationLane>;
  return lanes[intent];
}

function laneFromBookTypeChoice(choice: MobileBookTypeChoice | undefined): MobileCreationLane | undefined {
  if (!choice || choice === "auto") {
    return undefined;
  }
  if (choice === "short_story") {
    return "adult_story";
  }
  return choice;
}

function laneFromProductBookType(bookType: MobileCreationPresets["bookType"]): MobileCreationLane {
  if (bookType === "workbook") {
    return "workbook";
  }
  if (bookType === "short_story") {
    return "adult_story";
  }
  return "lead_magnet";
}

function productBookTypeForLane(lane: MobileCreationLane): MobileCreationPresets["bookType"] {
  if (lane === "workbook" || lane === "client_tool") {
    return "workbook";
  }
  if (lane === "adult_story" || lane === "children_story") {
    return "short_story";
  }
  return "lead_magnet";
}

function intentForLane(lane: MobileCreationLane): MobileCreationBrief["intent"] {
  if (lane === "workbook") return "teach_practice";
  if (lane === "client_tool") return "support_clients";
  if (lane === "offer_guide") return "explain_offer";
  if (lane === "adult_story" || lane === "children_story") return "short_story";
  return "collect_leads";
}

function laneLabel(lane: MobileCreationLane): string {
  return {
    auto: "Auto",
    children_story: "Children's story",
    adult_story: "Short story",
    workbook: "Workbook",
    client_tool: "Client tool",
    offer_guide: "Offer guide",
    lead_magnet: "Lead magnet",
    practical_guide: "Practical guide"
  }[lane];
}

function bookTypeLabel(bookType: MobileCreationPresets["bookType"]): string {
  return bookType === "workbook"
    ? "workbook or study guide"
    : bookType === "short_story"
      ? "short story"
      : "lead magnet ebook or practical guide";
}

function wordCount(value: string): number {
  return value.trim().split(/\s+/).filter(Boolean).length;
}

function looksFactualOrCurrent(value: string): boolean {
  return /\b(research|study|studies|statistics|current|recent|latest|medical|legal|financial|law|health|science|evidence)\b/i.test(value);
}

function cleanTitlePart(value: string): string {
  const cleaned = value
    .replace(/^create\s+(an?|the)?\s*/i, "")
    .replace(/\b(book|ebook|guide|workbook|story|lead magnet|bedtime)\b/gi, "")
    .replace(/\bfor\s+([2-9]|10|11|12)\s*(-| )?(year|yr)s?\s*olds?\b/gi, "")
    .replace(/\bfor\s+[^,.!?;]+/i, "")
    .trim();
  if (!cleaned) {
    return "";
  }
  return cleaned
    .split(/\s+/)
    .slice(0, 6)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

function fallbackTopic(bookType: MobileCreationPresets["bookType"]): string {
  return bookType === "workbook" ? "Practice" : bookType === "short_story" ? "Moon Garden" : "Starter";
}
