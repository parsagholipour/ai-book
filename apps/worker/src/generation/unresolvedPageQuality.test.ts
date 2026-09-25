import { describe, expect, it } from "vitest";
import { unresolvedPageQualityIssues } from "./unresolvedPageQuality.js";

describe("unresolved page QA", () => {
  it("preserves distinct findings and revision guidance without repeating feedback", () => {
    const issues = unresolvedPageQualityIssues([{ index: 30, status: "FAILED_QA", qualityReport: {
      approved: false, score: 78,
      issues: ["The picnic action repeats page 28.", " The picnic action repeats page 28. ", "", "The ending needs closure."],
      requiredRevisions: ["Keep the final picnic beat.", "Keep the final picnic beat.", "Add a closing response."]
    } }]);
    expect(issues).toEqual([expect.objectContaining({ code: "PAGE_QA_UNRESOLVED", severity: "warning",
      message: "Page QA did not approve the saved draft: The picnic action repeats page 28.\nThe ending needs closure.",
      guidance: "Keep the final picnic beat.\nAdd a closing response.", affectedPageIndexes: [30] })]);
  });

  it.each([null, undefined, "unreadable", {}, { approved: false, issues: [] }])(
    "keeps a page link when the failed page has no usable rejection details: %j", (qualityReport) => {
      expect(unresolvedPageQualityIssues([{ index: 13, status: "FAILED_QA", qualityReport }])).toEqual([
        expect.objectContaining({ code: "PAGE_QA_UNRESOLVED", severity: "warning",
          message: expect.stringContaining("no detailed rejection"), affectedPageIndexes: [13] })
      ]);
    }
  );

  it("does not re-grade completed pages from historical reports or turn prose approval into a rejection", () => {
    expect(unresolvedPageQualityIssues([
      { index: 1, status: "COMPLETED", qualityReport: { approved: false, score: 40, issues: ["Old draft issue."] } },
      { index: 2, status: "FAILED_QA", qualityReport: { approved: true, score: 95, issues: ["Accepted editorial note."] } },
      { index: 3, status: "COMPLETED", qualityReport: null }
    ])).toEqual([]);
  });
});
