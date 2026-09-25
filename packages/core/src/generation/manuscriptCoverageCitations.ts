type Citation = { pageIndex: number; quote: string };
type Page = { index: number; markdown: string };

/** Repair citation coordinates, never evidence substance. No fuzzy matching or model retry. */
export function coverageCitationResolver(pages: readonly Page[]): (citation: Citation) => Citation | undefined {
  const counts = new Map<number, number>();
  for (const page of pages) counts.set(page.index, (counts.get(page.index) ?? 0) + 1);
  const byIndex = new Map(pages.filter((page) => counts.get(page.index) === 1).map((page) => [page.index, page.markdown]));
  return (citation) => {
    const { quote, pageIndex } = citation;
    if (quote.trim().length < 12) return undefined;
    if (byIndex.get(pageIndex)?.includes(quote)) return citation;
    const exactPages = pages.filter((page) => page.markdown.includes(quote));
    if (exactPages.length) return exactPages.length === 1 && counts.get(exactPages[0]!.index) === 1
      ? { pageIndex: exactPages[0]!.index, quote } : undefined;
    // A reviewer sometimes wraps a partial dialogue quotation with its own closing mark.
    // Strip only one matching outer pair, preserve every interior byte, and require a
    // unique occurrence on the originally cited page. Never combine this with relocation.
    const pairs: Record<string, string> = { '"': '"', "“": "”", "‘": "’", "'": "'", "«": "»" };
    if (pairs[quote[0]!] !== quote.at(-1)) return undefined;
    const excerpt = quote.slice(1, -1);
    if (excerpt.trim().length < 12) return undefined;
    const markdown = byIndex.get(pageIndex);
    const offset = markdown?.indexOf(excerpt) ?? -1;
    return offset >= 0 && markdown!.indexOf(excerpt, offset + 1) === -1 ? { pageIndex, quote: excerpt } : undefined;
  };
}
