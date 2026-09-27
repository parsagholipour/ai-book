import { describe, expect, it } from "vitest";
import { failedQaPageIndexesForCompile } from "./compileExportCitationRepair.js";
import { pageQualityReportSchema } from "@book-maker/core";
import { unresolvedPageQualityIssues } from "../generation/unresolvedPageQuality.js";

const page = (issues: string[]) => ({
  index: 2,
  status: "FAILED_QA",
  qualityReport: { approved: false, issues }
});

describe("failedQaPageIndexesForCompile", () => {
  it("warns about unavailable review without authorizing a rewrite, but retains real local defects", () => {
    const report = pageQualityReportSchema.parse({ approved: false, score: 100, scoreBasis: "screened_unscored" });
    const unavailable = { ...page([]), qualityReport: report };
    expect(failedQaPageIndexesForCompile([unavailable], [])).toEqual([]);
    expect(unresolvedPageQualityIssues([unavailable])).toEqual([expect.objectContaining({ code: "FINAL_REVIEW_UNAVAILABLE", affectedPageIndexes: [2] })]);
    expect(failedQaPageIndexesForCompile([{ ...unavailable, qualityReport: { ...report, issues: ["Prompt leaked into prose."] } }], [])).toEqual([2]);
  });
  it.each([
    [
      "a mixed source complaint and repetition",
      ["No specific dispatch date or archive is identified.", "The page repeats the explanation from page 1."]
    ],
    [
      "an invented scene",
      ["The page invents an unnamed county magistrate scene that the supplied record does not support."]
    ],
    [
      "a mixed defect in one issue",
      ["No specific dispatch date is identified, and the account contradicts the supplied record."]
    ]
  ])("keeps %s in the compile repair set", (_name, issues) => {
    expect(failedQaPageIndexesForCompile([page(issues)], [])).toEqual([2]);
  });
});
