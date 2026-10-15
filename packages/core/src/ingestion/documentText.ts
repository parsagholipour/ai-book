import JSZip from "jszip";
import { replaceMarkupElements, replaceTags, throughLastTag, type MarkupElementKind } from "./markupScan.js";
import { inspectZipDirectory, type ZipDirectoryLimits } from "./zipDirectory.js";

/**
 * Shared low-level document text extraction used by both creation-chat
 * attachments (bounded digests) and manuscript import (full-length text).
 * Pure text utilities; callers bound the output to their own limits. The one
 * size policy here is how far an archive may inflate, because nothing after
 * the inflater can take that back.
 */

export type DocumentTextErrorCode = "UNREADABLE_FILE" | "FILE_TOO_LARGE";

export class DocumentTextError extends Error {
  readonly code: DocumentTextErrorCode;

  constructor(code: DocumentTextErrorCode, message: string) {
    super(message);
    this.name = "DocumentTextError";
    this.code = code;
  }
}

/**
 * How far one file inside an uploaded .docx or .epub may inflate. A zip's
 * headers state each entry's size and nothing holds the inflater to them — a
 * 306 KB .docx whose document.xml inflated to 300 MB ran the API out of heap —
 * so the bytes are counted as they come out, and the read stops at the limit.
 * The longest manuscript an import keeps (1.5M characters, about 600 pages)
 * is 4.7 MB of this compiler's Word XML (measured), and by estimate 15–20 MB
 * from Word with its runs split by every edit; 64 MiB is several times the
 * larger. It is not
 * free: stripping tags from markup costs many times its size in heap, so this
 * is also what one upload may make the API read in a single pass.
 */
export const DOCUMENT_ENTRY_MAX_BYTES = 64 * 1024 * 1024;
/**
 * One EPUB content document. A whole 600-page book in a single XHTML file is
 * about 5 MB; a 120 MB chapter took 8 s and 1.7 GB of heap to strip.
 */
export const EPUB_DOCUMENT_MAX_BYTES = 16 * 1024 * 1024;
/** Every file one upload's parse reads, together: an EPUB's chapters, or a Word document and its metadata. */
export const DOCUMENT_ARCHIVE_MAX_BYTES = 128 * 1024 * 1024;
/** Files one archive may hold. A long fixed-layout EPUB, a page and a picture per sheet, has a few thousand. */
export const DOCUMENT_ARCHIVE_MAX_ENTRIES = 10_000;
/**
 * The central directory one archive may declare: a kilobyte a file at the
 * most files. A real entry's header is its path, a few dozen bytes of extra
 * fields and 46 bytes more, so ten thousand of them come to one or two MB.
 */
export const DOCUMENT_ARCHIVE_DIRECTORY_MAX_BYTES = DOCUMENT_ARCHIVE_MAX_ENTRIES * 1024;
/**
 * Extra fields across one archive's directory, eight a file at the most
 * files. A real entry carries at most four (Unix times and ids, NTFS times,
 * ZIP64 sizes); JSZip keeps each one as an object and a Buffer view, about
 * 165 bytes, so this is 13 MB of heap at the most.
 */
export const DOCUMENT_ARCHIVE_MAX_EXTRA_FIELDS = DOCUMENT_ARCHIVE_MAX_ENTRIES * 8;
/** A metadata file parsed into a whole element tree (Word's core properties run to a few KB). */
export const DOCUMENT_METADATA_MAX_BYTES = 1024 * 1024;

export type DocumentArchiveLimits = {
  /** A tighter total than `DOCUMENT_ARCHIVE_MAX_BYTES` for a caller that keeps less of the file. */
  maxArchiveBytes?: number | undefined;
};

/** The start of one archived file, and whether that start is all of it. */
export type DocumentFilePrefix = { text: string; complete: boolean };

/**
 * An uploaded .docx or .epub, read one file at a time within the limits
 * above. Past one, the read stops where it is and the reader is told the file
 * is too large — never a crash, and never a guess from a header.
 */
export class DocumentArchive {
  private inflated = 0;

  private constructor(
    private readonly zip: JSZip,
    private readonly label: string,
    private readonly maxArchiveBytes: number
  ) {}

