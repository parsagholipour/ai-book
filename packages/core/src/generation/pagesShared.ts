import type { TextModelAdapter } from "../adapters/types.js";
import { isSignpostingBookCategory } from "../categories.js";
import {
  kidsReadingGuidanceLines,
  kidsReadingGuidancePayload
} from "../prompting/readingLevel.js";
import { plannerToneGuidance, reviewerStyleGuidance, toneProfileFromMediaSettings, writerToneGuidance } from "../prompting/tone.js";
import type { BookPlan, ChapterBrief, ChapterPlan, CreateProjectInput, PageProductionBeat } from "../schemas/book.js";
import { isRecord, jsonRecord, mediaSettingsMobileRecord } from "../schemas/jsonCoercion.js";
import { isImportedManuscript } from "../schemas/mediaSettings.js";
import { BYLINE_IS_TYPESET_RULE } from "./markdown.js";

/**
 * Prompt rules and payload helpers shared by the page-map production layer
 * (`pagesPageMap.ts`), the drafting layer (`pages.ts`) and the review layer
 * (`pagesReview.ts`). Split out of pages.ts; nothing here is part of the
 * public `@book-maker/core` surface except `PriorPageContext`, which pages.ts
 * re-exports.
 */

export function plannerToneRules(input: CreateProjectInput): string[] {
  return [...kidsReadingGuidanceLines(input), ...plannerToneGuidance(toneProfileFromMediaSettings(input.mediaSettings))];
}

export function writerToneRules(input: CreateProjectInput): string[] {
  return [...kidsReadingGuidanceLines(input), ...writerToneGuidance(toneProfileFromMediaSettings(input.mediaSettings))];
}

export function reviewerStyleRules(input: CreateProjectInput): string[] {
  return [
    ...kidsReadingGuidanceLines(input).map((line) => `Reject if the page violates this reading-level rule: ${line}`),
    ...reviewerStyleGuidance()
  ];
}

export const READER_FACING_PAGE_BRIEF_RULES = [
  "Treat pageBrief purpose, beat, requiredContinuity, and endingPressure as internal assignment notes; transform them into prose instead of echoing their wording.",
  'Do not write procedural phrases such as "concluding the survey", "this chapter transitions", "the next section", or "the scope of this survey" in the page.',
  "If requiredContinuity points to an earlier page, preserve consistency without re-explaining that page's concrete examples; add a new implication or consequence.",
  "When pageScope.isLastPageOfChapter is true, close with a concrete implication for the chapter's argument and let any handoff to the next chapter arise from substance, not from announcing a transition.",
  BYLINE_IS_TYPESET_RULE
];

export const INTERNAL_PAGE_TITLE_RULE =
  "The title field is internal tracking metadata only; give it a concise page-specific title that reflects this page's beat, and do not reuse the book title, chapter title, a Page N label, mini-chapter heading, or an adjacent/recent page title.";
export const GROUNDED_FACTUALITY_RULE =
  "For factual or research-grounded prose, never invent studies, journals, experts, institutions, citations, statistics, source names, or numeric findings; use provided researchNotes or qualify/omit unsupported claims.";
export const IMAGE_PROMPT_CHARACTER_RULE =
  "When imagePrompt depicts recurring characters, use exact character names from characters, preserve visualRules, and avoid generic labels when a named character appears.";

export function styleGuidancePayload(input: CreateProjectInput) {
  const toneProfile = toneProfileFromMediaSettings(input.mediaSettings);
  return {
    toneProfile,
    readingGuidance: kidsReadingGuidancePayload(input),
    rules: writerToneGuidance(toneProfile)
  };
}

export type PriorPageContext = {
  index: number;
  title: string;
  markdown: string;
  summary: string;
};

