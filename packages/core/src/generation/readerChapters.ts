import { createHash } from "node:crypto";
import { z } from "zod";
import type { TextModelAdapter } from "../adapters/types.js";
import { targetLanguageGenerationGuidance, targetLanguagePayload } from "../prompting/language.js";
import type { BookPlan, CreateProjectInput } from "../schemas/book.js";
import { isRecord } from "../schemas/jsonCoercion.js";
import { generateJsonWithRetry } from "./generateJsonWithRetry.js";
import type { MarkdownPage, ReaderChapter } from "./markdown.js";

const MIN_READER_CHAPTER_PAGES = 8;
const MIN_READER_CHAPTER_WORDS = 1600;
const MAX_READER_CHAPTERS = 12;
const PAGE_EXCERPT_CHARS = 700;

export type CreateReaderChaptersOptions = {
  input: CreateProjectInput;
  plan: BookPlan;
  pages: MarkdownPage[];
  textModel: TextModelAdapter;
};

/**
 * Where the chapters came from, so a caller can cache the expensive answer
 * without pinning a cheap one. Only `"model"` may be cached.
 *
 * - `"model"` — the model's own usable answer. That includes the empty array a
 *   long single-arc book earns, which is a real verdict and the case most worth
 *   caching, and the empty array a short manuscript short-circuits to without
 *   asking anyone.
 * - `"rejected"` — the model answered, but not with something usable: a reply
 *   carrying no chapters array at all, or a single chapter when the prompt asks
 *   for two to twelve or none. The book still gets `[]`, which is what it always
 *   got, but the next compile must be free to ask again. `schema: z.unknown()`
 *   below is why this matters: any JSON satisfies it, so a misshaped reply is
 *   never retried by `generateJsonWithRetry` and would otherwise be pinned as
 *   "this book has no chapters" for as long as its text is unchanged.
 * - `"fallback"` — the call itself failed, or its boundaries were rejected, and
 *   the deterministic grouping stood in. Caching that would freeze one transient
 *   outage into this manuscript forever.
 */
export type ReaderChapterSource = "model" | "rejected" | "fallback";

export type ReaderChapterResult = {
  chapters: ReaderChapter[];
  source: ReaderChapterSource;
};

/**
 * Identifies the inputs this chapterization was computed from — exactly the
 * fields the prompt below reads, so a cached result is reusable precisely when
 * nothing the model saw has changed.
 *
 * The page markdown goes in whole rather than as the 700-character excerpt the
 * prompt sends: a false miss costs one call, which is what every compile pays
 * today, while a false hit would print stale chapter boundaries over rewritten
 * prose.
 */
export function readerChapterFingerprint(options: {
  input: CreateProjectInput;
  plan: BookPlan;
  pages: MarkdownPage[];
}): string {
  const pages = normalizePages(options.pages);
  const payload = JSON.stringify({
    plan: {
      title: options.plan.title,
      premise: options.plan.premise,
      audience: options.plan.audience
    },
    input: {
      targetPages: options.input.targetPages,
      category: options.input.category,
      subcategory: options.input.subcategory ?? null,
      language: options.input.language,
      temperature: options.input.temperature
    },
    pages: pages.map((page) => [page.index, page.title, page.summary ?? "", page.markdown])
  });
  return createHash("sha256").update(payload).digest("hex");
}