  static async open(data: Buffer, label: string, limits: DocumentArchiveLimits = {}): Promise<DocumentArchive> {
    // JSZip builds every entry before anything can count them, so the
    // directory is measured first, in the bytes, by what JSZip would build.
    const directory = inspectZipDirectory(data, DOCUMENT_ARCHIVE_DIRECTORY_LIMITS);
    if (!directory.readable) throw directory.reason === "too_large" ? archiveTooLarge(label) : archiveUnreadable(label);
    let zip: JSZip;
    try {
      zip = await JSZip.loadAsync(data);
    } catch {
      throw archiveUnreadable(label);
    }
    if (Object.keys(zip.files).length > DOCUMENT_ARCHIVE_MAX_ENTRIES) throw archiveTooLarge(label);
    return new DocumentArchive(zip, label, Math.min(limits.maxArchiveBytes ?? DOCUMENT_ARCHIVE_MAX_BYTES, DOCUMENT_ARCHIVE_MAX_BYTES));
  }

  /** Every file's path, folders left out, in the archive's own order. */
  paths(): string[] {
    return Object.keys(this.zip.files).filter((path) => !this.zip.files[path]!.dir);
  }

  has(path: string): boolean {
    return this.zip.file(path) !== null;
  }

  /**
   * One file's text as UTF-8, or `undefined` when the archive has no such
   * file. `maxBytes` narrows the per-file limit for a file read into a tree
   * rather than scanned, where every element costs far more than its bytes.
   */
  async text(path: string, maxBytes = DOCUMENT_ENTRY_MAX_BYTES): Promise<string | undefined> {
    const file = this.zip.file(path);
    if (!file) return undefined;
    const limit = Math.min(maxBytes, DOCUMENT_ENTRY_MAX_BYTES, this.maxArchiveBytes - this.inflated);
    const { bytes } = await inflateWithin(file, limit, this.label, false);
    this.inflated += bytes.length;
    return bytes.toString("utf8");
  }

  /**
   * As much of one file as the archive's total has left, for a caller that
   * keeps only the start of it: where `text` refuses a file past a limit, this
   * stops the inflater there and answers the start with `complete: false`.
   * A multi-byte character cut at the end decodes to U+FFFD.
   */
  async textPrefix(path: string): Promise<DocumentFilePrefix | undefined> {
    const file = this.zip.file(path);
    if (!file) return undefined;
    const limit = Math.min(DOCUMENT_ENTRY_MAX_BYTES, this.maxArchiveBytes - this.inflated);
    const { bytes, complete } = await inflateWithin(file, limit, this.label, true);
    this.inflated += bytes.length;
    return { text: bytes.toString("utf8"), complete };
  }
}

const DOCUMENT_ARCHIVE_DIRECTORY_LIMITS: ZipDirectoryLimits = {
  maxEntries: DOCUMENT_ARCHIVE_MAX_ENTRIES,
  maxDirectoryBytes: DOCUMENT_ARCHIVE_DIRECTORY_MAX_BYTES,
  maxExtraFields: DOCUMENT_ARCHIVE_MAX_EXTRA_FIELDS
};

function archiveTooLarge(label: string): DocumentTextError {
  return new DocumentTextError("FILE_TOO_LARGE", `That ${label} is too large to read. Split it into smaller files and try again.`);
}

function archiveUnreadable(label: string): DocumentTextError {
  return new DocumentTextError("UNREADABLE_FILE", `That ${label} could not be opened.`);
}

/** JSZip's documented `internalStream`, which its typings leave out. */
type StreamingZipEntry = { internalStream(type: "uint8array"): JSZip.JSZipStreamHelper<Uint8Array> };

/**
 * The entry's bytes, stopped the moment more than `limit` of them have come
 * out of the inflater: refused, or with `keepPrefix` answered with the first
 * `limit` bytes and `complete: false`.
 */