export type GeneratePageOptions = {
  input: CreateProjectInput;
  plan: BookPlan;
  chapter?: ChapterPlan | undefined;
  chapterBrief?: ChapterBrief | undefined;
  pageBrief?: PageProductionBeat | undefined;
  chapterPageStart?: number | undefined;
  chapterPageEnd?: number | undefined;
  pageIndex: number;
  previousSummaries: string[];
  previousPages?: PriorPageContext[] | undefined;
  /**
   * Pages that already exist *after* this one and are not being rewritten.
   *
   * Empty for every page a book writes front to back, which is why the drafting
   * context has only ever looked backwards. A page inserted into a finished
   * book is the case that needs it: it has to hand off to prose the reader
   * already has, and without seeing that prose it either stops mid-thought or
   * writes the following page's beat a second time.
   */
  nextPages?: PriorPageContext[] | undefined;
  continuityNotes: string[];
  researchNotes: string[];
  /** Semantically retrieved long-range context outside the recency window. */
  semanticMemory?: string[] | undefined;
  /** Structured character/location state lines. */
  entityState?: string[] | undefined;
  /** Pinned accepted-page excerpts, separate from recency. */
  styleExcerpts?: string[] | undefined;
  /**
   * Fetch a stored page by global index from the whole manuscript, not just the
   * loaded window. Injected by the worker because core cannot import the DB;
   * absent in tests and non-sequential modes, which fall back to the window.
   */
  lookupStoredPage?: ((pageIndex: number) => Promise<PriorPageContext | null>) | undefined;
  /** Hybrid semantic/keyword search over the book's stored page memory, injected by the worker. */
  searchStoredMemory?: ((query: string) => Promise<string[]>) | undefined;
  textModel: TextModelAdapter;
};

export type PageScopeSource = {
  input: CreateProjectInput;
  chapter?: ChapterPlan | undefined;
  chapterBrief?: ChapterBrief | undefined;
  pageBrief?: PageProductionBeat | undefined;
  chapterPageStart?: number | undefined;
  chapterPageEnd?: number | undefined;
  pageIndex: number;
};

export function pageScopePayload(options: PageScopeSource) {
  const briefPages = options.chapterBrief?.pages ?? [];
  const briefIndexes = briefPages.map((page) => page.pageIndex).filter((pageIndex) => Number.isFinite(pageIndex));
  const chapterPageStart = options.chapterPageStart ?? (briefIndexes.length > 0 ? Math.min(...briefIndexes) : undefined);
  const chapterPageEnd = options.chapterPageEnd ?? (briefIndexes.length > 0 ? Math.max(...briefIndexes) : undefined);
  const chapterPageCount =
    chapterPageStart !== undefined && chapterPageEnd !== undefined
      ? Math.max(1, chapterPageEnd - chapterPageStart + 1)
      : options.chapter?.targetPages;
  const chapterPageNumber =
    chapterPageStart !== undefined && chapterPageEnd !== undefined && options.pageIndex >= chapterPageStart
      ? Math.min(Math.max(options.pageIndex - chapterPageStart + 1, 1), chapterPageCount ?? 1)
      : undefined;
  const futureChapterPageBriefs = briefPages
    .filter((page) => page.pageIndex > options.pageIndex)
    .map(compactPageBriefForScope);
  const previousChapterPageBriefs = briefPages
    .filter((page) => page.pageIndex < options.pageIndex)
    .map(compactPageBriefForScope);

  return {
    globalPageIndex: options.pageIndex,
    totalBookPages: options.input.targetPages,
    chapterIndex: options.chapter?.index ?? options.pageBrief?.chapterIndex ?? options.chapterBrief?.chapterIndex,
    chapterTitle: options.chapter?.title ?? options.chapterBrief?.title,
    chapterPageStart,
    chapterPageEnd,
    chapterPageNumber,
    chapterPageCount,
    isFirstPageOfChapter: chapterPageStart !== undefined ? options.pageIndex === chapterPageStart : undefined,
    isLastPageOfChapter: chapterPageEnd !== undefined ? options.pageIndex === chapterPageEnd : undefined,
    currentPageBriefIsAuthoritative: true,
    previousChapterPageBriefs,
    futureChapterPageBriefs,
    instruction:
      "Judge and write only the beat assigned to pageBrief for this global page. Future chapter page briefs are reserved for later pages."
  };
}

