/**
 * A clipped plain-text summary of markdown. This is not a Zod schema and not
 * generation; it sits between `schemas/` and `generation/` so `normalizePageDraft`
 * in `book.ts` can clip without importing figures, and `pageDraftSummary` can
 * import the clip without a cycle.
 */
export function summaryFromMarkdown(markdown: string | undefined): string {
  if (!markdown) {
    return "";
  }

  const plain = markdown
    .replace(/!\[[^\]]*]\([^)]+\)/g, "")
    .replace(/\[([^\]]+)]\([^)]+\)/g, "$1")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/[*_`>#]/g, "")
    .replace(/\s+/g, " ")
    .trim();

  if (plain.length <= 240) {
    return plain;
  }

  const clipped = plain.slice(0, 240);
  const lastSpace = clipped.lastIndexOf(" ");
  const end = lastSpace > 160 ? lastSpace : 240;
  return `${clipped.slice(0, end).trim()}...`;
}
