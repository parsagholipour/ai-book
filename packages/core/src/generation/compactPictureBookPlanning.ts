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
  "Make clues change what the characters know and do: observation -> inference -> consequential action. A requested pattern in where objects moved needs observed landing places of at least two of those objects, a concrete comparison, and a useful prediction; environmental signs alone do not replace it. Schedule the comparison after the observations. Anchor the predicted direction and destination to those observed places; do not send a search down a different route without a new clue or a stated reason. Keep an author's hidden prop inventory distinct from reader/character discoveries; do not reveal every search answer during setup. A known location can still lead to a difficult retrieval.",
  "Allocate scenes to new discoveries, consequences and relationship changes. Before finalizing, test each neighboring pair: if removing either page loses no discovery, consequential choice, action, cost or emotional change, combine its work with execution and reuse the slot. An object already delivered cannot be delivered to the same place again without an intervening move. Vary repeated retrievals by the choice or cooperation required, not just scenery. After a problem is solved, preserve requested escort/return events without replaying its solutions; let those scenes test changed behavior and then close. Use no fixed act percentages or forced danger to fill pages.",
  "Keep a stable prop inventory and each character/group’s entrance and exit locations. At a crossing, specify who crosses first, where the helper stands, who takes the object, and where they meet. Show necessary transfers before ownership changes; never lift an object from the ground after already carrying it. Carry the causal state across chapter boundaries.",
  "Track prop condition and unresolved setups as well as location: damage must be repaired, replaced or bypassed before reuse, and an agreed method must be established before characters rely on it. Remembering an object's old location does not put it back there. Give each complication a concrete payoff in this book. Correct known mistakes promptly unless a real constraint prevents it. Combine permission, preparation and execution of a simple action; spend freed scenes on consequential discoveries, choices or emotional change instead of repeated readiness.",
  "Introduce a requested deadline before an extended search so it can shape decisions. Schedule the requested ending event before its deadline, then close the story; the last page must not demand a new scene. A boast or mistaken belief can resolve through changed action."
];

function illustrationPageIndexes(input: CreateProjectInput): number[] {
  return Array.from({ length: input.targetPages }, (_, i) => i + 1).filter((index) => pageGetsInteriorIllustration(input, index));
}

function illustrationCadenceGuidance(input: CreateProjectInput): string {
  const pages = illustrationPageIndexes(input);
  return `Plan ${pages.length} interior illustrations, only on story pages ${pages.length ? pages.join(", ") : "none"}. All other pages remain text-only; do not add illustration moments for them. Keep all ${input.targetPages} story pages and their complete narrative progression regardless of illustration cadence.`;
}

/** A small production plan, not a long-form author dossier. Canonical postprocessing still applies. */
export function compactPictureBookPlanMessages(input: CreateProjectInput, storyFirst = false) {
  const illustrated = illustrationPageIndexes(input).length > 0;
  return [{ role: "system" as const, content: [
    "Create a concise production plan for a short children's story. Return the plan fields at the JSON root.",
    storyFirst
      ? "Write storyTreatment first: a complete 450–700 word causal story in continuous prose, from the opening through the actual ending. Develop choices, discoveries, their consequences and each requested character change before deciding how to distribute pages. No chapter list, page numbers, page quotas or one-sentence-per-page outline. Combine asking, preparing, doing and confirming a simple action into one event. Use the remaining narrative space for distinct consequences, relationships, sensory experience and meaningful quiet moments. Do not invent danger to fill space. Preserve explicit chapter requirements from the brief for the later allocation pass. Return supporting plan metadata after storyTreatment; omit chapters and bookArc. Keep total plan prose about 700–1000 words."
      : "Keep total plan prose about 700–1000 words. Each chapter summary is one sentence; keyBeats are 3–5 short concrete turns, not page prose. Do not duplicate the brief in style rules.",
    illustrated
      ? "Give each chapter only 1–2 short illustration moments. IllustrationPlan needs a short globalStyle and 2–4 pageRules; reusable character design comes from saved portraits."
      : "Leave chapter illustrationPrompts empty and illustrationPlan.pageRules empty; do not add interior illustration moments.",
    "Use 2–4 specific voiceGuide rules, 3–5 antiAiRules and concise continuityRules. Do not generate unrelated writing samples, an author dossier, or duplicate structured style rules.",
    storyFirst
      ? `This story will later occupy ${input.targetPages} pages; develop enough meaningful material for that length, without allocating it yet. Preserve requested title, characters, age band and tone.`
      : `Chapter targetPages must sum to exactly ${input.targetPages}; preserve requested title, characters, age band and tone.`,
    illustrationCadenceGuidance(input),
    "Set questions=[] for coherent requests; make ordinary creative choices yourself. Ask only if a missing subject or contradictory requirement prevents understanding. Keep researchQueries=[] for this fictional story.",
    "Seed promises with requested outcomes and distinct character changes. Set openingHook to one concrete opening moment. Do not add extra named main characters unless requested.",
    "In continuityRules, record one compact arc contract per protagonist whose growth is requested: initial limitation -> difficult choice -> changed action, naming concrete story moments. Establish the limitation early enough to affect events; do not introduce and resolve it together near the ending. Show requested traits through choices and dialogue. Add compact prop-state and clue contracts when relevant: initial inventory -> transfers -> final state; observed comparison -> useful inference -> next action. Use these instead of generic reminders; stay within the existing plan budget.",
    ...PICTURE_BOOK_STORY_OBLIGATIONS, ...targetLanguageGenerationGuidance(input.language), ...kidsReadingGuidanceLines(input),
    ...planLibraryCharacterGuidance(libraryCharactersFromMediaSettings(input.mediaSettings))
  ].join(" ") }, { role: "user" as const, content: JSON.stringify({ userInput: input }) }];
}

