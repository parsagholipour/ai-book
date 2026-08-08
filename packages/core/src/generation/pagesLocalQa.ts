import type { TextModelAdapter } from "../adapters/types.js";
import { kidsReadingGuidanceForInput } from "../prompting/readingLevel.js";
import type { CreateProjectInput, PageDraft, PageQualityReport } from "../schemas/book.js";
import type { FinalQaPage, ReviewPageOptions } from "./pages.js";

/**
 * The deterministic local-QA block: model-free page and manuscript checks, the
 * text metrics behind them, and their pattern tables. Split out of pages.ts,
 * which re-exports the public pieces so `@book-maker/core` is unchanged.
 */

export type LocalPageReviewOptions = Omit<ReviewPageOptions, "textModel">;

/**
 * Runs only the deterministic local quality heuristics (no model call).
 * Used by bulk strategies (e.g. whole-book single pass) to produce honest
 * quality reports without the full model review loop.
 */
export function reviewPageDraftLocally(options: LocalPageReviewOptions): PageQualityReport {
  return runLocalPageQualityChecks({ ...options, textModel: undefined as unknown as TextModelAdapter });
}

export function runLocalPageQualityChecks(options: ReviewPageOptions): PageQualityReport {
  const text = `${options.draft.title}\n${options.draft.markdown}`;
  const currentBody = options.draft.markdown.trim();
  const issues: string[] = [];
  const checks = {
    placeholderFree: true,
    promptLeakFree: true,
    titleClean: true,
    repetitionOk: true,
    progressionOk: true,
    styleNatural: true
  };

  const placeholder = PLACEHOLDER_PATTERNS.find((pattern) => pattern.test(text));
  if (placeholder) {
    checks.placeholderFree = false;
    issues.push("Page contains placeholder or scaffold prose.");
  }

  const promptLeak = PROMPT_LEAK_PATTERNS.find((pattern) => pattern.test(text));
  if (promptLeak) {
    checks.promptLeakFree = false;
    issues.push("Page leaks prompts, schema, image instructions, or production notes.");
  }

  if (hasPageBriefMetaLanguage(currentBody)) {
    checks.promptLeakFree = false;
    checks.progressionOk = false;
    issues.push("Page turns page-brief instructions into reader-facing meta-commentary.");
  }

  const fabricatedResearch = FABRICATED_RESEARCH_PATTERNS.find((pattern) => pattern.test(text));
  if (fabricatedResearch) {
    checks.promptLeakFree = false;
    checks.progressionOk = false;
    issues.push("Page contains invented or explicitly fabricated research evidence.");
  }

  if (hasFormulaicProofLeap(currentBody)) {
    checks.styleNatural = false;
    issues.push("Page uses a formulaic proof-leap phrase that makes the prose sound generated.");
  }

  if (hasFormulaicAdjacentContrast(currentBody)) {
    checks.styleNatural = false;
    issues.push("Page stacks adjacent contrast sentences in a generic AI-rhetorical pattern.");
  }

  if (hasExcessiveDashUse(currentBody)) {
    checks.styleNatural = false;
    issues.push("Page overuses inline em/en dashes in a way that makes the prose sound generated.");
  }

  if (hasDuplicatePagePrefix(options.pageIndex, options.draft.title)) {
    checks.titleClean = false;
    issues.push("Page title repeats the page label.");
  }

  const adjacentPage = options.previousPages.at(-1);
  const normalizedDraftTitle = normalizeTitle(options.draft.title);
  if (adjacentPage && normalizedDraftTitle.length > 0 && normalizeTitle(adjacentPage.title) === normalizedDraftTitle) {
    checks.titleClean = false;
    checks.repetitionOk = false;
    issues.push(`Page title repeats adjacent page ${adjacentPage.index}.`);
  }

  const repeatedPage = options.previousPages.slice(-5).find((page) => {
    const bodySimilarity = similarity(currentBody, page.markdown);
    const summarySimilarity = similarity(options.draft.summary, page.summary);
    const lexicalOverlap = keywordOverlap(options.draft.summary, page.summary);
    return bodySimilarity >= 0.82 || summarySimilarity >= 0.72 || lexicalOverlap >= 0.78;
  });
  if (repeatedPage) {
    checks.repetitionOk = false;
    issues.push(`Page repeats or substantially overlaps the beat from page ${repeatedPage.index}.`);
  }

  const kidsGuidance = kidsReadingGuidanceForInput(options.input);
  // countReadableWords is Unicode-aware; tokenize-based counts undercount or
  // zero out non-Latin scripts (e.g. Persian) and must not gate progression.
  const wordCount = countReadableWords(currentBody);
  const minWords = kidsGuidance?.targetWordsPerPage.min ?? (options.input.category === "STORY" ? 70 : 90);
  if (wordCount < minWords) {
    checks.progressionOk = false;
    issues.push(`Page is too short to show meaningful progression (${wordCount} words).`);
  }

  if (kidsGuidance && wordCount > kidsGuidance.maxWordsPerPageWithTolerance) {
    checks.styleNatural = false;
    issues.push(
      `Page is too long for ages ${kidsGuidance.ageRange} (${wordCount} words; target ${kidsGuidance.targetWordsPerPage.min}-${kidsGuidance.targetWordsPerPage.max}).`
    );
  }

  if (kidsGuidance) {
    const sentenceStats = sentenceLengthStats(currentBody);
    if (
      sentenceStats.average > kidsGuidance.maxAverageSentenceWords ||
      sentenceStats.max > kidsGuidance.maxSentenceWords
    ) {
      checks.styleNatural = false;
      issues.push(
        `Sentences are too long for ages ${kidsGuidance.ageRange} (average ${sentenceStats.average.toFixed(1)} words, longest ${sentenceStats.max}; target average <= ${kidsGuidance.maxAverageSentenceWords}, longest <= ${kidsGuidance.maxSentenceWords}).`
      );
    }
  }

  if (SCAFFOLD_SHAPE_PATTERNS.some((pattern) => pattern.test(currentBody))) {
    checks.progressionOk = false;
    issues.push("Page describes its intended function instead of becoming finished book prose.");
  }

  if (options.pageIndex === options.input.targetPages && hasVagueEnding(options.draft)) {
    checks.progressionOk = false;
    issues.push("Final page ending is too vague to resolve the book's central promise.");
  }

  return {
    approved: issues.length === 0,
    score: Math.max(0, 100 - issues.length * 25),
    issues,
    requiredRevisions: issues.map((issue) => `Fix: ${issue}`),
    notes: issues.length === 0 ? "Local quality checks passed." : "Local quality checks rejected the page.",
    checks
  };
}

