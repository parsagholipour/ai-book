import { useId, useMemo, useRef, useState } from "react";
import { Button } from "../shared/Button.js";
import { count, shortDate, usdShort } from "./format.js";
import type { NamedTotal } from "./types.js";

/**
 * Hand-rolled SVG charts — no charting dependency.
 *
 * Two rules from the house data-viz method are load-bearing here and easy to
 * undo by accident:
 *
 * - **One value axis, never two.** Cash collected spikes to ~$70 on a purchase
 *   day while provider spend sits under a dollar; putting both on one plot with
 *   two scales would invent a correlation. Measures of different magnitude get
 *   their own chart instead.
 * - **A tooltip may enhance a value but never gate it.** Every chart here has a
 *   table view holding the same numbers, and the crosshair is keyboard-driveable
 *   with the arrow keys, so hover is never the only way in.
 */

/** Categorical slots 1 and 2, validated against this console's cream surface. */
export const SERIES_COLORS = ["#2a78d6", "#eb6834"] as const;
const GRID = "#e1e0d9";
const AXIS_TEXT = "#898781";
const CRITICAL = "#d03b3b";

type Padding = { top: number; right: number; bottom: number; left: number };
const PAD: Padding = { top: 12, right: 16, bottom: 28, left: 48 };

export type LineSeries = { key: string; label: string; color: string; values: number[] };

/**
 * Round numbers a reader can do arithmetic with, and always at least one step
 * so an all-zero window still draws an axis instead of collapsing.
 */
function niceTicks(max: number, steps = 4): number[] {
  if (!Number.isFinite(max) || max <= 0) {
    return [0, 1];
  }
  const rough = max / steps;
  const magnitude = 10 ** Math.floor(Math.log10(rough));
  const step = [1, 2, 2.5, 5, 10].map((multiple) => multiple * magnitude).find((candidate) => candidate >= rough) ?? magnitude * 10;
  const ticks: number[] = [];
  for (let value = 0; value <= max + step * 0.001; value += step) {
    ticks.push(Math.round(value * 1e6) / 1e6);
  }
  return ticks.length > 1 ? ticks : [0, step];
}

function useCrosshair(length: number) {
  const [hovered, setHovered] = useState<number | null>(null);
  const clamp = (index: number) => Math.max(0, Math.min(length - 1, index));
  return {
    hovered,
    setHovered,
    onKeyDown: (event: React.KeyboardEvent) => {
      if (event.key === "ArrowRight" || event.key === "ArrowLeft") {
        event.preventDefault();
        setHovered((current) => clamp((current ?? 0) + (event.key === "ArrowRight" ? 1 : -1)));
      } else if (event.key === "Escape") {
        setHovered(null);
      }
    }
  };
}

