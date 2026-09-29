import { describe, expect, it } from "vitest";
import { MAX_BOOK_PAGES, paginateWorkingCopy, planBookSlots } from "./manuscript/manuscriptPublishPlan.js";

function chapter(id: string, position: number, title: string, markdown: string) {
  return { id, position, title, markdown, wordCount: 1, revision: 2, publishedRevision: null, conflictDetectedAt: null };
}

describe("paginating the working copy", () => {
  it("widens the page target until a long flow book fits under the page ceiling", () => {
    const paragraph = "word ".repeat(200).trim();
    const markdown = Array.from({ length: 1400 }, () => paragraph).join("\n\n");

    const paginated = paginateWorkingCopy([chapter("c1", 1, "Everything", markdown)], "flow");

    expect(paginated.pageCount).toBeLessThanOrEqual(MAX_BOOK_PAGES);
    expect(paginated.targetChars).toBeGreaterThan(1900);
    expect(paginated.chapters[0]!.pages.join("\n\n")).toBe(markdown);
  });

  it("skips empty chapters and keeps a picture book's explicit pages", () => {
    const paginated = paginateWorkingCopy(
      [
        chapter("c1", 1, "Story", "![A fox](/assets/images/p/upload-a.jpg)\n\nThe fox.\n\n<!-- page -->\n\nThe hen."),
        chapter("c2", 2, "Empty", "   ")
      ],
      "picture"
    );
    expect(paginated.chapters.map((entry) => entry.pages)).toEqual([["![A fox](/assets/images/p/upload-a.jpg)\n\nThe fox.", "The hen."]]);
    expect(paginated.emptyChapterIds).toEqual(["c2"]);
  });
});

describe("landing pages on the book's rows", () => {
  it("keeps an identical slot, rewrites a changed one, and detaches every image on a page it rewrites", () => {
    const paginated = paginateWorkingCopy(
      [chapter("c1", 1, "One", `${"Alpha ".repeat(240).trim()}\n\n${"Beta ".repeat(240).trim()}`)],
      "flow"
    );
    const titles = paginated.chapters[0]!.pages.map((_, index) => `One · ${index + 1}`);
    const slots = planBookSlots({
      paginated,
      existingChapters: [{ id: "chapter-1", index: 1 }, { id: "chapter-9", index: 9 }],
      existingPages: [
        { id: "page-1", index: 1, chapterId: "chapter-1", title: titles[0]!, markdown: paginated.chapters[0]!.pages[0]!, status: "COMPLETED", revision: 3, imageIds: [] },
        { id: "page-2", index: 2, chapterId: "chapter-1", title: "Old", markdown: "Old text", status: "COMPLETED", revision: 5, imageIds: ["hero-2"] },
        { id: "page-3", index: 3, chapterId: "chapter-1", title: "Gone", markdown: "Gone", status: "COMPLETED", revision: 1, imageIds: [] }
      ]
    });

    expect(paginated.pageCount).toBe(2);
    expect(slots.pageKeeps.map((page) => page.id)).toEqual(["page-1"]);
    expect(slots.pageUpdates.map((page) => [page.id, page.revision, page.title])).toEqual([["page-2", 6, "One · 2"]]);
    expect(slots.pageDeleteIds).toEqual(["page-3"]);
    expect(slots.detachImageIds).toEqual(["hero-2"]);
    expect(slots.chapterUpdates.map((row) => [row.id, row.targetPages])).toEqual([["chapter-1", 2]]);
    expect(slots.chapterDeleteIds).toEqual(["chapter-9"]);
    expect(slots.shrank).toBe(true);
    expect(slots.published.get("c1")).toEqual({
      bookChapterId: "chapter-1",
      pages: [{ pageId: "page-1", revision: 3 }, { pageId: "page-2", revision: 6 }]
    });
  });

  it("rewrites an identical page a chat edit left unsettled, because the compile waits for every page to be COMPLETED", () => {
    const paginated = paginateWorkingCopy([chapter("c1", 1, "One", "Only page.")], "flow");
    const slots = planBookSlots({
      paginated,
      existingChapters: [{ id: "chapter-1", index: 1 }],
      existingPages: [
        { id: "page-1", index: 1, chapterId: "chapter-1", title: "One · 1", markdown: "Only page.", status: "FAILED_QA", revision: 4, imageIds: [] }
      ]
    });
    expect(slots.pageKeeps).toEqual([]);
    expect(slots.pageUpdates.map((page) => [page.id, page.revision])).toEqual([["page-1", 5]]);
  });
});
