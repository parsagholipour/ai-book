import { countReadableWords } from "./proseShape.js";

/**
 * Deterministic measurements of prose *shape*, quoted back as sentences.
 *
 * These never gate anything (→ "a deterministic rule that can veto the model
 * reviewer is measured against shipped pages before it ships"). They are what
 * the composed-chapters line editor and the whole-manuscript read are handed
 * so their notes name sentences rather than impressions — the first composed
 * book's editor changed under 2% of the words because it was told "vary
 * paragraph length" and nothing it could act on. The same numbers are what
 * `pnpm scorecard` prints, off this one implementation.
 *
 * English-shaped: on another language the counts read as zero and the editor
 * is simply told less. Nothing here is a verdict about a page.
 */

export type MeasuredSentences = { count: number; examples: string[] };

export type ProseMeasurements = {
  /** "The source establishes X. It does not establish Y." — an affirmation and its retraction, as adjacent sentences. */
  assertRetract: MeasuredSentences;
  /** Paragraph-final sentences built as two balanced clauses joined by a semicolon, "while" or "and so is". */
  symmetricalClosers: MeasuredSentences & { share: number };
  /** The last paragraph names three or more of the chapter's own cases again. */
  rollCallClosing: boolean;
  /** Paragraphs that end on a question: the seam written as a question. */
  questionSeams: MeasuredSentences;
  /** Lines shaped "Label: text", a list wearing prose. */
  labelledListLines: number;
  words: number;
  sentences: number;
  sentenceMean: number;
  sentenceCv: number;
  /** "did not simply X; it Y", "was never only an X", "not X but Y", "less X than Y", "neither X nor Y". */
  negationContrast: MeasuredSentences & { per1000Sentences: number };
  /** A paragraph's last sentence that states a general truth: short, no name, no number, no quotation. */
  generalisingClosers: MeasuredSentences & { share: number };
  /** A negation sentence followed by a short corrective one: "The wall did not stop anyone. It made movement legible." */
  negationThenShort: MeasuredSentences & { per1000Sentences: number };
  /** Sentences enumerating four or more items. */
  listSentences: MeasuredSentences & { share: number };
  /** Stock pivots, by phrase. */
  pivots: { count: number; byPhrase: Record<string, number> };
  openers: { top: Array<{ opener: string; count: number }>; theShare: number };
  openingSentence: string;
  /** "A cannon was never only a cannon": a general claim about a common noun, no particular in it. */
  genericSingularOpening: boolean;
  closingSentence: string;
  closingGeneralises: boolean;
  abstractNounsPer1000: number;
  paragraphs: number;
  paragraphCv: number;
};

