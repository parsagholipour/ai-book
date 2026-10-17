import { MANUSCRIPT_PROMPT_LEAK_PATTERNS, promptLeakSpan } from "./promptLeak.js";
import { groupManuscriptQualityFindings, manuscriptQualityPenalty } from "./manuscriptQualityFindings.js";
import { figureFreeProse } from "./figures/figureBlocks.js";
import { sentenceOpeningCadenceIssues } from "./manuscriptCadence.js";
import { englishPhraseDetectorsEnabled } from "./manuscriptLanguage.js";
import {
  nearDuplicateIssues,
  repeatedOpeningIssues,
  repeatedPhraseIssues
} from "./manuscriptLexicalRepetition.js";
import { plainMarkdown, tokenizePage } from "./manuscriptPageCache.js";
import {
  manuscriptError,
  manuscriptWarning,
  type ManuscriptIntegrityPage,
  type ManuscriptQualityIssue,
  type ManuscriptQualityReport
} from "./manuscriptQualityIssue.js";
import {
  READER_FINDINGS_POLICY,
  isReaderFinding,
  readerCopyOf,
  readerFindingsFrom,
  readerQualityState
} from "./readerFindings.js";
import {
  manuscriptQualityDiagnostics,
  publicationCorroborationError,
  stampShadowWouldBlock
} from "./manuscriptQualityPolicy.js";
import { cacheManuscriptPages } from "./manuscriptSignatures.js";
import { structuralSlopIssues } from "./manuscriptStructuralSlop.js";
import { recapBacktrackingIssues } from "./manuscriptRecapAudit.js";
import { describeScriptLeaks, findScriptLeaks } from "./scriptLeaks.js";

export {
  MANUSCRIPT_STRUCTURAL_AUDIT_DETECTOR_VERSION,
  compactExcerpt,
  evidenceForPages,
  manuscriptError,
  manuscriptFinding,
  manuscriptWarning,
  optionalIssueCluster,
  parseManuscriptQualityIssueCluster,
  type ManuscriptIntegrityPage,
  type ManuscriptQualityDiagnostics,
  type ManuscriptQualityFindingDiagnostic,
  type ManuscriptQualityIssue,
  type ManuscriptQualityIssueCluster,
  type ManuscriptQualityIssueEvidence,
  type ManuscriptQualityIssueMetrics,
  type ManuscriptQualityReport,
  type ManuscriptQualitySeverity,
  type ManuscriptQualitySource,
  type ManuscriptQualityState
} from "./manuscriptQualityIssue.js";
export {
  BOOK_PRINTED_SHORT_CODE,
  READER_FINDINGS_POLICY,
  READER_FINDING_ADMISSIONS,
  diagnosticIssuesOf,
  isReaderFinding,
  printedSheetsFor,
  printedShortIssue,
  readerCopyOf,
  readerFindingAdmission,
  readerFindingsFrom,
  readerQualityState,
  type PrintedSheets,
  type ReaderFindingAdmission,
  type ReaderFindingEvidence
} from "./readerFindings.js";
export { hasAttributedSpeech, speechAbsenceRefuted, withoutRefutedFindings } from "./findingCounterevidence.js";
export {
  DUPLICATE_CLUSTER_BLOCKING_MIN_PAGES,
  PUBLICATION_CORROBORATION_CODES,
  SENTENCE_OPENING_CLEAN_CORPUS_BASELINE,
  SENTENCE_OPENING_WARNING_BASELINE_MULTIPLIER,
  SENTENCE_OPENING_WARNING_MIN_OCCURRENCES,
  STRUCTURAL_FAMILY_PAGE_RATIO_BLOCKING,
  STRUCTURAL_OCCURRENCE_SPAN_BLOCKING_MIN_CHAPTERS,
  STRUCTURAL_OCCURRENCE_SPAN_BLOCKING_MIN_OCCURRENCES
} from "./manuscriptQualityPolicy.js";

type ManuscriptGlobalRuleContext = {
  pages: ManuscriptIntegrityPage[];
  expectedPageCount: number;
  indexes: number[];
  expectedIndexes: number[];
};

type ManuscriptPageRuleContext = {
  page: ManuscriptIntegrityPage;
  plain: string;
};

type ManuscriptQualityRule<Context> = (
  context: Context
) => readonly ManuscriptQualityIssue[] | undefined;

