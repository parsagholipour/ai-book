import type { ChartFigureSpec } from "./figureSpec.js";
import {
  FIGURE_INK,
  FIGURE_LINE_DASHES,
  FIGURE_SERIES_COLORS,
  FIGURE_WIDTH,
  estimateTextWidth,
  formatFigureNumber,
  formatTickNumber,
  niceTicks,
  round,
  svgOpen,
  svgText,
  wrapLabel,
  type FigureRenderContext
} from "./figureSvgShared.js";

/**
 * Bar, line and pie charts as static SVG. No script, no `<marker>`, no `id`
 * attribute anywhere: the PDF render runs with JavaScript off, two figures in
 * one book must not share an id, and the page-anchor pass renames reserved
 * ids in the rendered HTML. Every empty element is self-closed because the
 * EPUB's XHTML pass closes only `img|br|hr|input|meta|link`.
 */

const CHART_HEIGHT = 360;
const PIE_HEIGHT = 320;
const MARGIN = { top: 14, right: 16, bottom: 44, left: 60 };
const MIN_AXIS_MARGIN = 48;
const MAX_AXIS_MARGIN = 150;
/** Values whose largest is this many times the smallest are drawn on a log axis unless the writer chose otherwise. */
const AUTO_LOG_RATIO = 1000;
const LEGEND_ROW = 18;
const BAR_MAX_WIDTH = 24;
const BAR_GAP = 2;
const BAR_RADIUS = 4;
const TICK_SIZE = 11;
const LABEL_SIZE = 12;

type Plot = { left: number; right: number; top: number; bottom: number };

function seriesColor(index: number): string {
  return FIGURE_SERIES_COLORS[index % FIGURE_SERIES_COLORS.length]!;
}

function legend(spec: ChartFigureSpec, context: FigureRenderContext, x: number, y: number, kind: "swatch" | "line"): { svg: string; rows: number } {
  if (spec.series.length < 2) return { svg: "", rows: 0 };
  const parts: string[] = [];
  let cursor = x;
  let rows = 1;
  let rowY = y;
  for (const [index, series] of spec.series.entries()) {
    const width = 20 + estimateTextWidth(series.name, LABEL_SIZE) + 18;
    if (cursor + width > FIGURE_WIDTH - MARGIN.right && cursor > x) {
      rows += 1;
      rowY += LEGEND_ROW;
      cursor = x;
    }
    if (kind === "swatch") {
      parts.push(`<rect x="${round(cursor)}" y="${round(rowY - 9)}" width="12" height="12" rx="2" fill="${seriesColor(index)}"/>`);
    } else {
      const dash = FIGURE_LINE_DASHES[index % FIGURE_LINE_DASHES.length];
      parts.push(
        `<line x1="${round(cursor)}" y1="${round(rowY - 3)}" x2="${round(cursor + 16)}" y2="${round(rowY - 3)}" stroke="${seriesColor(index)}" stroke-width="2.5" stroke-linecap="round"${dash ? ` stroke-dasharray="${dash}"` : ""}/>`
      );
    }
    parts.push(svgText({ x: cursor + 20, y: rowY, text: series.name, size: LABEL_SIZE, profile: context.profile, fill: FIGURE_INK.secondary }));
    cursor += width;
  }
  return { svg: parts.join(""), rows };
}

/** The value axis: its ticks, where a value sits along it as a fraction, and where the bars grow from. */
type ValueAxis = { ticks: number[]; fraction: (value: number) => number; baseline: number };

