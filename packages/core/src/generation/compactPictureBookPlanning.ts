import { pictureBookRequirementContract, WRITER_REQUIREMENT_SCOPE_GUIDANCE } from "./pictureBookRequirementContract.js";
import { FINAL_PAGE_OBLIGATION_GUIDANCE } from "./finalPageObligations.js";
import { mediaSettingsMobileRecord } from "../schemas/jsonCoercion.js";
import { z } from "zod";
import type { BookPlan, ChapterBrief, ChapterPlan, CreateProjectInput } from "../schemas/book.js";
import type { TextModelAdapter } from "../adapters/types.js";
import { hasResearchIntent } from "./researchIntent.js";
import { modelTierForInput } from "../adapters/modelTiers.js";
import { generateJsonWithRetry } from "./generateJsonWithRetry.js";
import { firstPageBriefFieldsForRange } from "./pageBriefContract.js";
import { decodeGeneratedChapterBrief } from "./generatedChapterBriefAcceptance.js";
import { targetLanguageGenerationGuidance } from "../prompting/language.js";
import { kidsReadingGuidanceLines } from "../prompting/readingLevel.js";
import { planLibraryCharacterGuidance } from "./planLibraryCharacters.js";
import { libraryCharactersFromMediaSettings } from "./libraryCharacters.js";
import { REAL_PEOPLE_KEEP_THEIR_NAMES_RULE } from "./realPeople.js";
import { pageGetsInteriorIllustration } from "./illustrationSlots.js";
import { generationPageCountBounds, requestedGenerationPages } from "./pageCountAllowance.js";

export function usesCompactPictureBookPlanning(input: CreateProjectInput): boolean {
  // Page-count and prose requirements select the workflow; artwork is optional. Quick Draft plans
  // without the requirement contract's extra call. This read `mediaSettings.finalReview`, which only
  // the Quick Draft preset left off; that flag controls nothing since 2026-10-16, so the tier says it.
  return input.category === "KIDS" && requestedGenerationPages(input) >= 5 && requestedGenerationPages(input) <= 40 &&
    modelTierForInput(input) !== "fast" &&
    (!input.mediaSettings.generationStrategy || input.mediaSettings.generationStrategy === "auto") && !hasResearchIntent(input) &&
    !mediaSettingsMobileRecord(input.mediaSettings).import;
}

export const PICTURE_BOOK_STORY_OBLIGATIONS = [
  "Preserve every concrete requirement in the exact brief, especially deadlines (for example before moonrise), object counts, and each named protagonist's distinct growth.",
  "When the brief requests growth, give each specified protagonist an initial limitation that affects the action, a consequential choice that challenges it, and an observable changed action, including a wise mentor. Being helpful throughout is not a change. Keep saved character canon intact; a strength can be applied too rigidly without becoming a new personality.",
  "Make clues change what the characters know and do: observation -> inference -> consequential action. A requested pattern in where objects moved needs observed landing places of at least two of those objects, a concrete comparison, and a useful prediction; environmental signs alone do not replace it. Schedule the comparison after the observations. Anchor the predicted direction and destination to those observed places; do not send a search down a different route without a new clue or a stated reason. Keep an author's hidden prop inventory distinct from reader/character discoveries; do not reveal every search answer during setup. A known location can still lead to a difficult retrieval.",
  "Give each page a specific contribution: a discovery, consequential choice, obstacle, relationship change or distinctive reader experience, including earned humor, sensory exploration and quiet emotional release. Enact it through what characters do, notice, say or feel; 'trust grows' alone is not a scene. Vary repeated tasks by the cooperation or consequence required. After solving a problem, let requested escort/return scenes test changed behavior and close without replaying the solution. Use no fixed act percentages, forced danger or unrelated subplots to fill pages.",
  "Keep a stable prop inventory, recognizable prop names and each character/group’s entrance and exit locations. At a crossing, specify who crosses first, where the helper stands, who takes the object, and where they meet. Show transfers before ownership changes; never lift an already carried object from the ground or repeat its delivery without an intervening move. Carry the causal state across chapter boundaries.",
  "Track prop condition and unresolved setups as well as location: damage must be repaired, replaced or bypassed before reuse, and an agreed method must be established before characters rely on it. Remembering an object's old location does not put it back there. Give each complication a concrete payoff in this book. Correct known mistakes promptly unless a real constraint prevents it.",
  "Introduce a requested deadline before an extended search so it can shape decisions. Schedule the requested ending event before its deadline. A boast or mistaken belief can resolve through changed action."
];

function illustrationPageIndexes(input: CreateProjectInput): number[] {
  return Array.from({ length: input.targetPages }, (_, i) => i + 1).filter((index) => pageGetsInteriorIllustration(input, index));
}

