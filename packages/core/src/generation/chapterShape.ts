import { chapterBlocks } from "./chapterPagination.js";
import { countReadableWords } from "./proseShape.js";

/**
 * The deterministic half of "every paragraph the same length".
 *
 * The first composed book came back with 617 paragraphs of mean 74 words,
 * none over 130 and ten under 40 — a coefficient of variation of 0.20 against
 * 0.6 in books written by hand, and the one shape the blind reviewers had not
 * yet been shown. Both prompts had asked for variety in words; the model
 * answered in words. This measures the chapter after the line edit, and when
 * it reads uniform the editor gets one more pass with the numbers.
 */

export type ParagraphShapeReport = {
  paragraphs: number;
  meanWords: number;
  cv: number;
  longestWords: number;
  shortParagraphs: number;
  longParagraphs: number;
  /** Share of sentences listing four or more comma-separated items. */
  listSentenceShare: number;
  /** "It can show X. It cannot show Y." pairs: an assertion sentence followed by its negated twin. */
  concessiveCouplets: number;
  sentences: number;
};

const SENTENCE_SPLIT = /(?<=[.!?…؟。])\s+/u;
const COUPLET_ASSERT = /^(?:It|This|That|The \w+|A \w+|They|These|Such \w+)\s+(?:can|could|does|did|may|shows?|reveals?|records?|establish(?:es)?|preserves?)\b/i;
const COUPLET_NEGATE = /^(?:It|This|That|The \w+|A \w+|They|These|Such \w+)\s+(?:cannot|can ?not|could not|does not|did not|may not|is not|was not|are not|were not)\b/i;

export const LIST_SENTENCE_MAX_SHARE = 0.12;
export const CONCESSIVE_COUPLETS_MAX_PER_CHAPTER = 3;

function sentencesOf(markdown: string): string[] {
  return markdown
    .replace(/```[\s\S]*?```/g, " ")
    .split(SENTENCE_SPLIT)
    .map((sentence) => sentence.replace(/^[\s>*_-]+/, "").trim())
    .filter((sentence) => countReadableWords(sentence) >= 3);
}

function isListSentence(sentence: string): boolean {
  return (sentence.match(/,/g) ?? []).length >= 3 && /,\s+(?:and|or)\s+\S/.test(sentence);
}

export const PARAGRAPH_SHAPE_MIN_CV = 0.38;
export const PARAGRAPH_SHAPE_LONG_WORDS = 150;
export const PARAGRAPH_SHAPE_SHORT_WORDS = 30;

export function paragraphShapeReport(markdown: string): ParagraphShapeReport {
  const lengths = chapterBlocks(markdown)
    .filter((block) => !/^\s*```/m.test(block))
    .map((block) => countReadableWords(block))
    .filter((count) => count > 0);
  const sentences = sentencesOf(markdown);
  let couplets = 0;
  for (let index = 1; index < sentences.length; index += 1) {
    if (COUPLET_ASSERT.test(sentences[index - 1]!) && COUPLET_NEGATE.test(sentences[index]!)) {
      couplets += 1;
    }
  }
  const listSentenceShare = sentences.length === 0 ? 0 : sentences.filter(isListSentence).length / sentences.length;
  if (lengths.length === 0) {
    return {
      paragraphs: 0,
      meanWords: 0,
      cv: 0,
      longestWords: 0,
      shortParagraphs: 0,
      longParagraphs: 0,
      listSentenceShare,
      concessiveCouplets: couplets,
      sentences: sentences.length
    };
  }
  const mean = lengths.reduce((sum, count) => sum + count, 0) / lengths.length;
  const variance = lengths.reduce((sum, count) => sum + (count - mean) ** 2, 0) / lengths.length;
  return {
    paragraphs: lengths.length,
    meanWords: Math.round(mean * 10) / 10,
    cv: mean === 0 ? 0 : Math.round((Math.sqrt(variance) / mean) * 1000) / 1000,
    longestWords: Math.max(...lengths),
    shortParagraphs: lengths.filter((count) => count <= PARAGRAPH_SHAPE_SHORT_WORDS).length,
    longParagraphs: lengths.filter((count) => count >= PARAGRAPH_SHAPE_LONG_WORDS).length,
    listSentenceShare: Math.round(listSentenceShare * 1000) / 1000,
    concessiveCouplets: couplets,
    sentences: sentences.length
  };
}

/**
 * Notes for the editor when a chapter's paragraphs read as one size; empty
 * when the shape is already varied. Written as instructions with numbers,
 * because the words alone were what the model had already ignored.
 */
export function paragraphShapeNotes(markdown: string): string[] {
  const report = paragraphShapeReport(markdown);
  if (report.paragraphs < 6) {
    return [];
  }
  const notes: string[] = [];
  if (report.cv < PARAGRAPH_SHAPE_MIN_CV) {
    notes.push(
      `The chapter's ${report.paragraphs} paragraphs are all about ${Math.round(report.meanWords)} words; reshape them so their lengths vary widely, without changing the facts or the order of sections.`
    );
  }
  if (report.longParagraphs === 0) {
    notes.push(
      `No paragraph runs past ${PARAGRAPH_SHAPE_LONG_WORDS} words (the longest is ${report.longestWords}): merge paragraphs that continue one movement — a scene, a sustained explanation, a close reading — into at least three paragraphs of 180 to 260 words.`
    );
  }
  if (report.shortParagraphs < 3) {
    notes.push(
      `Only ${report.shortParagraphs} paragraph${report.shortParagraphs === 1 ? "" : "s"} are under ${PARAGRAPH_SHAPE_SHORT_WORDS} words: let at least four turns, quotations, or landings stand alone as one- or two-sentence paragraphs.`
    );
  }
  if (report.sentences >= 40 && report.listSentenceShare > LIST_SENTENCE_MAX_SHARE) {
    notes.push(
      `${Math.round(report.listSentenceShare * 100)}% of sentences list four or more items: in all but a catalogue or a procedure, keep the one detail that matters and cut the rest, so that fewer than one sentence in ten is a list.`
    );
  }
  if (report.concessiveCouplets > CONCESSIVE_COUPLETS_MAX_PER_CHAPTER) {
    notes.push(
      `The chapter pairs an assertion with its negation ("It can show X. It cannot show Y.") ${report.concessiveCouplets} times: keep at most ${CONCESSIVE_COUPLETS_MAX_PER_CHAPTER}, and elsewhere state what the evidence shows and move on, or say what would settle the question instead of what does not.`
    );
  }
  return notes;
}
