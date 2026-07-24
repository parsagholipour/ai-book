import { z } from "zod";
import type { TextModelAdapter } from "../adapters/types.js";
import { generateJsonWithRetry } from "../generation/generateJsonWithRetry.js";
import { bookPlanSchema, type BookPlan } from "../schemas/book.js";
import {
  decodeUtf8,
  DocumentTextError,
  docxXmlToText,
  loadZip,
  normalizeExtractedText,
  orderedEpubChapterPaths,
  readDocxDocumentXml,
  stripHtml,
  stripRtf
} from "./documentText.js";

/**
 * Full-length manuscript import ("bring your own book"). Unlike creation-chat
 * attachments — which are truncated digests used as reference material — an
 * imported manuscript IS the canonical book content: it is segmented into
 * chapters and pages that become real Chapter/Page rows, so the whole edit,
 * chat, and export stack operates on it unchanged.
 */

/** Upload ceiling, matching the mobile client's document cap. */
export const MANUSCRIPT_MAX_BYTES = 20 * 1024 * 1024;
/** Longest manuscript we materialize (~250k words). */
export const MANUSCRIPT_MAX_CHARS = 1_500_000;
/** Hard page ceiling; page size grows to fit longer texts under it. */
export const MANUSCRIPT_MAX_PAGES = 600;

/** Preferred page length; pages split at paragraph boundaries near this size. */
const PAGE_TARGET_CHARS = 1900;
/** Below this a single-block text is not worth an LLM chapterization call. */
const CHAPTERIZE_MIN_CHARS = 30_000;
/** Chapter size for the deterministic last-resort segmentation. */
const FIXED_CHAPTER_PAGES = 10;
/** Style analysis reads ~this much text sampled from start/middle/end. */
const STYLE_SAMPLE_CHARS = 9000;

export type ManuscriptImportFormat = "docx" | "epub" | "html" | "rtf" | "text";

export type ManuscriptImportErrorCode =
  | "UNSUPPORTED_TYPE"
  | "EMPTY_FILE"
  | "FILE_TOO_LARGE"
  | "IMPORT_TOO_LARGE"
  | "UNREADABLE_FILE";

export class ManuscriptImportError extends Error {
  readonly code: ManuscriptImportErrorCode;

  constructor(code: ManuscriptImportErrorCode, message: string) {
    super(message);
    this.name = "ManuscriptImportError";
    this.code = code;
  }
}

/** One structural unit of the source document (EPUB spine item, heading-run, …). */
export type ImportSection = {
  title: string | null;
  text: string;
};

export type ParsedManuscript = {
  sections: ImportSection[];
  /** Concatenated normalized text of every section. */
  text: string;
  charCount: number;
  wordCount: number;
};

export type ManuscriptPage = { title: string; markdown: string; summary: string };
export type ManuscriptChapter = { title: string; summary: string; pages: ManuscriptPage[] };

export type SegmentedManuscript = {
  chapters: ManuscriptChapter[];
  pageCount: number;
  /** How chapter boundaries were found, for import stats/telemetry. */
  segmentation: "structure" | "llm" | "fixed";
};

/**
 * Extracts the manuscript's full text as ordered sections. Never truncates;
 * rejects texts beyond MANUSCRIPT_MAX_CHARS instead.
 */
export async function parseManuscript(input: {
  data: Buffer;
  format: ManuscriptImportFormat;
}): Promise<ParsedManuscript> {
  if (input.data.length === 0) {
    throw new ManuscriptImportError("EMPTY_FILE", "That file is empty, so there is nothing to import.");
  }
  if (input.data.length > MANUSCRIPT_MAX_BYTES) {
    throw new ManuscriptImportError(
      "FILE_TOO_LARGE",
      "That file is too large. Manuscripts up to 20 MB are supported."
    );
  }

  let sections: ImportSection[];
  try {
    sections = await extractManuscriptSections(input.data, input.format);
  } catch (error) {
    if (error instanceof DocumentTextError) {
      throw new ManuscriptImportError(error.code, error.message);
    }
    throw error;
  }

  sections = sections
    .map((section) => ({ title: section.title, text: normalizeExtractedText(section.text) }))
    .filter((section) => section.text.length > 0);
  const text = sections.map((section) => section.text).join("\n\n");
  if (!text) {
    throw new ManuscriptImportError("UNREADABLE_FILE", "No readable text was found in that file.");
  }
  if (text.length > MANUSCRIPT_MAX_CHARS) {
    throw new ManuscriptImportError(
      "IMPORT_TOO_LARGE",
      "That manuscript is longer than what can be imported right now (about 250,000 words). Try splitting it into volumes."
    );
  }

  return {
    sections,
    text,
    charCount: text.length,
    wordCount: countWords(text)
  };
}

