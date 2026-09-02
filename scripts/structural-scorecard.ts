/**
 * Structural scorecard for a book's prose: the deterministic half of the blind
 * rubric that found the 2026-09-02 books "competent, restrained prose whose
 * repeated deep structure creates an over-produced effect".
 *
 *   pnpm scorecard <book.md | pages.json> [<second file>]
 *
 * A `.json` file is an array of `{ index, markdown }` pages (dump them with
 * psql); a Markdown file is treated as one text and cut into ~450-word windows
 * for the page-shape measure. Two files print side by side.
 *
 * Baseline (Aggression Through Time, cmtj5zdel0012o1p5msfy2ygy, balanced,
 * per-page strategy, 2026-09-01): sentence CV 0.41, "The same" ×36 as the top
 * opener, 23% list sentences, top-5 page shapes covering 76% of pages,
 * concession markers 11.0 per 1000 words, 21% of paragraphs ending on a hedge.
 */
import { readFileSync } from "node:fs";
import { basename, extname } from "node:path";
import { measureProse } from "../packages/core/src/generation/proseMeasurements.js";

type Page = { index: number; markdown: string };

type Scorecard = {
  words: number;
  sentences: number;
  sentenceMean: number;
  sentenceCv: number;
  topOpener: string;
  topOpenerCount: number;
  top5OpenerShare: number;
  theStartShare: number;
  listSentenceShare: number;
  concessionPer1000: number;
  abstractNounPer1000: number;
  paragraphs: number;
  paragraphCv: number;
  hedgeEndingShare: number;
  pages: number;
  distinctShapes: number;
  top5ShapeCoverage: number;
  negationContrastPer1000Sentences: number;
  generalisingCloserShare: number;
  pivotsPer1000Words: number;
};

const CONCESSION_PATTERNS: RegExp[] = [
  /\bnot (?:only |just |simply |merely )?\w+(?: \w+){0,6} but\b/gi,
  /\brather than\b/gi,
  /\bwhile\b/gi,
  /\byet\b/gi,
  /\bdid not\b/gi,
  /\bcannot (?:by itself|alone)\b/gi,
  /\bby itself\b/gi,
  /\bdoes not (?:prove|establish|show|reveal|mean|tell)\b/gi,
  /\bhowever\b/gi,
  /\bnevertheless\b/gi,
  /\bat the same time\b/gi,
  /\bboth \w+(?: \w+){0,6} and\b/gi
];

const ABSTRACT_NOUNS = /\b(?:capacity|capacities|authority|reach|arrangements?|institutions?|institutional|mechanisms?|conditions|patterns?|structures?|record|evidence|distinction|framework|dynamics)\b/gi;

const HEDGE_ENDING: RegExp[] = [
  /^(?:that|this|the) (?:conclusion|result|pattern|change|evidence|record|distinction|difference)\b/i,
  /\btherefore\b/i,
  /\bconsequently\b/i,
  /\bremains?\b/i,
  /\bnot .{3,40} but\b/i,
  /\brather than\b/i,
  /\bcannot (?:by itself|alone)\b/i,
  /\bdoes not (?:prove|establish|show|reveal|tell)\b/i,
  /\bwithout (?:revealing|showing|proving)\b/i,
  /\ba (?:bounded|limited|partial)\b/i,
  /\bis (?:substantial|real|clear), but\b/i,
  /\bboth .{3,40} and\b/i
];

