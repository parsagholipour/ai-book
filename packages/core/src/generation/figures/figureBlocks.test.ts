import { describe, expect, it } from "vitest";
import {
  FIGURE_WORD_EQUIVALENT,
  figureFreeProse,
  figureStandInMarkdown,
  figureWordEquivalent,
  findFigureFences,
  hasFigureFence,
  isFigureFenceBlock,
  mentionsFigure,
  proseWordCount,
  reinsertFigureFences,
  stripFigureFences,
  validateFigureFences
} from "./figureBlocks.js";

const spec = {
  kind: "bar",
  title: "Share of the workforce in farming",
  categories: ["1900", "1950", "2000"],
  series: [{ name: "United States", values: [41, 12, 2] }],
  unit: "%",
  source: "US Census Bureau"
};
const fence = "```figure\n" + JSON.stringify(spec) + "\n```";

const before = "The farm counted its people every ten years. By 1900 two in five worked the land, and the census clerks wrote it down.";
const after = "This is the paragraph that follows the figure, and it goes on to say what the numbers meant for the towns.";
const chapter = `${before}\n\n${fence}\n\n${after}\n\nA closing paragraph about the harvest and the road out of town.`;

describe("findFigureFences", () => {
  it("finds a figure block with its title and ignores other fences", () => {
    const found = findFigureFences(chapter);
    expect(found).toHaveLength(1);
    expect(found[0]!.title).toBe("Share of the workforce in farming");
    expect(found[0]!.spec?.kind).toBe("bar");
    expect(chapter.slice(found[0]!.start, found[0]!.end)).toBe(fence);
    expect(findFigureFences("```python\nprint(1)\n```")).toHaveLength(0);
    expect(findFigureFences("```figure\n{\"kind\":\"bar\"}\n\nno closer")).toHaveLength(0);
    expect(hasFigureFence(chapter)).toBe(true);
    expect(hasFigureFence(before)).toBe(false);
  });

  it("names an unreadable block by its title key when it has one", () => {
    const broken = '```figure\n{"kind":"bar","title":"Broken \\"chart\\"",}}\n```';
    const found = findFigureFences(broken);
    expect(found[0]!.spec).toBeUndefined();
    expect(found[0]!.title).toBe('Broken "chart"');
  });

  it("recognises a block that is exactly one fence", () => {
    expect(isFigureFenceBlock(fence)).toBe(true);
    expect(isFigureFenceBlock(`${before}\n${fence}`)).toBe(false);
    expect(isFigureFenceBlock("```figure\n{}\n```\ntrailing")).toBe(false);
  });
});

describe("figureFreeProse and figureStandInMarkdown", () => {
  it("removes or replaces the block and leaves prose alone", () => {
    expect(figureFreeProse(chapter)).toBe(`${before}\n\n${after}\n\nA closing paragraph about the harvest and the road out of town.`);
    expect(figureStandInMarkdown(chapter)).toContain(`${before}\n\n[Figure: Share of the workforce in farming]\n\n${after}`);
    expect(figureFreeProse(before)).toBe(before);
    expect(figureStandInMarkdown(before)).toBe(before);
    expect(proseWordCount(chapter)).toBe(proseWordCount(figureFreeProse(chapter)));
    expect(proseWordCount(chapter)).toBeLessThan(proseWordCount(chapter.replace(fence, JSON.stringify(spec))));
  });
});

