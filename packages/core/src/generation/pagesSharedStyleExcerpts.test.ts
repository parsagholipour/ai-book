import { describe, expect, it } from "vitest";
import { pinStyleExcerpts, type PriorPageContext } from "./pagesShared.js";

function page(index: number, voice: string): PriorPageContext {
  return {
    index,
    title: `Page ${index}`,
    markdown: `${voice} ${"prose ".repeat(20)}`,
    summary: `Summary ${index}`
  };
}

describe("pinStyleExcerpts", () => {
  it("excerpts the two lowest-index pages even when they are not first in the array", () => {
    const excerpts = pinStyleExcerpts([
      page(17, "seventeen-window"),
      page(18, "eighteen-window"),
      page(1, "opening-voice"),
      page(2, "second-voice")
    ]);
    expect(excerpts).toHaveLength(2);
    expect(excerpts[0]).toContain("opening-voice");
    expect(excerpts[1]).toContain("second-voice");
    expect(excerpts.join(" ")).not.toMatch(/seventeen-window|eighteen-window/);
  });

  it("cannot invent pages 1 and 2 when only later pages are present", () => {
    const excerpts = pinStyleExcerpts([page(17, "seventeen-window"), page(18, "eighteen-window")]);
    expect(excerpts).toHaveLength(2);
    expect(excerpts[0]).toContain("seventeen-window");
    expect(excerpts[1]).toContain("eighteen-window");
  });
});
