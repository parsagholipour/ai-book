/**
 * Reusable deterministic checks. Each returns a `CheckResult`: `pass` is the gate (null when the
 * check does not apply), `value` the measurement a report averages. Pure; no product imports, so the
 * host and the container share it. Checks that need product code (degeneracy, patch application)
 * live in `container/productChecks.ts`.
 */
import { fences, foldForMatch, paragraphs, parseJsonReply, sentences, shingles, tables, withoutFences, wordCount, words } from "./text.ts";

export type CheckResult = { id: string; pass: boolean | null; value?: number; detail?: string };

const result = (id: string, pass: boolean | null, value?: number, detail?: string): CheckResult => ({
  id,
  pass,
  ...(value === undefined ? {} : { value }),
  ...(detail === undefined ? {} : { detail })
});

export function nonEmpty(text: string): CheckResult {
  return result("non_empty", text.trim().length > 0, text.trim().length);
}

/** The reply parses as JSON (one wrapping fence tolerated). */
export function jsonValid(text: string): CheckResult {
  return result("json_valid", parseJsonReply(text) !== undefined);
}

function shapeOf(value: unknown): string {
  if (Array.isArray(value)) return "array";
  if (value === null) return "null";
  return typeof value;
}

/**
 * The reply has the recorded reply's top-level keys with the same value types. The product's zod
 * schemas are module-private, so the recorded answer (which passed them) is the reference shape.
 */
export function shapeMatches(candidate: unknown, reference: unknown, id = "schema_shape"): CheckResult {
  if (reference === undefined || reference === null || typeof reference !== "object" || Array.isArray(reference)) return result(id, null);
  if (candidate === undefined || candidate === null || typeof candidate !== "object" || Array.isArray(candidate)) return result(id, false, 0, "not an object");
  const ref = reference as Record<string, unknown>;
  const got = candidate as Record<string, unknown>;
  const missing = Object.keys(ref).filter((key) => !(key in got));
  const mistyped = Object.keys(ref).filter((key) => key in got && shapeOf(got[key]) !== shapeOf(ref[key]) && ref[key] !== null && got[key] !== null);
  const problems = [...missing.map((key) => `missing ${key}`), ...mistyped.map((key) => `${key}: ${shapeOf(got[key])}≠${shapeOf(ref[key])}`)];
  return result(id, problems.length === 0, problems.length, problems.join("; ") || undefined);
}

