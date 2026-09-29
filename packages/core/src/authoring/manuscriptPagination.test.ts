import { describe, expect, it } from "vitest";
import { bookPlanSchema, createProjectSchema } from "../schemas/book.js";
import { DEFAULT_STUDIO_ART_STYLE, synthesizeAuthorBookPlan } from "./authorBookPlan.js";
import {
  joinManuscriptPages,
  manuscriptBlocks,
  manuscriptPageTargetChars,
  paginateManuscriptChapter
} from "./manuscriptPagination.js";
import {
  hasUnclosedFence,
  manuscriptExcerpt,
  manuscriptPlaceholderIssues,
  manuscriptWordCount,
  MANUSCRIPT_PAGE_SEPARATOR,
  normalizeManuscriptMarkdown
} from "./manuscriptText.js";

const paragraph = (seed: number, words = 60) =>
  Array.from({ length: words }, (_, index) => `word${seed}x${index}`).join(" ") + ".";

describe("paginateManuscriptChapter (flow)", () => {
  it("cuts only between blocks and round-trips through the join", () => {
    const chapter = Array.from({ length: 30 }, (_, index) => paragraph(index)).join("\n\n");
    const pages = paginateManuscriptChapter(chapter, { layout: "flow", targetChars: 1900 });
    expect(pages.length).toBeGreaterThan(3);
    for (const page of pages) {
      expect(page.trim()).toBe(page);
      expect(page).not.toBe("");
      // Every page starts and ends on a whole paragraph.
      expect(page.startsWith("word")).toBe(true);
      expect(page.endsWith(".")).toBe(true);
    }
    expect(joinManuscriptPages(pages, "flow")).toBe(normalizeManuscriptMarkdown(chapter));
  });

  it("keeps fences, images, lists, quotes and tables whole", () => {
    const fence = "```js\nconst a = 1;\n\nconst b = 2;\n```";
    const tilde = "~~~\nplain\n\n\nstill code\n~~~";
    const image = "![A lighthouse at dusk](/assets/images/p1/upload-abc.jpg)";
    const list = "- one\n- two\n- three";
    const quote = "> said the sea\n> twice";
    const table = "| a | b |\n|---|---|\n| 1 | 2 |";
    const chapter = [paragraph(1), fence, paragraph(2), tilde, image, list, quote, table, paragraph(3)].join("\n\n");
    const pages = paginateManuscriptChapter(chapter, { layout: "flow", targetChars: 200 });
    const all = pages.join("\n\n");
    for (const block of [fence, tilde, image, list, quote, table]) {
      expect(pages.some((page) => page.includes(block))).toBe(true);
      expect(all).toContain(block);
    }
  });

  it("closes an unclosed fence at the end of its chapter instead of losing text", () => {
    const chapter = `${paragraph(1)}\n\n~~~\ncode\n\nmore code`;
    expect(hasUnclosedFence(chapter)).toBe(true);
    const pages = paginateManuscriptChapter(chapter, { layout: "flow", targetChars: 200 });
    const all = pages.join("\n\n");
    expect(all).toContain("more code");
    expect(all.endsWith("more code\n~~~")).toBe(true);
    expect(hasUnclosedFence(all)).toBe(false);
    expect(pages.every((page) => page.trim().length > 0)).toBe(true);
  });

  it("never leaves a heading as the last block of a page", () => {
    const chapter = [paragraph(1, 150), "## The storm", paragraph(2, 150), "### Aftermath", paragraph(3, 150)].join("\n\n");
    const pages = paginateManuscriptChapter(chapter, { layout: "flow", targetChars: 1000 });
    for (const page of pages) {
      const blocks = manuscriptBlocks(page);
      expect(blocks[blocks.length - 1]).not.toMatch(/^#{1,6}\s/);
    }
  });

  it("splits only a lone paragraph longer than four page targets, at sentences", () => {
    const sentence = (n: number) => `This is sentence number ${n} of a very long paragraph.`;
    const huge = Array.from({ length: 200 }, (_, index) => sentence(index)).join(" ");
    const pages = paginateManuscriptChapter(huge, { layout: "flow", targetChars: 1900 });
    expect(pages.length).toBeGreaterThan(1);
    expect(pages.every((page) => page.endsWith("paragraph."))).toBe(true);
    const long = Array.from({ length: 40 }, (_, index) => sentence(index)).join(" ");
    expect(paginateManuscriptChapter(long, { layout: "flow", targetChars: 1900 })).toEqual([long]);
  });

  it("keeps a book at or under 600 pages", () => {
    expect(manuscriptPageTargetChars(10_000)).toBe(1900);
    expect(manuscriptPageTargetChars(1_500_000)).toBe(2500);
  });

  it("returns no pages for an empty chapter", () => {
    expect(paginateManuscriptChapter("  \n\n ", { layout: "flow" })).toEqual([]);
  });
});

describe("paginateManuscriptChapter (picture)", () => {
  it("splits only on the author's page separators and drops blank pages", () => {
    const chapter = [
      "![Mia on the hill](/assets/images/p1/upload-1.jpg)\n\nMia climbed the hill.",
      MANUSCRIPT_PAGE_SEPARATOR,
      MANUSCRIPT_PAGE_SEPARATOR,
      "The wind was waiting.",
      MANUSCRIPT_PAGE_SEPARATOR,
      "```\n<!-- page -->\n```"
    ].join("\n\n");
    const pages = paginateManuscriptChapter(chapter, { layout: "picture" });
    expect(pages).toEqual([
      "![Mia on the hill](/assets/images/p1/upload-1.jpg)\n\nMia climbed the hill.",
      "The wind was waiting.",
      "```\n<!-- page -->\n```"
    ]);
    expect(joinManuscriptPages(pages, "picture")).toBe(
      normalizeManuscriptMarkdown(
        [pages[0], MANUSCRIPT_PAGE_SEPARATOR, pages[1], MANUSCRIPT_PAGE_SEPARATOR, pages[2]].join("\n\n"),
        "picture"
      )
    );
  });
});

describe("normalizeManuscriptMarkdown", () => {
  it("normalizes endings, blank runs and raw page breaks, and is idempotent", () => {
    const raw = "One.  \r\n\r\n\r\n\r\nTwo.\n<div class=\"page-break\"></div>\nThree.";
    const flow = normalizeManuscriptMarkdown(raw, "flow");
    expect(flow).toBe("One.\n\nTwo.\n\nThree.");
    expect(normalizeManuscriptMarkdown(flow, "flow")).toBe(flow);
    const picture = normalizeManuscriptMarkdown(raw, "picture");
    expect(picture).toBe(`One.\n\nTwo.\n\n${MANUSCRIPT_PAGE_SEPARATOR}\n\nThree.`);
    expect(normalizeManuscriptMarkdown(picture, "picture")).toBe(picture);
  });

  it("never touches author headings or text inside fences", () => {
    const raw = "# Chapter One\n\n## Page 3\n\n```\n\n\n\nkept   \n```";
    expect(normalizeManuscriptMarkdown(raw)).toBe(raw);
  });
});

describe("manuscript measurements", () => {
  it("counts prose words only", () => {
    const md = "# Title\n\nThe **quick** brown fox.\n\n![A fox](/x.jpg)\n\n```\nnot counted here\n```";
    expect(manuscriptWordCount(md)).toBe(5);
  });

  it("makes a plain-text excerpt", () => {
    expect(manuscriptExcerpt("## Hi\n\nThe *sea* was [calm](x).", 160)).toBe("Hi The sea was calm.");
    expect(manuscriptExcerpt(paragraph(1), 40).endsWith("…")).toBe(true);
  });

  it("finds placeholders an author left behind", () => {
    expect(manuscriptPlaceholderIssues("It was TODO dark. Lorem ipsum.")).toEqual(["TODO", "Lorem ipsum"]);
    expect(manuscriptPlaceholderIssues("A toddler ran.")).toEqual([]);
  });
});

describe("synthesizeAuthorBookPlan", () => {
  it("builds a valid plan whose art style reaches the illustrations", () => {
    const plan = synthesizeAuthorBookPlan({
      title: "The Lighthouse",
      kind: "story",
      chapters: [
        { title: "Arrival", summary: "", pageCount: 3 },
        { title: "", summary: "The storm", pageCount: 2 }
      ],
      characters: [{ name: "Mia", description: "A girl with a red coat" }]
    });
    expect(bookPlanSchema.safeParse(plan).success).toBe(true);
    expect(plan.chapters.map((chapter) => [chapter.title, chapter.targetPages])).toEqual([
      ["Arrival", 3],
      ["Chapter 2", 2]
    ]);
    expect(plan.illustrationPlan.globalStyle).toBe(DEFAULT_STUDIO_ART_STYLE);
    expect(plan.characters[0]?.name).toBe("Mia");
    expect(
      synthesizeAuthorBookPlan({ title: "X", chapters: [], artStyle: "Ink and watercolour" }).illustrationPlan.globalStyle
    ).toBe("Ink and watercolour");
  });

  it("describes a never-published Studio book that passes the project schema", () => {
    const parsed = createProjectSchema.safeParse({
      title: "My book",
      prompt: "Author-written manuscript: My book",
      targetPages: 1,
      mediaSettings: {
        fullIllustrations: false,
        coverArtSource: "design",
        finalReview: false,
        mobile: { studio: { layout: "flow", kind: "story", createdAt: new Date().toISOString() } }
      }
    });
    expect(parsed.success).toBe(true);
  });
});