function axisOf(spec: ChartFigureSpec): ValueAxis {
  const values = spec.series.flatMap((series) => series.values);
  const positive = values.every((value) => value > 0);
  // The first live chart put a linear axis over six decades and three of its
  // four series were flat lines: a writer rarely thinks of the scale.
  const log = spec.scale === "log" || (spec.scale === undefined && positive && Math.max(...values) / Math.min(...values) >= AUTO_LOG_RATIO);
  if (log && positive) {
    const smallest = Math.min(...values);
    let low = Math.floor(Math.log10(smallest) + 1e-9);
    // A value sitting on the lowest tick would draw a bar of no height.
    if (10 ** low >= smallest) low -= 1;
    const high = Math.max(low + 1, Math.ceil(Math.log10(Math.max(...values)) - 1e-9));
    const decades = high - low;
    const every = decades > 8 ? Math.ceil(decades / 8) : 1;
    const ticks: number[] = [];
    for (let power = low; power <= high; power += every) ticks.push(10 ** power);
    if (ticks.at(-1) !== 10 ** high) ticks.push(10 ** high);
    return {
      ticks,
      fraction: (value) => (Math.log10(Math.max(value, 10 ** low)) - low) / (high - low),
      baseline: 0
    };
  }
  const ticks = niceTicks(Math.min(0, ...values), Math.max(0, ...values));
  const min = ticks[0]!;
  const max = ticks.at(-1)!;
  const fraction = (value: number) => (value - min) / (max - min);
  return { ticks, fraction, baseline: fraction(Math.max(min, Math.min(0, max))) };
}

function tickLabel(value: number, spec: ChartFigureSpec, context: FigureRenderContext): string {
  const number = formatTickNumber(value, context.profile);
  return spec.unit && spec.unit.length <= 2 ? `${number}${spec.unit}` : number;
}

/** A unit longer than a sign gets a line of its own above the axis; on the ticks it would widen every label. */
function hasUnitRow(spec: ChartFigureSpec): boolean {
  return Boolean(spec.unit && spec.unit.length > 2);
}

function unitLabel(spec: ChartFigureSpec, context: FigureRenderContext, x: number, y: number, align: "left" | "right"): string {
  if (!hasUnitRow(spec)) return "";
  return svgText({ x, y, text: spec.unit!, size: TICK_SIZE, profile: context.profile, align, fill: FIGURE_INK.muted });
}

/** The left margin a value axis needs: the widest tick label, within bounds. */
function axisMargin(axis: ValueAxis, spec: ChartFigureSpec, context: FigureRenderContext): number {
  const widest = Math.max(...axis.ticks.map((tick) => estimateTextWidth(tickLabel(tick, spec, context), TICK_SIZE)));
  return Math.min(MAX_AXIS_MARGIN, Math.max(MIN_AXIS_MARGIN, Math.ceil(widest) + 16));
}

function verticalBarPath(x: number, top: number, bottom: number, width: number, radius: number, upward: boolean): string {
  const r = Math.min(radius, width / 2, Math.abs(bottom - top) / 2);
  if (upward) {
    return `M${round(x)} ${round(bottom)}V${round(top + r)}Q${round(x)} ${round(top)} ${round(x + r)} ${round(top)}H${round(x + width - r)}Q${round(x + width)} ${round(top)} ${round(x + width)} ${round(top + r)}V${round(bottom)}Z`;
  }
  return `M${round(x)} ${round(top)}V${round(bottom - r)}Q${round(x)} ${round(bottom)} ${round(x + r)} ${round(bottom)}H${round(x + width - r)}Q${round(x + width)} ${round(bottom)} ${round(x + width)} ${round(bottom - r)}V${round(top)}Z`;
}

function horizontalBarPath(y: number, left: number, right: number, height: number, radius: number, rightward: boolean): string {
  const r = Math.min(radius, height / 2, Math.abs(right - left) / 2);
  if (rightward) {
    return `M${round(left)} ${round(y)}H${round(right - r)}Q${round(right)} ${round(y)} ${round(right)} ${round(y + r)}V${round(y + height - r)}Q${round(right)} ${round(y + height)} ${round(right - r)} ${round(y + height)}H${round(left)}Z`;
  }
  return `M${round(right)} ${round(y)}H${round(left + r)}Q${round(left)} ${round(y)} ${round(left)} ${round(y + r)}V${round(y + height - r)}Q${round(left)} ${round(y + height)} ${round(left + r)} ${round(y + height)}H${round(right)}Z`;
}

