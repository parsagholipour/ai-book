import { splitSentences } from "./proseShape.js";

/**
 * How much of a page's prose a rewrite kept, sentence by sentence.
 *
 * A reader-requested rewrite that touched only what it was asked to touch
 * comes back with nearly every sentence of the original intact, and that page
 * was approved by the reviewer once already. Re-reviewing it re-litigates
 * prose nobody changed against a reviewer that is not deterministic between
 * sittings — on 2026-09-06 it rejected three pages the edit had kept at 0.97
 * to 1.00 of their prose, and each rejection bought a repair that rewrote the
 * page from scratch. This measurement is what lets a faithful rewrite inherit
 * the page's standing approval instead.
 *
 * Fenced blocks are excluded on both sides: a code conversion replaces every
 * block and keeps every sentence, which is exactly the case the measurement
 * exists for. Whitespace is normalised and a sentence counts as kept when it
 * appears verbatim anywhere in the rewrite, so a moved sentence is kept and a
 * reworded one is not.
 */
export function retainedProseFraction(before: string, after: string): number {
  const sentences = proseSentences(before).filter((sentence) => sentence.length >= MIN_MEASURED_SENTENCE_LENGTH);
  if (sentences.length === 0) {
    return 1;
  }
  const haystack = normaliseProse(stripFencedBlocks(after));
  const kept = sentences.filter((sentence) => haystack.includes(sentence)).length;
  return kept / sentences.length;
}

/** Below this a "sentence" is a heading fragment or a list marker, not evidence either way. */
const MIN_MEASURED_SENTENCE_LENGTH = 20;

function proseSentences(markdown: string): string[] {
  return splitSentences(stripFencedBlocks(markdown)).map(normaliseProse).filter(Boolean);
}

function stripFencedBlocks(markdown: string): string {
  return markdown.replace(/```[\s\S]*?```/g, " ").replace(/~~~[\s\S]*?~~~/g, " ");
}

function normaliseProse(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}
