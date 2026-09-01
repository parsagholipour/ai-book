import type { TextModelAdapter } from "../adapters/types.js";
import { isSignpostingBookCategory } from "../categories.js";
import { kidsReadingGuidanceForInput } from "../prompting/readingLevel.js";
import type { PageDraft, PageQualityReport } from "../schemas/book.js";
import { isImportedManuscript } from "../schemas/mediaSettings.js";
import type { FinalQaPage, ReviewPageOptions } from "./pages.js";
import { skippedPageQualityReport } from "./pagesSkippedQualityReport.js";
import { overlapTokens } from "./pageOverlap.js";
import {
  repeatedRecentPage,
  sameChapterTreatmentMatch,
  treatmentRepetitionIssue,
  type SameChapterTreatmentMatch
} from "./pagesTreatmentQa.js";
import { PAGE_PROMPT_LEAK_PATTERNS, containsPromptLeak } from "./promptLeak.js";
import {
  countReadableWords,
  hasExcessiveDashUse,
  narrationOutsideQuotedSpeech,
  sentenceLengthStats,
  splitSentences
} from "./proseShape.js";

/**
 * The deterministic local-QA block: model-free page and manuscript checks and
 * the pattern tables they read a page against. Split out of pages.ts, which
 * re-exports the public pieces so `@book-maker/core` is unchanged; the prose
 * measurement every check here counts with is `proseShape.ts` next door, and
 * the two repetition gates — near-verbatim overlap shared with the plan-time
 * beat dedup, and same-chapter treatment shared with the manuscript audit —
 * are `pagesTreatmentQa.ts`.
 */

export type LocalPageReviewOptions = Omit<ReviewPageOptions, "textModel">;

const PASSING_PAGE_CHECKS = {
  placeholderFree: true,
  promptLeakFree: true,
  titleClean: true,
  repetitionOk: true,
  progressionOk: true,
  styleNatural: true
} satisfies PageQualityReport["checks"];

type LocalPageCheck = keyof typeof PASSING_PAGE_CHECKS;

type LocalPageFinding = {
  failedChecks: readonly LocalPageCheck[];
  issue: string;
};

type LocalPageRuleContext = {
  options: ReviewPageOptions;
  text: string;
  currentBody: string;
  flowingBody: string;
  flowingText: string;
  adjacentPage: ReviewPageOptions["previousPages"][number] | undefined;
  normalizedDraftTitle: string;
  repeatedPage: ReviewPageOptions["previousPages"][number] | undefined;
  treatmentMatch: SameChapterTreatmentMatch | undefined;
  kidsGuidance: ReturnType<typeof kidsReadingGuidanceForInput>;
  wordCount: number;
  minWords: number;
  sentenceStats: ReturnType<typeof sentenceLengthStats> | undefined;
};

type LocalPageQualityRule = (context: LocalPageRuleContext) => readonly LocalPageFinding[] | undefined;

function pageRule(
  predicate: (context: LocalPageRuleContext) => boolean,
  failedChecks: readonly LocalPageCheck[],
  issue: string | ((context: LocalPageRuleContext) => string)
): LocalPageQualityRule {
  return (context) =>
    predicate(context)
      ? [{ failedChecks, issue: typeof issue === "string" ? issue : issue(context) }]
      : undefined;
}

/**
 * The report's public issue order. Each rule owns both its message and every
 * check flag it invalidates, so adding an anti-slop predicate is one ordered
 * table entry rather than another mutation site in the review loop.
 */
const FIRST_PAGE_OPENING_QUALITY_RULE = pageRule(
  ({ currentBody, options }) =>
    options.pageIndex === 1 &&
    !isImportedManuscript(options.input.mediaSettings) &&
    hasWeakFirstPageOpening(currentBody),
  ["styleNatural"],
  "First page opens with a generic or meta hook instead of a concrete one."
);