export function TimeChart(props: {
  title: string;
  subtitle?: string;
  dates: string[];
  series: LineSeries[];
  format?: (value: number) => string;
  height?: number;
}) {
  const format = props.format ?? usdShort;
  const height = props.height ?? 200;
  const width = 720;
  const plotWidth = width - PAD.left - PAD.right;
  const plotHeight = height - PAD.top - PAD.bottom;
  const crosshair = useCrosshair(props.dates.length);
  const [showTable, setShowTable] = useState(false);
  const svgRef = useRef<SVGSVGElement | null>(null);
  const titleId = useId();

  const maxValue = Math.max(0, ...props.series.flatMap((series) => series.values));
  const ticks = useMemo(() => niceTicks(maxValue), [maxValue]);
  const axisMax = ticks[ticks.length - 1]!;
  const xAt = (index: number) =>
    PAD.left + (props.dates.length <= 1 ? plotWidth / 2 : (index / (props.dates.length - 1)) * plotWidth);
  const yAt = (value: number) => PAD.top + plotHeight - (value / axisMax) * plotHeight;

  if (props.dates.length === 0) {
    return <ChartFrame title={props.title} subtitle={props.subtitle}>{emptyNote}</ChartFrame>;
  }

  return (
    <ChartFrame
      title={props.title}
      subtitle={props.subtitle}
      legend={props.series.length > 1 ? props.series : undefined}
      onToggleTable={() => setShowTable((current) => !current)}
      showTable={showTable}
    >
      {showTable ? (
        <SeriesTable dates={props.dates} series={props.series} format={format} />
      ) : (
        <div className="chart-plot">
          <svg
            ref={svgRef}
            viewBox={`0 0 ${width} ${height}`}
            className="chart-svg"
            role="img"
            aria-labelledby={titleId}
            tabIndex={0}
            onKeyDown={crosshair.onKeyDown}
            onMouseLeave={() => crosshair.setHovered(null)}
            onMouseMove={(event) => {
              const bounds = svgRef.current?.getBoundingClientRect();
              if (!bounds) return;
              const ratio = ((event.clientX - bounds.left) / bounds.width) * width;
              const step = props.dates.length <= 1 ? plotWidth : plotWidth / (props.dates.length - 1);
              crosshair.setHovered(
                Math.max(0, Math.min(props.dates.length - 1, Math.round((ratio - PAD.left) / step)))
              );
            }}
          >
            <title id={titleId}>{props.title}</title>
            {ticks.map((tick) => (
              <g key={tick}>
                <line x1={PAD.left} x2={width - PAD.right} y1={yAt(tick)} y2={yAt(tick)} stroke={GRID} strokeWidth={1} />
                <text x={PAD.left - 8} y={yAt(tick) + 4} textAnchor="end" fontSize={11} fill={AXIS_TEXT}>
                  {format(tick)}
                </text>
              </g>
            ))}
            {xTickIndexes(props.dates.length).map((index) => (
              <text key={index} x={xAt(index)} y={height - 8} textAnchor="middle" fontSize={11} fill={AXIS_TEXT}>
                {shortDate(props.dates[index]!)}
              </text>
            ))}
            {crosshair.hovered !== null ? (
              <line
                x1={xAt(crosshair.hovered)}
                x2={xAt(crosshair.hovered)}
                y1={PAD.top}
                y2={PAD.top + plotHeight}
                stroke={AXIS_TEXT}
                strokeWidth={1}
              />
            ) : null}
            {props.series.map((series) => (
              <polyline
                key={series.key}
                fill="none"
                stroke={series.color}
                strokeWidth={2}
                strokeLinejoin="round"
                strokeLinecap="round"
                points={series.values.map((value, index) => `${xAt(index)},${yAt(value)}`).join(" ")}
              />
            ))}
            {crosshair.hovered !== null
              ? props.series.map((series) => (
                  <circle
                    key={series.key}
                    cx={xAt(crosshair.hovered!)}
                    cy={yAt(series.values[crosshair.hovered!] ?? 0)}
                    r={4}
                    fill={series.color}
                    stroke="#fffdf8"
                    strokeWidth={2}
                  />
                ))
              : null}
          </svg>
          {crosshair.hovered !== null ? (
            <ChartTooltip
              leftPercent={(xAt(crosshair.hovered) / width) * 100}
              heading={shortDate(props.dates[crosshair.hovered]!)}
              rows={props.series.map((series) => ({
                color: series.color,
                label: series.label,
                value: format(series.values[crosshair.hovered!] ?? 0)
              }))}
            />
          ) : null}
        </div>
      )}
    </ChartFrame>
  );
}

