/** Recover only explicitly quoted, uniquely located fragments in reading order.
 * The result is copied from the cited page, including everything between them.
 * No fuzzy matching, changed words, reordered fragments or cross-page search. */
export function pictureBookExactQuote(markdown: string, citation: string): string | undefined {
  if (markdown.includes(citation)) return citation;
  const fragments = [...citation.matchAll(/“([^“”]+)”|"([^"“”]+)"/gu)];
  if (fragments.length === 1 && fragments[0]![0] === citation) {
    const fragment = fragments[0]![1] ?? fragments[0]![2]!;
    const offset = markdown.indexOf(fragment);
    if (fragment.trim().length >= 12 && offset >= 0 && markdown.indexOf(fragment, offset + 1) < 0) return markdown.slice(offset, offset + fragment.length);
  }
  if (fragments.length < 2 || fragments.length > 3) return undefined;
  let consumed = 0, start = -1, end = -1;
  for (const [index, match] of fragments.entries()) {
    const between = citation.slice(consumed, match.index);
    // These separators assert only textual order, never a new causal claim.
    if (index === 0 ? between.trim() !== "" : !/^\s*(?:[,;]?\s*(?:Later|Then|later|then)[,:]?|…|\.{3}|[,;])?\s*$/u.test(between)) return undefined;
    const fragment = match[1] ?? match[2]!;
    if (fragment.trim().length < 12) return undefined;
    const offset = markdown.indexOf(fragment);
    if (offset < 0 || markdown.indexOf(fragment, offset + 1) !== -1 || offset < end) return undefined;
    if (start < 0) start = offset;
    end = offset + fragment.length;
    consumed = match.index! + match[0].length;
  }
  if (citation.slice(consumed).trim() || end - start > 700) return undefined;
  return markdown.slice(start, end);
}
