import { afterEach, describe, expect, it, vi } from "vitest";
import {
  FIGURE_DROPPED_EVENT,
  pageFigureRewrite,
  pageFigureRewriteForDraft,
  stripDraftFigures,
  restoreFigures,
  validateComposedChapterFigures
} from "./composedFigures.js";

const fence =
  "```figure\n" +
  JSON.stringify({ kind: "bar", title: "Carts by decade", categories: ["1500", "1510"], series: [{ name: "Carts", values: [120, 140] }], source: "The ledger" }) +
  "\n```";
const before = "The clerks counted the carts at the north gate.";
const after = "The towns felt the change first.";

afterEach(() => vi.restoreAllMocks());

describe("validateComposedChapterFigures", () => {
  it("keeps a planned block canonical and writes what it drops to the run log", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const runLog = { append: vi.fn(async () => "2026-09-04T00:00:00.000Z") };
    const pretty = "```figure\n" + JSON.stringify({ kind: "bar", title: "Carts by decade", categories: ["1500", "1510"], series: [{ name: "Carts", values: [120, 140] }], source: "The ledger" }, null, 2) + "\n```";
    const kept = await validateComposedChapterFigures({ markdown: `${before}\n\n${pretty}\n\n${after}`, planned: 1, projectId: "p", chapterIndex: 3, runLog });
    expect(kept).toBe(`${before}\n\n${fence}\n\n${after}`);
    expect(warn).not.toHaveBeenCalled();
    expect(runLog.append).not.toHaveBeenCalled();

    const dropped = await validateComposedChapterFigures({ markdown: `${before}\n\n${fence}\n\n${after}`, planned: 0, projectId: "p", chapterIndex: 3, runLog });
    expect(dropped).toBe(`${before}\n\n${after}`);
    // The JSONL run log is what a rerun is measured from; stdout is the echo.
    expect(runLog.append).toHaveBeenCalledTimes(1);
    expect(runLog.append).toHaveBeenCalledWith(
      FIGURE_DROPPED_EVENT,
      expect.objectContaining({ projectId: "p", chapterIndex: 3, planned: 0, reason: "no figure was planned for this chapter" })
    );
    expect(warn).toHaveBeenCalledWith(
      "Figure block dropped from a composed chapter",
      expect.objectContaining({ event: FIGURE_DROPPED_EVENT, projectId: "p", chapterIndex: 3 })
    );
  });

  it("drops an unterminated opener and logs it", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const runLog = { append: vi.fn(async () => "2026-09-04T00:00:00.000Z") };
    const markdown = `${before}\n\n\`\`\`figure\n{"kind":"bar"}\n\nno closer`;
    const dropped = await validateComposedChapterFigures({ markdown, planned: 1, projectId: "p", chapterIndex: 2, runLog });
    expect(dropped).toBe(`${before}\n\nno closer`);
    expect(runLog.append).toHaveBeenCalledWith(
      FIGURE_DROPPED_EVENT,
      expect.objectContaining({ projectId: "p", chapterIndex: 2, planned: 1, reason: "unterminated" })
    );
    expect(warn).toHaveBeenCalledWith(
      "Figure block dropped from a composed chapter",
      expect.objectContaining({ event: FIGURE_DROPPED_EVENT, reason: "unterminated" })
    );
  });

  it("drops a figure whose kind is not the planned kind", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const runLog = { append: vi.fn(async () => "2026-09-04T00:00:00.000Z") };
    const dropped = await validateComposedChapterFigures({
      markdown: `${before}\n\n${fence}\n\n${after}`,
      planned: 1,
      kind: "line",
      projectId: "p",
      chapterIndex: 4,
      runLog
    });
    expect(dropped).toBe(`${before}\n\n${after}`);
    expect(runLog.append).toHaveBeenCalledWith(
      FIGURE_DROPPED_EVENT,
      expect.objectContaining({ reason: "planned line, got bar" })
    );
  });

  it("still drops and echoes without a run logger", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    await expect(validateComposedChapterFigures({ markdown: `${before}\n\n${fence}`, planned: 0, projectId: "p", chapterIndex: 1 })).resolves.toBe(before);
  });

  it("drops an unplanned or malformed fence from every candidate independently", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const unplanned = `${before}\n\n${fence}\n\n${after}`;
    const malformed = `${before}\n\n\`\`\`figure\n{"kind":"bar"}\n\nno closer`;
    const options = { planned: 0, projectId: "p", chapterIndex: 1 };
    await expect(
      Promise.all([unplanned, malformed].map((markdown) => validateComposedChapterFigures({ ...options, markdown })))
    ).resolves.toEqual([`${before}\n\n${after}`, `${before}\n\nno closer`]);
  });
});