export function runLocalFinalQa(input: CreateProjectInput, pages: FinalQaPage[]): string[] {
  const issues: string[] = [];
  if (pages.length !== input.targetPages) {
    issues.push(`Expected ${input.targetPages} pages but found ${pages.length}.`);
  }

  for (const page of pages) {
    const report = runLocalPageQualityChecks({
      input,
      plan: {
        title: "",
        premise: "",
        audience: "",
        writingComplexity: input.complexity,
        voiceGuide: [""],
        antiAiRules: [""],
        questions: [],
        chapters: [],
        characters: [],
        locations: [],
        continuityRules: [],
        researchQueries: [],
        researchNotes: [],
        illustrationPlan: {
          cadence: input.mediaSettings.illustrationCadence,
          globalStyle: "",
          characterReferencePrompts: [],
          pageRules: []
        }
      },
      pageIndex: page.index,
      draft: {
        title: page.title,
        markdown: page.markdown,
        summary: page.summary,
        continuityNotes: []
      },
      previousPages: pages.filter((candidate) => candidate.index < page.index).slice(-4),
      continuityNotes: [],
      textModel: {} as TextModelAdapter
    });
    if (!report.approved) {
      issues.push(`Page ${page.index}: ${report.issues.join(" ")}`);
    }
  }

  return issues.slice(0, 20);
}

export function compactSummaryForQa(summary: string, maxLength: number): string {
  const trimmed = summary.trim();
  if (trimmed.length <= maxLength) {
    return trimmed;
  }

  const budget = Math.max(16, maxLength - 1);
  const slice = trimmed.slice(0, budget).trimEnd();
  const lastSpace = slice.lastIndexOf(" ");
  const body = lastSpace > budget * 0.55 ? slice.slice(0, lastSpace) : slice;
  return `${body}…`;
}

