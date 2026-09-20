import { markdownLabels } from "./markdownLabels.js";
import { countReadableWords } from "./proseShape.js";

/** Digits of the scripts the book languages count in, folded to ASCII so a chapter number reads the same in every note. */
const DIGIT_BLOCKS = [0x0660, 0x06f0, 0x0966, 0x0e50]; // Arabic-Indic, Persian and Urdu, Devanagari, Thai
const asciiDigits = (text: string) => text.replace(/[\u0660-\u0669\u06F0-\u06F9\u0966-\u096F\u0E50-\u0E59]/g, (digit) => {
  const code = digit.codePointAt(0)!;
  return String(code - DIGIT_BLOCKS.find((base) => code >= base && code < base + 10)!);
});
/** "3", "3, 5 and 6", "12، 13 و 14": numbers joined by punctuation or a connective of at most three letters. */
const NUMBER_LIST = String.raw`\d+(?:\s*(?:[,،、&]|,?\s+\p{L}{1,3})\s*\d+)*`;
/** Quote marks as they stand after `foldQuotes`: typographic doubles and singles are already straight. */
const QUOTE_PAIRS: ReadonlyArray<readonly [string, string]> = [["«", "»"], ["「", "」"], ["『", "』"], ['"', '"'], ["'", "'"]];
const foldQuotes = (text: string) => text.replace(/[‘’‚‛]/g, "'").replace(/[“”„‟]/g, '"').replace(/\s+/g, " ").trim();
const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * The chapters a manuscript read's cut notes cite as holding the retained passage: named by number
 * after the book language's word for chapter (or the English one), or quoted in opening words found
 * verbatim in a chapter's text. `except` is the chapter being cut, whose text is the comparison itself.
 * `undefined` when the notes cite nothing recognisable at all, so the caller keeps every chapter in
 * view rather than none of them; an empty array means the notes cite only the chapter being cut.
 *
 * The third 100-page Balanced book (2026-09-19) sent every other chapter to eight cut reviews: 270–288
 * KB of a 390–405 KB payload, $0.21 of a $0.73 book. Its notes named the retained chapter every time
 * ("Chapter 3 already establishes…"), 19–47 KB of it, and the reviewer's retained evidence for
 * every span was a passage of the chapter being cut or of the chapter the note named.
 */
export function citedChapters(
  notes: readonly string[],
  chapters: ReadonlyArray<{ index: number; markdown: string }>,
  options: { language?: string | undefined; except?: number | undefined } = {}
): number[] | undefined {
  const known = new Map(chapters.map((chapter) => [chapter.index, foldQuotes(chapter.markdown).toLowerCase()]));
  const chapterWord = markdownLabels(options.language).chapter;
  const words = [...new Set(["chapter", chapterWord.toLowerCase()])].map(escape);
  // "Chapter 3", "Kapitel 3", "فصل ۳", "第3章" — and the number first where the language writes it so ("3장").
  const patterns = [new RegExp(String.raw`(?:${words.join("|")})s?\s*(${NUMBER_LIST})`, "giu")];
  if (chapterWord.toLowerCase() !== "chapter") patterns.push(new RegExp(String.raw`(${NUMBER_LIST})\s*${escape(chapterWord.toLowerCase())}`, "giu"));
  const cited = new Set<number>();
  let recognised = false;
  for (const note of notes) {
    const text = asciiDigits(note);
    for (const pattern of patterns) {
      for (const match of text.matchAll(pattern)) {
        for (const number of match[1]!.match(/\d+/g) ?? []) {
          const index = Number(number);
          if (!known.has(index)) continue;
          recognised = true;
          cited.add(index);
        }
      }
    }
    const folded = foldQuotes(text);
    for (const [open, close] of QUOTE_PAIRS) {
      const quotes = folded.matchAll(new RegExp(`${escape(open)}([^${escape(close)}]{8,400})${escape(close)}`, "gu"));
      for (const [, quoted] of quotes) {
        const needle = foldQuotes(quoted!).toLowerCase();
        // Four words, or one unspaced run of eight characters where the script writes none.
        const wordCount = needle.split(" ").length;
        if (wordCount < 4 && (wordCount > 1 || needle.length < 8)) continue;
        for (const [index, markdown] of known) {
          if (!markdown.includes(needle)) continue;
          recognised = true;
          cited.add(index);
        }
      }
    }
  }
  if (!recognised) return undefined;
  return [...cited].filter((index) => index !== options.except).sort((a, b) => a - b);
}

/** The writer's hard limits, also supplied to the semantic judge. */
export function chapterCutConstraints(original: string, minimumWords: number, maxRemovableWords = Infinity) {
  const originalWords = countReadableWords(original);
  return {
    originalWords, minimumWords, preserveFirstParagraph: true,
    maxRemovableWords: Math.max(0, Math.min(originalWords - minimumWords, Math.floor(originalWords / 4), maxRemovableWords))
  };
}

/** Exact deleted text and surviving paragraph neighbors; never an editorial verdict. */
export function chapterRemovedSpans(original: string, candidate: string) {
  const sentences = (text: string) => text.split(/(?<=[.!?؟。][”"’')\]]?)\s+|\n\s*\n/).map((part) => part.trim()).filter(Boolean);
  const normalize = (text: string) => text.replace(/\s+/g, " ");
  const indexed = (source: string) => {
    let offset = 0;
    return sentences(source).map((text) => {
      const index = source.indexOf(text, offset);
      offset = index + text.length;
      return { text, index };
    });
  };
  const before = indexed(original);
  const retained = new Map<number, { text: string; index: number }>();
  let cursor = 0;
  for (const sentence of indexed(candidate)) {
    while (cursor < before.length && normalize(before[cursor]!.text) !== normalize(sentence.text)) cursor++;
    if (cursor === before.length) return []; // Only deletion-only comparisons have deleted spans.
    retained.set(cursor++, sentence);
  }
  const spans: Array<{ removed: string; before: string; after: string }> = [];
  for (let start = 0; start < before.length;) {
    if (retained.has(start)) { start++; continue; }
    let end = start + 1;
    while (end < before.length && !retained.has(end)) end++;
    const first = before[start]!.index;
    const last = before[end - 1]!;
    const until = last.index + last.text.length;
    const previous = retained.get(start - 1);
    const next = retained.get(end);
    const left = previous ? candidate.slice(0, previous.index + previous.text.length).trimEnd() : "";
    const right = next ? candidate.slice(next.index).trimStart() : "";
    spans.push({ removed: original.slice(first, until), before: left.split(/\n\s*\n/).at(-1) ?? "", after: right.split(/\n\s*\n/)[0] ?? "" });
    start = end;
  }
  return spans;
}