function manuscriptRule<Context>(
  predicate: (context: Context) => boolean,
  finding: (context: Context) => ManuscriptQualityIssue
): ManuscriptQualityRule<Context> {
  return (context) => (predicate(context) ? [finding(context)] : undefined);
}

const MANUSCRIPT_GLOBAL_QUALITY_RULES = [
  manuscriptRule(
    ({ pages }: ManuscriptGlobalRuleContext) => pages.length === 0,
    () =>
      manuscriptError("MISSING_PAGES", "No manuscript pages were generated.", "Regenerate the book before exporting.", [])
  ),
  manuscriptRule(
    ({ pages, expectedPageCount }: ManuscriptGlobalRuleContext) =>
      pages.length > 0 && pages.length !== expectedPageCount,
    ({ pages, expectedPageCount }) =>
      manuscriptError(
        "PAGE_COUNT_MISMATCH",
        `The manuscript has ${pages.length} pages but ${expectedPageCount} were expected.`,
        "Regenerate missing pages or correct the plan's page count.",
        pages.map((page) => page.index)
      )
  ),
  manuscriptRule(
    ({ pages, indexes, expectedIndexes }: ManuscriptGlobalRuleContext) =>
      pages.length > 0 &&
      (new Set(indexes).size !== indexes.length ||
        indexes.some((value, index) => value !== expectedIndexes[index])),
    ({ indexes }) =>
      manuscriptError(
        "PAGE_INDEX_INVALID",
        "Page indexes contain a duplicate, gap, or out-of-order value.",
        "Repair page ordering before publishing.",
        indexes
      )
  )
] as const satisfies readonly ManuscriptQualityRule<ManuscriptGlobalRuleContext>[];

const MANUSCRIPT_PAGE_QUALITY_RULES = [
  manuscriptRule(
    ({ page, plain }: ManuscriptPageRuleContext) => !page.title.trim() || !plain,
    ({ page }) =>
      manuscriptError(
        "EMPTY_PAGE",
        `Page ${page.index} has an empty title or body.`,
        "Open Edit Mode or regenerate this page.",
        [page.index]
      )
  ),
  // The one rule that quotes what it matched: a reader is shown this finding
  // (`readerFindings.ts`) only with a quote of the page, and the detector is
  // the only thing that knows which words it matched.
  ({ page }: ManuscriptPageRuleContext) => {
    const span = promptLeakSpan(page.markdown, MANUSCRIPT_PROMPT_LEAK_PATTERNS)?.replace(/\s+/g, " ").trim();
    if (!span) return undefined;
    return [manuscriptError(
      "PROMPT_LEAKAGE",
      `Page ${page.index} appears to expose generation instructions or hidden prompt text: “${span}”.`,
      "Regenerate this page without internal instructions.",
      [page.index],
      { evidence: [{ pageIndex: page.index, excerpt: span }] }
    )];
  },
  manuscriptRule(
    ({ page }: ManuscriptPageRuleContext) => containsPlaceholder(page.markdown),
    ({ page }) =>
      manuscriptError(
        "PLACEHOLDER_TEXT",
        `Page ${page.index} contains placeholder text.`,
        "Replace the placeholder in Edit Mode or regenerate the page.",
        [page.index]
      )
  ),
  manuscriptRule(
    ({ page }: ManuscriptPageRuleContext) => hasMalformedMarkdown(page.markdown),
    ({ page }) =>
      manuscriptError(
        "MALFORMED_MARKDOWN",
        `Page ${page.index} contains malformed Markdown.`,
        "Fix unmatched code fences, links, or footnotes in Edit Mode.",
        [page.index]
      )
  ),
  manuscriptRule(
    ({ page }: ManuscriptPageRuleContext) => hasUnsupportedFootnote(page.markdown),
    ({ page }) =>
      manuscriptError(
        "UNSUPPORTED_CITATION",
        `Page ${page.index} references a citation that has no matching definition.`,
        "Add the missing source definition or remove the citation reference.",
        [page.index]
      )
  )
] as const satisfies readonly ManuscriptQualityRule<ManuscriptPageRuleContext>[];