describe("stripDraftFigures and restoreFigures", () => {
  it("takes the figures off the pages that have them and puts them back after a revise", () => {
    const pages = [
      { index: 1, title: "One", markdown: `${before}\n\n${fence}\n\n${after}`, summary: "s", continuityNotes: [] },
      { index: 2, title: "Two", markdown: "No figure here.", summary: "s", continuityNotes: [] }
    ];
    const { drafts, fencesByIndex } = stripDraftFigures(pages);
    expect(drafts[0]!.markdown).toBe(`${before}\n\n${after}`);
    expect(drafts[1]).toBe(pages[1]);
    expect([...fencesByIndex.keys()]).toEqual([1]);
    expect(restoreFigures(drafts[0]!, fencesByIndex).markdown).toBe(pages[0]!.markdown);
    const revised = { ...drafts[0]!, markdown: `${before} Slowly, and twice.\n\n${after}` };
    expect(restoreFigures(revised, fencesByIndex).markdown).toBe(`${before} Slowly, and twice.\n\n${fence}\n\n${after}`);
    expect(restoreFigures(drafts[1]!, fencesByIndex)).toBe(drafts[1]);
  });
});

describe("pageFigureRewrite", () => {
  const page = `${before}\n\n${fence}\n\n${after}`;
  const invented =
    "```figure\n" +
    JSON.stringify({ kind: "pie", title: "Invented", categories: ["a"], series: [{ name: "S", values: [1] }], source: "nowhere" }) +
    "\n```";

  it("holds a fence the instruction does not name", () => {
    const rewrite = pageFigureRewrite(page, "make the page more dramatic");
    expect(rewrite.keep).toBe(false);
    expect(rewrite.figures).toBe("hold");
    expect(rewrite.prose).toContain("[Figure: Carts by decade]");
    expect(rewrite.prose).not.toContain("```figure");
  });

  it("puts the original fence back on hold restore", () => {
    const rewrite = pageFigureRewrite(page, "make the page more dramatic");
    const draft = { markdown: `${before} Slowly.\n\n[Figure: Carts by decade]\n\n${invented}\n\n${after}` };
    expect(rewrite.restore(draft).markdown).toBe(`${before} Slowly.\n\n${fence}\n\n${after}`);
  });

  it("keeps a fence the instruction names", () => {
    const rewrite = pageFigureRewrite(page, "give Carts by Decade a caption about the tolls");
    expect(rewrite.keep).toBe(true);
    expect(rewrite.figures).toBe("keep");
    expect(rewrite.prose).toBe(page);
    const draft = { markdown: page };
    expect(rewrite.restore(draft)).toBe(draft);
  });

  it("drops a second invented fence on keep restore", () => {
    const rewrite = pageFigureRewrite(page, "redraw the chart as a pie");
    const draft = { markdown: `${page}\n\n${invented}` };
    const restored = rewrite.restore(draft);
    expect(restored.markdown).toContain("Carts by decade");
    expect(restored.markdown).not.toContain("Invented");
    expect(restored.markdown.match(/```figure/g)).toHaveLength(1);
  });

  it("omits figures when the page has none", () => {
    const markdown = `${before}\n\n${after}`;
    const rewrite = pageFigureRewrite(markdown, "drop the chart");
    expect(rewrite.keep).toBe(false);
    expect(rewrite.figures).toBeUndefined();
    expect("figures" in rewrite).toBe(false);
    expect(rewrite.prose).toBe(markdown);
    const draft = { markdown: "rewritten" };
    expect(rewrite.restore(draft)).toBe(draft);
  });
});

describe("pageFigureRewriteForDraft", () => {
  const source = `${before}\n\n${fence}\n\n${after}`;
  const invented =
    "```figure\n" +
    JSON.stringify({ kind: "pie", title: "Invented", categories: ["a"], series: [{ name: "S", values: [1] }], source: "nowhere" }) +
    "\n```";

  it("plants a source fence onto figure-free prose and holds it when unnamed", () => {
    const { draft, rewrite } = pageFigureRewriteForDraft({ markdown: "New prose 2." }, source, "make the page more dramatic");
    expect(draft.markdown).toContain("```figure");
    expect(draft.markdown).toContain("Carts by decade");
    expect(rewrite.keep).toBe(false);
    expect(rewrite.figures).toBe("hold");
    expect(rewrite.prose).toContain("[Figure: Carts by decade]");
    expect(rewrite.prose).not.toContain("```figure");
    expect(rewrite.restore({ markdown: rewrite.prose }).markdown).toContain("```figure");
    expect(rewrite.restore({ markdown: rewrite.prose }).markdown).toContain('"kind":"bar"');
  });

  it("does not replace a draft that already has a fence with a different source fence", () => {
    const existing = { markdown: `${before}\n\n${invented}\n\n${after}` };
    const { draft, rewrite } = pageFigureRewriteForDraft(existing, source, "make the page more dramatic");
    expect(draft).toBe(existing);
    expect(draft.markdown).toContain("Invented");
    expect(draft.markdown).not.toContain("Carts by decade");
    expect(rewrite.prose).toContain("[Figure: Invented]");
    expect(rewrite.prose).not.toContain("Carts by decade");
  });

  it("keeps a named source figure after planting it onto figure-free prose", () => {
    const { draft, rewrite } = pageFigureRewriteForDraft(
      { markdown: "New prose 2." },
      source,
      "give Carts by Decade a caption about the tolls"
    );
    expect(draft.markdown).toContain("```figure");
    expect(draft.markdown).toContain("Carts by decade");
    expect(rewrite.keep).toBe(true);
    expect(rewrite.figures).toBe("keep");
    expect(rewrite.prose).toContain("```figure");
    expect(rewrite.prose).toContain("Carts by decade");
  });

  it("keeps an unreadable fence the instruction names so restore can drop it", () => {
    const unreadable = "Mara found the key.\n\n```figure\n{\"kind\":\"bar\",\"title\":\"x\"\n```\n\nShe would not use it.";
    const { rewrite } = pageFigureRewriteForDraft(
      { markdown: unreadable },
      source,
      "give Carts by Decade a caption about the tolls",
      false
    );
    expect(rewrite.keep).toBe(true);
    expect(rewrite.figures).toBe("keep");
    expect(rewrite.prose).toContain("```figure");
    expect(rewrite.restore({ markdown: rewrite.prose }).markdown).not.toContain("```figure");
  });

  it("does not plant a named source figure onto a figure-free keep drop", () => {
    const incoming = { markdown: "Mara found the key." };
    const { draft, rewrite } = pageFigureRewriteForDraft(
      incoming,
      source,
      "give Carts by Decade a caption about the tolls",
      false
    );
    expect(draft).toBe(incoming);
    expect(draft.markdown).not.toContain("```figure");
    expect(draft.markdown).not.toContain("Carts by decade");
    expect(rewrite.keep).toBe(false);
    expect(rewrite.figures).toBeUndefined();
    expect("figures" in rewrite).toBe(false);
    expect(rewrite.restore(incoming)).toBe(incoming);
  });
});
