import type { ScriptProfile } from "../prompting/script.js";
import { extractPdfNamedDestinations } from "./pdfNamedDestinations.js";

export const DEFAULT_BOOK_PAGE_MARGIN_RULE = "margin: 20mm 18mm 22mm;";

export type BookPdfPagination = {
  targetPages: number;
  originalPages: number;
  actualPages: number;
  matched: boolean;
  /** Positive is more compact; zero is the unchanged house layout. */
  adjustment: number;
  renders: number;
};

/** Bounded typography, with the extra leading required by each script retained. */
export function bookPdfLayout(profile: ScriptProfile, adjustment: number) {
  if (!Number.isFinite(adjustment) || Math.abs(adjustment) > 1) throw new RangeError("Invalid PDF layout adjustment");
  const compact = adjustment >= 0;
  const amount = Math.abs(adjustment);
  const interpolate = (start: number, compactEnd: number, spaciousEnd: number) =>
    Math.round((start + ((compact ? compactEnd : spaciousEnd) - start) * amount) * 1000) / 1000;
  const topMarginMm = interpolate(20, 16, 24);
  return {
    topMarginPt: topMarginMm * 72 / 25.4,
    marginRule: `margin: ${topMarginMm}mm ${interpolate(18, 15, 21)}mm ${interpolate(22, 18, 26)}mm;`,
    fontSizePt: interpolate(11, 10, 12) * profile.fontSizeScale,
    lineHeight: interpolate(profile.lineHeight, profile.lineHeight - 0.35, profile.lineHeight + 0.2),
    paragraphSpaceEm: interpolate(1, 0.25, 1.3)
  };
}

export function bookPdfPaginationCss(css: string, profile: ScriptProfile, adjustment: number): string {
  if (adjustment === 0) return css;
  const layout = bookPdfLayout(profile, adjustment);
  // Replace the existing page rule. Appending a second @page makes Chromium
  // shrink covered books globally, including their fonts, to fit the cover.
  return css.replace(DEFAULT_BOOK_PAGE_MARGIN_RULE, layout.marginRule) + `
  body { font-size: ${layout.fontSizePt}pt; line-height: ${layout.lineHeight}; }
  body > p { margin-bottom: ${layout.paragraphSpaceEm}em; }
  body > table, body > blockquote { margin-bottom: ${layout.paragraphSpaceEm}em; }
`;
}

/**
 * Search rendered sheets, including the cover, Contents and Sources. Never cut
 * prose, resize the paper, append blank sheets or exceed the typography bounds.
 * Unreachable targets retain the nearest complete render and an explicit miss
 * in the diagnostic; an absent PDF measurement keeps the original render.
 */
export async function fitBookPdfPageCount<T extends { pdf: Buffer }>(
  targetPages: number | undefined,
  render: (adjustment: number) => Promise<T>
): Promise<{ rendered: T; pagination?: BookPdfPagination }> {
  if (targetPages !== undefined && (!Number.isSafeInteger(targetPages) || targetPages < 1)) {
    throw new RangeError("PDF target page count must be a positive integer");
  }
  const original = await render(0);
  if (targetPages === undefined) return { rendered: original };
  const originalPages = extractPdfNamedDestinations(original.pdf)?.pageCount;
  if (originalPages === undefined) return { rendered: original };
  let renders = 1;
  let best = { rendered: original, adjustment: 0, pages: originalPages };
  const result = () => ({
    rendered: best.rendered,
    pagination: {
      targetPages, originalPages, actualPages: best.pages, matched: best.pages === targetPages,
      adjustment: best.adjustment, renders
    }
  });
  if (originalPages === targetPages) return result();
  const direction = originalPages > targetPages ? 1 : -1;
  let low = 0;
  let high = 1;
  for (let attempt = 0; attempt < 9; attempt += 1) {
    const amount = attempt === 0 ? 1 : (low + high) / 2;
    const adjustment = amount * direction;
    const rendered = await render(adjustment);
    renders += 1;
    const pages = extractPdfNamedDestinations(rendered.pdf)?.pageCount;
    if (pages === undefined) break;
    const distance = Math.abs(pages - targetPages);
    const bestDistance = Math.abs(best.pages - targetPages);
    if (distance < bestDistance || (distance === bestDistance && Math.abs(adjustment) < Math.abs(best.adjustment))) {
      best = { rendered, adjustment, pages };
    }
    if (pages === targetPages) return result();
    const needsMore = direction === 1 ? pages > targetPages : pages < targetPages;
    if (needsMore) {
      if (attempt === 0) break; // Even the boundary cannot reach the target.
      low = amount;
    } else high = amount;
  }
  return result();
}