async function extractManuscriptSections(
  data: Buffer,
  format: ManuscriptImportFormat
): Promise<ImportSection[]> {
  if (format === "docx") {
    return extractDocxSections(data);
  }
  if (format === "epub") {
    return extractEpubSections(data);
  }
  const raw = decodeUtf8(data);
  if (format === "html") {
    return sectionsFromHtml(raw);
  }
  if (format === "rtf") {
    return sectionsFromHeadingLines(stripRtf(raw));
  }
  return sectionsFromText(raw);
}

/** DOCX: Heading1/Heading2/Title paragraph styles start a new section. */
async function extractDocxSections(data: Buffer): Promise<ImportSection[]> {
  const documentXml = await readDocxDocumentXml(data);
  // Match whole paragraphs: self-closing <w:p/> or <w:p>…</w:p>. The closing
  // tag must be matched explicitly — inner self-closing tags like <w:pStyle/>
  // would otherwise end the match early.
  const paragraphs = documentXml.match(/<w:p(?:\s[^>]*)?\/>|<w:p(?:\s[^>]*)?>[\s\S]*?<\/w:p>/g) ?? [];
  const sections: ImportSection[] = [];
  let current: { title: string | null; parts: string[] } = { title: null, parts: [] };

  const flush = () => {
    const text = current.parts.join("\n").trim();
    if (text || current.title) {
      sections.push({ title: current.title, text });
    }
  };

  for (const paragraph of paragraphs) {
    const style = paragraph.match(/<w:pStyle\b[^>]*w:val="([^"]+)"/)?.[1] ?? "";
    const text = docxXmlToText(paragraph).trim();
    if (/^(heading[12]|title)$/i.test(style) && text) {
      flush();
      current = { title: text, parts: [] };
    } else if (text) {
      current.parts.push(text);
    }
  }
  flush();

  if (sections.length === 0) {
    // No styled headings at all — fall back to plain text heading detection.
    return sectionsFromHeadingLines(docxXmlToText(documentXml));
  }
  return sections;
}

/** Boilerplate EPUB sections (cover, TOC, copyright…) that are not chapters. */
const EPUB_BOILERPLATE_TITLE =
  /^(cover|title ?page|copyright|contents|table of contents|toc|nav|landmarks|dedication|acknowledg|about the (author|publisher)|colophon|imprint)/i;

/** EPUB: one section per spine item, in reading order. */
async function extractEpubSections(data: Buffer): Promise<ImportSection[]> {
  const zip = await loadZip(data, "EPUB");
  const paths = await orderedEpubChapterPaths(zip);
  const sections: ImportSection[] = [];
  for (const path of paths) {
    const html = await zip.file(path)?.async("string");
    if (!html) {
      continue;
    }
    const title =
      html.match(/<h[12]\b[^>]*>([\s\S]*?)<\/h[12]>/i)?.[1]?.replace(/<[^>]+>/g, "").trim() ||
      html.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i)?.[1]?.trim() ||
      null;
    const text = normalizeExtractedText(stripHtml(html));
    if (!text) {
      continue;
    }
    if (title && EPUB_BOILERPLATE_TITLE.test(title) && text.length < 1500) {
      continue;
    }
    sections.push({ title, text });
  }
  if (sections.length === 0) {
    throw new DocumentTextError("UNREADABLE_FILE", "No readable chapters were found in that EPUB.");
  }
  return sections;
}

