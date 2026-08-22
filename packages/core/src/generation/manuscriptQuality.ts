import { MANUSCRIPT_PROMPT_LEAK_PATTERNS, containsPromptLeak } from "./promptLeak.js";

export type ManuscriptQualityState = "passed" | "review_recommended" | "blocked";
export type ManuscriptQualitySeverity = "error" | "warning";
export type ManuscriptQualitySource = "deterministic" | "model";

export type ManuscriptQualityIssue = {
  code: string;
  severity: ManuscriptQualitySeverity;
  source: ManuscriptQualitySource;
  message: string;
  guidance: string;
  affectedPageIndexes: number[];
};

export type ManuscriptQualityReport = {
  state: ManuscriptQualityState;
  score: number;
  issues: ManuscriptQualityIssue[];
  affectedPageIndexes: number[];
  checkedAt: string;
};

export type ManuscriptIntegrityPage = {
  index: number;
  title: string;
  markdown: string;
};

export function runDeterministicManuscriptChecks(options: {
  pages: ManuscriptIntegrityPage[];
  expectedPageCount: number;
}): ManuscriptQualityIssue[] {
  const issues: ManuscriptQualityIssue[] = [];
  const pages = [...options.pages].sort((a, b) => a.index - b.index);
  if (pages.length === 0) {
    issues.push(issue("MISSING_PAGES", "No manuscript pages were generated.", "Regenerate the book before exporting.", []));
    return issues;
  }
  if (pages.length !== options.expectedPageCount) {
    issues.push(
      issue(
        "PAGE_COUNT_MISMATCH",
        `The manuscript has ${pages.length} pages but ${options.expectedPageCount} were expected.`,
        "Regenerate missing pages or correct the plan's page count.",
        pages.map((page) => page.index)
      )
    );
  }
  const indexes = pages.map((page) => page.index);
  const expectedIndexes = Array.from({ length: pages.length }, (_, index) => index + 1);
  if (new Set(indexes).size !== indexes.length || indexes.some((value, index) => value !== expectedIndexes[index])) {
    issues.push(
      issue(
        "PAGE_INDEX_INVALID",
        "Page indexes contain a duplicate, gap, or out-of-order value.",
        "Repair page ordering before publishing.",
        indexes
      )
    );
  }

  // Stripped and tokenized once per page, and shared by every check below:
  // the near-duplicate loop is n(n-1)/2 comparisons, and a 60-page book was
  // re-running `plainMarkdown` plus the word regex ~3,500 times over the same
  // prose — and each book-level repetition check would otherwise pay a full
  // pass of its own on every compile.
  const pageTexts = pages.map((page) => plainMarkdown(page.markdown));
  const pageTokens = pageTexts.map((plain) => tokenizePage(plain));

  for (let pageIndex = 0; pageIndex < pages.length; pageIndex += 1) {
    const page = pages[pageIndex]!;
    const plain = pageTexts[pageIndex]!;
    if (!page.title.trim() || !plain) {
      issues.push(
        issue(
          "EMPTY_PAGE",
          `Page ${page.index} has an empty title or body.`,
          "Open Edit Mode or regenerate this page.",
          [page.index]
        )
      );
    }
    if (containsPromptLeak(page.markdown, MANUSCRIPT_PROMPT_LEAK_PATTERNS)) {
      issues.push(
        issue(
          "PROMPT_LEAKAGE",
          `Page ${page.index} appears to expose generation instructions or hidden prompt text.`,
          "Regenerate this page without internal instructions.",
          [page.index]
        )
      );
    }
    if (containsPlaceholder(page.markdown)) {
      issues.push(
        issue(
          "PLACEHOLDER_TEXT",
          `Page ${page.index} contains placeholder text.`,
          "Replace the placeholder in Edit Mode or regenerate the page.",
          [page.index]
        )
      );
    }
    if (hasMalformedMarkdown(page.markdown)) {
      issues.push(
        issue(
          "MALFORMED_MARKDOWN",
          `Page ${page.index} contains malformed Markdown.`,
          "Fix unmatched code fences, links, or footnotes in Edit Mode.",
          [page.index]
        )
      );
    }
    if (hasUnsupportedFootnote(page.markdown)) {
      issues.push(
        issue(
          "UNSUPPORTED_CITATION",
          `Page ${page.index} references a citation that has no matching definition.`,
          "Add the missing source definition or remove the citation reference.",
          [page.index]
        )
      );
    }
  }

  const wordSets = pageTokens.map((tokens) => distinctWords(tokens));
  for (let left = 0; left < pages.length; left += 1) {
    for (let right = left + 1; right < pages.length; right += 1) {
      if (nearDuplicateWordSets(wordSets[left]!, wordSets[right]!)) {
        issues.push(
          issue(
            "NEAR_DUPLICATE_PAGES",
            `Pages ${pages[left]!.index} and ${pages[right]!.index} are nearly identical.`,
            "Regenerate one of these pages with its distinct page brief.",
            [pages[left]!.index, pages[right]!.index]
          )
        );
      }
    }
  }
  issues.push(
    ...repeatedPhraseIssues(pages, pageTexts, pageTokens),
    ...repeatedOpeningIssues(pages, pageTexts, pageTokens)
  );
  return issues;
}