const SENTENCE_SPLIT = /(?<=[.!?…؟。])\s+(?=[\p{Lu}"'“‘(\p{N}])/u;
const ABSTRACT_NOUN = /\b(?:capacity|capacities|authority|reach|arrangements?|institutions?|institutional|mechanisms?|conditions|patterns?|structures?|record|evidence|distinction|framework|dynamics|meanings?|choices|history|humanity|violence|aggression|power)\b/gi;
const NEGATION_CONTRAST: RegExp[] = [
  /\b(?:did|does|do|was|were|is|are|could|would|had|has|have)\s+not\s+(?:simply|merely|only|just|by itself|in itself)\b/i,
  /\b(?:was|were|is|are)\s+never\s+(?:only|simply|merely|just)\b/i,
  /\bnot\s+(?:because|that)\b.{3,80}\b(?:but|rather)\b/i,
  /\bnot\s+\w+(?:\s+\w+){0,5}\s+but\s+(?:a|an|the|to|in|of)\b/i,
  /\bless\s+(?:on|about|from|a|an)\b.{3,80}\bthan\s+(?:on|about|from|a|an)\b/i,
  /\bneither\b.{3,80}\bnor\b/i,
  /\brather than\b/i,
  /;\s*(?:it|they|he|she|that|this)\s+(?:was|were|is|are|did|had|made|gave)\b/i
];
const STOCK_PIVOTS = [
  "a rival interpretation",
  "a rival explanation",
  "the strongest rival",
  "on this view",
  "not a transparent",
  "the claim fails",
  "the strongest objection",
  "the distinction matters",
  "that distinction matters",
  "taken together",
  "in other words",
  "put differently",
  "the point is",
  "what matters is",
  "this is not to say",
  "it is worth noting",
  "the lesson is",
  "the result was",
  "therefore",
  "consequently"
];

export function splitSentences(text: string): string[] {
  return text
    .replace(/\s+/g, " ")
    .split(SENTENCE_SPLIT)
    .map((sentence) => sentence.trim())
    .filter((sentence) => countReadableWords(sentence) >= 2);
}

/** Paragraphs of prose; the floor only drops headings, captions and stray lines, so a one-sentence landing paragraph still counts. */
export function proseParagraphs(markdown: string, minWords = 12): string[] {
  return markdown
    .replace(/```[\s\S]*?```/g, " ")
    .split(/\n\s*\n/)
    .map((paragraph) => paragraph.replace(/^#{1,6}\s.*$/gm, "").replace(/[*_>`]/g, "").replace(/\s+/g, " ").trim())
    .filter((paragraph) => countReadableWords(paragraph) >= minWords);
}

function hasParticular(sentence: string): boolean {
  const body = sentence.replace(/^[^\p{L}]*/u, "");
  const later = body.split(/\s+/).slice(1).join(" ");
  return /\p{N}/u.test(sentence) || /[“"'‘]/.test(sentence) || /\b\p{Lu}\p{Ll}+/u.test(later);
}

export function isNegationContrast(sentence: string): boolean {
  return NEGATION_CONTRAST.some((pattern) => pattern.test(sentence));
}

const NEGATION_WORD = /\b(?:not|never|no longer|nobody|nothing)\b/i;
const SHORT_CORRECTION_OPENER = /^(?:It|They|He|She|That|This|The|Each|Both|Neither|One|What|Instead)\b/;

/** The pair the first composed book leaned on 116 times in 46,000 words. */
export function negationThenShortPairs(sentences: readonly string[]): string[] {
  const pairs: string[] = [];
  for (let index = 0; index + 1 < sentences.length; index += 1) {
    const first = sentences[index]!;
    const second = sentences[index + 1]!;
    if (NEGATION_WORD.test(first) && countReadableWords(second) <= 9 && SHORT_CORRECTION_OPENER.test(second)) {
      pairs.push(`${first} ${second}`);
    }
  }
  return pairs;
}

/** Three or more short comma-separated items closed by "and"/"or": an enumeration, not a long sentence with clauses. */
const ASSERT = /\b(?:can|could|may|does|did|will)\s+(?:show|establish|tell|reveal|record|supply|permit|give|preserve|indicate|demonstrate)\b|\b(?:shows|establishes|records|supplies|preserves|indicates|demonstrates|reveals)\b/i;
const RETRACT = /^(?:It|They|That|This|The\s+\w+|Neither|Nothing)\b.{0,40}\b(?:cannot|can not|could not|does not|did not|do not|will not|is not|are not|leaves? open|without)\b/i;

/** "It can show X. It cannot show Y.": the hedge the blind panel counted by the hundred. */
export function assertRetractPairs(sentences: readonly string[]): string[] {
  const pairs: string[] = [];
  for (let index = 0; index + 1 < sentences.length; index += 1) {
    const first = sentences[index]!;
    const second = sentences[index + 1]!;
    if (ASSERT.test(first) && RETRACT.test(second) && countReadableWords(second) <= 30) {
      pairs.push(`${first} ${second}`);
    }
  }
  return pairs;
}

const SYMMETRICAL_JOIN = /^(.{15,110}?)(?:;\s+|,?\s+while\s+|,\s+and so (?:is|does|was|did)\s+|,\s+yet\s+)(.{10,110})$/i;

/** A closing sentence made of two balanced clauses: the paired antithesis the panel called the default cadence. */
export function isSymmetricalCloser(sentence: string): boolean {
  const match = sentence.trim().match(SYMMETRICAL_JOIN);
  if (!match) return false;
  const left = countReadableWords(match[1]!);
  const right = countReadableWords(match[2]!);
  return left >= 4 && right >= 4 && Math.abs(left - right) <= Math.max(3, Math.round(Math.max(left, right) * 0.35)) && !/[“"‘]/.test(sentence);
}

function properNames(text: string): Set<string> {
  const names = new Set<string>();
  for (const match of text.matchAll(/(?<![.!?]\s)(?<!^)\b(\p{Lu}[\p{Ll}’'-]{2,})\b/gu)) {
    names.add(match[1]!);
  }
  return names;
}

/** The chapter's last paragraph names three or more cases the chapter already treated: the roll-call recap. */
export function isRollCallClosing(paragraphs: readonly string[]): boolean {
  if (paragraphs.length < 3) return false;
  const last = paragraphs.at(-1)!;
  const earlier = paragraphs.slice(0, -1).join(" ");
  const earlierNames = properNames(earlier);
  let recalled = 0;
  for (const name of properNames(last)) {
    if (earlierNames.has(name)) recalled += 1;
  }
  return recalled >= 3;
}

export function isListSentence(sentence: string): boolean {
  if (!/,\s+(?:and|or|nor)\s+\w/.test(sentence)) return false;
  const shortSegments = sentence
    .split(",")
    .map((segment) => segment.trim().replace(/^(?:and|or|nor)\s+/, ""))
    .filter((segment) => segment.length > 0 && countReadableWords(segment) <= 7);
  return shortSegments.length >= 3;
}

/** A short closing sentence with no name, number or quotation in it: a truth rather than a thing. */
export function isGeneralisingCloser(sentence: string): boolean {
  const length = countReadableWords(sentence);
  if (length > 16 || length < 3) return false;
  return !hasParticular(sentence);
}

export function isGenericSingularOpening(sentence: string): boolean {
  return /^(?:A|An)\s+\p{Ll}+(?:\s+\p{Ll}+){0,2}\s+(?:is|was|were|are|can|could|does|did|has|had|had|makes|made|became|begins|began|stands|stood|matters|mattered|rarely|never|often|always|seldom)\b/u.test(sentence) && !hasParticular(sentence);
}

function mean(values: number[]): number {
  return values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length;
}

function cv(values: number[]): number {
  const average = mean(values);
  if (average === 0) return 0;
  return Math.sqrt(mean(values.map((value) => (value - average) ** 2))) / average;
}

const EXAMPLE_CAP = 6;

export function measureProse(markdown: string): ProseMeasurements {
  const paragraphs = proseParagraphs(markdown);
  const text = paragraphs.join("\n\n");
  const sentences = paragraphs.flatMap(splitSentences);
  const lengths = sentences.map((sentence) => countReadableWords(sentence));
  const negation = sentences.filter(isNegationContrast);
  const negationPairs = paragraphs.flatMap((paragraph) => negationThenShortPairs(splitSentences(paragraph)));
  const assertRetract = paragraphs.flatMap((paragraph) => assertRetractPairs(splitSentences(paragraph)));
  const lists = sentences.filter(isListSentence);
  const closers = paragraphs.map((paragraph) => splitSentences(paragraph).at(-1) ?? "").filter(Boolean);
  const generalising = closers.filter(isGeneralisingCloser);
  const symmetrical = closers.filter(isSymmetricalCloser);
  const questionSeams = closers.filter((closer) => /\?\s*$/.test(closer));
  const labelledListLines = (markdown.match(/^\s*\*{0,2}[A-Z][A-Za-z’' -]{2,32}\*{0,2}:\s+\S/gm) ?? []).length;
  const lower = text.toLowerCase();
  const byPhrase: Record<string, number> = {};
  let pivotCount = 0;
  for (const phrase of STOCK_PIVOTS) {
    const count = lower.split(phrase).length - 1;
    if (count > 0) {
      byPhrase[phrase] = count;
      pivotCount += count;
    }
  }
  const openerCounts = new Map<string, number>();
  let theStarts = 0;
  for (const sentence of sentences) {
    const tokens = sentence.toLowerCase().match(/[\p{L}\p{N}'’-]+/gu) ?? [];
    if (tokens[0] === "the") theStarts += 1;
    const opener = tokens.slice(0, 2).join(" ");
    if (opener) openerCounts.set(opener, (openerCounts.get(opener) ?? 0) + 1);
  }
  const openingSentence = sentences[0] ?? "";
  const closingSentence = sentences.at(-1) ?? "";
  const words = countReadableWords(text);
  return {
    assertRetract: { count: assertRetract.length, examples: assertRetract.slice(0, EXAMPLE_CAP) },
    symmetricalClosers: {
      count: symmetrical.length,
      share: closers.length === 0 ? 0 : symmetrical.length / closers.length,
      examples: symmetrical.slice(0, EXAMPLE_CAP)
    },
    rollCallClosing: isRollCallClosing(paragraphs),
    questionSeams: { count: questionSeams.length, examples: questionSeams.slice(0, EXAMPLE_CAP) },
    labelledListLines,
    words,
    sentences: sentences.length,
    sentenceMean: mean(lengths),
    sentenceCv: cv(lengths),
    negationContrast: {
      count: negation.length,
      per1000Sentences: sentences.length === 0 ? 0 : (negation.length / sentences.length) * 1000,
      examples: negation.slice(0, EXAMPLE_CAP)
    },
    negationThenShort: {
      count: negationPairs.length,
      per1000Sentences: sentences.length === 0 ? 0 : (negationPairs.length / sentences.length) * 1000,
      examples: negationPairs.slice(0, EXAMPLE_CAP)
    },
    generalisingClosers: {
      count: generalising.length,
      share: closers.length === 0 ? 0 : generalising.length / closers.length,
      examples: generalising.slice(0, EXAMPLE_CAP)
    },
    listSentences: {
      count: lists.length,
      share: sentences.length === 0 ? 0 : lists.length / sentences.length,
      examples: lists.slice(0, EXAMPLE_CAP)
    },
    pivots: { count: pivotCount, byPhrase },
    openers: {
      top: [...openerCounts.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5)
        .map(([opener, count]) => ({ opener, count })),
      theShare: sentences.length === 0 ? 0 : theStarts / sentences.length
    },
    openingSentence,
    genericSingularOpening: isGenericSingularOpening(openingSentence),
    closingSentence,
    closingGeneralises: isGeneralisingCloser(closingSentence) || isNegationContrast(closingSentence) || isListSentence(closingSentence),
    abstractNounsPer1000: words === 0 ? 0 : ((text.match(ABSTRACT_NOUN) ?? []).length / words) * 1000,
    paragraphs: paragraphs.length,
    paragraphCv: cv(paragraphs.map((paragraph) => countReadableWords(paragraph)))
  };
}

export type MeasurementCeilings = {
  negationContrastPer1000Sentences: number;
  negationThenShortPer1000Sentences: number;
  generalisingCloserShare: number;
  listSentenceShare: number;
  pivotsPerThousandWords: number;
  topOpenerShare: number;
};

/** Where an edited chapter should land. Published narrative history sits under all of these. */
export const CHAPTER_MEASUREMENT_CEILINGS: MeasurementCeilings = {
  negationContrastPer1000Sentences: 12,
  negationThenShortPer1000Sentences: 12,
  generalisingCloserShare: 0.1,
  listSentenceShare: 0.12,
  pivotsPerThousandWords: 1.5,
  topOpenerShare: 0.012
};

function quoted(examples: string[]): string {
  return examples.map((example) => `"${example.length > 160 ? `${example.slice(0, 159)}…` : example}"`).join(" ");
}

/**
 * The measurements as notes an editor can act on: only the measures over
 * their ceiling, each with the sentences that put it there.
 */
export function measurementNotes(
  measurements: ProseMeasurements,
  ceilings: MeasurementCeilings = CHAPTER_MEASUREMENT_CEILINGS,
  options: { includeNegationNotes?: boolean } = {}
): string[] {
  const notes: string[] = [];
  const perThousandWords = (count: number) => (measurements.words === 0 ? 0 : (count / measurements.words) * 1000);
  // Negation and closing-verdict notes are diagnostics only: quoted into the
  // editor's prompt they were obeyed lexically, the two-sentence hedge fused
  // into the one-sentence antithesis, and "while" rose 20% across the edit.
  if (options.includeNegationNotes && measurements.negationContrast.per1000Sentences > ceilings.negationContrastPer1000Sentences) {
    notes.push(
      `${measurements.negationContrast.count} sentences are built as a negation followed by its correction ("did not simply X; it Y", "was never only an X", "less X than Y", "neither X nor Y", "rather than"); keep at most ${Math.max(1, Math.round((ceilings.negationContrastPer1000Sentences * measurements.sentences) / 1000))}, and state what the thing was in the rest. For example: ${quoted(measurements.negationContrast.examples)}`
    );
  }
  if (options.includeNegationNotes && measurements.negationThenShort.per1000Sentences > ceilings.negationThenShortPer1000Sentences) {
    notes.push(
      `${measurements.negationThenShort.count} places pair a negation with a short corrective sentence after it ("X did not Y. It Z."); keep at most ${Math.max(1, Math.round((ceilings.negationThenShortPer1000Sentences * measurements.sentences) / 1000))} and fold the rest into one plain sentence that says what happened. For example: ${quoted(measurements.negationThenShort.examples)}`
    );
  }
  if (measurements.generalisingClosers.share > ceilings.generalisingCloserShare) {
    notes.push(
      `${measurements.generalisingClosers.count} of ${measurements.paragraphs} paragraphs end on a short sentence that states a general truth with no name, number or quotation in it; cut it, or make it a specific claim about the case, and do not replace it with an object placed for effect. For example: ${quoted(measurements.generalisingClosers.examples)}`
    );
  }
  if (measurements.listSentences.share > ceilings.listSentenceShare) {
    notes.push(
      `${measurements.listSentences.count} sentences enumerate four or more items; outside a catalogue or a procedure, keep one or two of the items and develop them. For example: ${quoted(measurements.listSentences.examples)}`
    );
  }
  if (perThousandWords(measurements.pivots.count) > ceilings.pivotsPerThousandWords) {
    const phrases = Object.entries(measurements.pivots.byPhrase)
      .sort((a, b) => b[1] - a[1])
      .map(([phrase, count]) => `"${phrase}" ×${count}`)
      .join(", ");
    notes.push(`Stock pivots to cut or replace with the substance they announce: ${phrases}.`);
  }
  const top = measurements.openers.top[0];
  if (top && measurements.sentences > 40 && top.count / measurements.sentences > ceilings.topOpenerShare) {
    notes.push(
      `Sentence openings repeat: ${measurements.openers.top
        .slice(0, 3)
        .map((entry) => `"${entry.opener}" ×${entry.count}`)
        .join(", ")}; vary the construction, not just the word.`
    );
  }
  if (measurements.genericSingularOpening) {
    notes.push(
      `The chapter opens on a general claim about a common noun ("${measurements.openingSentence}"); open inside the first section's material instead — a named place, a dated event, a person, a document.`
    );
  }
  if (options.includeNegationNotes && measurements.closingGeneralises && countReadableWords(measurements.closingSentence) <= 16) {
    notes.push(
      `The chapter ends on a one-sentence verdict ("${measurements.closingSentence}"); write the chapter's conclusion as a reasoned paragraph in the author's voice instead.`
    );
  }
  return notes;
}

/**
 * The notes for the focused de-templating pass: recurring moves, each with the
 * sentences that carry it, for a rewrite that changes those sentences and
 * nothing else. Kept apart from `measurementNotes` because the line edit that
 * received eight notes at once acted on none of them.
 */
export function detemplateNotes(measurements: ProseMeasurements, options: { maxAssertRetract?: number } = {}): string[] {
  const notes: string[] = [];
  const keepPairs = options.maxAssertRetract ?? 3;
  if (measurements.assertRetract.count > keepPairs) {
    notes.push(
      `${measurements.assertRetract.count} places affirm what a source shows and then retract it in the next sentence ("The record shows X. It does not show Y."). Keep at most ${keepPairs}; elsewhere delete the retracting sentence, or fold its one useful limit into the affirming sentence as a clause. For example: ${quoted(measurements.assertRetract.examples)}`
    );
  }
  if (measurements.symmetricalClosers.count >= 3) {
    notes.push(
      `${measurements.symmetricalClosers.count} paragraphs end on a balanced two-clause sentence ("X; Y", "X while Y"). Rewrite each ending so it says one thing, or cut it. For example: ${quoted(measurements.symmetricalClosers.examples)}`
    );
  }
  if (measurements.rollCallClosing) {
    notes.push(
      "The final paragraph names the chapter's cases again in sequence. Replace it with the author's conclusion argued from the chapter as a whole: no roll call of the cases, no restatement of the book's thesis, no balanced closing sentence."
    );
  }
  if (measurements.questionSeams.count >= 2) {
    notes.push(
      `${measurements.questionSeams.count} paragraphs end on a question that the next paragraph answers; cut the question and let the next paragraph begin with its answer. For example: ${quoted(measurements.questionSeams.examples)}`
    );
  }
  if (measurements.pivots.count > 0) {
    const phrases = Object.entries(measurements.pivots.byPhrase)
      .sort((a, b) => b[1] - a[1])
      .map(([phrase, count]) => `"${phrase}" ×${count}`)
      .join(", ");
    notes.push(`Stock pivots to cut or replace with the substance they announce: ${phrases}.`);
  }
  if (measurements.labelledListLines >= 3) {
    notes.push(`${measurements.labelledListLines} lines are shaped "Label: text", a list wearing prose; write them as sentences.`);
  }
  return notes;
}

/** Sentences of the voice sample that reached the prose verbatim. */
export function sampleSentenceLeaks(sample: string, markdown: string, minWords = 7): string[] {
  const haystack = markdown.replace(/\s+/g, " ").toLowerCase();
  return splitSentences(sample)
    .filter((sentence) => countReadableWords(sentence) >= minWords)
    .filter((sentence) => haystack.includes(sentence.replace(/\s+/g, " ").toLowerCase()));
}

/** The first and last sentence of a chapter, for the next chapter's writer to avoid. */
export function chapterEdges(markdown: string): { opening: string; closing: string } {
  const sentences = proseParagraphs(markdown, 1).flatMap(splitSentences);
  return { opening: sentences[0] ?? "", closing: sentences.at(-1) ?? "" };
}