function sectionsFromHtml(html: string): ImportSection[] {
  const marked = html.replace(
    /<h([12])\b[^>]*>([\s\S]*?)<\/h\1>/gi,
    (_, _level: string, inner: string) => `\n\u0001${inner.replace(/<[^>]+>/g, " ").trim()}\u0001\n`
  );
  return sectionsFromMarkedText(stripHtml(marked));
}

function sectionsFromText(raw: string): ImportSection[] {
  const normalized = normalizeExtractedText(raw);
  // Markdown headings first; prose heading lines otherwise.
  if (/^#{1,2}\s+\S/m.test(normalized)) {
    const marked = normalized.replace(/^#{1,2}\s+(.+)$/gm, "\u0001$1\u0001");
    return sectionsFromMarkedText(marked);
  }
  return sectionsFromHeadingLines(normalized);
}

const HEADING_LINE =
  /^(?:(?:chapter|part|book|prologue|epilogue|interlude|act)\b[^\n]{0,80}|[IVXLC]+\.\s[^\n]{0,80}|\d{1,3}\.\s[^\n]{0,80})$/i;

/** Splits plain text into sections at lines that read like chapter headings. */
function sectionsFromHeadingLines(text: string): ImportSection[] {
  const normalized = normalizeExtractedText(text);
  const lines = normalized.split("\n");
  const marked = lines
    .map((line) => {
      const trimmed = line.trim();
      return HEADING_LINE.test(trimmed) && trimmed.length <= 90 ? `\u0001${trimmed}\u0001` : line;
    })
    .join("\n");
  return sectionsFromMarkedText(marked);
}

/** Parses text where headings were wrapped in \u0001 markers into sections. */
function sectionsFromMarkedText(marked: string): ImportSection[] {
  const sections: ImportSection[] = [];
  let title: string | null = null;
  let parts: string[] = [];
  const flush = () => {
    const text = parts.join("\n").trim();
    if (text || title) {
      sections.push({ title, text });
    }
  };
  for (const line of marked.split("\n")) {
    const heading = line.match(/^\u0001(.*)\u0001$/);
    if (heading) {
      flush();
      title = heading[1]!.trim() || null;
      parts = [];
    } else {
      parts.push(line);
    }
  }
  flush();
  return sections.length > 0 ? sections : [{ title: null, text: marked }];
}

export type SegmentManuscriptDeps = {
  /** Mechanical-tier model for the chapterization fallback; optional. */
  chapterizeModel?: TextModelAdapter | undefined;
  language?: string | undefined;
};

/**
 * Turns parsed sections into chapters of pages. Structure wins; an LLM pass
 * only runs when the document has no usable boundaries, and a fixed split is
 * the deterministic last resort.
 */
export async function segmentManuscript(
  parsed: ParsedManuscript,
  deps: SegmentManuscriptDeps = {}
): Promise<SegmentedManuscript> {
  const pageChars = pageChunkChars(parsed.charCount);

  if (parsed.sections.length >= 2) {
    return finishSegmentation({
      chapters: parsed.sections.map((section, index) => chapterFromSection(section, index, pageChars)),
      pageCount: 0,
      segmentation: "structure"
    });
  }

  const only = parsed.sections[0] ?? { title: null, text: parsed.text };
  if (only.title && parsed.charCount <= CHAPTERIZE_MIN_CHARS) {
    // A short single titled section is simply a one-chapter book.
    return finishSegmentation({
      chapters: [chapterFromSection(only, 0, pageChars)],
      pageCount: 0,
      segmentation: "structure"
    });
  }

  if (deps.chapterizeModel && parsed.charCount > CHAPTERIZE_MIN_CHARS) {
    const llmChapters = await chapterizeWithModel(only.text, deps.chapterizeModel, deps.language);
    if (llmChapters && llmChapters.length >= 2) {
      return finishSegmentation({
        chapters: llmChapters.map((section, index) => chapterFromSection(section, index, pageChars)),
        pageCount: 0,
        segmentation: "llm"
      });
    }
  }

  // Fixed split: page the whole text, then group pages into parts.
  const pages = splitIntoPages(only.text, pageChars);
  const chapters: ManuscriptChapter[] = [];
  for (let start = 0; start < pages.length; start += FIXED_CHAPTER_PAGES) {
    const slice = pages.slice(start, start + FIXED_CHAPTER_PAGES);
    const title = pages.length <= FIXED_CHAPTER_PAGES ? (only.title ?? "Manuscript") : `Part ${chapters.length + 1}`;
    chapters.push({
      title,
      summary: clipSummary(slice[0]?.markdown ?? "", 300),
      pages: slice.map((page, index) => ({ ...page, title: pageTitle(title, index, slice.length) }))
    });
  }
  return finishSegmentation({ chapters, pageCount: 0, segmentation: "fixed" });
}

function finishSegmentation(segmented: SegmentedManuscript): SegmentedManuscript {
  const chapters = segmented.chapters.filter((chapter) => chapter.pages.length > 0);
  return {
    chapters,
    pageCount: chapters.reduce((sum, chapter) => sum + chapter.pages.length, 0),
    segmentation: segmented.segmentation
  };
}

function chapterFromSection(section: ImportSection, index: number, pageChars: number): ManuscriptChapter {
  const title = section.title?.trim() || `Chapter ${index + 1}`;
  const pages = splitIntoPages(section.text, pageChars);
  return {
    title,
    summary: clipSummary(section.text, 300),
    pages: pages.map((page, pageIndex) => ({ ...page, title: pageTitle(title, pageIndex, pages.length) }))
  };
}

function pageTitle(chapterTitle: string, index: number, total: number): string {
  return total <= 1 ? chapterTitle : `${chapterTitle} · ${index + 1}`;
}

/** Grows the per-page size so long manuscripts stay under the page ceiling. */
function pageChunkChars(totalChars: number): number {
  return Math.max(PAGE_TARGET_CHARS, Math.ceil(totalChars / MANUSCRIPT_MAX_PAGES));
}

function splitIntoPages(text: string, chunkChars: number): Array<{ title: string; markdown: string; summary: string }> {
  const paragraphs = text
    .split(/\n{2,}/)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean)
    .flatMap((paragraph) => (paragraph.length > chunkChars * 1.5 ? hardSplit(paragraph, chunkChars) : [paragraph]));

  const pages: Array<{ title: string; markdown: string; summary: string }> = [];
  let parts: string[] = [];
  let length = 0;
  const flush = () => {
    if (parts.length > 0) {
      const markdown = parts.join("\n\n");
      pages.push({ title: "", markdown, summary: clipSummary(markdown, 240) });
      parts = [];
      length = 0;
    }
  };
  // Pages close only once they reach the chunk size, so every page (except a
  // chapter's last) is at least chunkChars long — which keeps the total page
  // count at or under ceil(totalChars / chunkChars) and thus under the cap.
  for (const paragraph of paragraphs) {
    parts.push(paragraph);
    length += paragraph.length + 2;
    if (length >= chunkChars) {
      flush();
    }
  }
  flush();
  return pages;
}