export async function createReaderChaptersForExport(
  options: CreateReaderChaptersOptions
): Promise<ReaderChapterResult> {
  const pages = normalizePages(options.pages);
  if (!shouldAttemptReaderChapterization(pages)) {
    return { chapters: [], source: "model" };
  }

  try {
    const result = await generateJsonWithRetry(options.textModel, {
      purpose: "chapterize-export",
      temperature: Math.min(0.25, options.input.temperature),
      maxTokens: 2200,
      schema: z.unknown(),
      messages: [
        {
          role: "system",
          content: [
            "You are the final chapterization editor for a finished manuscript.",
            "You may add reader-facing chapter boundaries, but you must not rewrite page prose.",
            "Return one JSON object with a chapters array.",
            "If the manuscript is short or reads as one uninterrupted arc, return an empty chapters array.",
            "If chapters help the reader, create 2 to 12 real chapters.",
            "Every chapter must span contiguous existing page indexes.",
            "The returned chapters must cover every page exactly once from the first page through the last page.",
            "Never create one chapter per page.",
            "Where possible, each chapter must span multiple pages.",
            "Use concise human chapter titles based only on the manuscript pages, without Page N prefixes.",
            ...targetLanguageGenerationGuidance(options.input.language)
          ].join(" ")
        },
        {
          role: "user",
          content: JSON.stringify(
            {
              language: targetLanguagePayload(options.input.language),
              book: {
                title: options.plan.title,
                premise: options.plan.premise,
                audience: options.plan.audience,
                targetPages: options.input.targetPages,
                category: options.input.category,
                subcategory: options.input.subcategory
              },
              chapterCountGuide: {
                suggested: suggestedReaderChapterCount(pages),
                maximum: maxReaderChapterCount(pages.length)
              },
              pages: pages.map((page) => ({
                index: page.index,
                title: page.title,
                summary: page.summary,
                excerpt: plainText(page.markdown).slice(0, PAGE_EXCERPT_CHARS)
              })),
              instruction:
                "Return {\"chapters\":[{\"index\":1,\"title\":\"...\",\"summary\":\"...\",\"startPageIndex\":1,\"endPageIndex\":3}, ...]} or {\"chapters\":[]}."
            },
            null,
            2
          )
        }
      ]
    });

    return normalizeReaderChapters(result.data, pages);
  } catch {
    return { chapters: createDeterministicReaderChapters(pages), source: "fallback" };
  }
}

/** The chapters a model reply yields, and whether the reply was usable as given. */
export function normalizeReaderChaptersFromModel(raw: unknown, pagesInput: MarkdownPage[]): ReaderChapter[] {
  return normalizeReaderChapters(raw, pagesInput).chapters;
}

function normalizeReaderChapters(raw: unknown, pagesInput: MarkdownPage[]): ReaderChapterResult {
  const pages = normalizePages(pagesInput);
  if (!shouldAttemptReaderChapterization(pages)) {
    return { chapters: [], source: "model" };
  }

  const rawChapters = extractChapterArray(raw);
  if (!rawChapters) {
    // No chapters array anywhere in the reply. That is a miss, not a verdict.
    return { chapters: [], source: "rejected" };
  }
  if (rawChapters.length === 0) {
    // "This manuscript reads as one arc" — what the prompt asks for, and a real
    // answer to keep.
    return { chapters: [], source: "model" };
  }
  if (rawChapters.length === 1) {
    // Off-spec: the prompt asks for two to twelve, or none. One chapter helps
    // no reader, so the book gets `[]` — but the next compile may ask again.
    return { chapters: [], source: "rejected" };
  }

  const pageCount = pages.length;
  const maxChapters = maxReaderChapterCount(pageCount);
  if (rawChapters.length > maxChapters) {
    throw new Error(`Reader chapterization returned too many chapters: ${rawChapters.length}.`);
  }

  const pageIndexes = new Set(pages.map((page) => page.index));
  const firstPage = pages[0];
  const lastPage = pages[pages.length - 1];
  if (!firstPage || !lastPage) {
    return { chapters: [], source: "rejected" };
  }

  const chapters = rawChapters.map((rawChapter, index) => {
    if (!isRecord(rawChapter)) {
      throw new Error(`Reader chapter ${index + 1} is not an object.`);
    }

    const pageRange = isRecord(rawChapter.pageRange) ? rawChapter.pageRange : undefined;
    const startPageIndex =
      numberField(rawChapter, ["startPageIndex", "startPage", "pageStart", "firstPage", "from"]) ??
      (pageRange ? numberField(pageRange, ["start", "from", "firstPage", "startPageIndex"]) : undefined);
    const endPageIndex =
      numberField(rawChapter, ["endPageIndex", "endPage", "pageEnd", "lastPage", "to"]) ??
      (pageRange ? numberField(pageRange, ["end", "to", "lastPage", "endPageIndex"]) : undefined);

    if (!startPageIndex || !endPageIndex) {
      throw new Error(`Reader chapter ${index + 1} is missing page boundaries.`);
    }
    if (startPageIndex > endPageIndex) {
      throw new Error(`Reader chapter ${index + 1} has reversed page boundaries.`);
    }
    if (!pageIndexes.has(startPageIndex) || !pageIndexes.has(endPageIndex)) {
      throw new Error(`Reader chapter ${index + 1} references pages outside the manuscript.`);
    }

    const rangePages = pages.filter((page) => page.index >= startPageIndex && page.index <= endPageIndex);
    const title = sanitizeReaderChapterTitle(
      stringField(rawChapter, ["title", "chapterTitle", "heading", "name"]) ?? "",
      index + 1,
      rangePages
    );
    const summary = sanitizeReaderChapterSummary(
      stringField(rawChapter, ["summary", "description", "synopsis"]) ?? "",
      rangePages
    );

    return {
      index: index + 1,
      title,
      summary,
      startPageIndex,
      endPageIndex
    };
  });

  const ordered = [...chapters].sort((a, b) => a.startPageIndex - b.startPageIndex);
  let expectedStart = firstPage.index;
  for (const chapter of ordered) {
    if (chapter.startPageIndex !== expectedStart) {
      throw new Error("Reader chapters must cover every manuscript page contiguously.");
    }
    expectedStart = chapter.endPageIndex + 1;
  }
  if (expectedStart !== lastPage.index + 1) {
    throw new Error("Reader chapters must end on the final manuscript page.");
  }

  if (looksLikePageLevelReaderChapters(ordered, pageCount)) {
    throw new Error("Reader chapterization returned page-level chapters.");
  }

  return {
    chapters: ordered.map((chapter, index) => ({
      ...chapter,
      index: index + 1
    })),
    source: "model"
  };
}

