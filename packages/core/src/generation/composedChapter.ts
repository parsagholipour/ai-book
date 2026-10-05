import { acceptsChapterEdit, type ChapterEditAcceptanceOptions } from "./chapterEditAcceptance.js";
import { chapterResearchNotesForPrompt, CHAPTER_RESEARCH_CONTEXT_RULE } from "./chapterResearchContext.js";
import { chapterDegeneracy } from "./chapterIntegrity.js";
import { generateChapterProse } from "./generateChapterProse.js";
import { chapterCutConstraints } from "./chapterCutContext.js";
import { deletionOnlyResult } from "./composedChapterCuts.js";
export { cutChapterTail, CUT_TAIL_WORDS, deletionOnlyResult } from "./composedChapterCuts.js";
import type { TextModelAdapter } from "../adapters/types.js";
import { isStopOrAbortError } from "../adapters/retry.js";
import { editShortensPastFloor, LENGTH_FLOOR_SHARE, printedWordCount } from "./printedLength.js";
import { CONTINUITY_NOTE_PROMPT_LIMITS, continuityNotesForPrompt } from "../context/contextPack.js";
import { targetLanguageGenerationGuidance, targetLanguagePayload } from "../prompting/language.js";
import { kidsReadingGuidanceForInput, kidsReadingGuidanceLines } from "../prompting/readingLevel.js";
import type { AuthorStance, BookPlan, ChapterPlan, CreateProjectInput } from "../schemas/book.js";
import { authorStancePromptLines, isNarrativeWritingMode } from "./authorStance.js";
import type { BookArc } from "./bookArc.js";
import { chapterDevelopmentLines } from "./bookDevelopment.js";
import {
  CREATIVE_CONTRACT_RULES,
  FOCUSED_RECONSTRUCTION_RULE,
  focusedProgressionLines,
  materialEditLines,
  materialLines,
  materialPayload,
  remainingBudget,
  type ChapterMaterial,
  type ComposeContract,
  type ComposedChapterText
} from "./composedChapterMaterial.js";
export { CREATIVE_CONTRACT_RULES, type ChapterMaterial, type ComposeContract, type ComposedChapterText } from "./composedChapterMaterial.js";
import { afterOpeningScene } from "./composedSceneTold.js";
import { HISTORY_QUESTION_RULE, HISTORY_RECONSTRUCTION_RULE, historyWriterPalette, withoutUnfetchedReadings, writesHistorySources } from "./historySources.js";
import { stanceLinesFor } from "./composedChapterStance.js";
import {  compositionWriterLines, formPaletteFor, type ChapterComposition } from "./chapterForms.js";
import { normalizeChapterMarkdown } from "./chapterPagination.js";
import { FIGURE_WORD_EQUIVALENT, proseWordCount } from "./figures/figureBlocks.js";
import { codeBlockRules } from "./codeBlockRules.js";
import { exampleCastLines, exampleCastLinesForChapter, type ExampleCastMember } from "./exampleCast.js";
import { TOOLKIT_FORMS } from "./chapterFormPalette.js";
import { EXAMPLE_PEOPLE_RULE, TOOLKIT_LAST_CHAPTER_LINE, TOOLKIT_LAYOUT_RULE, TOOLKIT_QUOTATION_RULE, TOOLKIT_SHAPE_RULES, activeToolkit, toolkitPayload, toolkitWriterLines, type InstructionalToolkit } from "./instructionalBook.js";
import { chapterFactLines, ESTABLISHED_FACTS_EDITOR_RULE, ESTABLISHED_FACTS_MAX_CHARACTERS, ESTABLISHED_FACTS_WRITER_RULE, type ChapterFact } from "./chapterFacts.js";
import { figureComposeRules, figureEditRules, plannedFigures } from "./figures/figurePrompt.js";
import { chapterStyleNotes } from "./planContract.js";
import { BYLINE_IS_TYPESET_RULE } from "./markdown.js";
import { GROUNDED_FACTUALITY_RULE, citationContractFields } from "./pagesShared.js";
import { countReadableWords } from "./proseShape.js";
import { inferWritingMode } from "./styleContract.js";
import type { WritingMode } from "../schemas/styleContract.js";
export {
  MANUSCRIPT_READ_MAX_WORDS,
  READ_MANUSCRIPT_PURPOSE,
  manuscriptReadEditCap,
  readManuscript,
  type ManuscriptChapterForRead,
  type ManuscriptReadResult
} from "./manuscriptRead.js";

/**
 * The four provider calls of the composed-chapters strategy: compose a whole
 * chapter as one piece of prose, edit it as a line editor would, describe the
 * pages the typesetter cut it into, and read the finished manuscript once.
 *
 * What is deliberately absent: the per-page rule list, the page brief with
 * its landing claim, the evidence ledger, the reviewer that rejects a page for
 * developing the next page's reserved beat. See `.scratch/composed-chapters/spec.md`.
 */

export const COMPOSE_CHAPTER_PURPOSE = "compose-chapter";
export const EDIT_CHAPTER_PURPOSE = "edit-chapter";
export { DESCRIBE_PAGES_PURPOSE, describeChapterPages, fallbackPageDescription, type ChapterPageForDescription, type DescribedPage } from "./composedChapterPages.js";

/** Beyond this the read is skipped rather than truncated: a read that saw half a book would flag the half it saw. */
/** 1,200 words was a third of the previous chapter, sent to both the compose and the edit call; 300 is its landing. */
export const PREVIOUS_CHAPTER_TAIL_WORDS = 300;
export const CHAPTER_DIGEST_MAX_CHARACTERS = 700;

export type ChapterWordBudget = { perPage: number; min: number; target: number; max: number };

/** Below this share of the target the editor develops the chapter rather than only cutting. */
export const EDITOR_EXTEND_BELOW_SHARE = 0.92;

/**
 * Words per model page, sized so the printed book is as long as the page
 * count the reader paid for. A printed page holds ~470 words of this prose,
 * and the composer delivers about 87% of the target it is asked for (the
 * first live book: 4.5k words against a 5.16k ask, 95 printed pages against
 * 120 paid for), so the ask sits above the printed density and the editor
 * extends anything that lands under `extendBelow`.
 */
