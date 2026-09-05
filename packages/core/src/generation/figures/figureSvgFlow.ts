import type { FlowFigureSpec, FlowNodeShape } from "./figureSpec.js";
import { FIGURE_INK, FIGURE_WIDTH, escapeXml, estimateTextWidth, round, svgOpen, wrapLabel, type FigureRenderContext } from "./figureSvgShared.js";

/**
 * A flow diagram laid out top to bottom: back edges found by depth-first
 * search, layers by longest path over the rest, nodes ordered within a layer
 * by the barycentre of their neighbours, loops routed down a channel on the
 * right. Small enough (twelve nodes, sixteen edges) that the simple version
 * of every step is the right one. Arrowheads are polygons, not markers, so
 * nothing needs an id.
 */

const MARGIN = 16;
const LAYER_PITCH = 100;
const NODE_GAP = 24;
const BACK_CHANNEL = 28;
const MAX_BACK_CHANNELS = 3;
/**
 * A `<figure>` is `break-inside:avoid`. A4 content is ~255mm tall; at full
 * column width a 640×720 drawing is ~196mm, which still leaves room for the
 * caption. The old 14-layer pitch of 100 ran to ~1398px and spilled the page.
 */
const MAX_FLOW_HEIGHT = 720;
const LABEL_SIZE = 12;
const LINE_HEIGHT = 14;
const MAX_LABEL_LINES = 3;
const NODE_SIZES: Record<FlowNodeShape, { w: number; h: number }> = {
  start: { w: 140, h: 40 },
  end: { w: 140, h: 40 },
  step: { w: 150, h: 46 },
  decision: { w: 150, h: 66 }
};
const NODE_FILLS: Record<FlowNodeShape, string> = {
  start: "#e8f1fc",
  end: "#e8f1fc",
  step: FIGURE_INK.surface,
  decision: "#fdf0e8"
};

export type FlowLayoutNode = {
  id: string;
  label: string;
  shape: FlowNodeShape;
  /** Centre. */
  x: number;
  y: number;
  w: number;
  h: number;
  layer: number;
  lines: string[];
};

export type FlowLayoutEdge = {
  from: string;
  to: string;
  label?: string | undefined;
  back: boolean;
  path: string;
  /** Arrowhead polygon points. */
  arrow: string;
  labelAt: { x: number; y: number };
};

export type FlowLayout = { width: number; height: number; layers: number; nodes: FlowLayoutNode[]; edges: FlowLayoutEdge[] };