export function createDeterministicReaderChapters(pagesInput: MarkdownPage[]): ReaderChapter[] {
  const pages = normalizePages(pagesInput);
  if (!shouldAttemptReaderChapterization(pages)) {
    return [];
  }

  const chapterCount = suggestedReaderChapterCount(pages);
  if (chapterCount < 2) {
    return [];
  }

  const chapters: ReaderChapter[] = [];
  let offset = 0;
  for (let index = 0; index < chapterCount; index += 1) {
    const remainingPages = pages.length - offset;
    const remainingChapters = chapterCount - index;
    const groupSize = Math.max(1, Math.floor(remainingPages / remainingChapters));
    const group = pages.slice(offset, offset + groupSize);
    const firstPage = group[0];
    const lastPage = group[group.length - 1];
    if (!firstPage || !lastPage) {
      break;
    }
    chapters.push({
      index: index + 1,
      title: sanitizeReaderChapterTitle("", index + 1, group),
      summary: sanitizeReaderChapterSummary("", group),
      startPageIndex: firstPage.index,
      endPageIndex: lastPage.index
    });
    offset += groupSize;
  }

  return chapters;
}

function shouldAttemptReaderChapterization(pages: MarkdownPage[]): boolean {
  if (pages.length < MIN_READER_CHAPTER_PAGES) {
    return false;
  }
  const totalWords = pages.reduce((sum, page) => sum + wordCount(page.markdown), 0);
  return totalWords >= MIN_READER_CHAPTER_WORDS || pages.length >= 12;
}

function suggestedReaderChapterCount(pages: MarkdownPage[]): number {
  const pageCount = pages.length;
  const maximum = maxReaderChapterCount(pageCount);
  if (maximum < 2) {
    return 0;
  }
  return Math.max(2, Math.min(maximum, Math.round(Math.sqrt(pageCount))));
}

function maxReaderChapterCount(pageCount: number): number {
  return Math.max(0, Math.min(MAX_READER_CHAPTERS, Math.floor(pageCount / 2)));
}

function looksLikePageLevelReaderChapters(chapters: ReaderChapter[], pageCount: number): boolean {
  if (chapters.length <= 1) {
    return false;
  }
  const spans = chapters.map((chapter) => chapter.endPageIndex - chapter.startPageIndex + 1);
  const onePageSpans = spans.filter((span) => span <= 1).length;
  return chapters.length >= pageCount || onePageSpans / chapters.length >= 0.7;
}

