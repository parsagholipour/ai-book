import { narrationOutsideQuotedSpeech } from "./proseShape.js";
import {
  evidenceForPages,
  manuscriptWarning,
  ratio,
  type ManuscriptQualityIssue
} from "./manuscriptQualityIssue.js";
import {
  SENTENCE_OPENING_CLEAN_CORPUS_BASELINE,
  SENTENCE_OPENING_WARNING_BASELINE_MULTIPLIER,
  SENTENCE_OPENING_WARNING_MIN_OCCURRENCES
} from "./manuscriptQualityPolicy.js";
import { WORD_TOKEN_PATTERN } from "./manuscriptPageCache.js";
import { chaptersSpannedBy, type CachedManuscriptPage } from "./manuscriptSignatures.js";

type OpeningFamily = {
  id: string;
  label: string;
  test: (opening: string, sentence: string) => boolean;
};

const OPENING_FAMILIES: readonly OpeningFamily[] = [
  { id: "rather_than", label: "Rather than", test: (opening) => /^rather than\b/u.test(opening) },
  { id: "the_distinction", label: "The distinction", test: (opening) => /^the distinction\b/u.test(opening) },
  {
    id: "does_not_by_itself",
    label: "This/That does not by itself",
    test: (opening, sentence) => /^(?:this|that) does not\b/u.test(opening) && /\bby itself\b/u.test(sentence)
  },
  {
    id: "same_could_also",
    label: "The same … could also",
    test: (opening, sentence) => /^the same\b/u.test(opening) && /\bcould also\b/u.test(sentence)
  },
  {
    id: "not_merely_but",
    label: "Not merely/just/simply … but",
    test: (opening, sentence) => /^not (?:merely|just|simply)\b/u.test(opening) && /\bbut\b/u.test(sentence)
  },
  {
    id: "neither_nor_caveat",
    label: "neither … nor",
    test: (opening, sentence) => /^neither\b/u.test(opening) && /\bnor\b/u.test(sentence)
  },
  {
    id: "fundamentally",
    label: "Fundamentally",
    test: (opening) => /^(?:fundamentally|essentially|ultimately|crucially)\b/u.test(opening)
  }
];

const HEADING_LINE = /^\s{0,3}#{1,6}\s/u;
const LIST_LINE = /^\s{0,3}(?:[-*+]|\d+[.)])\s/u;
const QUOTE_LINE = /^\s{0,3}>/u;
const FENCE_LINE = /^\s{0,3}```/u;
const ABBREVIATIONS = new Set([
  "dr", "mr", "mrs", "ms", "prof", "sr", "jr", "vs", "etc", "fig", "vol", "pp", "st", "rd", "ave",
  "inc", "ltd", "approx", "al", "eg", "ie", "us", "uk"
]);

export function sentenceOpeningCadenceIssues(cached: readonly CachedManuscriptPage[]): ManuscriptQualityIssue[] {
  const ownersByFamily = new Map<string, { label: string; pages: Set<number>; occurrences: number; excerpts: Map<number, string> }>();
  for (const page of cached) {
    const sentences = narrativeSentencesFromMarkdown(page.markdown);
    for (const sentence of sentences) {
      const opening = sentenceOpening(sentence);
      if (!opening) {
        continue;
      }
      for (const family of OPENING_FAMILIES) {
        if (!family.test(opening, sentence.toLowerCase())) {
          continue;
        }
        const entry = ownersByFamily.get(family.id) ?? {
          label: family.label,
          pages: new Set<number>(),
          occurrences: 0,
          excerpts: new Map<number, string>()
        };
        entry.pages.add(page.page.index);
        entry.occurrences += 1;
        if (!entry.excerpts.has(page.page.index)) {
          entry.excerpts.set(page.page.index, sentence);
        }
        ownersByFamily.set(family.id, entry);
      }
    }
  }

  const issues: ManuscriptQualityIssue[] = [];
  for (const entry of ownersByFamily.values()) {
    if (
      entry.occurrences < SENTENCE_OPENING_WARNING_MIN_OCCURRENCES ||
      entry.occurrences < SENTENCE_OPENING_CLEAN_CORPUS_BASELINE * SENTENCE_OPENING_WARNING_BASELINE_MULTIPLIER
    ) {
      continue;
    }
    const affected = [...entry.pages].sort((a, b) => a - b);
    issues.push(
      manuscriptWarning(
        "SENTENCE_OPENING_CADENCE",
        `The "${entry.label}" sentence opening appears ${entry.occurrences} times across ${affected.length} pages.`,
        "Keep one precise use and vary later sentence openings so the cadence does not saturate the manuscript.",
        affected,
        {
          metrics: {
            occurrences: entry.occurrences,
            affectedPageRatio: ratio(affected.length, cached.length),
            clusterCount: 1,
            chaptersSpanned: chaptersSpannedBy(cached, affected)
          },
          evidence: evidenceForPages(
            [...entry.excerpts.entries()].map(([pageIndex, excerpt]) => ({ index: pageIndex, plain: excerpt })),
            affected
          )
        }
      )
    );
  }
  return issues;
}

export function narrativeSentencesFromMarkdown(markdown: string): string[] {
  const kept: string[] = [];
  let inFence = false;
  for (const line of markdown.split(/\r?\n/u)) {
    if (FENCE_LINE.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence || HEADING_LINE.test(line) || LIST_LINE.test(line) || QUOTE_LINE.test(line)) {
      continue;
    }
    if (line.trim()) {
      kept.push(line);
    }
  }
  const narration = narrationOutsideQuotedSpeech(kept.join("\n"));
  return splitSentencesAvoidingAbbreviations(narration).filter(isCountableSentence);
}

function sentenceOpening(sentence: string): string {
  const words = (sentence.toLowerCase().match(WORD_TOKEN_PATTERN) ?? []).slice(0, 4);
  return words.join(" ");
}

function isCountableSentence(sentence: string): boolean {
  const words = sentence.match(WORD_TOKEN_PATTERN) ?? [];
  return words.length >= 5;
}

function splitSentencesAvoidingAbbreviations(text: string): string[] {
  const sentences: string[] = [];
  let start = 0;
  const pattern = /([.!?؟۔…])(["'”»)\]]*)(\s+|$)/gu;
  for (const match of text.matchAll(pattern)) {
    const index = match.index ?? 0;
    if (isAbbreviationToken(wordBefore(text, index))) {
      continue;
    }
    const sentence = text.slice(start, index + (match[1]?.length ?? 0) + (match[2]?.length ?? 0)).trim();
    if (sentence) {
      sentences.push(sentence);
    }
    start = index + match[0].length;
  }
  const tail = text.slice(start).trim();
  if (tail) {
    sentences.push(tail);
  }
  return sentences;
}

function wordBefore(text: string, index: number): string {
  const prefix = text.slice(0, index);
  const tokens = prefix.match(WORD_TOKEN_PATTERN) ?? [];
  return tokens.at(-1) ?? "";
}

function isAbbreviationToken(token: string): boolean {
  const folded = token.toLowerCase().replace(/\./g, "");
  return folded.length <= 1 || ABBREVIATIONS.has(folded);
}