type ChapterRange = { chapter: ChapterPlan; startPage: number; endPage: number };
const beatSchema = z.strictObject({
  pageIndex: z.number().int().positive(),
  // Tolerate legacy model labels, but never use them for chapter ownership.
  chapterIndex: z.unknown().optional(),
  purpose: z.string().min(12), beat: z.string().min(12),
  requiredContinuity: z.array(z.string().min(1)), endingPressure: z.string().min(12), imageMoment: z.string().min(1).optional()
});

function chapterOwnership(targetPages: number, ranges: readonly { chapter: { index: number }; startPage: number; endPage: number }[]): Map<number, number> {
  const owners = new Map<number, number>(), chapters = new Set<number>();
  let nextPage = 1;
  for (const { chapter, startPage, endPage } of ranges) {
    if (!Number.isInteger(chapter.index) || chapter.index < 1 || chapters.has(chapter.index) ||
      startPage !== nextPage || !Number.isInteger(endPage) || endPage < startPage || endPage > targetPages)
      throw new Error("Compact picture-book chapter ranges must cover every page exactly once in order with unique chapters.");
    chapters.add(chapter.index);
    for (let pageIndex = startPage; pageIndex <= endPage; pageIndex += 1) owners.set(pageIndex, chapter.index);
    nextPage = endPage + 1;
  }
  if (nextPage !== targetPages + 1) throw new Error("Compact picture-book chapter ranges must cover every requested page.");
  return owners;
}