const LOCAL_PAGE_QUALITY_RULES = [
  pageRule(
    ({ flowingText }) => PLACEHOLDER_PATTERNS.some((pattern) => pattern.test(flowingText)),
    ["placeholderFree"],
    "Page contains placeholder or scaffold prose."
  ),
  pageRule(
    ({ text }) => containsPromptLeak(text, PAGE_PROMPT_LEAK_PATTERNS),
    ["promptLeakFree"],
    "Page leaks prompts, schema, image instructions, or production notes."
  ),
  pageRule(
    ({ currentBody }) => hasPageBriefMetaLanguage(currentBody),
    ["promptLeakFree", "progressionOk"],
    "Page turns page-brief instructions into reader-facing meta-commentary."
  ),
  pageRule(
    ({ flowingText }) => FABRICATED_RESEARCH_PATTERNS.some((pattern) => pattern.test(flowingText)),
    ["promptLeakFree", "progressionOk"],
    "Page contains invented or explicitly fabricated research evidence."
  ),
  pageRule(
    ({ flowingBody }) => hasFormulaicProofLeap(flowingBody),
    ["styleNatural"],
    "Page uses a formulaic proof-leap phrase that makes the prose sound generated."
  ),
  pageRule(
    ({ currentBody }) => hasFormulaicAdjacentContrast(currentBody),
    ["styleNatural"],
    "Page stacks adjacent contrast sentences in a generic AI-rhetorical pattern."
  ),
  pageRule(
    ({ currentBody }) => hasFormulaicContrastOveruse(currentBody),
    ["styleNatural"],
    "Page leans repeatedly on the formulaic 'not just X, it's Y' contrast pattern."
  ),
  pageRule(
    ({ currentBody, options }) =>
      !isSignpostingBookCategory(options.input.category) && hasChapterOpenerScaffold(currentBody),
    ["styleNatural"],
    "Page announces what the chapter will cover instead of covering it."
  ),
  pageRule(
    ({ currentBody }) => hasExcessiveDashUse(currentBody),
    ["styleNatural"],
    "Page overuses inline em/en dashes in a way that makes the prose sound generated."
  ),
  pageRule(
    ({ options }) => hasDuplicatePagePrefix(options.pageIndex, options.draft.title),
    ["titleClean"],
    "Page title repeats the page label."
  ),
  pageRule(
    ({ adjacentPage, normalizedDraftTitle }) =>
      Boolean(
        adjacentPage &&
          normalizedDraftTitle.length > 0 &&
          normalizeTitle(adjacentPage.title) === normalizedDraftTitle
      ),
    ["titleClean", "repetitionOk"],
    // "(from page N)": the final-QA repair harvests every other `page N` in
    // this message as a page to redraft — see `pagesTreatmentQa.ts`.
    ({ adjacentPage }) => `Page title repeats the title of the page before it (from page ${adjacentPage!.index}).`
  ),
  pageRule(
    ({ repeatedPage }) => Boolean(repeatedPage),
    ["repetitionOk"],
    ({ repeatedPage }) =>
      `Page repeats or substantially overlaps the beat from page ${repeatedPage!.index}.`
  ),
  pageRule(
    ({ treatmentMatch }) => Boolean(treatmentMatch),
    ["repetitionOk"],
    ({ treatmentMatch }) => treatmentRepetitionIssue(treatmentMatch!)
  ),
  pageRule(
    ({ wordCount, minWords }) => wordCount < minWords,
    ["progressionOk"],
    ({ wordCount }) => `Page is too short to show meaningful progression (${wordCount} words).`
  ),
  pageRule(
    ({ kidsGuidance, wordCount }) =>
      Boolean(kidsGuidance && wordCount > kidsGuidance.maxWordsPerPageWithTolerance),
    ["styleNatural"],
    ({ kidsGuidance, wordCount }) =>
      `Page is too long for ages ${kidsGuidance!.ageRange} (${wordCount} words; target ${kidsGuidance!.targetWordsPerPage.min}-${kidsGuidance!.targetWordsPerPage.max}).`
  ),
  pageRule(
    ({ kidsGuidance, sentenceStats }) =>
      Boolean(
        kidsGuidance &&
          sentenceStats &&
          (sentenceStats.average > kidsGuidance.maxAverageSentenceWords ||
            sentenceStats.max > kidsGuidance.maxSentenceWords)
      ),
    ["styleNatural"],
    ({ kidsGuidance, sentenceStats }) =>
      `Sentences are too long for ages ${kidsGuidance!.ageRange} (average ${sentenceStats!.average.toFixed(1)} words, longest ${sentenceStats!.max}; target average <= ${kidsGuidance!.maxAverageSentenceWords}, longest <= ${kidsGuidance!.maxSentenceWords}).`
  ),
  pageRule(
    ({ flowingBody }) => SCAFFOLD_SHAPE_PATTERNS.some((pattern) => pattern.test(flowingBody)),
    ["progressionOk"],
    "Page describes its intended function instead of becoming finished book prose."
  ),
  FIRST_PAGE_OPENING_QUALITY_RULE,
  pageRule(
    ({ options }) => options.pageIndex === options.input.targetPages && hasVagueEnding(options.draft),
    ["progressionOk"],
    "Final page ending is too vague to resolve the book's central promise."
  )
] as const satisfies readonly LocalPageQualityRule[];

