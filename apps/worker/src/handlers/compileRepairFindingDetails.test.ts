import { expect, it } from "vitest";
import { buildManuscriptQualityReport, PictureBookReviewIncompleteError, pictureBookCitationRowsSchema } from "@book-maker/core";
import captured from "./testing/quickUnverifiedFinding.json" with { type: "json" };
import { finalRepairQualityIssues, repairFailure, repairFailureSchema } from "./compileRepairOutcome.js";

it("keeps Quick's unverified page-13 concern through durable failure serialization without duplicating the group failure", () => {
  const error = new PictureBookReviewIncompleteError({ version: 2, reviews: [], unresolvedPageIndexes: [13],
    validationIssues: [{ pageIndex: 13, message: "The finding quotation could not be corrected." }], protocolIssues: [],
    roundsStarted: 2, attemptsUsed: 2, outputWidened: false, citationRows: pictureBookCitationRowsSchema.parse([captured]) });
  const failures = [16, 30].map(index => repairFailure(`p${index}`, index, error));
  const persisted = repairFailureSchema.array().parse(JSON.parse(JSON.stringify(failures)));
  const issues = finalRepairQualityIssues({ repairFailures: persisted }, [{ id: "p16", index: 16 }, { id: "p30", index: 30 }]);
  expect(issues.filter(i => i.code === "FINAL_QA_REPAIR_UNAVAILABLE")).toHaveLength(1);
  const concern = issues.find(i => i.code === "MANUSCRIPT_FINDING_UNVERIFIED");
  expect(concern?.affectedPageIndexes).toEqual([13]);
  expect(concern?.message).toContain("agreed signal");
  expect(concern?.guidance).toContain("Either establish the signal");
  expect(concern?.evidence).toBeUndefined();
  expect(buildManuscriptQualityReport([], issues, { finalReviewRan: true }).state).toBe("review_recommended");
});

it("retains validation details when no editorial finding was recoverable", () => {
  const error = new PictureBookReviewIncompleteError({ version: 2, reviews: [], unresolvedPageIndexes: [29, 30],
    validationIssues: [{ pageIndex: 29, message: "Story assessment missing." }, { pageIndex: 30, message: "Missing verdict." }],
    protocolIssues: [], roundsStarted: 2, attemptsUsed: 2, outputWidened: false });
  const failures = [16, 30].map(index => repairFailure(`p${index}`, index, error, "operation"));
  const issues = finalRepairQualityIssues({ repairFailures: failures }, []);
  expect(issues).toHaveLength(1);
  expect(issues[0]).toMatchObject({ affectedPageIndexes: [29, 30], message: expect.stringContaining("Page 29: Story assessment missing.") });
});
