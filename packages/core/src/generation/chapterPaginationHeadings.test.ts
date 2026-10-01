import { describe, expect, it } from "vitest";
import { FakeTextModelAdapter } from "../adapters/fake.js";
import { makeFallbackPlan } from "../prompting/templates.js";
import type { CreateProjectInput } from "../schemas/book.js";
import { normalizeChapterMarkdown, paginateChapterMarkdown } from "./chapterPagination.js";
import { describeChapterPages } from "./composedChapterPages.js";

const paragraph = (label: string, words: number) => `${label} ${Array.from({ length: words - 1 }, (_, index) => `word${index}`).join(" ")}.`;

describe("a toolkit chapter keeps its section headings, and only those", () => {
  const draft = ["# The chapter title", "## Chapter 3", "### Thirty questions, sorted by purpose", paragraph("Intro", 40), "#### A fourth-level heading", "Page 4", paragraph("Body", 40)].join("\n\n");

  it("strips every heading when not asked, as it always did", () => {
    expect(normalizeChapterMarkdown(draft, { chapterTitle: "The chapter title" })).not.toMatch(/^#/m);
  });

  it("keeps the ### headings when asked, and still drops the title, chapter labels, other levels and page markers", () => {
    const kept = normalizeChapterMarkdown(draft, { chapterTitle: "The chapter title", keepSubheadings: true });
    expect(kept.split("\n").filter((line) => line.startsWith("#"))).toEqual(["### Thirty questions, sorted by purpose"]);
    expect(kept).not.toContain("Page 4");
    expect(normalizeChapterMarkdown("### The chapter title\n\nText.", { chapterTitle: "The chapter title", keepSubheadings: true })).toBe("Text.");
  });
});

describe("a heading never ends a page", () => {
  it("carries each heading onto the page of the block it heads", () => {
    const chapter = [paragraph("A", 300), "### Second section", paragraph("B", 60), paragraph("C", 240), "### Third section", "### Straight into a subsection", paragraph("D", 300)].join("\n\n");
    const { pages } = paginateChapterMarkdown(chapter, 3);
    for (const page of pages) {
      const lines = page.trim().split("\n").filter(Boolean);
      expect(lines.at(-1)).not.toMatch(/^###/);
    }
    expect(pages.join("\n\n")).toBe(chapter);
  });

  it("cuts a chapter with no headings exactly as before", () => {
    const blocks = [paragraph("A", 200), paragraph("B", 200), paragraph("C", 200), paragraph("D", 200)];
    expect(paginateChapterMarkdown(blocks.join("\n\n"), 2).pages).toEqual([blocks.slice(0, 2).join("\n\n"), blocks.slice(2).join("\n\n")]);
  });
});

describe("a page title never copies the heading the page opens on", () => {
  const input = { prompt: "A guide.", category: "BUSINESS", targetPages: 4, complexity: 4, temperature: 0.5, language: "en", mediaSettings: {} } as unknown as CreateProjectInput;
  const plan = makeFallbackPlan(input);

  it("prefixes the chapter's title when the described title equals the page's leading ### heading, which the compile would strip", async () => {
    const model = new FakeTextModelAdapter(input);
    model.generateJson = async (options) => {
      const data = { pages: [{ index: 1, title: "Thirty Questions, Sorted by Purpose", summary: "The bank." }, { index: 2, title: "Using the bank", summary: "More." }] };
      return { data: options.schema.parse(data), text: JSON.stringify(data), model: "fixture", provider: "fixture" };
    };
    const described = await describeChapterPages({
      input,
      plan,
      chapter: { index: 3, title: "Ask better questions", summary: "", keyBeats: [], targetPages: 2 },
      pages: [
        { index: 1, markdown: "### Thirty questions, sorted by purpose\n\n1. What has taken your attention?" },
        { index: 2, markdown: "Using the bank is simple." }
      ],
      illustratedIndexes: [],
      textModel: model
    });
    expect(described.map((page) => page.title)).toEqual(["Ask better questions: Thirty Questions, Sorted by Purpose", "Using the bank"]);
  });
});
