import { z } from "zod";
import { isRecord } from "../../schemas/jsonCoercion.js";

/**
 * The figure block: the one non-prose element a composed chapter may carry.
 *
 * A figure travels through the manuscript as a fenced block tagged `figure`
 * whose body is one JSON object — a bar, line or pie chart of numbers the
 * chapter discusses, or a flow diagram of a procedure's steps. The exporters
 * draw it deterministically at compile time (`figureHtml.ts`); nothing here
 * is an image asset, an image prompt or an illustration slot, which is what
 * keeps a figure free of the per-image credit charge and the free-tier
 * illustrated-book quota.
 *
 * The validator re-serialises every valid block to one canonical line of
 * JSON, so downstream regexes (a `pages:` line, a labelled list, a footnote
 * marker) never meet a pretty-printed key at the start of a line.
 */

export const FIGURE_FENCE_TAG = "figure";

export const CHART_KINDS = ["bar", "line", "pie"] as const;
export const FIGURE_KINDS = [...CHART_KINDS, "flow"] as const;
export type FigureKind = (typeof FIGURE_KINDS)[number];

export const FIGURE_LIMITS = {
  series: 4,
  barCategories: 16,
  linePoints: 30,
  pieSlices: 8,
  flowNodes: 14,
  flowEdges: 20,
  title: 160,
  caption: 300,
  source: 240,
  label: 80,
  nodeLabel: 60,
  edgeLabel: 24,
  unit: 60
} as const;

/**
 * Strings are clipped, never refused: the first live figure was thrown away
 * whole because its unit ran two characters past a limit, and a figure lost
 * over one long string is the wrong trade. Only the counts are hard limits,
 * because truncating data would draw a different chart than the one written.
 */
const label = (max: number) =>
  z
    .string()
    .trim()
    .min(1)
    .transform((text) => (text.length > max ? `${text.slice(0, max - 1)}…` : text));
const clipped = (max: number) => z.string().trim().transform((text) => (text.length > max ? `${text.slice(0, max - 1)}…` : text));

const chartSeriesSchema = z.object({
  name: label(FIGURE_LIMITS.label),
  values: z.array(z.number()).min(1)
});

export const chartFigureSchema = z
  .object({
    kind: z.enum(CHART_KINDS),
    title: label(FIGURE_LIMITS.title),
    categories: z.array(label(FIGURE_LIMITS.label)).min(1).max(FIGURE_LIMITS.linePoints),
    series: z.array(chartSeriesSchema).min(1).max(FIGURE_LIMITS.series),
    unit: clipped(FIGURE_LIMITS.unit).optional(),
    orientation: z.enum(["vertical", "horizontal"]).optional(),
    /** `log` for values spanning orders of magnitude — operation counts, populations; needs every value above zero. */
    scale: z.enum(["linear", "log"]).optional(),
    source: label(FIGURE_LIMITS.source),
    caption: clipped(FIGURE_LIMITS.caption).optional()
  })
  .superRefine((spec, context) => {
    for (const [index, series] of spec.series.entries()) {
      if (series.values.length !== spec.categories.length) {
        context.addIssue({
          code: "custom",
          path: ["series", index, "values"],
          message: `has ${series.values.length} values for ${spec.categories.length} categories`
        });
      }
      if (series.values.some((value) => !Number.isFinite(value))) {
        context.addIssue({ code: "custom", path: ["series", index, "values"], message: "holds a value that is not a finite number" });
      }
    }
    if (spec.kind === "bar" && spec.categories.length > FIGURE_LIMITS.barCategories) {
      context.addIssue({ code: "custom", path: ["categories"], message: `a bar chart holds at most ${FIGURE_LIMITS.barCategories} categories` });
    }
    if (spec.kind === "line" && spec.categories.length < 2) {
      context.addIssue({ code: "custom", path: ["categories"], message: "a line chart needs at least two points" });
    }
    if (spec.kind === "pie") {
      if (spec.series.length !== 1) {
        context.addIssue({ code: "custom", path: ["series"], message: "a pie chart holds exactly one series" });
      }
      if (spec.categories.length > FIGURE_LIMITS.pieSlices) {
        context.addIssue({ code: "custom", path: ["categories"], message: `a pie chart holds at most ${FIGURE_LIMITS.pieSlices} slices` });
      }
      if (spec.series.some((series) => series.values.some((value) => value < 0))) {
        context.addIssue({ code: "custom", path: ["series"], message: "a pie chart cannot hold a negative value" });
      }
      if (spec.series.every((series) => series.values.every((value) => value === 0))) {
        context.addIssue({ code: "custom", path: ["series"], message: "a pie chart needs one value above zero" });
      }
    }
  });

export type ChartFigureSpec = z.infer<typeof chartFigureSchema>;