export function summaryLimitForFinalQa(pageCount: number): number {
  if (pageCount <= 30) {
    return 800;
  }
  if (pageCount <= 80) {
    return 450;
  }
  return 220;
}

export function compactPageMap(pages: FinalQaPage[]) {
  const summaryLimit = summaryLimitForFinalQa(pages.length);
  const compact = pages.map((page) => ({
    index: page.index,
    title: page.title,
    summary: compactSummaryForQa(page.summary, summaryLimit)
  }));
  if (compact.length <= 120) {
    return compact;
  }

  const first = compact.slice(0, 40);
  const last = compact.slice(-40);
  const middle: typeof compact = [];
  const stride = Math.max(1, Math.floor((compact.length - 80) / 40));
  for (let index = 40; index < compact.length - 40; index += stride) {
    middle.push(compact[index]!);
    if (middle.length >= 40) {
      break;
    }
  }
  return [...first, { index: -1, title: "Omitted middle pages sampled", summary: `${compact.length - 120} pages omitted from this compact QA map.` }, ...middle, ...last];
}

export function hasDuplicatePagePrefix(pageIndex: number, title: string): boolean {
  const pattern = new RegExp(`^\\s*page\\s+${pageIndex}\\s*[:\\-]\\s*page\\s+${pageIndex}\\b`, "i");
  return pattern.test(title);
}


function normalizeTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/^page\s+\d+\s*[:-]\s*/i, "")
    .replace(/[^\p{L}\p{N}\s']/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function similarity(first: string, second: string): number {
  const firstShingles = shingles(tokenize(first), 3);
  const secondShingles = shingles(tokenize(second), 3);
  if (firstShingles.size === 0 || secondShingles.size === 0) {
    return 0;
  }
  let shared = 0;
  for (const shingle of firstShingles) {
    if (secondShingles.has(shingle)) {
      shared += 1;
    }
  }
  return shared / Math.min(firstShingles.size, secondShingles.size);
}

function keywordOverlap(first: string, second: string): number {
  const firstKeywords = new Set(tokenize(first).filter((token) => !SUMMARY_STOP_WORDS.has(token)));
  const secondKeywords = new Set(tokenize(second).filter((token) => !SUMMARY_STOP_WORDS.has(token)));
  if (firstKeywords.size < 4 || secondKeywords.size < 4) {
    return 0;
  }
  let shared = 0;
  for (const keyword of firstKeywords) {
    if (secondKeywords.has(keyword)) {
      shared += 1;
    }
  }
  return shared / Math.min(firstKeywords.size, secondKeywords.size);
}

function shingles(tokens: string[], size: number): Set<string> {
  const output = new Set<string>();
  for (let index = 0; index <= tokens.length - size; index += 1) {
    output.add(tokens.slice(index, index + size).join(" "));
  }
  return output;
}

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s']/gu, " ")
    .split(/\s+/)
    .filter((token) => token.length > 2);
}

