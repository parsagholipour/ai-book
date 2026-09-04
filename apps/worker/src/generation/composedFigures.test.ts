import { afterEach, describe, expect, it, vi } from "vitest";
import { figureFreeDrafts, restoreFigures, validateComposedChapterFigures } from "./composedFigures.js";

const fence =
  "```figure\n" +
  JSON.stringify({ kind: "bar", title: "Carts by decade", categories: ["1500", "1510"], series: [{ name: "Carts", values: [120, 140] }], source: "The ledger" }) +
  "\n```";
const before = "The clerks counted the carts at the north gate.";
const after = "The towns felt the change first.";

afterEach(() => vi.restoreAllMocks());

describe("validateComposedChapterFigures", () => {
  it("keeps a planned block canonical and logs what it drops", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const pretty = "```figure\n" + JSON.stringify({ kind: "bar", title: "Carts by decade", categories: ["1500", "1510"], series: [{ name: "Carts", values: [120, 140] }], source: "The ledger" }, null, 2) + "\n```";
    const kept = validateComposedChapterFigures({ markdown: `${before}\n\n${pretty}\n\n${after}`, planned: 1, projectId: "p", chapterIndex: 3 });
    expect(kept).toBe(`${before}\n\n${fence}\n\n${after}`);
    expect(warn).not.toHaveBeenCalled();

    const dropped = validateComposedChapterFigures({ markdown: `${before}\n\n${fence}\n\n${after}`, planned: 0, projectId: "p", chapterIndex: 3 });
    expect(dropped).toBe(`${before}\n\n${after}`);
    expect(warn).toHaveBeenCalledWith(
      "Figure block dropped from a composed chapter",
      expect.objectContaining({ event: "generation.composed_chapters.figure_dropped", projectId: "p", chapterIndex: 3 })
    );
  });
});

describe("figureFreeDrafts and restoreFigures", () => {
  it("takes the figures off the pages that have them and puts them back after a revise", () => {
    const pages = [
      { index: 1, title: "One", markdown: `${before}\n\n${fence}\n\n${after}`, summary: "s", continuityNotes: [] },
      { index: 2, title: "Two", markdown: "No figure here.", summary: "s", continuityNotes: [] }
    ];
    const { drafts, fencesByIndex } = figureFreeDrafts(pages);
    expect(drafts[0]!.markdown).toBe(`${before}\n\n${after}`);
    expect(drafts[1]).toBe(pages[1]);
    expect([...fencesByIndex.keys()]).toEqual([1]);
    expect(restoreFigures(drafts[0]!, fencesByIndex).markdown).toBe(pages[0]!.markdown);
    const revised = { ...drafts[0]!, markdown: `${before} Slowly, and twice.\n\n${after}` };
    expect(restoreFigures(revised, fencesByIndex).markdown).toBe(`${before} Slowly, and twice.\n\n${fence}\n\n${after}`);
    expect(restoreFigures(drafts[1]!, fencesByIndex)).toBe(drafts[1]);
  });
});