function runQualityRules<Context>(
  rules: readonly ManuscriptQualityRule<Context>[],
  context: Context
): ManuscriptQualityIssue[] {
  const findings: ManuscriptQualityIssue[] = [];
  for (const rule of rules) {
    const ruleFindings = rule(context);
    if (ruleFindings) {
      findings.push(...ruleFindings);
    }
  }
  return findings;
}

/**
 * The deterministic checks an author's own manuscript (`isAuthorManuscript`)
 * answers to: whether the book is *whole*, never whether it is well written.
 *
 * Kept — content integrity, the questions a publish can get wrong and the author
 * can fix: pages missing, miscounted or misnumbered; an empty page; a
 * `TODO`/`TBD`/placeholder the author left in; an unmatched code fence or a link
 * cut off mid-way (`MALFORMED_MARKDOWN`), which swallows everything after it.
 *
 * Skipped — every judgment of the prose itself: near-duplicate pages, repeated
 * phrases and openings, the structural slop families and the
 * `STRUCTURAL_SLOP_SATURATION` error their corroboration raises
 * (`publicationCorroborationError`), recap backtracking, sentence-opening cadence.
 * They were measured against what this pipeline's models write — a model's
 * habits, flagged so the repair pass can redraft them — and an author's refrain,
 * house style or deliberate repetition is not a defect this product may grade,
 * let alone one that holds their book in REVIEW_REQUIRED. Skipped as well:
 * `PROMPT_LEAKAGE`, which looks for our own prompts in the prose, and
 * `UNSUPPORTED_CITATION`, which asks each *page* to define its own footnotes —
 * right for a model's self-contained page, wrong for an author's, whose
 * definitions sit wherever they wrote them and whose pages are only where the
 * paginator cut.
 */
const AUTHOR_MANUSCRIPT_CHECK_CODES = new Set([
  "MISSING_PAGES",
  "PAGE_COUNT_MISMATCH",
  "PAGE_INDEX_INVALID",
  "EMPTY_PAGE",
  "PLACEHOLDER_TEXT",
  "MALFORMED_MARKDOWN"
]);

export function runDeterministicManuscriptChecks(options: {
  pages: ManuscriptIntegrityPage[];
  expectedPageCount: number;
  language?: string;
  /** The author owns the text: content-integrity checks only. See {@link AUTHOR_MANUSCRIPT_CHECK_CODES}. */
  authorManuscript?: boolean;
  /**
   * A story (`isNarrativeWritingMode`): no `CROSS_CHAPTER_CONCEPT_REPETITION`,
   * which looks for explanatory modules taught twice. On stories it read two
   * adjacent scenes, or a recurring place, as "overlapping explanatory
   * modules" — 4 of 15 labelled findings false, all on stories and running
   * examples (2026-10-15).
   */
  narrative?: boolean;
}): ManuscriptQualityIssue[] {
  const pages = [...options.pages].sort((a, b) => a.index - b.index);
  const indexes = pages.map((page) => page.index);
  const expectedIndexes = Array.from({ length: pages.length }, (_, index) => index + 1);
  const issues = runQualityRules(MANUSCRIPT_GLOBAL_QUALITY_RULES, {
    pages,
    expectedPageCount: options.expectedPageCount,
    indexes,
    expectedIndexes
  });
  if (pages.length === 0) {
    return stampShadowWouldBlock(issues, 0);
  }

  // Strip and tokenize once per page. Near-duplicate comparison is n(n-1)/2,
  // and treatment/recap scoring reuses the same signatures instead of
  // rebuilding token sets inside pair loops.
  const prepared = pages.map((raw) => {
    // Every measure below reads prose; a figure block is drawn, not read.
    const markdown = figureFreeProse(raw.markdown);
    const page = { ...raw, markdown };
    const plain = plainMarkdown(markdown);
    return { page, plain, tokens: tokenizePage(plain) };
  });
  const pageTexts = prepared.map(({ plain }) => plain);
  const pageTokens = prepared.map(({ tokens }) => tokens);

  for (const { page, plain } of prepared) {
    issues.push(...runQualityRules(MANUSCRIPT_PAGE_QUALITY_RULES, { page, plain }));
  }
  if (options.authorManuscript) {
    return stampShadowWouldBlock(issues.filter((issue) => AUTHOR_MANUSCRIPT_CHECK_CODES.has(issue.code)), pages.length);
  }
  issues.push(...scriptLeakIssues(prepared.map(({ page }) => page), options.language));
  const cached = cacheManuscriptPages(prepared);
  const englishPhraseDetectors = englishPhraseDetectorsEnabled(options.language, pageTexts);

  issues.push(
    ...nearDuplicateIssues(pages, pageTokens),
    ...repeatedPhraseIssues(pages, pageTexts, pageTokens),
    ...repeatedOpeningIssues(pages, pageTexts, pageTokens)
  );

  const slop = structuralSlopIssues(cached, { englishPhraseDetectors, conceptRepetition: !options.narrative });
  issues.push(
    ...slop,
    ...publicationCorroborationError(slop),
    ...recapBacktrackingIssues(cached, { englishPhraseDetectors })
  );
  if (englishPhraseDetectors) {
    issues.push(...sentenceOpeningCadenceIssues(cached));
  }
  return stampShadowWouldBlock(issues, pages.length);
}

