/** Read-only cadence measurements for experiment reports. A match is not an editing instruction. */
const FIRST_MAX_WORDS = 18;
const SECOND_MAX_WORDS = 22;
/** The assert-then-retract pair runs longer than the classic couplet on both sides. */
const RETRACT_FIRST_MAX_WORDS = 28;
const RETRACT_SECOND_MAX_WORDS = 26;

const NEGATION = /\b(?:was|were|is|are|did|does|do|had|has|have|could|would|will|can)\s+not\b|\bn't\b|\bnever\b/i;
const SECOND_OPENER = /^(?:It|They|That|This|What|The|Its|Their|He|She|We)\b/;
/** The second half of an assert-then-retract pair: a bare subject that takes the claim back. */
const RETRACTION_OPENER =
  /^(?:It|They|That|This|What it|What they|The (?:record|evidence|bones|text|document|site|sources?))\s+(?:(?:does|did|do|is|was|are|were|can|could|will|would|has|have)\s+not|cannot|can't|rarely|never|seldom)\b/;
/** The same retraction folded onto a semicolon inside one sentence. */
const SEMICOLON_RETRACTION =
  /;\s*(?:it|they|that|this|the other|the second)\s+(?:(?:does|did|do|is|was|are|were|can|could|will|would|had|has|have)\s+not|cannot|can't|rarely|never|seldom|hardly)\b/i;
/** "The evidence can support A without proving B": the retraction as a subordinate clause. */
const WITHOUT_PROVING =
  /\b(?:can|could|may|might|does|do|did|will)\b[^.;:!?]{0,90}\bwithout\s+(?:establishing|proving|showing|settling|determining|telling|revealing|explaining|demonstrating|implying|supplying)\b/i;

export type CoupletKind = "classic" | "assertRetract" | "semicolonRetract" | "withoutProving";

export type Couplet = {
  id: string;
  paragraph: number;
  kind: CoupletKind;
  /** The exact span to replace: both sentences for a pair, the sentence itself otherwise. */
  text: string;
  first: string;
  /** Empty for the one-sentence kinds. */
  second: string;
};

/** Sentence splitting for the historical cadence measurements. */
export function splitCoupletSentences(paragraph: string): string[] {
  return paragraph
    .split(/(?<=[.!?][”"’')\]]?)\s+(?=[A-Z“"‘'([])/)
    .map((sentence) => sentence.trim())
    .filter(Boolean);
}

function wordCount(text: string): number {
  return text.split(/\s+/).filter(Boolean).length;
}

export function isCouplet(first: string, second: string): boolean {
  return (
    NEGATION.test(first) &&
    wordCount(first) <= FIRST_MAX_WORDS &&
    SECOND_OPENER.test(second) &&
    wordCount(second) <= SECOND_MAX_WORDS
  );
}

/** An assertion, then its retraction: the mirror of the classic couplet. */
export function isAssertRetract(first: string, second: string): boolean {
  return (
    !NEGATION.test(first) &&
    wordCount(first) <= RETRACT_FIRST_MAX_WORDS &&
    RETRACTION_OPENER.test(second) &&
    wordCount(second) <= RETRACT_SECOND_MAX_WORDS
  );
}

/**
 * Every antithesis in the chapter, in order, at most one hit per sentence and
 * the earliest kind winning. Prose paragraphs only: a heading, a quotation, a
 * list item and a fence are read past.
 */
export function findCouplets(markdown: string): Couplet[] {
  const couplets: Couplet[] = [];
  const paragraphs = markdown.split(/\n\s*\n/);
  paragraphs.forEach((paragraph, index) => {
    if (/^\s*(?:#|>|[-*]\s|\d+\.\s|```)/.test(paragraph)) return;
    const sentences = splitCoupletSentences(paragraph);
    const push = (kind: CoupletKind, text: string, first: string, second: string) => {
      couplets.push({ id: `c${couplets.length + 1}`, paragraph: index, kind, text, first, second });
    };
    let at = 0;
    while (at < sentences.length) {
      const first = sentences[at]!;
      const second = at + 1 < sentences.length ? sentences[at + 1]! : undefined;
      const pair = second ? `${first} ${second}` : undefined;
      if (second && pair && paragraph.includes(pair) && isCouplet(first, second)) {
        push("classic", pair, first, second);
        at += 2;
        continue;
      }
      if (second && pair && paragraph.includes(pair) && isAssertRetract(first, second)) {
        push("assertRetract", pair, first, second);
        at += 2;
        continue;
      }
      if (SEMICOLON_RETRACTION.test(first)) {
        push("semicolonRetract", first, first, "");
      } else if (WITHOUT_PROVING.test(first)) {
        push("withoutProving", first, first, "");
      }
      at += 1;
    }
  });
  return couplets;
}

function sentenceCount(markdown: string): number {
  return markdown.split(/\n\s*\n/).reduce((sum, paragraph) => sum + splitCoupletSentences(paragraph).length, 0);
}

/** Sentences per thousand that open a classic couplet — the scorecard's series, unchanged. */
export function coupletsPer1000Sentences(markdown: string): number {
  const total = sentenceCount(markdown);
  return total === 0 ? 0 : (findCouplets(markdown).filter((couplet) => couplet.kind === "classic").length / total) * 1000;
}

/** The same reading over every kind: the claim-and-retraction rate of the chapter. */
export function antithesesPer1000Sentences(markdown: string): number {
  const total = sentenceCount(markdown);
  return total === 0 ? 0 : (findCouplets(markdown).length / total) * 1000;
}

/** Capitalised tokens for historical diagnostics; they do not establish factual equivalence. */
export function coupletAnchors(text: string): Set<string> {
  const found = new Set<string>();
  for (const match of text.matchAll(/\b[A-Z][\p{L}’'-]+|\b\d[\d,.]*\b/gu)) {
    const token = match[0].replace(/[’']s$/, "");
    if (/^(?:It|They|That|This|What|The|Its|Their|He|She|We|A|An|But|And|In|On|At|By|For|To|Of|If|When|Where|While|Yet|So|As|Not|No|There|These|Those|Here|Then|Now)$/.test(token)) continue;
    found.add(token);
  }
  return found;
}