/**
 * Runs only the deterministic local quality heuristics (no model call).
 * Used by bulk strategies (e.g. whole-book single pass) to produce honest
 * quality reports without the full model review loop.
 */
export function reviewPageDraftLocally(options: LocalPageReviewOptions): PageQualityReport {
  return runLocalPageQualityChecks({ ...options, textModel: undefined as unknown as TextModelAdapter });
}

export function runLocalPageQualityChecks(options: ReviewPageOptions): PageQualityReport {
  return pageQualityReportForRules(options, LOCAL_PAGE_QUALITY_RULES);
}

/**
 * The provenance-only deterministic invariant that remains active when the
 * operator disables configurable local QA. Generated page 1 must still honor
 * its opening contract; imported prose remains exempt.
 */
export function reviewRequiredPageQualityChecks(options: ReviewPageOptions): PageQualityReport {
  if (options.pageIndex !== 1) {
    return skippedPageQualityReport();
  }
  const report = pageQualityReportForRules(options, [FIRST_PAGE_OPENING_QUALITY_RULE]);
  return report.approved ? skippedPageQualityReport() : report;
}

function pageQualityReportForRules(
  options: ReviewPageOptions,
  rules: readonly LocalPageQualityRule[]
): PageQualityReport {
  const context = localPageRuleContext(options);
  const checks: PageQualityReport["checks"] = { ...PASSING_PAGE_CHECKS };
  const issues: string[] = [];

  for (const rule of rules) {
    const findings = rule(context);
    if (!findings) {
      continue;
    }
    for (const finding of findings) {
      for (const failedCheck of finding.failedChecks) {
        checks[failedCheck] = false;
      }
      issues.push(finding.issue);
    }
  }

  return {
    approved: issues.length === 0,
    score: Math.max(0, 100 - issues.length * 25),
    issues,
    requiredRevisions: issues.map((issue) => `Fix: ${issue}`),
    notes: issues.length === 0 ? "Local quality checks passed." : "Local quality checks rejected the page.",
    groundedOk: true,
    unsupportedClaims: [],
    checks
  };
}