export function ColumnChart(props: {
  title: string;
  subtitle?: string;
  dates: string[];
  values: number[];
  color?: string;
  format?: (value: number) => string;
  height?: number;
}) {
  const format = props.format ?? usdShort;
  const color = props.color ?? SERIES_COLORS[0];
  const height = props.height ?? 160;
  const width = 720;
  const plotWidth = width - PAD.left - PAD.right;
  const plotHeight = height - PAD.top - PAD.bottom;
  const crosshair = useCrosshair(props.dates.length);
  const [showTable, setShowTable] = useState(false);
  const titleId = useId();

  const ticks = useMemo(() => niceTicks(Math.max(0, ...props.values)), [props.values]);
  const axisMax = ticks[ticks.length - 1]!;
  const slot = plotWidth / Math.max(1, props.dates.length);
  // Cap the bar and let the slot's leftover be air; the 2px surface gap between
  // neighbours is what separates them, never a stroke.
  const barWidth = Math.max(2, Math.min(24, slot - 2));

  if (props.dates.length === 0) {
    return <ChartFrame title={props.title} subtitle={props.subtitle}>{emptyNote}</ChartFrame>;
  }

  return (
    <ChartFrame
      title={props.title}
      subtitle={props.subtitle}
      onToggleTable={() => setShowTable((current) => !current)}
      showTable={showTable}
    >
      {showTable ? (
        <SeriesTable
          dates={props.dates}
          series={[{ key: "value", label: props.title, color, values: props.values }]}
          format={format}
        />
      ) : (
        <div className="chart-plot">
          <svg
            viewBox={`0 0 ${width} ${height}`}
            className="chart-svg"
            role="img"
            aria-labelledby={titleId}
            tabIndex={0}
            onKeyDown={crosshair.onKeyDown}
            onMouseLeave={() => crosshair.setHovered(null)}
          >
            <title id={titleId}>{props.title}</title>
            {ticks.map((tick) => (
              <g key={tick}>
                <line
                  x1={PAD.left}
                  x2={width - PAD.right}
                  y1={PAD.top + plotHeight - (tick / axisMax) * plotHeight}
                  y2={PAD.top + plotHeight - (tick / axisMax) * plotHeight}
                  stroke={GRID}
                  strokeWidth={1}
                />
                <text
                  x={PAD.left - 8}
                  y={PAD.top + plotHeight - (tick / axisMax) * plotHeight + 4}
                  textAnchor="end"
                  fontSize={11}
                  fill={AXIS_TEXT}
                >
                  {format(tick)}
                </text>
              </g>
            ))}
            {props.values.map((value, index) => {
              const barHeight = axisMax > 0 ? (value / axisMax) * plotHeight : 0;
              const x = PAD.left + index * slot + (slot - barWidth) / 2;
              return (
                <g key={props.dates[index]}>
                  {/* A hit target wider than the bar, so a 2px column is still hoverable. */}
                  <rect
                    x={PAD.left + index * slot}
                    y={PAD.top}
                    width={slot}
                    height={plotHeight}
                    fill="transparent"
                    onMouseEnter={() => crosshair.setHovered(index)}
                  />
                  {value > 0 ? (
                    <rect
                      x={x}
                      y={PAD.top + plotHeight - barHeight}
                      width={barWidth}
                      height={barHeight}
                      rx={Math.min(4, barWidth / 2)}
                      fill={color}
                      opacity={crosshair.hovered === null || crosshair.hovered === index ? 1 : 0.45}
                      pointerEvents="none"
                    />
                  ) : null}
                </g>
              );
            })}
            {xTickIndexes(props.dates.length).map((index) => (
              <text key={index} x={PAD.left + index * slot + slot / 2} y={height - 8} textAnchor="middle" fontSize={11} fill={AXIS_TEXT}>
                {shortDate(props.dates[index]!)}
              </text>
            ))}
          </svg>
          {crosshair.hovered !== null ? (
            <ChartTooltip
              leftPercent={((PAD.left + crosshair.hovered * slot + slot / 2) / width) * 100}
              heading={shortDate(props.dates[crosshair.hovered]!)}
              rows={[{ color, label: props.title, value: format(props.values[crosshair.hovered] ?? 0) }]}
            />
          ) : null}
        </div>
      )}
    </ChartFrame>
  );
}

/**
 * Horizontal bars for nominal categories.
 *
 * One colour for every bar on purpose: shading by size would double-encode the
 * length the bar already shows and burn the only free channel.
 */
