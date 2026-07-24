import JSZip from "jszip";
import { describe, expect, it } from "vitest";
import { bookPlanSchema } from "../schemas/book.js";
import type {
  GenerateJsonOptions,
  GenerateTextOptions,
  JsonResult,
  TextModelAdapter,
  TextResult,
  ToolCallsResult
} from "../adapters/types.js";
import {
  MANUSCRIPT_MAX_CHARS,
  MANUSCRIPT_MAX_PAGES,
  ManuscriptImportError,
  analyzeManuscriptStyle,
  deriveManuscriptTitle,
  parseManuscript,
  segmentManuscript,
  synthesizeImportedBookPlan
} from "./manuscriptImport.js";

/** Fake model that always answers generateJson with a canned payload. */
class CannedJsonModel implements TextModelAdapter {
  constructor(private readonly payload: unknown) {}

  async generateJson<T>(options: GenerateJsonOptions<T>): Promise<JsonResult<T>> {
    return {
      text: JSON.stringify(this.payload),
      model: "fake",
      provider: "fake",
      data: options.schema.parse(this.payload)
    };
  }

  generateText(_options: GenerateTextOptions): Promise<TextResult> {
    throw new Error("not used");
  }

  async *streamText(_options: GenerateTextOptions): AsyncGenerator<string> {
    throw new Error("not used");
  }

  generateWithTools(): Promise<ToolCallsResult> {
    throw new Error("not used");
  }
}

function paragraph(index: number): string {
  return `Paragraph ${index}. ${"The dragon walked through the misty valley toward the distant keep. ".repeat(4)}`;
}

function chapteredText(chapters: number, paragraphsPerChapter: number): string {
  const parts: string[] = [];
  for (let chapter = 1; chapter <= chapters; chapter += 1) {
    parts.push(`Chapter ${chapter}: The Journey Part ${chapter}`);
    for (let index = 0; index < paragraphsPerChapter; index += 1) {
      parts.push(paragraph(chapter * 100 + index));
    }
  }
  return parts.join("\n\n");
}

async function docxBuffer(paragraphs: Array<{ text: string; heading?: boolean }>): Promise<Buffer> {
  const body = paragraphs
    .map(({ text, heading }) =>
      heading
        ? `<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>${text}</w:t></w:r></w:p>`
        : `<w:p><w:r><w:t>${text}</w:t></w:r></w:p>`
    )
    .join("");
  const zip = new JSZip();
  zip.file("word/document.xml", `<?xml version="1.0"?><w:document><w:body>${body}</w:body></w:document>`);
  return zip.generateAsync({ type: "nodebuffer" });
}

/** EPUB whose OPF spine order deliberately disagrees with alphabetical order. */
async function spineEpubBuffer(): Promise<Buffer> {
  const zip = new JSZip();
  zip.file(
    "META-INF/container.xml",
    `<?xml version="1.0"?><container><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>`
  );
  zip.file(
    "OEBPS/content.opf",
    `<?xml version="1.0"?><package><manifest>
      <item id="late" href="a-last-alphabetically-first.xhtml" media-type="application/xhtml+xml"/>
      <item id="early" href="z-first-alphabetically-last.xhtml" media-type="application/xhtml+xml"/>
    </manifest><spine>
      <itemref idref="early"/>
      <itemref idref="late"/>
    </spine></package>`
  );
  zip.file(
    "OEBPS/z-first-alphabetically-last.xhtml",
    `<html><body><h1>Opening Chapter</h1><p>${paragraph(1)}</p></body></html>`
  );
  zip.file(
    "OEBPS/a-last-alphabetically-first.xhtml",
    `<html><body><h1>Closing Chapter</h1><p>${paragraph(2)}</p></body></html>`
  );
  return zip.generateAsync({ type: "nodebuffer" });
}