function compactPageBriefForScope(page: PageProductionBeat) {
  return {
    pageIndex: page.pageIndex,
    chapterIndex: page.chapterIndex,
    purpose: page.purpose,
    beat: page.beat,
    endingPressure: page.endingPressure
  };
}

/**
 * The chapter brief as serialized next to a `pageScope` payload: everything
 * but its `pages` array. pageScope already carries those beats windowed
 * around the current page (compact previous/future plus the authoritative
 * pageBrief), so sending the full array again put every chapter beat in the
 * prompt twice — re-serialized on every candidate of the quality loop.
 * Callers without a pageScope (whole-chapter drafts) keep the full brief.
 */
export function chapterBriefPayloadForPageScope(brief: ChapterBrief | undefined) {
  if (!brief) {
    return undefined;
  }
  const { pages: _pages, ...rest } = brief;
  return rest;
}

export function compactPriorPages(pages: PriorPageContext[], count: number, excerptLength: number) {
  return compactPageContexts(pages.slice(-count), excerptLength);
}

/**
 * The forward twin of {@link compactPriorPages}, and it must take the pages
 * from the *front*.
 *
 * The nearest prior page is the last one; the nearest following page is the
 * first. Trimming a forward window with `slice(-count)` keeps the pages
 * furthest from the hand-off and drops the one the draft actually has to land
 * into — which reads as a plausible window and is exactly wrong.
 */
export function compactFollowingPages(pages: PriorPageContext[], count: number, excerptLength: number) {
  return compactPageContexts(pages.slice(0, count), excerptLength);
}

function compactPageContexts(pages: PriorPageContext[], excerptLength: number) {
  return pages.map((page) => ({
    index: page.index,
    title: page.title,
    summary: page.summary,
    excerpt: page.markdown.slice(0, excerptLength)
  }));
}

/** Accepted pages 1 and 2 are the style lock, independent of recency-window order. */
export const STYLE_LOCK_PAGE_INDEXES = [1, 2] as const;

export function missingStyleLockIndexes(
  recencyPages: readonly { index: number }[],
  currentPageIndex: number
): number[] {
  const present = new Set(recencyPages.map((page) => page.index));
  return STYLE_LOCK_PAGE_INDEXES.filter((index) => index < currentPageIndex && !present.has(index));
}

/** Recency window plus any loaded style-lock pages, for `pinStyleExcerpts` only. */
export function pagesForStyleExcerpts(
  recencyPages: PriorPageContext[],
  styleLockPages: PriorPageContext[]
): PriorPageContext[] {
  if (styleLockPages.length === 0) {
    return recencyPages;
  }
  const present = new Set(recencyPages.map((page) => page.index));
  const lockIndexes = new Set<number>(STYLE_LOCK_PAGE_INDEXES);
  const extra = styleLockPages.filter((page) => lockIndexes.has(page.index) && !present.has(page.index));
  return extra.length > 0 ? [...extra, ...recencyPages] : recencyPages;
}

export function pinStyleExcerpts(
  pages: PriorPageContext[],
  sampleExcerpts: string[] = [],
  excerptLength = 400
): string[] {
  const seen = new Set<number>();
  const fromPages = [...pages]
    .sort((left, right) => left.index - right.index)
    .filter((page) => {
      if (seen.has(page.index) || page.markdown.trim().length <= 40) {
        return false;
      }
      seen.add(page.index);
      return true;
    })
    .slice(0, 2)
    .map((page) => page.markdown.slice(0, excerptLength).trim())
    .filter(Boolean);
  if (fromPages.length >= 2) {
    return fromPages;
  }
  const fromImport = sampleExcerpts.map((excerpt) => excerpt.trim()).filter(Boolean).slice(0, 2 - fromPages.length);
  return [...fromPages, ...fromImport].slice(0, 2);
}

