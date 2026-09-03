/**
 * The quote guard: every quoted span of `MIN_QUOTE_WORDS` or more words in a
 * chapter is checked, model-free, against the folded text of the chapter's
 * dossier. The check is a substring test after folding (NFKC, case, quotes,
 * dashes, whitespace), with `…`/`...` inside a quotation treated as a break
 * between segments that each have to match.
 *
 * What the guard does with a miss is deliberately narrow: a span that names a
 * dossier document in its own paragraph and is not in that document loses its
 * quotation marks (it becomes paraphrase); every other miss is counted and
 * left, because under the creative contract the writer may quote from its own
 * knowledge — a famous line, a motto — and stripping those would be a veto on
 * shipped prose that no replay has approved (Parsa's 99% rule).
 */

export const MIN_QUOTE_WORDS = 8;

export type QuotedSpan = {
  text: string;
  words: number;
  /** Byte offsets of the span including its marks. */
  start: number;
  end: number;
  verbatim: boolean;
  /** Which dossier document the paragraph names, when one is named. */
  attributedTo?: string | undefined;
};

export type QuoteProvenanceReport = {
  spans: QuotedSpan[];
  checked: number;
  verbatim: number;
  /** Misses whose paragraph names a dossier document. */
  misattributed: number;
};

const OPENERS = "“\"«„";
const CLOSERS = "”\"»“";

export function foldQuoteText(text: string): string {
  return text
    .normalize("NFKD")
    // Diacritics dropped: a writer's "Temujin" is the document's "Temüjin".
    .replace(/[\u0300-\u036f]/g, "")
    // Zero-width and soft-hyphen characters: Wikisource text carries them
    // between words, and they broke every anchor that crossed one.
    .replace(/[\u200B-\u200D\u2060\uFEFF\u00AD]/g, "")
    .toLowerCase()
    .replace(/[‘’‚‛`´]/g, "'")
    .replace(/[“”„‟«»]/g, '"')
    .replace(/[‐-―−]/g, "-")
    .replace(/[ \s]+/g, " ")
    .replace(/[.,;:!?'"()[\]-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function countWords(text: string): number {
  return text.split(/\s+/).filter(Boolean).length;
}

/** Quoted spans of at least `minWords` words, in document order. */
export function quotedSpans(markdown: string, minWords: number = MIN_QUOTE_WORDS): Array<Pick<QuotedSpan, "text" | "words" | "start" | "end">> {
  const spans: Array<Pick<QuotedSpan, "text" | "words" | "start" | "end">> = [];
  const pattern = new RegExp(`[${OPENERS}]([^${OPENERS}${CLOSERS}]{20,2000}?)[${CLOSERS}]`, "g");
  for (const match of markdown.matchAll(pattern)) {
    const inner = match[1]!;
    const words = countWords(inner);
    if (words < minWords) continue;
    // A span that runs across a paragraph break is two quotations the model
    // closed once; skip rather than guess.
    if (/\n\s*\n/.test(inner)) continue;
    spans.push({ text: inner, words, start: match.index!, end: match.index! + match[0].length });
  }
  return spans;
}

/** Whether a quoted span is, segment by segment, a substring of some folded dossier text. */
export function spanIsVerbatim(span: string, foldedDossier: readonly string[]): boolean {
  const segments = span
    .split(/…|\.\.\.|\[\s*…\s*\]|\[\s*\.\.\.\s*\]/)
    .map((segment) => foldQuoteText(segment))
    .filter((segment) => countWords(segment) >= 3);
  if (segments.length === 0) return false;
  return segments.every((segment) => foldedDossier.some((text) => text.includes(segment)));
}

function paragraphAt(markdown: string, offset: number): string {
  const before = markdown.lastIndexOf("\n\n", offset);
  const after = markdown.indexOf("\n\n", offset);
  return markdown.slice(before < 0 ? 0 : before + 2, after < 0 ? markdown.length : after);
}

function documentNameTokens(title: string): string[] {
  return foldQuoteText(title)
    .split(" ")
    .filter((token) => token.length >= 5);
}

/** The dossier document a paragraph names, by a distinctive word of its title. */
function attributedDocument(paragraph: string, documentTitles: readonly string[]): string | undefined {
  const folded = ` ${foldQuoteText(paragraph)} `;
  for (const title of documentTitles) {
    const tokens = documentNameTokens(title);
    if (tokens.length === 0) continue;
    const hits = tokens.filter((token) => folded.includes(` ${token} `)).length;
    if (hits >= Math.min(2, tokens.length)) return title;
  }
  return undefined;
}

export function checkQuoteProvenance(
  markdown: string,
  dossier: readonly { text: string; documentTitle: string }[],
  minWords: number = MIN_QUOTE_WORDS
): QuoteProvenanceReport {
  const folded = dossier.map((excerpt) => foldQuoteText(excerpt.text));
  const titles = [...new Set(dossier.map((excerpt) => excerpt.documentTitle))];
  const spans = quotedSpans(markdown, minWords).map((span) => {
    const verbatim = spanIsVerbatim(span.text, folded);
    const attributedTo = verbatim ? undefined : attributedDocument(paragraphAt(markdown, span.start), titles);
    return { ...span, verbatim, ...(attributedTo ? { attributedTo } : {}) };
  });
  return {
    spans,
    checked: spans.length,
    verbatim: spans.filter((span) => span.verbatim).length,
    misattributed: spans.filter((span) => !span.verbatim && span.attributedTo).length
  };
}

/**
 * Strips the quotation marks from every misattributed span — a quotation the
 * paragraph hangs on a dossier document that the document does not contain —
 * and leaves every other span as written. Returns the text and what changed.
 */
export function stripMisattributedQuotes(
  markdown: string,
  report: QuoteProvenanceReport
): { markdown: string; stripped: number } {
  const targets = report.spans.filter((span) => !span.verbatim && span.attributedTo).sort((a, b) => b.start - a.start);
  let text = markdown;
  for (const span of targets) {
    const original = text.slice(span.start, span.end);
    const unquoted = original.slice(1, -1);
    text = `${text.slice(0, span.start)}${unquoted}${text.slice(span.end)}`;
  }
  return { markdown: text, stripped: targets.length };
}