export function chapterWordBudget(
  input: CreateProjectInput,
  pageCount: number,
  options: { /** Words of prose the chapter's figures displace on the page. */ figureWords?: number | undefined } = {}
): ChapterWordBudget {
  const pages = Math.max(1, pageCount);
  const kids = kidsReadingGuidanceForInput(input);
  const per = kids
    ? {
        min: kids.targetWordsPerPage.min,
        target: Math.round((kids.targetWordsPerPage.min + kids.targetWordsPerPage.max) / 2),
        max: kids.targetWordsPerPage.max
      }
    : // A printed page holds ~490 words of this prose: 480 a page printed 107–112 of 120
      // paid, 540 printed 124, 520 printed 120, and length made no difference to the blind
      // panel (480: 7.32, 520: 7.31, ×3 each). But at ~87% delivery 520 sat the book on its
      // floor and the read's cuts could not apply; 570 lands ~10% above it for them to spend.
      // The diagram-friendly categories (SCIENCE, EDUCATION, HEALTH) used to ask 300/380/480,
      // a discount nothing had measured: the same typesetter prints the same ~496 words on a
      // full sheet of a science book (the 2026-09-19 cryptography book, inline maths and all),
      // so 380 a page could print at most 88 of 100 paid even at full delivery, and printed
      // 77. A figure's room on the page is `figureWords` below, so the discount stood for
      // nothing else.
      { min: 430, target: 570, max: 640 };
  const displaced = Math.max(0, options.figureWords ?? 0);
  // Floor the no-figure chapter first (a one-page chapter still asks for a
  // full page of prose), then subtract figure words. Flooring at `per.target`
  // *after* the subtraction left a one-page figured chapter at 520 with no
  // deduction; flooring at `per.min` still ate 50 of the 140. A figure is
  // already on the page, so the prose ask may sit below `per.min`.
  const baseMin = Math.max(per.target, per.min * pages);
  const baseTarget = Math.max(per.target, per.target * pages);
  const baseMax = Math.max(per.target, per.max * pages);
  return {
    perPage: per.target,
    min: Math.max(0, baseMin - displaced),
    target: Math.max(0, baseTarget - displaced),
    max: Math.max(0, baseMax - displaced)
  };
}

/**
 * The most prose one compose call has returned. Across two live Balanced books
 * and their replays (2026-09-19, forty first drafts) no draft passed 4,700
 * words whatever it was asked for — 7,410 came back at 4,667, 6,224 at 4,508 —
 * while chapters asked for 2,000–3,500 came back at 60–105%. A chapter whose
 * target sits above this is short by construction, so the planner is told the
 * longest chapter the budget allows (`maxComposedChapterPages`).
 */
export const COMPOSE_CALL_WORDS = 4600;

/** The longest chapter, in pages, whose word target one compose call can reach: eight at 570 words a page, never under the planner's five-page floor. */
export function maxComposedChapterPages(input: CreateProjectInput): number {
  return Math.max(5, Math.min(14, Math.floor(COMPOSE_CALL_WORDS / chapterWordBudget(input, 1).perPage)));
}

export type EarlierChapterDigest = {
  index: number;
  title: string;
  digest: string;
  /** The cases, sources, scenes and people that chapter's sections owned: already told, named only. */
  told?: string[] | undefined;
};

export type ComposeChapterOptions = {
  signal?: AbortSignal | undefined;
  input: CreateProjectInput;
  plan: BookPlan;
  stance: AuthorStance;
  /** The book's arc: with it, a middle chapter writes from its job and never sees the thesis. */
  arc?: BookArc | undefined;
  chapter: ChapterPlan;
  composition: ChapterComposition;
  chapterPageStart: number;
  chapterPageEnd: number;
  /** The end of the previous chapter, verbatim. */
  previousChapterTail?: string | undefined;
  earlierChapters: EarlierChapterDigest[];
  /** The first sentence of every earlier chapter, verbatim: moves this chapter may not repeat. */
  earlierOpenings?: string[] | undefined;
  /** The last sentence of every earlier chapter, verbatim: shapes this chapter may not end on. */
  earlierClosings?: string[] | undefined;
  continuityNotes: string[];
  researchNotes: string[];
  storyStateLines?: string[] | undefined;
  /** The continuity ledger (`chapterFacts.ts`): what the chapters before this one fixed, and never a later one's. */
  establishedFacts?: readonly ChapterFact[] | undefined;
  textModel: TextModelAdapter;
  /** A second candidate samples hotter than the book's own temperature; the judge decides. */
  temperature?: number | undefined;
  /** The second of two drafts takes a different way in; the OpenAI adapter drops temperature under any reasoning effort, so the variation has to be in the prompt. */
  variant?: "second" | undefined;
  /**
   * What the writer may draw on. `grounded` (the default) holds named evidence
   * to researchNotes; `creative` lets the author write from their own
   * knowledge of the subject, with quotation marks kept as a promise. Parsa's
   * decision, 2026-09-03: the grounded contract starved every page of
   * particulars and the panel's engagement sevens went to the writers that
   * supplied their own.
   */
  contract?: ComposeContract | undefined;
  /** Material-first: the chapter's episodes, its dossier of verbatim primary text, and a scene already written for its opening. */
  material?: ChapterMaterial | undefined;
  /** `sourceResearchFits`: false for a book no source was gathered for on purpose, which is not a book whose passages are missing. */
  sourced?: boolean | undefined;
  /** The book's recurring example people (`exampleCast.ts`), each in the one role they keep. */
  exampleCast?: readonly ExampleCastMember[] | undefined;
  /**
   * A practical guide's or a workbook's whole-book decisions
   * (`instructionalBook.ts`); only a book on that path acts on it
   * (`activeToolkit`), and a book planned before it existed has none.
   */
  toolkit?: InstructionalToolkit | undefined;
  /**
   * Words the book's earlier chapters are over their minimums. The length
   * floor that blocks is the book's (the worker's `composedChapterLengthIssues`),
   * so a shortfall the book already covers is not worth a second compose call —
   * 20–30 s on the critical path, once to three times a Quick Draft book — down
   * to three quarters of this chapter's minimum, where a chapter is a stub.
   */
  lengthSlack?: number | undefined;
};

/** Below this share of its minimum a chapter is retried whatever the book's slack. */
const RETRY_STUB_SHARE = 0.75;

/**
 * Repetition was padding against the word minimum (2026-10-01): told "never
 * repeat" outright the chapters came back shorter and duller and lost 4 of 12
 * blind pairs, while this line, replacing "Keep a caveat when it limits an
 * inference; cut it only when the same limitation is already stated with the
 * same scope and context", won 12 of 12 — 8 non-fiction, 4 fiction, where it
 * follows the pacing sentence. The acceptance reviewer is told the same.
 */
export const CAVEAT_ONCE_EDITOR_RULE = "State a caveat or limitation once, where it first matters in the chapter; cut each later restatement of it, however it is worded, unless it adds a new condition.";
export const CAVEAT_ONCE_ACCEPTANCE_RULE = "The editor was told to state each caveat or limitation once, where it first matters in the chapter: removing a later restatement of a caveat or limitation the candidate still states earlier in the chapter preserves meaning and is the intended edit, however differently the removed one was worded. A removed qualification that added a condition the retained one lacks is still a regression.";