/** One bounded map passes mandatory integrity; the compact workflow reviews the finished prose. */
export async function generateCompactPictureBookMap(options: {
  input: CreateProjectInput; plan: BookPlan; textModel: TextModelAdapter; chapterRanges: ChapterRange[];
}): Promise<ChapterBrief[]> {
  // Invalid local allocation cannot be repaired by another paid model attempt.
  chapterOwnership(options.input.targetPages, options.chapterRanges);
  const schema = z.strictObject({
    pages: z.array(beatSchema).length(options.input.targetPages),
    // Older complete maps remain usable without buying a regeneration for metadata.
    chapters: z.array(z.strictObject({
      title: z.string().trim().min(1), summary: z.string().trim().min(1), endPage: z.number().int().positive()
    })).min(1).max(Math.floor(options.input.targetPages / 2)).optional()
  }).superRefine((result, context) => {
    for (const [i, page] of result.pages.entries()) {
      if (page.pageIndex !== i + 1) context.addIssue({ code: "custom", message: `Page position ${i + 1} must use its exact ordered global index.` });
    }
    if (result.chapters && (result.chapters.at(-1)!.endPage !== options.input.targetPages ||
      result.chapters.some((chapter, i, chapters) => chapter.endPage <= (chapters[i - 1]?.endPage ?? 0)))) {
      context.addIssue({ code: "custom", message: "Chapter endPage values must increase strictly in chapter order and end at targetPages; every chapter contains at least one page." });
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
      "Create the complete page map for this short children's story in one compact response. Allocate the complete sequence of scenes first, then place chapter boundaries at the resulting story turns. Return pages, then chapters: group the completed scenes into a few coherent story phases, each with a short title, one-sentence summary and inclusive global endPage. End pages must increase strictly and the last must equal targetPages. Choose the chapter count and lengths from the story; every chapter must contain at least one page. Omit per-page chapterIndex: the application assigns ownership from those boundaries.",
      "Keep purpose within 8 words, beat within 18 words, endingPressure within 10 words, and requiredContinuity to at most two short changed/essential facts per page. Do not repeat chapter summaries, cast descriptions or global rules on every page.",
      illustrationPageIndexes(options.input).length
        ? "imageMoment is optional when the beat already gives the visual scene."
        : "This story has no interior illustrations; omit imageMoment on every page.",
      "Use purpose to name what changes on this page, rather than label a task. Put the causal action in beat and essential entry/exit, possession or knowledge state in requiredContinuity. Bridges preserve the previous scene without replaying it. Do not write reader-facing prose.",
      options.plan.storyTreatment
        ? "Distribute the completed storyTreatment across exactly targetPages. Preserve its causal sequence and ending. Each page earns its place with action, new information, emotion or a visual development; a scene may span pages without repeating its work. Combine mechanical preparation/execution and use freed space for developed consequences. Do not replace this story with a new plot, reveal a later discovery early, or stretch a solved task just to occupy slots. Honor explicit chapter/page constraints in the user brief when grouping the completed allocation."
        : "Use storyOutline as the existing story's causal starting point, not as one chapter or equal page allotment per entry. Combine procedural steps and develop the consequences into complete scenes. Chapter-number references in preliminary continuity notes describe the intended event order, not the new chapter boundaries.",
      "Place the continuityRules arc, clue and prop-state contracts into concrete beats. Diagnose any earlier critic warning against the scenes and revise the affected assignments now; do not pass a warning to the writer beside the unchanged defective beat. Choose chapter boundaries and names only after assigning the scenes; the preliminary outline is not a quota of actions or chapters to fill. Do not pad a chapter to match its neighbors or reserve equal space for permission, preparation and execution. Follow any explicit chapter or page-allocation requirements in the exact user brief. Preserve saved canon.",
      "endingPressure describes the unresolved change that carries into the next scene, in declarative author notes. It is not a question to print or a required closing sentence. Let scene action carry page turns; allow a quiet final resolution.",
      illustrationCadenceGuidance(options.input),
      ...PICTURE_BOOK_STORY_OBLIGATIONS, ...firstPage.rules, ...targetLanguageGenerationGuidance(options.input.language)
    ].join(" ") }, { role: "user", content: JSON.stringify({
      userPrompt: options.input.prompt, targetPages: options.input.targetPages, ...firstPage.payload,
      book: { title: options.plan.title, premise: options.plan.premise, promises: options.plan.promises, continuityRules: options.plan.continuityRules },
      characters: options.plan.characters,
      ...(options.plan.storyTreatment ? { storyTreatment: options.plan.storyTreatment }
        : { storyOutline: options.plan.chapters.map(chapter => chapter.summary) })
    }) }]
  });
  const parsed = schema.parse(result.data);
  const ranges = parsed.chapters ? parsed.chapters.map((chapter, i, chapters) => ({
    chapter: { index: i + 1, title: chapter.title, summary: chapter.summary },
    startPage: (chapters[i - 1]?.endPage ?? 0) + 1, endPage: chapter.endPage
  })) : options.chapterRanges;
  const owners = chapterOwnership(options.input.targetPages, ranges);
  // Only chapter labels are derived. Preserve the validated order and all narrative fields.
  const pages = parsed.pages.map(page => ({ ...page, chapterIndex: owners.get(page.pageIndex)! }));
  return ranges.map(({ chapter, startPage, endPage }) => decodeGeneratedChapterBrief({
    chapterIndex: chapter.index, title: chapter.title, summary: chapter.summary, continuityFocus: [],
    pages: pages.filter((page) => page.chapterIndex === chapter.index)
  }, { chapterIndex: chapter.index, pageRange: { start: startPage, end: endPage }, allowCompleteLocalPageNumbering: false }));
}

/** Adopt only a complete scene allocation; malformed maps still face mandatory integrity. */
export function compactPictureBookPlanForBriefs(input: CreateProjectInput, plan: BookPlan, briefs: readonly ChapterBrief[]): BookPlan {
  if (input.targetPages <= 24 || !usesCompactPictureBookPlanning(input) || briefs.length === 0 || briefs.length > Math.floor(input.targetPages / 2)) return plan;
  let nextPage = 1;
  for (const [i, brief] of briefs.entries()) {
    if (brief.chapterIndex !== i + 1 || brief.pages.length === 0) return plan;
    for (const page of brief.pages) {
      if (page.pageIndex !== nextPage || page.chapterIndex !== brief.chapterIndex) return plan;
      nextPage += 1;
    }
  }
  if (nextPage !== input.targetPages + 1) return plan;
  const sameStructure = plan.chapters.length === briefs.length && plan.chapters.every((chapter, i) =>
    chapter.index === briefs[i]!.chapterIndex && chapter.title === briefs[i]!.title && chapter.summary === briefs[i]!.summary);
  if (sameStructure && plan.chapters.every((chapter, i) => chapter.targetPages === briefs[i]!.pages.length)) return plan;
  const chapters = briefs.map((brief, i) => ({
    ...(sameStructure ? plan.chapters[i]! : { index: brief.chapterIndex, title: brief.title, summary: brief.summary,
      keyBeats: brief.pages.map(page => page.beat), illustrationPrompts: brief.pages.flatMap(page => page.imageMoment ? [page.imageMoment] : []) }),
    targetPages: brief.pages.length
  }));
  // The preliminary arc's chapter-indexed jobs are obsolete after regrouping. The
  // book's promises and continuity contracts remain authoritative and unchanged.
  const { bookArc, ...book } = plan;
  return { ...book, chapters, ...(sameStructure && bookArc ? { bookArc: { ...bookArc,
    chapters: bookArc.chapters.map(chapter => ({ ...chapter,
      pages: chapters.find(candidate => candidate.index === chapter.index)?.targetPages ?? chapter.pages
    }))
  } } : {}) };
}