function localPageRuleContext(options: ReviewPageOptions): LocalPageRuleContext {
  const text = `${options.draft.title}\n${options.draft.markdown}`;
  const currentBody = options.draft.markdown.trim();
  // The phrase tables below are written with literal single spaces, so a page
  // that hard-wraps mid-phrase — or a model that emits a double space — walked
  // past them. `splitSentences` (`proseShape.ts`) collapses whitespace before
  // matching for exactly this reason; these checks did not. Only the checks
  // that read *flowing prose* take the collapsed copy: dialogue removal, dash
  // counting and the opening window all read the page as written, because line
  // structure is the signal they are built on.
  //
  // The title/body break survives the collapse, because it is a break between
  // two texts rather than inside one: glued together, a page called "The
  // Placeholder" whose prose opens "Page one begins…" reads as the literal
  // scaffold phrase `placeholder page` and auto-rejects a page with nothing
  // wrong with it. The breaks *inside* one text survive for the same reason,
  // which is `collapseHardWraps`' own note below: a hard wrap is one phrase
  // broken in half, and every other line break is two phrases.
  //
  // The body is collapsed once and the title's copy glued in front of it,
  // because `collapseHardWraps` trims each line itself and so answers
  // identically for `markdown` and for its trimmed twin. This runs for every
  // draft candidate of every page — page 1 of a balanced-and-up book has
  // several — and again for every page of `runLocalFinalQa`.
  const flowingBody = collapseHardWraps(currentBody);
  const flowingText = `${collapseHardWraps(options.draft.title)}\n${flowingBody}`;

  // The draft is one text scored against five, so its three sets are built here
  // rather than inside the loop — the whole reason the overlap rule below is
  // spelled over sets. The draft summary and each predecessor's summary are
  // tokenized once, with both summary sets derived from those tokens. Scoring
  // per pair instead put the draft body through five full shingle passes, its
  // summary through ten and every predecessor's through two, on a function that
  // runs for every draft candidate of every page and again for every page of
  // `runLocalFinalQa`: thousands of redundant tokenizations of a finished book,
  // all of them on the worker's own thread.
  //
  // **They are built inside the predecessor guard, because hoisting them out of
  // the loop also hoists them out of the loop's short circuit.** `.find` over an
  // empty list never calls its callback, so a page with nothing behind it used
  // to tokenize nothing at all; unhoisted work is skipped for free, hoisted work
  // is not. Left bare, every such call paid a full trigram pass over the whole
  // page body and two more over the summary and then read none of the three —
  // and "nothing behind it" is page 1 of every book, the one page best-of drafts
  // several candidates of, plus every `reviewPageDraftLocally` the bulk
  // strategies make with no `previousPages` at all.
  const recentPages = options.previousPages.slice(-5);
  const repeatedPage =
    recentPages.length > 0
      ? repeatedRecentPage(recentPages, currentBody, options.draft.summary)
      : undefined;
  // The treatment gate reads the draft against its finished chapter siblings
  // with the manuscript audit's own scorer, and skips every tokenization the
  // same way when there are none.
  const treatmentMatch = sameChapterTreatmentMatch(options);

  const kidsGuidance = kidsReadingGuidanceForInput(options.input);
  // countReadableWords is Unicode-aware; tokenize-based counts undercount or
  // zero out non-Latin scripts (e.g. Persian) and must not gate progression.
  const wordCount = countReadableWords(currentBody);
  const minWords = kidsGuidance?.targetWordsPerPage.min ?? (options.input.category === "STORY" ? 70 : 90);
  const adjacentPage = options.previousPages.at(-1);
  return {
    options,
    text,
    currentBody,
    flowingBody,
    flowingText,
    adjacentPage,
    normalizedDraftTitle: normalizeTitle(options.draft.title),
    repeatedPage,
    treatmentMatch,
    kidsGuidance,
    wordCount,
    minWords,
    sentenceStats: kidsGuidance ? sentenceLengthStats(currentBody) : undefined
  };
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

// Every class in this file that names an apostrophe names both: provider prose
// writes the typographic U+2019 far more often than the ASCII one, and a class
// that keeps only `'` splits "don’t" into a word and a dropped fragment while
// keeping "don't" whole — the same hole the phrase patterns had.
function normalizeTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/^page\s+\d+\s*[:-]\s*/i, "")
    .replace(/[^\p{L}\p{N}\s'’]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function hasFormulaicProofLeap(text: string): boolean {
  return PROOF_LEAP_PATTERNS.some((pattern) => pattern.test(text));
}

/**
 * The everyday half of the contrast-pair tell, which the adjacent-contrast
 * detector below deliberately misses: "It's not just a recipe, it's a
 * philosophy" carries no grandiose thesis word, so THESIS_ABSTRACTION_PATTERN
 * never fires on it. One instance is ordinary human prose; a page built on the
 * formula is the tell, so this counts occurrences and only fires on overuse —
 * two "punch" resolutions, or three setups on a single page.
 */
function hasFormulaicContrastOveruse(text: string): boolean {
  const setups = text.match(CONTRAST_SETUP_PATTERN)?.length ?? 0;
  if (setups < 2) {
    return false;
  }
  const punches = text.match(CONTRAST_PUNCH_PATTERN)?.length ?? 0;
  return punches >= 2 || setups >= 3;
}

function hasFormulaicAdjacentContrast(text: string): boolean {
  const sentences = splitSentences(text).filter((sentence) => overlapTokens(sentence).length >= 4);
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
  }
  return false;
}

