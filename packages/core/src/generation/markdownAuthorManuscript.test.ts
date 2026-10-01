import { describe, expect, it } from "vitest";
import { paginateManuscriptChapter } from "../authoring/manuscriptPagination.js";
import { synthesizeAuthorBookPlan } from "../authoring/authorBookPlan.js";
import { scriptProfileForLanguage } from "../prompting/script.js";
import { makeFallbackPlan } from "../prompting/templates.js";
import { createProjectSchema, type BookPlan, type CreateProjectInput } from "../schemas/book.js";
import { compileBookMarkdownWithPageAnchors, findBookLikeMarkdownIssues, type MarkdownPage } from "./markdown.js";
import { joinMarkdownPageBlocks } from "./markdownPageBoundaries.js";
import { buildBookPdfDocument } from "./pdfDocument.js";
import { bookPageAnchorLinkNav, injectBookPageAnchorMarkers } from "./pdfPageAnchors.js";
import { separateStoryPagesForPdf, storyPageLayoutFor } from "./pdfStoryPages.js";
import { authorReaderChapters } from "./readerChapters.js";

const flatPlan = makeFallbackPlan(createProjectSchema.parse({ prompt: "A book of the author's own.", category: "STORY", targetPages: 2 }));

function pagesOf(markdowns: string[]): MarkdownPage[] {
  return markdowns.map((markdown, position) => ({ index: position + 1, title: `Chapter · ${position + 1}`, markdown }));
}

async function bodyHtml(compiled: ReturnType<typeof compileBookMarkdownWithPageAnchors>): Promise<string> {
  const html = await buildBookPdfDocument({
    markdown: injectBookPageAnchorMarkers(compiled.markdown, compiled),
    pageAnchorNav: bookPageAnchorLinkNav(compiled.pageAnchors, {
      hasContents: compiled.hasContents,
      hasSources: compiled.sourcesOffset !== undefined
    }),
    profile: scriptProfileForLanguage("en"),
    css: ""
  });
  return html.slice(html.indexOf("<body"));
}

function compile(markdowns: string[], authorManuscript: boolean, plan: BookPlan = flatPlan) {
  return compileBookMarkdownWithPageAnchors({ plan, pages: pagesOf(markdowns), authorManuscript });
}

describe("an author's page boundaries", () => {
  it("prints the paragraphs either side of a cut as two paragraphs, and a generated book's as one", async () => {
    const pages = ["First paragraph ends here.", "Second paragraph starts."];
    const author = compile(pages, true);
    const generated = compile(pages, false);

    expect(author.markdown).toContain("First paragraph ends here.\n\nSecond paragraph starts.");
    expect(generated.markdown).toContain("First paragraph ends here.\nSecond paragraph starts.");
    expect((await bodyHtml(author)).match(/<p>/g)).toHaveLength(2);
    expect((await bodyHtml(generated)).match(/<p>/g)).toHaveLength(1);
  });

  it("anchors every page at its own first character", () => {
    const compiled = compile(["One.", "Two.", "Three."], true);
    for (const [position, text] of ["One.", "Two.", "Three."].entries()) {
      const anchor = compiled.pageAnchors.find((value) => value.pageIndex === position + 1)!;
      expect(compiled.markdown.slice(anchor.markdownOffset, anchor.markdownOffset! + text.length)).toBe(text);
      if (position > 0) expect(compiled.markdown.slice(anchor.markdownOffset! - 2, anchor.markdownOffset)).toBe("\n\n");
    }
  });

  it("round-trips a paginated chapter into the blocks the author wrote", async () => {
    const paragraphs = Array.from({ length: 9 }, (_, index) =>
      `Paragraph ${index + 1} ${"walks the long road home under a patient sky ".repeat(8).trim()}.`);
    const pages = paginateManuscriptChapter(paragraphs.join("\n\n"), { layout: "flow", targetChars: 700 });
    expect(pages.length).toBeGreaterThan(2);

    const compiled = compile(pages, true);

    expect((await bodyHtml(compiled)).match(/<p>/g)).toHaveLength(paragraphs.length);
    for (const paragraph of paragraphs) expect(compiled.markdown).toContain(paragraph);
  });

  it("puts exactly one blank line between blocks, counting a hero image's own newline", () => {
    const { markdown, offsets } = joinMarkdownPageBlocks(["Before.", "\n![Hero](/a.png)\nAfter.", "Last.\n", "Tail."], {
      paragraphBreaks: true
    });
    expect(markdown).toBe("Before.\n\n![Hero](/a.png)\nAfter.\n\nLast.\n\nTail.");
    expect(offsets).toEqual([0, 8, 33, 40]);
  });

  it("ends an author's table at the page that ends it", async () => {
    const compiled = compile(["| A | B |\n|---|---|\n| one | two |", "Prose after the table."], true);
    const body = await bodyHtml(compiled);
    expect(body.match(/<td>/g)).toHaveLength(2);
    expect(body).toMatch(/<\/table>\s*<p><span id="bp-2">Prose<\/span>/);
  });

  it("keeps an author's whole-page code block as code, where a model's wrapper is unwrapped", () => {
    const page = "```\nlet x = 1;\n```";
    expect(compile(["Intro.", page], true).markdown).toContain("```\nlet x = 1;\n```");
    expect(compile(["Intro.", page], false).markdown).not.toContain("```");
  });
});

