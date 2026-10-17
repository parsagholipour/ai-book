import { describe, expect, it } from "vitest";
import { canonicalFigureFence, type FigureSpec } from "./figures/figureSpec.js";
import { checkQuickDraftFigurePatch, numbersIn, quickDraftRepairEchoPages, quickDraftRepairOutline, quickDraftRepairScope, quickDraftRepairView } from "./quickDraftRepairScope.js";

const flow: FigureSpec = { kind: "flow", title: "The legislative route", source: "Chamber records", nodes: [
  { id: "a", label: "Submitted", shape: "start" }, { id: "c", label: "Admissible?", shape: "decision" },
  { id: "j", label: "Senate approval", shape: "end" }], edges: [{ from: "a", to: "c" }, { from: "c", to: "j", label: "Yes" }, { from: "c", to: "j", label: "No" }] };
const bar: FigureSpec = { kind: "bar", title: "Project costs", source: "Illustrative inputs", categories: ["Overhead", "Direct", "Total"],
  series: [{ name: "Dollars", values: [300, 200, 500] }] };
const figurePage = (spec: FigureSpec, prose = "The proposal stops when it is inadmissible.") => `${prose}\n\n${canonicalFigureFence(spec)}\n\nThe vote follows.`;
const pages = Array.from({ length: 12 }, (_, i) => ({ index: i + 1, title: `Page ${i + 1}`, summary: `Summary ${i + 1}.`, markdown: `Prose of page ${i + 1}.` }));

describe("what a Quick Draft repair reads", () => {
  it("is the targets, both neighbours, the evidence pages and the pages the instruction names", () => {
    const scope = quickDraftRepairScope({ pages, targets: [5], instruction: "Page 5: it contradicts pages 9 and 11.",
      findings: [{ targets: [5], kind: "contradiction", problem: "p", fix: "f", evidence: [{ pageIndex: 5, quote: "Prose" }, { pageIndex: 2, quote: "Prose" }] },
        { targets: [8], kind: "duplicate", problem: "elsewhere", fix: "f", evidence: [{ pageIndex: 12, quote: "Prose" }] }] });
    expect(scope.context).toEqual([2, 4, 5, 6, 9, 11]);
    expect(quickDraftRepairOutline(pages, new Set(scope.context)).map((page) => page.index)).toEqual([1, 3, 7, 8, 10, 12]);
  });

  it("shows a figure's JSON only where a finding quotes it or names the figure", () => {
    const book = pages.map((page) => page.index === 3 || page.index === 4 ? { ...page, markdown: figurePage(flow) } : page);
    const quoted = quickDraftRepairScope({ pages: book, targets: [3], instruction: "",
      findings: [{ targets: [3], kind: "contradiction", problem: "Branches go to approval.", fix: "Route No elsewhere.", evidence: [{ pageIndex: 3, quote: '{"from":"c","to":"j","label":"No"}' }] }] });
    expect([...quoted.figurePages]).toEqual([3]);
    expect(quickDraftRepairView(book[3]!, quoted.figurePages)).toContain("[Figure: The legislative route]");
    expect(quickDraftRepairView(book[2]!, quoted.figurePages)).toContain('"label":"No"');
    const prose = quickDraftRepairScope({ pages: book, targets: [3], instruction: "",
      findings: [{ targets: [3], kind: "contradiction", problem: "The vote is dated twice.", fix: "Keep one date.", evidence: [{ pageIndex: 3, quote: "The vote follows." }] }] });
    expect(prose.figurePages.size).toBe(0);
    const named = quickDraftRepairScope({ pages: book, targets: [3], instruction: "",
      findings: [{ targets: [3], kind: "contradiction", problem: "The flowchart approves a failed proposal.", fix: "Fix the diagram.", evidence: [{ pageIndex: 3, quote: "The vote follows." }] }] });
    expect([...named.figurePages]).toEqual([3]);
  });
});

