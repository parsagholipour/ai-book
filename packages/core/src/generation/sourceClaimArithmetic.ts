import { numericStatementHolds } from "./arithmeticCheck.js";

/** A small closed grammar for mathematical sentences, never a general prose classifier.
 * Anything else (including attribution or empirical premises) stays in source review.
 */
function mathematicalSentence(text: string): string {
  return text.trim().replace(/[.;]$/, "").trim()
    .replace(/^In modular arithmetic,\s+/i, "")
    .replace(/^The notation\s+(.+)\s+records that relationship$/i, "$1")
    .replace(/^The statement\s+(.+)\s+is true$/i, "$1");
}

function mathBody(text: string): string {
  const trimmed = mathematicalSentence(text);
  for (const [open, close] of [["\\(", "\\)"], ["\\[", "\\]"], ["$$", "$$"], ["$", "$"], ["`", "`"]] as const) {
    if (trimmed.startsWith(open) && trimmed.endsWith(close)) return trimmed.slice(open.length, -close.length).trim();
  }
  return trimmed;
}

function normalizedCalculation(text: string): string {
  return mathBody(text).replace(/−/g, "-")
    .replace(/\(\s*mod\s+(\d+)\s*\)\s*$/g, "\\pmod{$1}")
    .replace(/\bmod\s+(\d+)\b/g, "\\bmod{$1}");
}

/** A provable numeric quote is exempt only when every occurrence is itself a mathematical
 * sentence. A short fragment of an attributed assertion must not erase that assertion.
 */
export function isDerivedArithmeticClaim(quote: string, markdown: string): boolean {
  if (!numericStatementHolds(normalizedCalculation(quote))) return false;
  let at = markdown.indexOf(quote);
  if (at < 0) return false;
  while (at >= 0) {
    // Keep the entire containing sentence, including quote marks, blockquote/citation markers,
    // units and attribution. Decimal punctuation is not a sentence boundary.
    const before = markdown.slice(0, at);
    const after = markdown.slice(at + quote.length);
    const leftBoundary = [...before.matchAll(/[.!?](?=\s|$)|\n[ \t]*\n/g)].at(-1);
    const start = leftBoundary ? leftBoundary.index + leftBoundary[0].length : 0;
    const rightBoundary = /[.!?](?=\s|$)|\n[ \t]*\n/.exec(after);
    const quoteEndsSentence = /[.!?]$/.test(quote) && /^(?:\s|$)/.test(after);
    const end = quoteEndsSentence ? at + quote.length : rightBoundary ? at + quote.length + rightBoundary.index + (rightBoundary[0].startsWith("\n") ? 0 : 1) : markdown.length;
    // A blank line does not release a quoted calculation from its introduction or attribution.
    // Keep all colon introductions, even a mathematical one, rather than classify their prose.
    if (markdown.slice(0, start).trimEnd().endsWith(":")) return false;
    if (/^\s*(?:—|--|>\s*[—-]|\[\d+\])/.test(markdown.slice(end))) return false;
    const sentence = markdown.slice(start, end);
    if (!numericStatementHolds(normalizedCalculation(sentence))) return false;
    at = markdown.indexOf(quote, at + quote.length);
  }
  return true;
}