function average(values: number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

/** Scale a layer so nodes + gaps fit `usable`. Never floors to a minimum width that would overflow. */
function fitLayer(widths: number[], usable: number): { scale: number; gap: number } {
  const total = widths.reduce((sum, width) => sum + width, 0);
  const gapCount = Math.max(0, widths.length - 1);
  if (widths.length === 0 || total <= 0) return { scale: 1, gap: NODE_GAP };
  if (gapCount === 0) return { scale: total > usable ? usable / total : 1, gap: 0 };
  const preferredGaps = NODE_GAP * gapCount;
  if (total + preferredGaps <= usable) return { scale: 1, gap: NODE_GAP };
  if (preferredGaps < usable) return { scale: (usable - preferredGaps) / total, gap: NODE_GAP };
  // Gaps themselves overflow: shrink them until the row fits, then scale nodes if zero gap is still too wide.
  if (total <= usable) return { scale: 1, gap: (usable - total) / gapCount };
  return { scale: usable / total, gap: 0 };
}

function clampNodeToViewBox(node: FlowLayoutNode): void {
  if (node.w > FIGURE_WIDTH) node.w = FIGURE_WIDTH;
  const half = node.w / 2;
  if (node.x - half < 0) node.x = half;
  if (node.x + half > FIGURE_WIDTH) node.x = FIGURE_WIDTH - half;
}

const SKIP_EDGE_INSET = 4;

/** Half-width plus gutter, signed toward the nearer sheet edge. Zero only when the edge does not skip. */
function skipEdgeBow(from: FlowLayoutNode, to: FlowLayoutNode, columnCenter: number): number {
  if (to.layer - from.layer < 2) return 0;
  return (from.x <= columnCenter ? -1 : 1) * (Math.max(from.w, to.w) / 2 + 40);
}

export function layoutFlow(spec: FlowFigureSpec): FlowLayout {
  const indexOf = new Map(spec.nodes.map((node, index) => [node.id, index]));
  const edges = spec.edges.map((edge) => ({ from: indexOf.get(edge.from)!, to: indexOf.get(edge.to)!, label: edge.label }));
  const out: number[][] = spec.nodes.map(() => []);
  const incoming = spec.nodes.map(() => 0);
  for (const [key, edge] of edges.entries()) {
    out[edge.from]!.push(key);
    incoming[edge.to] = (incoming[edge.to] ?? 0) + 1;
  }

  // Back edges: an edge to a node still on the search stack.
  const back = new Set<number>();
  const state = spec.nodes.map(() => 0);
  const visit = (node: number): void => {
    state[node] = 1;
    for (const key of out[node]!) {
      const target = edges[key]!.to;
      if (state[target] === 1) {
        back.add(key);
      } else if (state[target] === 0) {
        visit(target);
      }
    }
    state[node] = 2;
  };
  const roots = [...spec.nodes.keys()].sort((left, right) => (incoming[left] === 0 ? 0 : 1) - (incoming[right] === 0 ? 0 : 1) || left - right);
  for (const root of roots) if (state[root] === 0) visit(root);

  // Longest-path layering over the forward edges, which form a DAG.
  const layer = spec.nodes.map(() => 0);
  const forwardIn = spec.nodes.map(() => 0);
  for (const [key, edge] of edges.entries()) if (!back.has(key)) forwardIn[edge.to] = (forwardIn[edge.to] ?? 0) + 1;
  const queue = [...spec.nodes.keys()].filter((node) => forwardIn[node] === 0);
  while (queue.length > 0) {
    const node = queue.shift()!;
    for (const key of out[node]!) {
      if (back.has(key)) continue;
      const target = edges[key]!.to;
      layer[target] = Math.max(layer[target]!, layer[node]! + 1);
      forwardIn[target] = (forwardIn[target] ?? 1) - 1;
      if (forwardIn[target] === 0) queue.push(target);
    }
  }
  const layerCount = Math.max(...layer) + 1;
  const layers: number[][] = Array.from({ length: layerCount }, () => []);
  for (const node of spec.nodes.keys()) layers[layer[node]!]!.push(node);

  // Barycentre ordering, two sweeps down and up.
  const position = new Map<number, number>();
  const settle = () => layers.forEach((members) => members.forEach((node, index) => position.set(node, index)));
  settle();
  const forwardEdges = edges.map((edge, key) => ({ ...edge, key })).filter((edge) => !back.has(edge.key));
  const neighbours = (node: number, direction: "up" | "down") =>
    forwardEdges.filter((edge) => (direction === "up" ? edge.to === node : edge.from === node)).map((edge) => (direction === "up" ? edge.from : edge.to));
  const sortLayer = (members: number[], direction: "up" | "down") => {
    const keyed = members.map((node, index) => {
      const near = neighbours(node, direction);
      return { node, key: near.length > 0 ? average(near.map((other) => position.get(other)!)) : index };
    });
    keyed.sort((left, right) => left.key - right.key || position.get(left.node)! - position.get(right.node)!);
    return keyed.map((entry) => entry.node);
  };
  for (let round = 0; round < 2; round += 1) {
    for (let index = 1; index < layerCount; index += 1) {
      layers[index] = sortLayer(layers[index]!, "up");
      settle();
    }
    for (let index = layerCount - 2; index >= 0; index -= 1) {
      layers[index] = sortLayer(layers[index]!, "down");
      settle();
    }
  }

  // Geometry.
  const channels = Math.min(MAX_BACK_CHANNELS, back.size);
  const reserved = channels > 0 ? 16 + channels * BACK_CHANNEL : 0;
  const usable = FIGURE_WIDTH - 2 * MARGIN - reserved;
  // The last layer's back edges drop below their node before turning, so the sheet leaves room for them.
  const backRoom = channels > 0 ? 16 : 0;
  const fixed = 2 * MARGIN + 66;
  const naturalHeight = fixed + backRoom + Math.max(0, layerCount - 1) * LAYER_PITCH;
  const height = Math.min(MAX_FLOW_HEIGHT, naturalHeight);
  const extra = height < fixed + backRoom ? Math.max(0, height - fixed) : backRoom;
  const pitch = layerCount > 1 ? Math.max(0, (height - fixed - extra) / (layerCount - 1)) : LAYER_PITCH;
  const nodes: FlowLayoutNode[] = spec.nodes.map((node, index) => {
    const shape = node.shape ?? "step";
    return { id: node.id, label: node.label, shape, x: 0, y: 0, w: NODE_SIZES[shape].w, h: NODE_SIZES[shape].h, layer: layer[index]!, lines: [] };
  });
  // Compressed pitch used to be smaller than a decision diamond, so a 14-layer
  // chain of those overlapped even though the viewBox was capped.
  const maxH = Math.max(...nodes.map((node) => node.h), 1);
  if (layerCount > 1 && pitch > 0 && maxH + 8 > pitch) {
    const scaleH = Math.max(0.35, (pitch - 8) / maxH);
    for (const node of nodes) node.h *= scaleH;
  }
  for (const [layerIndex, members] of layers.entries()) {
    const widths = members.map((node) => nodes[node]!.w);
    const total = widths.reduce((sum, width) => sum + width, 0);
    const { scale, gap } = fitLayer(widths, usable);
    const gapCount = Math.max(0, members.length - 1);
    const scaledTotal = total * scale + gap * gapCount;
    let cursor = MARGIN + Math.max(0, (usable - scaledTotal) / 2);
    for (const node of members) {
      const entry = nodes[node]!;
      entry.w = entry.w * scale;
      entry.x = cursor + entry.w / 2;
      entry.y = MARGIN + 33 + layerIndex * pitch;
      clampNodeToViewBox(entry);
      const usableChars = Math.max(6, Math.floor(((entry.shape === "decision" ? entry.w * 0.72 : entry.w) - 14) / 6.6));
      entry.lines = wrapLabel(entry.label, usableChars, MAX_LABEL_LINES);
      cursor += entry.w + gap;
    }
  }

  // Where an edge leaves and enters a box: a node's forward edges are spread
  // along its bottom, ordered by where they go, and a target's along its top,
  // so a column of edges into one node no longer draws as one line. A diamond
  // keeps its vertices.
  const outgoing = new Map<number, number[]>();
  const incoming2 = new Map<number, number[]>();
  for (const [key, edge] of edges.entries()) {
    if (back.has(key)) continue;
    outgoing.set(edge.from, [...(outgoing.get(edge.from) ?? []), key]);
    incoming2.set(edge.to, [...(incoming2.get(edge.to) ?? []), key]);
  }
  const spread = (keys: number[], key: number, node: FlowLayoutNode, byX: (edge: (typeof edges)[number]) => number): number => {
    if (node.shape === "decision" || keys.length <= 1) return 0;
    const ordered = [...keys].sort((left, right) => byX(edges[left]!) - byX(edges[right]!));
    const index = ordered.indexOf(key);
    const span = node.w * 0.5;
    return -span / 2 + (span * index) / (ordered.length - 1);
  };
  const forwardGeom = (key: number, edge: (typeof edges)[number]) => {
    const from = nodes[edge.from]!;
    const to = nodes[edge.to]!;
    return {
      from,
      to,
      x1: from.x + spread(outgoing.get(edge.from) ?? [], key, from, (other) => nodes[other.to]!.x),
      y1: from.y + from.h / 2,
      x2: to.x + spread(incoming2.get(edge.to) ?? [], key, to, (other) => nodes[other.from]!.x),
      y2: to.y - to.h / 2
    };
  };

  // Keep the unclamped skip-edge bow. If a control would leave 4..width-4,
  // grow the sheet and shift the column rather than flattening the curve
  // back through the boxes it was meant to miss.
  let padLeft = 0;
  let padRight = 0;
  for (const [key, edge] of edges.entries()) {
    if (back.has(key)) continue;
    const { from, to, x1, x2 } = forwardGeom(key, edge);
    const bow = skipEdgeBow(from, to, FIGURE_WIDTH / 2);
    if (bow === 0) continue;
    for (const control of [x1 + bow, x2 + bow]) {
      padLeft = Math.max(padLeft, SKIP_EDGE_INSET - control);
      padRight = Math.max(padRight, control - (FIGURE_WIDTH - SKIP_EDGE_INSET));
    }
  }
  const width = FIGURE_WIDTH + padLeft + padRight;
  if (padLeft > 0) for (const node of nodes) node.x += padLeft;

  let channel = 0;
  const laidOut: FlowLayoutEdge[] = edges.map((edge, key) => {
    const from = nodes[edge.from]!;
    const to = nodes[edge.to]!;
    if (back.has(key)) {
      const cx = padLeft + FIGURE_WIDTH - MARGIN - reserved + 16 + Math.min(channel, channels - 1) * BACK_CHANNEL;
      channel += 1;
      // Out of the bottom of the source, not its side: a side exit runs
      // straight through whatever sits to its right in the same layer.
      const x1 = from.x + from.w / 4;
      const y1 = from.y + from.h / 2;
      const below = y1 + 14;
      const x2 = to.x + to.w / 2;
      return {
        from: from.id,
        to: to.id,
        label: edge.label,
        back: true,
        path: `M${round(x1)} ${round(y1)}V${round(below)}H${round(cx)}V${round(to.y)}H${round(x2)}`,
        arrow: `${round(x2)},${round(to.y)} ${round(x2 + 8)},${round(to.y - 4.5)} ${round(x2 + 8)},${round(to.y + 4.5)}`,
        labelAt: { x: cx + 4, y: (below + to.y) / 2 + 4 }
      };
    }
    const { x1, y1, x2, y2 } = forwardGeom(key, edge);
    const ym = (y1 + y2) / 2;
    const bow = skipEdgeBow(from, to, padLeft + FIGURE_WIDTH / 2);
    const path =
      bow !== 0
        ? `M${round(x1)} ${round(y1)}C${round(x1 + bow)} ${round(y1 + 40)} ${round(x2 + bow)} ${round(y2 - 40)} ${round(x2)} ${round(y2)}`
        : Math.abs(x1 - x2) < 1
          ? `M${round(x1)} ${round(y1)}L${round(x2)} ${round(y2)}`
          : `M${round(x1)} ${round(y1)}C${round(x1)} ${round(ym)} ${round(x2)} ${round(ym)} ${round(x2)} ${round(y2)}`;
    return {
      from: from.id,
      to: to.id,
      label: edge.label,
      back: false,
      path,
      arrow: `${round(x2)},${round(y2)} ${round(x2 - 4.5)},${round(y2 - 8)} ${round(x2 + 4.5)},${round(y2 - 8)}`,
      labelAt: { x: (x1 + x2) / 2 + bow * 0.75 + 6, y: ym + 4 }
    };
  });
  return { width, height, layers: layerCount, nodes, edges: laidOut };
}

function nodeShape(node: FlowLayoutNode): string {
  const stroke = ` fill="${NODE_FILLS[node.shape]}" stroke="${FIGURE_INK.secondary}" stroke-width="1.25" class="figure-node"`;
  if (node.shape === "decision") {
    const points = `${round(node.x)},${round(node.y - node.h / 2)} ${round(node.x + node.w / 2)},${round(node.y)} ${round(node.x)},${round(node.y + node.h / 2)} ${round(node.x - node.w / 2)},${round(node.y)}`;
    return `<polygon points="${points}"${stroke}/>`;
  }
  const radius = node.shape === "step" ? 5 : node.h / 2;
  return `<rect x="${round(node.x - node.w / 2)}" y="${round(node.y - node.h / 2)}" width="${round(node.w)}" height="${round(node.h)}" rx="${round(radius)}"${stroke}/>`;
}

function centredLines(x: number, y: number, lines: string[], context: FigureRenderContext, size: number): string {
  const direction = context.profile.direction === "rtl" ? ' direction="rtl" unicode-bidi="embed"' : "";
  const firstY = y - ((lines.length - 1) * LINE_HEIGHT) / 2 + size * 0.35;
  const spans = lines.map((line, index) => (index === 0 ? escapeXml(line) : `<tspan x="${round(x)}" dy="${LINE_HEIGHT}">${escapeXml(line)}</tspan>`)).join("");
  return `<text x="${round(x)}" y="${round(firstY)}" font-size="${size}" fill="${FIGURE_INK.primary}" text-anchor="middle"${direction}>${spans}</text>`;
}

export function renderFlowSvg(spec: FlowFigureSpec, context: FigureRenderContext): string {
  const layout = layoutFlow(spec);
  const parts: string[] = [];
  for (const edge of layout.edges) {
    parts.push(`<path d="${edge.path}" fill="none" stroke="${FIGURE_INK.secondary}" stroke-width="1.5" class="figure-edge"/>`);
    parts.push(`<polygon points="${edge.arrow}" fill="${FIGURE_INK.secondary}" class="figure-arrow"/>`);
  }
  for (const node of layout.nodes) {
    parts.push(nodeShape(node));
    parts.push(centredLines(node.x, node.y, node.lines, context, LABEL_SIZE));
  }
  for (const edge of layout.edges) {
    const label = edge.label?.trim();
    if (!label) continue;
    const width = estimateTextWidth(label, 11) + 8;
    const x = Math.min(layout.width - width + 4, Math.max(4, edge.labelAt.x));
    const y = Math.min(layout.height - 3, Math.max(11, edge.labelAt.y));
    parts.push(`<rect x="${round(x - 4)}" y="${round(y - 11)}" width="${round(width)}" height="14" rx="2" fill="${FIGURE_INK.surface}"/>`);
    const direction = context.profile.direction === "rtl" ? ' direction="rtl" unicode-bidi="embed"' : "";
    parts.push(`<text x="${round(x)}" y="${round(y)}" font-size="11" fill="${FIGURE_INK.secondary}" text-anchor="${context.profile.direction === "rtl" ? "end" : "start"}"${direction}>${escapeXml(label)}</text>`);
  }
  return `${svgOpen({
    height: layout.height,
    width: layout.width,
    label: `${context.labels.figure}: ${spec.title}`
  })}${parts.join("")}</svg>`;
}
