import { describe, expect, it, vi } from "vitest";
import JSZip from "jszip";
import { assertSourceSize, chunkSourceSection, extractSource } from "./extraction.js";
import { rankSourcePassages } from "./retrieval.js";
import { sourceFixturePdf } from "./testing/pdfFixture.js";

const ending = "Final section: the observatory closed in 2047; the access code was ORCHID-913.";
const full = `${"Background material and unrelated history.\n".repeat(1800)}\n${ending}`;

describe("full source extraction", () => {
  it("preserves the final section beyond both old cutoffs and retrieves its exact fact", async () => {
    const sections = await extractSource({ name: "long.txt", data: Buffer.from(full) }, { checkpoint: vi.fn() });
    expect(sections[0]!.content).toBe(full);
    const passages = sections.flatMap(chunkSourceSection).map((chunk) => ({ ...chunk, sourceId: "older", version: 1, name: "long.txt" }));
    expect(passages.map((row) => row.content).join("")).toBe(full);
    expect(rankSourcePassages(passages, "observatory access code 2047")[0]?.content).toContain(ending);
  });
  it("reads every EPUB spine item including the ending", async () => {
    const zip = new JSZip();
    zip.file("1.xhtml", `<p>${full}</p>`);
    zip.file("2.xhtml", "<h2>Afterword</h2><p>FINAL-EPUB-991</p>");
    const result = await extractSource({ name: "long.epub", data: await zip.generateAsync({ type: "nodebuffer" }) }, { checkpoint: vi.fn() });
    expect(result[0]!.content).toContain("FINAL-EPUB-991");
  });
  it("preserves DOCX table columns, headings and Persian/Arabic text", async () => {
    const zip = new JSZip();
    zip.file("word/document.xml", '<w:document><w:p><w:t>نتیجه نهایی</w:t></w:p><w:tbl><w:tr><w:tc><w:t>علی</w:t></w:tc><w:tc><w:t>۷۴۲</w:t></w:tc></w:tr></w:tbl><w:p><w:t>الخاتمة: القاهرة</w:t></w:p></w:document>');
    const result = await extractSource({ name: "table.docx", data: await zip.generateAsync({ type: "nodebuffer" }) }, { checkpoint: vi.fn() });
    expect(result[0]!.content).toContain("علی\t۷۴۲");
    expect(result[0]!.content).toContain("الخاتمة: القاهرة");
  });
  it("refuses oversized text instead of shortening it", async () => {
    expect(() => assertSourceSize(1_500_001)).toThrow("1.5 million");
    await expect(extractSource({ name: "huge.txt", data: Buffer.from("a".repeat(1_500_001)) }, { checkpoint: vi.fn() })).rejects.toMatchObject({ code: "FILE_TOO_LARGE" });
  });
  it("uses native PDF text without a vision call", async () => {
    const ocr = vi.fn();
    const result = await extractSource({ name: "native.pdf", data: sourceFixturePdf([{ text: ending }]) }, { ocr, checkpoint: vi.fn() });
    expect(result[0]!.content).toContain("ORCHID-913");
    expect(result[0]!.locator).toBe("Page 1");
    expect(ocr).not.toHaveBeenCalled();
  });
  it("scopes OCR to scanned or mixed pages, bounds concurrency and records unreadable pages", async () => {
    let active = 0, peak = 0, calls = 0;
    const ocr = vi.fn(async (data: Buffer) => {
      expect(data.toString("latin1")).toContain("/Count 1");
      peak = Math.max(peak, ++active);
      const call = ++calls;
      await new Promise((resolve) => setTimeout(resolve, 5));
      active--;
      if (call === 3) throw new Error("OCR outage");
      return { content: `جدول\nالاسم\tالقيمة\nعلی\t${call === 2 ? "913" : "742"}`, unreadable: call === 2 ? ["bottom right unreadable"] : [] };
    });
    const result = await extractSource({ name: "mixed.pdf", data: sourceFixturePdf([{ text: ending }, { image: true }, { image: true, text: ending }, { image: true }]) }, { ocr, checkpoint: vi.fn() });
    expect(ocr).toHaveBeenCalledTimes(3);
    expect(peak).toBeLessThanOrEqual(2);
    expect(result[1]!.content).toContain("علی");
    expect(result.slice(2).some((section) => section.unreadable?.includes("bottom right"))).toBe(true);
    expect(result.slice(2).some((section) => section.unreadable?.includes("failed"))).toBe(true);
  });
  it("reuses checkpointed PDF pages after interruption", async () => {
    const ocr = vi.fn(async () => ({ content: "Recovered final page", unreadable: [] }));
    const result = await extractSource({ name: "scan.pdf", data: sourceFixturePdf([{ image: true }, { image: true }]) }, {
      ocr, completed: [{ section: 1, locator: "Page 1", content: "Previously read page" }], checkpoint: vi.fn()
    });
    expect(result[0]!.content).toBe("Previously read page");
    expect(ocr).toHaveBeenCalledTimes(1);
  });
  it("refuses PDFs over 600 pages before OCR", async () => {
    const ocr = vi.fn();
    await expect(extractSource({ name: "huge.pdf", data: sourceFixturePdf(Array.from({ length: 601 }, () => ({}))) }, { ocr, checkpoint: vi.fn() })).rejects.toMatchObject({ code: "FILE_TOO_LARGE" });
    expect(ocr).not.toHaveBeenCalled();
  });
});