export function sampleExcerptsFromInput(input: CreateProjectInput): string[] {
  const mobile = mediaSettingsMobileRecord(input.mediaSettings);
  const profile = jsonRecord(jsonRecord(mobile.import).styleProfile);
  return Array.isArray(profile.sampleExcerpts)
    ? profile.sampleExcerpts.filter((excerpt): excerpt is string => typeof excerpt === "string" && excerpt.trim().length > 0)
    : [];
}

/**
 * What a page prompt needs to know to talk about the book's opening: the book,
 * the plan that may have committed to a hook, and which page is being written.
 * Every option type in the drafting and review layers already satisfies it —
 * `GeneratePageOptions`, `PolishPageOptions`, `ReviewPageOptions` and
 * `RevisePageOptions` — so a prompt passes its own `options` straight through.
 */
export type PageInstructionSource = OpeningContractSource & {
  pageIndex: number;
};

/** Spread into a prompt payload; empty on every page that is not shown a hook. */
export type OpeningHookPayload = { openingHook?: string };

export type PageInstructionFields = {
  /** The instruction line, under whatever key this prompt names it. */
  text: string;
  /** The `openingHook` key that line owes the model, spread beside it. */
  payload: OpeningHookPayload;
};

/**
 * The one predicate every opening-hook decision in the pipeline is built on:
 * *does what this call writes include global page 1*.
 *
 * It is a range and not an index because most callers write or brief several
 * pages at once, and because the range is the only honest form of the question.
 * A chapter-scoped call asks it of the absolute page range it was handed rather
 * than of its chapter index, since a leading chapter that ended up with no pages
 * hands page 1 to the next one. A single-page prompt asks the degenerate
 * one-page form.
 */
export function writesFirstPage(pageStart: number, pageEnd: number): boolean {
  return pageStart <= 1 && pageEnd >= 1;
}

/**
 * The hook this call is responsible for showing the model: the plan's
 * commitment when this call writes page 1, and nothing otherwise.
 *
 * Every prompt that *names* `openingHook` owes the model the key beside it, or
 * the page is told to deliver a hook it was never shown — so nothing reads
 * `plan.openingHook` beside a first-page test of its own. The two audiences wrap
 * this with their own rule text and never with each other's: the page prompts
 * with {@link openingContractFields} (deliver, or judge the delivery of, the
 * hook in page 1's prose) and the page-map producers with
 * `firstPageBriefFieldsForRange` (`pageBriefContract.ts`, assign the hook inside
 * page 1's brief).
 *
 * **This is the plan's answer, not the contract's**, which is why it is private:
 * both audiences reach it only through {@link openingContractForRange}, the one
 * place the imported-manuscript exemption is applied to it. Exported, it was a
 * hook reader with no gate on it, and the brief producers took it — so a
 * `book_replan` on an import (whose plan carries a hook a model invented after
 * the fact) briefed page 1 to deliver one its writer prompt was no longer told
 * to carry. See the exemption's reasoning on {@link OpeningContract}.
 *
 * An empty hook is no hook — a plan stores its hook trimmed, and every consumer
 * of this gates on truthiness rather than on presence.
 */
function openingHookForRange(plan: BookPlan, pageStart: number, pageEnd: number): string | undefined {
  return writesFirstPage(pageStart, pageEnd) && plan.openingHook ? plan.openingHook : undefined;
}

/**
 * The book an opening contract is read from: the plan that may have committed
 * to a hook, and the `input` whose provenance decides the exemption. Every
 * multi-page writer's options already satisfy it and pass themselves straight
 * through, the way `PageBriefBookScope` (`pageBriefContract.ts`) takes one.
 */
