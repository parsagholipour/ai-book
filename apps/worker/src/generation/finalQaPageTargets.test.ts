import { describe, expect, it } from "vitest";
import { extractRepairPageIndexesFromText, lastPageIndex } from "./finalQaPageTargets.js";

// Pure text in, page indexes out: no module mocks, no database, no config.

describe("extractRepairPageIndexesFromText", () => {
  it("takes the named pages and nothing else", () => {
    // The reader's quality card asks this one per message: no edge heuristic, so
    // a complaint that named no page links nowhere rather than to a guess.
    expect(extractRepairPageIndexesFromText("The opening is meta.", 20)).toEqual([]);
    expect(extractRepairPageIndexesFromText("Page 40 repeats page 3.", 20)).toEqual([3]);
  });

  it.each<[string, number[]]>([
    // The two shapes that used to lose pages. Both were survivable while the
    // verdict's whole union was stamped on every issue; the card asks this per
    // message, so the first printed "Pages 6 · Open Edit Mode" for a complaint
    // about three pages and tapped through to the wrong one, and the second lost
    // page 7 entirely — after "pages 3, 5" was consumed, the trailing "and 7"
    // had no keyword left to match.
    ["Pages 4 to 6 restate the premise.", [4, 5, 6]],
    ["Pages 3, 5 and 7 repeat the opening.", [3, 5, 7]],
    // Every dash a model emits, the serial comma, and the keyword repeated
    // after a separator — which used to break one reference into two matches.
    ["Pages 4-6 restate the premise.", [4, 5, 6]],
    ["Pages 4–6 restate the premise.", [4, 5, 6]],
    ["Pages 3 through 5 and 8 to 9 repeat the same beat.", [3, 4, 5, 8, 9]],
    ["Pages 3, 5, and 7 repeat the opening.", [3, 5, 7]],
    ["Page 3, page 5 and page 7 repeat the opening.", [3, 5, 7]],
    // A span is expanded because the card prints every page a human can turn
    // to and the repair redrafts what the complaint names — until it is wide
    // enough to be a complaint about the book, when only the two pages the
    // sentence types survive.
    ["Pages 1 to 20 all restate the premise.", [1, 20]],
    // Descending is two references, not a span.
    ["Pages 6 to 4 are out of order.", [6, 4]]
  ])("answers the whole reference in %j", (message, expected) => {
    expect(extractRepairPageIndexesFromText(message, 20)).toEqual(expected);
  });

  it("clamps a span to the book before walking it, never after", () => {
    // A 20-page book has no page 400, and enumerating up to one would build 399
    // entries for the bound to drop 380 of them. Over the span cap, so only the
    // pages the sentence names are offered, and only the one that exists.
    expect(extractRepairPageIndexesFromText("Pages 2 to 400 restate the premise.", 20)).toEqual([2]);
    // A span whose end is past the last page still hands over the pages that
    // are there — the reviewer's numbers came from a manuscript, not a plan.
    expect(extractRepairPageIndexesFromText("Pages 4 to 6 restate the premise.", 5)).toEqual([4, 5]);
    expect(extractRepairPageIndexesFromText("Pages 40 to 60 restate the premise.", 20)).toEqual([]);
  });

  it("still reads a lone 'from page N' as provenance rather than as a target", () => {
    // Where something came from is not what the complaint is about.
    expect(extractRepairPageIndexesFromText("Move the epigraph from page 4 onto page 9.", 20)).toEqual([9]);
    // But the guard used to swallow the start of a span written this way, and
    // the rest of it collapsed to its last number.
    expect(extractRepairPageIndexesFromText("Copy the quote from page 4 to page 6 verbatim.", 20)).toEqual([
      4, 5, 6
    ]);
  });
});

describe("lastPageIndex", () => {
  it("is the book's own last page, not the plan's page count", () => {
    // The manuscript audit reports a page count off the target as a mismatch, so
    // the two genuinely disagree — and the reader can only open the pages that
    // exist.
    expect(lastPageIndex([{ index: 1 }, { index: 2 }, { index: 3 }])).toBe(3);
    expect(lastPageIndex([])).toBe(0);
  });

  it("bounds a tail complaint into the book a longer manuscript actually has", () => {
    const pages = Array.from({ length: 24 }, (_, position) => ({ index: position + 1 }));
    // Bounded by a 20-page plan, page 23 was dropped and the card showed no link
    // at all for a complaint about the tail.
    expect(extractRepairPageIndexesFromText("Page 23 trails off.", 20)).toEqual([]);
    expect(extractRepairPageIndexesFromText("Page 23 trails off.", lastPageIndex(pages))).toEqual([23]);
  });
});