function renderVerticalBars(spec: ChartFigureSpec, context: FigureRenderContext): string {
  const axis = axisOf(spec);
  const left = axisMargin(axis, spec, context);
  const legendBlock = legend(spec, context, left, MARGIN.top + 10, "swatch");
  const plot: Plot = {
    left,
    right: FIGURE_WIDTH - MARGIN.right,
    top: MARGIN.top + legendBlock.rows * LEGEND_ROW + (legendBlock.rows > 0 ? 8 : 6) + (hasUnitRow(spec) ? LEGEND_ROW : 0),
    bottom: CHART_HEIGHT - MARGIN.bottom
  };
  const y = (value: number) => plot.bottom - axis.fraction(value) * (plot.bottom - plot.top);
  const parts: string[] = [legendBlock.svg];
  for (const tick of axis.ticks) {
    parts.push(`<line x1="${round(plot.left)}" y1="${round(y(tick))}" x2="${round(plot.right)}" y2="${round(y(tick))}" stroke="${FIGURE_INK.grid}" stroke-width="1"/>`);
    parts.push(svgText({ x: plot.left - 8, y: y(tick) + 4, text: tickLabel(tick, spec, context), size: TICK_SIZE, profile: context.profile, align: "right", fill: FIGURE_INK.muted }));
  }
  parts.push(unitLabel(spec, context, plot.left, plot.top - 7, "left"));
  const baseline = plot.bottom - axis.baseline * (plot.bottom - plot.top);
  const groupWidth = (plot.right - plot.left) / spec.categories.length;
  const count = spec.series.length;
  const barWidth = Math.max(3, Math.min(BAR_MAX_WIDTH, (groupWidth * 0.72 - (count - 1) * BAR_GAP) / count));
  const groupContent = count * barWidth + (count - 1) * BAR_GAP;
  const maxChars = Math.max(6, Math.floor(groupWidth / 6.2));
  for (const [categoryIndex, category] of spec.categories.entries()) {
    const groupLeft = plot.left + categoryIndex * groupWidth + (groupWidth - groupContent) / 2;
    for (const [seriesIndex, series] of spec.series.entries()) {
      const value = series.values[categoryIndex] ?? 0;
      const x = groupLeft + seriesIndex * (barWidth + BAR_GAP);
      const top = Math.min(y(value), baseline);
      const bottom = Math.max(y(value), baseline);
      if (bottom - top < 0.5) continue;
      parts.push(`<path d="${verticalBarPath(x, top, bottom, barWidth, BAR_RADIUS, value >= 0)}" fill="${seriesColor(seriesIndex)}"/>`);
    }
    const lines = wrapLabel(category, maxChars, 2);
    for (const [lineIndex, line] of lines.entries()) {
      parts.push(svgText({ x: plot.left + categoryIndex * groupWidth + groupWidth / 2, y: plot.bottom + 16 + lineIndex * 13, text: line, size: TICK_SIZE, profile: context.profile, align: "middle" }));
    }
  }
  parts.push(`<line x1="${round(plot.left)}" y1="${round(baseline)}" x2="${round(plot.right)}" y2="${round(baseline)}" stroke="${FIGURE_INK.axis}" stroke-width="1"/>`);
  return `${svgOpen({ height: CHART_HEIGHT, label: `${context.labels.figure}: ${spec.title}` })}${parts.join("")}</svg>`;
}