describe("parseManuscript", () => {
  it("keeps full manuscripts far beyond the chat-attachment truncation cap", async () => {
    const text = chapteredText(8, 30); // ~70k chars, well over the 12k digest cap
    const parsed = await parseManuscript({ data: Buffer.from(text, "utf8"), format: "text" });
    expect(parsed.charCount).toBeGreaterThan(50_000);
    expect(parsed.text).toContain("Paragraph 829");
    expect(parsed.sections.length).toBe(8);
    expect(parsed.sections[0]!.title).toMatch(/^Chapter 1/);
  });

  it("splits DOCX manuscripts at Heading1 styles", async () => {
    const data = await docxBuffer([
      { text: "The Long Winter", heading: true },
      { text: paragraph(1) },
      { text: paragraph(2) },
      { text: "Spring Returns", heading: true },
      { text: paragraph(3) }
    ]);
    const parsed = await parseManuscript({ data, format: "docx" });
    expect(parsed.sections.map((section) => section.title)).toEqual(["The Long Winter", "Spring Returns"]);
  });

  it("orders EPUB sections by OPF spine, not alphabetically", async () => {
    const parsed = await parseManuscript({ data: await spineEpubBuffer(), format: "epub" });
    expect(parsed.sections.map((section) => section.title)).toEqual(["Opening Chapter", "Closing Chapter"]);
  });

  it("splits markdown manuscripts at headings", async () => {
    const markdown = `# First Light\n\n${paragraph(1)}\n\n# Second Wind\n\n${paragraph(2)}`;
    const parsed = await parseManuscript({ data: Buffer.from(markdown, "utf8"), format: "text" });
    expect(parsed.sections.map((section) => section.title)).toEqual(["First Light", "Second Wind"]);
  });

  it("rejects empty, oversized, and unreadable files with typed errors", async () => {
    await expect(parseManuscript({ data: Buffer.alloc(0), format: "text" })).rejects.toMatchObject({
      code: "EMPTY_FILE"
    });
    await expect(
      parseManuscript({ data: Buffer.from("x".repeat(MANUSCRIPT_MAX_CHARS + 100_000), "utf8"), format: "text" })
    ).rejects.toMatchObject({ code: "IMPORT_TOO_LARGE" });
    await expect(
      parseManuscript({ data: Buffer.from("not a zip", "utf8"), format: "docx" })
    ).rejects.toBeInstanceOf(ManuscriptImportError);
  });
});

describe("segmentManuscript", () => {
  it("uses document structure and pages every chapter", async () => {
    const parsed = await parseManuscript({
      data: Buffer.from(chapteredText(5, 20), "utf8"),
      format: "text"
    });
    const segmented = await segmentManuscript(parsed);
    expect(segmented.segmentation).toBe("structure");
    expect(segmented.chapters.length).toBe(5);
    expect(segmented.pageCount).toBeGreaterThan(5);
    for (const chapter of segmented.chapters) {
      expect(chapter.pages.length).toBeGreaterThan(0);
      expect(chapter.pages[0]!.markdown.length).toBeGreaterThan(0);
      expect(chapter.pages[0]!.summary.length).toBeGreaterThan(0);
    }
  });

  it("falls back to fixed parts for unstructured text without a model", async () => {
    const flat = Array.from({ length: 120 }, (_, index) => paragraph(index)).join("\n\n");
    const parsed = await parseManuscript({ data: Buffer.from(flat, "utf8"), format: "text" });
    const segmented = await segmentManuscript(parsed);
    expect(segmented.segmentation).toBe("fixed");
    expect(segmented.pageCount).toBeGreaterThan(1);
  });

  it("uses the chapterize model for long unstructured text", async () => {
    const flat = Array.from({ length: 200 }, (_, index) => paragraph(index)).join("\n\n");
    const parsed = await parseManuscript({ data: Buffer.from(flat, "utf8"), format: "text" });
    const model = new CannedJsonModel({
      chapters: [
        { startParagraph: 0, title: "The Beginning" },
        { startParagraph: 100, title: "The End" }
      ]
    });
    const segmented = await segmentManuscript(parsed, { chapterizeModel: model });
    expect(segmented.segmentation).toBe("llm");
    expect(segmented.chapters.map((chapter) => chapter.title)).toEqual(["The Beginning", "The End"]);
  });

  it("stays under the page ceiling by growing page size", async () => {
    const huge = Array.from({ length: 4000 }, (_, index) => paragraph(index)).join("\n\n");
    expect(huge.length).toBeLessThan(MANUSCRIPT_MAX_CHARS);
    const parsed = await parseManuscript({ data: Buffer.from(huge, "utf8"), format: "text" });
    const segmented = await segmentManuscript(parsed);
    expect(segmented.pageCount).toBeLessThanOrEqual(MANUSCRIPT_MAX_PAGES);
  });
});

