type Page = { index: number; markdown: string };
export type CoverageCitationSourceSpan = { id: string; pageIndex: number; quote: string };

/** Selection coordinates, not an evidence verdict. The model must still confirm
 * the same passage, actor and claim against the complete, unchanged source page. */
export function coverageCitationSourceSpans(pages: readonly Page[]): CoverageCitationSourceSpan[] {
  const spans: CoverageCitationSourceSpan[] = [];
  const segmenter = new Intl.Segmenter(undefined, { granularity: "sentence" });
  for (const page of pages) {
    for (const { segment, index } of segmenter.segment(page.markdown)) {
      const quote = segment.trim();
      if (quote.length < 12 || quote.length > 700) continue;
      const start = index + segment.indexOf(quote);
      spans.push({ id: `page-${page.index}:${start}-${start + quote.length}`, pageIndex: page.index, quote });
      // Raw pages remain complete. A large catalog falls back to the existing
      // exact-quote correction contract, never truncated manuscript evidence.
      if (spans.length > 64) return [];
    }
  }
  return spans;
}