function normalizePages(pages: MarkdownPage[]): MarkdownPage[] {
  return [...pages]
    .filter((page) => Number.isInteger(page.index) && page.index > 0 && page.markdown.trim().length > 0)
    .sort((a, b) => a.index - b.index);
}

/**
 * The chapters array a reply carries, or `undefined` when it carries none.
 *
 * The distinction is the whole point: an *empty* array is the model saying this
 * manuscript is one arc, while no array at all is a reply we could not read.
 * Collapsing both to `[]` made the second one look like the first, and the cache
 * then kept it.
 */
function extractChapterArray(raw: unknown): unknown[] | undefined {
  if (Array.isArray(raw)) {
    return raw;
  }
  if (!isRecord(raw)) {
    return undefined;
  }
  for (const key of ["chapters", "readerChapters", "reader_chapters", "sections", "tableOfContents"]) {
    const value = raw[key];
    if (Array.isArray(value)) {
      return value;
    }
  }
  return undefined;
}

function sanitizeReaderChapterTitle(title: string, index: number, pages: MarkdownPage[]): string {
  let clean = title
    .trim()
    .replace(/^#+\s*/, "")
    .replace(/\s+/g, " ");
  const duplicatePrefix = new RegExp(`^(?:chapter\\s+${index}\\s*[:\\-]?\\s*)+`, "i");
  while (duplicatePrefix.test(clean)) {
    clean = clean.replace(duplicatePrefix, "").trim();
  }
  clean = clean.replace(/^page\s+\d+\s*[:-]\s*/i, "").trim();
  if (!clean || /^chapter\s+\d+$/i.test(clean) || /^page\s+\d+$/i.test(clean)) {
    clean = deriveTitleFromPages(pages);
  }
  return clipAtWord(clean || `Movement ${index}`, 80);
}

function sanitizeReaderChapterSummary(summary: string, pages: MarkdownPage[]): string {
  const clean = plainText(summary).trim();
  if (clean) {
    return clipAtWord(clean, 220);
  }
  return clipAtWord(
    pages
      .map((page) => page.summary || firstSentence(plainText(page.markdown)))
      .filter(Boolean)
      .slice(0, 3)
      .join(" "),
    220
  );
}

function deriveTitleFromPages(pages: MarkdownPage[]): string {
  const candidates = pages.flatMap((page) => [
    page.title,
    firstSentence(page.summary ?? ""),
    firstSentence(plainText(page.markdown))
  ]);
  for (const candidate of candidates) {
    const clean = candidate
      .trim()
      .replace(/^#+\s*/, "")
      .replace(/^page\s+\d+\s*[:-]\s*/i, "")
      .replace(/\s+/g, " ");
    if (clean && !/^page\s+\d+$/i.test(clean)) {
      return clean;
    }
  }
  return "";
}

function firstSentence(text: string): string {
  return text.split(/[.!?]\s/)[0]?.trim() ?? "";
}

function clipAtWord(text: string, limit: number): string {
  const clean = text.trim().replace(/\s+/g, " ");
  if (clean.length <= limit) {
    return clean;
  }
  const clipped = clean.slice(0, limit);
  const lastSpace = clipped.lastIndexOf(" ");
  return `${clipped.slice(0, lastSpace > 40 ? lastSpace : limit).trim()}…`;
}

function plainText(markdown: string): string {
  return markdown
    .replace(/!\[[^\]]*]\([^)]+\)/g, "")
    .replace(/\[([^\]]+)]\([^)]+\)/g, "$1")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/[*_`>#]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function wordCount(text: string): number {
  return plainText(text).match(/[\p{L}\p{N}][\p{L}\p{N}'-]*/gu)?.length ?? 0;
}

function numberField(record: Record<string, unknown>, keys: string[]): number | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "number" && Number.isFinite(value)) {
      return Math.floor(value);
    }
    if (typeof value === "string" && /^\d+$/.test(value.trim())) {
      return Number.parseInt(value.trim(), 10);
    }
  }
  return undefined;
}

function stringField(record: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim().length > 0) {
      return value;
    }
  }
  return undefined;
}