/** Readable words one repeated phrase spans, in every script. */
const REPEATED_PHRASE_SHINGLE_WORDS = 4;
const REPEATED_PHRASE_MIN_LENGTH = 18;
const REPEATED_PHRASE_ISSUE_CAP = 3;
const REPEATED_PHRASE_MIN_PAGES_FLOOR = 6;
/** Readable words a page's opening move spans, in every script. */
const REPEATED_OPENING_WORDS = 4;
const REPEATED_OPENING_MIN_LENGTH = 12;
const REPEATED_OPENING_ISSUE_CAP = 3;
const REPEATED_OPENING_MIN_PAGES_FLOOR = 3;
// Pages under this are picture-book-shaped, where a refrain and a recurring
// opening are craft rather than a defect, so neither repetition check reads
// them — the same reason NEAR_DUPLICATE_MIN_WORDS keeps the pair check off
// short pages. Counted by `measureWords`, never in space-delimited runs: a full
// Chinese page is ~30 runs, so a run count put every zh/ja book under this floor
// and quietly switched all three checks off for those languages.
const REPETITION_MIN_PAGE_WORDS = 80;
const REPETITION_MIN_PAGE_FRACTION = 0.15;

/**
 * Either repetition warning flips an otherwise clean report from a full compile
 * to "review_recommended" — the in-app quality card and the completion message —
 * so each has to stay rare on ordinary prose. Scaling with the book is what
 * keeps it rare: three pages opening alike are a tic in a 10-page book and a
 * coincidence in a 30-page one. The floors carry short books, and the phrase
 * floor is double the opening one because any 4-gram anywhere on a page is a
 * far noisier signal than the four words a page opens with.
 */
function repetitionMinPages(pageCount: number, floor: number): number {
  return Math.max(floor, Math.ceil(pageCount * REPETITION_MIN_PAGE_FRACTION));
}

/**
 * The book-level repetition no per-page window can see: a distinctive phrase
 * recurring every few pages passes the 5-page repetition check on every one
 * of them, and the near-duplicate check above only fires on whole pages that
 * are almost identical. Warning severity on purpose — a repeated phrase can be
 * a deliberate refrain, so it is surfaced for review rather than blocking the
 * export or feeding the repair loop.
 *
 * Two passes keep the whole-book state to one counter per distinct shingle: a
 * 300-page book carries ~120k of them, and retaining a string plus an owner
 * Set for each was tens of MB on every compile. Pass one counts pages per
 * shingle *hash*; only the hashes that reach the page threshold get their
 * strings and owners built in pass two, which re-applies the threshold per
 * real string — a hash collision can promote a shingle into pass two, never
 * flag it.
 */