function renderHorizontalBars(spec: ChartFigureSpec, context: FigureRenderContext): string {
  const axis = axisOf(spec);
  const longest = Math.max(...spec.categories.map((category) => estimateTextWidth(category, TICK_SIZE)));
  const labelWidth = Math.min(200, Math.max(60, longest + 12));
  const legendBlock = legend(spec, context, labelWidth + 12, MARGIN.top + 10, "swatch");
  const count = spec.series.length;
  const rowHeight = Math.max(count * 14 + 10, 26);
  const plotTop = MARGIN.top + legendBlock.rows * LEGEND_ROW + (legendBlock.rows > 0 ? 8 : 6);
  const height = plotTop + spec.categories.length * rowHeight + 34;
  const plot: Plot = { left: labelWidth + 12, right: FIGURE_WIDTH - MARGIN.right, top: plotTop, bottom: plotTop + spec.categories.length * rowHeight };
  const x = (value: number) => plot.left + axis.fraction(value) * (plot.right - plot.left);
  const parts: string[] = [legendBlock.svg];
  for (const tick of axis.ticks) {
    parts.push(`<line x1="${round(x(tick))}" y1="${round(plot.top)}" x2="${round(x(tick))}" y2="${round(plot.bottom)}" stroke="${FIGURE_INK.grid}" stroke-width="1"/>`);
    parts.push(svgText({ x: x(tick), y: plot.bottom + 16, text: tickLabel(tick, spec, context), size: TICK_SIZE, profile: context.profile, align: "middle", fill: FIGURE_INK.muted }));
  }
  parts.push(unitLabel(spec, context, plot.right, plot.bottom + 30, "right"));
  const baseline = plot.left + axis.baseline * (plot.right - plot.left);
  const barHeight = Math.max(3, Math.min(BAR_MAX_WIDTH, (rowHeight * 0.76 - (count - 1) * BAR_GAP) / count));
  const groupContent = count * barHeight + (count - 1) * BAR_GAP;
  const maxChars = Math.max(6, Math.floor(labelWidth / 6.2));
  for (const [categoryIndex, category] of spec.categories.entries()) {
    const rowTop = plot.top + categoryIndex * rowHeight;
    const groupTop = rowTop + (rowHeight - groupContent) / 2;
    for (const [seriesIndex, series] of spec.series.entries()) {
      const value = series.values[categoryIndex] ?? 0;
      const yTop = groupTop + seriesIndex * (barHeight + BAR_GAP);
      const left = Math.min(x(value), baseline);
      const right = Math.max(x(value), baseline);
      if (right - left < 0.5) continue;
      parts.push(`<path d="${horizontalBarPath(yTop, left, right, barHeight, BAR_RADIUS, value >= 0)}" fill="${seriesColor(seriesIndex)}"/>`);
    }
    const lines = wrapLabel(category, maxChars, 2);
    const firstY = rowTop + rowHeight / 2 + 4 - ((lines.length - 1) * 13) / 2;
    for (const [lineIndex, line] of lines.entries()) {
      parts.push(svgText({ x: plot.left - 8, y: firstY + lineIndex * 13, text: line, size: TICK_SIZE, profile: context.profile, align: "right" }));
    }
  }
  parts.push(`<line x1="${round(baseline)}" y1="${round(plot.top)}" x2="${round(baseline)}" y2="${round(plot.bottom)}" stroke="${FIGURE_INK.axis}" stroke-width="1"/>`);
  return `${svgOpen({ height, label: `${context.labels.figure}: ${spec.title}` })}${parts.join("")}</svg>`;
}

function renderLines(spec: ChartFigureSpec, context: FigureRenderContext): string {
  const axis = axisOf(spec);
  const left = axisMargin(axis, spec, context);
  const legendBlock = legend(spec, context, left, MARGIN.top + 10, "line");
  const plot: Plot = {
    left,
    right: FIGURE_WIDTH - MARGIN.right,
    top: MARGIN.top + legendBlock.rows * LEGEND_ROW + (legendBlock.rows > 0 ? 8 : 6) + (hasUnitRow(spec) ? LEGEND_ROW : 0),
    bottom: CHART_HEIGHT - MARGIN.bottom
  };
  const y = (value: number) => plot.bottom - axis.fraction(value) * (plot.bottom - plot.top);
  const points = spec.categories.length;
  const inset = 14;
  const x = (index: number) => (points === 1 ? (plot.left + plot.right) / 2 : plot.left + inset + (index * (plot.right - plot.left - inset * 2)) / (points - 1));
  const parts: string[] = [legendBlock.svg];
  for (const tick of axis.ticks) {
    parts.push(`<line x1="${round(plot.left)}" y1="${round(y(tick))}" x2="${round(plot.right)}" y2="${round(y(tick))}" stroke="${FIGURE_INK.grid}" stroke-width="1"/>`);
    parts.push(svgText({ x: plot.left - 8, y: y(tick) + 4, text: tickLabel(tick, spec, context), size: TICK_SIZE, profile: context.profile, align: "right", fill: FIGURE_INK.muted }));
  }
  parts.push(unitLabel(spec, context, plot.left, plot.top - 7, "left"));
  const baseline = plot.bottom - axis.baseline * (plot.bottom - plot.top);
  parts.push(`<line x1="${round(plot.left)}" y1="${round(baseline)}" x2="${round(plot.right)}" y2="${round(baseline)}" stroke="${FIGURE_INK.axis}" stroke-width="1"/>`);
  const every = Math.max(1, Math.ceil(points / 8));
  for (const [index, category] of spec.categories.entries()) {
    if (index % every !== 0 && index !== points - 1) continue;
    parts.push(svgText({ x: x(index), y: plot.bottom + 16, text: wrapLabel(category, 14, 1)[0]!, size: TICK_SIZE, profile: context.profile, align: "middle" }));
  }
  const markers = points <= 12;
  for (const [seriesIndex, series] of spec.series.entries()) {
    const color = seriesColor(seriesIndex);
    const dash = FIGURE_LINE_DASHES[seriesIndex % FIGURE_LINE_DASHES.length];
    const d = series.values.map((value, index) => `${index === 0 ? "M" : "L"}${round(x(index))} ${round(y(value))}`).join("");
    parts.push(`<path d="${d}" fill="none" stroke="${color}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"${dash ? ` stroke-dasharray="${dash}"` : ""}/>`);
    for (const [index, value] of series.values.entries()) {
      if (!markers && index !== 0 && index !== points - 1) continue;
      parts.push(`<circle cx="${round(x(index))}" cy="${round(y(value))}" r="4" fill="${color}" stroke="${FIGURE_INK.surface}" stroke-width="2"/>`);
    }
  }
  return `${svgOpen({ height: CHART_HEIGHT, label: `${context.labels.figure}: ${spec.title}` })}${parts.join("")}</svg>`;
}

