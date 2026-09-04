import { describe, expect, it } from "vitest";
import { canonicalFigureFence, figureSpecSchema, parseFigureSpec, type FigureSpec } from "./figureSpec.js";

const bar = {
  kind: "bar",
  title: "Share of the workforce in farming",
  categories: ["1900", "1950", "2000"],
  series: [{ name: "United States", values: [41, 12, 2] }],
  unit: "%",
  source: "US Census Bureau, decennial censuses",
  caption: "Farm work as a share of all employment."
};

const flow = {
  kind: "flow",
  title: "How a claim moves through review",
  nodes: [
    { id: "a", label: "Claim filed", shape: "start" },
    { id: "b", label: "Triage within 48 hours" },
    { id: "c", label: "File complete?", shape: "decision" },
    { id: "d", label: "Request documents" },
    { id: "e", label: "Assess and decide", shape: "end" }
  ],
  edges: [
    { from: "a", to: "b" },
    { from: "b", to: "c" },
    { from: "c", to: "d", label: "No" },
    { from: "d", to: "b" },
    { from: "c", to: "e", label: "Yes" }
  ],
  source: "The procedure this chapter describes"
};

function errorOf(value: unknown): string {
  const parsed = parseFigureSpec(JSON.stringify(value));
  expect(parsed.spec).toBeUndefined();
  return parsed.error ?? "";
}

describe("parseFigureSpec", () => {
  it("reads a chart and a flow diagram", () => {
    expect(parseFigureSpec(JSON.stringify(bar)).spec?.kind).toBe("bar");
    expect(parseFigureSpec(JSON.stringify(flow)).spec?.kind).toBe("flow");
  });

  it("repairs a trailing comma and refuses anything else that is not JSON", () => {
    expect(parseFigureSpec(JSON.stringify(bar).replace(/}$/, ",}")).spec?.kind).toBe("bar");
    expect(parseFigureSpec("not json at all").error).toMatch(/not JSON/);
    expect(parseFigureSpec("[1,2]").error).toBe("not a JSON object");
    expect(parseFigureSpec(JSON.stringify({ ...bar, kind: "scatter" })).error).toMatch(/unknown kind "scatter"/);
  });

  it("clips a long string instead of losing the figure over it", () => {
    const spec = parseFigureSpec(JSON.stringify({ ...bar, unit: "relative operation counts per lookup, indexed to a linear scan", title: "t".repeat(200) })).spec;
    expect(spec?.kind).toBe("bar");
    expect((spec as { unit?: string }).unit).toHaveLength(60);
    expect(spec?.title).toHaveLength(160);
    expect(spec?.title.endsWith("…")).toBe(true);
  });

  it("keeps a log scale only over values it can draw", () => {
    expect((parseFigureSpec(JSON.stringify({ ...bar, scale: "log" })).spec as { scale?: string }).scale).toBe("log");
    expect((parseFigureSpec(JSON.stringify({ ...bar, scale: "log", series: [{ name: "S", values: [0, 12, 2] }] })).spec as { scale?: string }).scale).toBeUndefined();
  });

  it("holds a chart to its limits", () => {
    expect(errorOf({ ...bar, series: Array.from({ length: 5 }, (_, index) => ({ name: `S${index}`, values: [1, 2, 3] })) })).toMatch(/series/);
    const many = Array.from({ length: 17 }, (_, index) => `c${index}`);
    expect(errorOf({ ...bar, categories: many, series: [{ name: "S", values: many.map(() => 1) }] })).toMatch(/at most 16 categories/);
    expect(errorOf({ ...bar, kind: "line", categories: ["only"], series: [{ name: "S", values: [1] }] })).toMatch(/at least two points/);
    expect(errorOf({ ...bar, kind: "pie", series: [{ name: "A", values: [1, 2, 3] }, { name: "B", values: [1, 2, 3] }] })).toMatch(/exactly one series/);
    const slices = Array.from({ length: 9 }, (_, index) => `s${index}`);
    expect(errorOf({ ...bar, kind: "pie", categories: slices, series: [{ name: "S", values: slices.map(() => 1) }] })).toMatch(/at most 8 slices/);
    expect(errorOf({ ...bar, kind: "pie", series: [{ name: "S", values: [1, -2, 3] }] })).toMatch(/negative/);
    expect(errorOf({ ...bar, series: [{ name: "S", values: [1, 2] }] })).toMatch(/2 values for 3 categories/);
    expect(errorOf({ ...bar, source: "" })).toMatch(/source/);
  });

  it("refuses a value that is not a finite number even when handed the object directly", () => {
    const direct = figureSpecSchema.safeParse({ ...bar, series: [{ name: "S", values: [1, Number.POSITIVE_INFINITY, 3] }] });
    expect(direct.success).toBe(false);
  });

  it("holds a flow diagram to consistent ids", () => {
    expect(errorOf({ ...flow, nodes: [...flow.nodes, { id: "a", label: "Again" }] })).toMatch(/used twice/);
    expect(errorOf({ ...flow, edges: [...flow.edges, { from: "a", to: "zz" }] })).toMatch(/does not exist/);
    expect(errorOf({ ...flow, edges: [...flow.edges, { from: "a", to: "a" }] })).toMatch(/onto itself/);
    const nodes = Array.from({ length: 15 }, (_, index) => ({ id: `n${index}`, label: `Step ${index}` }));
    expect(errorOf({ ...flow, nodes, edges: [{ from: "n0", to: "n1" }] })).toMatch(/nodes/);
  });
});

describe("canonicalFigureFence", () => {
  it("is one line of JSON and a fixed point of parsing", () => {
    const spec = parseFigureSpec(JSON.stringify(bar, null, 2)).spec as FigureSpec;
    const fence = canonicalFigureFence(spec);
    expect(fence.split("\n")).toHaveLength(3);
    expect(fence.startsWith("```figure\n{")).toBe(true);
    const again = parseFigureSpec(fence.split("\n")[1]!).spec as FigureSpec;
    expect(canonicalFigureFence(again)).toBe(fence);
  });
});