/**
 * Scaffold is the *book* announcing its agenda, so this reads the page's own
 * narration and never a character's mouth. The patterns match a sentence, not
 * a speaker: `"In this chapter, we will learn about clouds," said Professor
 * Hoot` is correct KIDS/STORY prose — and neither category is exempt — yet it
 * flipped styleNatural on every draft candidate, so the quality loop spent its
 * whole revision budget rewriting dialogue that was already right.
 *
 * Voice is the distinction here, not position, which is why the scan still
 * covers the whole body instead of a leading window: an agenda sentence is
 * scaffold wherever it sits, and the "in the following pages, we will" twin is
 * usually the page's *last* line, so a leading window would quietly retire it.
 */
function hasChapterOpenerScaffold(body: string): boolean {
  const narration = narrationOutsideQuotedSpeech(body);
  return CHAPTER_OPENER_SCAFFOLD_PATTERNS.some((pattern) => pattern.test(narration));
}

/**
 * The page-1 twin of `hasVagueEnding`: the reader's first paragraph must not
 * be a stock hook. The list is deliberately tiny — every match costs 25 points
 * and auto-rejects, spending real revision budget — and it reads only the
 * page's opening window, so a character may say any of these lines and a later
 * paragraph may earn them. English-only like every pattern in this file; other
 * languages are carried by the model reviewer's first-page rule.
 *
 * **The window is measured on the page as written, and the dialogue is removed
 * from inside it — never the other way round.** Stripping first collapses every
 * quoted span to a single space and every blockquoted or dash-led line to the
 * empty string, so on a dialogue-heavy page the 280 surviving characters reach
 * far past the first paragraph: a first page opening on the French/Spanish/
 * Russian dash convention left a handful of newlines, and the window then
 * covered narration sitting ~900 characters into the page. A sixth-paragraph
 * "Have you ever wondered why the river stopped freezing?" auto-rejected page 1
 * and spent its revision budget — the exact prose the paragraph above promises
 * is safe. Truncating first can cut a closing quote off and read the tail of
 * the window as dialogue instead, which is the direction `stripQuotedSpans`
 * (`proseShape.ts`) already errs in deliberately: reading too much as dialogue only misses a
 * hook, reading too little fails a page that was right.
 */
export const FIRST_PAGE_OPENING_WINDOW = 280;