function countReadableWords(text: string): number {
  return text.match(/[\p{L}\p{N}]+(?:['-][\p{L}\p{N}]+)*/gu)?.length ?? 0;
}

function sentenceLengthStats(text: string): { average: number; max: number } {
  const sentenceWordCounts = splitSentences(text).map(countReadableWords).filter((count) => count > 0);
  if (sentenceWordCounts.length === 0) {
    return { average: 0, max: 0 };
  }
  const total = sentenceWordCounts.reduce((sum, count) => sum + count, 0);
  return {
    average: total / sentenceWordCounts.length,
    max: Math.max(...sentenceWordCounts)
  };
}

function hasFormulaicProofLeap(text: string): boolean {
  return PROOF_LEAP_PATTERNS.some((pattern) => pattern.test(text));
}

function hasFormulaicAdjacentContrast(text: string): boolean {
  const sentences = splitSentences(text).filter((sentence) => tokenize(sentence).length >= 4);
  for (let index = 0; index < sentences.length - 1; index += 1) {
    const current = sentences[index]!;
    const next = sentences[index + 1]!;
    const pair = `${current} ${next}`;
    if (
      RHETORICAL_SETUP_PATTERNS.some((pattern) => pattern.test(current)) &&
      CONTRAST_RESOLUTION_PATTERNS.some((pattern) => pattern.test(next)) &&
      THESIS_ABSTRACTION_PATTERN.test(pair)
    ) {
      return true;
    }
    if (
      BROAD_NEGATION_PATTERN.test(current) &&
      THESIS_SENTENCE_START_PATTERN.test(next) &&
      THESIS_ABSTRACTION_PATTERN.test(next)
    ) {
      return true;
    }
  }
  return false;
}

function hasExcessiveDashUse(text: string): boolean {
  const dashCount = countStyleDashes(text);
  if (dashCount < 4) {
    return false;
  }
  const wordCount = Math.max(1, countReadableWords(text));
  const sentenceCount = Math.max(1, splitSentences(text).length);
  return dashCount / wordCount >= 0.018 || dashCount / sentenceCount >= 0.35;
}

function countStyleDashes(text: string): number {
  let count = 0;
  for (const line of text.split(/\r?\n/)) {
    const dashIndexes = [...line.matchAll(/[—–]/g)].map((match) => match.index ?? 0);
    if (dashIndexes.length === 0) {
      continue;
    }

    const ignored = new Set<number>();
    const firstContentIndex = line.search(/\S/);
    if (firstContentIndex >= 0 && isDash(line[firstContentIndex])) {
      ignored.add(firstContentIndex);
      const attributionDashIndex = dashIndexes.find(
        (index) => index !== firstContentIndex && isDialogueAttributionDash(line, index)
      );
      if (attributionDashIndex !== undefined) {
        ignored.add(attributionDashIndex);
      }
    }

    count += dashIndexes.filter((index) => !ignored.has(index)).length;
  }
  return count;
}

function isDash(value: string | undefined): boolean {
  return value === "—" || value === "–";
}

function isDialogueAttributionDash(line: string, index: number): boolean {
  return /\s$/.test(line.slice(0, index)) && /^\s*\p{L}/u.test(line.slice(index + 1));
}

function splitSentences(text: string): string[] {
  return text
    .replace(/\s+/g, " ")
    .split(/(?<=[.!?؟۔…])\s+/)
    .map((sentence) => sentence.trim())
    .filter(Boolean);
}

function hasVagueEnding(draft: PageDraft): boolean {
  const endingText = `${draft.markdown}\n${draft.summary}`.toLowerCase();
  const hasVagueSignal = VAGUE_ENDING_PATTERNS.some((pattern) => pattern.test(endingText));
  const hasResolutionSignal = RESOLUTION_PATTERNS.some((pattern) => pattern.test(endingText));
  return hasVagueSignal && !hasResolutionSignal;
}


const PLACEHOLDER_PATTERNS = [
  /approved premise/i,
  /concrete detail anchors/i,
  /language stays deliberate/i,
  /scene advances one small promise/i,
  /useful pressure/i,
  /mock_ai placeholder/i,
  /placeholder page/i,
  /drafted content for/i
];

const PROMPT_LEAK_PATTERNS = [
  /global visual style/i,
  /continuity rules:/i,
  /return json/i,
  /json schema/i,
  /pageinstruction/i,
  /image prompt/i,
  /avoid text inside images/i,
  /generation instructions/i,
  /production instructions/i,
  /do not mention ai/i
];

const PAGE_BRIEF_META_LANGUAGE_PATTERNS = [
  /\b(?:concluding|conclude|concludes|closing|close|ending|end)\s+the\s+(?:survey|chapter|section|discussion|analysis|page)\b/i,
  /\b(?:the|this)\s+(?:survey|chapter|section|discussion|analysis|page)\s+(?:concludes|closes|ends|transitions|moves|prepares|sets up)\b/i,
  /\b(?:transition(?:s|ing)?|shift(?:s|ing)?|move(?:s|ing)?|prepare(?:s|ing)?)\s+(?:the\s+reader\s+)?(?:from|toward|to|into|away from|for)\s+(?:the\s+)?(?:next|following|subsequent)\s+(?:chapter|section|analysis|focus)\b/i,
  /\b(?:sets?|leaves)\s+up\s+(?:the\s+)?(?:next|following|subsequent)\s+(?:chapter|section|analysis|focus)\b/i
];

export function hasPageBriefMetaLanguage(text: string): boolean {
  return PAGE_BRIEF_META_LANGUAGE_PATTERNS.some((pattern) => pattern.test(text));
}

const FABRICATED_RESEARCH_PATTERNS = [
  /\b(?:fictional|fabricated|invented|made[-\s]?up)\b.{0,100}\b(?:stud(?:y|ies)|data|journal|institute|authority|research|project|statistics|evidence|source|citation|expert|findings?)\b/i,
  /\b(?:stud(?:y|ies)|data|journal|institute|authority|research|project|statistics|evidence|source|citation|expert|findings?)\b.{0,100}\b(?:fictional|fabricated|invented|made[-\s]?up)\b/i,
  /\bfabricated data\b/i,
  /\binvented longitudinal studies\b/i
];

const PROOF_LEAP_PATTERNS = [
  /\b(?:this|that|it)\s+(?:is|was)\s+not\s+(?:a\s+)?coincidence\b.{0,140}\b(?:sign|proof|evidence|indication|revelation|reveals?|shows?|means|proves?|demonstrates?|divine)\b/i,
  /\bno\s+accident\b.{0,140}\b(?:sign|proof|evidence|indication|revelation|reveals?|shows?|means|proves?|demonstrates?|divine)\b/i,
  /\bhidden\s+in\s+plain\s+sight\b/i,
  /\bthe\s+truth\s+is\s+that\b.{0,140}\b(?:superior|supremacy|inferior|destiny|essence|divine|ultimate|absolute)\b/i
];

const RHETORICAL_SETUP_PATTERNS = [
  /\bwhere\s+are\b/i,
  /\bwhat\s+of\b/i,
  /\byou\s+(?:have\s+been\s+taught|might\s+object|may\s+ask)\b/i,
  /\bbut\s+what\s+if\b/i,
  /\bpause\s+and\s+reflect\b/i
];

const CONTRAST_RESOLUTION_PATTERNS = [
  /^(?:they|he|she|it|this|that)\s+(?:are|is|was|were)\b/i,
  /^(?:instead|but|yet|and yet|the truth is|what this means is)\b/i,
  /\b(?:not\s+.+;\s+(?:it|they|this|that)\s+(?:is|are)|opposite|therefore|thus)\b/i
];

const THESIS_ABSTRACTION_PATTERN =
  /\b(?:truth|sign|proof|evidence|indication|superiority|supremacy|primacy|hierarchy|destiny|essence|divine|original|supreme|ultimate|inferiority)\b/i;

const BROAD_NEGATION_PATTERN = /\b(?:not|never|opposite|absent|wrong|misread|misunderstood|been taught)\b/i;
const THESIS_SENTENCE_START_PATTERN = /^(?:this|that|it|the truth|therefore|thus|instead)\b/i;

const SCAFFOLD_SHAPE_PATTERNS = [
  /\bthe page opens\b/i,
  /\bthe scene advances\b/i,
  /\bstaying close to the book\b/i,
  /\bleaves the next page\b/i
];

const VAGUE_ENDING_PATTERNS = [
  /\bnothing\.?\s+everything\b/i,
  /\bnothing\b.{0,80}\beverything\b/i,
  /\bthe rest (?:was|is) silence\b/i,
  /\bwhat came next\b/i,
  /\bwhatever came next\b/i,
  /\binto the unknown\b/i,
  /\bthe beginning\b/i,
  /\bnot the end\b/i
];

const RESOLUTION_PATTERNS = [
  /\bresolved\b/i,
  /\bforgave\b/i,
  /\bconfessed\b/i,
  /\bfreed\b/i,
  /\bsurrendered\b/i,
  /\bacquitted\b/i,
  /\breturned\b/i,
  /\bchose\b/i,
  /\bpromised\b/i,
  /\bsigned\b/i,
  /\bburied\b/i,
  /\bopened\b/i,
  /\bclosed\b/i
];

const SUMMARY_STOP_WORDS = new Set([
  "about",
  "after",
  "again",
  "before",
  "between",
  "into",
  "through",
  "with",
  "without",
  "from",
  "that",
  "this",
  "what",
  "when",
  "where",
  "while",
  "they",
  "them",
  "their",
  "page",
  "jack",
  "chapter",
  "story"
]);