describe("a patched figure", () => {
  it("must stay byte for byte when the finding is not about it", () => {
    const before = figurePage(flow);
    expect(checkQuickDraftFigurePatch(before, before.replace("The vote follows.", "The vote came later."), false).failures).toEqual([]);
    const moved = before.replace('"to":"j","label":"No"', '"to":"a","label":"No"');
    expect(checkQuickDraftFigurePatch(before, moved, false).failures.map((failure) => failure.reason)).toEqual(["figure_changed"]);
  });

  it("is kept canonical when it still parses, keeps its kind and invents no number", () => {
    const before = figurePage({ ...flow, nodes: [...flow.nodes, { id: "k", label: "Does not advance", shape: "end" }] });
    const rerouted = before.replace('"to":"j","label":"No"', '"to":"k","label":"No"');
    const accepted = checkQuickDraftFigurePatch(before, rerouted, true);
    expect(accepted.failures).toEqual([]);
    // Stored in the validator's canonical one-line form, key order included.
    expect(accepted.markdown).toContain('"edges":[{"from":"a","to":"c"},{"from":"c","to":"j","label":"Yes"},{"from":"c","to":"k","label":"No"}],"source":"Chamber records"');
    expect(checkQuickDraftFigurePatch(before, before.replace('"to":"j","label":"No"}', '"to":"j","label":"No"'), true).failures[0]!.reason).toBe("figure_invalid");
    expect(checkQuickDraftFigurePatch(before, before.replace('"to":"j","label":"No"', '"to":"zz","label":"No"'), true).failures[0]!.reason).toBe("figure_invalid");
    expect(checkQuickDraftFigurePatch(before, before.replace('"kind":"flow"', '"kind":"bar"'), true).failures.length).toBeGreaterThan(0);
    const chart = figurePage(bar, "Overhead is $300 and direct costs $200, so the project needs $500.");
    expect(checkQuickDraftFigurePatch(chart, chart.replace("[300,200,500]", "[300,200,550]"), true).failures.map((failure) => failure.reason))
      .toEqual(["figure_invented_value"]);
    expect(checkQuickDraftFigurePatch(chart, chart.replace('"kind":"bar"', '"kind":"pie"'), true).failures.map((failure) => failure.reason))
      .toEqual(["figure_kind_changed"]);
    const corrected = figurePage({ ...bar, series: [{ name: "Dollars", values: [411, 200, 500] }] }, "Overhead is $300 and direct costs $200, so the project needs $500.");
    expect(checkQuickDraftFigurePatch(corrected, corrected.replace("[411,200,500]", "[300,200,500]"), true).failures).toEqual([]);
  });

  it("may be removed whole, never added", () => {
    const before = figurePage(bar);
    const removed = before.replace(canonicalFigureFence(bar), "");
    expect(checkQuickDraftFigurePatch(before, removed, true).failures).toEqual([]);
    expect(checkQuickDraftFigurePatch(before, `${before}\n\n${canonicalFigureFence(flow)}`, true).failures[0]!.reason).toBe("figure_invalid");
  });

  it("reads numbers as values, and a JSON array as separate ones", () => {
    expect(numbersIn("123,682,372 ballots; 2.50 and 1 200")).toEqual(["123682372", "2.5", "1200"]);
    expect(numbersIn("[411,200,500,1200]")).toEqual(["411200500", "1200"]);
  });
});

describe("pages the verifier follows a changed name into", () => {
  it("are unchanged pages carrying a rare removed or added name, at most four", () => {
    const book = pages.map((page) => ({ ...page, markdown: page.index === 9 ? "The Ledger of Ashfall burns in 1188." : page.index === 2 ? "Mara signs." : page.markdown }));
    const echoes = quickDraftRepairEchoPages({ pages: book, exclude: new Set([4, 5, 6]),
      changed: [{ index: 5, before: "The Ledger of Ashfall, 1187.", after: "The Book of Ashfall, 1188." }] });
    expect(echoes).toEqual([9]);
  });
});
