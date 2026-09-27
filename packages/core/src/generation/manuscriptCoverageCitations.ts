type Citation = { pageIndex: number; quote: string };
type Page = { index: number; markdown: string };

/** A wrong coordinate is recoverable only for one unchanged, nontrivial source span. */
export function exactCoverageCitationResolver(pages: readonly Page[]): (citation: Citation) => Citation | undefined {
  return citation => {
    const atIndex = pages.filter(page => page.index === citation.pageIndex);
    if (atIndex.length > 1 || !citation.quote.trim()) return undefined;
    if (atIndex[0]?.markdown.includes(citation.quote)) return citation;
    if (citation.quote.trim().length < 12) return undefined;
    const matches = pages.filter(page => page.markdown.includes(citation.quote));
    const page = matches[0];
    if (matches.length !== 1 || !page || pages.filter(item => item.index === page.index).length !== 1) return undefined;
    const first = page.markdown.indexOf(citation.quote);
    return page.markdown.indexOf(citation.quote, first + 1) === -1 ? { ...citation, pageIndex: page.index } : undefined;
  };
}

/** Repair citation coordinates, never evidence substance. No fuzzy matching or model retry. */
export function coverageCitationResolver(pages: readonly Page[]): (citation: Citation) => Citation | undefined {
  const counts = new Map<number, number>();
  for (const page of pages) counts.set(page.index, (counts.get(page.index) ?? 0) + 1);
  const byIndex = new Map(pages.filter((page) => counts.get(page.index) === 1).map((page) => [page.index, page.markdown]));
  const exact = exactCoverageCitationResolver(pages);
  return (citation) => {
    const { quote, pageIndex } = citation;
    if (quote.trim().length < 12) {
      const context = shortDialogueContext(byIndex.get(pageIndex), quote);
      return context ? { pageIndex, quote: context } : undefined;
    }
    const resolved = exact(citation);
    if (resolved) return resolved;
    if (pages.some(page => page.markdown.includes(quote))) return undefined;
    // A reviewer sometimes wraps a partial dialogue quotation with its own closing mark.
    // Strip only one matching outer pair, preserve every interior byte, and require a
    // unique occurrence on the originally cited page. Never combine this with relocation.
    const pairs: Record<string, string> = { '"': '"', "“": "”", "‘": "’", "'": "'", "«": "»" };
    const markdown = byIndex.get(pageIndex);
    if (markdown === undefined) return undefined;
    if (pairs[quote[0]!] === quote.at(-1)) {
      const excerpt = quote.slice(1, -1);
      if (excerpt.trim().length < 12) return undefined;
      const offset = markdown.indexOf(excerpt);
      return offset >= 0 && markdown.indexOf(excerpt, offset + 1) === -1 ? { pageIndex, quote: excerpt } : undefined;
    }
    const original = recoverTranscriptionSpan(markdown, quote);
    return original === undefined ? undefined : { pageIndex, quote: original };
  };
}

/** Retain the entire source paragraph around a uniquely cited complete utterance.
 * Never relocate short quotes, invent speaker attribution, or omit surrounding negation. */
function shortDialogueContext(markdown: string | undefined, quote: string): string | undefined {
  const pairs: Record<string, string> = { '"': '"', "“": "”", "‘": "’", "'": "'", "«": "»", "「": "」", "『": "』" };
  if (!markdown || !quote || pairs[quote[0]!] !== quote.at(-1) ||
    !/[.!?؟。！？]$/u.test(quote.slice(1, -1)) || !/[\p{L}\p{N}]/u.test(quote)) return undefined;
  const start = markdown.indexOf(quote);
  if (start < 0 || markdown.indexOf(quote, start + 1) !== -1) return undefined;
  const paragraph = markdown.split(/\r?\n\s*\r?\n/u).find(text => text.includes(quote));
  if (!paragraph || paragraph.trim().length < 12 || paragraph.length > 700 ||
    !/[\p{L}\p{N}]/u.test(paragraph.replace(quote, ""))) return undefined;
  return paragraph;
}

/** Only whitespace runs and an uppercased clause start may differ. Keep all
 * interior case (names/acronyms), punctuation and words. Never relocate too. */
function recoverTranscriptionSpan(markdown: string, quote: string): string | undefined {
  const escaped = quote.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/gu, "\\s+");
  const pattern = /^[A-Z][a-z]/.test(escaped) ? `[${escaped[0]}${escaped[0]!.toLowerCase()}]${escaped.slice(1)}` : escaped;
  const word = /[\p{L}\p{M}\p{N}_]/u;
  let found: string | undefined;
  const matcher = new RegExp(pattern, "gu");
  let match: RegExpExecArray | null;
  while ((match = matcher.exec(markdown))) {
    // Count overlapping candidates too, without splitting a Unicode code point.
    matcher.lastIndex = match.index + String.fromCodePoint(markdown.codePointAt(match.index)!).length;
    const before = Array.from(markdown.slice(Math.max(0, match.index - 2), match.index)).at(-1) ?? "";
    const end = match.index + match[0].length;
    const after = Array.from(markdown.slice(end, end + 2))[0] ?? "";
    if ((word.test(match[0][0]!) && word.test(before)) || (word.test(match[0].at(-1)!) && word.test(after))) continue;
    if (found !== undefined) return undefined;
    found = match[0];
  }
  return found !== undefined && found.trim().length >= 12 ? found : undefined;
}