/** The pivots the blind readers quoted from the first composed book. */
const STOCK_PIVOT_BAN =
  'Do not write "a rival interpretation", "a rival explanation", "the strongest objection", "the claim fails", "on this view", "not a transparent", "the distinction matters", "taken together", "in other words", "put differently", "the point is", "what matters is", "this is not to say", "it is worth noting" or "the lesson is"; say the thing the pivot announces, and answer a rival view without announcing it. "Therefore" and "consequently" appear at most three times in the chapter.';

export const DETEMPLATE_CHAPTER_PURPOSE = "detemplate-chapter";



function reconstructionRule(narrative: boolean): string[] {
  if (narrative) return [];
  return [
    "A scene in this book is a documented episode from a named source, site or record. When the source records little, say what it records in a paragraph and move on; do not narrate around a gap. Never present an unnamed or composite person as a witnessed fact."
  ];
}


const PROMPT_LEAK_BAN =
  "Do not mention AI, prompts, plans, JSON, schemas, generation, sections, forms, or production instructions in the prose.";


/**
 * How a chapter's final paragraph lands, rotated by chapter so no two
 * consecutive chapters close the same way. The first composed book ended
 * six chapters on a one-sentence "less X than Y" thesis stamp — the landing
 * rule read as a landing *shape* — and both blind reviewers named it first.
 */
export const LANDING_FORMS = [
  "an event: the last thing that happened, told plainly, with no sentence after it explaining what it meant",
  "a verdict: one plain declarative sentence the chapter has earned, without a balancing clause",
  "an image: a particular thing seen, left to carry the meaning",
  "a question the chapter has made sharp, left open, with what would settle it",
  "a consequence traced forward: what the chapter's events cost a named person or place afterwards",
  "a document or quotation: a source's own words, then silence"
] as const;

export function landingFormFor(chapterIndex: number): string {
  return LANDING_FORMS[(Math.max(1, chapterIndex) - 1) % LANDING_FORMS.length]!;
}

/**
 * How the chapter may be set on the page. A how-to reader acts on steps,
 * checklists and worksheets, so those three sections may be set as a list or
 * a table there; everywhere else, and in every other kind of book, the ladder's
 * paragraphs-only rule stands. Under it a workbook's worksheets came out as
 * run-on sentences ("months reviewed: ____; income received: ____; …") and a
 * one-on-one guide's promised checklist as prose (Quick Draft, 2026-09-30).
 */
function layoutRule(mode: WritingMode, toolkit?: InstructionalToolkit | undefined): string {
  if (toolkit) return TOOLKIT_LAYOUT_RULE;
  const bans = "no headings, no title line, no section labels, no page numbers or page breaks, no summary, no epigraph, no notes. Move between sections with a paragraph break and a change of register.";
  return mode === "instructional"
    ? `Write in paragraphs, with ${bans} The one exception is what the reader will act on: a procedure section may set its steps as a numbered list, an exercise may set its worksheet as a short Markdown table with blank cells or as fill-in lines, and a checklist may be a bulleted list. Introduce each list or table in a sentence, keep it under a dozen lines, and never use one for explanation or argument.`
    : `Paragraphs only: ${bans}`;
}

function shapeRules(narrative: boolean, mode?: WritingMode, toolkit?: InstructionalToolkit | undefined): string[] {
  if (toolkit) return [...TOOLKIT_SHAPE_RULES, STOCK_PIVOT_BAN];
  return [
    narrative
      ? "Every scene and every paragraph inside it ends on action, speech, or an image, never on a sentence that explains what the scene meant or what a character has learned."
      : "The sections are movements of one argument, not separate essays: let each grow out of the one before, point back to an earlier case in a clause when it bears on the current one, and let the chapter's claim accumulate. Do not open every section on a place-and-date stamp, and do not close sections on a placed object for effect: a reed marker, a file on a table, dust on a path. Once a chapter is a texture; every section is a tic.",
    "The book's plan is not visible to the reader: never refer to a chapter by number, never say what another chapter showed or will show, and never mention the sections, forms, handoffs or notes you were given. A case the book treated earlier is pointed to in half a sentence, never re-narrated.",
    mode === "instructional"
      ? "The chapter ends where its last section ends. A catalogue is written in sentences unless it is a checklist the reader will use."
      : "The chapter ends where its last section ends. A catalogue is written in sentences, never as labelled entries.",
    mode && writesHistorySources(mode)
      ? HISTORY_QUESTION_RULE
      : "State what a source shows and use it. Do not follow each affirmation with what the source cannot show: the sentence pair that asserts and then withdraws — \"It can show X. It cannot show Y.\", \"The record shows X. It does not show Y.\" — may appear at most three times in the chapter. Rhetorical questions: at most one per section, never a run of them.",
    "Every section names at least three particulars — a person, a place, a date, a document, an object, a number — and where researchNotes holds a source for the matter, paraphrases or quotes it.",
    "Paragraphs are shaped by what they carry, not cut to a size: a scene or a sustained explanation runs on for two hundred words or more, a turn stands alone as one or two sentences, and most sections hold at least one of each. Never a run of paragraphs of the same length. Let some sentences run past forty words with a subordinate clause before the main clause, and let some be four words. Do not open consecutive sentences or consecutive paragraphs with the same word or the same construction, and do not write three sentences in a row on the same frame.",
    "Prefer one example developed at length to several named in passing. A sentence lists at most three items unless the section's form is a catalogue or a procedure.",
    STOCK_PIVOT_BAN,
    "Name the particular thing — the person, the document, the place, the object — instead of \"institutions\", \"mechanisms\", \"arrangements\", \"capacity\", \"authority\" or \"dynamics\" wherever a particular can be named.",
    "Do not restate what earlier chapters established; refer to it in a clause if you must. Do not recap this chapter anywhere inside it, and do not announce what comes next."
  ];
}

function positionLines(options: {
  plan: BookPlan;
  chapter: ChapterPlan;
  input: CreateProjectInput;
  narrative: boolean;
  toolkit?: InstructionalToolkit | undefined;
}): string[] {
  const chapters = options.plan.chapters;
  const isFirst = options.chapter.index === chapters[0]?.index;
  const isLast = options.chapter.index === chapters.at(-1)?.index;
  const lines: string[] = [];
  if (isFirst) {
    lines.push(
      options.plan.openingHook
        ? `This is the book's opening chapter. The plan suggested an opening; take it or find a better one: ${options.plan.openingHook}`
        : options.narrative
          ? "This is the book's opening chapter. Open inside a concrete scene already in motion: a specific person, place and pressure in the first lines, not backstory or panoramic scene-setting."
          : "This is the book's opening chapter. Open with a striking specific: a scene, a fact, a grounded question. Never a generalisation such as \"Throughout history\" or \"Since the dawn of time\", and never a description of what the book will do."
    );
  }
  if (isLast && options.toolkit) {
    lines.push(`${TOOLKIT_LAST_CHAPTER_LINE}${options.plan.promises.length > 0 ? ` The promises still owed to the reader: ${options.plan.promises.join("; ")}` : ""}`);
  } else if (isLast) {
    lines.push(
      `This is the final chapter. Its last section carries the book's resolution through one new case, and the chapter ends where that section ends; do not re-list the earlier chapters.${
        options.plan.promises.length > 0 ? ` The promises still owed to the reader: ${options.plan.promises.join("; ")}` : ""
      }`
    );
  }
  return lines;
}

