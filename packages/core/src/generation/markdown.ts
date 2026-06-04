import type { BookPlan, ChapterPlan, CreateProjectInput } from "../schemas/book.js";
import { isSourceForwardBookCategory } from "../categories.js";
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
};

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
  const contents = chapterStarts.length > 1 ? formatContentsSection(chapterStarts, labels) : "";
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
        chapter ? `<a id="${chapterAnchorId(chapter)}"></a>\n\n## ${formatChapterHeading(chapter, labels)}` : "",
        page.imagePath ? `\n![${sanitizeImageAlt(page.index, page.imageAlt, labels)}](${page.imagePath})\n` : "",
        sanitizePageMarkdown(page, chapter, labels),
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
  clean = clean.replace(/^page\s+\d+\s*[:\-]\s*/i, "").trim();
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

function formatChapterHeading(chapter: DisplayChapter, labels: MarkdownLabels): string {
  const clean = cleanChapterTitle(chapter);
  return clean ? `${labels.chapter} ${chapter.index}: ${clean}` : `${labels.chapter} ${chapter.index}`;
}

function formatContentsSection(
  chapterStarts: Array<{ pageIndex: number; chapter: DisplayChapter }>,
  labels: MarkdownLabels
): string {
  const items = chapterStarts.map((item) => formatContentsItem(item, labels)).join("\n");
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
  labels: MarkdownLabels
): string {
  const label = escapeHtml(`${labels.chapter} ${chapter.index}`);
  const title = escapeHtml(cleanChapterTitle(chapter) || "Untitled");
  const page = escapeHtml(String(pageIndex));
  const href = `#${chapterAnchorId(chapter)}`;
  return [
    '    <li class="book-contents__item">',
    `      <a class="book-contents__link" href="${href}">`,
    `        <span class="book-contents__chapter">${label}</span>`,
    `        <span class="book-contents__name">${title}</span>`,
    '        <span class="book-contents__leader" aria-hidden="true"></span>',
    `        <span class="book-contents__page">${page}</span>`,
    "      </a>",
    "    </li>"
  ].join("\n");
}

function cleanChapterTitle(chapter: DisplayChapter): string {
  let clean = chapter.title.trim().replace(/^#+\s*/, "").replace(/\s+/g, " ");
  const duplicatePrefix = new RegExp(`^(?:chapter\\s+${chapter.index}\\s*[:\\-]?\\s*)+`, "i");
  while (duplicatePrefix.test(clean)) {
    clean = clean.replace(duplicatePrefix, "").trim();
  }
  return clean;
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

function sanitizePageMarkdown(page: MarkdownPage, chapter: DisplayChapter | undefined, labels: MarkdownLabels): string {
  const markdown = unwrapWholePageMarkdownFence(page.markdown);
  const lines = markdown.split(/\r?\n/);
  const firstLine = lines[0];
  const heading = firstLine?.match(/^#{1,6}\s+(.+?)\s*#*\s*$/);
  if (!heading) {
    return markdown;
  }

  if (!shouldStripLeadingHeading(heading[1] ?? "", page, chapter, labels)) {
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
  labels: MarkdownLabels
): boolean {
  const normalizedHeading = normalizeHeadingText(heading);
  const normalizedPageTitle = normalizeHeadingText(sanitizePageTitle(page.index, page.title));
  const pagePrefix = new RegExp(`^page\\s+${page.index}\\b`, "i");
  if (
    pagePrefix.test(normalizedHeading) ||
    /^page(?:\s+\d+\b|\s+title\b|\s+like\b)/i.test(normalizedHeading) ||
    normalizedHeading === normalizedPageTitle
  ) {
    return true;
  }

  if (!chapter) {
    return false;
  }

  return (
    normalizedHeading === normalizeHeadingText(formatChapterHeading(chapter, labels)) ||
    normalizedHeading === normalizeHeadingText(chapter.title)
  );
}

function normalizeHeadingText(text: string): string {
  return text
    .toLowerCase()
    .replace(/[*_`]/g, "")
    .replace(/[^a-z0-9\s]/g, " ")
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

  if (hasExplicitResearchIntent(input.plan)) {
    return true;
  }

  const decisionText = sourceDecisionText(input, pages);
  if (hasFactualBackMatterSignals(decisionText)) {
    return true;
  }

  return false;
}

function hasExplicitResearchIntent(plan: BookPlan): boolean {
  return (
    plan.researchQueries.some((query) => query.trim().length > 0) ||
    plan.researchNotes.some((source) => Boolean(source.url?.trim()))
  );
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

const FACTUAL_BACK_MATTER_PATTERNS = [
  /\b(?:nonfiction|non-fiction|factual|facts?|source-backed|research-grounded|evidence-based)\b/i,
  /\b(?:science|scientific|experiment|biology|chemistry|physics|astronomy|geology|ecology)\b/i,
  /\b(?:history|historical|biography|biographical|ancient|archaeology|civilization)\b/i,
  /\b(?:current|recent|latest|today|real-world|real world|true story|based on real)\b/i,
  /\b(?:medicine|medical|health|law|legal|finance|financial|safety)\b/i,
  /\b(?:explainer|field guide|guidebook|lesson|educational|learn about|teach(?:es|ing)? about)\b/i,
  /\b(?:life cycle|ecosystem|habitat|pollinat(?:e|es|ion|or)|climate|weather|planet|space|ocean)\b/i,
  /\bhow\b.{0,80}\b(?:works?|happens?|changes?|grows?|moves?|forms?|pollinat(?:es|ion)|survives?)\b/i
];