describe("an author's text never fails the leak checks", () => {
  const leaky = [
    "generatedAt: 2026-01-01",
    "pages: 3",
    "## Page 3",
    "- [Page 3: The Hall](#page-3)",
    "![Illustration for Page 2](/assets/images/p/upload-1.png)"
  ].join("\n\n");

  it("runs only the structural checks for an author's manuscript", () => {
    expect(findBookLikeMarkdownIssues(leaky, { authorManuscript: true })).toEqual([]);
    expect(findBookLikeMarkdownIssues(leaky)).toEqual([
      "generatedAt metadata",
      "page-count metadata",
      "page-number heading",
      "page-number table of contents link",
      "page-number image alt text"
    ]);
    expect(findBookLikeMarkdownIssues('---\ntitle: x\n---\n\n<div class="page-break"></div>', { authorManuscript: true }))
      .toEqual(["frontmatter block", "raw page-break markup"]);
  });

  it("prints an author's own \"Page 3\" heading, which a generated book may not", () => {
    const page = "## Page 3\n\nThe hall was dark. generatedAt noon.";
    expect(compile(["Intro.", page], true).markdown).toContain(page);
    // A generated page's leading "Page N" title is scaffolding and stripped;
    // one anywhere else fails the compile.
    expect(compile(["Intro.", page.replace(" generatedAt noon", "")], false).markdown).not.toContain("## Page 3");
    expect(() => compile(["Intro.", `The hall.\n\n${page}`], false)).toThrow(/page-number heading/);
  });

  it("still drops an author's repeat of the chapter heading printed above it", () => {
    const pages = [1, 2, 3, 4, 5, 6, 7, 8].map((index) => ({
      index, title: `Page ${index}`, markdown: index === 5 ? "# The Storm\n\nRain." : `Prose ${index}.`,
      chapter: { index: index <= 4 ? 1 : 2, title: index <= 4 ? "Calm" : "The Storm", summary: "" }
    }));
    const markdown = compileBookMarkdownWithPageAnchors({
      plan: flatPlan, pages, readerChapters: authorReaderChapters(pages), authorManuscript: true
    }).markdown;
    expect(markdown).toContain("## Chapter 2: The Storm\nRain.");
    expect(markdown).not.toContain("# The Storm\n");
  });
});