/**
 * The book as the writer sees it. Under an arc, a middle chapter gets the
 * book's question for its premise and no promises: composed-7's premise *is*
 * the thesis, and the promises say where the book lands, so the stance lines
 * withholding the answer were being handed it back one key over.
 */
function bookPayload(plan: BookPlan, input: CreateProjectInput, withheld: BookArc | undefined, toolkit?: InstructionalToolkit | undefined) {
  return {
    title: plan.title,
    premise: withheld ? withheld.question : plan.premise,
    audience: plan.audience,
    category: input.category,
    subcategory: input.subcategory,
    writingComplexity: plan.writingComplexity,
    // Taking these out of the writer's payload was measured (composed-20, ×3):
    // 7.08 against 7.32 with them in, and the same five reader complaints
    // either way. They stay. Only the method rules are withheld, because a rule
    // about handling evidence shown in every call is performed in every paragraph.
    styleNotes: chapterStyleNotes(plan.voiceGuide),
    // A how-to's continuityRules were its caveats in every chapter ("keep tax guidance
    // general", "label sample figures as illustrative"); its toolkit keeps the facts here
    // and gives each caveat one chapter (`instructionalBook.ts`).
    ...(toolkit ? (toolkit.rules.length > 0 ? { bookRules: toolkit.rules } : {}) : { continuityRules: plan.continuityRules }),
    ...(withheld ? {} : { promises: plan.promises })
  };
}

/** The arc, when this chapter is one the answer is withheld from. */
function withheldArc(options: ComposeChapterOptions): BookArc | undefined {
  return options.arc && !isFirstOrLastChapter(options) ? options.arc : undefined;
}

/** The chapter's summary as the writer sees it: its focus, else the arc's job where the plan's summary would say what the chapter proves. */
function chapterSummaryFor(options: ComposeChapterOptions): string {
  const focus = options.material?.focus;
  if (focus) return `${focus.question} ${focus.investigation.join(" ")}`;
  const arc = withheldArc(options);
  const job = arc?.chapters.find((entry) => entry.index === options.chapter.index)?.job.does;
  return job || options.chapter.summary;
}

/**
 * The ledger as this chapter's prompt shows it: over the budget, the subjects
 * its plan, the previous chapter's tail and (for an edit) its own text name
 * go first. Empty for the first chapter, so its prompt is the one it always was.
 */
export function establishedFactLinesFor(options: ComposeChapterOptions, text?: string): string[] {
  if (!options.establishedFacts?.length) return [];
  const mentionText = [
    options.chapter.title,
    options.chapter.summary,
    ...options.composition.sections.flatMap((section) => [section.subject, ...(section.owns ?? []), section.note ?? ""]),
    options.previousChapterTail ?? "",
    text ?? ""
  ].join("\n");
  return chapterFactLines(options.establishedFacts, { mentionText, maxCharacters: ESTABLISHED_FACTS_MAX_CHARACTERS });
}

function characterPayload(plan: BookPlan) {
  return plan.characters.map((character) => ({
    name: character.name,
    role: character.role,
    description: character.description
  }));
}

/**
 * A reply wrapped whole in one fence is unwrapped; a chapter that merely
 * starts with a figure block and ends with another is not, so only the
 * info strings a wrapper carries are accepted, as `unwrapWholePageMarkdownFence` does.
 */
function unfence(text: string): string {
  const trimmed = text.trim();
  const fenced = trimmed.match(/^```(?:markdown|md|text|plain(?:text)?|prose)?[ \t]*\r?\n([\s\S]*?)\n```\s*$/i);
  return fenced ? fenced[1]! : trimmed;
}

function chapterPosition(plan: BookPlan, chapter: ChapterPlan, pageStart: number, pageEnd: number) {
  return {
    index: chapter.index,
    ofChapters: plan.chapters.length,
    pages: pageEnd - pageStart + 1,
    isFirst: chapter.index === plan.chapters[0]?.index,
    isLast: chapter.index === plan.chapters.at(-1)?.index
  };
}

/** Output fuse: prose plus, on reasoning models, the reasoning OpenAI counts toward it. */
function composeMaxTokens(budget: ChapterWordBudget): number {
  return Math.min(48_000, Math.max(6000, Math.round(budget.max * 1.8) + 6000));
}

