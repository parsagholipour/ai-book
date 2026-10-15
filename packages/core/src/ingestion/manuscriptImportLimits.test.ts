import JSZip from "jszip";
import { describe, expect, it } from "vitest";
import { DOCUMENT_METADATA_MAX_BYTES } from "./documentText.js";
import { MANUSCRIPT_MAX_CHARS, ManuscriptImportError, parseManuscript, type ManuscriptImportFormat } from "./manuscriptImport.js";
import { separateManuscriptMatter, type MatterSourceSection } from "./manuscriptMatter.js";
import { wordBomb } from "./testing/zipArchive.js";
import { LINEAR_TIME_CEILING_MS } from "./testing/linearTime.js";

async function readMs(run: () => Promise<unknown>): Promise<number> {
  let best = Number.POSITIVE_INFINITY;
  for (let read = 0; read < 2; read += 1) {
    const start = performance.now();
    await run();
    best = Math.min(best, performance.now() - start);
  }
  return best;
}

function word(xml: string, files: Record<string, string> = {}): Promise<Buffer> {
  const zip = new JSZip();
  zip.file("word/document.xml", `<w:document><w:body>${xml}</w:body></w:document>`);
  for (const [path, text] of Object.entries(files)) zip.file(path, text);
  return zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
}

async function refusal(data: Buffer, format: ManuscriptImportFormat): Promise<string> {
  const error = await parseManuscript({ data, format }).catch((caught: unknown) => caught);
  expect(error).toBeInstanceOf(ManuscriptImportError);
  return (error as ManuscriptImportError).code;
}

const CHAPTERS: MatterSourceSection[] = [
  { title: "Chapter 1", text: "Snow fell in the valley." },
  { title: "Chapter 2", text: "The river slept under the ice." }
];

describe("manuscript import on the API's thread", () => {
  it("reads Word paragraphs and credit starts that never close in linear time", async () => {
    // 40,000 unclosed paragraphs took 2.5 s to parse; 40,000 unended credit starts, 8.8 s.
    const credit = `<w:bookmarkStart w:id="0" w:name="TomezaMadeWithCredit"/>`;
    for (const count of [4_000, 40_000]) {
      for (const [label, xml] of [["unclosed <w:p>", "<w:p>".repeat(count)], ["unended credits", `<w:p>${credit.repeat(count)}</w:p>`]] as const) {
        const data = await word(xml);
        const ms = await readMs(() => parseManuscript({ data, format: "docx" }).catch(() => undefined));
        expect(ms, `${label} × ${count}: ${ms.toFixed(1)} ms`).toBeLessThan(LINEAR_TIME_CEILING_MS);
      }
    }
  });

  it("reads HTML headings that never close in linear time", async () => {
    // 2.4 s at 120,000 characters before.
    for (const length of [12_000, 120_000]) {
      const data = Buffer.from(`<p>Text</p>${"<h2 ".repeat(length / 4)}`);
      const ms = await readMs(() => parseManuscript({ data, format: "html" }).catch(() => undefined));
      expect(ms, `unclosed <h2 at ${length} chars: ${ms.toFixed(1)} ms`).toBeLessThan(LINEAR_TIME_CEILING_MS);
    }
  });

  it("reads a manuscript's matter pages in linear time", async () => {
    const adversarial: Array<[string, (length: number) => MatterSourceSection[], boolean]> = [
      // 13.7 s at 30,000 characters: every Contents page read the whole book again.
      ["Contents headings", (length) => [...Array.from({ length: length / 9 }, () => ({ title: "Contents", text: "x" })), ...CHAPTERS], false],
      // 1.2 s: a page-number leader was read to its end from each of its dots.
      ["a Contents leader", (length) => [{ title: "Contents", text: `Chapter 1${".".repeat(length)}x` }, ...CHAPTERS], false],
      // 2.7 s at 60,000: a run of spaces with no line break in it, read from each space.
      ["a run of no-break spaces", (length) => [{ title: null, text: `The Title\nby Jane Doe\na${" ".repeat(length)}b` }, ...CHAPTERS], false],
      // 1.1 s: emphasis that never closes on a title page.
      ["unclosed emphasis", (length) => [{ title: null, text: `The Title\nby Jane Doe\n${"**a ".repeat(length / 4)}` }, ...CHAPTERS], true]
    ];
    for (const [label, build, markdown] of adversarial) {
      for (const length of [6_000, 60_000]) {
        const sections = build(length);
        const ms = await readMs(async () => separateManuscriptMatter(sections, { markdown }));
        expect(ms, `${label} at ${length} chars: ${ms.toFixed(1)} ms`).toBeLessThan(LINEAR_TIME_CEILING_MS);
      }
    }
  });

  it("answers that a manuscript is too long before reading its every line", async () => {
    // Read to the end first, 19 MB of short lines held the thread for 7.4 s.
    const lines = Array.from({ length: (MANUSCRIPT_MAX_CHARS * 2) / 3 + 10 }, (_, index) => (index % 1000).toString(36).padStart(2, "0")).join("\n");
    const rtf = Buffer.from(lines.replace(/\n/g, "\\par "));
    // Half of 7.4 s for both reads together: a loaded `pnpm check` took 2.7 s.
    const started = performance.now();
    expect(await refusal(Buffer.from(lines), "text")).toBe("IMPORT_TOO_LARGE");
    expect(await refusal(rtf, "rtf")).toBe("IMPORT_TOO_LARGE");
    expect(performance.now() - started).toBeLessThan(3_700);
  });

  it("still imports a manuscript just under the ceiling", async () => {
    const paragraph = "The river slept under the ice and the wind kept its own counsel while the village waited. ".repeat(10);
    const chapters = Array.from({ length: 100 }, (_, index) => `Chapter ${index + 1}\n\n${`${paragraph}\n\n`.repeat(15)}`);
    const text = chapters.join("\n\n");
    expect(text.length).toBeLessThan(MANUSCRIPT_MAX_CHARS);
    expect(text.length).toBeGreaterThan(MANUSCRIPT_MAX_CHARS * 0.8);
    const parsed = await parseManuscript({ data: Buffer.from(text), format: "text" });
    expect(parsed.sections).toHaveLength(100);
  });

  it("refuses a Word document of more paragraphs than any book has", async () => {
    expect(await refusal(await word("<w:p/>".repeat(250_001)), "docx")).toBe("IMPORT_TOO_LARGE");
  });

  it("refuses a Word document that inflates past the limit, and metadata past its own", async () => {
    const error = await parseManuscript({ data: wordBomb(200), format: "docx" }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ManuscriptImportError);
    expect(error).toMatchObject({
      code: "FILE_TOO_LARGE",
      message: "That Word document is too large to read. Split it into smaller files and try again."
    });
    const metadata = `<cp:coreProperties>${" ".repeat(DOCUMENT_METADATA_MAX_BYTES)}</cp:coreProperties>`;
    expect(await refusal(await word("<w:p><w:r><w:t>Text</w:t></w:r></w:p>", { "docProps/core.xml": metadata }), "docx")).toBe("FILE_TOO_LARGE");
  });
});
