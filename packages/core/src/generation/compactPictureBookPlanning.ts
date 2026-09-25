import { mediaSettingsMobileRecord } from "../schemas/jsonCoercion.js";
import { z } from "zod";
import type { BookPlan, ChapterBrief, ChapterPlan, CreateProjectInput } from "../schemas/book.js";
import type { TextModelAdapter } from "../adapters/types.js";
import { hasResearchIntent } from "./researchIntent.js";
import { generateJsonWithRetry } from "./generateJsonWithRetry.js";
import { firstPageBriefFieldsForRange } from "./pageBriefContract.js";
import { decodeGeneratedChapterBrief } from "./generatedChapterBriefAcceptance.js";
import { targetLanguageGenerationGuidance } from "../prompting/language.js";
import { kidsReadingGuidanceLines } from "../prompting/readingLevel.js";
import { planLibraryCharacterGuidance } from "./planLibraryCharacters.js";
import { libraryCharactersFromMediaSettings } from "./libraryCharacters.js";
import { pageGetsInteriorIllustration } from "./illustrationSlots.js";

export function usesCompactPictureBookPlanning(input: CreateProjectInput): boolean {
  // Page-count and prose requirements select the workflow; artwork is optional.
  return input.category === "KIDS" && input.targetPages >= 5 && input.targetPages <= 40 &&
    input.mediaSettings.finalReview === true &&
    (!input.mediaSettings.generationStrategy || input.mediaSettings.generationStrategy === "auto") && !hasResearchIntent(input) &&
    !mediaSettingsMobileRecord(input.mediaSettings).import;
}

export const PICTURE_BOOK_STORY_OBLIGATIONS = [
  "Preserve every concrete requirement in the exact brief, especially deadlines (for example before moonrise), object counts, and each named protagonist's distinct growth.",
  "When the brief requests growth, give each specified protagonist an initial limitation that affects the action, a consequential choice that challenges it, and an observable changed action, including a wise mentor. Being helpful throughout is not a change. Keep saved character canon intact; a strength can be applied too rigidly without becoming a new personality.",
  "Make clues change what the characters know and do. When several objects must be recovered, vary the obstacle or cooperative choice; discovering, counting and confirming the same fact are not three developments. A known location can still lead to a difficult retrieval.",
  "Keep a stable prop inventory and each character/group’s entrance and exit locations; show any necessary transfer, return or loss before the state changes. Track where characters, neighbors and objects move; never recover a counted object twice or reset the group to an earlier location. Carry the causal state across chapter boundaries.",
  "Schedule the requested ending event before its deadline, then close the story; the last page must not demand a new scene. A boast or mistaken belief can resolve through changed action."
];

function illustrationPageIndexes(input: CreateProjectInput): number[] {
  return Array.from({ length: input.targetPages }, (_, i) => i + 1).filter((index) => pageGetsInteriorIllustration(input, index));
}

function illustrationCadenceGuidance(input: CreateProjectInput): string {
  const pages = illustrationPageIndexes(input);
  return `Plan ${pages.length} interior illustrations, only on story pages ${pages.length ? pages.join(", ") : "none"}. All other pages remain text-only; do not add illustration moments for them. Keep all ${input.targetPages} story pages and their complete narrative progression regardless of illustration cadence.`;
}

/** A small production plan, not a long-form author dossier. Canonical postprocessing still applies. */
export function compactPictureBookPlanMessages(input: CreateProjectInput) {
  const illustrated = illustrationPageIndexes(input).length > 0;
  return [{ role: "system" as const, content: [
    "Create a concise production plan for a short children's story. Return the plan fields at the JSON root.",
    "Keep total plan prose about 700–1000 words. Each chapter summary is one sentence; keyBeats are 3–5 short concrete turns, not page prose. Do not duplicate the brief in style rules.",
    illustrated
      ? "Give each chapter only 1–2 short illustration moments. IllustrationPlan needs a short globalStyle and 2–4 pageRules; reusable character design comes from saved portraits."
      : "Leave chapter illustrationPrompts empty and illustrationPlan.pageRules empty; do not add interior illustration moments.",
    "Use 2–4 specific voiceGuide rules, 3–5 antiAiRules and concise continuityRules. Do not generate unrelated writing samples, an author dossier, or duplicate structured style rules.",
    `Chapter targetPages must sum to exactly ${input.targetPages}; preserve requested title, characters, age band and tone.`,
    illustrationCadenceGuidance(input),
    "Set questions=[] for coherent requests; make ordinary creative choices yourself. Ask only if a missing subject or contradictory requirement prevents understanding. Keep researchQueries=[] for this fictional story.",
    "Seed promises with requested outcomes and distinct character changes. Set openingHook to one concrete opening moment. Do not add extra named main characters unless requested.",
    "In continuityRules, record one compact arc contract per protagonist whose growth is requested: initial limitation -> difficult choice -> changed action, naming concrete story moments. Add one compact prop-state contract when counts or transfers matter: initial inventory -> losses/recoveries/transfers -> final state. Use these instead of generic growth/inventory reminders; stay within the existing plan budget.",
    ...PICTURE_BOOK_STORY_OBLIGATIONS, ...targetLanguageGenerationGuidance(input.language), ...kidsReadingGuidanceLines(input),
    ...planLibraryCharacterGuidance(libraryCharactersFromMediaSettings(input.mediaSettings))
  ].join(" ") }, { role: "user" as const, content: JSON.stringify({ userInput: input }) }];
}