function repeatedPhraseIssues(
  pages: ManuscriptIntegrityPage[],
  pageTexts: string[],
  pageTokens: PageTokens[]
): ManuscriptQualityIssue[] {
  const minPages = repetitionMinPages(pages.length, REPEATED_PHRASE_MIN_PAGES_FLOOR);
  // Rebuilt per pass rather than kept for the whole book: a Chinese page's
  // stream is one unit per character, and retaining 300 pages of them is the
  // memory this two-pass shape exists to avoid. Building one is a linear scan.
  const laneFor = (pageIndex: number): RepetitionLane | null => {
    const tokens = pageTokens[pageIndex]!;
    // Pages under the picture-book floor are skipped whole — see
    // REPETITION_MIN_PAGE_WORDS.
    return tokens.wordCount < REPETITION_MIN_PAGE_WORDS
      ? null
      : repetitionLane(pageTexts[pageIndex]!, tokens, {
          words: REPEATED_PHRASE_SHINGLE_WORDS,
          minKeyLength: REPEATED_PHRASE_MIN_LENGTH
        });
  };
  const candidates = candidateShingleHashes(pages.length, laneFor, minPages);
  if (candidates.size === 0) {
    return [];
  }

  const pagesByShingle = new Map<string, { owners: Set<number>; quote: string }>();
  for (let pageIndex = 0; pageIndex < pages.length; pageIndex += 1) {
    const lane = laneFor(pageIndex);
    if (!lane) {
      continue;
    }
    forEachDistinctShingle(lane, (hash, start) => {
      if (!candidates.has(hash)) {
        return;
      }
      // Grouped by the normalized key, reported as the page spells it: two
      // pages agreeing on a phrase is a fact about the words, and the reader
      // has to be able to find the phrase they are being told to vary.
      const key = lane.keyAt(start);
      const entry = pagesByShingle.get(key) ?? { owners: new Set<number>(), quote: lane.quoteAt(start) };
      entry.owners.add(pages[pageIndex]!.index);
      pagesByShingle.set(key, entry);
    });
  }

  const flagged = [...pagesByShingle.values()]
    .filter((entry) => entry.owners.size >= minPages)
    .sort((left, right) => right.owners.size - left.owners.size);
  const issues: ManuscriptQualityIssue[] = [];
  // A repeated sentence yields several overlapping shingles over the same
  // pages; one issue per distinct page set keeps the report readable.
  const reportedPageSets = new Set<string>();
  for (const entry of flagged) {
    const affected = [...entry.owners].sort((a, b) => a - b);
    const pageSetKey = affected.join(",");
    if (reportedPageSets.has(pageSetKey)) {
      continue;
    }
    reportedPageSets.add(pageSetKey);
    issues.push(
      warningIssue(
        "REPEATED_PHRASE",
        `The phrase "${entry.quote}" recurs on ${affected.length} pages.`,
        "Vary the wording on most of these pages, or keep it only where the repetition is deliberate.",
        affected
      )
    );
    if (issues.length >= REPEATED_PHRASE_ISSUE_CAP) {
      break;
    }
  }
  return issues;
}

/** Pass one: pages per shingle hash, so only shingles that genuinely recur ever materialize as strings. */
function candidateShingleHashes(
  pageCount: number,
  laneFor: (pageIndex: number) => RepetitionLane | null,
  minPages: number
): Set<number> {
  const pagesByHash = new Map<number, number>();
  for (let pageIndex = 0; pageIndex < pageCount; pageIndex += 1) {
    const lane = laneFor(pageIndex);
    if (!lane) {
      continue;
    }
    forEachDistinctShingle(lane, (hash) => {
      pagesByHash.set(hash, (pagesByHash.get(hash) ?? 0) + 1);
    });
  }
  const candidates = new Set<number>();
  for (const [hash, count] of pagesByHash) {
    if (count >= minPages) {
      candidates.add(hash);
    }
  }
  return candidates;
}

/**
 * Visits a page's qualifying shingles as an FNV-1a-style hash of the shingle's
 * own text without ever building the string, deduplicated within the page;
 * `start` lets pass two rebuild the key and the quote for the few hashes it
 * wants.
 */
