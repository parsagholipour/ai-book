import type { ScriptProfile } from "../../prompting/script.js";

/**
 * What every figure renderer shares: the ink and series palette, number and
 * text helpers, and the one rule about text direction.
 *
 * The four series colours are the dataviz skill's reference palette in an
 * order validated against a white page (`validate_palette.js`: adjacent CVD
 * ΔE 9.2, normal-vision 27.6, aqua under 3:1 contrast so every series is also
 * named in a legend). Text never wears a series colour.
 */

export const FIGURE_SERIES_COLORS = ["#2a78d6", "#eb6834", "#1baf7a", "#4a3aa7"] as const;

/** Dash patterns as the second channel for line charts, so a grayscale print still separates the series. */
export const FIGURE_LINE_DASHES = ["", "7 4", "2 3", "9 3 2 3"] as const;

export const FIGURE_INK = {
  primary: "#0b0b0b",
  secondary: "#52514e",
  muted: "#898781",
  grid: "#e1e0d9",
  axis: "#c3c2b7",
  surface: "#ffffff"
} as const;

/** The display face the PDF embeds under this family name; readers without it fall through to a sans. */
export const FIGURE_FONT_FAMILY = "InterBook, 'Segoe UI', system-ui, sans-serif";

export const FIGURE_WIDTH = 640;

export type FigureRenderContext = {
  profile: ScriptProfile;
  labels: { figure: string; source: string };
};

export function escapeXml(text: string): string {
  return text.replace(/[&<>"']/g, (character) => {
    switch (character) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case '"':
        return "&quot;";
      default:
        return "&#39;";
    }
  });
}

/** ASCII digits rewritten in the script's own, when it has them in everyday use. */
export function localizeDigits(text: string, numerals: string | null): string {
  if (!numerals || numerals.length < 10) return text;
  return text.replace(/[0-9]/g, (digit) => numerals[digit.charCodeAt(0) - 48] ?? digit);
}

export function formatFigureNumber(value: number, profile: ScriptProfile): string {
  let text: string;
  try {
    text = new Intl.NumberFormat(profile.code, { maximumFractionDigits: 2 }).format(value);
  } catch {
    text = new Intl.NumberFormat("en", { maximumFractionDigits: 2 }).format(value);
  }
  return localizeDigits(text, profile.numerals);
}

/** A tick past ten thousand in compact notation (10K, 1M), so a large axis keeps a narrow margin. */
export function formatTickNumber(value: number, profile: ScriptProfile): string {
  if (Math.abs(value) < 10_000) return formatFigureNumber(value, profile);
  let text: string;
  try {
    text = new Intl.NumberFormat(profile.code, { notation: "compact", maximumFractionDigits: 1 }).format(value);
  } catch {
    text = new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 }).format(value);
  }
  return localizeDigits(text, profile.numerals);
}

/** Round tick values covering [min, max], about `count` of them; a flat domain is widened by one unit. */
export function niceTicks(min: number, max: number, count = 5): number[] {
  let low = Math.min(min, max);
  let high = Math.max(min, max);
  if (!Number.isFinite(low) || !Number.isFinite(high)) return [0, 1];
  if (high === low) {
    high = low + Math.max(1, Math.abs(low) || 1);
  }
  const rawStep = (high - low) / Math.max(1, count - 1);
  const magnitude = 10 ** Math.floor(Math.log10(rawStep));
  const residual = rawStep / magnitude;
  const step = (residual >= 7 ? 10 : residual >= 3 ? 5 : residual >= 1.5 ? 2 : 1) * magnitude;
  const start = Math.floor(low / step) * step;
  const end = Math.ceil(high / step) * step;
  const ticks: number[] = [];
  for (let value = start; value <= end + step / 2; value += step) {
    ticks.push(Number(value.toFixed(10)));
  }
  return ticks;
}

const WIDE_CHARACTER = /[\u1100-\u11ff\u2e80-\ua4cf\uac00-\ud7af\uf900-\ufaff\ufe30-\ufe4f\uff00-\uffef]/;

/** A width estimate in viewBox units; the renderer has no font metrics, so this errs wide. */
export function estimateTextWidth(text: string, fontSize: number): number {
  let width = 0;
  for (const character of text) {
    width += WIDE_CHARACTER.test(character) ? 1 : 0.58;
  }
  return width * fontSize;
}

/** Greedy word wrap; a run longer than a line is broken, and lines past the cap fold into the last one with an ellipsis. */
export function wrapLabel(text: string, maxChars: number, maxLines: number): string[] {
  const words = text.replace(/\s+/g, " ").trim().split(" ").filter(Boolean);
  const lines: string[] = [];
  let current = "";
  const push = (line: string) => {
    if (line) lines.push(line);
  };
  for (const word of words) {
    let remaining = word;
    // Only a word far longer than the line is broken: "Reachability" on a
    // 11-character line overflows a little, which reads; "Reachabilit y" does not.
    while (remaining.length > maxChars + 6) {
      push(current);
      current = "";
      lines.push(remaining.slice(0, maxChars));
      remaining = remaining.slice(maxChars);
    }
    const candidate = current ? `${current} ${remaining}` : remaining;
    if (candidate.length <= maxChars) {
      current = candidate;
    } else {
      push(current);
      current = remaining;
    }
  }
  push(current);
  if (lines.length > maxLines) {
    const kept = lines.slice(0, maxLines - 1);
    const rest = lines.slice(maxLines - 1).join(" ");
    kept.push(`${rest.slice(0, Math.max(1, maxChars - 1))}…`);
    return kept;
  }
  return lines.length > 0 ? lines : [""];
}

export type TextAlign = "left" | "middle" | "right";

/**
 * One `<text>` element with a physical alignment. Geometry stays left-to-right
 * in every script; only the run inside the element is right-to-left, and in
 * SVG `text-anchor` follows the run's direction, so a physical alignment has
 * to be translated for a right-to-left profile.
 */
export function svgText(options: {
  x: number;
  y: number;
  text: string;
  size: number;
  profile: ScriptProfile;
  align?: TextAlign;
  fill?: string;
  weight?: "normal" | "bold";
  attributes?: string;
}): string {
  const rtl = options.profile.direction === "rtl";
  const align = options.align ?? "left";
  const anchor = align === "middle" ? "middle" : (align === "left") !== rtl ? "start" : "end";
  const direction = rtl ? ' direction="rtl" unicode-bidi="embed"' : "";
  const weight = options.weight === "bold" ? ' font-weight="600"' : "";
  return `<text x="${round(options.x)}" y="${round(options.y)}" font-size="${options.size}" fill="${options.fill ?? FIGURE_INK.secondary}" text-anchor="${anchor}"${direction}${weight}${options.attributes ?? ""}>${escapeXml(options.text)}</text>`;
}

export function round(value: number): string {
  return (Math.round(value * 100) / 100).toString();
}

export function svgOpen(options: { height: number; label: string }): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${FIGURE_WIDTH} ${round(options.height)}" role="img" aria-label="${escapeXml(options.label)}" font-family="${escapeXml(FIGURE_FONT_FAMILY)}" style="display:block;width:100%;height:auto">`;
}
