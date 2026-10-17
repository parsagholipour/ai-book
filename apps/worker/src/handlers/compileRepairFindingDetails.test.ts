import { expect, it } from "vitest";
import { buildManuscriptQualityReport, PictureBookReviewIncompleteError, pictureBookCitationRowsSchema,
  pictureBookMetadataRowsSchema } from "@book-maker/core";
import metadata from "../../../../packages/core/src/generation/testing/quickMalformedFindingMetadata.json" with { type: "json" };
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
  expect(persisted[0]?.reviewFindings?.[0]?.validationFailure).toBe("evidence");
  expect(concern?.message).toContain("Unverified editorial concern");
  expect(concern?.evidence).toBeUndefined();
  // Unverified concerns are console diagnostics: kept on the report, never the reader's grade.
  const report = buildManuscriptQualityReport([], issues, { finalReviewRan: true });
  expect(report.state).toBe("passed");
  expect(report.issues).toEqual(issues);
});

it("distinguishes a retained concern with incomplete auxiliary checks and accepts legacy failure records", () => {
  const rows = pictureBookCitationRowsSchema.parse([captured]);
  const error = new PictureBookReviewIncompleteError({ version: 2, reviews: [], unresolvedPageIndexes: [13],
    validationIssues: [{ pageIndex: 13, message: "Story extraction is incomplete." }], protocolIssues: [],
    roundsStarted: 2, attemptsUsed: 2, outputWidened: false, editorialRows: rows });
  const saved = repairFailureSchema.parse(JSON.parse(JSON.stringify(repairFailure("p13", 13, error))));
  expect(saved.reviewFindings?.[0]?.validationFailure).toBe("auxiliary");
  const concern = finalRepairQualityIssues({ repairFailures: [saved] }, []).find(issue => issue.code === "MANUSCRIPT_FINDING_UNVERIFIED");
  expect(concern?.message).toContain("Editorial concern on candidate page 13");
  expect(concern?.guidance).toContain("auxiliary review checks are incomplete");
  expect(concern?.provenance?.verification).toBe("unverified");
  const legacy = { ...saved, reviewFindings: saved.reviewFindings?.map(({ validationFailure: _kind, ...finding }) => finding) };
  expect(repairFailureSchema.safeParse(legacy).success).toBe(true);
  expect(finalRepairQualityIssues({ repairFailures: [legacy] }, []).find(issue => issue.code === "MANUSCRIPT_FINDING_UNVERIFIED")?.message)
    .toContain("Unverified editorial concern");
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

it("retains both malformed-metadata diagnoses and all cited pages through repair failure serialization", () => {
  const rows = metadata.response.findings.map(({ pageIndex, ...finding }) => ({
    ...metadata.response.pages.find(page => page.pageIndex === pageIndex), pageIndex,
    findings: [finding], styleAudit: null
  }));
  const error = new PictureBookReviewIncompleteError({ version: 2, reviews: [], unresolvedPageIndexes: [4, 25],
    validationIssues: [], protocolIssues: [], roundsStarted: 2, attemptsUsed: 2, outputWidened: false,
    metadataRows: pictureBookMetadataRowsSchema.parse(rows) });
  const saved = repairFailureSchema.parse(JSON.parse(JSON.stringify(repairFailure("p19", 19, error, "repair-metadata"))));
  const issues = finalRepairQualityIssues({ repairFailures: [saved] }, []);
  const concerns = issues.filter(issue => issue.code === "MANUSCRIPT_FINDING_UNVERIFIED");
  expect(concerns).toHaveLength(2);
  expect(concerns[0]?.message).toContain(metadata.response.findings[0]!.message);
  expect(concerns[1]).toMatchObject({ affectedPageIndexes: [25, 26, 27, 28, 29],
    message: expect.stringContaining(metadata.response.findings[1]!.message), provenance: { verification: "unverified" } });
  expect(concerns.every(issue => issue.evidence === undefined)).toBe(true);
  expect(saved.reviewFindings?.every(finding => finding.validationFailure === "repair_metadata")).toBe(true);
  expect(concerns[1]?.message).toContain("Editorial concern on candidate page 25");
  expect(concerns[1]?.guidance).toContain("repair scope");
  expect(issues.find(issue => issue.code === "FINAL_QA_REPAIR_UNAVAILABLE")?.message)
    .toContain("Editorial concerns were found, but repair metadata could not be verified");
  // Unverified concerns are console diagnostics: kept on the report, never the reader's grade.
  const report = buildManuscriptQualityReport([], issues, { finalReviewRan: true });
  expect(report.state).toBe("passed");
  expect(report.issues).toEqual(issues);
});