/** Splits an oversized paragraph at sentence boundaries near the chunk size. */
function hardSplit(paragraph: string, chunkChars: number): string[] {
  const sentences = paragraph.match(/[^.!?…]+[.!?…]+["'”»)]*\s*|[^.!?…]+$/g) ?? [paragraph];
  const chunks: string[] = [];
  let current = "";
  for (const sentence of sentences) {
    if (current && current.length + sentence.length > chunkChars) {
      chunks.push(current.trim());
      current = "";
    }
    current += sentence;
  }
  if (current.trim()) {
    chunks.push(current.trim());
  }
  return chunks;
}

function clipSummary(text: string, max: number): string {
  const condensed = text.replace(/\s+/g, " ").trim();
  if (condensed.length <= max) {
    return condensed;
  }
  const slice = condensed.slice(0, max - 1);
  const lastBreak = Math.max(slice.lastIndexOf(". "), slice.lastIndexOf(" "));
  return `${(lastBreak > max * 0.6 ? slice.slice(0, lastBreak) : slice).trimEnd()}…`;
}

function countWords(text: string): number {
  return text.split(/\s+/).filter(Boolean).length;
}

const chapterizeAiSchema = z
  .object({
    chapters: z
      .array(
        z.object({
          startParagraph: z.number().int().min(0),
          title: z.string().trim().min(1).max(120)
        })
      )
      .min(2)
      .max(120)
  })
  .strict();

/** One cheap model call proposing chapter boundaries for unstructured text. */
async function chapterizeWithModel(
  text: string,
  model: TextModelAdapter,
  language: string | undefined
): Promise<ImportSection[] | null> {
  const paragraphs = text.split(/\n{2,}/).map((paragraph) => paragraph.trim()).filter(Boolean);
  if (paragraphs.length < 4) {
    return null;
  }
  const previews = paragraphs
    .map((paragraph, index) => `${index}: ${paragraph.replace(/\s+/g, " ").slice(0, 90)}`)
    .slice(0, 400)
    .join("\n");
  try {
    const result = await generateJsonWithRetry(model, {
      purpose: "import-chapterize",
      temperature: 0.1,
      maxTokens: 2000,
      schema: chapterizeAiSchema,
      messages: [
        {
          role: "system",
          content:
            "You split an uploaded manuscript into chapters. Given numbered paragraph previews, return the paragraph index where each chapter starts (the first chapter starts at 0) and a short title per chapter, in the manuscript's own language." +
            (language ? ` If the language is unclear, use "${language}".` : "")
        },
        { role: "user", content: previews }
      ]
    });
    const starts = [...result.data.chapters]
      .sort((a, b) => a.startParagraph - b.startParagraph)
      .filter((chapter) => chapter.startParagraph < paragraphs.length);
    if (starts.length < 2 || starts[0]!.startParagraph !== 0) {
      return null;
    }
    return starts.map((chapter, index) => {
      const end = starts[index + 1]?.startParagraph ?? paragraphs.length;
      return {
        title: chapter.title,
        text: paragraphs.slice(chapter.startParagraph, end).join("\n\n")
      };
    });
  } catch {
    return null;
  }
}

export const manuscriptStyleProfileSchema = z
  .object({
    voiceGuide: z.array(z.string().trim().min(1).max(300)).min(1).max(8),
    antiAiRules: z.array(z.string().trim().min(1).max(300)).min(1).max(6),
    tone: z.string().trim().min(1).max(120).default("neutral"),
    pointOfView: z.string().trim().min(1).max(120).default("unknown"),
    tense: z.string().trim().min(1).max(60).default("unknown"),
    audience: z.string().trim().min(1).max(160).default("General readers"),
    writingComplexity: z.coerce.number().int().min(1).max(10).default(6),
    premise: z.string().trim().min(1).max(600),
    detectedLanguage: z.string().trim().min(2).max(40).default("en"),
    sampleExcerpts: z.array(z.string().trim().min(1).max(600)).max(3).default([])
  })
  .strict();

export type ManuscriptStyleProfile = z.infer<typeof manuscriptStyleProfileSchema>;

export type AnalyzeManuscriptStyleDeps = {
  /** Mechanical-tier model; the deterministic fallback runs without it. */
  model?: TextModelAdapter | undefined;
};

/**
 * Distills the author's voice from samples of the manuscript. Never throws:
 * a deterministic profile is returned when no model is available or the
 * call fails, so import always completes.
 */
export async function analyzeManuscriptStyle(
  input: { text: string; language?: string | undefined },
  deps: AnalyzeManuscriptStyleDeps = {}
): Promise<ManuscriptStyleProfile> {
  const fallback = fallbackStyleProfile(input.text, input.language);
  if (!deps.model) {
    return fallback;
  }
  try {
    const result = await generateJsonWithRetry(deps.model, {
      purpose: "import-style-profile",
      temperature: 0.2,
      maxTokens: 1400,
      schema: manuscriptStyleProfileSchema,
      messages: [
        {
          role: "system",
          content:
            "You are a book editor profiling an author's writing style so future chapters can be written in their voice. Analyze the manuscript samples and return: voiceGuide (3-8 concrete style rules an imitating writer must follow), antiAiRules (2-6 rules that prevent generic AI-sounding prose in this book), tone, pointOfView, tense, audience, writingComplexity (1-10), premise (2-3 sentences describing what the book is), detectedLanguage (BCP-47 or English name), and sampleExcerpts (up to 3 short verbatim excerpts that best capture the voice). Write rules in English; quote excerpts verbatim."
        },
        { role: "user", content: styleSample(input.text) }
      ]
    });
    return result.data;
  } catch {
    return fallback;
  }
}

/** Beginning + middle + end samples so the profile sees the whole arc. */
function styleSample(text: string): string {
  const third = Math.floor(STYLE_SAMPLE_CHARS / 3);
  if (text.length <= STYLE_SAMPLE_CHARS) {
    return text;
  }
  const middleStart = Math.floor(text.length / 2 - third / 2);
  return [
    `[BEGINNING]\n${text.slice(0, third)}`,
    `[MIDDLE]\n${text.slice(middleStart, middleStart + third)}`,
    `[END]\n${text.slice(-third)}`
  ].join("\n\n");
}

function fallbackStyleProfile(text: string, language: string | undefined): ManuscriptStyleProfile {
  return manuscriptStyleProfileSchema.parse({
    voiceGuide: [
      "Match the vocabulary, sentence rhythm, and tone of the manuscript's existing chapters.",
      "Keep narration consistent with the manuscript's established point of view and tense.",
      "Reuse the manuscript's names, terms, and phrasing exactly as the author wrote them."
    ],
    antiAiRules: [
      "No generic filler transitions; keep the author's natural cadence.",
      "Never recap earlier chapters inside the prose."
    ],
    premise: clipSummary(text, 400) || "An imported manuscript.",
    ...(language ? { detectedLanguage: language } : {}),
    sampleExcerpts: [clipSummary(text.slice(0, 1200), 500)].filter(Boolean)
  });
}

/**
 * Builds a bookPlanSchema-valid plan for an imported manuscript without any
 * model call, so every existing plan-dependent path (edit intents, replans,
 * exports) works on imported books.
 */
export function synthesizeImportedBookPlan(input: {
  title: string;
  subtitle?: string | undefined;
  segmented: SegmentedManuscript;
  style: ManuscriptStyleProfile;
}): BookPlan {
  const continuityRules = [
    input.style.pointOfView !== "unknown" ? `Point of view: ${input.style.pointOfView}.` : null,
    input.style.tense !== "unknown" ? `Narrative tense: ${input.style.tense}.` : null,
    input.style.tone !== "neutral" ? `Tone: ${input.style.tone}.` : null,
    "The imported manuscript text is canonical; never contradict it."
  ].filter((rule): rule is string => rule !== null);

  return bookPlanSchema.parse({
    title: input.title,
    ...(input.subtitle ? { subtitle: input.subtitle } : {}),
    premise: input.style.premise,
    audience: input.style.audience,
    writingComplexity: input.style.writingComplexity,
    voiceGuide: input.style.voiceGuide,
    antiAiRules: input.style.antiAiRules,
    questions: [],
    chapters: input.segmented.chapters.map((chapter, index) => ({
      index: index + 1,
      title: chapter.title,
      summary: chapter.summary || chapter.title,
      targetPages: chapter.pages.length,
      keyBeats: []
    })),
    characters: [],
    locations: [],
    continuityRules,
    researchQueries: [],
    researchNotes: [],
    illustrationPlan: {
      cadence: "manual",
      globalStyle: "No illustrations. Imported manuscript preserved as the author wrote it.",
      characterReferencePrompts: [],
      pageRules: []
    }
  });
}

/** Best available title: explicit override → first section heading → file stem. */
export function deriveManuscriptTitle(options: {
  override?: string | undefined;
  sections: ImportSection[];
  fileName: string;
}): string {
  const override = options.override?.trim();
  if (override) {
    return override.slice(0, 200);
  }
  const first = options.sections[0]?.title?.trim();
  if (first && first.length >= 2 && !/^(chapter|part|prologue)\b/i.test(first)) {
    return first.slice(0, 200);
  }
  const stem = options.fileName.replace(/\.[a-z0-9]+$/i, "").replace(/[_-]+/g, " ").trim();
  return (stem || "Imported manuscript").slice(0, 200);
}