function inflateWithin(
  file: JSZip.JSZipObject,
  limit: number,
  label: string,
  keepPrefix: boolean
): Promise<{ bytes: Buffer; complete: boolean }> {
  return new Promise((resolve, reject) => {
    const chunks: Uint8Array[] = [];
    let size = 0;
    let settled = false;
    const stream = (file as unknown as StreamingZipEntry).internalStream("uint8array");
    stream
      .on("data", (chunk) => {
        if (settled) return;
        if (size + chunk.length > limit) {
          settled = true;
          // Pausing stops JSZip's inflater after the chunk it is on. A throw
          // here would surface inside JSZip's setImmediate tick, uncaught.
          stream.pause();
          if (keepPrefix) {
            chunks.push(chunk.subarray(0, limit - size));
            resolve({ bytes: Buffer.concat(chunks, limit), complete: false });
          } else {
            chunks.length = 0;
            reject(archiveTooLarge(label));
          }
          return;
        }
        size += chunk.length;
        chunks.push(chunk);
      })
      .on("error", (error) => {
        if (settled) return;
        settled = true;
        reject(error);
      })
      .on("end", () => {
        if (settled) return;
        settled = true;
        resolve({ bytes: Buffer.concat(chunks, size), complete: true });
      })
      .resume();
  });
}

export function decodeUtf8(data: Buffer): string {
  const text = data.toString("utf8");
  // A UTF-16 file decoded as UTF-8 is mostly NUL bytes; re-decode it instead.
  const nulRatio = (text.match(/\u0000/g)?.length ?? 0) / Math.max(1, text.length);
  if (nulRatio > 0.1) {
    return data.toString("utf16le");
  }
  return text.replace(/^﻿/, "");
}

export async function extractDocxText(data: Buffer): Promise<string> {
  const documentXml = await readDocxDocumentXml(data);
  return docxXmlToText(documentXml);
}

export async function readDocxDocumentXml(data: Buffer): Promise<string> {
  const archive = await DocumentArchive.open(data, "Word document");
  const documentXml = await archive.text("word/document.xml");
  if (!documentXml) {
    throw new DocumentTextError("UNREADABLE_FILE", "That Word document could not be read.");
  }
  return documentXml;
}

/** `<w:tab/>` and `<w:br/>` read as `<x\b[^>]*\/>`: the tag through its `>`, kept unless it closes itself. */
function selfClosing(replacement: string): (tag: string) => string {
  return (tag) => (tag.endsWith("/>") ? replacement : tag);
}