function forEachDistinctShingle(lane: RepetitionLane, visit: (hash: number, start: number) => void): void {
  const seen = new Set<number>();
  for (let start = 0; start < lane.count; start += 1) {
    const hash = lane.hashAt(start);
    if (hash === null || seen.has(hash)) {
      continue;
    }
    seen.add(hash);
    visit(hash, start);
  }
}

/** Pages that keep opening with the same move ("As the sun set…"). */
function repeatedOpeningIssues(
  pages: ManuscriptIntegrityPage[],
  pageTexts: string[],
  pageTokens: PageTokens[]
): ManuscriptQualityIssue[] {
  const minPages = repetitionMinPages(pages.length, REPEATED_OPENING_MIN_PAGES_FLOOR);
  const pagesByOpening = new Map<string, { owners: number[]; quote: string }>();
  for (let pageIndex = 0; pageIndex < pages.length; pageIndex += 1) {
    const tokens = pageTokens[pageIndex]!;
    if (tokens.wordCount < REPETITION_MIN_PAGE_WORDS) {
      continue;
    }
    const sentence = firstSentence(pageTexts[pageIndex]!);
    // Read in the *page's* script, not the sentence's: one English line in a
    // Chinese book is still a page of a Chinese book, and the openings have to
    // be measured the same way on every page or nothing groups.
    const lane = repetitionLane(
      sentence,
      { ...tokenizePage(sentence), script: tokens.script },
      { words: REPEATED_OPENING_WORDS, minKeyLength: REPEATED_OPENING_MIN_LENGTH }
    );
    // No opening at all when the sentence is shorter than one shingle, or (in a
    // spaced script) too short to be distinctive.
    if (lane.count === 0 || lane.hashAt(0) === null) {
      continue;
    }
    const key = lane.keyAt(0);
    const entry = pagesByOpening.get(key) ?? { owners: [], quote: lane.quoteAt(0) };
    entry.owners.push(pages[pageIndex]!.index);
    pagesByOpening.set(key, entry);
  }

  return [...pagesByOpening.values()]
    .filter((entry) => entry.owners.length >= minPages)
    .sort((left, right) => right.owners.length - left.owners.length)
    .slice(0, REPEATED_OPENING_ISSUE_CAP)
    .map((entry) =>
      warningIssue(
        "REPEATED_OPENING",
        `${entry.owners.length} pages open with the same move ("${entry.quote}…").`,
        "Rework most of these openings so consecutive pages do not start the same way.",
        [...entry.owners].sort((a, b) => a - b)
      )
    );
}

function firstSentence(plain: string): string {
  return plain.split(SENTENCE_BOUNDARY_PATTERN)[0] ?? "";
}

export type ManuscriptQualityReportOptions = {
  /**
   * Whether the compile that produced these issues ran the full review, or only
   * the deterministic checks. Stated by the caller, never inferred from what the
   * issue lists happen to hold.
   */
  finalReviewRan: boolean;
};

/**
 * Turns one compile's findings into the verdict the app reads off the book.
 *
 * `finalReviewRan` decides whether a *warning* may recommend review, and it is
 * the compile's own statement about itself. A full compile grades a book nobody
 * has graded yet, so every warning it raises is news. A deterministic-only
 * compile is not grading anything: every `skipFinalReview` recompile — an undo,
 * a verified exact replacement, a chat edit's apply — re-runs the whole-book
 * checks over prose the edit never touched, and those jobs *do* own the quality
 * verdict (`jobOwnsQualityVerdict` in `packages/core/src/jobScope.ts` excludes
 * only detached repairs and presentation reprints). So a book that passed months
 * ago came back "review recommended" for a repeated phrase its own first compile
 * had already accepted, on the strength of a free edit — and permanently, since
 * the export repair pass filters to `severity === "error"`: a warning is
 * unfixable, so every later recompile re-asserted it.
 *
 * Two things are deliberately outside that gate. An **error** blocks whatever
 * ran, because publication integrity is never bypassed by an edit. And a model
 * finding always speaks, because only a full review can produce one.
 *
 * The warnings themselves stay in `issues` and still cost score either way: they
 * are what this compile saw, worth having on the job row for an operator reading
 * it. Only the `state` is the claim the app acts on.
 */
