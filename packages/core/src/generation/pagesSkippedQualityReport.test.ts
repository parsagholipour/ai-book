import { describe, expect, it } from "vitest";
import { skippedPageQualityReport } from "./pagesSkippedQualityReport.js";

const SKIPPED_REPORT = {
  approved: true,
  score: 100,
  issues: [],
  requiredRevisions: [],
  notes: "Page quality checks skipped.",
  groundedOk: true,
  unsupportedClaims: [],
  checks: {
    placeholderFree: true,
    promptLeakFree: true,
    titleClean: true,
    repetitionOk: true,
    progressionOk: true,
    styleNatural: true
  }
};

describe("skippedPageQualityReport", () => {
  it("returns the full synthetic-approved contract for skipped page quality checks", () => {
    expect(skippedPageQualityReport()).toEqual(SKIPPED_REPORT);
  });

  it("returns fresh arrays and checks for every report", () => {
    const first = skippedPageQualityReport();
    const second = skippedPageQualityReport();

    expect(second.issues).not.toBe(first.issues);
    expect(second.requiredRevisions).not.toBe(first.requiredRevisions);
    expect(second.unsupportedClaims).not.toBe(first.unsupportedClaims);
    expect(second.checks).not.toBe(first.checks);

    first.issues.push("mutated issue");
    first.requiredRevisions.push("mutated revision");
    first.unsupportedClaims.push("mutated claim");
    first.checks.placeholderFree = false;

    expect(skippedPageQualityReport()).toEqual(SKIPPED_REPORT);
  });
});
