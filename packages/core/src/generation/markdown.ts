import type { BookPlan, ChapterPlan, CreateProjectInput } from "../schemas/book.js";
import { isNarrativeBookCategory, isSourceForwardBookCategory } from "../categories.js";
import { isEnglishLanguage, languageLabel } from "../prompting/language.js";

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
   * even when the category and plan would normally print it; `undefined` leaves
   * the automatic decision in {@link shouldRenderSources} alone.
   */
  includeSources?: boolean | undefined;
  /**
   * Reader preference for how a chapter heading is worded. `undefined` keeps
   * the canonical `Chapter N: Title`.
   */
  chapterHeadingStyle?: ChapterHeadingStyle | undefined;
  /** Replaces the word "Chapter" — "Part", "Episode". `undefined` keeps the localized default. */
  chapterHeadingLabel?: string | undefined;
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

type MarkdownLabels = {
  contentsEyebrow: string;
  contentsHeading: string;
  chapter: string;
  sources: string;
  illustration: string;
  bookCover: string;
};

const DEFAULT_MARKDOWN_LABELS: MarkdownLabels = {
  contentsEyebrow: "Table of Contents",
  contentsHeading: "Contents",
  chapter: "Chapter",
  sources: "Sources",
  illustration: "Illustration",
  bookCover: "Book cover"
};

const MARKDOWN_LABELS_BY_LANGUAGE: Record<string, MarkdownLabels> = {
  arabic: {
    contentsEyebrow: "فهرس المحتويات",
    contentsHeading: "المحتويات",
    chapter: "الفصل",
    sources: "المصادر",
    illustration: "رسم توضيحي",
    bookCover: "غلاف الكتاب"
  },
  chinese: {
    contentsEyebrow: "目录",
    contentsHeading: "目录",
    chapter: "第",
    sources: "资料来源",
    illustration: "插图",
    bookCover: "书籍封面"
  },
  french: {
    contentsEyebrow: "Table des matières",
    contentsHeading: "Sommaire",
    chapter: "Chapitre",
    sources: "Sources",
    illustration: "Illustration",
    bookCover: "Couverture du livre"
  },
  german: {
    contentsEyebrow: "Inhaltsverzeichnis",
    contentsHeading: "Inhalt",
    chapter: "Kapitel",
    sources: "Quellen",
    illustration: "Illustration",
    bookCover: "Buchcover"
  },
  hindi: {
    contentsEyebrow: "विषय-सूची",
    contentsHeading: "विषय-सूची",
    chapter: "अध्याय",
    sources: "स्रोत",
    illustration: "चित्र",
    bookCover: "पुस्तक आवरण"
  },
  italian: {
    contentsEyebrow: "Indice",
    contentsHeading: "Indice",
    chapter: "Capitolo",
    sources: "Fonti",
    illustration: "Illustrazione",
    bookCover: "Copertina del libro"
  },
  japanese: {
    contentsEyebrow: "目次",
    contentsHeading: "目次",
    chapter: "第",
    sources: "出典",
    illustration: "挿絵",
    bookCover: "本の表紙"
  },
  korean: {
    contentsEyebrow: "목차",
    contentsHeading: "목차",
    chapter: "장",
    sources: "출처",
    illustration: "삽화",
    bookCover: "책 표지"
  },
  persian: {
    contentsEyebrow: "فهرست مطالب",
    contentsHeading: "فهرست",
    chapter: "فصل",
    sources: "منابع",
    illustration: "تصویر",
    bookCover: "جلد کتاب"
  },
  portuguese: {
    contentsEyebrow: "Sumário",
    contentsHeading: "Sumário",
    chapter: "Capítulo",
    sources: "Fontes",
    illustration: "Ilustração",
    bookCover: "Capa do livro"
  },
  russian: {
    contentsEyebrow: "Оглавление",
    contentsHeading: "Содержание",
    chapter: "Глава",
    sources: "Источники",
    illustration: "Иллюстрация",
    bookCover: "Обложка книги"
  },
  spanish: {
    contentsEyebrow: "Tabla de contenido",
    contentsHeading: "Contenido",
    chapter: "Capítulo",
    sources: "Fuentes",
    illustration: "Ilustración",
    bookCover: "Cubierta del libro"
  },
  turkish: {
    contentsEyebrow: "İçindekiler",
    contentsHeading: "İçindekiler",
    chapter: "Bölüm",
    sources: "Kaynaklar",
    illustration: "İllüstrasyon",
    bookCover: "Kitap kapağı"
  },
  urdu: {
    contentsEyebrow: "فہرست مضامین",
    contentsHeading: "فہرست",
    chapter: "باب",
    sources: "ذرائع",
    illustration: "تصویر",
    bookCover: "کتاب کا سرورق"
  }
};