function renderPie(spec: ChartFigureSpec, context: FigureRenderContext): string {
  const series = spec.series[0]!;
  const total = series.values.reduce((sum, value) => sum + Math.max(0, value), 0);
  const radius = 118;
  const cx = 170;
  const cy = PIE_HEIGHT / 2;
  const parts: string[] = [];
  let angle = -Math.PI / 2;
  const slices = spec.categories.map((category, index) => ({ category, value: Math.max(0, series.values[index] ?? 0), index })).filter((slice) => slice.value > 0);
  if (slices.length === 1) {
    parts.push(`<circle cx="${cx}" cy="${cy}" r="${radius}" fill="${seriesColor(slices[0]!.index)}"/>`);
  } else {
    for (const slice of slices) {
      const sweep = (slice.value / total) * Math.PI * 2;
      const end = angle + sweep;
      const x1 = cx + radius * Math.cos(angle);
      const y1 = cy + radius * Math.sin(angle);
      const x2 = cx + radius * Math.cos(end);
      const y2 = cy + radius * Math.sin(end);
      const large = sweep > Math.PI ? 1 : 0;
      parts.push(
        `<path d="M${cx} ${cy}L${round(x1)} ${round(y1)}A${radius} ${radius} 0 ${large} 1 ${round(x2)} ${round(y2)}Z" fill="${seriesColor(slice.index)}" stroke="${FIGURE_INK.surface}" stroke-width="2"/>`
      );
      angle = end;
    }
  }
  const legendX = 320;
  const rowHeight = 22;
  let rowY = cy - ((slices.length - 1) * rowHeight) / 2 + 4;
  for (const slice of slices) {
    const share = formatFigureNumber(Math.round((slice.value / total) * 1000) / 10, context.profile);
    parts.push(`<rect x="${legendX}" y="${round(rowY - 10)}" width="12" height="12" rx="2" fill="${seriesColor(slice.index)}"/>`);
    parts.push(svgText({ x: legendX + 20, y: rowY, text: `${wrapLabel(slice.category, 34, 1)[0]!} · ${share}%`, size: LABEL_SIZE, profile: context.profile }));
    rowY += rowHeight;
  }
  return `${svgOpen({ height: PIE_HEIGHT, label: `${context.labels.figure}: ${spec.title}` })}${parts.join("")}</svg>`;
}

export function renderChartSvg(spec: ChartFigureSpec, context: FigureRenderContext): string {
  switch (spec.kind) {
    case "bar":
      return spec.orientation === "horizontal" ? renderHorizontalBars(spec, context) : renderVerticalBars(spec, context);
    case "line":
      return renderLines(spec, context);
    case "pie":
      return renderPie(spec, context);
  }
}
