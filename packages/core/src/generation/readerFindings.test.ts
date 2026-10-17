import { describe, expect, it } from "vitest";
import { appendQualityIssue, buildManuscriptQualityReport, runDeterministicManuscriptChecks } from "./manuscriptQuality.js";
import type { ManuscriptQualityIssue } from "./manuscriptQualityIssue.js";
import {
  READER_FINDINGS_POLICY,
  READER_FINDING_ADMISSIONS,
  diagnosticIssuesOf,
  isReaderFinding,
  printedSheetsFor,
  printedShortIssue
} from "./readerFindings.js";

const leak: ManuscriptQualityIssue = {
  code: "PROMPT_LEAKAGE", severity: "error", source: "deterministic",
  message: "Page 3 appears to expose generation instructions or hidden prompt text: “system prompt”.",
  guidance: "Regenerate this page without internal instructions.", affectedPageIndexes: [3],
  evidence: [{ pageIndex: 3, excerpt: "system prompt" }]
};
const coherence: ManuscriptQualityIssue = {
  code: "WHOLE_BOOK_REVIEW", severity: "warning", source: "model", message: "Page 4: The pacing sags.",
  guidance: "Review page 4.", affectedPageIndexes: [4], evidence: [{ pageIndex: 4, excerpt: "The night was long." }]
};

describe("the admission list", () => {
  it("is data, and nothing on it may block until it is measured at 0.99", () => {
    expect(READER_FINDING_ADMISSIONS.map((admission) => admission.code)).toEqual(["PROMPT_LEAKAGE", "ARITHMETIC_ERRORS", "BOOK_PRINTED_SHORT"]);
    expect(READER_FINDING_ADMISSIONS.every((admission) => !admission.mayBlock && admission.measured.length > 0)).toBe(true);
  });

  it("admits a type only with a page and a quote on a page it names", () => {
    expect(isReaderFinding(leak)).toBe(true);
    // The stored PROMPT_LEAKAGE of every report before 2026-10-15 carried no quote.
    expect(isReaderFinding({ ...leak, evidence: undefined } as unknown as ManuscriptQualityIssue)).toBe(false);
    expect(isReaderFinding({ ...leak, evidence: [{ pageIndex: 9, excerpt: "system prompt" }] })).toBe(false);
    expect(isReaderFinding({ ...leak, affectedPageIndexes: [] })).toBe(false);
    // A verified quote does not admit a type that is not on the list: whole-book review's
    // quoted findings verified 36/36 and were real 5/12.
    expect(isReaderFinding(coherence)).toBe(false);
  });
});

describe("a split report", () => {
  it("grades the reader's findings alone, capped at a warning, and keeps every finding for the console", () => {
    const report = buildManuscriptQualityReport([leak], [coherence], { finalReviewRan: true });
    expect(report).toMatchObject({ state: "review_recommended", score: 95, affectedPageIndexes: [3], readerPolicy: READER_FINDINGS_POLICY });
    expect(report.readerFindings).toEqual([{ ...leak, severity: "warning" }]);
    expect(report.issues).toEqual([leak, coherence]);
    expect(diagnosticIssuesOf(report)).toEqual([coherence]);
  });

  it("passes a book whose findings are all diagnostics, and says so to nobody but the console", () => {
    const report = buildManuscriptQualityReport(runDeterministicManuscriptChecks({
      expectedPageCount: 2, pages: [{ index: 1, title: "One", markdown: "TODO: write this." }]
    }), [coherence], { finalReviewRan: true });
    expect(report).toMatchObject({ state: "passed", score: 100, readerFindings: [], affectedPageIndexes: [] });
    expect(diagnosticIssuesOf(report)?.map((issue) => issue.code)).toEqual(["PAGE_COUNT_MISMATCH", "PLACEHOLDER_TEXT", "WHOLE_BOOK_REVIEW"]);
  });

  it("has no console half for a report made before the split", () => {
    expect(diagnosticIssuesOf({ issues: [coherence] })).toBeUndefined();
  });

  it("lets an appended reader finding move the grade, and an appended diagnostic only the ledger", () => {
    const clean = buildManuscriptQualityReport([], [], { finalReviewRan: true });
    const epub = appendQualityIssue(clean, { code: "EPUB_EXPORT_FAILED", severity: "warning", source: "deterministic",
      message: "EPUB export failed.", guidance: "Retry.", affectedPageIndexes: [] });
    expect(epub).toMatchObject({ state: "passed", score: 100, readerFindings: [] });
    const short = appendQualityIssue(epub, printedShortIssue({ paidPages: 10, printedPages: 9 })!);
    expect(short).toMatchObject({ state: "review_recommended", score: 95 });
    expect(short.readerFindings?.map((issue) => issue.code)).toEqual(["BOOK_PRINTED_SHORT"]);
    expect(short.issues.map((issue) => issue.code)).toEqual(["EPUB_EXPORT_FAILED", "BOOK_PRINTED_SHORT"]);
  });
});

describe("the printed-short measurement", () => {
  it("reads a prose book's miss off the fitter, matter sheets excluded", () => {
    // Paid 20, fitted toward 22 (two matter sheets nobody paid for), printed 21: one paid page short.
    expect(printedSheetsFor({ paidPages: 20, separateStoryLayout: false,
      pagination: { targetPages: 22, actualPages: 21 } })).toEqual({ paidPages: 20, printedPages: 19 });
    expect(printedSheetsFor({ paidPages: 20, separateStoryLayout: false,
      pagination: { targetPages: 22, actualPages: 22 } })).toEqual({ paidPages: 20, printedPages: 20 });
  });

  it("counts a picture book's story sheets off its measured page map", () => {
    // cmv9ob8mz (2026-10-15): a 10-page illustrated story printed 9 story sheets.
    const pages = Array.from({ length: 9 }, (_, offset) => ({ index: offset + 1, startPdfPage: offset + 3, endPdfPage: offset + 3 }));
    expect(printedSheetsFor({ paidPages: 10, separateStoryLayout: true, pageMap: { pages } })).toEqual({ paidPages: 10, printedPages: 9 });
    expect(printedShortIssue({ paidPages: 10, printedPages: 9 })).toMatchObject({
      code: "BOOK_PRINTED_SHORT", severity: "warning", affectedPageIndexes: [],
      message: "The PDF prints 9 of the 10 pages this book was made for."
    });
  });

  it("claims nothing it did not measure, and nothing about a book that printed in full", () => {
    expect(printedSheetsFor({ paidPages: undefined, separateStoryLayout: false, pagination: { targetPages: 5, actualPages: 3 } })).toBeUndefined();
    expect(printedSheetsFor({ paidPages: 10, separateStoryLayout: false })).toBeUndefined();
    expect(printedSheetsFor({ paidPages: 10, separateStoryLayout: true })).toBeUndefined();
    expect(printedShortIssue({ paidPages: 10, printedPages: 10 })).toBeUndefined();
    expect(printedShortIssue({ paidPages: 10, printedPages: 11 })).toBeUndefined();
  });
});
