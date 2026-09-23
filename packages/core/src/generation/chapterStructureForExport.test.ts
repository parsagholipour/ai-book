import { expect, it } from "vitest";
import { chapterStructureForExport, compileBookMarkdown } from "./markdown.js";
import { originalDevelopmentPlan } from "./testing/bookDevelopmentFixtures.js";

const plan = originalDevelopmentPlan();
const pages = Array.from({ length: 12 }, (_, position) => ({ index: position + 1, title: "Page", markdown: "Body prose." }));

it("reports the current reader divisions instead of the original chapter targets", () => {
  const readerChapters = [
    { index: 1, title: "Merged opening", summary: "", startPageIndex: 1, endPageIndex: 8 },
    { index: 2, title: "New ending", summary: "", startPageIndex: 9, endPageIndex: 12 }
  ];
  const input = { plan, pages, readerChapters };
  expect(chapterStructureForExport(input)).toEqual(readerChapters.map(({ summary: _summary, ...chapter }) => chapter));
  const markdown = compileBookMarkdown(input);
  expect(markdown).toContain("Merged opening");
  expect(markdown).toContain("New ending");
  expect(markdown).not.toContain(plan.chapters[1]!.title);
});

it("uses the same fallback divisions as rendering and excludes unprinted apparatus", () => {
  const fallback = chapterStructureForExport({ plan, pages, readerChapters: [] });
  expect(fallback.map((chapter) => chapter.title)).toEqual(plan.chapters.map((chapter) => chapter.title));
  expect(fallback.at(-1)?.endPageIndex).toBe(12);
  const shortInput = { plan, pages: pages.slice(0, 1), readerChapters: [] };
  expect(chapterStructureForExport(shortInput)).toEqual([]);
  expect(compileBookMarkdown(shortInput)).not.toContain('id="chapter-');
});