export function buildManuscriptQualityReport(
  deterministicIssues: ManuscriptQualityIssue[],
  modelIssues: ManuscriptQualityIssue[],
  options: ManuscriptQualityReportOptions
): ManuscriptQualityReport {
  const issues = [...deterministicIssues, ...modelIssues];
  const blocked = deterministicIssues.some((entry) => entry.severity === "error");
  const deterministicWarnings = deterministicIssues.filter((entry) => entry.severity === "warning").length;
  const state: ManuscriptQualityState = blocked
    ? "blocked"
    : modelIssues.length > 0 || (options.finalReviewRan && deterministicWarnings > 0)
      ? "review_recommended"
      : "passed";
  const score = Math.max(
    0,
    100 -
      deterministicIssues.filter((entry) => entry.severity === "error").length * 18 -
      (modelIssues.length + deterministicWarnings) * 5
  );
  return {
    state,
    score,
    issues,
    affectedPageIndexes: [...new Set(issues.flatMap((entry) => entry.affectedPageIndexes))].sort((a, b) => a - b),
    checkedAt: new Date().toISOString()
  };
}

/**
 * Adds a post-hoc issue (e.g. an export artifact failure discovered after the
 * manuscript checks ran) to an existing report, recomputing state and score
 * with the same weights as buildManuscriptQualityReport. State never improves:
 * a warning bumps "passed" to "review_recommended"; a deterministic error
 * blocks.
 */
export function appendQualityIssue(
  report: ManuscriptQualityReport,
  issue: ManuscriptQualityIssue
): ManuscriptQualityReport {
  const blocked = report.state === "blocked" || (issue.severity === "error" && issue.source === "deterministic");
  return {
    ...report,
    state: blocked ? "blocked" : "review_recommended",
    score: Math.max(0, report.score - (issue.severity === "error" ? 18 : 5)),
    issues: [...report.issues, issue],
    affectedPageIndexes: [...new Set([...report.affectedPageIndexes, ...issue.affectedPageIndexes])].sort(
      (a, b) => a - b
    )
  };
}

function issue(
  code: string,
  message: string,
  guidance: string,
  affectedPageIndexes: number[]
): ManuscriptQualityIssue {
  return { code, severity: "error", source: "deterministic", message, guidance, affectedPageIndexes };
}

function warningIssue(
  code: string,
  message: string,
  guidance: string,
  affectedPageIndexes: number[]
): ManuscriptQualityIssue {
  return { code, severity: "warning", source: "deterministic", message, guidance, affectedPageIndexes };
}

function plainMarkdown(value: string): string {
  return value
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/!??\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/[#>*_`~-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function containsPlaceholder(value: string): boolean {
  return /\b(?:TODO|TBD|FIXME|LOREM IPSUM|PLACEHOLDER)\b|\[(?:insert|add|write|placeholder|todo)[^\]]*\]/i.test(value);
}

