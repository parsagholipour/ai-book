import { z } from "zod";
import type { TextModelAdapter } from "../adapters/types.js";
import { isDiagramFriendlyBookCategory } from "../categories.js";
import { CONTINUITY_NOTE_PROMPT_LIMITS, continuityNotesForPrompt } from "../context/contextPack.js";
import { targetLanguageGenerationGuidance, targetLanguagePayload } from "../prompting/language.js";
import { kidsReadingGuidanceForInput, kidsReadingGuidanceLines } from "../prompting/readingLevel.js";
import type { AuthorStance, BookPlan, ChapterPlan, CreateProjectInput } from "../schemas/book.js";
import { isRecord } from "../schemas/jsonCoercion.js";
import { authorStancePromptLines, isNarrativeWritingMode } from "./authorStance.js";
import type { BookArc } from "./bookArc.js";
import { chapterDevelopmentLines } from "./bookDevelopment.js";
import {
  CREATIVE_CONTRACT_RULES,
  CREATIVE_RECONSTRUCTION_RULE,
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
import { stanceLinesFor } from "./composedChapterStance.js";
import {  compositionWriterLines, formPaletteFor, type ChapterComposition } from "./chapterForms.js";
import { normalizeChapterMarkdown } from "./chapterPagination.js";
import { FIGURE_WORD_EQUIVALENT, figureFreeProse, figureStandInMarkdown, proseWordCount } from "./figures/figureBlocks.js";
import { codeBlockRules } from "./codeBlockRules.js";
import { figureComposeRules, figureEditRules, plannedFigures } from "./figures/figurePrompt.js";
import { generateJsonWithRetry } from "./generateJsonWithRetry.js";
import { chapterStyleNotes } from "./planContract.js";
import { BYLINE_IS_TYPESET_RULE } from "./markdown.js";
import { GROUNDED_FACTUALITY_RULE, IMAGE_PROMPT_CHARACTER_RULE, citationContractFields } from "./pagesShared.js";
import { countReadableWords } from "./proseShape.js";
import { inferWritingMode } from "./styleContract.js";
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
export const DESCRIBE_PAGES_PURPOSE = "describe-pages";

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
    : isDiagramFriendlyBookCategory(input.category)
      ? { min: 300, target: 380, max: 480 }
      : // A printed page holds ~490 words of this prose: 480 a page printed 107–112 of 120
        // paid, 540 printed 124, 520 printed 120, and length made no difference to the blind
        // panel (480: 7.32, 520: 7.31, ×3 each). But at ~87% delivery 520 sat the book on its
        // floor and the read's cuts could not apply; 570 lands ~10% above it for them to spend.
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

export type EarlierChapterDigest = {
  index: number;
  title: string;
  digest: string;
  /** The cases, sources, scenes and people that chapter's sections owned: already told, named only. */
  told?: string[] | undefined;
};

export type ComposeChapterOptions = {
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
};

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

function shapeRules(narrative: boolean): string[] {
  return [
    narrative
      ? "Every scene and every paragraph inside it ends on action, speech, or an image, never on a sentence that explains what the scene meant or what a character has learned."
      : "The sections are movements of one argument, not separate essays: let each grow out of the one before, point back to an earlier case in a clause when it bears on the current one, and let the chapter's claim accumulate. Do not open every section on a place-and-date stamp, and do not close sections on a placed object for effect: a reed marker, a file on a table, dust on a path. Once a chapter is a texture; every section is a tic.",
    "The book's plan is not visible to the reader: never refer to a chapter by number, never say what another chapter showed or will show, and never mention the sections, forms, handoffs or notes you were given. A case the book treated earlier is pointed to in half a sentence, never re-narrated.",
    "The chapter ends where its last section ends. A catalogue is written in sentences, never as labelled entries.",
    "State what a source shows and use it. Do not follow each affirmation with what the source cannot show: the sentence pair that asserts and then withdraws — \"It can show X. It cannot show Y.\", \"The record shows X. It does not show Y.\" — may appear at most three times in the chapter. Rhetorical questions: at most one per section, never a run of them.",
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
  if (isLast) {
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
function bookPayload(plan: BookPlan, input: CreateProjectInput, withheld: BookArc | undefined) {
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
    continuityRules: plan.continuityRules,
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
  const focused = !narrative && Boolean(options.material?.focus);
  const palette = formPaletteFor(mode);
  const pages = options.chapterPageEnd - options.chapterPageStart + 1;
  const budget = chapterWordBudget(options.input, pages, { figureWords: plannedFigures(options.composition).length * FIGURE_WORD_EQUIVALENT });
  const citation = citationContractFields(options.researchNotes.slice(0, 18));
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
    "Paragraphs only: no headings, no title line, no section labels, no page numbers or page breaks, no summary, no epigraph, no notes. Move between sections with a paragraph break and a change of register.",
    ...(minimal
      ? []
      : focused
        ? focusedProgressionLines()
        : shapeRules(narrative).filter(
            // Under an arc only a method chapter keeps the evidence-limit rule; the others' job is not to bound sources.
            (rule) => !(options.arc && arcKindFor(options) !== "method" && rule.startsWith("State what a source shows"))
          )),
    ...(minimal ? [] : ["Do not open the chapter with a general claim about a common noun (\"A cannon was never only a cannon\")."]),
    ...(minimal || options.material?.evidencePackets?.length ? [] : options.contract === "creative" ? (narrative ? [] : [options.material?.focus ? FOCUSED_RECONSTRUCTION_RULE : CREATIVE_RECONSTRUCTION_RULE]) : reconstructionRule(narrative)),
    `Now chapter ${options.chapter.index}, "${options.chapter.title}".`,
    ...materialLines(options),
    ...chapterDevelopmentLines(options.plan, options.chapter.index),
    ...(focused ? [] : compositionWriterLines(options.composition, palette, budget.target)),
    ...figureComposeRules(options.composition),
    ...codeBlockRules(options.input, options.plan),
    ...(options.variant === "second"
      ? [
          "This is the second of two drafts of this chapter, to be judged against the first. Enter the first section by a different door than the obvious one, put the chapter's one sustained stretch in a different section than a first draft would, and let a different section carry the short paragraphs."
        ]
      : []),
    ...positionLines({ plan: options.plan, chapter: options.chapter, input: options.input, narrative }),
    // Composed-8's chapter 8 opened by paraphrasing chapter 7's tail as a coda,
    // and the cut then removed chapter 7's own closing, so three blind readers
    // found the previous chapter's conclusion stranded under the next heading.
    "previousChapterTail is where the previous chapter stopped, already printed: this chapter opens on its own first section's material and neither resumes, summarises nor answers that paragraph. earlierChapters are digests of what the reader already knows, each with told: the cases, sources, scenes and people that chapter carried; anything in told may be named in passing and is never re-told, and its dates and figures are not repeated.",
    ...(options.contract === "creative" ? CREATIVE_CONTRACT_RULES : [GROUNDED_FACTUALITY_RULE, ...citation.rules]),
    // Research notes arrive as "title: summary" and a search hit's title is
    // often its bare domain, so a writer told to name only sources in the
    // notes wrote "the explanatory pages at psychstory.co.uk" (composed-17).
    "Never name a website, domain or URL in the prose, and never refer to your notes: no \"research brief\", \"research record\", \"supplied evidence\", \"the figures supplied\", \"the material for this discussion\" or any phrase that says where a fact came from. State the fact as the author who knows it; the Sources list is typeset from the notes.",
    BYLINE_IS_TYPESET_RULE,
    PROMPT_LEAK_BAN,
    ...targetLanguageGenerationGuidance(options.input.language),
    ...kidsReadingGuidanceLines(options.input),
    `Write between ${remaining.min} and ${remaining.max} words and aim for ${options.plan.bookDevelopment ? Math.min(remaining.max, Math.ceil(remaining.target / 0.87)) : remaining.target}. The typesetter will divide the chapter into ${pages} pages of about ${budget.perPage} words; pages are not units of argument, so do not shape the prose around them.`,
    "Return only the chapter's prose."
  ];
  const userPayload = {
    language: targetLanguagePayload(options.input.language),
    userPrompt: options.input.prompt,
    // A focused middle chapter is not handed the thesis back as the premise, nor where the book lands as promises.
    book: {
      ...bookPayload(options.plan, options.input, withheldArc(options)),
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
    characters: characterPayload(options.plan),
    ...citation.payload,
    ...materialPayload(options),
    wordBudget: budget
  };

  let attempts = 0;
  let best: ComposedChapterText | undefined;
  let shortfall: string | undefined;
  while (attempts < 2) {
    attempts += 1;
    const result = await options.textModel.generateText({
      purpose: COMPOSE_CHAPTER_PURPOSE,
      temperature: options.temperature ?? options.input.temperature,
      maxTokens: composeMaxTokens(budget),
      messages: [
        { role: "system", content: [...systemLines, ...(shortfall ? [shortfall] : [])].join(" ") },
        { role: "user", content: JSON.stringify(userPayload, null, 2) }
      ]
    });
    const markdown = normalizeChapterMarkdown(unfence(result.text), { chapterTitle: options.chapter.title });
    const words = proseWordCount(markdown);
    const candidate = { markdown, words, attempts };
    if (!best || words > best.words) {
      best = candidate;
    }
    if (words >= remaining.min * (options.plan.bookDevelopment ? 1 : 0.7)) {
      break;
    }
    shortfall = `Your previous answer was ${words} words; the chapter needs at least ${remaining.min}. Write the complete chapter.`;
  }
  if (!best || !best.markdown) {
    throw new Error(`Chapter ${options.chapter.index} came back empty.`);
  }
  return best;
}

export type EditChapterOptions = ComposeChapterOptions & {
  /** Structural editing allocates length across the book; a line edit cannot pad a chapter. */
  allowExtension?: boolean | undefined;
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

/** The cut scoped to a chapter's tail: the read's notes name recap tails and closers, so the head is not sent. */
export const CUT_TAIL_WORDS = 600;

export async function cutChapterTail(
  options: EditChapterOptions & { notes: string[]; bookNotes?: string[] | undefined }
): Promise<EditedChapterText> {
  const paragraphs = options.markdown.split(/\n\s*\n/);
  let tailStart = paragraphs.length;
  let words = 0;
  while (tailStart > 1 && words < CUT_TAIL_WORDS) {
    tailStart -= 1;
    words += countReadableWords(paragraphs[tailStart] ?? "");
  }
  const head = paragraphs.slice(0, tailStart).join("\n\n");
  const tail = paragraphs.slice(tailStart).join("\n\n");
  const cut = await cutChapter({ ...options, markdown: tail });
  if (!cut.changed) {
    return { markdown: options.markdown, words: countReadableWords(options.markdown), attempts: cut.attempts, changed: false };
  }
  const markdown = head ? `${head}\n\n${cut.markdown}` : cut.markdown;
  return { markdown, words: countReadableWords(markdown), attempts: cut.attempts, changed: true };
}

/** The cut may remove between half a percent and a quarter of the chapter. */
const CUT_MIN_KEPT_SHARE = 0.75;

function cutParagraphs(markdown: string): string[] {
  return markdown
    .split(/\n\s*\n/)
    .map((paragraph) => paragraph.replace(/\s+/g, " ").trim())
    .filter(Boolean);
}

function cutSentences(paragraph: string): string[] {
  return paragraph
    .split(/(?<=[.!?؟。][”"’')\]]?)\s+/)
    .map((sentence) => sentence.trim())
    .filter(Boolean);
}

/**
 * Accepts a cut only if it is one: every kept paragraph is one of the draft's
 * paragraphs with zero or more whole sentences removed, in order, and the
 * chapter kept at least 75% of its words and made a cut. Anything else — a rewrite,
 * a merge, a fragment, a refusal, an over-cut — returns undefined and the draft
 * stands. Nothing the model writes can enter the book through this pass.
 */
export function deletionOnlyResult(draft: string, candidate: string): string | undefined {
  const draftParagraphs = cutParagraphs(draft);
  const keptParagraphs = cutParagraphs(candidate);
  if (keptParagraphs.length === 0 || keptParagraphs.length > draftParagraphs.length) {
    return undefined;
  }
  let cursor = 0;
  for (const kept of keptParagraphs) {
    const keptSentences = cutSentences(kept);
    let found = -1;
    for (let index = cursor; index < draftParagraphs.length; index += 1) {
      const source = cutSentences(draftParagraphs[index]!);
      let at = 0;
      for (const sentence of source) {
        if (at < keptSentences.length && sentence === keptSentences[at]) {
          at += 1;
        }
      }
      if (at === keptSentences.length) {
        found = index;
        break;
      }
    }
    if (found < 0) {
      return undefined;
    }
    cursor = found + 1;
  }
  const draftWords = countReadableWords(draft);
  const keptWords = countReadableWords(candidate);
  const share = draftWords > 0 ? keptWords / draftWords : 0;
  if (share < CUT_MIN_KEPT_SHARE || keptWords >= draftWords) {
    return undefined;
  }
  return keptParagraphs.join("\n\n");
}

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
  const draftWords = countReadableWords(options.markdown);
  const pages = options.chapterPageEnd - options.chapterPageStart + 1;
  const budget = chapterWordBudget(options.input, pages);
  const removableWords = Math.max(0, Math.min(draftWords - budget.min, options.maxRemovableWords ?? Infinity));
  if (removableWords === 0) {
    return { markdown: options.markdown, words: draftWords, attempts: 0, changed: false };
  }
  const result = await options.textModel.generateText({
    purpose: CUT_CHAPTER_PURPOSE,
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
            ...(options.bookNotes && options.bookNotes.length > 0 ? { bookNotes: options.bookNotes } : {})
          },
          null,
          2
        )
      }
    ]
  });
  const cut = deletionOnlyResult(options.markdown, normalizeChapterMarkdown(unfence(result.text), { chapterTitle: options.chapter.title }));
  // A cut that takes the chapter under the pages it was paid for is refused, deletion-only or not.
  if (!cut || countReadableWords(cut) < budget.min || draftWords - countReadableWords(cut) > removableWords) {
    return { markdown: options.markdown, words: draftWords, attempts: 1, changed: false };
  }
  return { markdown: cut, words: countReadableWords(cut), attempts: 1, changed: true };
}

export async function editChapter(options: EditChapterOptions): Promise<EditedChapterText> {
  const mode = inferWritingMode(options.input, options.plan);
  const narrative = isNarrativeWritingMode(mode);
  const focused = !narrative && Boolean(options.material?.focus);
  const palette = formPaletteFor(mode);
  const pages = options.chapterPageEnd - options.chapterPageStart + 1;
  const budget = chapterWordBudget(options.input, pages, { figureWords: plannedFigures(options.composition).length * FIGURE_WORD_EQUIVALENT });
  const draftWords = proseWordCount(options.markdown);
  const citation = citationContractFields(options.researchNotes.slice(0, 18));
  const systemLines = [
    `You are the line editor for "${options.plan.title}", revising each chapter into its finished form in the author's own voice.`,
    ...stanceLinesFor(options),
    "Preserve the chapter's claims, causal relationships, negation, scope, uncertainty, names, dates, quantities and exact quotations. Keep the section order and the material of the opening. A qualification may be essential even when its names and numbers occur elsewhere.",
    "Edit where the surrounding passage gives a concrete reason: clarify a confusing sentence or remove a repetition that adds no fact, distinction, context or narrative purpose. Sentence shape alone is not a defect. Intentional repetition, dialogue and quotations may recur. Keep a passage unchanged when an improvement would lose meaning or require guessing.",
    narrative
      ? "Judge pacing through the scene's actions and consequences; keep reflection when it changes what the reader understands."
      : "Judge pacing through the chapter's evidence and explanation. Keep a caveat when it limits an inference; cut it only when the same limitation is already stated with the same scope and context.",
    "Use the book's spelling convention. Add no new claim, episode or source during this edit.",
    ...(focused ? focusedProgressionLines() : []),
    `Now chapter ${options.chapter.index}, "${options.chapter.title}".`,
    ...(focused ? [] : compositionWriterLines(options.composition, palette, budget.target)),
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
    ...(options.contract === "creative" ? [CREATIVE_CONTRACT_RULES[1]!] : [GROUNDED_FACTUALITY_RULE, ...citation.rules]),
    ...materialEditLines(options),
    ...(options.material?.scene
      ? [`The chapter opens with a scene of about ${options.material.scene.words} words that was written on purpose in a narrating register; keep it a scene — tighten it if you must, never turn it into summary or argument.`]
      : []),
    // Research notes arrive as "title: summary" and a search hit's title is
    // often its bare domain, so a writer told to name only sources in the
    // notes wrote "the explanatory pages at psychstory.co.uk" (composed-17).
    "Never name a website, domain or URL in the prose, and never refer to your notes: no \"research brief\", \"research record\", \"supplied evidence\", \"the figures supplied\", \"the material for this discussion\" or any phrase that says where a fact came from. State the fact as the author who knows it; the Sources list is typeset from the notes.",
    BYLINE_IS_TYPESET_RULE,
    PROMPT_LEAK_BAN,
    ...targetLanguageGenerationGuidance(options.input.language),
    ...kidsReadingGuidanceLines(options.input),
    "Return only the revised chapter as Markdown prose: paragraphs only, no headings, no notes, no preface, no summary of your changes."
  ];
  const result = await options.textModel.generateText({
    purpose: EDIT_CHAPTER_PURPOSE,
    temperature: Math.min(0.7, options.input.temperature),
    maxTokens: composeMaxTokens(budget),
    messages: [
      { role: "system", content: systemLines.join(" ") },
      {
        role: "user",
        content: JSON.stringify(
          {
            language: targetLanguagePayload(options.input.language),
            chapterPosition: chapterPosition(options.plan, options.chapter, options.chapterPageStart, options.chapterPageEnd),
            draft: options.markdown,
            ...(options.previousChapterTail ? { previousChapterTail: options.previousChapterTail } : {}),
            earlierChapters: options.earlierChapters,
            ...(!focused && options.measurementNotes && options.measurementNotes.length > 0 ? { measurementNotes: options.measurementNotes } : {}),
            ...(options.readerNotes && options.readerNotes.length > 0 ? { readerNotes: options.readerNotes } : {}),
            ...citation.payload,
            ...materialPayload(options),
            wordBudget: budget
          },
          null,
          2
        )
      }
    ]
  });
  const markdown = normalizeChapterMarkdown(unfence(result.text), { chapterTitle: options.chapter.title });
  const words = countReadableWords(markdown);
  // An edit that lost more than a third of the chapter is a refusal or a
  // truncation, not an edit; the draft stands.
  if (!markdown || words < draftWords * 0.62) {
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

export type ChapterPageForDescription = { index: number; markdown: string };

export type DescribedPage = {
  index: number;
  title: string;
  summary: string;
  continuityNotes: string[];
  imagePrompt?: string;
};

const describedPageSchema = z.object({
  index: z.number().int().positive(),
  title: z.string().default(""),
  summary: z.string().default(""),
  continuityNotes: z.array(z.string()).default([]),
  imagePrompt: z.string().optional()
});

const describedPagesResponseSchema = z.preprocess(
  (value) => (Array.isArray(value) ? { pages: value } : isRecord(value) && Array.isArray(value.pages) ? value : value),
  z.object({ pages: z.array(z.unknown()) })
);

function firstSentence(markdown: string): string {
  const plain = markdown.replace(/[#*_>`]/g, " ").replace(/\s+/g, " ").trim();
  const match = plain.match(/^(.{20,240}?[.!?…؟。])(\s|$)/u);
  return (match?.[1] ?? plain.slice(0, 240)).trim();
}

/** What a page is called and remembered as when the model could not say. */
export function fallbackPageDescription(page: ChapterPageForDescription, illustrated: boolean): DescribedPage {
  const sentence = firstSentence(figureFreeProse(page.markdown));
  const title = sentence.split(/\s+/).slice(0, 7).join(" ").replace(/[,;:.!?…]+$/u, "") || `Page ${page.index}`;
  return {
    index: page.index,
    title,
    summary: sentence || `Page ${page.index}.`,
    continuityNotes: [],
    ...(illustrated && sentence ? { imagePrompt: `An illustration of this moment: ${sentence}` } : {})
  };
}

export async function describeChapterPages(options: {
  input: CreateProjectInput;
  plan: BookPlan;
  chapter: ChapterPlan;
  pages: ChapterPageForDescription[];
  illustratedIndexes: readonly number[];
  textModel: TextModelAdapter;
}): Promise<DescribedPage[]> {
  const illustrated = new Set(options.illustratedIndexes);
  const fallback = () => options.pages.map((page) => fallbackPageDescription(page, illustrated.has(page.index)));
  if (options.pages.length === 0) {
    return [];
  }
  let raw: unknown;
  try {
    raw = (
      await generateJsonWithRetry(options.textModel, {
        purpose: DESCRIBE_PAGES_PURPOSE,
        temperature: 0.2,
        maxTokens: Math.min(16_000, 800 + options.pages.length * 260),
        schema: z.unknown(),
        messages: [
          {
            role: "system",
            content: [
              "Describe each page of this chapter for the book's index and its continuity memory. Return one JSON object with a pages array in the same order as the input, one object per page: index, title, summary, continuityNotes, and imagePrompt only where asked.",
              "title: concise and specific to what happens on that page; never the chapter title, never a Page N label, never the same as a neighbouring page's title.",
              "summary: one or two sentences recording what the page covers — the facts, events or decisions — and any unresolved handoff into the next page.",
              "continuityNotes: zero to three short facts later chapters must keep consistent (names, dates, places, states, decisions). Omit trivia.",
              "imagePrompt: only for pages whose index is in illustratedPageIndexes. A self-contained visual description of one moment on that page in the book's illustration style, naming recurring characters exactly as in characters, with no text or lettering in the image. Omit the key on every other page.",
              IMAGE_PROMPT_CHARACTER_RULE,
              ...targetLanguageGenerationGuidance(options.input.language)
            ].join(" ")
          },
          {
            role: "user",
            content: JSON.stringify(
              {
                language: targetLanguagePayload(options.input.language),
                book: { title: options.plan.title, audience: options.plan.audience },
                chapter: { index: options.chapter.index, title: options.chapter.title },
                illustrationPlan: options.plan.illustrationPlan,
                characters: options.plan.characters,
                illustratedPageIndexes: options.illustratedIndexes,
                // The describer reads prose and a stand-in, never a figure's JSON.
                pages: options.pages.map((page) => ({ index: page.index, markdown: figureStandInMarkdown(page.markdown) })),
                outputContract: {
                  pages: [
                    {
                      index: options.pages[0]!.index,
                      title: "Specific page title",
                      summary: "One or two sentences.",
                      continuityNotes: ["A fact later chapters keep consistent."],
                      imagePrompt: "Only for illustrated pages."
                    }
                  ]
                }
              },
              null,
              2
            )
          }
        ]
      })
    ).data;
  } catch (error) {
    if (error instanceof Error && /stop/i.test(error.name)) {
      throw error;
    }
    return fallback();
  }
  const parsed = describedPagesResponseSchema.safeParse(raw);
  const byIndex = new Map<number, DescribedPage>();
  if (parsed.success) {
    for (const candidate of parsed.data.pages) {
      const page = describedPageSchema.safeParse(candidate);
      if (page.success && !byIndex.has(page.data.index)) {
        const { imagePrompt, ...rest } = page.data;
        byIndex.set(page.data.index, { ...rest, ...(imagePrompt !== undefined ? { imagePrompt } : {}) });
      }
    }
  }
  return options.pages.map((page) => {
    const described = byIndex.get(page.index);
    const stand = fallbackPageDescription(page, illustrated.has(page.index));
    if (!described) {
      return stand;
    }
    const wantsImage = illustrated.has(page.index);
    const imagePrompt = wantsImage ? described.imagePrompt?.trim() || stand.imagePrompt : undefined;
    return {
      index: page.index,
      title: described.title.trim() || stand.title,
      summary: described.summary.trim() || stand.summary,
      continuityNotes: described.continuityNotes.map((note) => note.trim()).filter(Boolean).slice(0, 3),
      ...(imagePrompt ? { imagePrompt } : {})
    };
  });
}

/** A chapter's digest for later chapters: its page summaries, clipped. */
export function chapterDigest(pageSummaries: readonly string[]): string {
  const joined = pageSummaries.map((summary) => summary.trim()).filter(Boolean).join(" ");
  if (joined.length <= CHAPTER_DIGEST_MAX_CHARACTERS) {
    return joined;
  }
  return `${joined.slice(0, CHAPTER_DIGEST_MAX_CHARACTERS - 1).trimEnd()}…`;
}