export const FLOW_NODE_SHAPES = ["start", "step", "decision", "end"] as const;
export type FlowNodeShape = (typeof FLOW_NODE_SHAPES)[number];

const nodeId = z.string().trim().min(1).max(40);

const flowNodeSchema = z.object({
  id: nodeId,
  label: label(FIGURE_LIMITS.nodeLabel),
  shape: z.enum(FLOW_NODE_SHAPES).optional()
});

const flowEdgeSchema = z.object({
  from: nodeId,
  to: nodeId,
  label: clipped(FIGURE_LIMITS.edgeLabel).optional()
});

export const flowFigureSchema = z
  .object({
    kind: z.literal("flow"),
    title: label(FIGURE_LIMITS.title),
    nodes: z.array(flowNodeSchema).min(2).max(FIGURE_LIMITS.flowNodes),
    edges: z.array(flowEdgeSchema).min(1).max(FIGURE_LIMITS.flowEdges),
    source: label(FIGURE_LIMITS.source),
    caption: clipped(FIGURE_LIMITS.caption).optional()
  })
  .superRefine((spec, context) => {
    const ids = new Set<string>();
    for (const [index, node] of spec.nodes.entries()) {
      if (ids.has(node.id)) {
        context.addIssue({ code: "custom", path: ["nodes", index, "id"], message: `the id "${node.id}" is used twice` });
      }
      ids.add(node.id);
    }
    for (const [index, edge] of spec.edges.entries()) {
      if (!ids.has(edge.from) || !ids.has(edge.to)) {
        context.addIssue({ code: "custom", path: ["edges", index], message: `names a node that does not exist (${edge.from} → ${edge.to})` });
      } else if (edge.from === edge.to) {
        context.addIssue({ code: "custom", path: ["edges", index], message: `loops "${edge.from}" onto itself` });
      }
    }
  });

export type FlowFigureSpec = z.infer<typeof flowFigureSchema>;
export type FigureSpec = ChartFigureSpec | FlowFigureSpec;

/** Both shapes, for a caller that already knows it holds a figure. */
export const figureSpecSchema = z.union([chartFigureSchema, flowFigureSchema]);

/** What the form plan assigns a section: the kind, what it shows, and where its numbers or steps come from. */
export const figurePlanSchema = z.object({
  kind: z.enum(FIGURE_KINDS),
  shows: z.string().trim().min(1).max(200),
  source: z.string().trim().max(200).default("")
});

export type FigurePlan = z.infer<typeof figurePlanSchema>;

export type ParsedFigure = { spec: FigureSpec; error?: undefined } | { spec?: undefined; error: string };

function parseJsonTolerantly(body: string): unknown {
  const trimmed = body.trim();
  try {
    return JSON.parse(trimmed);
  } catch (error) {
    // A trailing comma before a closing bracket is the one JSON fault models
    // make routinely; anything else is refused as written.
    const repaired = trimmed.replace(/,\s*([}\]])/g, "$1");
    if (repaired === trimmed) throw error;
    return JSON.parse(repaired);
  }
}

/** Reads a fence body. Never throws: a body that is not a figure comes back as an error sentence. */
export function parseFigureSpec(body: string): ParsedFigure {
  let raw: unknown;
  try {
    raw = parseJsonTolerantly(body);
  } catch (error) {
    return { error: `not JSON (${error instanceof Error ? error.message : String(error)})` };
  }
  if (!isRecord(raw)) {
    return { error: "not a JSON object" };
  }
  const kind = raw.kind;
  const schema =
    kind === "flow" ? flowFigureSchema : (CHART_KINDS as readonly unknown[]).includes(kind) ? chartFigureSchema : undefined;
  if (!schema) {
    return { error: `unknown kind ${JSON.stringify(kind)}` };
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    return {
      error: parsed.error.issues
        .map((issue) => `${issue.path.join(".") || "figure"}: ${issue.message}`)
        .join("; ")
        .slice(0, 300)
    };
  }
  return { spec: normalizeFigureSpec(parsed.data) };
}

/** A log scale over a value at or below zero cannot be drawn, so the chart falls back to linear rather than being lost. */
function normalizeFigureSpec(spec: FigureSpec): FigureSpec {
  if (spec.kind === "flow" || spec.scale !== "log") return spec;
  if (spec.kind === "pie" || spec.series.some((series) => series.values.some((value) => value <= 0))) {
    const { scale: _unusable, ...rest } = spec;
    return rest;
  }
  return spec;
}

/** The block as the manuscript stores it: the tag, one line of JSON, the closer. */
export function canonicalFigureFence(spec: FigureSpec): string {
  return `\`\`\`${FIGURE_FENCE_TAG}\n${JSON.stringify(spec)}\n\`\`\``;
}