describe("analyzeManuscriptStyle", () => {
  it("returns a deterministic profile without a model", async () => {
    const style = await analyzeManuscriptStyle({ text: chapteredText(2, 5) });
    expect(style.voiceGuide.length).toBeGreaterThan(0);
    expect(style.antiAiRules.length).toBeGreaterThan(0);
    expect(style.premise.length).toBeGreaterThan(0);
  });

  it("returns the model profile when the call succeeds", async () => {
    const model = new CannedJsonModel({
      voiceGuide: ["Short declarative sentences.", "Dry humor in asides."],
      antiAiRules: ["Never summarize the plot."],
      tone: "wry",
      pointOfView: "third person limited",
      tense: "past",
      audience: "Adult fantasy readers",
      writingComplexity: 7,
      premise: "A dragon learns diplomacy.",
      detectedLanguage: "en",
      sampleExcerpts: ["The dragon walked."]
    });
    const style = await analyzeManuscriptStyle({ text: chapteredText(2, 5) }, { model });
    expect(style.tone).toBe("wry");
    expect(style.voiceGuide).toContain("Short declarative sentences.");
  });
});

describe("synthesizeImportedBookPlan", () => {
  it("produces a bookPlanSchema-valid plan from segmentation and style", async () => {
    const parsed = await parseManuscript({
      data: Buffer.from(chapteredText(3, 10), "utf8"),
      format: "text"
    });
    const segmented = await segmentManuscript(parsed);
    const style = await analyzeManuscriptStyle({ text: parsed.text });
    const plan = synthesizeImportedBookPlan({ title: "The Long Winter", segmented, style });

    // Round-trips through the schema exactly as the worker stores/reads it.
    const reparsed = bookPlanSchema.parse(JSON.parse(JSON.stringify(plan)));
    expect(reparsed.title).toBe("The Long Winter");
    expect(reparsed.chapters.length).toBe(segmented.chapters.length);
    expect(reparsed.voiceGuide.length).toBeGreaterThan(0);
    expect(reparsed.antiAiRules.length).toBeGreaterThan(0);
    expect(reparsed.illustrationPlan.cadence).toBe("manual");
    expect(reparsed.chapters.reduce((sum, chapter) => sum + chapter.targetPages, 0)).toBe(
      segmented.pageCount
    );
  });
});

describe("deriveManuscriptTitle", () => {
  it("prefers the override, then a non-generic first heading, then the file stem", () => {
    const sections = [{ title: "The Long Winter", text: "..." }];
    expect(deriveManuscriptTitle({ override: " My Book ", sections, fileName: "x.docx" })).toBe("My Book");
    expect(deriveManuscriptTitle({ sections, fileName: "x.docx" })).toBe("The Long Winter");
    expect(
      deriveManuscriptTitle({ sections: [{ title: "Chapter 1", text: "..." }], fileName: "long_winter-final.docx" })
    ).toBe("long winter final");
    expect(deriveManuscriptTitle({ sections: [], fileName: ".docx" })).toBe("Imported manuscript");
  });
});