function hasMalformedMarkdown(value: string): boolean {
  const fences = value.match(/```/g)?.length ?? 0;
  if (fences % 2 !== 0) return true;
  const links = value.match(/\[[^\]]*\]\([^)]*$/gm);
  return Boolean(links?.length);
}

function hasUnsupportedFootnote(value: string): boolean {
  const references = [...value.matchAll(/\[\^([^\]]+)\](?!:)/g)].map((match) => match[1]);
  if (references.length === 0) return false;
  const definitions = new Set([...value.matchAll(/^\[\^([^\]]+)\]:/gm)].map((match) => match[1]));
  return references.some((reference) => reference && !definitions.has(reference));
}

const NEAR_DUPLICATE_MIN_WORDS = 80;
const NEAR_DUPLICATE_JACCARD = 0.9;

/**
 * A page's distinct words, or `undefined` for a page too short to compare.
 *
 * Hoisting the length floor in here is what keeps the pair loop from
 * re-deciding it: a book's short pages are short for every pair they appear in.
 */
function distinctWords(tokens: PageTokens): Set<string> | undefined {
  return tokens.wordCount < NEAR_DUPLICATE_MIN_WORDS ? undefined : new Set(tokens.values);
}

function nearDuplicateWordSets(left: Set<string> | undefined, right: Set<string> | undefined): boolean {
  if (!left || !right) return false;
  // |A∩B| ≤ min(|A|,|B|) and |A∪B| ≥ max(|A|,|B|), so J ≤ min/max. Two pages
  // whose vocabularies differ in size by more than a tenth cannot reach the
  // threshold, and are rejected without walking either set.
  const smaller = left.size <= right.size ? left : right;
  const larger = smaller === left ? right : left;
  if (larger.size === 0 || smaller.size / larger.size < NEAR_DUPLICATE_JACCARD) return false;

  let intersection = 0;
  for (const word of smaller) {
    if (larger.has(word)) intersection += 1;
  }
  // |A∪B| = |A| + |B| − |A∩B|, so the union needs no second set built.
  const union = left.size + right.size - intersection;
  return union > 0 && intersection / union >= NEAR_DUPLICATE_JACCARD;
}

/**
 * One page's text, measured the three ways every check below reads it.
 *
 * `values` are lowercased letter/digit runs — one per space-delimited word in a
 * script that has spaces, one per *clause* in a script that does not. Which is
 * exactly why nothing may count them as words: see `wordCount`.
 */
type PageTokens = {
  values: string[];
  /** Where `values[i]` starts and ends in the page's plain text, so a finding can be quoted as written. */
  starts: number[];
  ends: number[];
  /** Readable words, estimated per script — never `values.length`. */
  wordCount: number;
  /** The script writing most of this page, when that script puts no spaces between words. */
  script: NonSpacedScript | null;
};

/**
 * Marks are inside the token, which is the half that used to be missing.
 * `[\p{L}\p{N}]+` breaks a run at every combining mark, so vocalized Arabic
 * («الْكِتَابُ») and Thai came apart into single base letters: a four-token
 * shingle was four letters, far under the 18-character bar, so both repetition
 * checks were dead in those scripts — and any finding that did survive quoted
 * the mark-stripped debris back to the reader. NFD Latin had the same split.
 */
const WORD_TOKEN_PATTERN = /[\p{L}\p{N}\p{M}]+(?:['’-][\p{L}\p{N}\p{M}]+)*/gu;
/** The same class, one character at a time, for the character lane. */
const WORD_CHARACTER_PATTERN = /[\p{L}\p{N}\p{M}]/u;

/** Callers hand this `plainMarkdown` output; stripping is hoisted so each page pays it once. */
function tokenizePage(plain: string): PageTokens {
  const values: string[] = [];
  const starts: number[] = [];
  const ends: number[] = [];
  for (const match of plain.matchAll(WORD_TOKEN_PATTERN)) {
    const raw = match[0];
    const start = match.index ?? 0;
    values.push(raw.toLowerCase());
    starts.push(start);
    ends.push(start + raw.length);
  }
  return { values, starts, ends, ...measureWords(values) };
}

/**
 * How many words a reader reads here, and in which script.
 *
 * A local counterpart of `countReadableWords` in `proseShape.ts`, which exports
 * it: same rule (a CJK character is half a word, an unsegmented Southeast Asian
 * one a quarter, a combining mark none of one), summed over the page rather
 * than rounded up per run. Counting runs instead is what made every check below
 * inert in Chinese and Japanese: a full ~1100 character page is ~30 runs, so the
 * 80-word picture-book floor skipped it, and a book with the same sentence on
 * twenty pages sailed through.
 *
 * Deliberately a twin rather than a call, so this file's checks cannot be moved
 * by a change made for the page gates. The rounding above is the intended
 * divergence; one more is known and unintended, kept here so nobody "fixes" it
 * blind: a token of combining marks alone, in a script outside the CJK/SEA
 * sets, is one word here and none there — `NON_SPACED_CHARACTER_PATTERN` fails,
 * so the token is banked as a spaced word before any character is inspected,
 * while `countReadableWords` skips every mark and reaches zero. It needs a mark
 * standing alone between separators, so it moves Indic and NFD-Latin counts
 * only, and by less than the per-run rounding already does.
 */
function measureWords(tokens: string[]): { wordCount: number; script: NonSpacedScript | null } {
  let spacedWords = 0;
  let cjkCharacters = 0;
  let unsegmentedCharacters = 0;
  for (const token of tokens) {
    if (!NON_SPACED_CHARACTER_PATTERN.test(token)) {
      spacedWords += 1;
      continue;
    }
    let spacedCharacters = 0;
    for (const character of token) {
      if (COMBINING_MARK_PATTERN.test(character)) {
        continue;
      }
      if (CJK_SCRIPT.pattern.test(character)) {
        cjkCharacters += 1;
      } else if (UNSEGMENTED_SCRIPT.pattern.test(character)) {
        unsegmentedCharacters += 1;
      } else {
        spacedCharacters += 1;
      }
    }
    if (spacedCharacters > 0) {
      spacedWords += 1;
    }
  }
  const cjkWords = Math.ceil(cjkCharacters / CJK_SCRIPT.charactersPerWord);
  const unsegmentedWords = Math.ceil(unsegmentedCharacters / UNSEGMENTED_SCRIPT.charactersPerWord);
  const wordCount = spacedWords + cjkWords + unsegmentedWords;
  // A page belongs to a script that has no word spaces once that script writes
  // half of it; a few English loanwords do not move a Chinese page back onto
  // word shingles.
  const script =
    cjkWords > 0 && cjkWords >= unsegmentedWords && cjkWords * 2 >= wordCount
      ? CJK_SCRIPT
      : unsegmentedWords > 0 && unsegmentedWords * 2 >= wordCount
        ? UNSEGMENTED_SCRIPT
        : null;
  return { wordCount, script };
}

/** A script that writes words without spaces between them, and how many characters one word runs to. */
type NonSpacedScript = { pattern: RegExp; charactersPerWord: number };

// No Hangul: Korean is space-separated, so its runs already count one per word.
const CJK_SCRIPT: NonSpacedScript = {
  pattern: /[\p{Script_Extensions=Han}\p{Script_Extensions=Hiragana}\p{Script_Extensions=Katakana}]/u,
  charactersPerWord: 2
};
const UNSEGMENTED_SCRIPT: NonSpacedScript = {
  pattern: /[\p{Script_Extensions=Thai}\p{Script_Extensions=Lao}\p{Script_Extensions=Khmer}\p{Script_Extensions=Myanmar}]/u,
  charactersPerWord: 4
};
const NON_SPACED_CHARACTER_PATTERN = new RegExp(
  `${CJK_SCRIPT.pattern.source}|${UNSEGMENTED_SCRIPT.pattern.source}`,
  "u"
);
const COMBINING_MARK_PATTERN = /\p{M}/u;

/**
 * Where one sentence ends and the next begins. A local counterpart of
 * `SENTENCE_BOUNDARY_PATTERN` in `proseShape.ts` (module-private there) and
 * deliberately identical: a spaced terminator with its closing quotes, a
 * full-width CJK terminator that takes no space after it, and — in the
 * unsegmented Southeast Asian scripts — the space itself, which is those
 * scripts' sentence mark. Splitting on spaced ASCII terminators alone made
 * every Chinese page one sentence, so its "opening" was the whole page.
 */
const SENTENCE_BOUNDARY_PATTERN =
  /(?<=[。！？។။][」』】〉》）'’"”]*)(?![」』】〉》）'’"”])|(?<=[.!?؟۔…]['’"”»)\]]*)\s+|(?<=[\p{Script_Extensions=Thai}\p{Script_Extensions=Lao}\p{Script_Extensions=Khmer}\p{Script_Extensions=Myanmar}])\s+/u;

/**
 * One page's shingles, in whichever unit its script repeats itself in.
 *
 * Both book-level repetition checks read a page through this, so each one is
 * written once and asks the same question of every script: does the same span
 * of about four readable words turn up on too many pages? In a spaced script a
 * unit is a word; in Chinese, Japanese or Thai it is a character, because a
 * "word" there is a whole clause between punctuation and four of *those*
 * repeating is a duplicated paragraph, not a tic.
 */
type RepetitionLane = {
  /** Shingle start positions available on this page. */
  count: number;
  /** The shingle at `start`, hashed without building its string, or null when it is too short to be distinctive. */
  hashAt(start: number): number | null;
  /** The normalized text two pages have to agree on for it to count as the same phrase. */
  keyAt(start: number): string;
  /** That same span as the page spells it — case, marks and punctuation intact. */
  quoteAt(start: number): string;
};

const FNV_OFFSET_BASIS = 0x811c9dc5;
const FNV_PRIME = 0x01000193;

function repetitionLane(
  text: string,
  tokens: PageTokens,
  spec: { words: number; minKeyLength: number }
): RepetitionLane {
  return tokens.script
    ? nonSpacedCharacterLane(text, tokens.script, spec.words * tokens.script.charactersPerWord)
    : spacedWordLane(text, tokens, spec.words, spec.minKeyLength);
}

function spacedWordLane(text: string, tokens: PageTokens, window: number, minKeyLength: number): RepetitionLane {
  const { values, starts, ends } = tokens;
  return {
    count: Math.max(0, values.length - window + 1),
    hashAt(start) {
      let length = window - 1; // the joining spaces
      let hash = FNV_OFFSET_BASIS;
      for (let offset = 0; offset < window; offset += 1) {
        const word = values[start + offset]!;
        if (offset > 0) {
          hash = Math.imul(hash ^ 0x20, FNV_PRIME); // the joining space
        }
        length += word.length;
        for (let position = 0; position < word.length; position += 1) {
          hash = Math.imul(hash ^ word.charCodeAt(position), FNV_PRIME);
        }
      }
      return length < minKeyLength ? null : hash;
    },
    keyAt: (start) => values.slice(start, start + window).join(" "),
    quoteAt: (start) => text.slice(starts[start]!, ends[start + window - 1]!)
  };
}

/**
 * The same sliding window over characters, for the scripts that write no spaces.
 * Punctuation and any interleaved Latin sit outside the stream, so the window is
 * the script's own characters — and the quote is the source span between the
 * first and last of them, which puts the punctuation back where the reader
 * expects it.
 */
function nonSpacedCharacterLane(text: string, script: NonSpacedScript, window: number): RepetitionLane {
  const characters: string[] = [];
  const offsets: number[] = [];
  let offset = 0;
  for (const character of text) {
    // Word characters only, the way the spaced lane's tokens are. CJK
    // punctuation carries the script in its `Script_Extensions` — 。 is
    // `Han` — so a stream taken off the script alone made "。" a unit, and the
    // most repeated eight-character window in any Chinese book was a full stop
    // followed by seven characters of whatever came next.
    if (script.pattern.test(character) && WORD_CHARACTER_PATTERN.test(character)) {
      characters.push(character);
      offsets.push(offset);
    }
    offset += character.length;
  }
  return {
    count: Math.max(0, characters.length - window + 1),
    hashAt(start) {
      let hash = FNV_OFFSET_BASIS;
      for (let position = 0; position < window; position += 1) {
        const character = characters[start + position]!;
        for (let unit = 0; unit < character.length; unit += 1) {
          hash = Math.imul(hash ^ character.charCodeAt(unit), FNV_PRIME);
        }
      }
      return hash;
    },
    keyAt: (start) => characters.slice(start, start + window).join(""),
    quoteAt(start) {
      const last = start + window - 1;
      return text.slice(offsets[start]!, offsets[last]! + characters[last]!.length);
    }
  };
}