export function docxXmlToText(documentXml: string): string {
  const paragraphs = replaceTags(documentXml, /<w:p\b[^>]*>/g, "\n").replace(/<\/w:tc>/g, "\t").replace(/<\/w:tr>/g, "\n");
  const breaks = replaceTags(replaceTags(paragraphs, /<w:tab\b[^>]*>/g, selfClosing("\t")), /<w:br\b[^>]*>/g, selfClosing("\n"));
  return replaceTags(breaks, /<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
}

/** Text read from the start of a document, and whether it is the whole document. */
export type BoundedDocumentText = { text: string; complete: boolean };

/**
 * How much of an upload a caller that keeps only its start will read. Both
 * limits stop the read where it is rather than refusing the file; the caller
 * decides what a start with no text in it means.
 */
export type DocumentTextBudget = {
  /**
   * Bytes inflated from the whole archive: a Word body, or an EPUB's package
   * files and chapters together. A package file past it is refused, since
   * nothing can be read without it.
   */
  maxBytes: number;
  /** Characters of text (as `normalizeExtractedText` leaves them) after which reading stops. */
  maxChars: number;
};

/** One `docxXmlToText` call's share of a bounded read; each slice is extended to the next paragraph close. */
const DOCX_SLICE_CHARS = 64 * 1024;
const DOCX_PARAGRAPH_CLOSE = "</w:p>";

/**
 * The start of a Word document's text: `word/document.xml` inflated no further
 * than the budget's bytes, then converted a slice at a time until the
 * budget's characters are out. A 225 KB .docx can inflate to 63 MB, and
 * converting all of it to keep 12,000 characters held the API's thread for
 * 2.5 s.
 */
export async function extractDocxTextWithin(data: Buffer, budget: DocumentTextBudget): Promise<BoundedDocumentText> {
  const archive = await DocumentArchive.open(data, "Word document", { maxArchiveBytes: budget.maxBytes });
  const entry = await archive.textPrefix("word/document.xml");
  if (!entry) {
    throw new DocumentTextError("UNREADABLE_FILE", "That Word document could not be read.");
  }
  const xml = entry.complete ? entry.text : throughLastParagraph(entry.text);
  const converted = docxXmlToTextWithin(xml, budget.maxChars);
  return { text: converted.text, complete: entry.complete && converted.complete };
}

/** A cut Word body ends mid-paragraph, perhaps mid-tag or mid-character: only its whole paragraphs are kept. */
function throughLastParagraph(xml: string): string {
  const close = xml.lastIndexOf(DOCX_PARAGRAPH_CLOSE);
  return close === -1 ? "" : xml.slice(0, close + DOCX_PARAGRAPH_CLOSE.length);
}

/**
 * `docxXmlToText` over the start of `xml`, stopping once more than `maxChars`
 * of text are out. Every slice ends just after a `</w:p>`, which no tag or
 * entity spans, so the slices convert to exactly what the whole would.
 */
export function docxXmlToTextWithin(xml: string, maxChars: number): BoundedDocumentText {
  const parts: string[] = [];
  let kept = 0;
  let start = 0;
  while (start < xml.length) {
    if (kept > maxChars) return { text: parts.join(""), complete: false };
    let end = start + DOCX_SLICE_CHARS;
    if (end >= xml.length) {
      end = xml.length;
    } else {
      const close = xml.indexOf(DOCX_PARAGRAPH_CLOSE, end);
      end = close === -1 ? xml.length : close + DOCX_PARAGRAPH_CLOSE.length;
    }
    const text = docxXmlToText(xml.slice(start, end));
    parts.push(text);
    kept += normalizeExtractedText(text).length;
    start = end;
  }
  return { text: parts.join(""), complete: true };
}

export type ExtractEpubTextOptions = {
  /** Stop concatenating chapters once the combined text exceeds this length. */
  maxChars?: number | undefined;
};

export async function extractEpubText(data: Buffer, options: ExtractEpubTextOptions = {}): Promise<string> {
  const archive = await DocumentArchive.open(data, "EPUB");
  const read = await joinEpubChapters(archive, options.maxChars, async (path) => {
    const html = await archive.text(path, EPUB_DOCUMENT_MAX_BYTES);
    return html === undefined ? undefined : { text: html, complete: true };
  });
  return read.text;
}

/**
 * The start of an EPUB's text: chapters joined until the budget's characters
 * are out or its bytes are spent, and the chapter the bytes ran out in is the
 * last one read, so the text is one unbroken start of the book.
 */
export async function extractEpubTextWithin(data: Buffer, budget: DocumentTextBudget): Promise<BoundedDocumentText> {
  const archive = await DocumentArchive.open(data, "EPUB", { maxArchiveBytes: budget.maxBytes });
  return joinEpubChapters(archive, budget.maxChars, async (path) => {
    const chapter = await archive.textPrefix(path);
    // A cut chapter may end inside a tag: keep it only through its last one.
    return chapter && !chapter.complete ? { text: throughLastTag(chapter.text), complete: false } : chapter;
  });
}

async function joinEpubChapters(
  archive: DocumentArchive,
  maxChars: number | undefined,
  read: (path: string) => Promise<DocumentFilePrefix | undefined>
): Promise<BoundedDocumentText> {
  const chapterFiles = await orderedEpubChapterPaths(archive);
  const chapters: string[] = [];
  // The length `chapters.join("\n\n")` would have, kept as it grows.
  let joinedLength = 0;
  let complete = true;
  for (const [position, path] of chapterFiles.entries()) {
    const chapter = await read(path);
    if (chapter) {
      const text = stripHtml(chapter.text);
      if (text.trim()) {
        chapters.push(text.trim());
        joinedLength += text.trim().length + (chapters.length > 1 ? 2 : 0);
      }
      if (!chapter.complete) {
        complete = false;
        break;
      }
    }
    if (maxChars !== undefined && joinedLength > maxChars) {
      complete = position === chapterFiles.length - 1;
      break;
    }
  }
  if (chapters.length === 0) {
    // Nothing readable in the part that was read is a file too large to read, not an empty one.
    if (!complete) throw archiveTooLarge("EPUB");
    throw new DocumentTextError("UNREADABLE_FILE", "No readable chapters were found in that EPUB.");
  }
  return { text: chapters.join("\n\n"), complete };
}

/**
 * Reading order of an EPUB's content documents: OPF spine order when the
 * package metadata parses, alphabetical path order as the fallback.
 */
export async function orderedEpubChapterPaths(archive: DocumentArchive): Promise<string[]> {
  const allHtml = archive.paths().filter((path) => /\.(x?html?)$/i.test(path));
  const spine = await epubSpinePaths(archive);
  if (spine.length === 0) {
    return allHtml.sort();
  }
  const spineSet = new Set(spine);
  // Spine first (in order), then any readable HTML the spine missed.
  return [...spine, ...allHtml.filter((path) => !spineSet.has(path)).sort()];
}

async function epubSpinePaths(archive: DocumentArchive): Promise<string[]> {
  try {
    const container = await archive.text("META-INF/container.xml");
    const opfPath = container?.match(/full-path="([^"]+)"/)?.[1];
    if (!opfPath) {
      return [];
    }
    const opf = await archive.text(opfPath);
    if (!opf) {
      return [];
    }
    const opfDir = opfPath.includes("/") ? opfPath.slice(0, opfPath.lastIndexOf("/") + 1) : "";
    const tags = throughLastTag(opf);

    const manifest = new Map<string, string>();
    for (const item of tags.matchAll(/<item\b[^>]*>/gi)) {
      const tag = item[0];
      const id = tag.match(/\bid="([^"]+)"/i)?.[1];
      const href = tag.match(/\bhref="([^"]+)"/i)?.[1];
      if (id && href) {
        manifest.set(id, resolveEpubPath(opfDir, decodeURIComponent(href)));
      }
    }

    const paths: string[] = [];
    for (const ref of tags.matchAll(/<itemref\b[^>]*>/gi)) {
      const idref = ref[0].match(/\bidref="([^"]+)"/i)?.[1];
      const path = idref ? manifest.get(idref) : undefined;
      if (path && /\.(x?html?)$/i.test(path) && archive.has(path)) {
        paths.push(path);
      }
    }
    return paths;
  } catch (error) {
    // A package file past the inflate limit refuses the upload, as a chapter would.
    if (error instanceof DocumentTextError) throw error;
    return [];
  }
}