type ChapterRange = { chapter: ChapterPlan; startPage: number; endPage: number };
const beatSchema = z.strictObject({
  pageIndex: z.number().int().positive(), chapterIndex: z.number().int().positive(),
  purpose: z.string().min(12), beat: z.string().min(12),
  requiredContinuity: z.array(z.string().min(1)), endingPressure: z.string().min(12), imageMoment: z.string().min(1).optional()
});

/** One bounded map still passes the worker's configured critic and mandatory integrity audit. */
export async function generateCompactPictureBookMap(options: {
  input: CreateProjectInput; plan: BookPlan; textModel: TextModelAdapter; chapterRanges: ChapterRange[];
}): Promise<ChapterBrief[]> {
  const schema = z.strictObject({ pages: z.array(beatSchema).length(options.input.targetPages) }).superRefine((result, context) => {
    for (const [i, page] of result.pages.entries()) {
      const chapter = options.chapterRanges.find((range) => page.pageIndex >= range.startPage && page.pageIndex <= range.endPage);
      if (page.pageIndex !== i + 1 || !chapter || page.chapterIndex !== chapter.chapter.index) context.addIssue({ code: "custom", message: `Page position ${i + 1} must use its exact ordered global index and assigned chapter.` });
    }
  });
  const firstPage = firstPageBriefFieldsForRange(options, 1, options.input.targetPages);
  const result = await generateJsonWithRetry(options.textModel, {
    // Preserve the saved route/effort that this >24-page input formerly used per chapter.
    // This is the entire map, unlike the per-chapter call sharing its route.
    // Sparse Premium exhausted a 16k effective cap entirely on reasoning; the
    // 24k retry completed. Reserve that measured headroom on the first call.
    purpose: "generate-chapter-brief", temperature: Math.min(0.7, options.input.temperature), maxTokens: 24_000,
    schema, repairAttempts: 2,
    messages: [{ role: "system", content: [
      "Create the complete page map for this short children's story in one compact response. Return pages only; each page has its exact global pageIndex and chapterIndex.",
      "Keep purpose within 8 words, beat within 18 words, endingPressure within 10 words, and requiredContinuity to at most two short changed/essential facts per page. Do not repeat chapter summaries, cast descriptions or global rules on every page.",
      illustrationPageIndexes(options.input).length
        ? "imageMoment is optional when the beat already gives the visual scene."
        : "This story has no interior illustrations; omit imageMoment on every page.",
      "Every page advances the action; bridges preserve where the last page left the characters and objects, without replaying its beat. Do not write reader-facing prose.",
      "Place the continuityRules arc and prop-state contracts into concrete beats. Establish a limitation before its turning choice; preserve discoveries until the clue that enables them. A repeated task must change the obstacle, knowledge or relationship.",
      "endingPressure describes the unresolved change that carries into the next scene, in declarative author notes. It is not a question to print or a required closing sentence. Let scene action carry page turns; allow a quiet final resolution.",
      illustrationCadenceGuidance(options.input),
      ...PICTURE_BOOK_STORY_OBLIGATIONS, ...firstPage.rules, ...targetLanguageGenerationGuidance(options.input.language)
    ].join(" ") }, { role: "user", content: JSON.stringify({
      userPrompt: options.input.prompt, targetPages: options.input.targetPages, ...firstPage.payload,
      book: { title: options.plan.title, premise: options.plan.premise, promises: options.plan.promises, continuityRules: options.plan.continuityRules },
      characters: options.plan.characters,
      chapterRanges: options.chapterRanges.map(({ chapter, startPage, endPage }) => ({ chapterIndex: chapter.index, title: chapter.title, summary: chapter.summary, keyBeats: chapter.keyBeats, startPage, endPage }))
    }) }]
  });
  const pages = schema.parse(result.data).pages;
  return options.chapterRanges.map(({ chapter, startPage, endPage }) => decodeGeneratedChapterBrief({
    chapterIndex: chapter.index, title: chapter.title, summary: chapter.summary, continuityFocus: [],
    pages: pages.filter((page) => page.chapterIndex === chapter.index)
  }, { chapterIndex: chapter.index, pageRange: { start: startPage, end: endPage }, allowCompleteLocalPageNumbering: false }));
}