export function BreakdownBars(props: {
  title: string;
  subtitle?: string;
  rows: NamedTotal[];
  format?: (value: number) => string;
  secondaryLabel?: string;
  /** Renders the secondary count as a failure marker rather than a plain tally. */
  secondaryIsFailure?: boolean;
  emptyLabel?: string;
}) {
  const format = props.format ?? count;
  const max = Math.max(0, ...props.rows.map((row) => row.value));

  return (
    <section className="work-section">
      <div className="section-title">
        <h3>{props.title}</h3>
      </div>
      {props.subtitle ? <p className="muted chart-subtitle">{props.subtitle}</p> : null}
      {props.rows.length === 0 ? (
        <p className="muted">{props.emptyLabel ?? "Nothing in this window."}</p>
      ) : (
        <ul className="breakdown-rows">
          {props.rows.map((row) => (
            <li key={row.key}>
              <div className="breakdown-head">
                <span className="breakdown-label" title={row.label}>
                  {row.label}
                </span>
                <span className="breakdown-value">
                  {format(row.value)}
                  {typeof row.secondary === "number" && row.secondary > 0 ? (
                    <em className={props.secondaryIsFailure ? "breakdown-fail" : "breakdown-note"}>
                      {props.secondaryIsFailure
                        ? `${row.secondary} failed`
                        : `${row.secondary}${props.secondaryLabel ? ` ${props.secondaryLabel}` : ""}`}
                    </em>
                  ) : null}
                </span>
              </div>
              <div className="breakdown-track">
                <span
                  className="breakdown-fill"
                  style={{
                    width: `${max > 0 ? Math.max(1, (row.value / max) * 100) : 0}%`,
                    background:
                      props.secondaryIsFailure && (row.secondary ?? 0) > 0 ? CRITICAL : SERIES_COLORS[0]
                  }}
                />
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function ChartFrame(props: {
  title: string;
  subtitle?: string | undefined;
  legend?: LineSeries[] | undefined;
  showTable?: boolean;
  onToggleTable?: (() => void) | undefined;
  children: React.ReactNode;
}) {
  return (
    <section className="work-section chart-card">
      <div className="section-title">
        <h3>{props.title}</h3>
        {props.onToggleTable ? (
          <Button className="chart-table-toggle" size="sm" onClick={props.onToggleTable}>
            {props.showTable ? "Chart" : "Table"}
          </Button>
        ) : null}
      </div>
      {props.subtitle ? <p className="muted chart-subtitle">{props.subtitle}</p> : null}
      {props.legend ? (
        <ul className="chart-legend">
          {props.legend.map((series) => (
            <li key={series.key}>
              <span className="chart-swatch" style={{ background: series.color }} aria-hidden />
              {series.label}
            </li>
          ))}
        </ul>
      ) : null}
      {props.children}
    </section>
  );
}

function ChartTooltip(props: {
  leftPercent: number;
  heading: string;
  rows: Array<{ color: string; label: string; value: string }>;
}) {
  return (
    <div
      className="chart-tooltip"
      style={{ left: `${Math.min(88, Math.max(4, props.leftPercent))}%` }}
      role="status"
      aria-live="polite"
    >
      <strong>{props.heading}</strong>
      {props.rows.map((row) => (
        <span key={row.label}>
          <span className="chart-swatch" style={{ background: row.color }} aria-hidden />
          {row.label}
          <b>{row.value}</b>
        </span>
      ))}
    </div>
  );
}

function SeriesTable(props: { dates: string[]; series: LineSeries[]; format: (value: number) => string }) {
  return (
    <div className="admin-table-scroll">
      <table className="admin-table">
        <thead>
          <tr>
            <th>Date</th>
            {props.series.map((series) => (
              <th key={series.key}>{series.label}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {props.dates.map((date, index) => (
            <tr key={date}>
              <td>{shortDate(date)}</td>
              {props.series.map((series) => (
                <td key={series.key} className="numeric">
                  {props.format(series.values[index] ?? 0)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** At most six x labels, always including the first and last day. */
function xTickIndexes(length: number): number[] {
  if (length <= 1) {
    return length === 1 ? [0] : [];
  }
  const wanted = Math.min(6, length);
  const step = (length - 1) / (wanted - 1);
  return [...new Set(Array.from({ length: wanted }, (_, index) => Math.round(index * step)))];
}

const emptyNote = <p className="muted">No activity in this window.</p>;
