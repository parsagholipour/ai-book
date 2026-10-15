import { deflateRawSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import {
  CREATION_ATTACHMENT_CONTENT_MAX,
  CREATION_ATTACHMENT_READ_MAX_BYTES,
  CreationAttachmentError,
  ingestCreationAttachment
} from "./creationAttachments.js";
import { docxXmlToText, docxXmlToTextWithin, extractDocxText, normalizeExtractedText } from "./documentText.js";
import { LINEAR_TIME_CEILING_MS } from "./testing/linearTime.js";
import { wordBomb, zeroBomb, zipArchive } from "./testing/zipArchive.js";

const MIB = 1024 * 1024;
const TOO_LARGE = "That file is too large to read in the chat. Paste the part you need into a message, or attach a smaller file.";

/** A Word body of `bytes` bytes of numbered paragraphs, honestly zipped. */
function wordFile(bytes: number): Buffer {
  const paragraphs: string[] = [];
  let length = 0;
  for (let index = 0; length < bytes; index += 1) {
    const paragraph = `<w:p><w:r><w:t>Paragraph ${index} of the manuscript.</w:t></w:r></w:p>`;
    paragraphs.push(paragraph);
    length += paragraph.length;
  }
  const xml = `<w:document><w:body>${paragraphs.join("")}</w:body></w:document>`;
  return zipArchive([{ path: "word/document.xml", deflated: deflateRawSync(Buffer.from(xml)), claimedSize: xml.length }]);
}

function epubFile(chapters: Array<{ path: string; text?: string; deflated?: Buffer; claimedSize?: number }>): Buffer {
  return zipArchive(chapters.map((chapter) =>
    chapter.text === undefined
      ? { path: chapter.path, deflated: chapter.deflated!, claimedSize: chapter.claimedSize ?? 1 }
      : { path: chapter.path, deflated: deflateRawSync(Buffer.from(chapter.text)), claimedSize: Buffer.byteLength(chapter.text) }
  ));
}

async function refusal(data: Buffer, name: string): Promise<{ code: string; message: string }> {
  const error = await ingestCreationAttachment({ data, name }).catch((caught: unknown) => caught);
  expect(error).toBeInstanceOf(CreationAttachmentError);
  return { code: (error as CreationAttachmentError).code, message: (error as CreationAttachmentError).message };
}

async function ingestMs(data: Buffer, name: string): Promise<number> {
  let best = Number.POSITIVE_INFINITY;
  for (let read = 0; read < 2; read += 1) {
    const started = performance.now();
    await ingestCreationAttachment({ data, name }).catch(() => undefined);
    best = Math.min(best, performance.now() - started);
  }
  return best;
}

describe("chat attachment read limits", () => {
  it("refuses a Word body with nothing readable before the limit, whatever its header claims", async () => {
    // 2 GiB of zeros behind a header claiming 1,000 bytes: the inflater stops
    // at the attachment's limit and finds no paragraph in it.
    const started = performance.now();
    expect(await refusal(wordBomb(2048), "notes.docx")).toEqual({ code: "FILE_TOO_LARGE", message: TOO_LARGE });
    expect(performance.now() - started).toBeLessThan(2_000);
  });

  it("reads a Word body past the limit from its start, and says it was cut", async () => {
    const data = wordFile(CREATION_ATTACHMENT_READ_MAX_BYTES + 2 * MIB);
    const attachment = await ingestCreationAttachment({ data, name: "long.docx" });
    expect(attachment.content.startsWith("Paragraph 0 of the manuscript.")).toBe(true);
    expect(attachment.content.length).toBeLessThanOrEqual(CREATION_ATTACHMENT_CONTENT_MAX);
    expect(attachment.truncated).toBe(true);
  });

  it("keeps a Word body just under the limit exactly as reading it whole would", async () => {
    const data = wordFile(CREATION_ATTACHMENT_READ_MAX_BYTES - 64 * 1024);
    const attachment = await ingestCreationAttachment({ data, name: "draft.docx" });
    expect(normalizeExtractedText(await extractDocxText(data)).startsWith(attachment.content)).toBe(true);
    expect(attachment.content.startsWith("Paragraph 0 of the manuscript.\nParagraph 1 of the manuscript.")).toBe(true);
    expect(attachment.content.length).toBeLessThanOrEqual(CREATION_ATTACHMENT_CONTENT_MAX);
    expect(attachment.content.length).toBeGreaterThan(CREATION_ATTACHMENT_CONTENT_MAX * 0.8);
    expect(attachment.truncated).toBe(true);
  });

  it("converts a Word body in slices to exactly what the whole converts to", () => {
    const xml = Array.from({ length: 6_000 }, (_, index) =>
      `<w:p w:rsidR="${index}"><w:r><w:t>Line ${index} &amp; more</w:t><w:tab/><w:br/></w:r></w:p><w:tbl><w:tr><w:tc><w:p><w:r><w:t>c${index}</w:t></w:r></w:p></w:tc></w:tr></w:tbl>`
    ).join("");
    expect(xml.length).toBeGreaterThan(3 * 64 * 1024);
    expect(docxXmlToTextWithin(xml, Number.POSITIVE_INFINITY)).toEqual({ text: docxXmlToText(xml), complete: true });
    const bounded = docxXmlToTextWithin(xml, 1_000);
    expect(bounded.complete).toBe(false);
    expect(docxXmlToText(xml).startsWith(bounded.text)).toBe(true);
    expect(bounded.text.length).toBeLessThan(docxXmlToText(xml).length);
  });

  it("reads a Word attachment in bounded time at any inflated size", async () => {
    // A 225 KB .docx inflating to 63 MB held the API's thread for 2.5 s (2026-10-13).
    for (const bytes of [4 * MIB, 64 * MIB]) {
      const data = wordFile(bytes);
      const ms = await ingestMs(data, "big.docx");
      expect(ms, `${bytes / MIB} MiB of Word XML: ${ms.toFixed(1)} ms`).toBeLessThan(LINEAR_TIME_CEILING_MS);
    }
    // Paragraphs that never close and closes with no text: one slice, or many empty ones.
    for (const xml of ["<w:p>".repeat(800_000), "</w:p>".repeat(650_000)]) {
      const data = zipArchive([{ path: "word/document.xml", deflated: deflateRawSync(Buffer.from(xml)), claimedSize: xml.length }]);
      const ms = await ingestMs(data, "odd.docx");
      expect(ms, `${xml.slice(0, 5)} × ${xml.length / 5}: ${ms.toFixed(1)} ms`).toBeLessThan(LINEAR_TIME_CEILING_MS);
    }
  });

  it("refuses an EPUB whose first chapter has nothing readable before the limit", async () => {
    const data = epubFile([{ path: "chapter.xhtml", deflated: zeroBomb(CREATION_ATTACHMENT_READ_MAX_BYTES / MIB + 1), claimedSize: 10 }]);
    expect(await refusal(data, "book.epub")).toEqual({ code: "FILE_TOO_LARGE", message: TOO_LARGE });
  });

  it("reads an EPUB chapter past the limit from its start and reads no chapter after it", async () => {
    const long = `<html><body><p>Middle words.</p>${"<span></span>".repeat(400_000)}<p>Hidden tail.</p></body></html>`;
    expect(long.length).toBeGreaterThan(CREATION_ATTACHMENT_READ_MAX_BYTES);
    const data = epubFile([
      { path: "a.xhtml", text: "<html><body><p>Opening words.</p></body></html>" },
      { path: "b.xhtml", text: long },
      { path: "c.xhtml", text: "<html><body><p>After words.</p></body></html>" }
    ]);
    const attachment = await ingestCreationAttachment({ data, name: "book.epub" });
    expect(attachment.content).toBe("Opening words.\n\nMiddle words.");
    expect(attachment.truncated).toBe(true);
  });

  it("refuses an EPUB of markup with no text once its bytes are spent, in bounded time", async () => {
    // Empty paragraphs are the most expensive markup to strip: 4 MiB took 300 ms.
    const empty = `<html><body>${"<p></p>".repeat(Math.floor(MIB / 7))}</body></html>`;
    const data = epubFile(Array.from({ length: 8 }, (_, index) => ({ path: `c${index}.xhtml`, text: empty })));
    expect(await refusal(data, "blank.epub")).toEqual({ code: "FILE_TOO_LARGE", message: TOO_LARGE });
    const ms = await ingestMs(data, "blank.epub");
    expect(ms, `8 MiB of empty paragraphs: ${ms.toFixed(1)} ms`).toBeLessThan(LINEAR_TIME_CEILING_MS);
  });

  it("reads only the start of a long text file and says it was cut", async () => {
    const line = "A line of the manuscript.\n";
    const data = Buffer.from(line.repeat(Math.ceil((CREATION_ATTACHMENT_READ_MAX_BYTES + MIB) / line.length)));
    const ms = await ingestMs(data, "notes.txt");
    expect(ms, `${(data.length / MIB).toFixed(1)} MiB of text: ${ms.toFixed(1)} ms`).toBeLessThan(LINEAR_TIME_CEILING_MS);
    const attachment = await ingestCreationAttachment({ data, name: "notes.txt" });
    expect(attachment.content.startsWith("A line of the manuscript.\nA line")).toBe(true);
    expect(attachment.truncated).toBe(true);
  });
});
