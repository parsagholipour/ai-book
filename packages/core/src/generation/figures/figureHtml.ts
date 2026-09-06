import { scriptProfileForLanguage } from "../../prompting/script.js";
import { markdownLabels } from "../markdownLabels.js";
import { findFigureFences } from "./figureBlocks.js";
import type { FigureSpec } from "./figureSpec.js";
import { renderChartSvg } from "./figureSvgCharts.js";
import { renderFlowSvg } from "./figureSvgFlow.js";
import { FIGURE_INK, escapeXml, type FigureRenderContext } from "./figureSvgShared.js";

/**
 * Where a figure block becomes something a reader sees. Both exporters call
 * `expandFigureFences` on the markdown they are about to render — the PDF
 * after the page-anchor markers are in and before the font subset is cut, the
 * EPUB before its own marked pass — so the manuscript and `book.md` keep the
 * portable fenced form and only the render carries markup. Inline styles
 * only: `BOOK_PDF_CSS` is fingerprinted, and nothing here may move a page
 * break in a book that has no figure.
 */

export function figureRenderContext(language: string | undefined): FigureRenderContext {
  const labels = markdownLabels(language);
  return { profile: scriptProfileForLanguage(language), labels: { figure: labels.figure, source: labels.source } };
}

export function figureSvg(spec: FigureSpec, context: FigureRenderContext): string {
  return spec.kind === "flow" ? renderFlowSvg(spec, context) : renderChartSvg(spec, context);
}

function withPeriod(text: string): string {
  const trimmed = text.trim();
  return /[.!?…؟。:;]$/u.test(trimmed) ? trimmed : `${trimmed}.`;
}

/**
 * The caption's three pieces, as sentences: the title, the optional caption and
 * the source line. Both the HTML figure and the Word export print exactly these
 * words, so the two renderers cannot drift apart on a period or a label.
 */
export function figureCaptionText(
  spec: FigureSpec,
  context: FigureRenderContext
): { title: string; caption: string | undefined; sourceLine: string } {
  const caption = spec.caption?.trim();
  return {
    title: withPeriod(spec.title),
    caption: caption ? withPeriod(caption) : undefined,
    sourceLine: `${context.labels.source}: ${withPeriod(spec.source)}`
  };
}

export function figureHtml(spec: FigureSpec, context: FigureRenderContext): string {
  const direction = context.profile.direction === "rtl" ? ' dir="rtl"' : "";
  const text = figureCaptionText(spec, context);
  const captionHtml = `<strong style="color:${FIGURE_INK.primary}">${escapeXml(text.title)}</strong>${text.caption ? ` ${escapeXml(text.caption)}` : ""} ${escapeXml(text.sourceLine)}`;
  return [
    `<figure class="book-figure" style="margin:1.4em 0;break-inside:avoid;page-break-inside:avoid"${direction}>`,
    figureSvg(spec, context),
    `<figcaption style="font-size:0.85em;line-height:1.35;margin-top:0.5em;color:${FIGURE_INK.secondary}">${captionHtml}</figcaption>`,
    "</figure>"
  ].join("\n");
}

/**
 * Every readable figure block replaced by its markup, every unreadable one
 * removed with the blank line that followed it; markdown with no block comes
 * back byte for byte. Never throws: a figure the renderer cannot draw is a
 * missing figure, not a failed compile.
 */
export function expandFigureFences(markdown: string, options: { language?: string | undefined } = {}): string {
  const fences = findFigureFences(markdown);
  if (fences.length === 0) return markdown;
  const context = figureRenderContext(options.language);
  let cursor = 0;
  let out = "";
  for (const fence of fences) {
    let html = "";
    if (fence.spec) {
      try {
        html = figureHtml(fence.spec, context);
      } catch {
        html = "";
      }
    }
    out += markdown.slice(cursor, fence.start) + html;
    cursor = fence.end;
    if (!html) {
      // Take the block's own trailing blank line with it, and nothing else.
      const trailing = markdown.slice(cursor).match(/^\n\n?/);
      if (trailing) cursor += trailing[0].length;
    }
  }
  out += markdown.slice(cursor);
  return out;
}