export async function composeChapter(options: ComposeChapterOptions): Promise<ComposedChapterText> {
  const mode = inferWritingMode(options.input, options.plan);
  const narrative = isNarrativeWritingMode(mode);
  const history = writesHistorySources(mode);
  const toolkit = activeToolkit(options.input, options.plan, options.toolkit);
  const noSourcePassages = !toolkit && !narrative && options.sourced !== false &&
    !options.material?.excerpts.length && !options.material?.evidencePackets?.length;
  if (noSourcePassages) {
    // Episode plans are research proposals. Without passages, assigning a
    // portrait made the writer invent an RSA discovery scene in the tier audit.
    options = {
      ...options,
      composition: { ...options.composition, sections: options.composition.sections.map((section) =>
        ["scene", "portrait", "close-reading", "document-reading"].includes(section.form)
          ? { ...section, form: "argument", note: "Explain the subject from supported facts and worked examples." }
          : section) },
      ...(options.material ? { material: { ...options.material, episodes: [], scene: undefined } } : {})
    };
  }
  const focused = !narrative && Boolean(options.material?.focus);
  const palette = toolkit ? TOOLKIT_FORMS : formPaletteFor(mode);
  if (history && options.material) options = { ...options, composition: withoutUnfetchedReadings(options.composition, options.material.episodes, options.material.excerpts) };
  options = { ...options, ...afterOpeningScene(options, palette) };
  const pages = options.chapterPageEnd - options.chapterPageStart + 1;
  const budget = chapterWordBudget(options.input, pages, { figureWords: plannedFigures(options.composition).length * FIGURE_WORD_EQUIVALENT });
  const citation = citationContractFields(chapterResearchNotesForPrompt(options.researchNotes));
  const establishedFacts = establishedFactLinesFor(options);
  // The opening scene, when one was composed first, is printed ahead of what
  // this call writes, so the ask shrinks by its length.
  const remaining = remainingBudget(budget, options.material?.scene?.words ?? 0);
  // The subtraction ablation (spec.md, "Fable opinion"): stance, forms,
  // material, budget and a handful of positive rules, none of the bans or
  // shape rules. Measured against the full prompt on one plan.
  const minimal = COMPOSE_PROMPT_MODE === "minimal";
  // Stable lines first (the same for every chapter of a book), chapter lines
  // last: OpenAI caches an identical prompt prefix past ~1k tokens, and with
  // the chapter line first none of a book's 30 prose calls ever hit it.
  const systemLines = [
    `You are writing the book "${options.plan.title}" as its author, one chapter at a time, each as one continuous piece of finished Markdown prose.`,
    ...stanceLinesFor(options),
    layoutRule(mode, toolkit),
    ...(minimal
      ? []
      : focused
        ? focusedProgressionLines()
        : shapeRules(narrative, mode, toolkit).filter(
            // Under an arc only a method chapter keeps the evidence-limit rule; the others' job is not to bound sources.
            (rule) => !(options.arc && arcKindFor(options) !== "method" && rule.startsWith("State what a source shows"))
          )),
    ...(minimal ? [] : ["Do not open the chapter with a general claim about a common noun (\"A cannon was never only a cannon\")."]),
    ...(minimal || options.material?.evidencePackets?.length ? [] : toolkit ? [EXAMPLE_PEOPLE_RULE] : options.contract === "creative" ? (narrative ? [] : [history ? HISTORY_RECONSTRUCTION_RULE : FOCUSED_RECONSTRUCTION_RULE]) : reconstructionRule(narrative)),
    `Now chapter ${options.chapter.index}, "${options.chapter.title}".`,
    ...materialLines({ ...options, nonfiction: !narrative, history, practical: Boolean(toolkit) }),
    ...(toolkit ? exampleCastLinesForChapter(options.exampleCast, options.chapter.index) : exampleCastLines(options.exampleCast)),
    ...toolkitWriterLines(toolkit, options.chapter.index),
    ...chapterDevelopmentLines(options.plan, options.chapter.index),
    ...(focused ? [] : compositionWriterLines(options.composition, history ? historyWriterPalette(palette) : palette, budget.target)),
    ...figureComposeRules(options.composition),
    ...codeBlockRules(options.input, options.plan),
    ...(options.variant === "second"
      ? [
          "This is the second of two drafts of this chapter, to be judged against the first. Enter the first section by a different door than the obvious one, put the chapter's one sustained stretch in a different section than a first draft would, and let a different section carry the short paragraphs."
        ]
      : []),
    ...positionLines({ plan: options.plan, chapter: options.chapter, input: options.input, narrative, toolkit }),
    // Composed-8's chapter 8 opened by paraphrasing chapter 7's tail as a coda,
    // and the cut then removed chapter 7's own closing, so three blind readers
    // found the previous chapter's conclusion stranded under the next heading.
    "previousChapterTail is where the previous chapter stopped, already printed: this chapter opens on its own first section's material and neither resumes, summarises nor answers that paragraph. earlierChapters are digests of what the reader already knows, each with told: the cases, sources, scenes and people that chapter carried; anything in told may be named in passing and is never re-told, and its dates and figures are not repeated.",
    ...(establishedFacts.length > 0 ? [ESTABLISHED_FACTS_WRITER_RULE] : []),
    ...(options.contract === "creative" ? (toolkit ? [CREATIVE_CONTRACT_RULES[0]!, TOOLKIT_QUOTATION_RULE] : CREATIVE_CONTRACT_RULES) : [GROUNDED_FACTUALITY_RULE, ...citation.rules, CHAPTER_RESEARCH_CONTEXT_RULE]),
    // Research notes arrive as "title: summary" and a search hit's title is
    // often its bare domain, so a writer told to name only sources in the
    // notes wrote "the explanatory pages at psychstory.co.uk" (composed-17).
    "Never name a website, domain or URL in the prose, and never refer to your notes: no \"research brief\", \"research record\", \"supplied evidence\", \"the figures supplied\", \"the material for this discussion\" or any phrase that says where a fact came from. State the fact as the author who knows it; the Sources list is typeset from the notes.",
    BYLINE_IS_TYPESET_RULE,
    PROMPT_LEAK_BAN,
    ...targetLanguageGenerationGuidance(options.input.language),
    ...kidsReadingGuidanceLines(options.input),
    `Write between ${remaining.min} and ${remaining.max} words and aim for ${options.plan.bookDevelopment ? Math.min(remaining.max, Math.ceil(remaining.target / 0.87)) : remaining.target}. The typesetter will divide the chapter into ${pages} pages of about ${budget.perPage} words; pages are not units of argument, so do not shape the prose around them.`,
    ...(noSourcePassages ? ["No actual source passages have been supplied for this chapter. Historical scene, portrait and close-reading assignments are replaced by explanation of the subject. Open directly with that explanation; develop supported facts, worked examples and comparisons, without a discovery anecdote. Source fidelity takes precedence over form assignments, rhythm exemplars and length targets."] : []),
    "Return only the chapter's prose."
  ];
  const userPayload = {
    language: targetLanguagePayload(options.input.language),
    userPrompt: options.input.prompt,
    // A focused middle chapter is not handed the thesis back as the premise, nor where the book lands as promises.
    book: {
      ...bookPayload(options.plan, options.input, withheldArc(options), toolkit),
      ...(options.material?.focus && !isFirstOrLastChapter(options) ? { premise: options.material.focus.question, promises: [] } : {})
    },
    chapter: {
      index: options.chapter.index,
      title: options.chapter.title,
      summary: chapterSummaryFor(options)
    },
    chapterPosition: chapterPosition(options.plan, options.chapter, options.chapterPageStart, options.chapterPageEnd),
    ...(focused ? {} : {
      composition: {
        sections: options.composition.sections.map((section) => ({
          ...(toolkit && section.heading ? { heading: section.heading } : {}),
          form: section.form,
          subject: section.subject,
          owns: section.owns,
          ...(section.note ? { note: section.note } : {}),
          ...(section.figure ? { figure: section.figure } : {})
        }))
      }
    }),
    ...(options.previousChapterTail ? { previousChapterTail: options.previousChapterTail } : {}),
    earlierChapters: options.earlierChapters,
    continuityNotes: continuityNotesForPrompt(options.continuityNotes, CONTINUITY_NOTE_PROMPT_LIMITS.bulkDraft),
    ...(options.storyStateLines && options.storyStateLines.length > 0 ? { storyState: options.storyStateLines } : {}),
    ...(establishedFacts.length > 0 ? { establishedFacts } : {}),
    characters: characterPayload(options.plan),
    ...citation.payload,
    ...materialPayload({ ...options, history, practical: Boolean(toolkit) }),
    ...toolkitPayload(toolkit, options.chapter.index),
    wordBudget: budget
  };

  let attempts = 0;
  let best: ComposedChapterText | undefined;
  let shortfall: string | undefined;
  while (attempts < 2) {
    attempts += 1;
    const request = {
      purpose: COMPOSE_CHAPTER_PURPOSE,
      ...(options.signal ? { signal: options.signal } : {}),
      temperature: options.temperature ?? options.input.temperature,
      maxTokens: composeMaxTokens(budget),
      messages: [
        { role: "system" as const, content: [...systemLines, ...(shortfall ? [shortfall] : [])].join(" ") },
        { role: "user" as const, content: JSON.stringify(userPayload, null, 2) }
      ]
    };
    let result;
    try {
      result = await generateChapterProse(options.textModel, request, !best?.markdown);
    } catch (error) {
      // The length retry is a second try at a chapter that already exists: a truncated,
      // refused or unreachable reply keeps the longer earlier draft rather than failing
      // the book (a Quick Draft guide failed whole on a retry's runaway, 2026-09-30).
      if (!best?.markdown || isStopOrAbortError(error)) throw error;
      return { ...best, attempts, lengthRetryError: error instanceof Error ? error.message : String(error) };
    }
    const markdown = normalizeChapterMarkdown(unfence(result.text), { chapterTitle: options.chapter.title, ...(toolkit ? { keepSubheadings: true } : {}) });
    // As it prints: a worksheet row fills a printed row whatever its cells hold.
    const words = printedWordCount(markdown);
    const candidate = { markdown, words, attempts };
    if (!best || words > best.words) {
      best = candidate;
    }
    if (words >= remaining.min * LENGTH_FLOOR_SHARE || (remaining.min - words <= (options.lengthSlack ?? 0) && words >= remaining.min * RETRY_STUB_SHARE)) {
      break;
    }
    shortfall = `Your previous answer was ${words} words; the chapter needs at least ${remaining.min}. Write the complete chapter. Develop the assigned sections that were only sketched: carry through a worked example, explain its intermediate steps and consequences, or examine the supplied source passage more closely. Preserve the chapter's scope and source constraints. Do not add recap, repeated caveats, invented evidence or filler to reach the budget. If the available material cannot support the minimum, return the strongest supported chapter.`;
  }
  if (!best || !best.markdown) {
    throw new Error(`Chapter ${options.chapter.index} came back empty.`);
  }
  return { ...best, attempts };
}