function illustrationCadenceGuidance(input: CreateProjectInput): string {
  const pages = illustrationPageIndexes(input);
  const extra = Array.from({ length: generationPageCountBounds(input).maximumPages - input.targetPages }, (_, i) => input.targetPages + i + 1)
    .filter(index => pageGetsInteriorIllustration(input, index));
  return `Illustrate story pages ${pages.length ? pages.join(", ") : "none"}.${extra.length ? ` If extra pages are used, also illustrate only these extra indexes: ${extra.join(", ")}.` : ""} All other pages remain text-only; do not add illustration moments for them. Preserve the complete narrative progression regardless of illustration cadence.`;
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
      ? `This story will later occupy ${input.targetPages}–${generationPageCountBounds(input).maximumPages} pages; the requested ${input.targetPages} is the minimum. Extra pages are optional, only for meaningful developments. Develop enough material for that length without allocating it yet. Preserve requested title, characters, age band and tone.`
      : `Chapter targetPages must sum to exactly ${input.targetPages}; preserve requested title, characters, age band and tone.`,
    REAL_PEOPLE_KEEP_THEIR_NAMES_RULE,
    illustrationCadenceGuidance(input),
    "Set questions=[] for coherent requests; make ordinary creative choices yourself. Ask only if a missing subject or contradictory requirement prevents understanding. Keep researchQueries=[] for this fictional story.",
    "Seed promises with requested outcomes and distinct character changes. Page counts and media delivery are enforced by the application; do not restate them as prose promises. The configured story-page range overrides exact-count wording in the brief. Preserve narrative scope: do not append stricter deadlines or an immediate ending cutoff that the user did not request. Set openingHook to one concrete opening moment. Do not add extra named main characters unless requested.",
    "In continuityRules, record one compact arc contract per protagonist whose growth is requested: initial limitation -> difficult choice -> changed action, naming concrete story moments. Establish the limitation early enough to affect events; do not introduce and resolve it together near the ending. Show requested traits through choices and dialogue. Add compact prop-state and clue contracts when relevant: initial inventory -> transfers -> final state; observed comparison -> useful inference -> next action. Use these instead of generic reminders; stay within the existing plan budget.",
    FINAL_PAGE_OBLIGATION_GUIDANCE,
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
  const { minimumPages, maximumPages } = generationPageCountBounds(options.input);
  const schema = z.strictObject({
    pages: z.array(beatSchema).min(minimumPages).max(maximumPages),
    // Older complete maps remain usable without buying a regeneration for metadata.
    chapters: z.array(z.strictObject({
      title: z.string().trim().min(1), summary: z.string().trim().min(1), endPage: z.number().int().positive()
    })).min(1).max(Math.floor(options.input.targetPages / 2)).optional()
  }).superRefine((result, context) => {
    for (const [i, page] of result.pages.entries()) {
      if (page.pageIndex !== i + 1) context.addIssue({ code: "custom", message: `Page position ${i + 1} must use its exact ordered global index.` });
    }
    if (!result.chapters && result.pages.length !== options.input.targetPages)
      context.addIssue({ code: "custom", message: "Extra pages require chapter boundaries covering the chosen page count." });
    if (result.chapters && (result.chapters.at(-1)!.endPage !== result.pages.length ||
      result.chapters.some((chapter, i, chapters) => chapter.endPage <= (chapters[i - 1]?.endPage ?? 0)))) {
      context.addIssue({ code: "custom", message: "Chapter endPage values must increase strictly in chapter order and end at pages.length; every chapter contains at least one page." });
    }
  });
  const firstPage = firstPageBriefFieldsForRange(options, 1, maximumPages);
  const result = await generateJsonWithRetry(options.textModel, {
    // Retain the existing route and small-map budget. Longer maps keep the
    // measured headroom that avoided a Premium reasoning-only truncation.
    purpose: options.input.targetPages > 24 ? "generate-chapter-brief" : "generate-page-map",
    temperature: Math.min(options.input.targetPages > 24 ? 0.7 : 0.55, options.input.temperature),
    maxTokens: options.input.targetPages > 24 ? 24_000 : Math.min(12_000, Math.max(1800, maximumPages * 180)),
    schema, repairAttempts: 2,
    messages: [{ role: "system", content: [
      "Create the complete page map for this short children's story in one compact response. Allocate the complete sequence of scenes first, then place chapter boundaries at the resulting story turns. Return pages, then chapters: group the completed scenes into a few coherent story phases, each with a short title, one-sentence summary and inclusive global endPage. End pages must increase strictly and the last must equal the chosen pages.length. Choose the chapter count and lengths from the story; every chapter must contain at least one page. Omit per-page chapterIndex: the application assigns ownership from those boundaries.",
      `Choose ${minimumPages}–${maximumPages} story pages. The customer's requested ${minimumPages} is a hard minimum. Extra pages are optional: use them only for a meaningful discovery, consequence, relationship change or earned ending. Do not fill the allowance automatically, repeat growth demonstrations, or split routine preparation across extra pages. Number the chosen pages consecutively from 1; deliver the requested ending on the actual last page.`,
      "Keep purpose within 8 words, beat within 18 words, endingPressure within 10 words, and requiredContinuity to at most two short changed/essential facts per page. Do not repeat chapter summaries, cast descriptions or global rules on every page.",
      illustrationPageIndexes(options.input).length
        ? "imageMoment is optional when the beat already gives the visual scene."
        : "This story has no interior illustrations; omit imageMoment on every page.",
      "Use purpose for the specific change or reader experience, beat for the action and its immediate response/outcome, and requiredContinuity for essential entry/exit, possession or knowledge state. Prefer concrete interaction over labels such as 'learns teamwork'. Keep unchanged inventory in the background. Do not write reader-facing prose or explanations defending the allocation.",
      "Before returning, compare adjacent pages: what would the reader lose if their work shared one page? Deciding, preparing, attempting and confirming one simple action usually belong together. A new checker, prop inventory or repeated intention does not earn another page. Combine those beats, preserve necessary movement and both characters' contributions, then develop the freed slots within the chosen page count: a consequence that changes the next attempt, a clue that redirects action, conflicting approaches resolved through cooperation, or an earned playful/quiet interaction. Choose what this story supports; do not add every kind or a new problem to fill space. Preserve the minimum and required ending. Record each departure, arrival and solution once; begin the next page from its resulting state.",
      options.plan.storyTreatment
        ? "Distribute storyTreatment across the chosen page count within pageCountBounds. Preserve its causal sequence and ending; a scene may span pages when each develops it. Do not replace the plot, reveal a later discovery early or stretch a solved task to occupy slots. Honor explicit chapter/page constraints in the brief."
        : "Use storyOutline as the existing story's causal starting point, not as one chapter or equal page allotment per entry. Combine procedural steps and develop the consequences into complete scenes. Chapter-number references in preliminary continuity notes describe the intended event order, not the new chapter boundaries.",
      "Place the continuityRules arc, clue and prop-state contracts into concrete beats. Diagnose any earlier critic warning against the scenes and revise the affected assignments now; do not pass a warning to the writer beside the unchanged defective beat. Choose chapter boundaries and names only after assigning the scenes; the preliminary outline is not a quota of actions or chapters to fill. Do not pad a chapter to match its neighbors or reserve equal space for permission, preparation and execution. Follow any explicit chapter or page-allocation requirements in the exact user brief. Preserve saved canon.",
      "endingPressure describes the unresolved change that carries into the next scene, or the requested ending on the final page, in declarative author notes. It is not a question to print or a required closing sentence. Let scene action carry page turns.",
      illustrationCadenceGuidance(options.input),
      WRITER_REQUIREMENT_SCOPE_GUIDANCE,
      ...PICTURE_BOOK_STORY_OBLIGATIONS, ...firstPage.rules, ...targetLanguageGenerationGuidance(options.input.language)
    ].join(" ") }, { role: "user", content: JSON.stringify({
      ...pictureBookRequirementContract(options.input, options.plan),
      userPrompt: options.input.prompt, targetPages: options.input.targetPages, pageCountBounds: { minimumPages, maximumPages }, ...firstPage.payload,
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
  const owners = chapterOwnership(parsed.pages.length, ranges);
  // Only chapter labels are derived. Preserve the validated order and all narrative fields.
  const pages = parsed.pages.map(page => ({ ...page, chapterIndex: owners.get(page.pageIndex)! }));
  return ranges.map(({ chapter, startPage, endPage }) => decodeGeneratedChapterBrief({
    chapterIndex: chapter.index, title: chapter.title, summary: chapter.summary, continuityFocus: [],
    pages: pages.filter((page) => page.chapterIndex === chapter.index)
  }, { chapterIndex: chapter.index, pageRange: { start: startPage, end: endPage }, allowCompleteLocalPageNumbering: false }));
}

/** Adopt only a complete scene allocation; malformed maps still face mandatory integrity. */
export function compactPictureBookPlanForBriefs(input: CreateProjectInput, plan: BookPlan, briefs: readonly ChapterBrief[]): BookPlan {
  if (!usesCompactPictureBookPlanning(input) || briefs.length === 0 || briefs.length > Math.floor(input.targetPages / 2)) return plan;
  let nextPage = 1;
  for (const [i, brief] of briefs.entries()) {
    if (brief.chapterIndex !== i + 1 || brief.pages.length === 0) return plan;
    for (const page of brief.pages) {
      if (page.pageIndex !== nextPage || page.chapterIndex !== brief.chapterIndex) return plan;
      nextPage += 1;
    }
  }
  const { minimumPages, maximumPages } = generationPageCountBounds(input);
  if (nextPage - 1 < minimumPages || nextPage - 1 > maximumPages) return plan;
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
