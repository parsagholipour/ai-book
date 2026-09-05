import { describe, expect, it } from "vitest";
import {
  FIGURE_WORD_EQUIVALENT,
  figureFreeProse,
  figureStandInMarkdown,
  figureWordEquivalent,
  findFigureFences,
  hasFigureFence,
  isFigureFenceBlock,
  proseWordCount,
  reinsertFigureFences,
  stripFigureFences,
  figureFreeDraft,
  validateFigureFences,
  figureAndStandInFreeProse
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
    expect(findFigureFences("```figures\n{\"kind\":\"bar\"}\n```")).toHaveLength(0);
    const unterminated = "```figure\n{\"kind\":\"bar\"}\n\nno closer";
    const openFence = findFigureFences(unterminated)[0]!;
    expect(findFigureFences(unterminated)).toHaveLength(1);
    expect(openFence.closed).toBe(false);
    expect(unterminated.slice(openFence.end)).toBe("\n\nno closer");
    expect(hasFigureFence(unterminated)).toBe(true);
    expect(figureFreeProse(unterminated)).toBe("no closer");
    expect(stripFigureFences(unterminated).fences).toHaveLength(1);
    const toEof = "```figure\n{\"kind\":\"bar\"}";
    expect(findFigureFences(toEof)[0]!.end).toBe(toEof.length);
    expect(figureFreeProse(toEof)).toBe("");
    expect(findFigureFences("```figure json\n{\"kind\":\"bar\"}\n```")).toHaveLength(1);
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

  it("drops a fence the pass invented beside the one it puts back", () => {
    // The prose handed to the pass held stand-ins only, so a block in what came
    // back is not ours; an unrelated rewrite used to store both.
    const { fences } = stripFigureFences(chapter);
    const invented = "```figure\n" + JSON.stringify({ ...spec, title: "An invented chart" }) + "\n```";
    const restored = reinsertFigureFences(`${before}\n\n[Figure: Share of the workforce in farming]\n\n${invented}\n\n${after}`, fences);
    expect(restored).toBe(`${before}\n\n${fence}\n\n${after}`);
    const inventedFirst = reinsertFigureFences(`${invented}\n\n${before}\n\n${after}`, fences);
    expect(inventedFirst.match(/```figure/g)).toHaveLength(1);
    expect(inventedFirst).toContain(fence);
    expect(inventedFirst).not.toContain("An invented chart");
  });

  it("returns prose byte for byte when there was nothing to put back and nothing model-facing in it", () => {
    const prose = `${before}\n\n\n\n${after}`;
    expect(reinsertFigureFences(prose, [])).toBe(prose);
    // With no figure of its own, a pass still has no business storing a fence or a stand-in.
    expect(reinsertFigureFences(`${before}\n\n${fence}\n\n[Figure: stray]\n\n${after}`, [])).toBe(`${before}\n\n${after}`);
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

  it("drops an unterminated opener and a valid bar when a line was planned", () => {
    const unterminated = `${before}\n\n\`\`\`figure\n{"kind":"bar"}\n\nno closer`;
    const droppedOpen = validateFigureFences(unterminated, { max: 1 });
    expect(droppedOpen.kept).toBe(0);
    expect(droppedOpen.dropped[0]!.reason).toBe("unterminated");
    expect(droppedOpen.markdown).toBe(`${before}\n\nno closer`);
    const mismatch = validateFigureFences(chapter, { max: 1, kind: "line" });
    expect(mismatch.kept).toBe(0);
    expect(mismatch.dropped).toEqual([{ reason: "planned line, got bar", excerpt: expect.stringContaining("Share of the workforce in farming") }]);
    expect(mismatch.markdown).toBe(`${before}\n\n${after}\n\nA closing paragraph about the harvest and the road out of town.`);
    const lineSpec = { ...spec, kind: "line" as const };
    const lineFence = "```figure\n" + JSON.stringify(lineSpec) + "\n```";
    const matching = validateFigureFences(`${before}\n\n${lineFence}\n\n${after}`, { max: 1, kind: "line" });
    expect(matching.kept).toBe(1);
    expect(matching.dropped).toEqual([]);
  });
});

describe("figureAndStandInFreeProse", () => {
  it("removes the block and any stand-in line a per-page writer echoed, and leaves other prose byte for byte", () => {
    expect(figureAndStandInFreeProse(`${before}\n\n${fence}\n\n[Figure: Share of the workforce in farming]\n\n${after}`)).toBe(`${before}\n\n${after}`);
    expect(figureAndStandInFreeProse(`${before}\n\n  [figure: anything]  \n\n${after}`)).toBe(`${before}\n\n${after}`);
    const plain = `${before}\n\n${after}\n\n\`\`\`python\nprint(1)\n\`\`\``;
    expect(figureAndStandInFreeProse(plain)).toBe(plain);
    expect(figureAndStandInFreeProse("A sentence that mentions [Figure: one] inline stays.")).toBe("A sentence that mentions [Figure: one] inline stays.");
  });
});

describe("figureFreeDraft", () => {
  it("returns the same draft object when there is nothing to remove, and a figure-free copy otherwise", () => {
    const clean = { title: "T", markdown: `${before}\n\n${after}`, summary: "s" };
    expect(figureFreeDraft(clean)).toBe(clean);
    const dirty = { ...clean, markdown: `${before}\n\n${fence}\n\n[Figure: x]\n\n${after}` };
    expect(figureFreeDraft(dirty)).toEqual(clean);
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