const WEAK_FIRST_PAGE_OPENER_PATTERNS = [
  /\bhave you ever (?:wondered|noticed|asked)\b/i,
  /\b(?:since|from) the dawn of (?:time|history|civilization)\b/i,
  /\bthroughout (?:history|the ages)\b/i,
  // `['’]`, like every other apostrophe in this file: a provider writes the
  // typographic one, so the straight-only class retired the single most
  // recognisable AI opener there is on the page it matters most on.
  /\bin today['’]s (?:fast-paced|modern|busy|digital) world\b/i,
  /\bimagine a world where\b/i
];

/**
 * Meta framing about the book itself, banned across the opening window for
 * **every** category. `buildPageInstruction` (`pagesShared.ts`) tells every
 * page-1 writer, whatever the book is, never to open with "throat-clearing, a
 * welcome, a definition of the topic, or meta framing such as 'In this book' or
 * 'This story is about'", and `FIRST_PAGE_IDENTITY_RULE`
 * (`pageBriefContract.ts`) briefs the same ban. `firstPageOpeningRule` grants the signposting categories
 * (`isSignpostingBookCategory`, `../categories.ts`) exactly one concession —
 * "you may signpost later on the page, never in the first paragraph" — and the
 * window below *is* that first paragraph, so an exemption here excused the one
 * place the instruction never did: the checker approving the exact sentence its
 * own writer had been forbidden to write. Signposting stays legal everywhere
 * this check does not look, which is what `hasChapterOpenerScaffold` — whole
 * page, category-gated — is for.
 */
const META_FIRST_PAGE_OPENER_PATTERNS = [
  /\bthis (?:book|story) (?:is about|will (?:show|teach|take))\b/i,
  // The phrase both prompts quote verbatim, plus the two variants that carry
  // the same framing. A reader or author subject is required rather than the
  // bare "in this book", which a history page's own prose can own ("In this
  // book of hours, a clerk recorded…").
  /\b(?:in|throughout) (?:this book|these pages)\s*,?\s+(?:we|you|i|the reader|the author)\b/i
];

/**
 * Meta framing that only means what it means as the page's *first* words.
 * "Welcome to" is a greeting at the top of page 1 and ordinary prose in the
 * middle of a paragraph ("the lit porch was a welcome to anyone walking up"),
 * so this list alone is anchored, and the window patterns above are not.
 */
const OPENING_WORDS_META_PATTERNS = [/^welcome to\b/i];

/**
 * **Whitespace is collapsed last, after the window and after the dialogue
 * strip, and never before either.** The window is a count of the page as
 * written and the strip is line-based, so collapsing first destroys both: a
 * page opening on the dash convention becomes one line whose first character is
 * a dash, `narrationOutsideQuotedSpeech` discards the whole page as dialogue,
 * and the gate silently stops looking at anything. Collapsing last leaves both
 * boundary fixtures meaning exactly what they meant — they are built from
 * single-spaced prose, where the collapse is the identity — and closes the hole
 * the patterns' literal spaces left: `"Have you ever\nwondered why the river
 * stopped freezing?"` is the most recognisable AI opener there is, and a hard
 * wrap inside the phrase was enough to pass it. That the collapse now keeps
 * every break but a hard wrap changes nothing about the order: it only ever
 * joins *less* than a flat collapse, and the strip has already emptied the
 * dialogue lines it would refuse to join.
 */
function hasWeakFirstPageOpening(body: string): boolean {
  const written = body.slice(0, FIRST_PAGE_OPENING_WINDOW);
  const narration = narrationOutsideQuotedSpeech(written);
  const opening = collapseHardWraps(narration);
  if (WEAK_FIRST_PAGE_OPENER_PATTERNS.some((pattern) => pattern.test(opening))) {
    return true;
  }
  if (META_FIRST_PAGE_OPENER_PATTERNS.some((pattern) => pattern.test(opening))) {
    return true;
  }
  return firstPageOpeningCandidates(narration, written).some((candidate) =>
    OPENING_WORDS_META_PATTERNS.some((pattern) => pattern.test(candidate))
  );
}

/**
 * What the anchored patterns above are anchored to: the narration's first
 * *word*, not its first character. `^` against the raw narration was the whole
 * test, and `narrationOutsideQuotedSpeech` keeps headings and emphasis markers
 * verbatim, so `**Welcome to the world of home water testing.** The kit…`
 * begins with `*` and the exact sentence this file's own comment says must
 * never pass was approved — as it was for `## Tap Water\n\nWelcome to…`, which
 * models emit in front of the prose despite INTERNAL_PAGE_TITLE_RULE. So
 * leading whitespace and markdown decoration are dropped, and a leading ATX
 * heading is a page title the writer was told not to write at all: the line
 * after it is offered as an opening too, and the heading's own text stays a
 * candidate, since `# Welcome to…` is the same greeting.
 *
 * It stays *only* the opening. Scanning stops at the first line that is not a
 * heading, so a later paragraph is never a candidate — the property the window
 * boundary tests pin, and the reason a mid-page "welcome to" costs a page
 * nothing.
 *
 * **A line the dialogue strip emptied is not a blank line, which is the whole
 * reason the page as written is read alongside the narration.** Only the
 * written line tells a paragraph break from a line `narrationOutsideQuotedSpeech`
 * mapped to `""`, and skipping both is skipping past the dialogue: a page
 * opening on four dash-convention lines took its first *candidate* from the
 * narration paragraph ~200 characters in, so a later "Welcome to the museum"
 * auto-rejected page 1 for 25 points and a revision call — the promise two
 * paragraphs up, broken. A page whose opening prose is dialogue has no
 * narration opening at all, and the greeting rule has nothing to say about it;
 * stopping there errs the way this whole window errs, since reading too little
 * only misses a hook while reading too much fails a page that was right. The
 * two splits line up index for index because `narrationOutsideQuotedSpeech`
 * maps a line to a line and joins them back.
 */
function firstPageOpeningCandidates(narration: string, written: string): string[] {
  const lines = narration.split(/\r?\n/);
  const writtenLines = written.split(/\r?\n/);
  const candidates: string[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    if (line.trim().length === 0) {
      // Blank here and blank on the page is a paragraph break; blank here and
      // prose on the page is the dialogue this page opens on.
      if ((writtenLines[index] ?? "").trim().length > 0) {
        break;
      }
      continue;
    }
    const opening = line.replace(LEADING_MARKDOWN_DECORATION_PATTERN, "");
    if (opening.length === 0) {
      continue;
    }
    // A candidate is its line *plus the rest of the window*, collapsed: the
    // anchored patterns are anchored to a line's first word, and a page that
    // hard-wraps between "Welcome" and "to" put the second half on a line no
    // pattern was ever matched against. Carrying the tail cannot widen what
    // counts as an opening — `^` still has to land on a line this loop chose,
    // and it chooses no line after the first non-heading one.
    candidates.push(collapseHardWraps([opening, ...lines.slice(index + 1)].join(" ")));
    if (!ATX_HEADING_LINE_PATTERN.test(line)) {
      break;
    }
  }
  return candidates;
}

/**
 * One line of flowing prose *per unit*, for the phrase patterns in this file
 * that spell their gaps as literal single spaces: inside one unit a hard wrap
 * or a run of spaces becomes a single space, and every other line break
 * survives as a single `\n`. Every caller has already taken whatever it needs
 * from the line structure, because this destroys all of it but those breaks.
 *
 * **A hard wrap is a single newline between two lines that are each the middle
 * of one unit of prose, and nothing else is.** A line that opens a unit of its
 * own — a heading, a list item, a blockquote, a table row, a thematic break, a
 * code fence, a standalone image, a line of dialogue (`OWN_UNIT_LINE_PATTERN`)
 * — was never one sentence with the line beside it, so the break is kept
 * whenever *either* side of it is such a line. A wrapped continuation of a list
 * item or of a dialogue line is therefore left broken rather than guessed at:
 * rejoining it would take the indentation rules of the block it continues, and
 * the two directions do not cost the same. A break kept where a hard wrap sat
 * only misses a slop phrase; a break removed where a unit ended fails a page
 * that was right, for 25 points and a revision call.
 *
 * **Those breaks are what bound every windowed pattern in this file, which is
 * why the bound is drawn exactly here and not one step looser.** The collapse
 * exists because `"Have you ever\nwondered why…"` is one phrase a literal space
 * could not match; but `.` does not match `\n` without the `s` flag, so every
 * newline removed hands `.{0,80}` (`VAGUE_ENDING_PATTERNS`), `.{0,100}`
 * (`FABRICATED_RESEARCH_PATTERNS`), `.{0,140}` (`PROOF_LEAP_PATTERNS`) and the
 * literal tables (`/placeholder page/i`) reach they never had. Flattening the
 * page whole cost a finished final page 25 points, an auto-rejection and a
 * revision call: "She had nothing left to give." and a next paragraph opening
 * "Everything about the morning felt heavier now" became one line and matched
 * `/\bnothing\b.{0,80}\beverything\b/` with no resolution word anywhere near
 * them. Keeping only the blank line cost exactly the same to two list items —
 * "- The map I invented for the frontispiece" over "- Data from the 1902
 * soundings" is `\binvented\b.{0,100}\bdata\b` — and to any block of dialogue,
 * which is written one line per speaker with no blank line anywhere in it.
 */
function collapseHardWraps(text: string): string {
  const units: string[] = [];
  let continuing = false;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/\s+/g, " ").trim();
    if (line.length === 0) {
      continuing = false;
      continue;
    }
    const opensItsOwnUnit = OWN_UNIT_LINE_PATTERN.test(line);
    const previous = units.length - 1;
    if (continuing && !opensItsOwnUnit && previous >= 0) {
      units[previous] = `${units[previous]!} ${line}`;
    } else {
      units.push(line);
    }
    continuing = !opensItsOwnUnit;
  }
  return units.join("\n");
}