function markdownLabels(language: string | undefined): MarkdownLabels {
  if (isEnglishLanguage(language)) {
    return DEFAULT_MARKDOWN_LABELS;
  }
  return MARKDOWN_LABELS_BY_LANGUAGE[languageLabel(language).toLowerCase()] ?? DEFAULT_MARKDOWN_LABELS;
}

export function compileBookMarkdown(input: CompileMarkdownInput): string {
  const pages = [...input.pages].sort((a, b) => a.index - b.index);
  const labels = markdownLabels(input.language);
  const readerChapterStarts = readerChapterStartsForPages(input.readerChapters, pages);
  const chapterStarts = readerChapterStarts.length > 0 ? readerChapterStarts : chapterStartsForPages(input.plan, pages);
  const chapterByStartPage = new Map(chapterStarts.map((start) => [start.pageIndex, start.chapter]));
  const heading = chapterHeadingFormat(input, labels);
  const contents = chapterStarts.length > 1 ? formatContentsSection(chapterStarts, labels, heading) : "";
  const research = formatReaderFacingSources(input, pages);
  const coverImagePath = input.cover?.imagePath;

  const markdown = [
    coverImagePath ? `![${sanitizeCoverAlt(input.cover?.imageAlt, labels)}](${coverImagePath})` : "",
    coverImagePath ? "" : `# ${input.plan.title}`,
    !coverImagePath && input.plan.subtitle ? `\n_${input.plan.subtitle}_\n` : "",
    contents,
    "",
    ...pages.map((page) => {
      const chapter = chapterByStartPage.get(page.index);
      return [
        chapter ? `<a id="${chapterAnchorId(chapter)}"></a>\n\n## ${formatChapterHeading(chapter, heading)}` : "",
        page.imagePath ? `\n![${sanitizeImageAlt(page.index, page.imageAlt, labels)}](${page.imagePath})\n` : "",
        sanitizePageMarkdown(page, chapter, labels, heading),
        ""
      ]
        .filter(Boolean)
        .join("\n");
    }),
    research ? `## ${labels.sources}\n` + research : ""
  ]
    .filter(Boolean)
    .join("\n");
  assertBookLikeMarkdown(markdown);
  return markdown;
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
  if (looksLikePageLevelChapterPlan(chapters, pages.length)) {
    return [];
  }

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

  if (looksLikePageLevelReaderChapters(chapters, pages.length)) {
    return [];
  }

  return chapters.map((chapter) => ({
    pageIndex: chapter.startPageIndex,
    chapter
  }));
}

function looksLikePageLevelChapterPlan(chapters: ChapterPlan[], pageCount: number): boolean {
  if (chapters.length <= 1) {
    return false;
  }
  const maxReasonableChapterCount = Math.max(4, Math.ceil(pageCount / 3));
  const shortChapterCount = chapters.filter((chapter) => chapter.targetPages <= 2).length;
  return chapters.length > maxReasonableChapterCount && shortChapterCount / chapters.length >= 0.7;
}

function looksLikePageLevelReaderChapters(chapters: ReaderChapter[], pageCount: number): boolean {
  if (chapters.length <= 1) {
    return false;
  }
  const spans = chapters.map((chapter) => chapter.endPageIndex - chapter.startPageIndex + 1);
  const onePageSpans = spans.filter((span) => span <= 1).length;
  return chapters.length >= pageCount || onePageSpans / chapters.length >= 0.7;
}

type DisplayChapter = Pick<ChapterPlan, "index" | "title" | "summary">;