function resolveEpubPath(baseDir: string, href: string): string {
  const joined = `${baseDir}${href}`.split("/");
  const resolved: string[] = [];
  for (const part of joined) {
    if (part === "..") {
      resolved.pop();
    } else if (part !== "." && part !== "") {
      resolved.push(part);
    }
  }
  return resolved.join("/");
}

/** `<(script|style)\b[\s\S]*?<\/\1>`, case-insensitive. */
const SCRIPT_AND_STYLE: readonly MarkupElementKind[] = [
  { open: /<script\b/gi, close: "</script>" },
  { open: /<style\b/gi, close: "</style>" }
];

export function stripHtml(html: string): string {
  const withoutCode = replaceMarkupElements(html, SCRIPT_AND_STYLE, () => " ");
  return replaceTags(replaceTags(withoutCode, /<(br|\/p|\/div|\/h[1-6]|\/li|\/tr)\b[^>]*>/gi, "\n"), /<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#(\d+);/g, (_, code: string) => safeFromCharCode(Number.parseInt(code, 10)));
}

function safeFromCharCode(code: number): string {
  return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : " ";
}

export function stripRtf(rtf: string): string {
  return rtf
    .replace(/\\par[d]?\b/g, "\n")
    .replace(/\\'([0-9a-f]{2})/gi, (_, hex: string) => String.fromCharCode(Number.parseInt(hex, 16)))
    .replace(/\\[a-z]+-?\d*\s?/gi, " ")
    .replace(/[{}]/g, "");
}

export function normalizeExtractedText(text: string): string {
  return text
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
