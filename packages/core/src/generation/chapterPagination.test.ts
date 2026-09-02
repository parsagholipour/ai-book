import { describe, expect, it } from "vitest";
import {
  chapterBlocks,
  chapterTail,
  dropDuplicateSentences,
  normalizeChapterMarkdown,
  paginateChapterMarkdown,
  varyParagraphs
} from "./chapterPagination.js";
import { countReadableWords } from "./proseShape.js";

function paragraph(words: number, seed: string): string {
  return Array.from({ length: words }, (_, index) => `${seed}${index % 7}`).join(" ") + ".";
}

describe("normalizeChapterMarkdown", () => {
  it("strips headings, page markers, chapter lines and a leading title, keeping fenced code", () => {
    const markdown = [
      "# The Long Road",
      "",
      "The Long Road",
      "",
      "Chapter 3",
      "",
      "Page 12",
      "",
      "First paragraph stays.",
      "",
      "## A heading inside",
      "",
      "```",
      "# not a heading",
      "```",
      "",
      "Last paragraph stays."
    ].join("\n");
    expect(normalizeChapterMarkdown(markdown, { chapterTitle: "The Long Road" })).toBe(
      ["First paragraph stays.", "", "```", "# not a heading", "```", "", "Last paragraph stays."].join("\n")
    );
  });
});

describe("chapterBlocks", () => {
  it("keeps a fenced block with blank lines inside it as one block", () => {
    const blocks = chapterBlocks(["Intro.", "", "```js", "const a = 1;", "", "const b = 2;", "```", "", "Outro."].join("\n"));
    expect(blocks).toHaveLength(3);
    expect(blocks[1]).toContain("const b = 2;");
  });
});

describe("paginateChapterMarkdown", () => {
  it("returns exactly the requested page count at paragraph boundaries with balanced words", () => {
    const paragraphs = Array.from({ length: 12 }, (_, index) => paragraph(60 + (index % 3) * 30, `w${index}`));
    const paginated = paginateChapterMarkdown(paragraphs.join("\n\n"), 4);
    expect(paginated.pages).toHaveLength(4);
    expect(paginated.pages.join("\n\n")).toBe(paragraphs.join("\n\n"));
    const target = paginated.totalWords / 4;
    for (const count of paginated.wordCounts) {
      expect(Math.abs(count - target)).toBeLessThan(target * 0.5);
    }
    for (const page of paginated.pages) {
      expect(page.startsWith("w")).toBe(true);
    }
  });

  it("splits long paragraphs at sentence boundaries when there are fewer blocks than pages", () => {
    const sentences = Array.from({ length: 8 }, (_, index) => `Sentence number ${index} of the one long paragraph, carrying its own weight.`);
    const paginated = paginateChapterMarkdown(sentences.join(" "), 3);
    expect(paginated.pages).toHaveLength(3);
    expect(paginated.pages.every((page) => page.trim().length > 0)).toBe(true);
    expect(paginated.pages.join(" ")).toBe(sentences.join(" "));
  });

  it("never cuts inside a fenced block", () => {
    const fence = ["```", ...Array.from({ length: 30 }, (_, index) => `line ${index}`), "```"].join("\n");
    const markdown = [paragraph(40, "a"), fence, paragraph(40, "b")].join("\n\n");
    const paginated = paginateChapterMarkdown(markdown, 2);
    expect(paginated.pages).toHaveLength(2);
    for (const page of paginated.pages) {
      expect((page.match(/^```/gm) ?? []).length % 2).toBe(0);
    }
  });

  it("gives every page something even when the chapter is a single sentence", () => {
    const paginated = paginateChapterMarkdown("One short sentence only.", 3);
    expect(paginated.pages).toHaveLength(3);
    expect(paginated.pages.filter((page) => page.trim()).length).toBeGreaterThanOrEqual(2);
  });
});

describe("chapterTail", () => {
  it("takes whole paragraphs from the end up to the word limit", () => {
    const paragraphs = [paragraph(100, "a"), paragraph(100, "b"), paragraph(100, "c")];
    const tail = chapterTail(paragraphs.join("\n\n"), 150);
    expect(tail.startsWith("b0")).toBe(true);
    expect(countReadableWords(tail)).toBe(200);
  });
});

describe("varyParagraphs and dropDuplicateSentences", () => {
  it("merges a continuation into the paragraph it continues and leaves everything else alone", () => {
    const a = paragraph(90, "a");
    const b = "This " + paragraph(80, "b");
    const c = [paragraph(40, "c"), paragraph(40, "e"), paragraph(40, "f"), paragraph(40, "g")].join(" ") + " The ledger closed.";
    const quoted = "“Not here,” she said. " + paragraph(30, "d");
    const varied = varyParagraphs([a, b, c, quoted].join("\n\n"));
    const blocks = chapterBlocks(varied);
    expect(blocks).toHaveLength(3);
    expect(blocks[0]).toBe(`${a} ${b}`);
    expect(blocks[1]).toBe(c);
    expect(blocks[2]).toBe(quoted);
  });

  it("drops a later verbatim copy of a long sentence and keeps short repeated ones", () => {
    const long = "Sacred language could enlarge or narrow the field of legitimate violence, but its practical force depended on institutions.";
    const text = `${long} The council met.\n\nAnother paragraph here with its own matter for the reader. ${long}\n\nThe council met.`;
    const cleaned = dropDuplicateSentences(text);
    expect(cleaned.split(long).length - 1).toBe(1);
    expect(cleaned.split("The council met.").length - 1).toBe(2);
  });
});