export type OpeningContractSource = {
  input: CreateProjectInput;
  plan: BookPlan;
};

/**
 * **What one call owes the book's first page — decided in one place, for every
 * prompt that says anything about it.**
 *
 * The contract has two halves — one gated on the book's provenance, one on that
 * provenance *and* the plan — and **an imported manuscript is exempt from
 * both**:
 *
 *   - the **opening-quality** half (never open on throat-clearing; open the way
 *     this category opens) is what the exemption was first written for. Page 1
 *     of an import is the author's own first sentence, and every one of these
 *     rules is a licence to rewrite it — `runLocalPageQualityChecks`
 *     (`pagesLocalQa.ts`) is the deterministic twin that gate was first spelled
 *     in, and this is the same gate reaching the prompts;
 *   - the **hook-delivery** half (deliver `plan.openingHook` in page 1's own
 *     prose) is gated on the plan having committed to a hook **and on the same
 *     provenance**, because an import's plan is not a commitment its book was
 *     written to. `synthesizeImportedBookPlan` (`ingestion/manuscriptImport.ts`)
 *     builds an import's plan out of the finished manuscript and sets no
 *     `openingHook` at all; one appears only once that plan is *revised*, and
 *     `revisePlanningPackage`'s "preserve or improve openingHook" line
 *     (`planner.ts`) is unconditional. So an import's hook is a sentence a model
 *     invented for a book that already existed, from a premise field, having
 *     never seen page 1.
 *
 * Fusing the two is what round one found: the multi-page writers' whole
 * first-page instruction was a single sentence that named the hook *and* stated
 * the ban, so a plan with no hook — every MOCK_AI run, every plan stored before
 * the field existed, `makeFallbackPlan` itself — drafted page 1 with no ban at
 * all, and the reviewer then failed it and paid for a revision. Round two found
 * the reviewer stating the ban on every page of every book, page 7 included.
 * Round three found `buildPageInstruction` stating it with no import check,
 * feeding the reviser and the polisher an instruction to rewrite the author's
 * opening on any page-1 failure with an unrelated cause.
 *
 * Round four found local QA excusing categories the writer prompt banned
 * outright. The unification those rounds produced then wrote the exemption down
 * as covering the ban alone, on the grounds that "a repair's replacement page is
 * generated prose" — and round five found that justification true of the *brief*
 * producers, which assign work for prose about to be written, and false of every
 * prompt this contract feeds: `revisePageDraft` and `polishPageDraft`
 * rewrite the page they are handed, in place, and `rewritePageForUserRequest`
 * (`apps/worker/src/handlers/replanBook.ts`) routes a reader's "make page 1
 * sharper" through that same `revisePageDraft`. On an import's page 1 all three
 * therefore carried "deliver the plan's openingHook in the page's own prose" —
 * an instruction to rewrite the author's opening into a stranger's idea of it,
 * arriving through the half the exemption did not cover, after a QA failure with
 * some entirely unrelated cause. Hence the second half of the gate.
 *
 * **Which page is the author's is not a question that can be asked.** `Page`
 * carries no provenance column, so `isImportedManuscript` reads the *project's*
 * mediaSettings and both halves can only ever be book-level. That over-applies
 * in one direction — `resolveStructuralEdit` (`pageRestructure.ts`) accepts
 * `anchorPageIndex: 0`, so pages inserted at the head of an imported book are
 * pipeline prose sitting at global index 1 — and it is the right trade for both
 * halves at once: the hook such a page would be told to deliver is the invented
 * one, and it is the page that has to hand off to the author's original opening
 * on the very next page. Hook without ban is also the worst of the four
 * combinations, round one in mirror image — a page told to make its opening
 * striking with none of the rules that say what a striking opening is.
 *
 * Each round is one prompt disagreeing with the others about one of these three
 * booleans, so the booleans are answered here and the sentences are chosen from
 * {@link OPENING_CONTRACT_RULES} by audience. A prompt cannot state the ban
 * without being gated on the exemption, or name the hook without sending it,
 * because it does not build either one for itself — and the reviewer reads the
 * same contract as the writer, so it can no longer be asked to judge whether
 * page 1 delivered a hook the author never wrote, a rejection whose only repair
 * is a model rewrite of exactly the page the exemption protects.
 */