/**
 * A line that is a unit of its own rather than the middle of a paragraph,
 * tested against the line with its own whitespace already collapsed away.
 *
 * The markdown half is the block syntax a model actually emits into a page:
 * ATX heading, bullet or ordered list item, blockquote, table row, thematic
 * break, code fence, standalone image. Both list markers require the space
 * after them, so `**Welcome to…**` stays the prose it is. The dialogue half is
 * the recognition `narrationOutsideQuotedSpeech` (`proseShape.ts`) already
 * makes when it decides a whole line is speech: an em/en dash opening the line
 * is the French/Spanish/Russian convention, and the openers are
 * `DIALOGUE_QUOTE_CLOSERS`' keys — spelled again here because that map is
 * private to its file, and carrying its deliberate omission of the straight
 * apostrophe, which would make a unit of every line beginning "It's".
 */
const OWN_UNIT_LINE_PATTERN =
  /^(?:#{1,6}(?:\s|$)|[-*+]\s|\d{1,9}[.)]\s|[-*_]{3,}$|>|\||!\[|```|~~~|[—–]|["“„‘«»「『])/;

const LEADING_MARKDOWN_DECORATION_PATTERN = /^[\s#*_~`>+-]+/;
const ATX_HEADING_LINE_PATTERN = /^\s{0,3}#{1,6}(?:\s|$)/;

function hasVagueEnding(draft: PageDraft): boolean {
  // Collapsed for the same reason the phrase tables above are: these are
  // literal-space patterns, and "into the\nunknown" is the shape a page ends
  // on as often as not. Each half is collapsed on its own, so no phrase is
  // assembled out of the last words of the prose and the first of the summary
  // — and `collapseHardWraps` keeps every break inside each half that is not a
  // hard wrap, which is what bounds this list's one windowed pattern: a final
  // page reading "She had nothing left to give.\n\nEverything about the
  // morning felt heavier" is two sentences a paragraph apart, and the same two
  // clauses in two speakers' mouths are two lines of a dialogue block — not
  // the "nothing … everything" shrug `/\bnothing\b.{0,80}\beverything\b/` is
  // looking for.
  const endingText = `${collapseHardWraps(draft.markdown)}\n${collapseHardWraps(draft.summary)}`.toLowerCase();
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

/**
 * Forward-looking chapter scaffold: prose that announces the chapter's agenda
 * instead of being the chapter. PAGE_BRIEF_META_LANGUAGE_PATTERNS covers the
 * closing/transition shapes; these are their opening twins. Which categories
 * are allowed to signpost is `isSignpostingBookCategory` (`../categories.ts`),
 * beside every other per-category rule; `hasChapterOpenerScaffold` above is
 * what decides where on the page these are allowed to match.
 */
const CHAPTER_OPENER_SCAFFOLD_PATTERNS = [
  /\b(?:in|throughout)\s+this\s+(?:chapter|section|book|guide)\s*,?\s+(?:we|you|i)\s+(?:will|['’]ll|shall|are\s+going\s+to)\b/i,
  /\bthis\s+(?:chapter|section|part|guide)\s+(?:will\s+)?(?:explores?|examines?|covers?|introduces?|discusses?|outlines?|delves?\s+into|looks?\s+at)\b/i,
  /\bby\s+the\s+end\s+of\s+this\s+(?:chapter|section|book|guide)\s*,?\s+(?:we|you)\b/i,
  /\bin\s+the\s+(?:following|next)\s+(?:pages|sections)\s*,?\s+(?:we|you|i)\s+(?:will|['’]ll)\b/i
];

/**
 * "not just X" — the setup half of the everyday contrast formula. "not only"
 * is deliberately absent: it is the ordinary correlative ("not only builders,
 * but also arbiters"), standard prose in any register, not the slop formula.
 */
const CONTRAST_SETUP_PATTERN = /\b(?:not|isn['’]?t|aren['’]?t|wasn['’]?t|weren['’]?t)\s+(?:just|merely|simply)\b/gi;

/**
 * The punch: "…not just X — it's Y" / "…not just X. It is Y." No "but" before
 * the pronoun: "not simply X, but they were Y" is the correlative again, and
 * the formula's tell is the pronoun restarting the clause bare.
 */
const CONTRAST_PUNCH_PATTERN =
  /\b(?:not|isn['’]?t|aren['’]?t|wasn['’]?t|weren['’]?t)\s+(?:just|merely|simply)\b[^.!?؟\n]{0,80}[.,;:—–-]\s*(?:it|this|that|she|he|they|we)\s*(?:['’](?:s|re)|\s+(?:is|was|are|were))\b/gi;

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
