import { describe, expect, it } from "vitest";
import type { BookPlan } from "@book-maker/core";
import {
  continuationChapterPlans,
  continuationPageIndexes,
  distributeContinuationPages,
  fallbackContinuationOutline
} from "./continueBook.js";

describe("distributeContinuationPages", () => {
  it("spreads the charged page budget evenly with remainders first", () => {
    expect(distributeContinuationPages(10, 2)).toEqual([5, 5]);
    expect(distributeContinuationPages(11, 3)).toEqual([4, 4, 3]);
    expect(distributeContinuationPages(5, 1)).toEqual([5]);
  });

  it("guarantees at least one page per chapter", () => {
    expect(distributeContinuationPages(1, 3)).toEqual([1, 1, 1]);
    expect(distributeContinuationPages(0, 2)).toEqual([1, 1]);
  });
});

describe("continuationChapterPlans", () => {
  it("appends chapters after the existing plan with the page distribution", () => {
    const plan = { chapters: [{ index: 1 }, { index: 2 }] } as unknown as BookPlan;
    const outline = {
      chapters: [
        { title: "New Dawn", summary: "The sequel begins.", keyBeats: ["arrival"] },
        { title: "New Dusk", summary: "It ends.", keyBeats: [] }
      ]
    };
    const chapters = continuationChapterPlans(plan, outline, [4, 3], 3);
    expect(chapters).toEqual([
      { index: 3, title: "New Dawn", summary: "The sequel begins.", targetPages: 4, keyBeats: ["arrival"] },
      { index: 4, title: "New Dusk", summary: "It ends.", targetPages: 3, keyBeats: [] }
    ]);
  });
});

describe("continuationPageIndexes", () => {
  it("continues global page numbering after the last existing page", () => {
    expect(continuationPageIndexes(42, [2, 3])).toEqual([43, 44, 45, 46, 47]);
  });
});

describe("fallbackContinuationOutline", () => {
  it("builds a deterministic outline from the author's directive", () => {
    const outline = fallbackContinuationOutline("Write what happens after the wedding", 2);
    expect(outline.chapters).toHaveLength(2);
    expect(outline.chapters[0]!.summary).toContain("after the wedding");
  });

  it("falls back to a generic directive for empty requests", () => {
    const outline = fallbackContinuationOutline("   ", 1);
    expect(outline.chapters[0]!.summary).toContain("Continue the story");
  });
});
