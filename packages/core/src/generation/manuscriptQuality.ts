import { MANUSCRIPT_PROMPT_LEAK_PATTERNS, containsPromptLeak } from "./promptLeak.js";
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
  type ManuscriptIntegrityPage,
  type ManuscriptQualityIssue,
  type ManuscriptQualityReport,
  type ManuscriptQualityState
} from "./manuscriptQualityIssue.js";
import {
  manuscriptQualityDiagnostics,
  publicationCorroborationError,
  stampShadowWouldBlock
} from "./manuscriptQualityPolicy.js";
import { cacheManuscriptPages } from "./manuscriptSignatures.js";
import { structuralSlopIssues } from "./manuscriptStructuralSlop.js";
import { recapBacktrackingIssues, sameChapterTreatmentIssues } from "./manuscriptTreatmentAudit.js";

export {
  MANUSCRIPT_STRUCTURAL_AUDIT_DETECTOR_VERSION,
  compactExcerpt,
  evidenceForPages,
  manuscriptError,
  manuscriptFinding,
  manuscriptWarning,
  type ManuscriptIntegrityPage,
  type ManuscriptQualityDiagnostics,
  type ManuscriptQualityFindingDiagnostic,
  type ManuscriptQualityIssue,
  type ManuscriptQualityIssueEvidence,
  type ManuscriptQualityIssueMetrics,
  type ManuscriptQualityReport,
  type ManuscriptQualitySeverity,
  type ManuscriptQualitySource,
  type ManuscriptQualityState
} from "./manuscriptQualityIssue.js";
export {
  DUPLICATE_TREATMENT_CLUSTER_BLOCKING_MIN_PAGES,
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
  manuscriptRule(
    ({ page }: ManuscriptPageRuleContext) => containsPromptLeak(page.markdown, MANUSCRIPT_PROMPT_LEAK_PATTERNS),
    ({ page }) =>
      manuscriptError(
        "PROMPT_LEAKAGE",
        `Page ${page.index} appears to expose generation instructions or hidden prompt text.`,
        "Regenerate this page without internal instructions.",
        [page.index]
      )
  ),
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

export function runDeterministicManuscriptChecks(options: {
  pages: ManuscriptIntegrityPage[];
  expectedPageCount: number;
  language?: string;
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
  const prepared = pages.map((page) => {
    const plain = plainMarkdown(page.markdown);
    return { page, plain, tokens: tokenizePage(plain) };
  });
  const pageTexts = prepared.map(({ plain }) => plain);
  const pageTokens = prepared.map(({ tokens }) => tokens);
  const cached = cacheManuscriptPages(prepared);
  const englishPhraseDetectors = englishPhraseDetectorsEnabled(options.language, pageTexts);

  for (const { page, plain } of prepared) {
    issues.push(...runQualityRules(MANUSCRIPT_PAGE_QUALITY_RULES, { page, plain }));
  }

  issues.push(
    ...nearDuplicateIssues(pages, pageTokens),
    ...repeatedPhraseIssues(pages, pageTexts, pageTokens),
    ...repeatedOpeningIssues(pages, pageTexts, pageTokens)
  );

  const slop = structuralSlopIssues(cached, { englishPhraseDetectors });
  issues.push(
    ...slop,
    ...publicationCorroborationError(slop),
    ...sameChapterTreatmentIssues(cached),
    ...recapBacktrackingIssues(cached, { englishPhraseDetectors })
  );
  if (englishPhraseDetectors) {
    issues.push(...sentenceOpeningCadenceIssues(cached));
  }
  return stampShadowWouldBlock(issues, pages.length);
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
 * `deterministicWarningsAffectVerdict` decides whether a deterministic warning
 * may recommend review. It describes the compile's role, independently of
 * whether model QA happened to run: an initial/outcome compile grades a book
 * nobody has graded yet, so every warning it raises is news even when model QA
 * was not requested. A `skipFinalReview` recompile is not grading the whole book:
 * an undo, a verified exact replacement, or a chat edit re-runs deterministic
 * checks over prose the edit never touched. Letting those warnings speak made a
 * book that passed months ago come back "review recommended" permanently, since
 * the export repair pass only rewrites errors.
 *
 * Two things are deliberately outside that gate. An **error** blocks whatever
 * ran, because publication integrity is never bypassed by an edit. Existing
 * model reviewers still emit warnings; only the structural corroboration path
 * constructs a model `error`. A model finding always speaks, because only a
 * full review can produce one.
 *
 * Shadow `diagnostics.wouldBlock` is measured here and is **not** mapped onto
 * `state`. Publication blocks on explicit `severity === "error"`, including a
 * high-confidence corroborated structural duplication.
 */
export function buildManuscriptQualityReport(
  deterministicIssues: ManuscriptQualityIssue[],
  modelIssues: ManuscriptQualityIssue[],
  options: ManuscriptQualityReportOptions
): ManuscriptQualityReport {
  const issues = [...deterministicIssues, ...modelIssues];
  const blocked = issues.some((entry) => entry.severity === "error");
  const deterministicWarnings = deterministicIssues.filter((entry) => entry.severity === "warning").length;
  const advisoryModelIssues = modelIssues.filter((entry) => entry.severity !== "error").length;
  const deterministicWarningsAffectVerdict =
    options.deterministicWarningsAffectVerdict ?? options.finalReviewRan;
  const state: ManuscriptQualityState = blocked
    ? "blocked"
    : advisoryModelIssues > 0 || (deterministicWarningsAffectVerdict && deterministicWarnings > 0)
      ? "review_recommended"
      : "passed";
  const score = Math.max(
    0,
    100 -
      issues.filter((entry) => entry.severity === "error").length * 18 -
      (advisoryModelIssues + deterministicWarnings) * 5
  );
  const manuscriptPageCount =
    options.manuscriptPageCount ??
    Math.max(0, ...issues.flatMap((issue) => issue.affectedPageIndexes), 0);
  return {
    state,
    score,
    issues,
    affectedPageIndexes: [...new Set(issues.flatMap((entry) => entry.affectedPageIndexes))].sort((a, b) => a - b),
    checkedAt: new Date().toISOString(),
    diagnostics: manuscriptQualityDiagnostics(issues, manuscriptPageCount)
  };
}

/**
 * Adds a post-hoc issue (e.g. an export artifact failure discovered after the
 * manuscript checks ran) to an existing report, recomputing state and score
 * with the same weights as buildManuscriptQualityReport. State never improves:
 * a warning bumps "passed" to "review_recommended"; an error blocks.
 */
export function appendQualityIssue(
  report: ManuscriptQualityReport,
  issue: ManuscriptQualityIssue
): ManuscriptQualityReport {
  const blocked = report.state === "blocked" || issue.severity === "error";
  const issues = [...report.issues, issue];
  return {
    ...report,
    state: blocked ? "blocked" : "review_recommended",
    score: Math.max(0, report.score - (issue.severity === "error" ? 18 : 5)),
    issues,
    affectedPageIndexes: [...new Set([...report.affectedPageIndexes, ...issue.affectedPageIndexes])].sort(
      (a, b) => a - b
    ),
    ...(report.diagnostics
      ? {
          diagnostics: manuscriptQualityDiagnostics(
            issues,
            Math.max(0, ...issues.flatMap((entry) => entry.affectedPageIndexes), report.affectedPageIndexes.length)
          )
        }
      : {})
  };
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