export type OpeningContract = {
  /** Whether what this call writes, judges or briefs includes global page 1. */
  writesFirstPage: boolean;
  /**
   * Whether page 1's prose may be held to the opening-quality rules — false
   * for every call that does not reach page 1, and for every page of an
   * imported manuscript.
   */
  statesOpeningQuality: boolean;
  /**
   * The plan's commitment to how the book opens, when this call reaches page 1
   * of a book the pipeline wrote — `undefined` for an import, whose plan
   * describes a manuscript it did not commission.
   */
  openingHook: string | undefined;
  /** The `openingHook` key every rule naming it owes the model. */
  payload: OpeningHookPayload;
};

export function openingContractForRange(
  source: OpeningContractSource,
  pageStart: number,
  pageEnd: number
): OpeningContract {
  const reachesFirstPage = writesFirstPage(pageStart, pageEnd);
  // One fact, both halves. `statesOpeningQuality` is the exemption as it has
  // always read; the hook is the plan's answer *less that same exemption*,
  // rather than a second predicate spelled beside it — which is what the brief
  // producers' `openingHookForRange` still returns, and why nothing here calls
  // `isImportedManuscript` twice.
  const speaksForThisBooksOpening = reachesFirstPage && !isImportedManuscript(source.input.mediaSettings);
  const openingHook = speaksForThisBooksOpening ? openingHookForRange(source.plan, pageStart, pageEnd) : undefined;
  return {
    writesFirstPage: reachesFirstPage,
    statesOpeningQuality: speaksForThisBooksOpening,
    openingHook,
    payload: openingHook ? { openingHook } : {}
  };
}

/**
 * The word every audience's opening-quality sentence is built around, and the
 * only handle anything outside this module has on "does this prompt state the
 * ban".
 *
 * The three sentences below cannot be one string — a prompt writing forty pages
 * has to say *which* page it means, a prompt writing one says "this page", and
 * the reviewer is told what to reject rather than what to write — so the shared
 * thing is a token they all interpolate. `pagesShared.test.ts` sweeps every
 * prompt in the pipeline for it and checks that the set stating it is exactly
 * the set the exemption silences — the comparison all three rounds would have
 * failed. A fourth audience that phrases the ban in its own words rather than
 * quoting this is invisible to that sweep, so quote it.
 */
export const OPENING_QUALITY_RULE_MARKER = "throat-clearing";

/**
 * Who is being told, and therefore in whose voice. Exhaustive by type: a new
 * prompt that says anything about page 1 has to name itself here, and naming
 * itself is what gets it both halves of the contract and the exemption with
 * them.
 */
export type OpeningContractAudience = "multiPageWriter" | "pageWriter" | "reviewer";

type OpeningContractRules = {
  /** The ban, in this audience's voice. */
  quality: string;
  /**
   * Whether this audience also hears how its *category* opens. The writers do —
   * they choose the opening, and "open inside a scene already in motion" is the
   * only concession the ban makes. The reviewer does not: it judges the page it
   * was handed, and a category recipe in a rejection prompt invites it to reject
   * a legitimate opening for being the wrong shape.
   */
  statesCategoryOpening: boolean;
  /** The hook sentence, and the only line in either half that names the payload key. */
  hook: string;
};

