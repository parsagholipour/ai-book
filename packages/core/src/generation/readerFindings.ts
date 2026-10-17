import type {
  ManuscriptQualityIssue,
  ManuscriptQualityReport,
  ManuscriptQualityState
} from "./manuscriptQualityIssue.js";
import type { BookPdfPageMap } from "./pdfPageMap.js";
import type { BookPdfPagination } from "./pdfPagination.js";

/**
 * Which findings a reader is shown, and which stay on the operator's console.
 *
 * Owner's rule (Parsa, 2026-10-15), "verified defects only": a finding type
 * reaches the reader only with a measured precision on shipped books — at
 * least 0.95 to be shown, at least 0.99 to block — and each finding must
 * carry a page and a quote verified on that page. Everything else is a
 * diagnostic: the console shows it, the repair pass and the stand-down still
 * read it, and it never moves the reader's grade.
 *
 * The labelling behind the list (`.scratch/harness-redesign-2026-10-15/h6-labels/`):
 * 177 findings from 62 books, two blind labellers (κ 0.83) and a third on the
 * disagreements. 32% were defects a reader would want fixed, and no type
 * reached 0.95. The three below are provisional admissions of detector-backed
 * types whose measured misses were fixed at the detector, never proofs:
 * showing 0.95 with no miss takes about 60 labelled hits and 0.99 about 300,
 * and the blocking detectors fire 2–6 times in 20 days. So nothing here may
 * block. "Blocked" stays a state for an admission measured that high, and a
 * reader-facing error is capped to a warning until then.
 *
 * The list is data on purpose: admitting a type is one entry here with the
 * measurement that earned it, never a conditional at a call site.
 */
export const READER_FINDINGS_POLICY = "reader-findings-v1";

/** What a finding of an admitted type has to carry before a reader sees it. */
export type ReaderFindingEvidence =
  /** A page, and a quote of that page the detector itself matched in the page's text. */
  | "page-and-quote"
  /** A count of the published file — exact by construction, so no quote to verify. */
  | "measurement";

export type ReaderFindingAdmission = {
  readonly code: string;
  readonly evidence: ReaderFindingEvidence;
  /** Only an admission measured at ≥ 0.99 may keep an error's severity; none is. */
  readonly mayBlock: boolean;
  /** The measurement that admitted it. */
  readonly measured: string;
};

/** The one book-level finding about length a reader is shown. */
export const BOOK_PRINTED_SHORT_CODE = "BOOK_PRINTED_SHORT";

export const READER_FINDING_ADMISSIONS: readonly ReaderFindingAdmission[] = [
  {
    code: "PROMPT_LEAKAGE",
    evidence: "page-and-quote",
    mayBlock: false,
    measured: "2/2 labelled; over all 17,865 stored generated pages 6/7 pages real, 6/6 once the bare 'chain of thought' idiom was dropped (2026-10-15)"
  },
  {
    code: "ARITHMETIC_ERRORS",
    evidence: "page-and-quote",
    mayBlock: false,
    measured: "1/2 labelled; the miss was a prefix match of a corrected statement, fixed by a statement boundary and re-evaluation at compile time (2026-10-15)"
  },
  {
    code: BOOK_PRINTED_SHORT_CODE,
    evidence: "measurement",
    mayBlock: false,
    measured: "a sheet count of the published PDF; fired on 1 of 175 books in 20 days, the one that printed short (2026-10-15)"
  }
];

const ADMISSIONS = new Map(READER_FINDING_ADMISSIONS.map((admission) => [admission.code, admission]));

export function readerFindingAdmission(code: string): ReaderFindingAdmission | undefined {
  return ADMISSIONS.get(code);
}

/**
 * Whether this finding may reach the reader: its type is admitted, and it
 * carries what the admission asks for. A quote counts only on a page the
 * finding names. It proves where the detector looked, never that a model's
 * claim is true — whole-book review's quoted findings verified 36/36 and were
 * real 5/12 — which is why no model-backed type is admitted on a quote alone.
 */
export function isReaderFinding(issue: ManuscriptQualityIssue): boolean {
  const admission = ADMISSIONS.get(issue.code);
  if (!admission) return false;
  if (admission.evidence === "measurement") return true;
  return issue.affectedPageIndexes.length > 0 && (issue.evidence ?? []).some((item) =>
    issue.affectedPageIndexes.includes(item.pageIndex) && item.excerpt.trim().length > 0);
}

/** The reader's copy of an admitted finding: an error is a warning unless its type may block. */
export function readerCopyOf(issue: ManuscriptQualityIssue): ManuscriptQualityIssue {
  return issue.severity === "warning" || ADMISSIONS.get(issue.code)?.mayBlock ? issue : { ...issue, severity: "warning" };
}

