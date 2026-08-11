import {
  explicitTargetPagesFromText,
  generateJsonWithRetry,
  type TextModelAdapter
} from "@book-maker/core";
import type { z } from "zod";
import { withTimeout } from "./withTimeout.js";
import { linearizeCreationMessages } from "./creationChatTree.js";
import {
  artifactForLane,
  audienceFallback,
  audienceFor,
  cleanTitlePart,
  conflictFallback,
  endingFallback,
  exercisesFallback,
  fallbackTopic,
  laneForLegacyIntent,
  laneFromBookTypeChoice,
  laneFromProductBookType,
  looksFactualOrCurrent,
  mainCharacterFor,
  nextStepFallback,
  productBookTypeForLane,
  promiseFallback,
  themeFallback,
  titleFromIdea,
  toneFallback,
  wordCount
} from "./mobileCreationLanes.js";
import {
  aiAdvisorPatchSchema,
  mobileBookAdvisorResponseSchema,
  mobileBookRecipeSchema,
  mobileCreationDraftPayloadSchema,
  type MobileBookAdvisorResponse,
  type MobileBookRecipe,
  type MobileCreationDraftPayload,
  type MobileCreationLane,
  type MobileCreationPresets
} from "./mobileCreationSchemas.js";

/**
 * The deterministic book advisor and its payload normalization: lane
 * detection, recipe completion, preset recommendation and the optional AI
 * enrichment patch. Split out of mobileCreation.ts, which re-exports the
 * public pieces so the `./mobileCreation.js` surface is unchanged.
 */

type AdvisorOptions = {
  enrich?: ((payload: MobileCreationDraftPayload, base: MobileBookAdvisorResponse) => Promise<Partial<MobileBookAdvisorResponse>>) | undefined;
  timeoutMs?: number | undefined;
};

export async function adviseMobileBook(
  payload: MobileCreationDraftPayload,
  options: AdvisorOptions = {}
): Promise<MobileBookAdvisorResponse> {
  const parsed = activeThreadPayload(mobileCreationDraftPayloadSchema.parse(payload));
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
  return explicitTargetPagesFromText(pageCountSearchText(normalizePayload(payload)));
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

/**
 * Stored payload messages hold the full branch tree (editing a message forks
 * a sibling). Anything that reads the payload as a conversation — prompt
 * composition, advisors, title and page-count detection — must only see the
 * selected thread, or abandoned branches leak into the generated book.
 */
function activeThreadPayload(payload: MobileCreationDraftPayload): MobileCreationDraftPayload {
  if (!payload.messages || payload.messages.length === 0) {
    return payload;
  }
  const active = linearizeCreationMessages(payload.messages).active;
  return active.length === payload.messages.length ? payload : { ...payload, messages: active };
}

export function normalizePayload(payload: MobileCreationDraftPayload): MobileCreationDraftPayload {
  const resolved = activeThreadPayload(payload);
  if (resolved.rawIdea.trim() || !resolved.brief) {
    return resolved;
  }
  const brief = resolved.brief;
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
    selectedPresets: resolved.selectedPresets,
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

export function completeRecipe(payload: MobileCreationDraftPayload, lane: MobileCreationLane): MobileBookRecipe {
  const existing = payload.recipe;
  const rawIdea = payload.rawIdea.trim() || payload.brief?.topic.trim() || "A useful book";
  const details = payload.optionalDetails;
  // Every other source here is already capped at the recipe's own limits by the
  // draft or brief schema, but rawIdea holds up to 2000 characters — it joins
  // the user's chat turns — and audienceFor/promiseFallback/titleFromIdea echo
  // spans of it back. Clamping is what keeps an overflow from throwing a
  // ZodError out of adviseMobileBook and reaching the app as a 500.
  const audience = clampBriefText(
    existing?.audience || audienceFor(rawIdea, lane) || payload.brief?.audience || audienceFallback(lane),
    280
  );
  const title = clampBriefText(details.title || existing?.title || payload.brief?.title || titleFromIdea(rawIdea, lane), 160);
  const tone = details.tone || existing?.tone || payload.brief?.tone || toneFallback(lane);
  const promise = clampBriefText(existing?.promise || payload.brief?.desiredOutcome || promiseFallback(rawIdea, lane), 500);
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
  const referenceLength = payload.sourceNotes.length + attachmentContentLength(payload);
  if (lane === "auto") {
    return presetsWithPageCount({
      bookType: "lead_magnet",
      bookTypeChoice: "auto",
      lengthPreset: referenceLength > 1200 ? "standard" : "short",
      qualityPreset: "balanced",
      imagesEnabled: true,
      coverEnabled: true,
      illustrationsEnabled: true
    }, explicitTargetPages);
  }
  if (lane === "workbook" || lane === "client_tool") {
    return presetsWithPageCount(
      {
        bookType: "workbook",
        bookTypeChoice: "auto",
        lengthPreset: "standard",
        qualityPreset: "balanced",
        imagesEnabled: true,
        coverEnabled: true,
        illustrationsEnabled: true
      },
      explicitTargetPages
    );
  }
  if (lane === "adult_story" || lane === "children_story") {
    return presetsWithPageCount({
      bookType: "short_story",
      bookTypeChoice: "auto",
      lengthPreset: referenceLength > 800 ? "standard" : "short",
      qualityPreset: "balanced",
      imagesEnabled: true,
      coverEnabled: true,
      illustrationsEnabled: true
    }, explicitTargetPages);
  }
  return presetsWithPageCount({
    bookType: "lead_magnet",
    bookTypeChoice: "auto",
    lengthPreset: referenceLength > 1200 || lane === "offer_guide" || lane === "practical_guide" ? "standard" : "short",
    qualityPreset: lane === "offer_guide" ? "premium" : "balanced",
    imagesEnabled: true,
    coverEnabled: true,
    illustrationsEnabled: true
  }, explicitTargetPages);
}

function attachmentContentLength(payload: MobileCreationDraftPayload): number {
  return (payload.attachments ?? []).reduce((total, attachment) => total + attachment.content.length, 0);
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
      coverEnabled: selectedPresets.coverEnabled,
      illustrationsEnabled: selectedPresets.illustrationsEnabled,
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
  if (payload.sourceNotes.trim() || (payload.attachments?.length ?? 0) > 0) score += 7;
  score -= Math.min(15, warnings.length * 5);
  return Math.max(0, Math.min(100, score));
}

function warningMessages(payload: MobileCreationDraftPayload, lane: MobileCreationLane): string[] {
  const warnings: string[] = [];
  const text = searchableText(payload);
  if (payload.sourceNotes.length > 9000) {
    warnings.push("The pasted notes are long. The planner will treat them as reference material, not a full manuscript.");
  }
  if (attachmentContentLength(payload) > 20000) {
    warnings.push("The uploaded files are long. The planner will treat them as reference material, not a full manuscript.");
  }
  if (looksFactualOrCurrent(text) && !payload.sourceNotes.trim() && (payload.attachments?.length ?? 0) === 0) {
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
  if (attachmentContentLength(payload) >= 80) {
    return true;
  }
  return [payload.rawIdea, payload.sourceNotes, payload.optionalDetails.mustInclude].join(" ").trim().length >= 80;
}

/** Cuts text to a schema limit at a word boundary (when one is close enough). */
export function clampBriefText(value: string, max: number): string {
  const trimmed = value.trim();
  if (trimmed.length <= max) {
    return trimmed;
  }
  const slice = trimmed.slice(0, max);
  const lastSpace = slice.lastIndexOf(" ");
  return (lastSpace > max * 0.6 ? slice.slice(0, lastSpace) : slice).trim();
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