/** Output ran into its token budget, or stopped mid-sentence. */
export function truncation(text: string, outputTokens: number | undefined, maxTokens: number | undefined): CheckResult {
  const hitBudget = Boolean(maxTokens && outputTokens && outputTokens >= maxTokens * 0.98);
  const trimmed = withoutFences(text).trim();
  const last = trimmed.slice(-1);
  const midSentence = trimmed.length > 200 && !/[.!?…"”’)\]}*_|>`:;]/.test(last);
  return result("not_truncated", !(hitBudget || midSentence), hitBudget ? 1 : 0, hitBudget ? "hit maxTokens" : midSentence ? `ends with "${trimmed.slice(-40)}"` : undefined);
}

/** A loop: the same line or sentence five or more times, a long run of blank lines, or one 8-gram dominating. */
export function runaway(text: string): CheckResult {
  const counts = new Map<string, number>();
  for (const sentence of sentences(text)) {
    if (sentence.length < 25) continue;
    const key = foldForMatch(sentence);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const worst = Math.max(0, ...counts.values());
  const blankRun = /\n[ \t]*(?:\n[ \t]*){40,}/.test(text);
  const grams = shingles(words(text.toLowerCase()), 8);
  const gramCounts = new Map<string, number>();
  for (const gram of grams) gramCounts.set(gram, (gramCounts.get(gram) ?? 0) + 1);
  const worstGram = Math.max(0, ...gramCounts.values());
  const looping = worst >= 5 || blankRun || (grams.length > 200 && worstGram >= 12);
  return result("no_runaway", !looping, Math.max(worst, worstGram), looping ? `max sentence repeat ${worst}, max 8-gram repeat ${worstGram}${blankRun ? ", blank-line run" : ""}` : undefined);
}

export type WordBudget = { min?: number; target?: number; max?: number };

/** Length against a budget: pass inside [min, max]; value is words / target. */
export function lengthVsBudget(text: string, budget: WordBudget | undefined, id = "length_in_budget"): CheckResult {
  if (!budget || (!budget.min && !budget.max)) return result(id, null);
  const count = wordCount(withoutFences(text));
  const pass = (!budget.min || count >= budget.min) && (!budget.max || count <= budget.max);
  const ratio = budget.target ? count / budget.target : count;
  return result(id, pass, Number(ratio.toFixed(3)), `${count} words; budget ${budget.min ?? "?"}–${budget.max ?? "?"} (target ${budget.target ?? "?"})`);
}

/** Words of `after` as a share of `before`; pass when at least `floor` (the product's refusal line is 0.62). */
export function lengthRatio(before: string, after: string, floor = 0.62, id = "length_ratio"): CheckResult {
  const a = wordCount(withoutFences(before));
  const b = wordCount(withoutFences(after));
  const ratio = a === 0 ? 0 : b / a;
  return result(id, ratio >= floor, Number(ratio.toFixed(3)), `${a} → ${b} words`);
}

/** Sentence-level change between two texts: share of `before`'s sentences kept verbatim, and of its words. */
export function changeStats(before: string, after: string): { sentencesBefore: number; sentencesKept: number; changedSentences: number; addedSentences: number; wordsKeptShare: number } {
  const a = sentences(before).map(foldForMatch);
  const b = sentences(after).map(foldForMatch);
  const bSet = new Set(b);
  const aSet = new Set(a);
  const kept = a.filter((sentence) => bSet.has(sentence));
  const added = b.filter((sentence) => !aSet.has(sentence));
  const keptWords = kept.reduce((sum, sentence) => sum + wordCount(sentence), 0);
  const totalWords = a.reduce((sum, sentence) => sum + wordCount(sentence), 0);
  return {
    sentencesBefore: a.length,
    sentencesKept: kept.length,
    changedSentences: a.length - kept.length,
    addedSentences: added.length,
    wordsKeptShare: totalWords === 0 ? 1 : Number((keptWords / totalWords).toFixed(3))
  };
}

/** Kept-verbatim share of the draft's words, as a check value (no gate). */
export function wordsKept(before: string, after: string): CheckResult {
  const stats = changeStats(before, after);
  return result("words_kept_share", null, stats.wordsKeptShare, `${stats.changedSentences} of ${stats.sentencesBefore} sentences changed, ${stats.addedSentences} added`);
}

const NEGATIONS = /\b(?:not|no|never|none|nobody|nothing|neither|nor|without|cannot|n't)\b/gi;
const QUANTIFIERS = /\b(?:all|every|each|some|most|many|few|several|always|often|rarely|sometimes|only|any)\b/gi;
// "one" is left out: it is a pronoun ("one of the") far more often than a count.
const NUMBER = /\b\d[\d,.]*\d\b|\b\d\b|\b(?:two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|twenty|thirty|forty|fifty|hundred|thousand|million|billion)\b/gi;

function properNouns(text: string): string[] {
  const out: string[] = [];
  for (const sentence of sentences(text)) {
    const tokens = sentence.split(/\s+/);
    tokens.forEach((token, index) => {
      const bare = token.replace(/^[^\p{L}]+|[^\p{L}\p{M}'’-]+$/gu, "").replace(/['’]s?$/u, "");
      if (index > 0 && /^\p{Lu}[\p{Ll}\p{M}]+/u.test(bare) && !/^(?:I|I'm|I've|I'd|I'll)$/.test(bare)) out.push(bare);
    });
  }
  return out;
}

function typeDelta(before: string[], after: string[]): { added: string[]; removed: string[] } {
  const a = new Set(before.map((item) => item.toLowerCase().replace(/,/g, "")));
  const b = new Set(after.map((item) => item.toLowerCase().replace(/,/g, "")));
  return { added: [...b].filter((item) => !a.has(item)), removed: [...a].filter((item) => !b.has(item)) };
}

export type ProtectedTokenDelta = { numbersAdded: string[]; numbersRemoved: string[]; namesAdded: string[]; namesRemoved: string[]; negationsDelta: number; quantifiersDelta: number };

/**
 * What meaning-bearing tokens an edit changed: number and proper-noun *types* the other text does not
 * contain at all (a reordering that keeps them is not a change), and negation / quantifier counts.
 */
export function protectedTokenDelta(before: string, after: string): ProtectedTokenDelta {
  const a = withoutFences(before);
  const b = withoutFences(after);
  const numbers = typeDelta(a.match(NUMBER) ?? [], b.match(NUMBER) ?? []);
  // A name counts as present anywhere in the other text, capitalized or not (sentence-initial uses included).
  const lowerA = a.toLowerCase();
  const lowerB = b.toLowerCase();
  const namesA = new Set(properNouns(a).map((name) => name.toLowerCase()));
  const namesB = new Set(properNouns(b).map((name) => name.toLowerCase()));
  return {
    numbersAdded: numbers.added,
    numbersRemoved: numbers.removed,
    namesAdded: [...namesB].filter((name) => !lowerA.includes(name)),
    namesRemoved: [...namesA].filter((name) => !lowerB.includes(name)),
    negationsDelta: (b.match(NEGATIONS)?.length ?? 0) - (a.match(NEGATIONS)?.length ?? 0),
    quantifiersDelta: (b.match(QUANTIFIERS)?.length ?? 0) - (a.match(QUANTIFIERS)?.length ?? 0)
  };
}

/** Gate: no number or proper noun introduced that the draft did not contain (the H2 Quick Draft refusal's measure). */
export function noNewProtectedTokens(before: string, after: string): CheckResult {
  const delta = protectedTokenDelta(before, after);
  const introduced = [...delta.numbersAdded, ...delta.namesAdded];
  const changed = introduced.length + delta.numbersRemoved.length + delta.namesRemoved.length;
  return result(
    "no_new_names_or_numbers",
    introduced.length === 0,
    changed,
    changed === 0 ? undefined : `added ${introduced.slice(0, 8).join(", ") || "-"}; removed ${[...delta.numbersRemoved, ...delta.namesRemoved].slice(0, 8).join(", ") || "-"}; negations ${delta.negationsDelta >= 0 ? "+" : ""}${delta.negationsDelta}`
  );
}

/** Every fenced block (figures, code) of `before` survives byte for byte in `after`. */
export function fencesSurvive(before: string, after: string): CheckResult {
  const original = fences(before);
  if (original.length === 0) return result("fences_identical", null);
  const kept = original.filter((fence) => after.includes(fence.raw)).length;
  return result("fences_identical", kept === original.length, kept / original.length, `${kept}/${original.length} fences byte-identical`);
}

/** Tables keep their count and rows. */
export function tablesSurvive(before: string, after: string): CheckResult {
  const a = tables(before);
  if (a.length === 0) return result("tables_survive", null);
  const b = tables(after);
  const rowsA = a.reduce((sum, table) => sum + table.length, 0);
  const rowsB = b.reduce((sum, table) => sum + table.length, 0);
  return result("tables_survive", b.length >= a.length && rowsB >= rowsA, b.length / a.length, `${a.length}→${b.length} tables, ${rowsA}→${rowsB} rows`);
}

/** Figure markers: ```figure fences, or the "[Figure: …]" stand-ins later passes read. */
export function figuresSurvive(before: string, after: string): CheckResult {
  const count = (text: string) => fences(text).filter((fence) => /^figure\b/i.test(fence.info)).length + (text.match(/\[Figure:[^\]]*\]/g)?.length ?? 0);
  const a = count(before);
  if (a === 0) return result("figures_survive", null);
  const b = count(after);
  return result("figures_survive", b >= a, b / a, `${a}→${b} figures`);
}

const LEAK_PATTERNS: Array<[string, RegExp]> = [
  ["word-count talk", /\b(?:word count|words? (?:target|budget)|target (?:of )?\d{3,}|this is ~?\d{3,})/i],
  ["notes language", /\b(?:research brief|research notes|(?:the|this) supplied (?:evidence|material|sources|record)|the figures supplied|the material for this (?:chapter|section|discussion)|outputContract|wordBudget)\b/i],
  ["editor notes", /\[(?:note|todo|tk|citation needed)[^\]]*\]|\bTODO\b|\bTK\b/i],
  ["assistant voice", /\b(?:as an ai|i cannot|here is the revised|here's the revised|revised chapter:)\b/i],
  ["placeholder", /\b(?:lorem ipsum|PLACEHOLDER|\[insert [^\]]+\])/]
];

/** Production notes or prompt language that reached the prose. */
export function noLeaks(text: string): CheckResult {
  const hits = LEAK_PATTERNS.filter(([, pattern]) => pattern.test(text)).map(([name]) => name);
  return result("no_prompt_leaks", hits.length === 0, hits.length, hits.join(", ") || undefined);
}

/** Count of 8-word shingles that occur in more than one chapter (cross-chapter repetition). */
export function crossChapterDuplicateGrams(chapters: readonly string[], n = 8): CheckResult {
  const owners = new Map<string, Set<number>>();
  chapters.forEach((chapter, index) => {
    for (const gram of new Set(shingles(words(withoutFences(chapter).toLowerCase()), n))) {
      const set = owners.get(gram) ?? new Set<number>();
      set.add(index);
      owners.set(gram, set);
    }
  });
  const shared = [...owners.values()].filter((set) => set.size > 1).length;
  return result(`dup_${n}grams_across_chapters`, null, shared);
}

/** Sentences of `after` that do not occur in `before`: a deletion-only edit has none (whitespace/quote-folded). */
export function deletionOnly(before: string, after: string): CheckResult {
  const source = foldForMatch(before);
  const foreign = sentences(after).filter((sentence) => !source.includes(foldForMatch(sentence)));
  return result("deletion_only", foreign.length === 0, foreign.length, foreign[0] ? `first foreign sentence: "${foreign[0].slice(0, 100)}"` : undefined);
}

/** Quotations of at least `minWords` words in `text`. */
export function quotations(text: string, minWords = 5): string[] {
  const out: string[] = [];
  for (const match of text.matchAll(/[“"]([^“”"]{10,800})[”"]/g)) {
    if (wordCount(match[1]!) >= minWords) out.push(match[1]!);
  }
  for (const match of text.matchAll(/^>\s?(.+)$/gm)) if (wordCount(match[1]!) >= minWords) out.push(match[1]!.replace(/^[“"]|[”"]$/g, ""));
  return out;
}

/** True when `quote` occurs in `haystack` after folding quotes, dashes, whitespace and case; trailing punctuation ignored. */
export function verifyQuote(quote: string, haystack: string): boolean {
  const needle = foldForMatch(quote).replace(/^[\s"'.,;:]+|[\s"'.,;:]+$/g, "");
  if (!needle) return true;
  if (foldForMatch(haystack).includes(needle)) return true;
  // An ellipsis inside a quotation joins two verbatim spans.
  const parts = needle.split(/\s*\.\.\.\s*|\s*\[\.\.\.\]\s*/).filter((part) => part.length > 12);
  const folded = foldForMatch(haystack);
  return parts.length > 1 && parts.every((part) => folded.includes(part));
}

/** Every quotation in `text` is found verbatim in one of `sources`. */
export function quotesVerified(text: string, sources: readonly string[], minWords = 5): CheckResult {
  const quotes = quotations(text, minWords);
  if (quotes.length === 0) return result("quotes_verified", null);
  const haystack = sources.join("\n");
  const unverified = quotes.filter((quote) => !verifyQuote(quote, haystack));
  return result("quotes_verified", unverified.length === 0, (quotes.length - unverified.length) / quotes.length, unverified[0] ? `${unverified.length}/${quotes.length} unverified, e.g. "${unverified[0].slice(0, 90)}"` : `${quotes.length} verified`);
}

/** Paragraph count change, a cheap structural signal for edits. */
export function paragraphDelta(before: string, after: string): CheckResult {
  const a = paragraphs(before).length;
  const b = paragraphs(after).length;
  return result("paragraph_delta", null, b - a, `${a} → ${b} paragraphs`);
}
