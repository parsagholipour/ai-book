import type { ChatMessage } from "../adapters/types.js";
import type { CreateProjectInput } from "../schemas/book.js";
import { targetLanguageGenerationGuidance } from "../prompting/language.js";
import { kidsReadingGuidanceLines } from "../prompting/readingLevel.js";
import { plannerToneGuidance, toneProfileFromMediaSettings } from "../prompting/tone.js";
import { libraryCharactersFromMediaSettings } from "./libraryCharacters.js";
import { planLibraryCharacterGuidance } from "./planLibraryCharacters.js";
import { BYLINE_IS_TYPESET_RULE } from "./markdown.js";

/** Compactness limits detail per chapter, never the number of chapters a long book needs. */
export const QUICK_PLAN_GUIDANCE = [
  "Use a compact Quick Draft plan. Preserve the complete chapter outline and every explicit user requirement, even for long books.",
  "Keep shared plan prose around 300–400 words. Each chapter needs a one-sentence summary and 3–5 short, concrete keyBeats, normally under 70 words combined. Scale the outline with the book's length; never omit later chapters or the ending to meet a prose budget.",
  "Use 2–4 specific voiceGuide rules, 3–5 antiAiRules, and only load-bearing continuityRules. Avoid repeating the brief across fields. Do not generate an author dossier, writing samples, or duplicate structured style rules.",
  "For fiction, retain causal progression, each requested protagonist's initial limitation, consequential choice and changed action, stable prop state, and the actual ending. For nonfiction, give each chapter distinct subject matter and an actionable or explanatory outcome."
];

export function quickPlanMessages(input: CreateProjectInput, options: {
  autoGuidance: string[];
  maxChapterPages?: number;
}): ChatMessage[] {
  return [{ role: "system", content: [
    "Create a complete, concise book production plan. Return plan fields at the JSON root.",
    ...QUICK_PLAN_GUIDANCE,
    `Chapter targetPages must sum to exactly ${input.targetPages}. Use real chapters, not one heading per page.`,
    ...(options.maxChapterPages ? [`No chapter may exceed ${options.maxChapterPages} pages; split longer material into distinct chapters. Vary chapter lengths with their material.`] : []),
    "chapters is required: each entry has index, title, summary, targetPages and keyBeats. Include title, premise, audience, writingComplexity, voiceGuide, antiAiRules, characters, locations, continuityRules, promises and illustrationPlan. Set openingHook to one concrete opening moment.",
    "No web research was performed for this Quick Draft plan. Use supplied source material where available; do not claim to have searched or verified current facts, invent sources or citations, or treat uncertain claims as established. Keep researchQueries=[].",
    "Set questions=[] for coherent requests; decide ordinary creative details yourself. Ask at most one plain, self-contained question only if a missing subject or contradictory requirement prevents understanding. For a necessary choice, include 2–4 complete answers with answerKind=choice; use answerKind=open and options=[] for free text.",
    "Seed promises with concrete outcomes that later chapters must resolve; give each chapter new material rather than repeated summaries. Keep character descriptions and visualRules brief but consistent, and preserve user-supplied names.",
    input.mediaSettings.fullIllustrations
      ? "Give each chapter at most 1–2 short illustration moments using exact character names. Use a short illustrationPlan.globalStyle and 2–4 pageRules, respecting the requested illustration cadence."
      : "Leave chapter illustrationPrompts and illustrationPlan.pageRules empty; do not add interior illustration moments.",
    BYLINE_IS_TYPESET_RULE,
    ...options.autoGuidance,
    ...targetLanguageGenerationGuidance(input.language),
    ...kidsReadingGuidanceLines(input),
    ...plannerToneGuidance(toneProfileFromMediaSettings(input.mediaSettings)),
    ...planLibraryCharacterGuidance(libraryCharactersFromMediaSettings(input.mediaSettings))
  ].join(" ") }, { role: "user", content: JSON.stringify({ userInput: input }) }];
}