/** The heading wording in force for one compile: a style plus the word to use for "Chapter". */
type ChapterHeadingFormat = { style: ChapterHeadingStyle; word: string };

function chapterHeadingFormat(input: CompileMarkdownInput, labels: MarkdownLabels): ChapterHeadingFormat {
  return {
    style: input.chapterHeadingStyle ?? DEFAULT_CHAPTER_HEADING_STYLE,
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

function unwrapWholePageMarkdownFence(markdown: string): string {
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

function formatReaderFacingSources(input: CompileMarkdownInput, pages: MarkdownPage[]): string {
  if (input.includeSources === false) {
    return "";
  }
  const citations = uniqueResearchCitations(input.researchSources ?? []);
  if (citations.length === 0 || !shouldRenderSources(input, pages)) {
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

function shouldRenderSources(input: CompileMarkdownInput, pages: MarkdownPage[]): boolean {
  if (isSourceForwardBookCategory(input.category)) {
    return true;
  }

  if (isNarrativeBookCategory(input.category)) {
    return false;
  }

  const decisionText = sourceDecisionText(input, pages);
  if (hasNarrativeStorySignals(decisionText)) {
    return false;
  }

  return hasPlannedResearchQueries(input.plan) || hasFactualBackMatterSignals(decisionText);
}

function hasPlannedResearchQueries(plan: BookPlan): boolean {
  return plan.researchQueries.some((query) => query.trim().length > 0);
}

function sourceDecisionText(input: CompileMarkdownInput, pages: MarkdownPage[]): string {
  const plan = input.plan;
  return [
    input.category ?? "",
    plan.title,
    plan.subtitle ?? "",
    plan.premise,
    plan.audience,
    ...plan.voiceGuide,
    ...plan.chapters.flatMap((chapter) => [chapter.title, chapter.summary, ...chapter.keyBeats]),
    ...pages.map((page) => `${page.title} ${plainTextFromMarkdown(page.markdown)}`)
  ]
    .join("\n")
    .toLowerCase();
}

function plainTextFromMarkdown(markdown: string): string {
  return markdown
    .replace(/!\[[^\]]*]\([^)]+\)/g, " ")
    .replace(/\[([^\]]+)]\([^)]+\)/g, "$1")
    .replace(/^#{1,6}\s+/gm, " ")
    .replace(/[*_`>#|~-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function hasFactualBackMatterSignals(text: string): boolean {
  return FACTUAL_BACK_MATTER_PATTERNS.some((pattern) => pattern.test(text));
}

function hasNarrativeStorySignals(text: string): boolean {
  return NARRATIVE_STORY_PATTERNS.some((pattern) => pattern.test(text));
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

const NARRATIVE_STORY_PATTERNS = [
  /\b(?:fiction|fictional|novel|novella|storybook)\b/i,
  /\b(?:short|bedtime|adventure)\s+stor(?:y|ies)\b/i,
  /\b(?:fable|fairy\s?tale|folk\s?tale|tall tale|parable)\b/i,
  /\bonce upon a time\b/i,
  /\b(?:lullab(?:y|ies)|nursery rhymes?)\b/i
];

const FACTUAL_BACK_MATTER_PATTERNS = [
  /\b(?:nonfiction|non-fiction|factual|facts?|source-backed|research-grounded|evidence-based)\b/i,
  /\b(?:science|scientific|experiment|biology|chemistry|physics|astronomy|geology|ecology)\b/i,
  /\b(?:history|historical|biography|biographical|ancient|archaeology|civilization)\b/i,
  /\b(?:current|recent|latest|today|real-world|real world|true story|based on real)\b/i,
  /\b(?:medicine|medical|health|law|legal|finance|financial|safety)\b/i,
  /\b(?:explainer|field guide|guidebook|educational|learn about|teach(?:es|ing)? about)\b/i,
  /\b(?:life cycle|ecosystem|habitat|pollinat(?:e|es|ion|or)|climate|weather|planet|space|ocean)\b/i,
  /\bhow\b.{0,80}\b(?:works?|happens?|changes?|grows?|moves?|forms?|pollinat(?:es|ion)|survives?)\b/i
];