describe("stripFigureFences and reinsertFigureFences", () => {
  it("remembers the neighbouring paragraphs and shows the editor a stand-in", () => {
    const { prose, fences } = stripFigureFences(chapter);
    expect(prose).not.toContain("```");
    expect(prose).toContain("[Figure: Share of the workforce in farming]");
    expect(fences).toHaveLength(1);
    expect(fences[0]!.anchor).toBe(before);
    expect(fences[0]!.follower).toBe(after);
    expect(fences[0]!.fence).toBe(fence);
  });

  it("restores a kept stand-in in place, byte for byte", () => {
    const { prose, fences } = stripFigureFences(chapter);
    expect(reinsertFigureFences(prose, fences)).toBe(chapter);
  });

  it("places the block after the anchor paragraph when the editor rewrote it but kept its first sentence", () => {
    const { fences } = stripFigureFences(chapter);
    const edited = `${before.split(". ")[0]}. The clerks counted differently now, and the towns felt it.\n\n${after}`;
    const restored = reinsertFigureFences(edited, fences);
    const blocks = restored.split("\n\n");
    expect(blocks[1]).toBe(fence);
    expect(blocks).toHaveLength(3);
  });

  it("falls back to token overlap, then to the follower, then to the end", () => {
    const { fences } = stripFigureFences(chapter);
    const paraphrased = "Every ten years the farm counted its people, and by 1900 two in five worked the land; the census clerks wrote it down.";
    expect(reinsertFigureFences(`${paraphrased}\n\n${after}`, fences).split("\n\n")[1]).toBe(fence);
    expect(reinsertFigureFences(`Something else entirely about ships.\n\n${after}`, fences).split("\n\n")[1]).toBe(fence);
    const restored = reinsertFigureFences("Something else entirely about ships.\n\nAnd a second paragraph about ports.", fences);
    expect(restored.endsWith(fence)).toBe(true);
  });

  it("removes every stand-in the pass echoed and keeps one figure", () => {
    const { fences } = stripFigureFences(chapter);
    const echoed = `${before}\n\n[Figure: Share of the workforce in farming]\n\n${after}\n\n[Figure: Share of the workforce in farming]\n\n[figure: share of the workforce in farming]`;
    const restored = reinsertFigureFences(echoed, fences);
    expect(restored.match(/```figure/g)).toHaveLength(1);
    expect(restored).not.toMatch(/\[Figure:/i);
  });

  it("returns prose byte for byte when there was nothing to put back", () => {
    const prose = `${before}\n\n\n\n[Figure: stray]`;
    expect(reinsertFigureFences(prose, [])).toBe(prose);
  });
});

describe("validateFigureFences", () => {
  it("keeps the first planned block, canonicalises it, and drops the rest", () => {
    const pretty = "```figure\n" + JSON.stringify(spec, null, 2) + "\n```";
    const second = "```figure\n" + JSON.stringify({ ...spec, title: "A second chart" }) + "\n```";
    const glued = `${before}\n${pretty}\n${after}\n\n${second}`;
    const result = validateFigureFences(glued, { max: 1 });
    expect(result.kept).toBe(1);
    expect(result.dropped).toEqual([{ reason: "over the planned count", excerpt: expect.stringContaining("A second chart") }]);
    expect(result.markdown).toBe(`${before}\n\n${fence}\n\n${after}`);
  });

  it("drops an unreadable block with its reason and leaves the prose", () => {
    const broken = `${before}\n\n\`\`\`figure\n{"kind":"bar","title":"x"\n\`\`\`\n\n${after}`;
    const result = validateFigureFences(broken, { max: 1 });
    expect(result.kept).toBe(0);
    expect(result.dropped[0]!.reason).toMatch(/not JSON/);
    expect(result.markdown).toBe(`${before}\n\n${after}`);
  });

  it("drops every block when none was planned and is byte-identical on a canonical chapter", () => {
    expect(validateFigureFences(chapter, { max: 0 }).markdown).toBe(`${before}\n\n${after}\n\nA closing paragraph about the harvest and the road out of town.`);
    expect(validateFigureFences(chapter, { max: 0 }).dropped[0]!.reason).toMatch(/no figure was planned/);
    const canonical = validateFigureFences(chapter, { max: 1 });
    expect(canonical.markdown).toBe(chapter);
    expect(canonical.kept).toBe(1);
    expect(validateFigureFences(before, { max: 1 }).markdown).toBe(before);
  });
});

describe("figureWordEquivalent", () => {
  it("weighs a chart as a fixed block and a flow diagram by its depth", () => {
    expect(figureWordEquivalent(fence)).toBe(FIGURE_WORD_EQUIVALENT);
    const flow = (count: number) =>
      "```figure\n" +
      JSON.stringify({
        kind: "flow",
        title: "Steps",
        nodes: Array.from({ length: count }, (_, index) => ({ id: `n${index}`, label: `Step ${index}` })),
        edges: Array.from({ length: count - 1 }, (_, index) => ({ from: `n${index}`, to: `n${index + 1}` })),
        source: "The procedure"
      }) +
      "\n```";
    expect(figureWordEquivalent(flow(5))).toBe(105);
    expect(figureWordEquivalent(flow(12))).toBe(210);
    expect(figureWordEquivalent(flow(2))).toBe(100);
    expect(figureWordEquivalent("plain words here")).toBe(3);
  });
});

describe("mentionsFigure", () => {
  it("reads the words a reader uses for the figure in several languages", () => {
    expect(mentionsFigure("drop the chart")).toBe(true);
    expect(mentionsFigure("Make the diagram simpler")).toBe(true);
    expect(mentionsFigure("نمودار را حذف کن")).toBe(true);
    expect(mentionsFigure("make it more vivid")).toBe(false);
    expect(mentionsFigure("plot twist please")).toBe(true);
  });
});
