import { describe, expect, it } from "vitest";
import { pageDraftSummary } from "./figures/figureDraftSummary.js";
import { compactFollowingPages, compactPriorPages, pinStyleExcerpts, type PriorPageContext } from "./pagesShared.js";

/**
 * Every prior-page excerpt a prompt is shown is figure-blind: a page from a
 * composed chapter carries its block, and a page writer shown the JSON has a
 * thing to imitate. Kept apart from `pagesSharedStyleExcerpts.test.ts` and
 * `pagesShared.test.ts` so the figure rule reads in one place.
 */
const figureJson = {
  kind: "bar",
  title: "Carts by decade",
  categories: ["1500", "1510"],
  series: [{ name: "Carts", values: [120, 140] }],
  source: "The ledger"
};
const fence = "```figure\n" + JSON.stringify(figureJson) + "\n```";
const opening = "The clerks counted the carts at the north gate, and the ledger they kept still names every carrier.";
const closing = "The towns felt the change first.";

function page(index: number, markdown: string, summary = `Summary ${index}`): PriorPageContext {
  return { index, title: `Page ${index}`, markdown, summary };
}

describe("prior-page excerpts and figure blocks", () => {
  it("cuts a prompt excerpt from the stand-in form and leaves a page without a figure as it was", () => {
    const withFigure = page(3, `${opening}\n\n${fence}\n\n${closing}`);
    const plain = page(4, `${opening}\n\n${closing}`);
    for (const compact of [compactPriorPages([withFigure, plain], 2, 900), compactFollowingPages([withFigure, plain], 2, 900)]) {
      expect(compact[0]!.excerpt).toBe(`${opening}\n\n[Figure: Carts by decade]\n\n${closing}`);
      expect(compact[0]!.excerpt).not.toContain("```");
      expect(compact[1]!.excerpt).toBe(plain.markdown);
      expect(compact[0]!.summary).toBe("Summary 3");
      expect(compact[1]!.summary).toBe("Summary 4");
    }
  });

  it("runs compact summaries through pageDraftSummary so leaked figure JSON never reaches the writer", () => {
    const leaked = page(3, `${opening}\n\n${fence}\n\n${closing}`, JSON.stringify(figureJson));
    const expected = pageDraftSummary(leaked.markdown, leaked.summary);
    for (const compact of [compactPriorPages([leaked], 1, 900), compactFollowingPages([leaked], 1, 900)]) {
      expect(compact[0]!.summary).toBe(expected);
      expect(compact[0]!.summary).toMatch(/clerks counted/i);
      expect(compact[0]!.summary).not.toContain('"kind"');
      expect(compact[0]!.summary).not.toContain("```figure");
      expect(compact[0]!.summary).not.toContain("Carts by decade");
    }
  });

  it("pins the style lock from prose, with the figure as its stand-in", () => {
    const excerpts = pinStyleExcerpts([page(1, `${opening}\n\n${fence}\n\n${closing}`), page(2, `${closing} ${opening}`)]);
    expect(excerpts).toHaveLength(2);
    expect(excerpts[0]).toContain("[Figure: Carts by decade]");
    expect(excerpts[0]).not.toContain("```figure");
    expect(excerpts[1]).toBe(`${closing} ${opening}`);
  });
});