const OPENING_CONTRACT_RULES: Record<OpeningContractAudience, OpeningContractRules> = {
  multiPageWriter: {
    quality: `Global page 1 opens the book and is the reader's first impression: it must never begin with ${OPENING_QUALITY_RULE_MARKER}, a welcome, a definition of the topic, or meta framing such as 'In this book'.`,
    statesCategoryOpening: true,
    hook: "openingHook is the plan's commitment to how it opens, so global page 1 must deliver it in its own prose without echoing its wording."
  },
  pageWriter: {
    quality: `This is the book's first page and the reader's first impression: hook the reader by the end of the first paragraph, and never open with ${OPENING_QUALITY_RULE_MARKER}, a welcome, a definition of the topic, or meta framing such as 'In this book' or 'This story is about'.`,
    statesCategoryOpening: true,
    hook: "The plan's openingHook names how this book opens; deliver it in the page's own prose without echoing its wording."
  },
  reviewer: {
    quality: `For the book's first page, reject ${OPENING_QUALITY_RULE_MARKER} or meta openings ('In this book...', 'Welcome to...', 'Have you ever wondered...'), generic scene-setting that delays the subject, and a first paragraph that gives the reader no concrete reason to keep reading.`,
    statesCategoryOpening: false,
    // The payload carries openingHook, and for a round nothing here named it:
    // an unlabelled field beside pageBrief reads as "the page must match this",
    // which is the opposite of what the writer was told — deliver the hook
    // "without echoing its wording" — so a page that transformed it correctly
    // could be rejected for not reproducing it.
    hook: "openingHook is the plan's commitment to how this book opens: judge whether the first page delivers that opening in its own prose, and never require it to reproduce, quote, or echo the hook's wording, which the page writer is instructed not to do."
  }
};

export type OpeningContractFields = {
  /** The rule lines to state; empty whenever this call owes page 1 nothing. */
  rules: string[];
  /** The `openingHook` key those lines name, spread into the same prompt's payload. */
  payload: OpeningHookPayload;
};

/**
 * The contract as one prompt states it — the rule lines **and** the payload key
 * one of them names, from one call.
 *
 * The `{ rules, payload }` shape is `buildPageInstruction`'s, and it is here for
 * the same reason: spreading the payload beside the lines is the only way to use
 * either, so a prompt cannot ship the sentence without the key. What this adds
 * is the other direction — both lines are chosen by
 * {@link openingContractForRange}, so a prompt cannot ship either half of the
 * contract without the exemption that silences it.
 */
export function openingContractFields(
  source: OpeningContractSource,
  audience: OpeningContractAudience,
  pageStart: number,
  pageEnd: number
): OpeningContractFields {
  const contract = openingContractForRange(source, pageStart, pageEnd);
  const rules = OPENING_CONTRACT_RULES[audience];
  return {
    rules: [
      ...(contract.statesOpeningQuality
        ? [rules.quality, ...(rules.statesCategoryOpening ? [firstPageOpeningRule(source.input.category)] : [])]
        : []),
      ...(contract.openingHook ? [rules.hook] : [])
    ],
    payload: contract.payload
  };
}

/** The degenerate one-page form, for a prompt that writes or judges one page. */
export function openingContractFieldsForPage(
  source: PageInstructionSource,
  audience: OpeningContractAudience
): OpeningContractFields {
  return openingContractFields(source, audience, source.pageIndex, source.pageIndex);
}

/**
 * The per-page writing instruction **and** the payload key it owes, from one
 * call.
 *
 * The first-page lines name a payload field, so a prompt carrying this sentence
 * has to send the field too, or the page is told to deliver a hook it was never
 * shown. That used to be a condition each prompt spelled for itself beside its
 * own `buildPageInstruction(…, plan.openingHook)` call — five copies of one
 * predicate across the four single-page prompts, two of which shipped a round
 * without the key. Returning both halves together is what makes the next prompt
 * site unable to get it half right: spreading `payload` beside `text` is the
 * only way to use the instruction at all.
 *
 * The first-page lines themselves are {@link openingContractFields}', not this
 * function's. Owning them here is what shipped an import's page-1 reviser and
 * polisher an explicit instruction to rewrite the author's opening, on a page
 * that had failed QA for repetition or a prompt leak.
 */