/**
 * The findings a reader is shown out of everything a compile measured.
 *
 * `deterministicWarningsAffectVerdict` keeps its meaning: a deterministic
 * warning an edit's recompile re-measured over prose it never touched does not
 * re-grade the book. No admitted type is a deterministic warning when it is
 * measured — the leak and arithmetic detectors file errors, and the printed-
 * short finding is appended after the render (`appendQualityIssue`) — so today
 * the option silences nothing a reader would see.
 */
export function readerFindingsFrom(
  issues: readonly ManuscriptQualityIssue[],
  options: { deterministicWarningsAffectVerdict: boolean }
): ManuscriptQualityIssue[] {
  return issues
    .filter((issue) => isReaderFinding(issue) &&
      (issue.source === "model" || issue.severity === "error" || options.deterministicWarningsAffectVerdict))
    .map(readerCopyOf);
}

export function readerQualityState(readerFindings: readonly ManuscriptQualityIssue[]): ManuscriptQualityState {
  return readerFindings.some((issue) => issue.severity === "error")
    ? "blocked"
    : readerFindings.length > 0 ? "review_recommended" : "passed";
}

const findingIdentity = (issue: ManuscriptQualityIssue) =>
  JSON.stringify([issue.code, issue.source, issue.message, issue.affectedPageIndexes]);

/**
 * The console's half of a split report: every finding the compile measured
 * that the reader is not shown. Undefined for a report made before the split,
 * whose `issues` were all shown to the reader.
 */
export function diagnosticIssuesOf(
  report: Pick<ManuscriptQualityReport, "issues" | "readerFindings">
): ManuscriptQualityIssue[] | undefined {
  if (!report.readerFindings) return undefined;
  const shown = new Set(report.readerFindings.map(findingIdentity));
  return report.issues.filter((issue) => !shown.has(findingIdentity(issue)));
}

/** What the published PDF printed against what was paid for, in pages a reader counts. */
export type PrintedSheets = { paidPages: number; printedPages: number };

/**
 * The paid pages a render printed, from what the render itself measured, or
 * undefined when it measured nothing it could compare: an author's book (no
 * paid count), a render with no fit, a story layout whose page map failed.
 *
 * A prose book is fitted to the paid count plus the matter sheets nobody paid
 * for (`fitBookPdfPageCount`), so the fitter's miss below its target is
 * exactly the paid pages missing. A picture book is not fitted — every scene
 * takes its own sheet and front matter is extra — so its paid pages are the
 * sheets its model pages print on, read off the measured page map.
 */
export function printedSheetsFor(options: {
  paidPages: number | undefined;
  separateStoryLayout: boolean;
  pagination?: Pick<BookPdfPagination, "targetPages" | "actualPages"> | undefined;
  pageMap?: Pick<BookPdfPageMap, "pages"> | undefined;
}): PrintedSheets | undefined {
  const { paidPages } = options;
  if (paidPages === undefined || !Number.isSafeInteger(paidPages) || paidPages < 1) return undefined;
  if (options.separateStoryLayout) {
    if (!options.pageMap || options.pageMap.pages.length === 0) return undefined;
    const sheets = new Set<number>();
    for (const range of options.pageMap.pages) {
      for (let sheet = range.startPdfPage; sheet <= range.endPdfPage; sheet += 1) sheets.add(sheet);
    }
    return { paidPages, printedPages: sheets.size };
  }
  if (!options.pagination) return undefined;
  return { paidPages, printedPages: paidPages - (options.pagination.targetPages - options.pagination.actualPages) };
}

/**
 * The one length finding a reader is shown: the PDF has fewer pages than the
 * book was paid for. A chapter under its word minimum is a diagnostic
 * (`composedChapterLength.ts` in the worker): every one of the 65 books that
 * carried one in the 20 days to 2026-10-15 printed its paid pages, because
 * the fitter takes a shortfall up in type size and leading, and the one book
 * that printed short carried none.
 *
 * It names no page and quotes nothing, because its evidence is the sheet
 * count, which the reader can check by counting. That is the admission's
 * `measurement` evidence rather than an exception to the quote rule: a quote
 * makes a claim about prose checkable, and this is not a claim about prose.
 */
export function printedShortIssue(sheets: PrintedSheets): ManuscriptQualityIssue | undefined {
  if (!(sheets.printedPages < sheets.paidPages)) return undefined;
  return {
    code: BOOK_PRINTED_SHORT_CODE,
    severity: "warning",
    source: "deterministic",
    message: `The PDF prints ${sheets.printedPages} of the ${sheets.paidPages} pages this book was made for.`,
    guidance: "The text fits on fewer pages than planned. Ask in the book chat to add a page or expand a section if you want the full length.",
    affectedPageIndexes: [],
    metrics: { occurrences: sheets.paidPages - sheets.printedPages }
  };
}
