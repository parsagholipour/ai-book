import JSZip from "jszip";

/**
 * Shared low-level document text extraction used by both creation-chat
 * attachments (bounded digests) and manuscript import (full-length text).
 * Pure text utilities only — no size policy lives here; callers bound the
 * output to their own limits.
 */

export type DocumentTextErrorCode = "UNREADABLE_FILE";

export class DocumentTextError extends Error {
  readonly code: DocumentTextErrorCode;

  constructor(code: DocumentTextErrorCode, message: string) {
    super(message);
    this.name = "DocumentTextError";
    this.code = code;
  }
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

export async function loadZip(data: Buffer, label: string): Promise<JSZip> {
  try {
    return await JSZip.loadAsync(data);
  } catch {
    throw new DocumentTextError("UNREADABLE_FILE", `That ${label} could not be opened.`);
  }
}

export async function extractDocxText(data: Buffer): Promise<string> {
  const documentXml = await readDocxDocumentXml(data);
  return docxXmlToText(documentXml);
}

export async function readDocxDocumentXml(data: Buffer): Promise<string> {
  const zip = await loadZip(data, "Word document");
  const documentXml = await zip.file("word/document.xml")?.async("string");
  if (!documentXml) {
    throw new DocumentTextError("UNREADABLE_FILE", "That Word document could not be read.");
  }
  return documentXml;
}

export function docxXmlToText(documentXml: string): string {
  return documentXml
    .replace(/<w:p\b[^>]*>/g, "\n")
    .replace(/<w:tab\b[^>]*\/>/g, "\t")
    .replace(/<w:br\b[^>]*\/>/g, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
}

export type ExtractEpubTextOptions = {
  /** Stop concatenating chapters once the combined text exceeds this length. */
  maxChars?: number | undefined;
};

export async function extractEpubText(data: Buffer, options: ExtractEpubTextOptions = {}): Promise<string> {
  const zip = await loadZip(data, "EPUB");
  const chapterFiles = await orderedEpubChapterPaths(zip);
  const chapters: string[] = [];
  for (const path of chapterFiles) {
    const html = await zip.file(path)?.async("string");
    if (html) {
      const text = stripHtml(html);
      if (text.trim()) {
        chapters.push(text.trim());
      }
    }
    if (options.maxChars !== undefined && chapters.join("\n\n").length > options.maxChars) {
      break;
    }
  }
  if (chapters.length === 0) {
    throw new DocumentTextError("UNREADABLE_FILE", "No readable chapters were found in that EPUB.");
  }
  return chapters.join("\n\n");
}

/**
 * Reading order of an EPUB's content documents: OPF spine order when the
 * package metadata parses, alphabetical path order as the fallback.
 */
export async function orderedEpubChapterPaths(zip: JSZip): Promise<string[]> {
  const allHtml = Object.keys(zip.files).filter(
    (path) => /\.(x?html?)$/i.test(path) && !zip.files[path]!.dir
  );
  const spine = await epubSpinePaths(zip);
  if (spine.length === 0) {
    return allHtml.sort();
  }
  const spineSet = new Set(spine);
  // Spine first (in order), then any readable HTML the spine missed.
  return [...spine, ...allHtml.filter((path) => !spineSet.has(path)).sort()];
}

async function epubSpinePaths(zip: JSZip): Promise<string[]> {
  try {
    const container = await zip.file("META-INF/container.xml")?.async("string");
    const opfPath = container?.match(/full-path="([^"]+)"/)?.[1];
    if (!opfPath) {
      return [];
    }
    const opf = await zip.file(opfPath)?.async("string");
    if (!opf) {
      return [];
    }
    const opfDir = opfPath.includes("/") ? opfPath.slice(0, opfPath.lastIndexOf("/") + 1) : "";

    const manifest = new Map<string, string>();
    for (const item of opf.matchAll(/<item\b[^>]*>/gi)) {
      const tag = item[0];
      const id = tag.match(/\bid="([^"]+)"/i)?.[1];
      const href = tag.match(/\bhref="([^"]+)"/i)?.[1];
      if (id && href) {
        manifest.set(id, resolveEpubPath(opfDir, decodeURIComponent(href)));
      }
    }

    const paths: string[] = [];
    for (const ref of opf.matchAll(/<itemref\b[^>]*>/gi)) {
      const idref = ref[0].match(/\bidref="([^"]+)"/i)?.[1];
      const path = idref ? manifest.get(idref) : undefined;
      if (path && /\.(x?html?)$/i.test(path) && zip.file(path)) {
        paths.push(path);
      }
    }
    return paths;
  } catch {
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

export function stripHtml(html: string): string {
  return html
    .replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, " ")
    .replace(/<(br|\/p|\/div|\/h[1-6]|\/li|\/tr)\b[^>]*>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
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