/**
 * A word in a script the book is not written in (`scriptLeaks.ts`), one
 * warning a page. A console diagnostic and nothing more: the compose guard
 * and the page integrity rule are what act on a leak, before the compile. It
 * reads no brief, so a book whose brief asked for another script lists it here
 * and nowhere else.
 */
function scriptLeakIssues(pages: readonly ManuscriptIntegrityPage[], language: string | undefined): ManuscriptQualityIssue[] {
  return pages.flatMap((page) => {
    const leaks = findScriptLeaks(page.markdown, { language: language ?? "en" });
    if (leaks.length === 0) return [];
    return [manuscriptWarning(
      "FOREIGN_SCRIPT",
      `Page ${page.index} contains words in a script the book is not written in: ${describeScriptLeaks(leaks)}.`,
      "Replace each word with the book's own language in Edit Mode, or regenerate the page.",
      [page.index],
      { evidence: [{ pageIndex: page.index, excerpt: leaks[0]!.word }] }
    )];
  });
}

export type ManuscriptQualityReportOptions = {
  /**
   * Whether the compile that produced these issues ran the full model review.
   * Stated by the caller, never inferred from what the issue lists happen to
   * hold.
   */
  finalReviewRan: boolean;
  /**
   * Whether deterministic warnings discovered by this compile are new verdict
   * evidence. Initial/outcome compiles set this even when model review is not
   * requested; edit and presentation recompiles leave it false so they do not
   * retroactively re-grade untouched prose.
   *
   * Optional for stored/legacy callers: the former behavior was equivalent to
   * `finalReviewRan`.
   */
  deterministicWarningsAffectVerdict?: boolean;
  /** Manuscript length used for diagnostic ratios. Omit when unknown. */
  manuscriptPageCount?: number;
};

/**
 * Turns one compile's findings into the verdict the app reads off the book.
 *
 * **The reader's grade is made from `readerFindings` alone** (`readerFindings.ts`):
 * the admitted types, each with the evidence its admission requires, capped at
 * a warning unless the type is measured precise enough to block, and none is.
 * Every other finding is a diagnostic. It stays in `issues` and `findings` —
 * the console reads them, the repair pass targets the errors among them, and a
 * stand-down withdraws them — and it never moves `state`, `score` or
 * `affectedPageIndexes`. Before the split (2026-10-15) a report graded every
 * finding, and 147 of 175 recent books read "review recommended" or "blocked"
 * on findings a third of which were real; graded this way, 171 read "passed".
 * So an empty reader set grades `passed` while the console still lists what the
 * compile found. Errors a reader is not shown block nothing either:
 * `PAGE_COUNT_MISMATCH`, `EMPTY_PAGE` and the rest of the integrity sweep are
 * unmeasured (none fired in those 20 days), and a book that printed short is
 * told so by the one length finding that is (`BOOK_PRINTED_SHORT`).
 *
 * `deterministicWarningsAffectVerdict` keeps its meaning over the reader's
 * findings: a deterministic warning an edit's recompile re-measures over prose
 * it never touched does not re-grade the book. A deterministic error and a
 * model finding always speak. No admitted type is a deterministic warning when
 * it is graded here, so the option is recorded in provenance and silences
 * nothing a reader sees today.
 *
 * Shadow `diagnostics.wouldBlock` is measured over every issue and is **not**
 * mapped onto `state`.
 */
