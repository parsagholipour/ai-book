import { describe, expect, it } from "vitest";
import { acceptedSavedPageTarget, terminalSavedPageCount } from "./wholeBookTolerance.js";

describe("whole-book compile tolerance", () => {
  it("accepts contiguous saved pages within tolerance for whole-book draft strategies", () => {
    expect(
      acceptedSavedPageTarget(
        { targetPages: 18 },
        { executionMode: "draft-then-polish", generateWholeBookDraft: async () => ({ pages: [] }) },
        indexedPages(15)
      )
    ).toBe(15);
  });

  it("does not relax page readiness for non-whole-book strategies", () => {
    expect(
      acceptedSavedPageTarget({ targetPages: 18 }, { executionMode: "sequential-pages" }, indexedPages(15))
    ).toBeUndefined();
  });

  it("requires saved pages to be compact and contiguous", () => {
    expect(
      acceptedSavedPageTarget(
        { targetPages: 18 },
        { executionMode: "whole-book", generateWholeBookDraft: async () => ({ pages: [] }) },
        [{ index: 1 }, { index: 2 }, { index: 4 }]
      )
    ).toBeUndefined();
  });

  it("counts completed pages and failed-QA pages with kept drafts as terminal", () => {
    expect(
      terminalSavedPageCount([
        { status: "COMPLETED", markdown: "Done." },
        { status: "FAILED_QA", markdown: "Draft kept." },
        { status: "FAILED_QA", markdown: "" },
        { status: "PENDING", markdown: "Not terminal." }
      ])
    ).toBe(2);
  });
});

function indexedPages(count: number): Array<{ index: number }> {
  return Array.from({ length: count }, (_, index) => ({ index: index + 1 }));
}
