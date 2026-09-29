import { bookPlanSchema, synthesizeAuthorBookPlan } from "@book-maker/core";
import { describe, expect, it } from "vitest";
import type { BookPageRow } from "./manuscript/manuscriptBook.js";
import {
  planTakeoverBook,
  planWithTakeoverChapters,
  takeoverArtStyle,
  takeoverStudioShape
} from "./manuscript/manuscriptTakeoverPlan.js";

function page(index: number, chapterId: string | null, markdown: string, extra: Partial<BookPageRow> = {}): BookPageRow {
  return {
    id: `page-${index}`,
    index,
    chapterId,
    title: `Page ${index} title`,
    markdown,
    status: "COMPLETED",
    revision: 1,
    heroPath: null,
    imageIds: [],
    ...extra
  };
}

const rows = [
  { id: "ch-1", index: 1, title: "Chapter 1" },
  { id: "ch-2", index: 2, title: "The Storm" }
];
const pages = [page(1, "ch-1", "One."), page(2, "ch-1", "Two."), page(3, "ch-2", "Three."), page(4, "ch-2", "Four.")];

describe("the Studio shape a generated book continues in", () => {
  it("keeps a book that prints one sheet a page a picture book, and flows everything else", () => {
    expect(takeoverStudioShape({ category: "KIDS", printsSeparateStoryPages: true })).toEqual({ kind: "picture", layout: "picture" });
    expect(takeoverStudioShape({ category: "KIDS", printsSeparateStoryPages: false })).toEqual({ kind: "picture", layout: "flow" });
    expect(takeoverStudioShape({ category: "STORY", printsSeparateStoryPages: false })).toEqual({ kind: "story", layout: "flow" });
    expect(takeoverStudioShape({ category: "HISTORY", printsSeparateStoryPages: false }).kind).toBe("nonfiction");
    expect(takeoverStudioShape({ category: "CUSTOM", printsSeparateStoryPages: false }).kind).toBe("other");
  });

  it("carries the book's illustration style, clipped to what the Studio record accepts", () => {
    const plan = synthesizeAuthorBookPlan({ title: "T", chapters: [{ title: "A", summary: "a", pageCount: 1 }], artStyle: "Ink and wash" });
    expect(takeoverArtStyle({ plan, imageStyle: "watercolor", hasPictures: true })).toBe("Ink and wash");
    expect(takeoverArtStyle({ plan, imageStyle: "watercolor", hasPictures: false })).toBe("watercolor");
    expect(takeoverArtStyle({ plan: {}, imageStyle: undefined, hasPictures: true })).toBeNull();
    const long = synthesizeAuthorBookPlan({ title: "T", chapters: [{ title: "A", summary: "a", pageCount: 1 }], artStyle: "soft ".repeat(120) });
    expect(takeoverArtStyle({ plan: long, imageStyle: null, hasPictures: true })!.length).toBeLessThanOrEqual(400);
  });
});

describe("what a takeover writes", () => {
  it("writes only the pages whose text changes, hero first, and detaches every attached picture", () => {
    const plan = planTakeoverBook({
      chapters: rows,
      pages: [
        page(1, "ch-1", "One.", { heroPath: "/assets/images/p/one.jpg", imageIds: ["img-1", "img-1b"] }),
        page(2, "ch-1", "Two."),
        page(3, "ch-2", "## Chapter 2: The Storm\n\nThree."),
        page(4, "ch-2", "## Page 4 title")
      ],
      readerChapters: undefined,
      language: "en"
    });
    expect(plan.chapterSlots).toBeNull();
    expect(plan.pageWrites).toEqual([
      { id: "page-1", index: 1, chapterId: "ch-1", markdown: "![Illustration](/assets/images/p/one.jpg)\n\nOne.", revision: 2 },
      { id: "page-3", index: 3, chapterId: "ch-2", markdown: "Three.", revision: 2 }
    ]);
    // A page that was nothing but a title keeps its text rather than going empty.
    expect(plan.detachImageIds).toEqual(["img-1", "img-1b"]);
  });

  it("moves only the titles when the reader saw the same chapters under printed names", () => {
    const plan = planTakeoverBook({
      chapters: rows,
      pages,
      readerChapters: [
        { index: 1, title: "The Lamp", summary: "", startPageIndex: 1, endPageIndex: 2 },
        { index: 2, title: "The Storm", summary: "", startPageIndex: 3, endPageIndex: 4 }
      ],
      language: "en"
    });
    expect(plan.repartitioned).toBe(false);
    expect(plan.chapterSlots!.map((slot) => [slot.id, slot.title])).toEqual([["ch-1", "The Lamp"], ["ch-2", "The Storm"]]);
    expect(plan.pageWrites).toEqual([]);
    expect(plan.chapterDeleteIds).toEqual([]);

    const planned = synthesizeAuthorBookPlan({
      title: "T",
      chapters: [{ title: "Chapter 1", summary: "s1", pageCount: 2 }, { title: "The Storm", summary: "s2", pageCount: 2 }]
    });
    planned.chapters[0]!.keyBeats = ["She lights the lamp."];
    const kept = planWithTakeoverChapters(planned, plan.chapterSlots!, false)!;
    expect(kept.chapters[0]).toMatchObject({ title: "The Lamp", summary: "s1", keyBeats: ["She lights the lamp."] });
  });

  it("re-partitions into the reader's chapters by position, creating and deleting rows at the tail", () => {
    const plan = planTakeoverBook({
      chapters: rows,
      pages,
      readerChapters: [
        { index: 1, title: "Arrival", summary: "", startPageIndex: 1, endPageIndex: 1 },
        { index: 2, title: "Middle", summary: "", startPageIndex: 2, endPageIndex: 3 },
        { index: 3, title: "Leaving", summary: "", startPageIndex: 4, endPageIndex: 4 }
      ],
      language: "en"
    });
    expect(plan.repartitioned).toBe(true);
    expect(plan.chapterSlots!.map((slot) => [slot.index, slot.title, slot.targetPages, slot.create])).toEqual([
      [1, "Arrival", 1, false],
      [2, "Middle", 2, false],
      [3, "Leaving", 1, true]
    ]);
    const third = plan.chapterSlots![2]!.id;
    expect(plan.pageWrites.map((write) => [write.id, write.chapterId])).toEqual([
      ["page-2", "ch-2"],
      ["page-4", third]
    ]);
    const replanned = planWithTakeoverChapters(
      synthesizeAuthorBookPlan({ title: "T", chapters: [{ title: "A", summary: "a", pageCount: 2 }, { title: "B", summary: "b", pageCount: 2 }] }),
      plan.chapterSlots!,
      true
    )!;
    expect(bookPlanSchema.safeParse(replanned).success).toBe(true);
    expect(replanned.chapters.map((chapter) => [chapter.title, chapter.targetPages])).toEqual([
      ["Arrival", 1],
      ["Middle", 2],
      ["Leaving", 1]
    ]);
  });
});
