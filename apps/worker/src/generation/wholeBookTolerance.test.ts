import { describe, expect, it } from "vitest";
import { acceptedSavedPageTarget, terminalSavedPageCount } from "./wholeBookTolerance.js";

describe("whole-book compile tolerance", () => {
  it.each([29, 34])("refuses to export %i pages for a thirty-page request", count => {
    expect(acceptedSavedPageTarget({ targetPages: 30 }, { executionMode: "whole-book" }, indexedPages(count))).toBeUndefined();
  });

  it("does not grow the allowance again after the selected count is saved", () => {
    const input = { targetPages: 33, mediaSettings: { generationPageCount: { requestedPages: 30, selectedPages: 33 } } };
    expect(acceptedSavedPageTarget(input as never, { executionMode: "whole-book" }, indexedPages(33))).toBe(33);
    expect(acceptedSavedPageTarget(input as never, { executionMode: "whole-book" }, indexedPages(34))).toBeUndefined();
  });
  it("accepts contiguous saved pages within tolerance for whole-book draft strategies", () => {
    expect(
      acceptedSavedPageTarget(
        { targetPages: 18 },
        { executionMode: "draft-then-polish", generateWholeBookDraft: async () => ({ pages: [] }) },
        indexedPages(19)
      )
    ).toBe(19);
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
