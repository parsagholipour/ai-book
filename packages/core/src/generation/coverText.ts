import type { ScriptProfile } from "../prompting/script.js";

export type FitCoverTextOptions = {
  text: string;
  baseFontSize: number;
  minFontSize: number;
  maxCharsPerLine: number;
  maxLines: number;
  /**
   * The book's script. Absent means Latin, which is what every measurement
   * here was calibrated against — so omitting it reproduces the original
   * behaviour exactly.
   */
  script?: ScriptProfile | undefined;
};

export type FittedCoverText = {
  fontSize: number;
  lines: string[];
  truncated: boolean;
};

export function cleanText(value: string | null | undefined): string {
  return value?.replace(/\s+/g, " ").trim() ?? "";
}

/**
 * Shrinks a cover title until it fits the template's line budget.
 *
 * Everything is measured in **grapheme clusters** rather than UTF-16 code
 * units: slicing by `.length` severs surrogate pairs and strips combining
 * marks off their base, which turns a Devanagari conjunct or an emoji into
 * garbage. For ASCII the two counts are identical, so Latin titles are
 * unaffected.
 */
export function fitCoverText(options: FitCoverTextOptions): FittedCoverText {
  const text = cleanText(options.text);
  if (!text) {
    return { fontSize: options.baseFontSize, lines: [], truncated: false };
  }

  const script = options.script;
  const maxChars = Math.max(4, Math.round(options.maxCharsPerLine * (script?.charWidthScale ?? 1)));

  for (let fontSize = options.baseFontSize; fontSize >= options.minFontSize; fontSize -= 4) {
    const charsPerLine = Math.max(8, Math.floor(maxChars * (options.baseFontSize / fontSize)));
    const lines = wrapText(text, charsPerLine, script);
    if (lines.length <= options.maxLines) {
      return { fontSize, lines, truncated: false };
    }
  }

  const minCharsPerLine = Math.max(8, Math.floor(maxChars * (options.baseFontSize / options.minFontSize)));
  const lines = wrapText(text, minCharsPerLine, script).slice(0, options.maxLines);
  const last = lines.at(-1);
  if (last) {
    lines[lines.length - 1] = ellipsize(last, minCharsPerLine);
  }
  return { fontSize: options.minFontSize, lines, truncated: true };
}

function wrapText(text: string, maxCharsPerLine: number, script: ScriptProfile | undefined): string[] {
  // A script written without spaces must have its lines rejoined without them
  // too, or the cover reads "月 之 书" instead of "月之书".
  const spaceless = script !== undefined && usesDictionaryWordBreaks(script);
  const joiner = spaceless ? "" : " ";
  const lines: string[] = [];
  let current = "";

  for (const word of splitWords(text, script)) {
    if (!current && !word.trim()) {
      // A break fell on whitespace; it does not start the next line.
      continue;
    }
    if (graphemeLength(word) > maxCharsPerLine) {
      if (current) {
        lines.push(current);
        current = "";
      }
      // A cursive word must never be cut: each half re-shapes with isolated
      // forms, so the cover would show two words that are not the one written.
      // Overflow is handled instead by the font-size descent above.
      lines.push(...(script?.cursive ? [word] : splitLongWord(word, maxCharsPerLine)));
      continue;
    }
    const candidate = current ? `${current}${joiner}${word}` : word;
    if (graphemeLength(candidate) <= maxCharsPerLine) {
      current = candidate;
    } else {
      if (current) {
        lines.push(current);
      }
      current = word;
    }
  }
  if (current.trim()) {
    lines.push(current);
  }
  return lines;
}

/**
 * Chinese, Japanese and Thai are written without spaces, so splitting on
 * whitespace yields one unbreakable "word" the length of the title. ICU knows
 * where those scripts break — including a Thai dictionary — and Node ships it.
 *
 * Whitespace segments are kept rather than dropped, because those scripts still
 * embed Latin words and a title rejoined without a separator would run them
 * together.
 */
function splitWords(text: string, script: ScriptProfile | undefined): string[] {
  if (!script || !usesDictionaryWordBreaks(script)) {
    return text.split(/\s+/).filter(Boolean);
  }
  const segmenter = wordSegmenter(script.code);
  if (!segmenter) {
    return text.split(/\s+/).filter(Boolean);
  }
  return [...segmenter.segment(text)].map((entry) => entry.segment).filter((segment) => segment.length > 0);
}

function usesDictionaryWordBreaks(script: ScriptProfile): boolean {
  return (
    script.script === "han-simplified" ||
    script.script === "japanese" ||
    script.script === "korean" ||
    script.script === "thai"
  );
}

function splitLongWord(word: string, maxCharsPerLine: number): string[] {
  const clusters = graphemes(word);
  const parts: string[] = [];
  for (let index = 0; index < clusters.length; index += maxCharsPerLine) {
    parts.push(clusters.slice(index, index + maxCharsPerLine).join(""));
  }
  return parts;
}

function ellipsize(value: string, maxLength: number): string {
  const clusters = graphemes(value);
  if (clusters.length <= Math.max(1, maxLength - 1)) {
    return `${value}...`;
  }
  return `${clusters.slice(0, Math.max(1, maxLength - 1)).join("").trimEnd()}...`;
}

let cachedGraphemeSegmenter: Intl.Segmenter | undefined | null;
const wordSegmenters = new Map<string, Intl.Segmenter | undefined>();

function graphemes(value: string): string[] {
  const segmenter = graphemeSegmenter();
  return segmenter ? [...segmenter.segment(value)].map((entry) => entry.segment) : [...value];
}

function graphemeLength(value: string): number {
  return graphemes(value).length;
}

function graphemeSegmenter(): Intl.Segmenter | undefined {
  if (cachedGraphemeSegmenter === undefined) {
    cachedGraphemeSegmenter = createSegmenter(undefined, "grapheme") ?? null;
  }
  return cachedGraphemeSegmenter ?? undefined;
}

function wordSegmenter(locale: string): Intl.Segmenter | undefined {
  if (!wordSegmenters.has(locale)) {
    wordSegmenters.set(locale, createSegmenter(locale, "word"));
  }
  return wordSegmenters.get(locale);
}

function createSegmenter(locale: string | undefined, granularity: "grapheme" | "word"): Intl.Segmenter | undefined {
  if (typeof Intl.Segmenter !== "function") {
    return undefined;
  }
  try {
    return new Intl.Segmenter(locale, { granularity });
  } catch {
    return undefined;
  }
}
