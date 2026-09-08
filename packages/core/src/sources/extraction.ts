import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { CreationAttachmentError, detectCreationAttachmentType, type IngestCreationAttachmentInput } from "../ingestion/creationAttachments.js";
import { decodeUtf8, extractDocxText, extractEpubText, stripHtml, stripRtf } from "../ingestion/documentText.js";
import { SOURCE_CHUNK_CHARACTERS, SOURCE_MAX_CHARACTERS, SOURCE_MAX_PDF_PAGES, type SourceSection } from "./types.js";

const run = promisify(execFile);
export type SourceOcr = (data: Buffer, mimeType: string) => Promise<{ content: string; unreadable: string[]; inputTokens?: number; outputTokens?: number }>;
export type ExtractSourceOptions = {
  ocr?: SourceOcr | undefined;
  completed?: SourceSection[] | undefined;
  checkpoint: (section: SourceSection, total: number) => Promise<void>;
};
export function assertSourceSize(length: number): void {
  if (length > SOURCE_MAX_CHARACTERS) throw new CreationAttachmentError("FILE_TOO_LARGE", "Documents may contain up to 1.5 million extracted characters. Split this document before uploading.");
}
export function chunkSourceSection(section: SourceSection): Array<{ ordinal: number; section: number; locator: string; content: string }> {
  const chunks = [];
  for (let start = 0, part = 0; start < section.content.length; part++) {
    let end = Math.min(start + SOURCE_CHUNK_CHARACTERS, section.content.length);
    if (end < section.content.length) {
      const boundary = section.content.lastIndexOf("\n", end);
      if (boundary > start + SOURCE_CHUNK_CHARACTERS / 2) end = boundary + 1;
    }
    const heading = [...section.content.slice(0, end).matchAll(/^#{1,6}\s+(.+)$/gm)].at(-1)?.[1];
    chunks.push({ ordinal: section.section * 1000 + part, section: section.section, locator: `${section.locator}${heading ? ` / ${heading.slice(0, 160)}` : ""} · passage ${part + 1}`, content: section.content.slice(start, end) });
    start = end;
  }
  return chunks;
}

/** Extraction never summarizes, truncates, or silently skips a page. */
export async function extractSource(input: IngestCreationAttachmentInput, options: ExtractSourceOptions): Promise<SourceSection[]> {
  const type = detectCreationAttachmentType(input.name, input.mimeType);
  if (!type) throw new CreationAttachmentError("UNSUPPORTED_TYPE", "That file type is not supported.");
  if (type.format === "pdf") return extractPdf(input.data, options);
  const prior = options.completed?.find((section) => section.section === 0 && !section.unreadable);
  if (prior) return [prior];
  let text: string;
  let unreadable: string | undefined;
  if (type.format === "image") {
    if (!options.ocr) throw new CreationAttachmentError("INGESTION_UNAVAILABLE", "Reading photos is unavailable. Retry when reading is available.");
    const result = await options.ocr(input.data, type.mimeType);
    text = result.content;
    unreadable = result.unreadable.join("; ") || undefined;
  } else if (type.format === "docx") text = await extractDocxText(input.data);
  else if (type.format === "epub") text = await extractEpubText(input.data);
  else {
    text = decodeUtf8(input.data);
    if (type.format === "html") text = stripHtml(text);
    if (type.format === "rtf") text = stripRtf(text);
  }
  // Preserve tabs/table columns and all headings. Only normalize line endings.
  text = text.replace(/\r\n?/g, "\n").trim();
  assertSourceSize(text.length);
  const section: SourceSection = { section: 0, locator: "Document", content: text, ...(!text || unreadable ? { unreadable: unreadable || "No readable text found" } : {}) };
  await options.checkpoint(section, 1);
  return [section];
}

async function extractPdf(data: Buffer, options: ExtractSourceOptions): Promise<SourceSection[]> {
  const directory = await mkdtemp(join(tmpdir(), "book-source-"));
  try {
    const path = join(directory, "source.pdf");
    await writeFile(path, data);
    const info = await run("pdfinfo", [path], { timeout: 30_000 });
    const pages = Number(info.stdout.match(/^Pages:\s+(\d+)/m)?.[1]);
    if (!pages) throw new CreationAttachmentError("UNREADABLE_FILE", "The PDF page count could not be read.");
    if (pages > SOURCE_MAX_PDF_PAGES) throw new CreationAttachmentError("FILE_TOO_LARGE", "PDFs may contain up to 600 pages. Split this PDF before uploading.");
    const native = await run("pdftotext", ["-layout", "-enc", "UTF-8", path, "-"], { timeout: 60_000, maxBuffer: SOURCE_MAX_CHARACTERS * 6 });
    assertSourceSize(native.stdout.replace(/\f/g, "").length);
    const pageText = native.stdout.split("\f");
    const images = await run("pdfimages", ["-list", path], { timeout: 30_000 });
    const imagePages = new Set([...images.stdout.matchAll(/^\s*(\d+)\s+\d+\s+image\s/gm)].map((match) => Number(match[1])));
    const sections: SourceSection[] = [];
    let characters = 0;
    // Two page-scoped OCR calls maximum. Native text is retained if OCR fails.
    for (let first = 1; first <= pages; first += 2) {
      const batch = await Promise.all(Array.from({ length: Math.min(2, pages - first + 1) }, async (_, offset) => {
        const page = first + offset;
        const existing = options.completed?.find((section) => section.section === page && !section.unreadable);
        if (existing) return existing;
        const content = (pageText[page - 1] ?? "").trim();
        const section: SourceSection = { section: page, locator: `Page ${page}`, content };
        const broken = content.length < 30 || (content.match(/\ufffd/g)?.length ?? 0) > content.length * 0.02;
        if (broken || imagePages.has(page)) {
          if (!options.ocr) section.unreadable = `Page ${page}: visual content could not be read; OCR unavailable`;
          else {
            try {
              await run("pdfseparate", ["-f", String(page), "-l", String(page), path, join(directory, "page-%d.pdf")], { timeout: 30_000 });
              const result = await options.ocr(await readFile(join(directory, `page-${page}.pdf`)), "application/pdf");
              if (result.content.trim()) section.content = result.content;
              if (result.unreadable.length) section.unreadable = `Page ${page}: ${result.unreadable.join("; ")}`;
              else if (!section.content.trim()) section.content = "[Blank page]";
            } catch {
              section.unreadable = `Page ${page}: visual extraction failed; any native text is retained`;
            }
          }
        }
        return section;
      }));
      for (const section of batch) {
        characters += section.content.length;
        assertSourceSize(characters);
        await options.checkpoint(section, pages);
        sections.push(section);
      }
    }
    return sections;
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