export type EditChapterOptions = ComposeChapterOptions & ChapterEditAcceptanceOptions & {
  /** Structural editing allocates length across the book; a line edit cannot pad a chapter. */
  allowExtension?: boolean | undefined;
  /** Evidence repairs may have a tighter existing corruption ceiling than the chapter budget. */
  degeneracyMaxWords?: number | undefined;
  markdown: string;
  /** Notes from the whole-manuscript read, when this is the second pass. */
  readerNotes?: string[] | undefined;
  /** Deterministic measurements of the draft with the sentences behind them (`measurementNotes`). */
  measurementNotes?: string[] | undefined;
};

export type EditedChapterText = ComposedChapterText & { changed: boolean };

/** "full" is the prompt every composed run to composed-18 wrote with; "minimal" is the subtraction ablation. */
export const COMPOSE_PROMPT_MODE: "full" | "minimal" = "full";

function isFirstOrLastChapter(options: ComposeChapterOptions): boolean {
  const chapters = options.plan.chapters;
  return options.chapter.index === chapters[0]?.index || options.chapter.index === chapters.at(-1)?.index;
}

function arcKindFor(options: ComposeChapterOptions): string | undefined {
  return options.arc?.chapters.find((chapter) => chapter.index === options.chapter.index)?.kind;
}

export const CUT_CHAPTER_PURPOSE = "cut-chapter";

/**
 * The manuscript read's second pass, as deletion. The line edit is a
 * paraphrase — it changed the negation rate of composed-7's drafts from 45 to
 * 43 per thousand sentences — and every reader's remedy was a cut: the recap
 * tails, the repeated caveats, the thesis restated in eight chapters. A pass
 * that can only delete cannot add a tic, and `deletionOnlyResult` is what
 * makes "can only delete" a property of the code rather than of the prompt.
 */
export async function cutChapter(
  // `maxRemovableWords` is the room this chapter has over its page floor; the cut may spend no more.
  options: EditChapterOptions & { notes: string[]; bookNotes?: string[] | undefined; maxRemovableWords?: number | undefined }
): Promise<EditedChapterText> {
  options.signal?.throwIfAborted();
  const draftWords = countReadableWords(options.markdown);
  const pages = options.chapterPageEnd - options.chapterPageStart + 1;
  const budget = chapterWordBudget(options.input, pages);
  const cutConstraints = chapterCutConstraints(options.markdown, budget.min, options.maxRemovableWords);
  const removableWords = cutConstraints.maxRemovableWords;
  if (removableWords === 0) {
    return { markdown: options.markdown, words: draftWords, attempts: 0, changed: false };
  }
  const result = await options.textModel.generateText({
    purpose: CUT_CHAPTER_PURPOSE,
    ...(options.signal ? { signal: options.signal } : {}),
    temperature: Math.min(0.3, options.input.temperature),
    maxTokens: composeMaxTokens(budget),
    messages: [
      {
        role: "system",
        content: [
          `You are cutting chapter ${options.chapter.index}, "${options.chapter.title}", of "${options.plan.title}" after a reader's notes on the whole manuscript.`,
          "The only operation is deletion of whole sentences or whole paragraphs. Do not rewrite, reorder, merge or add a word; every sentence you keep stays exactly as written, in its paragraph. Delete what the notes name, and anything else that restates what this chapter or an earlier chapter already established, repeats a caveat the chapter already made, re-lists the chapter's cases at its end, or restates the book's argument in a sentence of its own.",
          "Preserve all claims, negations, causal relationships, scope, uncertainty and quotations. A repeated name is not a repeated fact, and a disclaimer may be essential. Delete only when you can identify the retained passage that already conveys the same information with the same scope and context. Preserve intentional repetition and the first paragraph. Return the draft unchanged if no such cut is justified.",
          `Remove only demonstrably redundant material, at most a quarter of the chapter${options.maxRemovableWords === undefined ? "" : ` and never more than ${options.maxRemovableWords} words`}.`,
          "Return only the cut chapter as Markdown paragraphs, nothing else."
        ].join(" ")
      },
      {
        role: "user",
        content: JSON.stringify(
          {
            draft: options.markdown,
            notes: options.notes,
            cutConstraints,
            ...(options.bookNotes && options.bookNotes.length > 0 ? { bookNotes: options.bookNotes } : {})
          },
          null,
          2
        )
      }
    ]
  });
  options.signal?.throwIfAborted();
  const cut = deletionOnlyResult(options.markdown, normalizeChapterMarkdown(unfence(result.text), { chapterTitle: options.chapter.title }));
  // A cut that takes the chapter under the pages it was paid for is refused, deletion-only or not.
  if (!cut || countReadableWords(cut) < budget.min || draftWords - countReadableWords(cut) > removableWords) {
    return { markdown: options.markdown, words: draftWords, attempts: 1, changed: false };
  }
  if (!await acceptsChapterEdit(options, cut, options)) {
    return { markdown: options.markdown, words: draftWords, attempts: 1, changed: false };
  }
  return { markdown: cut, words: countReadableWords(cut), attempts: 1, changed: true };
}