describe("an author's chapters", () => {
  const chaptered = (titles: string[], pagesPerChapter: number[]) => {
    let index = 0;
    return titles.flatMap((title, chapterPosition) =>
      Array.from({ length: pagesPerChapter[chapterPosition]! }, () => {
        index += 1;
        return {
          index,
          title: `${title} · ${index}`,
          markdown: `Prose on page ${index}, which the author wrote for this chapter.`,
          summary: `Page ${index}.`,
          chapter: { index: chapterPosition + 1, title, summary: "" }
        };
      }));
  };

  it("takes the rows' titles verbatim instead of inventing one for a default name", () => {
    const pages = chaptered(["Chapter 1", "The Storm", "Chapter 3"], [3, 3, 3]);
    const chapters = authorReaderChapters(pages);
    expect(chapters.map((chapter) => [chapter.title, chapter.startPageIndex, chapter.endPageIndex])).toEqual([
      ["Chapter 1", 1, 3], ["The Storm", 4, 6], ["Chapter 3", 7, 9]
    ]);

    const markdown = compileBookMarkdownWithPageAnchors({ plan: flatPlan, pages, readerChapters: chapters, authorManuscript: true }).markdown;
    expect(markdown).toContain("## Chapter 1\n");
    expect(markdown).toContain("## Chapter 2: The Storm\n");
    expect(markdown).toContain("## Chapter 3\n");
    expect(markdown).not.toContain("Chapter 1 ·");
  });

  it("hands a book with one chapter, or pages without rows, to the plan's partition", () => {
    expect(authorReaderChapters(chaptered(["Only"], [4]))).toEqual([]);
    expect(authorReaderChapters(pagesOf(["One.", "Two."]))).toEqual([]);
  });

  it("gets the chapter starts the publish wrote from the plan partition, and no apparatus for one chapter", () => {
    const plan = synthesizeAuthorBookPlan({
      title: "Harbour Lights",
      chapters: [
        { title: "Arrival", summary: "", pageCount: 5 },
        { title: "", summary: "", pageCount: 2 },
        { title: "Departure", summary: "", pageCount: 3 }
      ]
    });
    const pages = pagesOf(Array.from({ length: 10 }, (_, index) => `Page ${index + 1} prose.`));
    const compiled = compileBookMarkdownWithPageAnchors({ plan, pages, readerChapters: [], authorManuscript: true });
    expect(compiled.pageAnchors.filter((anchor) => anchor.destName.startsWith("chapter-")).map((anchor) => anchor.pageIndex))
      .toEqual([1, 6, 8]);
    expect(compiled.markdown).toContain("## Chapter 1: Arrival");
    expect(compiled.markdown).toContain("## Chapter 2\n");
    expect(compiled.markdown).toContain("## Chapter 3: Departure");

    const single = synthesizeAuthorBookPlan({ title: "One Piece", chapters: [{ title: "All of it", summary: "", pageCount: 3 }] });
    const alone = compileBookMarkdownWithPageAnchors({ plan: single, pages: pagesOf(["A.", "B.", "C."]), readerChapters: [], authorManuscript: true });
    expect(alone.markdown).not.toMatch(/^## /m);
    expect(alone.hasContents).toBe(false);
  });
});

describe("a Studio picture book's story pages", () => {
  const studio = (layout: "flow" | "picture") => ({ mobile: { studio: { layout, kind: "picture", createdAt: "2026-09-29T00:00:00Z" } } });
  const input = (mediaSettings: unknown, category: CreateProjectInput["category"] = "KIDS", targetPages = 3) =>
    ({ category, targetPages, mediaSettings });
  const story = pagesOf(["A fox.", "![Fox](/assets/images/p/upload-1.png)\n\nA hen.", "The end."]);

  it("prints one sheet per page at any length and in any category, and flows everything else", () => {
    expect(storyPageLayoutFor(input(studio("picture"), "CUSTOM", 99), story)).toBe("separate");
    expect(storyPageLayoutFor(input(studio("picture"), "KIDS", 1), story.slice(0, 1))).toBe("separate");
    expect(storyPageLayoutFor(input(studio("flow")), story)).toBeUndefined();
    expect(storyPageLayoutFor(input(studio("picture")), [story[0]!, story[2]!])).toBeUndefined();
    expect(storyPageLayoutFor(input(studio("picture")), [...story.slice(0, 2), { ...story[2]!, markdown: " " }])).toBeUndefined();
  });

  it("keeps the generated short-kids rule for generated books and never gives it to an import", () => {
    const tenPages = pagesOf(Array.from({ length: 10 }, (_, index) => `Scene ${index + 1}.`));
    expect(storyPageLayoutFor(input({}, "KIDS", 10), tenPages)).toBe("separate");
    expect(storyPageLayoutFor(input({ mobile: { import: { filename: "a.docx" } } }, "KIDS", 10), tenPages)).toBeUndefined();
  });

  it("cuts the paragraph-joined compile into one scene per page, a one-page book included", () => {
    for (const pages of [story, story.slice(0, 1)]) {
      const compiled = compileBookMarkdownWithPageAnchors({
        plan: flatPlan, pages, authorManuscript: true, storyPageLayout: "separate", category: "KIDS"
      });
      const { markdown } = separateStoryPagesForPdf(compiled.markdown, compiled);
      expect(markdown.match(/class="pdf-story-page pdf-story-scene[ "]/g)).toHaveLength(pages.length);
    }
  });
});
