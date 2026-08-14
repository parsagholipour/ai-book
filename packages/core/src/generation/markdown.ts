import type { BookPlan, ChapterPlan, CreateProjectInput } from "../schemas/book.js";
import { isSourceForwardBookCategory } from "../categories.js";
import { DEFAULT_MARKDOWN_LABELS, markdownLabels, type MarkdownLabels } from "./markdownLabels.js";

// Re-exported because `markdownLabels` was always part of this module's surface
// — `epub.ts` and the exporters import it from here.
export { markdownLabels, type MarkdownLabels } from "./markdownLabels.js";

export type MarkdownPage = {
  index: number;
  title: string;
  markdown: string;
  summary?: string | undefined;
  imagePath?: string | undefined;
  imageAlt?: string | undefined;
};

export type ReaderChapter = {
  index: number;
  title: string;
  summary: string;
  startPageIndex: number;
  endPageIndex: number;
};

export type CompileMarkdownInput = {
  plan: BookPlan;
  category?: CreateProjectInput["category"] | undefined;
  language?: string | undefined;
  pages: MarkdownPage[];
  readerChapters?: ReaderChapter[] | undefined;
  cover?: {
    imagePath: string;
    imageAlt?: string | undefined;
  } | undefined;
  researchSources?: Array<{ title: string; url?: string | undefined; summary: string }>;
  /**
   * Reader preference for the Sources back matter. `false` drops the section
   * even when the category would normally print it; `true` prints it when
   * citations exist; `undefined` leaves the automatic decision in
   * {@link shouldPrintSourcesBackMatter} alone.
   */
  includeSources?: boolean | undefined;
  /**
   * Reader preference for how a chapter heading is worded. `undefined` keeps
   * the canonical `Chapter N: Title`.
   */
  chapterHeadingStyle?: ChapterHeadingStyle | undefined;
  /** Replaces the word "Chapter" — "Part", "Episode". `undefined` keeps the localized default. */
  chapterHeadingLabel?: string | undefined;
  /**
   * The byline. When the export has no cover, this gives it a fallback title
   * page carrying the title, subtitle and author. A cover already typesets the
   * same metadata, so covered books must not repeat it on a second page.
   *
   * Read it from the project row rather than a plan's frozen `inputSnapshot`:
   * that is the same source `coverMetadataFromProject` typesets the cover from,
   * and the two must never disagree.
   */
  authorName?: string | undefined;
};

/**
 * How a chapter heading is worded.
 *
 * - `label_number_title` — `Chapter 1: The Web Spins` (the default)
 * - `number_title` — `1. The Web Spins`
 * - `title_only` — `The Web Spins`
 */
export type ChapterHeadingStyle = "label_number_title" | "number_title" | "title_only";

export const CHAPTER_HEADING_STYLES: readonly ChapterHeadingStyle[] = [
  "label_number_title",
  "number_title",
  "title_only"
];

export const DEFAULT_CHAPTER_HEADING_STYLE: ChapterHeadingStyle = "label_number_title";

/**
 * How much chapter apparatus a book earns, decided by its own size rather than
 * by whether the planner happened to name its beats "chapters".
 *
 * - `chapters` — `Chapter N: Title` headings and a Contents page.
 * - `sections` — the titles alone, unnumbered, and no Contents page.
 * - `none` — neither.
 */
export type ChapterPresentation = "chapters" | "sections" | "none";

/** At or above this many pages a book can carry numbered chapters and a Contents page. */
const MIN_CHAPTERED_BOOK_PAGES = 8;

/**
 * At or below this many pages, a division per page is still a structure — a
 * leaflet's movements — rather than a page index, and keeps its titles.
 */
const MAX_SECTIONED_BOOK_PAGES = 4;

/** Below this many pages each, divisions are section breaks wearing chapters' names. */
const MIN_PAGES_PER_DIVISION = 2;

/** Longer than this stops being a label and starts being a sentence in the heading. */
export const CHAPTER_HEADING_LABEL_MAX_LENGTH = 24;