export async function editChapter(options: EditChapterOptions): Promise<EditedChapterText> {
  options.signal?.throwIfAborted();
  const mode = inferWritingMode(options.input, options.plan);
  const narrative = isNarrativeWritingMode(mode);
  const history = writesHistorySources(mode);
  const toolkit = activeToolkit(options.input, options.plan, options.toolkit);
  const focused = !narrative && Boolean(options.material?.focus);
  const palette = toolkit ? TOOLKIT_FORMS : formPaletteFor(mode);
  if (history && options.material) options = { ...options, composition: withoutUnfetchedReadings(options.composition, options.material.episodes, options.material.excerpts) };
  options = { ...options, ...afterOpeningScene(options, palette) };
  const pages = options.chapterPageEnd - options.chapterPageStart + 1;
  const budget = chapterWordBudget(options.input, pages, { figureWords: plannedFigures(options.composition).length * FIGURE_WORD_EQUIVALENT });
  const draftWords = proseWordCount(options.markdown);
  // A targeted correction edits the current text. The old composition budget
  // made a 200-word source repair regenerate a 2,000-word discovery narrative.
  const editBudget = options.factualCorrection ? { ...budget, min: Math.floor(draftWords * 0.62), target: draftWords, max: Math.ceil(draftWords * 1.1) } : budget;
  const citation = citationContractFields(chapterResearchNotesForPrompt(options.researchNotes));
  const establishedFacts = establishedFactLinesFor(options, options.markdown);
  const systemLines = [
    `You are the line editor for "${options.plan.title}", revising each chapter into its finished form in the author's own voice.`,
    ...stanceLinesFor(options),
    "Preserve the chapter's claims, causal relationships, negation, scope, uncertainty, names, dates, quantities and exact quotations. Keep the section order and the material of the opening. A qualification may be essential even when its names and numbers occur elsewhere.",
    "Edit where the surrounding passage gives a concrete reason: clarify a confusing sentence or remove a repetition that adds no fact, distinction, context or narrative purpose. Sentence shape alone is not a defect. Intentional repetition, dialogue and quotations may recur. Make the smallest change that resolves the issue. Preserve unaffected paragraphs verbatim, and keep a passage unchanged when an improvement would lose meaning or require guessing.",
    narrative
      ? `Judge pacing through the scene's actions and consequences; keep reflection when it changes what the reader understands. ${CAVEAT_ONCE_EDITOR_RULE}`
      : `Judge pacing through the chapter's evidence and explanation. ${CAVEAT_ONCE_EDITOR_RULE}`,
    "Use the book's spelling convention. Add no new claim, episode or source during this edit.",
    ...(establishedFacts.length > 0 ? [ESTABLISHED_FACTS_EDITOR_RULE] : []),
    ...(focused ? focusedProgressionLines() : []),
    `Now chapter ${options.chapter.index}, "${options.chapter.title}".`,
    ...(focused || options.factualCorrection ? [] : compositionWriterLines(options.composition, history ? historyWriterPalette(palette) : palette, budget.target)),
    ...figureEditRules(options.composition),
    ...(/```/.test(options.markdown) ? ["Every fenced code block in the draft is returned byte for byte, its language tag included."] : []),
    ...(!focused && options.measurementNotes && options.measurementNotes.length > 0
      ? [`Optional measurements for orientation only; they are not editing targets and a match does not establish a defect: ${options.measurementNotes.join(" || ")}`]
      : []),
    ...(options.readerNotes && options.readerNotes.length > 0
      ? [`A reader of the whole manuscript left these notes. Assess them against the passage and preserve its facts and qualifications; leave the passage unchanged if a note is unsupported: ${options.readerNotes.join(" | ")}`]
      : []),
    options.allowExtension === false
      ? "This is a final line edit. Improve clarity and sentence craft while preserving substantive content and its evidence. Do not add facts, sections, examples or explanation to fill a length target. Do not undo a developmental cut or move. Keep the draft's length within ten percent unless readerNotes explicitly requires a factual correction."
      : draftWords < budget.target * EDITOR_EXTEND_BELOW_SHARE
      ? `The draft is ${draftWords} words and the chapter needs about ${budget.target} (never under ${budget.min}, never over ${budget.max}): develop the existing sections with more particular detail — the named person, the document, the place, the next thing that happened — rather than adding sections, generalising, or restating.`
      : `Return between ${budget.min} and ${budget.max} words; the draft is ${draftWords} words. Over ${budget.max}, cut.`,
    ...(toolkit
      ? [...(options.contract === "creative" ? [TOOLKIT_QUOTATION_RULE] : [GROUNDED_FACTUALITY_RULE, ...citation.rules, CHAPTER_RESEARCH_CONTEXT_RULE]), EXAMPLE_PEOPLE_RULE]
      : options.contract === "creative" ? [CREATIVE_CONTRACT_RULES[1]!, ...(narrative ? [] : [history ? HISTORY_RECONSTRUCTION_RULE : FOCUSED_RECONSTRUCTION_RULE])] : [GROUNDED_FACTUALITY_RULE, ...citation.rules, CHAPTER_RESEARCH_CONTEXT_RULE, history ? HISTORY_RECONSTRUCTION_RULE : FOCUSED_RECONSTRUCTION_RULE]),
    ...materialEditLines({ ...options, nonfiction: !narrative, history, practical: Boolean(toolkit) }),
    ...(toolkit ? exampleCastLinesForChapter(options.exampleCast, options.chapter.index) : exampleCastLines(options.exampleCast)),
    ...toolkitWriterLines(toolkit, options.chapter.index),
    ...(options.factualCorrection ? ["factualCorrection authorizes a targeted factual repair: correct, narrow or delete only the named unsupported claims against its evidence. The preservation rule applies to unrelated meaning; do not preserve the erroneous claim. Follow the correction instructions and evidence over the original claim."] : []),
    ...(options.material?.scene
      ? [`The chapter opens with a scene of about ${options.material.scene.words} words that was written on purpose in a narrating register; keep it a scene — tighten it if you must, never turn it into summary or argument. A later passage that tells that scene's events, figures or quotations again is a restatement: cut it down to what it adds.`]
      : []),
    // Research notes arrive as "title: summary" and a search hit's title is
    // often its bare domain, so a writer told to name only sources in the
    // notes wrote "the explanatory pages at psychstory.co.uk" (composed-17).
    "Never name a website, domain or URL in the prose, and never refer to your notes: no \"research brief\", \"research record\", \"supplied evidence\", \"the figures supplied\", \"the material for this discussion\" or any phrase that says where a fact came from. State the fact as the author who knows it; the Sources list is typeset from the notes.",
    BYLINE_IS_TYPESET_RULE,
    PROMPT_LEAK_BAN,
    ...targetLanguageGenerationGuidance(options.input.language),
    ...kidsReadingGuidanceLines(options.input),
    toolkit
      ? "Return only the revised chapter as Markdown: keep every ### section heading exactly as the draft has it, and every list, table, script or worksheet; no other headings, no notes, no preface, no summary of your changes."
      : mode === "instructional"
      ? "Return only the revised chapter as Markdown: no headings, no notes, no preface, no summary of your changes; keep every list or table the draft uses for steps, a checklist or a worksheet."
      : "Return only the revised chapter as Markdown prose: paragraphs only, no headings, no notes, no preface, no summary of your changes."
  ];
  const result = await options.textModel.generateText({
    purpose: EDIT_CHAPTER_PURPOSE,
    ...(options.signal ? { signal: options.signal } : {}),
    temperature: Math.min(0.7, options.input.temperature),
    maxTokens: composeMaxTokens(editBudget),
    messages: [
      { role: "system", content: systemLines.join(" ") },
      {
        role: "user",
        content: JSON.stringify(
          {
            language: targetLanguagePayload(options.input.language),
            chapterPosition: chapterPosition(options.plan, options.chapter, options.chapterPageStart, options.chapterPageEnd),
            draft: options.markdown,
            ...(options.factualCorrection ? { factualCorrection: options.factualCorrection } : {}),
            ...(options.previousChapterTail ? { previousChapterTail: options.previousChapterTail } : {}),
            earlierChapters: options.earlierChapters,
            ...(establishedFacts.length > 0 ? { establishedFacts } : {}),
            ...(!focused && options.measurementNotes && options.measurementNotes.length > 0 ? { measurementNotes: options.measurementNotes } : {}),
            ...(options.readerNotes && options.readerNotes.length > 0 ? { readerNotes: options.readerNotes } : {}),
            ...citation.payload,
            ...materialPayload({ ...options, history, practical: Boolean(toolkit) }),
            ...toolkitPayload(toolkit, options.chapter.index),
            wordBudget: editBudget
          },
          null,
          2
        )
      }
    ]
  });
  const markdown = normalizeChapterMarkdown(unfence(result.text), { chapterTitle: options.chapter.title, ...(toolkit ? { keepSubheadings: true } : {}) });
  const words = proseWordCount(markdown);
  // An edit that lost more than a third of the chapter is a refusal or a
  // truncation, not an edit; the draft stands.
  options.signal?.throwIfAborted();
  // Composition's editor cannot create or deepen a page-budget shortfall: it may cut
  // to the floor the book is judged at, as it prints, never under it or a draft
  // already under it (`editShortensPastFloor`). Explicit final edits after structural
  // reallocation and factual repairs may shorten the text; final manuscript QA
  // reports any remaining deficit.
  const lengthRegressed = !options.factualCorrection && options.allowExtension !== false && editShortensPastFloor(options.markdown, markdown, budget.min);
  if (!markdown || lengthRegressed || words < draftWords * 0.62 || chapterDegeneracy(markdown, {
    maxWords: options.degeneracyMaxWords ?? (options.factualCorrection ? editBudget.max : chapterWordBudget(options.input, pages).max), language: options.input.language
  }).degenerate) {
    return { markdown: options.markdown, words: draftWords, attempts: 1, changed: false };
  }
  if (markdown !== options.markdown && !await acceptsChapterEdit(options, markdown)) {
    return { markdown: options.markdown, words: draftWords, attempts: 1, changed: false };
  }
  return { markdown, words, attempts: 1, changed: markdown !== options.markdown };
}

