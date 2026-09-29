import { describe, expect, it } from "vitest";
import { makeFallbackPlan } from "../prompting/templates.js";
import { createProjectSchema } from "../schemas/book.js";
import { expandFigureFences } from "../generation/figures/figureHtml.js";
import { compileBookMarkdownWithPageAnchors, type MarkdownPage } from "../generation/markdown.js";
import { storyPageLayoutFor } from "../generation/pdfStoryPages.js";
import { readerChaptersFromPublishedMarkdown } from "../generation/publishedReaderChapters.js";
import { joinManuscriptPages, paginateManuscriptChapter } from "./manuscriptPagination.js";
import { generatedPagePrintedText, takenOverPageText, takeoverHeroLine } from "./takeoverText.js";

/**
 * A generated book taken over into the Writing Studio must print the same the
 * moment it changes hands, although the author compile reads a page
 * differently (no fence unwrapping, no heading strip, no hero block).
 */

const plan = makeFallbackPlan(createProjectSchema.parse({ prompt: "A harbour story for the takeover suite.", category: "STORY", targetPages: 3 }));
const hero = "/assets/images/project-1/page-page-1-abc.jpg";
const figure =
  "```figure\n" +
  JSON.stringify({
    kind: "bar",
    title: "Ships in harbour",
    categories: ["1950", "1960", "1970"],
    series: [{ name: "Ships", values: [3, 5, 8] }],
    unit: "ships",
    source: "Harbour records"
  }) +
  "\n```";

function page(index: number, markdown: string, extra: Partial<MarkdownPage> = {}): MarkdownPage {
  return { index, title: `The Harbour ${index}`, markdown, ...extra };
}

describe("a generated page as its author takes it over", () => {
  it("unwraps a model's whole-page fence and drops the headings the generated compile dropped", () => {
    expect(generatedPagePrintedText(page(1, "```markdown\nThe harbour was quiet.\n```"))).toBe("The harbour was quiet.");
    expect(generatedPagePrintedText(page(3, "## Page 3\n\nBoats rocked."))).toBe("Boats rocked.");
    expect(generatedPagePrintedText(page(2, "## The Harbour 2\n\nBoats rocked."))).toBe("Boats rocked.");
    // A repeat of the chapter heading goes on the page that opens the chapter, in any wording.
    const chapter = { index: 2, title: "The Storm" };
    expect(generatedPagePrintedText(page(4, "## Chapter 2: The Storm\n\nRain.", { title: "x" }), { chapter })).toBe("Rain.");
    expect(generatedPagePrintedText(page(4, "## The Storm\n\nRain.", { title: "x" }), { chapter })).toBe("Rain.");
    // A heading the book really prints stays.
    expect(generatedPagePrintedText(page(5, "## The lighthouse log\n\nRain.", { title: "x" }))).toBe("## The lighthouse log\n\nRain.");
  });

  it("writes the hero as the first line, with the alt text the compile printed", () => {
    expect(takenOverPageText(page(1, "The harbour was quiet."), { heroPath: hero })).toBe(
      `![Illustration](${hero})\n\nThe harbour was quiet.`
    );
    expect(takeoverHeroLine(hero, "fa")).not.toContain("Illustration");
    expect(takenOverPageText(page(1, "   "), { heroPath: hero })).toBe(`![Illustration](${hero})`);
    expect(takenOverPageText(page(1, "No picture here."))).toBe("No picture here.");
  });

  it("prints the picture once, in the same place, under the author rules", () => {
    const generated = compileBookMarkdownWithPageAnchors({
      plan,
      pages: [page(1, "## Page 1\n\nThe harbour was quiet.", { imagePath: hero, imageAlt: "Illustration" }), page(2, "Boats rocked.")]
    });
    const takenOver = compileBookMarkdownWithPageAnchors({
      plan,
      authorManuscript: true,
      pages: [
        page(1, takenOverPageText(page(1, "## Page 1\n\nThe harbour was quiet."), { heroPath: hero })),
        page(2, takenOverPageText(page(2, "Boats rocked.")))
      ]
    });
    for (const markdown of [generated.markdown, takenOver.markdown]) {
      expect(markdown.split(hero)).toHaveLength(2);
      expect(markdown).toContain(`![Illustration](${hero})\n\nThe harbour was quiet.`);
      expect(markdown).not.toContain("Page 1");
    }
  });

  it("keeps a figure byte for byte through the working copy and the author compile", () => {
    const pages = [takenOverPageText(page(1, `The ships came in.\n\n${figure}`)), takenOverPageText(page(2, "Then the storm."))];
    const workingCopy = joinManuscriptPages(pages, "flow");
    expect(workingCopy).toContain(figure);
    const republished = paginateManuscriptChapter(workingCopy, { layout: "flow" });
    const compiled = compileBookMarkdownWithPageAnchors({
      plan,
      authorManuscript: true,
      pages: republished.map((markdown, offset) => page(offset + 1, markdown))
    });
    expect(compiled.markdown).toContain(figure);
    expect(expandFigureFences(compiled.markdown)).toContain("<svg");
  });

  it("still prints the Sources list, which is never page text", () => {
    const compiled = compileBookMarkdownWithPageAnchors({
      plan,
      authorManuscript: true,
      includeSources: true,
      researchSources: [{ title: "Harbour records", url: "https://example.org/harbour", summary: "Ship counts." }],
      pages: [page(1, "The harbour was quiet [source:src1:1:0]."), page(2, "Boats rocked.")]
    });
    expect(compiled.markdown).toContain("[Harbour records](https://example.org/harbour)");
    expect(compiled.markdown).toContain("[source:src1:1:0]");
  });

  it("keeps a picture book on one sheet a page when its Studio layout is picture", () => {
    const pages = Array.from({ length: 6 }, (_, offset) => ({ index: offset + 1, markdown: `Page ${offset + 1} text.` }));
    const kids = createProjectSchema.parse({ prompt: "A picture book about a harbour cat.", category: "KIDS", targetPages: 6 });
    expect(storyPageLayoutFor(kids, pages)).toBe("separate");
    const takenOver = {
      ...kids,
      mediaSettings: { ...kids.mediaSettings, mobile: { studio: { layout: "picture", kind: "picture", createdAt: "2026-09-30T00:00:00.000Z", origin: "takeover" } } }
    };
    expect(storyPageLayoutFor(takenOver, pages)).toBe("separate");
  });

  it("reads back the chapters a published book printed", () => {
    const published = compileBookMarkdownWithPageAnchors({
      plan: { ...plan, chapters: plan.chapters.slice(0, 1) },
      pages: Array.from({ length: 8 }, (_, offset) => page(offset + 1, `Page ${offset + 1} prose.`)),
      readerChapters: [
        { index: 1, title: "Arrival", summary: "", startPageIndex: 1, endPageIndex: 4 },
        { index: 2, title: "Storm & Calm", summary: "", startPageIndex: 5, endPageIndex: 8 }
      ]
    });
    const pages = Array.from({ length: 8 }, (_, offset) => ({ index: offset + 1 }));
    expect(readerChaptersFromPublishedMarkdown(published.markdown, pages)).toEqual([
      { index: 1, title: "Arrival", summary: "", startPageIndex: 1, endPageIndex: 4 },
      { index: 2, title: "Storm & Calm", summary: "", startPageIndex: 5, endPageIndex: 8 }
    ]);
    // A page set the Contents no longer describes (a chapter's first page is gone) is no answer.
    expect(readerChaptersFromPublishedMarkdown(published.markdown, pages.filter((entry) => entry.index !== 5))).toBeUndefined();
  });
});