/**
 * Normalizes a custom chapter label, or returns `undefined` when it cannot be
 * used.
 *
 * "Page" is rejected outright: `assertBookLikeMarkdown` treats a
 * `## Page 1` heading as a generation artifact and throws, so accepting it here
 * would fail *every* export of that book rather than render badly. `#` and
 * newlines are rejected for the same reason one level down — they would break
 * out of the heading they are interpolated into.
 */
export function sanitizeChapterHeadingLabel(raw: unknown): string | undefined {
  if (typeof raw !== "string") {
    return undefined;
  }
  const clean = raw.replace(/\s+/g, " ").trim();
  if (!clean || clean.length > CHAPTER_HEADING_LABEL_MAX_LENGTH) {
    return undefined;
  }
  if (/[#<>[\]]/.test(clean) || /^page$/i.test(clean)) {
    return undefined;
  }
  return clean;
}

/**
 * Reads {@link CompileMarkdownInput.chapterHeadingStyle} out of a project's
 * stored `mediaSettings`. Live project preference, same rule as
 * {@link includeSourcesPreference}: read it from the project row, never from a
 * plan version's frozen `inputSnapshot`, or restyling a heading would need a
 * replan to take effect.
 */
export function chapterHeadingStylePreference(mediaSettings: unknown): ChapterHeadingStyle | undefined {
  const candidate = mediaSettingsRecord(mediaSettings).chapterHeadingStyle;
  return CHAPTER_HEADING_STYLES.find((style) => style === candidate);
}

/** The custom label, read from the same place and under the same rule. */
export function chapterHeadingLabelPreference(mediaSettings: unknown): string | undefined {
  return sanitizeChapterHeadingLabel(mediaSettingsRecord(mediaSettings).chapterHeadingLabel);
}

function mediaSettingsRecord(mediaSettings: unknown): Record<string, unknown> {
  return mediaSettings && typeof mediaSettings === "object" && !Array.isArray(mediaSettings)
    ? (mediaSettings as Record<string, unknown>)
    : {};
}

/**
 * Reads {@link CompileMarkdownInput.includeSources} out of a project's stored
 * `mediaSettings`. This is a live project preference, so read it from the
 * project row and never from a plan version's frozen `inputSnapshot` — turning
 * the Sources list off has to take effect on the next recompile, without
 * replanning.
 */
export function includeSourcesPreference(mediaSettings: unknown): boolean | undefined {
  const settings = mediaSettingsRecord(mediaSettings);
  return typeof settings.includeSources === "boolean" ? settings.includeSources : undefined;
}

export function compileBookMarkdown(input: CompileMarkdownInput): string {
  return compileBookMarkdownWithPageAnchors(input).markdown;
}

/**
 * Where each model page begins in the compiled markdown, for the PDF renderer's
 * page map. A page that opens a printed chapter is located by the `chapter-N`
 * anchor already in the markdown; every other page gets a `bp-N` name and the
 * offset of its first content character, where the renderer inserts a marker
 * into its *own copy* of the document — `markdown` itself is byte-identical to
 * what {@link compileBookMarkdown} always produced, because it is `book.md`,
 * the provenance sha and the EPUB's input.
 */
export type CompiledBookMarkdown = {
  markdown: string;
  pageAnchors: PageAnchorPlan[];
  /** Offset of the Sources heading, when the back matter is printed. */
  sourcesOffset?: number;
  /** True when the PDF opens on a furniture page — a cover or the fallback title page. */
  hasCoverPage: boolean;
  hasContents: boolean;
};

export type PageAnchorPlan = {
  pageIndex: number;
  destName: string;
  /** Absent for `chapter-*` anchors, which the markdown already carries. */
  markdownOffset?: number;
  /**
   * Where a `chapter-*` anchor's `<a id>` was written. It is the one copy of
   * that name the renderer must keep: the manuscript can hold copies of its own,
   * and only this offset tells them apart.
   */
  existingIdOffset?: number;
};

export function compileBookMarkdownWithPageAnchors(input: CompileMarkdownInput): CompiledBookMarkdown {
  const pages = [...input.pages].sort((a, b) => a.index - b.index);
  const labels = markdownLabels(input.language);
  const readerChapterStarts = readerChapterStartsForPages(input.readerChapters, pages);
  const starts = readerChapterStarts.length > 0 ? readerChapterStarts : chapterStartsForPages(input.plan, pages);
  const presentation = chapterPresentationFor(starts, pages);
  const chapterStarts = presentation === "none" ? [] : starts;
  const chapterByStartPage = new Map(chapterStarts.map((start) => [start.pageIndex, start.chapter]));
  const heading = chapterHeadingFormat(input, labels, presentation);
  const contents =
    presentation === "chapters" && chapterStarts.length > 1 ? formatContentsSection(chapterStarts, labels, heading) : "";
  const research = formatReaderFacingSources(input);
  const coverImagePath = input.cover?.imagePath;
  // The cover already carries the title, subtitle and byline. A title page is
  // only the no-cover fallback; rendering both repeats the same front matter
  // on the first two pages.
  const titlePage = coverImagePath ? "" : formatTitlePage(input, labels);

  type Element = { text: string; page?: { index: number; chapterDest?: string } | undefined; sources?: boolean };
  const elements: Element[] = [
    { text: coverImagePath ? `![${sanitizeCoverAlt(input.cover?.imageAlt, labels)}](${coverImagePath})` : "" },
    { text: titlePage },
    { text: titlePage || coverImagePath ? "" : `# ${input.plan.title}` },
    { text: !titlePage && !coverImagePath && input.plan.subtitle ? `\n_${input.plan.subtitle}_\n` : "" },
    { text: contents },
    { text: "" },
    ...pages.map((page): Element => {
      const chapter = chapterByStartPage.get(page.index);
      return {
        text: [
          chapter
            ? `${chapterAnchorMarkup(chapterAnchorId(chapter))}\n\n## ${formatChapterHeading(chapter, heading)}`
            : "",
          page.imagePath ? `\n![${sanitizeImageAlt(page.index, page.imageAlt, labels)}](${page.imagePath})\n` : "",
          sanitizePageMarkdown(page, chapter, labels, heading),
          ""
        ]
          .filter(Boolean)
          .join("\n"),
        page: { index: page.index, ...(chapter ? { chapterDest: chapterAnchorId(chapter) } : {}) }
      };
    }),
    { text: research ? `## ${labels.sources}\n` + research : "", sources: true }
  ];

  const kept = elements.filter((element) => element.text);
  const markdown = kept.map((element) => element.text).join("\n");

  const pageAnchors: PageAnchorPlan[] = [];
  let sourcesOffset: number | undefined;
  let offset = 0;
  for (const element of kept) {
    if (element.page) {
      if (element.page.chapterDest) {
        // The anchor is the first thing a chapter-opening page's block holds,
        // so the element's own offset is where its `<a id>` starts.
        pageAnchors.push({
          pageIndex: element.page.index,
          destName: element.page.chapterDest,
          existingIdOffset: offset
        });
      } else {
        // Skip the leading newline a hero-image block starts with: the anchor
        // names the first content character of the page's block.
        const lead = element.text.match(/^\n+/)?.[0]?.length ?? 0;
        pageAnchors.push({
          pageIndex: element.page.index,
          destName: `bp-${element.page.index}`,
          markdownOffset: offset + lead
        });
      }
    } else if (element.sources) {
      sourcesOffset = offset;
    }
    offset += element.text.length + 1;
  }

  assertBookLikeMarkdown(markdown);
  return {
    markdown,
    pageAnchors,
    ...(sourcesOffset !== undefined ? { sourcesOffset } : {}),
    hasCoverPage: Boolean(coverImagePath || titlePage),
    hasContents: Boolean(contents)
  };
}

export function assertBookLikeMarkdown(markdown: string): void {
  const issues = findBookLikeMarkdownIssues(markdown);
  if (issues.length > 0) {
    throw new Error(`Compiled book Markdown contains reader-facing generation artifacts: ${issues.join("; ")}`);
  }
}

export function findBookLikeMarkdownIssues(markdown: string): string[] {
  const issues: string[] = [];
  if (/^---\s*\r?\n/.test(markdown.trimStart())) {
    issues.push("frontmatter block");
  }
  if (/^generatedAt\s*:/im.test(markdown) || /\bgeneratedAt\b/i.test(markdown)) {
    issues.push("generatedAt metadata");
  }
  if (/^pages\s*:\s*\d+\s*$/im.test(markdown)) {
    issues.push("page-count metadata");
  }
  if (/^#{1,6}\s+Page\s+\d+\b/im.test(markdown)) {
    issues.push("page-number heading");
  }
  if (/^\s*-\s+\[Page\s+\d+(?::|\])/im.test(markdown)) {
    issues.push("page-number table of contents link");
  }
  if (/<div\b[^>]*class=["'][^"']*\bpage-break\b/i.test(markdown)) {
    issues.push("raw page-break markup");
  }
  if (/!\[Illustration for Page \d+\]/i.test(markdown)) {
    issues.push("page-number image alt text");
  }
  return issues;
}

export function sanitizePageTitle(index: number, title: string): string {
  let clean = title.trim().replace(/^#+\s*/, "");
  const exactPagePrefix = new RegExp(`^(?:page\\s+${index}\\s*[:\\-]\\s*)+`, "i");
  while (exactPagePrefix.test(clean)) {
    clean = clean.replace(exactPagePrefix, "").trim();
  }
  clean = clean.replace(/^page\s+\d+\s*[:-]\s*/i, "").trim();
  return clean || `Page ${index}`;
}

function chapterStartsForPages(
  plan: BookPlan,
  pages: MarkdownPage[]
): Array<{ pageIndex: number; chapter: DisplayChapter }> {
  if (pages.length === 0) {
    return [];
  }

  const pageIndexes = new Set(pages.map((page) => page.index));
  const chapters = [...plan.chapters].sort((a, b) => a.index - b.index);
  const starts: Array<{ pageIndex: number; chapter: ChapterPlan }> = [];
  let nextPageIndex = 1;

  for (const chapter of chapters) {
    if (pageIndexes.has(nextPageIndex)) {
      starts.push({ pageIndex: nextPageIndex, chapter });
    }
    nextPageIndex += Math.max(1, chapter.targetPages || 1);
  }

  const firstPage = pages[0];
  if (starts.length === 0 && firstPage && chapters[0]) {
    starts.push({ pageIndex: firstPage.index, chapter: chapters[0] });
  }

  return starts;
}

function readerChapterStartsForPages(
  readerChapters: ReaderChapter[] | undefined,
  pages: MarkdownPage[]
): Array<{ pageIndex: number; chapter: DisplayChapter }> {
  if (!readerChapters || readerChapters.length < 2 || pages.length === 0) {
    return [];
  }

  const pageIndexes = new Set(pages.map((page) => page.index));
  const chapters = readerChapters
    .filter((chapter) => pageIndexes.has(chapter.startPageIndex))
    .sort((a, b) => a.startPageIndex - b.startPageIndex)
    .map((chapter, index) => ({
      ...chapter,
      index: index + 1
    }));

  return chapters.map((chapter) => ({
    pageIndex: chapter.startPageIndex,
    chapter
  }));
}

/**
 * Decides the apparatus from the partition that is about to be printed, so a
 * plan's chapters and model-written reader chapters are held to one standard.
 *
 * The word "Chapter" over three paragraphs is what this exists to prevent. A
 * three-page book is still divided into beats worth titling — that is what the
 * planner wrote them for — but none of them is a chapter, and a Contents page
 * listing three of them costs a quarter of the finished PDF.
 */
export function chapterPresentationFor(
  starts: ReadonlyArray<{ pageIndex: number }>,
  pages: ReadonlyArray<{ index: number }>
): ChapterPresentation {
  if (starts.length < 2 || pages.length === 0) {
    return "none";
  }
  const pageLevel = looksLikePageLevelPartition(starts, pages);
  if (!pageLevel && pages.length >= MIN_CHAPTERED_BOOK_PAGES) {
    return "chapters";
  }
  // A short book earns unnumbered breaks even at one per page; a long one cut
  // that finely is a page list rather than a structure, and gets nothing.
  if (!pageLevel || pages.length <= MAX_SECTIONED_BOOK_PAGES) {
    return "sections";
  }
  return "none";
}

/**
 * Whether the partition is really a page index rather than a structure.
 *
 * Measured on the distance between consecutive starts rather than on a plan's
 * `targetPages`, which is a forecast the finished book may not have honoured —
 * and which used to be tested with a floor of four chapters, so a three-page
 * book cut into three could never be caught however thin the pieces were.
 *
 * Both halves are needed. The average catches a book sliced uniformly too fine;
 * the share of single-page divisions catches one that hides four of them behind
 * a single long chapter, which the average would forgive.
 */
function looksLikePageLevelPartition(
  starts: ReadonlyArray<{ pageIndex: number }>,
  pages: ReadonlyArray<{ index: number }>
): boolean {
  const ordered = [...starts].sort((a, b) => a.pageIndex - b.pageIndex);
  const lastPageIndex = pages.reduce((last, page) => Math.max(last, page.index), 0);
  const spans = ordered.map((start, index) => (ordered[index + 1]?.pageIndex ?? lastPageIndex + 1) - start.pageIndex);
  const onePageSpans = spans.filter((span) => span <= 1).length;
  return pages.length / ordered.length < MIN_PAGES_PER_DIVISION || onePageSpans / spans.length >= 0.7;
}

type DisplayChapter = Pick<ChapterPlan, "index" | "title" | "summary">;

/** The heading wording in force for one compile: a style plus the word to use for "Chapter". */
type ChapterHeadingFormat = { style: ChapterHeadingStyle; word: string };

function chapterHeadingFormat(
  input: CompileMarkdownInput,
  labels: MarkdownLabels,
  presentation: ChapterPresentation
): ChapterHeadingFormat {
  return {
    // A stated preference always wins: someone who asked for "Part 1" keeps it
    // however small the book is. Only the default is sized to the book.
    style: input.chapterHeadingStyle ?? (presentation === "sections" ? "title_only" : DEFAULT_CHAPTER_HEADING_STYLE),
    word: sanitizeChapterHeadingLabel(input.chapterHeadingLabel) ?? labels.chapter
  };
}

/**
 * Never returns an empty string. A chapter with no usable title falls back to
 * the numbered form even under `title_only`, because a bare `## ` is not a
 * heading to anything downstream: `splitIntoChapters` in `epub.ts` matches
 * `^##\s+(.+)$`, so an empty one would silently fold that chapter into the
 * previous one rather than render badly.
 */
function formatChapterHeading(chapter: DisplayChapter, heading: ChapterHeadingFormat): string {
  const clean = cleanChapterTitle(chapter, heading);
  const numbered = `${heading.word} ${chapter.index}`;
  if (!clean) {
    return numbered;
  }
  if (heading.style === "title_only") {
    return clean;
  }
  if (heading.style === "number_title") {
    return `${chapter.index}. ${clean}`;
  }
  return `${numbered}: ${clean}`;
}

/**
 * What every text-generating prompt has to be told about the byline, because
 * `formatTitlePage` below and `renderCoverPng` already print it. Without this
 * a stated author reads as a writing instruction: one book's plan answered
 * "make it under my name" by ending its premise with «به قلم پارسا ق.», and a
 * premise reaches every single page call.
 */
export const BYLINE_IS_TYPESET_RULE =
  "The cover (or the fallback title page when there is no cover) is typeset by the app from the project's title and author name. Never write the author's name, a byline, an attribution such as \"by <name>\", a dedication-style credit, or any other front matter into the premise, chapter titles, or page text; naming the author there prints it a second time inside the book.";

/**
 * The no-cover fallback title page, or `""` for a book with no byline.
 *
 * The caller suppresses this whenever a cover exists because the cover already
 * typesets the same title, subtitle and author. Keeping the fallback here makes
 * the byline visible for an exceptional coverless export without duplicating
 * normal books' front matter.
 */
function formatTitlePage(input: CompileMarkdownInput, labels: MarkdownLabels): string {
  const authorName = input.authorName?.trim();
  if (!authorName) {
    return "";
  }
  const subtitle = input.plan.subtitle?.trim();
  return [
    '<section class="book-title-page">',
    `  <h1 class="book-title-page__title">${escapeHtml(input.plan.title)}</h1>`,
    ...(subtitle ? [`  <p class="book-title-page__subtitle">${escapeHtml(subtitle)}</p>`] : []),
    `  <p class="book-title-page__byline">${escapeHtml(`${labels.by} ${authorName}`)}</p>`,
    "</section>"
  ].join("\n");
}

function formatContentsSection(
  chapterStarts: Array<{ pageIndex: number; chapter: DisplayChapter }>,
  labels: MarkdownLabels,
  heading: ChapterHeadingFormat
): string {
  const items = chapterStarts.map((item) => formatContentsItem(item, heading)).join("\n");
  const densityClass =
    chapterStarts.length > 14 ? " book-contents--dense" : chapterStarts.length > 8 ? " book-contents--compact" : "";
  return [
    `<section class="book-contents${densityClass}" aria-labelledby="book-contents-title">`,
    `  <p class="book-contents__eyebrow">${escapeHtml(labels.contentsEyebrow)}</p>`,
    `  <h2 id="book-contents-title">${escapeHtml(labels.contentsHeading)}</h2>`,
    '  <div class="book-contents__ornament" aria-hidden="true"></div>',
    '  <ol class="book-contents__list">',
    items,
    "  </ol>",
    "</section>"
  ].join("\n");
}

function formatContentsItem(
  { pageIndex, chapter }: { pageIndex: number; chapter: DisplayChapter },
  heading: ChapterHeadingFormat
): string {
  // The eyebrow carries whatever numbering the heading style kept, and is
  // dropped entirely under `title_only`. Every sibling span sets its own
  // `grid-column` in the PDF stylesheet, so removing this one loses the line
  // without reflowing the title, leader and page number.
  const label =
    heading.style === "title_only"
      ? ""
      : heading.style === "number_title"
        ? escapeHtml(String(chapter.index))
        : escapeHtml(`${heading.word} ${chapter.index}`);
  const title = escapeHtml(cleanChapterTitle(chapter, heading) || "Untitled");
  const page = escapeHtml(String(pageIndex));
  const href = `#${chapterAnchorId(chapter)}`;
  return [
    '    <li class="book-contents__item">',
    `      <a class="book-contents__link" href="${href}">`,
    ...(label ? [`        <span class="book-contents__chapter">${label}</span>`] : []),
    `        <span class="book-contents__name">${title}</span>`,
    '        <span class="book-contents__leader" aria-hidden="true"></span>',
    `        <span class="book-contents__page">${page}</span>`,
    "      </a>",
    "    </li>"
  ].join("\n");
}

/**
 * Strips a label prefix the stored title already carries, so a heading is never
 * doubled.
 *
 * Both the English "chapter" and the label actually in force are stripped: the
 * former because model-written titles arrive as "Chapter 3: ..." regardless of
 * language, the latter so switching to "Part" does not render "Part 1: Part 1: X".
 */
function cleanChapterTitle(chapter: DisplayChapter, heading?: ChapterHeadingFormat): string {
  let clean = chapter.title.trim().replace(/^#+\s*/, "").replace(/\s+/g, " ");
  const words = [...new Set(["chapter", ...(heading ? [heading.word.toLowerCase()] : [])])];
  const duplicatePrefix = new RegExp(
    `^(?:(?:${words.map(escapeRegExp).join("|")})\\s+${chapter.index}\\s*[:\\-]?\\s*)+`,
    "i"
  );
  while (duplicatePrefix.test(clean)) {
    clean = clean.replace(duplicatePrefix, "").trim();
  }
  return clean;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * The anchor a chapter opener carries in the compiled markdown, and the exact
 * bytes the renderer looks for at {@link PageAnchorPlan.existingIdOffset} before
 * it trusts an offset — so the two can never drift apart silently.
 */
export function chapterAnchorMarkup(destName: string): string {
  return `<a id="${destName}"></a>`;
}

function chapterAnchorId(chapter: DisplayChapter): string {
  const suffix = String(chapter.index)
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return `chapter-${suffix || "1"}`;
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function sanitizePageMarkdown(
  page: MarkdownPage,
  chapter: DisplayChapter | undefined,
  labels: MarkdownLabels,
  headingFormat: ChapterHeadingFormat
): string {
  const markdown = unwrapWholePageMarkdownFence(page.markdown);
  const lines = markdown.split(/\r?\n/);
  const firstLine = lines[0];
  const heading = firstLine?.match(/^#{1,6}\s+(.+?)\s*#*\s*$/);
  if (!heading) {
    return markdown;
  }

  if (!shouldStripLeadingHeading(heading[1] ?? "", page, chapter, labels, headingFormat)) {
    return markdown;
  }

  lines.shift();
  while (lines[0]?.trim() === "") {
    lines.shift();
  }
  return lines.join("\n").trim();
}

export function unwrapWholePageMarkdownFence(markdown: string): string {
  const trimmed = markdown.trim();
  const match = trimmed.match(/^```(?:markdown|md|text|plain(?:text)?|prose)?[ \t]*\r?\n([\s\S]*?)\r?\n```[ \t]*$/i);
  return match?.[1]?.trim() ?? trimmed;
}

function shouldStripLeadingHeading(
  heading: string,
  page: MarkdownPage,
  chapter: DisplayChapter | undefined,
  labels: MarkdownLabels,
  headingFormat: ChapterHeadingFormat
): boolean {
  const normalizedHeading = normalizeHeadingText(heading);
  const normalizedPageTitle = normalizeHeadingText(sanitizePageTitle(page.index, page.title));
  const pagePrefix = new RegExp(`^page\\s+${page.index}\\b`, "i");
  if (
    pagePrefix.test(normalizedHeading) ||
    /^page(?:\s+\d+\b|\s+title\b|\s+like\b)/i.test(normalizedHeading) ||
    (normalizedHeading.length > 0 && normalizedHeading === normalizedPageTitle)
  ) {
    return true;
  }

  if (!chapter || normalizedHeading.length === 0) {
    return false;
  }

  // The page's own heading was written when some *other* wording was canonical,
  // so match every form this chapter could have been headed with — not just the
  // one in force now. Otherwise switching the style leaves the old heading
  // sitting in the prose directly under the new one.
  const words = [...new Set([headingFormat.word, labels.chapter, "Chapter"])];
  return words.some((word) =>
    CHAPTER_HEADING_STYLES.some(
      (style) => normalizedHeading === normalizeHeadingText(formatChapterHeading(chapter, { style, word }))
    )
  );
}

function normalizeHeadingText(text: string): string {
  return text
    .toLowerCase()
    .replace(/[*_`]/g, "")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function sanitizeImageAlt(_index: number, alt: string | undefined, labels: MarkdownLabels): string {
  const clean = alt?.trim();
  if (!clean) {
    return labels.illustration;
  }
  if (
    clean === DEFAULT_MARKDOWN_LABELS.illustration ||
    /^illustration for page \d+$/i.test(clean) ||
    PROMPT_LEAK_PATTERNS.some((pattern) => pattern.test(clean)) ||
    clean.length > 120
  ) {
    return labels.illustration;
  }
  return clean;
}

function sanitizeCoverAlt(alt: string | undefined, labels: MarkdownLabels): string {
  if (!alt) {
    return labels.bookCover;
  }
  if (
    (labels !== DEFAULT_MARKDOWN_LABELS && /^cover for\b/i.test(alt)) ||
    PROMPT_LEAK_PATTERNS.some((pattern) => pattern.test(alt)) ||
    alt.length > 120
  ) {
    return labels.bookCover;
  }
  return alt.trim() || labels.bookCover;
}

function formatResearchCitation(source: { title: string; url?: string | undefined }): string | undefined {
  const url = source.url?.trim();
  if (!url) {
    return undefined;
  }
  return `- [${escapeMarkdownLinkText(sanitizeResearchTitle(source.title, url))}](${url})`;
}

function sanitizeResearchTitle(title: string, url: string): string {
  const clean = title.trim().replace(/\s+/g, " ");
  if (!clean || clean.length > 120 || PROMPT_LEAK_PATTERNS.some((pattern) => pattern.test(clean))) {
    return hostnameFromUrl(url);
  }
  return clean;
}

function hostnameFromUrl(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "") || "Source";
  } catch {
    return "Source";
  }
}

function escapeMarkdownLinkText(text: string): string {
  return text.replace(/[\\[\]]/g, "\\$&");
}

/**
 * Whether the Sources back matter should print, ignoring whether any citations
 * actually exist. `false` always drops it; `true` always keeps it (the
 * compiler still needs citations); unset follows the source-forward categories
 * (SCIENCE, HEALTH, BIOGRAPHY, HISTORY).
 */
export function shouldPrintSourcesBackMatter(options: {
  category?: string | undefined;
  includeSources?: boolean | undefined;
}): boolean {
  if (options.includeSources === false) {
    return false;
  }
  if (options.includeSources === true) {
    return true;
  }
  return isSourceForwardBookCategory(options.category);
}

/**
 * Whether any stored research row can become a citation. The compiler prints
 * only sources carrying a URL, so a project with rows but no links has nothing
 * to put at the end of the book — which is what the chat has to say rather than
 * promising a section it cannot deliver.
 */
export function hasReaderFacingSources(
  sources: Array<{ title: string; url?: string | undefined; summary: string }>
): boolean {
  return uniqueResearchCitations(sources).length > 0;
}

function formatReaderFacingSources(input: CompileMarkdownInput): string {
  if (
    !shouldPrintSourcesBackMatter({
      category: input.category,
      includeSources: input.includeSources
    })
  ) {
    return "";
  }
  const citations = uniqueResearchCitations(input.researchSources ?? []);
  if (citations.length === 0) {
    return "";
  }
  return citations.join("\n");
}

function uniqueResearchCitations(
  sources: Array<{ title: string; url?: string | undefined; summary: string }>
): string[] {
  const seen = new Set<string>();
  const citations: string[] = [];

  for (const source of sources) {
    const url = source.url?.trim();
    if (!url || seen.has(normalizeSourceUrl(url))) {
      continue;
    }
    const citation = formatResearchCitation(source);
    if (!citation) {
      continue;
    }
    seen.add(normalizeSourceUrl(url));
    citations.push(citation);
  }

  return citations;
}

function normalizeSourceUrl(url: string): string {
  try {
    const parsed = new URL(url);
    parsed.hash = "";
    return parsed.toString().replace(/\/$/, "");
  } catch {
    return url.trim().replace(/#.*$/, "").replace(/\/$/, "");
  }
}

const PROMPT_LEAK_PATTERNS = [
  /global visual style/i,
  /continuity rules:/i,
  /image prompt/i,
  /avoid text inside images/i,
  /return json/i,
  /pageinstruction/i,
  /production instructions/i,
  /for an ai book/i,
  /research this for/i,
  /book generation/i,
  /generation plan/i
];