/**
 * The focused pass: change only the quoted sentences and leave everything else
 * byte for byte. The omnibus line edit received eight measured notes and acted
 * on none; a rewrite whose whole job is a list of sentences complies.
 */
export async function detemplateChapter(
  options: EditChapterOptions & { notes: string[] }
): Promise<EditedChapterText> {
  const draftWords = countReadableWords(options.markdown);
  if (options.notes.length === 0) {
    return { markdown: options.markdown, words: draftWords, attempts: 0, changed: false };
  }
  const mode = inferWritingMode(options.input, options.plan);
  const pages = options.chapterPageEnd - options.chapterPageStart + 1;
  const budget = chapterWordBudget(options.input, pages);
  const result = await options.textModel.generateText({
    purpose: DETEMPLATE_CHAPTER_PURPOSE,
    temperature: Math.min(0.5, options.input.temperature),
    maxTokens: composeMaxTokens(budget),
    messages: [
      {
        role: "system",
        content: [
          `You are removing recurring moves from chapter ${options.chapter.index} of "${options.plan.title}" without changing its substance.`,
          ...authorStancePromptLines(options.stance, mode),
          "The notes quote the sentences that carry each recurring move. Rewrite those sentences, and only where the fix needs it the sentence beside each, so that the move is gone: cut, fold, or say one thing plainly. Every other sentence is returned byte for byte, in the same order, in the same paragraphs.",
          "Add no claim, example or source. Keep every fact, name, date, number and quotation. Do not replace a removed sentence with a sentence of the same shape, and do not replace it with an object placed for effect.",
          PROMPT_LEAK_BAN,
          ...targetLanguageGenerationGuidance(options.input.language),
          "Return the whole chapter as Markdown prose, paragraphs only, no headings, no notes."
        ].join(" ")
      },
      {
        role: "user",
        content: JSON.stringify({ notes: options.notes, chapter: options.markdown }, null, 2)
      }
    ]
  });
  const markdown = normalizeChapterMarkdown(unfence(result.text), { chapterTitle: options.chapter.title });
  const words = countReadableWords(markdown);
  // A pass that lost more than a fifth of the chapter did more than it was asked.
  if (!markdown || words < draftWords * 0.8) {
    return { markdown: options.markdown, words: draftWords, attempts: 1, changed: false };
  }
  return { markdown, words, attempts: 1, changed: markdown !== options.markdown };
}

/** A chapter's digest for later chapters: its page summaries, clipped. */
export function chapterDigest(pageSummaries: readonly string[]): string {
  const joined = pageSummaries.map((summary) => summary.trim()).filter(Boolean).join(" ");
  if (joined.length <= CHAPTER_DIGEST_MAX_CHARACTERS) {
    return joined;
  }
  return `${joined.slice(0, CHAPTER_DIGEST_MAX_CHARACTERS - 1).trimEnd()}…`;
}