function words(text: string): string[] {
  return text.match(/[\p{L}\p{N}'’-]+/gu) ?? [];
}

function sentences(text: string): string[] {
  return text
    .replace(/\s+/g, " ")
    .split(/(?<=[.!?…؟。])\s+(?=[\p{Lu}"'“‘(\p{N}])/u)
    .map((sentence) => sentence.trim())
    .filter((sentence) => words(sentence).length >= 2);
}

function plainText(markdown: string): string {
  return markdown
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/^#{1,6}\s.*$/gm, " ")
    .replace(/[*_>`]/g, "")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1");
}

function isListSentence(sentence: string): boolean {
  const commas = (sentence.match(/,/g) ?? []).length;
  return commas >= 3 && /,\s+(?:and|or)\s+\w/.test(sentence);
}

function shape(page: string): string {
  const pageSentences = sentences(plainText(page));
  const last2 = pageSentences.slice(-2).join(" ");
  const first3 = pageSentences.slice(0, 3).join(" ");
  const concession = CONCESSION_PATTERNS.some((pattern) => new RegExp(pattern.source, "i").test(last2));
  const evidenceWord = /\b(?:evidence|record|source|sources)\b/i.test(first3);
  const notBut = Math.min(3, (page.match(/\bnot \w+(?: \w+){0,6} but\b/gi) ?? []).length);
  const enumerations = Math.min(3, pageSentences.filter(isListSentence).length);
  const endsShort = words(pageSentences.at(-1) ?? "").length < 15;
  return [concession, evidenceWord, notBut, enumerations, endsShort].join("|");
}

function mean(values: number[]): number {
  return values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length;
}

function cv(values: number[]): number {
  const average = mean(values);
  if (average === 0) return 0;
  const variance = mean(values.map((value) => (value - average) ** 2));
  return Math.sqrt(variance) / average;
}

export function scorecardFor(pages: Page[]): Scorecard {
  const text = pages.map((page) => plainText(page.markdown)).join("\n\n");
  const allWords = words(text);
  const allSentences = sentences(text);
  const lengths = allSentences.map((sentence) => words(sentence).length);
  const openers = new Map<string, number>();
  let theStart = 0;
  for (const sentence of allSentences) {
    const tokens = words(sentence).map((token) => token.toLowerCase());
    if (tokens[0] === "the") theStart += 1;
    const opener = tokens.slice(0, 2).join(" ");
    openers.set(opener, (openers.get(opener) ?? 0) + 1);
  }
  const rankedOpeners = [...openers.entries()].sort((a, b) => b[1] - a[1]);
  const paragraphs = text
    .split(/\n\s*\n/)
    .map((paragraph) => paragraph.trim())
    .filter((paragraph) => words(paragraph).length >= 40);
  const hedgeEndings = paragraphs.filter((paragraph) => {
    const last = sentences(paragraph).at(-1) ?? "";
    return HEDGE_ENDING.some((pattern) => pattern.test(last));
  }).length;
  const concessions = CONCESSION_PATTERNS.reduce((sum, pattern) => sum + (text.match(pattern) ?? []).length, 0);
  const abstractNouns = (text.match(ABSTRACT_NOUNS) ?? []).length;
  const shapes = new Map<string, number>();
  const shapedPages = pages.filter((page) => words(page.markdown).length >= 80);
  for (const page of shapedPages) {
    const key = shape(page.markdown);
    shapes.set(key, (shapes.get(key) ?? 0) + 1);
  }
  const rankedShapes = [...shapes.values()].sort((a, b) => b - a);
  const per1000 = (count: number) => (allWords.length === 0 ? 0 : (count / allWords.length) * 1000);
  const measured = measureProse(pages.map((page) => page.markdown).join("\n\n"));
  return {
    negationContrastPer1000Sentences: measured.negationContrast.per1000Sentences,
    generalisingCloserShare: measured.generalisingClosers.share,
    pivotsPer1000Words: measured.words === 0 ? 0 : (measured.pivots.count / measured.words) * 1000,
    words: allWords.length,
    sentences: allSentences.length,
    sentenceMean: mean(lengths),
    sentenceCv: cv(lengths),
    topOpener: rankedOpeners[0]?.[0] ?? "",
    topOpenerCount: rankedOpeners[0]?.[1] ?? 0,
    top5OpenerShare: allSentences.length === 0 ? 0 : rankedOpeners.slice(0, 5).reduce((sum, [, count]) => sum + count, 0) / allSentences.length,
    theStartShare: allSentences.length === 0 ? 0 : theStart / allSentences.length,
    listSentenceShare: allSentences.length === 0 ? 0 : allSentences.filter(isListSentence).length / allSentences.length,
    concessionPer1000: per1000(concessions),
    abstractNounPer1000: per1000(abstractNouns),
    paragraphs: paragraphs.length,
    paragraphCv: cv(paragraphs.map((paragraph) => words(paragraph).length)),
    hedgeEndingShare: paragraphs.length === 0 ? 0 : hedgeEndings / paragraphs.length,
    pages: shapedPages.length,
    distinctShapes: shapes.size,
    top5ShapeCoverage: shapedPages.length === 0 ? 0 : rankedShapes.slice(0, 5).reduce((sum, count) => sum + count, 0) / shapedPages.length
  };
}

function loadPages(path: string): Page[] {
  const raw = readFileSync(path, "utf8");
  if (extname(path).toLowerCase() === ".json") {
    const parsed = JSON.parse(raw) as Array<{ index?: number; markdown?: string }>;
    return parsed
      .map((page, offset) => ({ index: page.index ?? offset + 1, markdown: page.markdown ?? "" }))
      .sort((a, b) => a.index - b.index);
  }
  const tokens = raw.split(/(\s+)/);
  const pages: Page[] = [];
  let current: string[] = [];
  let count = 0;
  for (const token of tokens) {
    current.push(token);
    if (/\S/.test(token)) count += 1;
    if (count >= 450 && /[.!?…]$/.test(token)) {
      pages.push({ index: pages.length + 1, markdown: current.join("") });
      current = [];
      count = 0;
    }
  }
  if (current.join("").trim()) pages.push({ index: pages.length + 1, markdown: current.join("") });
  return pages;
}

function row(label: string, values: string[]): string {
  return `${label.padEnd(34)}${values.map((value) => value.padStart(16)).join("")}`;
}

function format(card: Scorecard): Record<string, string> {
  const pct = (value: number) => `${(value * 100).toFixed(1)}%`;
  return {
    words: String(card.words),
    "sentences": String(card.sentences),
    "mean sentence length": card.sentenceMean.toFixed(1),
    "sentence-length CV (higher=varied)": card.sentenceCv.toFixed(3),
    "top 2-word opener": `${card.topOpener} ×${card.topOpenerCount}`,
    "top-5 openers share": pct(card.top5OpenerShare),
    "sentences starting 'The'": pct(card.theStartShare),
    "4+ item list sentences": pct(card.listSentenceShare),
    "concession markers /1000w": card.concessionPer1000.toFixed(1),
    "abstract nouns /1000w": card.abstractNounPer1000.toFixed(1),
    "paragraphs (40w+)": String(card.paragraphs),
    "paragraph-length CV": card.paragraphCv.toFixed(3),
    "paragraphs ending on a hedge": pct(card.hedgeEndingShare),
    "negation-correction /1000 sent.": card.negationContrastPer1000Sentences.toFixed(1),
    "paragraphs ending on a truism": pct(card.generalisingCloserShare),
    "stock pivots /1000w": card.pivotsPer1000Words.toFixed(2),
    "pages measured": String(card.pages),
    "distinct page shapes": String(card.distinctShapes),
    "top-5 page shapes cover": pct(card.top5ShapeCoverage)
  };
}

function main(): void {
  const paths = process.argv.slice(2);
  if (paths.length === 0) {
    console.error("usage: pnpm scorecard <book.md | pages.json> [<second file>]");
    process.exit(2);
  }
  const cards = paths.map((path) => format(scorecardFor(loadPages(path))));
  console.log(row("", paths.map((path) => basename(path).slice(0, 16))));
  for (const key of Object.keys(cards[0]!)) {
    console.log(row(key, cards.map((card) => card[key] ?? "")));
  }
}

const invokedDirectly = process.argv[1] !== undefined && process.argv[1].endsWith("structural-scorecard.ts");
if (invokedDirectly) {
  main();
}