export function buildManuscriptQualityReport(
  deterministicIssues: ManuscriptQualityIssue[],
  modelIssues: ManuscriptQualityIssue[],
  options: ManuscriptQualityReportOptions
): ManuscriptQualityReport {
  const issues = [...deterministicIssues, ...modelIssues];
  const deterministicWarningsAffectVerdict =
    options.deterministicWarningsAffectVerdict ?? options.finalReviewRan;
  const readerFindings = readerFindingsFrom(issues, { deterministicWarningsAffectVerdict });
  const manuscriptPageCount =
    options.manuscriptPageCount ??
    Math.max(0, ...issues.flatMap((issue) => issue.affectedPageIndexes), 0);
  return {
    state: readerQualityState(readerFindings),
    score: readerScore(readerFindings),
    scoreBasis: "unresolved_findings",
    findings: groupManuscriptQualityFindings(issues),
    issues,
    readerFindings,
    readerPolicy: READER_FINDINGS_POLICY,
    affectedPageIndexes: pagesNamedBy(readerFindings),
    checkedAt: new Date().toISOString(),
    diagnostics: manuscriptQualityDiagnostics(issues, manuscriptPageCount)
  };
}

/**
 * Adds a post-hoc issue — an export artifact failure, or the printed-short
 * finding, both discovered after the manuscript checks ran — to an existing
 * report. It always joins `issues`; it reaches the reader's grade only when
 * `isReaderFinding` admits it, and then it always speaks, because it is a fact
 * about the file this compile produced rather than a re-measurement of prose.
 * State never improves. A report made before the split grades every issue, as
 * it always did.
 */
export function appendQualityIssue(
  report: ManuscriptQualityReport,
  issue: ManuscriptQualityIssue
): ManuscriptQualityReport {
  const issues = [...report.issues, issue];
  const findings = groupManuscriptQualityFindings(issues);
  const diagnostics = report.diagnostics
    ? {
        diagnostics: manuscriptQualityDiagnostics(
          issues,
          Math.max(0, ...issues.flatMap((entry) => entry.affectedPageIndexes), report.affectedPageIndexes.length)
        )
      }
    : {};
  if (report.readerFindings === undefined) {
    return {
      ...report,
      state: report.state === "blocked" || issue.severity === "error" ? "blocked" : "review_recommended",
      score: Math.max(0, 100 - manuscriptQualityPenalty(findings)),
      scoreBasis: "unresolved_findings",
      findings,
      issues,
      affectedPageIndexes: [...new Set([...report.affectedPageIndexes, ...issue.affectedPageIndexes])].sort(
        (a, b) => a - b
      ),
      ...diagnostics
    };
  }
  const readerFindings = isReaderFinding(issue) ? [...report.readerFindings, readerCopyOf(issue)] : report.readerFindings;
  const graded = readerQualityState(readerFindings);
  return {
    ...report,
    state: STATE_RANK[graded] >= STATE_RANK[report.state] ? graded : report.state,
    score: Math.min(report.score, readerScore(readerFindings)),
    scoreBasis: "unresolved_findings",
    findings,
    issues,
    readerFindings,
    affectedPageIndexes: pagesNamedBy(readerFindings),
    ...diagnostics
  };
}

const STATE_RANK: Record<ManuscriptQualityReport["state"], number> = { passed: 0, review_recommended: 1, blocked: 2 };

function readerScore(readerFindings: readonly ManuscriptQualityIssue[]): number {
  return Math.max(0, 100 - manuscriptQualityPenalty(groupManuscriptQualityFindings(readerFindings)));
}

function pagesNamedBy(issues: readonly ManuscriptQualityIssue[]): number[] {
  return [...new Set(issues.flatMap((entry) => entry.affectedPageIndexes))].sort((a, b) => a - b);
}

/**
 * Scaffold markers are shouted (`TODO`, `TBD`, `FIXME`, `PLACEHOLDER`) or bracketed (`[insert …]`);
 * the same words in lower case are English. Matched case-insensitively, "choose a cautious placeholder
 * only for organizing cash" blocked a whole Quick Draft workbook (2026-09-30).
 */
function containsPlaceholder(value: string): boolean {
  return /\b(?:TODO|TBD|FIXME|PLACEHOLDER)\b/.test(value) || /\blorem ipsum\b|\[(?:insert|add|write|placeholder|todo)[^\]]*\]/i.test(value);
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
