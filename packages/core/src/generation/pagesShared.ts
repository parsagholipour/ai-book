import type { TextModelAdapter } from "../adapters/types.js";
import {
  kidsReadingGuidanceLines,
  kidsReadingGuidancePayload
} from "../prompting/readingLevel.js";
import { plannerToneGuidance, reviewerStyleGuidance, toneProfileFromMediaSettings, writerToneGuidance } from "../prompting/tone.js";
import type { BookPlan, ChapterBrief, ChapterPlan, CreateProjectInput, PageProductionBeat } from "../schemas/book.js";
import { jsonRecord, mediaSettingsMobileRecord } from "../schemas/jsonCoercion.js";
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
  continuityNotes: string[];
  researchNotes: string[];
  /** Semantically retrieved long-range context outside the recency window. */
  semanticMemory?: string[] | undefined;
  /** Structured character/location state lines. */
  entityState?: string[] | undefined;
  /** Pinned accepted-page excerpts, separate from recency. */
  styleExcerpts?: string[] | undefined;
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
  return pages.slice(-count).map((page) => ({
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

export function range(start: number, end: number): number[] {
  return Array.from({ length: end - start + 1 }, (_, index) => start + index);
}

export function buildPageInstruction(pageIndex: number, targetPages: number): string {
  const base = [
    "Write exactly this page, not a description of the page.",
    "Use a clean title without a Page N prefix.",
    "Treat the title as internal metadata only; the markdown should begin with book prose, not a page title or heading.",
    GROUNDED_FACTUALITY_RULE,
    "Advance beyond recentPages and alreadyCovered; do not restate their scene, decision, exposition, or emotional beat.",
    'Treat pageBrief and endingPressure as internal notes; do not echo phrases like "concluding the survey" or announce a transition to another chapter.',
    "The page summary must name the new beat or changed consequence introduced on this page."
  ];
  if (pageIndex === targetPages) {
    base.push(
      "This is the final page: resolve the book's central promise with a concrete consequence, completed choice, or settled question instead of a vague closing image."
    );
  }
  return base.join(" ");
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

export function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

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