export function buildPageInstruction(source: PageInstructionSource): PageInstructionFields {
  const { input, pageIndex } = source;
  const opening = openingContractFieldsForPage(source, "pageWriter");
  const base = [
    "Write exactly this page, not a description of the page.",
    "Use a clean title without a Page N prefix.",
    "Treat the title as internal metadata only; the markdown should begin with book prose, not a page title or heading.",
    GROUNDED_FACTUALITY_RULE,
    "Advance beyond recentPages and alreadyCovered; do not restate their scene, decision, exposition, or emotional beat.",
    'Treat pageBrief and endingPressure as internal notes; do not echo phrases like "concluding the survey" or announce a transition to another chapter.',
    "The page summary must name the new beat or changed consequence introduced on this page.",
    ...opening.rules
  ];
  if (pageIndex === input.targetPages) {
    base.push(
      "This is the final page: resolve the book's central promise with a concrete consequence, completed choice, or settled question instead of a vague closing image."
    );
  }
  return { text: base.join(" "), payload: opening.payload };
}

function firstPageOpeningRule(category: string | undefined): string {
  if (category === "STORY") {
    return "Open inside a concrete scene already in motion: a specific character, place, and pressure in the first lines, not backstory or panoramic scene-setting.";
  }
  if (category === "KIDS") {
    return "Open with a named character doing something a child can picture immediately; keep the first lines simple, warm, and read-aloud friendly for the target age band.";
  }
  if (isSignpostingBookCategory(category)) {
    return "Open with a concrete claim, surprising specific, or real mini-case the reader can test; you may signpost later on the page, never in the first paragraph.";
  }
  return "Open with a striking specific - a scene, fact, or grounded question - not a generalization like 'Throughout history' or 'Since the dawn of time'.";
}

// ---------------------------------------------------------------------------
// Tolerant readers for model-shaped JSON, shared by the draft and page-map
// normalizers.
// ---------------------------------------------------------------------------

export function unwrapModelObject(value: unknown, keys: string[]): unknown {
  if (!isRecord(value)) {
    return value;
  }
  for (const key of keys) {
    const candidate = value[key];
    if (isRecord(candidate)) {
      return candidate;
    }
  }
  return value;
}

export function arrayLikeField(record: Record<string, unknown>, key: string): unknown[] | undefined {
  const value = record[key];
  if (Array.isArray(value)) {
    return value;
  }
  if (!isRecord(value)) {
    return undefined;
  }
  for (const nestedKey of ["items", "list", "pages", "pageBeats", "page_beats", "beats"]) {
    const nested = value[nestedKey];
    if (Array.isArray(nested)) {
      return nested;
    }
  }
  const entries = Object.entries(value);
  if (entries.length > 0 && entries.every(([entryKey]) => /^\d+$/.test(entryKey))) {
    return entries.sort(([first], [second]) => Number(first) - Number(second)).map(([, item]) => item);
  }
  return undefined;
}

// The predicate itself lives in `schemas/jsonCoercion.ts`; this module carried a
// second copy of it. Re-exported so the drafting and page-map layers keep
// reading it off the helper bundle they already import.
export { isRecord };

export function numberField(record: Record<string, unknown>, keys: string[]): number | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "number") {
      return value;
    }
    if (typeof value === "string" && /^\d+$/.test(value.trim())) {
      return Number(value.trim());
    }
  }
  return undefined;
}

export function stringField(record: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) {
      return value;
    }
  }
  return undefined;
}

export function stringArrayField(record: Record<string, unknown>, keys: string[]): string[] | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) {
      return [value];
    }
    if (Array.isArray(value)) {
      return value.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
    }
  }
  return undefined;
}

export function objectKeys(value: unknown): string {
  return isRecord(value) ? Object.keys(value).join(", ") || "(none)" : "(not an object)";
}
