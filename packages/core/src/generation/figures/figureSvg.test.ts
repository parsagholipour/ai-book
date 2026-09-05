import { describe, expect, it } from "vitest";
import { scriptProfileForLanguage } from "../../prompting/script.js";
import { figureRenderContext } from "./figureHtml.js";
import type { ChartFigureSpec, FlowFigureSpec } from "./figureSpec.js";
import { renderChartSvg } from "./figureSvgCharts.js";
import { layoutFlow, renderFlowSvg } from "./figureSvgFlow.js";
import { FIGURE_WIDTH, formatFigureNumber, niceTicks, wrapLabel } from "./figureSvgShared.js";

const bar: ChartFigureSpec = {
  kind: "bar",
  title: "Share of the workforce in farming",
  categories: ["1900", "1950", "Q&A <2000>"],
  series: [{ name: "United States", values: [41, 12, 2] }],
  unit: "%",
  source: "US Census Bureau"
};

const flow: FlowFigureSpec = {
  kind: "flow",
  title: "How a claim moves through review",
  nodes: [
    { id: "a", label: "Claim filed", shape: "start" },
    { id: "b", label: "Triage within 48 hours of the first call" },
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

const en = figureRenderContext("en");
const fa = figureRenderContext("Farsi");
const UNCLOSED_EMPTY_ELEMENT = /<(rect|line|path|circle|polygon|polyline)\b[^>]*[^/]>/;

function count(svg: string, pattern: RegExp): number {
  return (svg.match(pattern) ?? []).length;
}

describe("renderChartSvg", () => {
  it("draws one bar per value, escapes labels, and carries no id", () => {
    const svg = renderChartSvg(bar, en);
    expect(svg.startsWith('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 640 360"')).toBe(true);
    expect(count(svg, /<path /g)).toBe(3);
    expect(svg).toContain("Q&amp;A &lt;2000&gt;");
    expect(svg).toContain('aria-label="Figure: Share of the workforce in farming"');
    expect(svg).not.toMatch(/\bid=/);
    expect(svg).not.toMatch(UNCLOSED_EMPTY_ELEMENT);
    expect(svg).not.toContain("\n\n");
    // One series: no legend swatch, and the unit rides on the ticks.
    expect(count(svg, /<rect /g)).toBe(0);
    expect(svg).toContain(">0%<");
  });

  it("adds a legend swatch per series once there are two, and lays bars sideways on request", () => {
    const two: ChartFigureSpec = { ...bar, series: [...bar.series, { name: "France", values: [43, 27, 4] }] };
    const svg = renderChartSvg(two, en);
    expect(count(svg, /<rect /g)).toBe(2);
    expect(count(svg, /<path /g)).toBe(6);
    const sideways = renderChartSvg({ ...two, orientation: "horizontal" }, en);
    expect(count(sideways, /<path /g)).toBe(6);
    expect(sideways).toMatch(/viewBox="0 0 640 \d+/);
    expect(sideways).not.toMatch(UNCLOSED_EMPTY_ELEMENT);
  });

  it("draws a line per series with a dash pattern as the second channel and ringed markers", () => {
    const line: ChartFigureSpec = { ...bar, kind: "line", series: [...bar.series, { name: "France", values: [43, 27, 4] }] };
    const svg = renderChartSvg(line, en);
    expect(count(svg, /<path /g)).toBe(2);
    expect(count(svg, /stroke-dasharray="7 4"/g)).toBe(2);
    expect(count(svg, /<circle /g)).toBe(6);
    expect(svg).toContain('stroke="#ffffff" stroke-width="2"');
    expect(svg).not.toMatch(UNCLOSED_EMPTY_ELEMENT);
  });

  it("draws a pie as wedges with a legend naming each share, and a full circle for one slice", () => {
    const pie: ChartFigureSpec = { ...bar, kind: "pie", unit: undefined as never, series: [{ name: "Share", values: [50, 25, 25] }] };
    const svg = renderChartSvg({ ...pie, unit: "" }, en);
    expect(count(svg, /<path /g)).toBe(3);
    expect(svg).toContain("1900 · 50%");
    expect(svg).toContain("Q&amp;A &lt;2000&gt; · 25%");
    const single = renderChartSvg({ ...pie, unit: "", categories: ["All"], series: [{ name: "Share", values: [7] }] }, en);
    expect(count(single, /<circle /g)).toBe(1);
    expect(single).toContain("All · 100%");
  });

  it("draws a log scale with a tick per decade, bars growing from the lowest one", () => {
    const counts: ChartFigureSpec = {
      ...bar,
      scale: "log",
      unit: "",
      categories: ["10,000 records", "100,000 records", "1,000,000 records"],
      series: [
        { name: "Linear scan", values: [10000, 100000, 1000000] },
        { name: "Hash lookup", values: [1, 1, 1] }
      ]
    };
    const svg = renderChartSvg(counts, en);
    for (const tick of ["0.1", "1", "10", "100", "1,000", "10K", "100K", "1M"]) expect(svg).toContain(`>${tick}<`);
    // Six bars: the value on the lowest decade still has a height, because the axis starts a decade below it.
    expect(count(svg, /<path /g)).toBe(6);
    const heights = [...svg.matchAll(/<path d="M[\d.]+ ([\d.]+)V([\d.]+)/g)].map((match) => Number(match[1]) - Number(match[2]));
    expect(heights[0]).toBeLessThan(heights[2]!);
    expect(heights[2]).toBeLessThan(heights[4]!);
    expect(heights[1]).toBeGreaterThan(5);
    expect(heights[1]).toBeCloseTo(heights[3]!, 5);
  });

  it("takes a log axis on its own over values spanning three decades, and widens the margin to the widest tick", () => {
    const wide: ChartFigureSpec = {
      ...bar,
      unit: "estimated comparisons or operations",
      categories: ["1,000 records", "10,000 records", "100,000 records"],
      series: [
        { name: "Linear scan", values: [1000, 10000, 100000] },
        { name: "Repeated scan", values: [10000000, 100000000, 1000000000] }
      ]
    };
    const svg = renderChartSvg(wide, en);
    expect(svg).toContain(">1B<");
    expect(svg).toContain(">1,000<");
    expect(svg).toContain(">estimated comparisons or operations<");
    expect(count(svg, /<path /g)).toBe(6);
    // A modest range stays linear even though the unit still gets its row.
    const modest = renderChartSvg({ ...bar, unit: "operations" }, en);
    expect(modest).toContain(">operations<");
    expect(modest).not.toContain(">0.1<");
    // The margin follows the widest tick label: "50%" fits the minimum, "-1,000" does not.
    const tickX = (spec: ChartFigureSpec) => Number(renderChartSvg(spec, en).match(/<text x="([\d.]+)" y="[\d.]+" font-size="11" fill="#898781" text-anchor="end">/)![1]);
    expect(tickX(bar)).toBe(40);
    expect(tickX({ ...bar, unit: "", series: [{ name: "S", values: [-1000, 800, 2] }] })).toBeGreaterThan(40);
  });

  it("marks right-to-left text and writes ticks in the script's digits", () => {
    const svg = renderChartSvg(bar, fa);
    expect(svg).toContain('direction="rtl" unicode-bidi="embed"');
    expect(svg).toContain(">۰%<");
    expect(svg).not.toContain(">0%<");
  });
});

describe("number and text helpers", () => {
  it("formats numbers for the book's locale and maps the digits", () => {
    expect(formatFigureNumber(1950, scriptProfileForLanguage("en"))).toBe("1,950");
    const persian = formatFigureNumber(1950, scriptProfileForLanguage("Farsi"));
    expect(persian).toContain("۱");
    expect(persian).toContain("۹۵۰");
    expect(formatFigureNumber(0.125, scriptProfileForLanguage("en"))).toBe("0.13");
  });

  it("picks round ticks and widens a flat domain", () => {
    expect(niceTicks(0, 41)).toEqual([0, 10, 20, 30, 40, 50]);
    expect(niceTicks(-3, 3)).toEqual([-4, -2, 0, 2, 4]);
    expect(niceTicks(5, 5).length).toBeGreaterThan(1);
  });

  it("never hangs or returns a non-finite tick, whatever the domain", () => {
    // The end used to round up past Number.MAX_VALUE to Infinity, and the loop never ended.
    for (const [low, high] of [
      [0, Number.MAX_VALUE],
      [-Number.MAX_VALUE, Number.MAX_VALUE],
      [Number.MAX_VALUE / 3, Number.MAX_VALUE],
      [Number.MAX_VALUE, Number.MAX_VALUE],
      [-Number.MAX_VALUE, -Number.MAX_VALUE],
      [0, Number.MIN_VALUE],
      [Number.MIN_VALUE, Number.MIN_VALUE],
      [0, 3e-12],
      [Number.NaN, 4],
      [1, Number.POSITIVE_INFINITY]
    ] as const) {
      const ticks = niceTicks(low, high);
      expect(ticks.length).toBeGreaterThanOrEqual(2);
      expect(ticks.length).toBeLessThanOrEqual(64);
      expect(ticks.every((tick) => Number.isFinite(tick))).toBe(true);
      expect(ticks[0]).not.toBe(ticks.at(-1));
    }
    // A domain below the old ten-decimal rounding keeps distinct ticks instead of collapsing to zero.
    expect(niceTicks(0, 3e-12)).toEqual([0, 1e-12, 2e-12, 3e-12]);
    // At FIGURE_LIMITS.value the nice step is smaller than the ULP, so += never advances.
    const nearLimit = niceTicks(999999999999999.9, 1e15);
    expect(nearLimit.length).toBeGreaterThanOrEqual(2);
    expect(nearLimit.length).toBeLessThanOrEqual(64);
    expect(nearLimit.every((tick) => Number.isFinite(tick))).toBe(true);
    expect(new Set(nearLimit).size).toBeGreaterThanOrEqual(2);
  });

  it("draws a chart built directly with values the schema would refuse, rather than hanging or emitting non-finite geometry", () => {
    const max = Number.MAX_VALUE;
    const domains: number[][] = [
      [1, max, 3],
      [max, max, max],
      [-max, -max, -max],
      [-max, 0, max],
      [Number.MIN_VALUE, 1, max],
      [Number.MIN_VALUE, 1, 2],
      [0, Number.MIN_VALUE, 0],
      [-max, 1, 1]
    ];
    for (const values of domains) {
      const base: ChartFigureSpec = { ...bar, unit: "", series: [{ name: "S", values }] };
      const variants: ChartFigureSpec[] = [
        base,
        { ...base, kind: "line" },
        { ...base, orientation: "horizontal" },
        { ...base, scale: "linear" },
        { ...base, scale: "log" },
        { ...base, kind: "pie", series: [{ name: "S", values: values.map(Math.abs) }] }
      ];
      for (const spec of variants) {
        const svg = renderChartSvg(spec, en);
        expect(svg.startsWith("<svg "), JSON.stringify(spec)).toBe(true);
        expect(svg, JSON.stringify(spec)).not.toMatch(/NaN|Infinity|∞/);
      }
    }
  });

  it("wraps a label into lines and folds the overflow into an ellipsis", () => {
    expect(wrapLabel("Triage within 48 hours", 10, 3)).toEqual(["Triage", "within 48", "hours"]);
    expect(wrapLabel("one two three four five six", 9, 2)).toEqual(["one two", "three fo…"]);
    // A word far past the line is broken; the remainder, within reach of it, overflows whole rather than losing its shape.
    expect(wrapLabel("abcdefghijklmnop", 6, 3)).toEqual(["abcdef", "ghijklmnop"]);
    expect(wrapLabel("Reachability or hops?", 11, 3)).toEqual(["Reachability", "or hops?"]);
  });
});

describe("layoutFlow and renderFlowSvg", () => {
  it("layers by longest path, finds the loop, and routes it down a channel on the right", () => {
    const layout = layoutFlow(flow);
    const byId = new Map(layout.nodes.map((node) => [node.id, node]));
    expect([byId.get("a")!.layer, byId.get("b")!.layer, byId.get("c")!.layer, byId.get("d")!.layer, byId.get("e")!.layer]).toEqual([0, 1, 2, 3, 3]);
    expect(layout.layers).toBe(4);
    const loop = layout.edges.find((edge) => edge.from === "d" && edge.to === "b")!;
    expect(loop.back).toBe(true);
    expect(loop.path).toMatch(/^M[\d.]+ [\d.]+V[\d.]+H[\d.]+V[\d.]+H[\d.]+$/);
    expect(layout.edges.filter((edge) => !edge.back).every((edge) => byId.get(edge.to)!.layer > byId.get(edge.from)!.layer)).toBe(true);
    expect(byId.get("b")!.lines.length).toBeGreaterThan(1);
    expect(layout.height).toBeGreaterThan(300);
  });

  it("renders every node, edge, arrowhead and edge label without ids or unclosed elements", () => {
    const svg = renderFlowSvg(flow, en);
    expect(count(svg, /class="figure-node"/g)).toBe(5);
    expect(count(svg, /class="figure-edge"/g)).toBe(5);
    expect(count(svg, /class="figure-arrow"/g)).toBe(5);
    expect(count(svg, /<polygon /g)).toBe(6);
    expect(svg).toContain(">Yes<");
    expect(svg).toContain(">No<");
    expect(svg).toContain("<tspan ");
    expect(svg).not.toMatch(/\bid=/);
    expect(svg).not.toMatch(UNCLOSED_EMPTY_ELEMENT);
    expect(renderFlowSvg(flow, fa)).toContain('direction="rtl"');
  });

  it("copes with a graph whose only root is inside a cycle", () => {
    const ring: FlowFigureSpec = {
      kind: "flow",
      title: "Round and round",
      nodes: [
        { id: "x", label: "Plan" },
        { id: "y", label: "Do" },
        { id: "z", label: "Check" }
      ],
      edges: [
        { from: "x", to: "y" },
        { from: "y", to: "z" },
        { from: "z", to: "x" }
      ],
      source: "The cycle"
    };
    const layout = layoutFlow(ring);
    expect(layout.layers).toBe(3);
    expect(layout.edges.filter((edge) => edge.back)).toHaveLength(1);
    expect(renderFlowSvg(ring, en)).not.toMatch(UNCLOSED_EMPTY_ELEMENT);
  });

  it("keeps a 14-node fan-out inside the 640-wide viewBox", () => {
    const fanOut: FlowFigureSpec = {
      kind: "flow",
      title: "One source, thirteen next steps",
      nodes: [
        { id: "n0", label: "Decide the next hop", shape: "start" },
        ...Array.from({ length: 13 }, (_, index) => ({ id: `n${index + 1}`, label: `Target ${index + 1}` }))
      ],
      edges: Array.from({ length: 13 }, (_, index) => ({ from: "n0", to: `n${index + 1}` })),
      source: "A procedure"
    };
    const layout = layoutFlow(fanOut);
    expect(layout.nodes).toHaveLength(14);
    for (const node of layout.nodes) {
      expect(node.x - node.w / 2).toBeGreaterThanOrEqual(-1e-6);
      expect(node.x + node.w / 2).toBeLessThanOrEqual(FIGURE_WIDTH + 1e-6);
      expect(node.x).toBeGreaterThanOrEqual(0);
      expect(node.x).toBeLessThanOrEqual(FIGURE_WIDTH);
    }
    const svg = renderFlowSvg(fanOut, en);
    expect(svg).toMatch(/viewBox="0 0 640 /);
    const viewBox = svg.match(/viewBox="0 0 640 ([\d.]+)"/)!;
    expect(Number(viewBox[1])).toBeGreaterThan(0);
    expect(svg).toContain('style="display:block;width:100%;height:auto"');
    expect(svg).not.toMatch(UNCLOSED_EMPTY_ELEMENT);
  });

  it("caps a 14-node chain at a page-sensible height", () => {
    const chain: FlowFigureSpec = {
      kind: "flow",
      title: "Fourteen steps in a line",
      nodes: Array.from({ length: 14 }, (_, index) => ({
        id: `n${index}`,
        label: `Step ${index + 1}`,
        ...(index === 0 ? { shape: "start" as const } : index === 13 ? { shape: "end" as const } : {})
      })),
      edges: Array.from({ length: 13 }, (_, index) => ({ from: `n${index}`, to: `n${index + 1}` })),
      source: "A procedure"
    };
    const layout = layoutFlow(chain);
    expect(layout.layers).toBe(14);
    // 720px at full column width is ~196mm on A4, under the 255mm content block; the old pitch ran to ~1398.
    expect(layout.height).toBeLessThanOrEqual(720);
    expect(layout.height).toBeLessThan(800);
    const svg = renderFlowSvg(chain, en);
    const viewBox = svg.match(/viewBox="0 0 640 ([\d.]+)"/)!;
    expect(Number(viewBox[1])).toBeLessThanOrEqual(720);
    expect(Number(viewBox[1])).toBe(Math.round(layout.height * 100) / 100);
    expect(svg).not.toMatch(UNCLOSED_EMPTY_ELEMENT);
  });

  it("shrinks nodes rather than overlapping them in a 14-decision chain", () => {
    const chain: FlowFigureSpec = {
      kind: "flow",
      title: "Fourteen decisions",
      nodes: Array.from({ length: 14 }, (_, index) => ({
        id: `n${index}`,
        label: `Ask ${index + 1}`,
        shape: "decision" as const
      })),
      edges: Array.from({ length: 13 }, (_, index) => ({ from: `n${index}`, to: `n${index + 1}` })),
      source: "A procedure"
    };
    const layout = layoutFlow(chain);
    expect(layout.height).toBeLessThanOrEqual(720);
    const ordered = [...layout.nodes].sort((left, right) => left.y - right.y || left.x - right.x);
    for (let index = 0; index < ordered.length - 1; index += 1) {
      const upper = ordered[index]!;
      const lower = ordered[index + 1]!;
      expect(upper.y + upper.h / 2).toBeLessThanOrEqual(lower.y - lower.h / 2 + 1e-6);
    }
  });
});

describe("flow edges that share a node or skip a layer", () => {
  it("spreads a node's edges along its side and bows a layer-skipping edge out of the column", () => {
    const fan: FlowFigureSpec = {
      kind: "flow",
      title: "Fan",
      nodes: [
        { id: "q", label: "Question", shape: "start" },
        { id: "a", label: "Use BFS" },
        { id: "b", label: "Use DFS" },
        { id: "c", label: "Use shortest path" },
        { id: "v", label: "Validate", shape: "end" }
      ],
      edges: [
        { from: "q", to: "a" },
        { from: "a", to: "b" },
        { from: "b", to: "c" },
        { from: "a", to: "v" },
        { from: "b", to: "v" },
        { from: "c", to: "v" }
      ],
      source: "A procedure"
    };
    const layout = layoutFlow(fan);
    const into = layout.edges.filter((edge) => edge.to === "v");
    const startX = (edge: (typeof into)[number]) => Number(edge.path.match(/^M([\d.]+) /)![1]);
    const endX = (edge: (typeof into)[number]) => Number(edge.arrow.split(" ")[0]!.split(",")[0]);
    expect(new Set(into.map(endX)).size).toBe(3);
    const fromA = layout.edges.filter((edge) => edge.from === "a");
    expect(new Set(fromA.map(startX)).size).toBe(2);
    const skipping = layout.edges.find((edge) => edge.from === "a" && edge.to === "v")!;
    const controlX = Number(skipping.path.match(/C([\d.-]+) /)![1]);
    expect(Math.abs(controlX - startX(skipping))).toBeGreaterThan(100);
    expect(renderFlowSvg(fan, en)).not.toMatch(UNCLOSED_EMPTY_ELEMENT);
  });

  it("bows a sheet-edge skip out of the column instead of flattening it to the margin", () => {
    // Four-wide layers fill the usable column, so the leftmost and rightmost
    // nodes sit on the margin clampNodeToViewBox would pin an overflow to.
    // Decision endpoints keep attach points on the column (no side spread).
    const edgeSkip: FlowFigureSpec = {
      kind: "flow",
      title: "Edge skips",
      nodes: [
        { id: "left", label: "Left start", shape: "decision" },
        { id: "a2", label: "A2" },
        { id: "a3", label: "A3" },
        { id: "right", label: "Right start", shape: "decision" },
        { id: "leftMid", label: "Left mid" },
        { id: "b2", label: "B2" },
        { id: "b3", label: "B3" },
        { id: "rightMid", label: "Right mid" },
        { id: "leftEnd", label: "Left end", shape: "decision" },
        { id: "c2", label: "C2" },
        { id: "c3", label: "C3" },
        { id: "rightEnd", label: "Right end", shape: "decision" }
      ],
      edges: [
        { from: "left", to: "leftMid" },
        { from: "leftMid", to: "leftEnd" },
        { from: "left", to: "leftEnd" },
        { from: "a2", to: "b2" },
        { from: "b2", to: "c2" },
        { from: "a3", to: "b3" },
        { from: "b3", to: "c3" },
        { from: "right", to: "rightMid" },
        { from: "rightMid", to: "rightEnd" },
        { from: "right", to: "rightEnd" }
      ],
      source: "A procedure"
    };
    const layout = layoutFlow(edgeSkip);
    const byId = new Map(layout.nodes.map((node) => [node.id, node]));
    const startX = (edge: (typeof layout.edges)[number]) => Number(edge.path.match(/^M([\d.-]+) /)![1]);
    const cubic = (p0: number, p1: number, p2: number, p3: number, t: number) => {
      const u = 1 - t;
      return u * u * u * p0 + 3 * u * u * t * p1 + 3 * u * t * t * p2 + t * t * t * p3;
    };
    const skipPath = (path: string) => {
      const match = path.match(/^M([\d.-]+) ([\d.-]+)C([\d.-]+) ([\d.-]+) ([\d.-]+) ([\d.-]+) ([\d.-]+) ([\d.-]+)$/)!;
      return {
        x1: Number(match[1]),
        y1: Number(match[2]),
        c1x: Number(match[3]),
        c1y: Number(match[4]),
        c2x: Number(match[5]),
        c2y: Number(match[6]),
        x2: Number(match[7]),
        y2: Number(match[8])
      };
    };
    const missesBox = (path: string, node: (typeof layout.nodes)[number]) => {
      const curve = skipPath(path);
      for (let step = 1; step < 20; step += 1) {
        const t = step / 20;
        const x = cubic(curve.x1, curve.c1x, curve.c2x, curve.x2, t);
        const y = cubic(curve.y1, curve.c1y, curve.c2y, curve.y2, t);
        expect(Math.abs(x - node.x) < node.w / 2 && Math.abs(y - node.y) < node.h / 2).toBe(false);
      }
    };
    const pathCoords = (path: string) => {
      const out: { x: number; y: number }[] = [];
      let x = 0;
      let y = 0;
      for (const match of path.matchAll(/([MLHVCS])([^MLHVCS]*)/g)) {
        const nums = (match[2]!.match(/-?\d+(?:\.\d+)?/g) ?? []).map(Number);
        if (match[1] === "M" || match[1] === "L") {
          x = nums[0]!;
          y = nums[1]!;
          out.push({ x, y });
        } else if (match[1] === "C") {
          for (let index = 0; index < nums.length; index += 2) out.push({ x: (x = nums[index]!), y: (y = nums[index + 1]!) });
        } else if (match[1] === "H") out.push({ x: (x = nums[0]!), y });
        else if (match[1] === "V") out.push({ x, y: (y = nums[0]!) });
      }
      return out;
    };

    expect(layout.width).toBeGreaterThan(FIGURE_WIDTH);
    const leftSkip = layout.edges.find((edge) => edge.from === "left" && edge.to === "leftEnd")!;
    const rightSkip = layout.edges.find((edge) => edge.from === "right" && edge.to === "rightEnd")!;
    const leftBow = Math.abs(Number(leftSkip.path.match(/C([\d.-]+) /)![1]) - startX(leftSkip));
    const rightBow = Math.abs(Number(rightSkip.path.match(/C([\d.-]+) /)![1]) - startX(rightSkip));
    const expectedLeft = Math.max(byId.get("left")!.w, byId.get("leftEnd")!.w) / 2 + 40;
    const expectedRight = Math.max(byId.get("right")!.w, byId.get("rightEnd")!.w) / 2 + 40;
    expect(leftBow).toBeGreaterThan(100);
    expect(rightBow).toBeGreaterThan(100);
    expect(leftBow).toBeCloseTo(expectedLeft, 1);
    expect(rightBow).toBeCloseTo(expectedRight, 1);
    missesBox(leftSkip.path, byId.get("leftMid")!);
    missesBox(rightSkip.path, byId.get("rightMid")!);

    const inside = (x: number, y: number) => {
      expect(x).toBeGreaterThanOrEqual(-1e-6);
      expect(x).toBeLessThanOrEqual(layout.width + 1e-6);
      expect(y).toBeGreaterThanOrEqual(-1e-6);
      expect(y).toBeLessThanOrEqual(layout.height + 1e-6);
    };
    for (const node of layout.nodes) {
      inside(node.x - node.w / 2, node.y - node.h / 2);
      inside(node.x + node.w / 2, node.y + node.h / 2);
    }
    for (const edge of layout.edges) {
      for (const point of pathCoords(edge.path)) inside(point.x, point.y);
      for (const vertex of edge.arrow.split(" ")) {
        const [x, y] = vertex.split(",");
        inside(Number(x), Number(y));
      }
      inside(edge.labelAt.x, edge.labelAt.y);
    }

    const svg = renderFlowSvg(edgeSkip, en);
    const viewBox = svg.match(/viewBox="0 0 ([\d.]+) ([\d.]+)"/)!;
    expect(Number(viewBox[1])).toBeCloseTo(layout.width, 2);
    expect(Number(viewBox[2])).toBeCloseTo(layout.height, 2);
    expect(svg).not.toMatch(UNCLOSED_EMPTY_ELEMENT);
  });
});
