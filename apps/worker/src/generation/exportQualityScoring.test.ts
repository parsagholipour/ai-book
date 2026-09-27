import { expect, it } from "vitest";
import { buildManuscriptQualityReport, type ManuscriptQualityIssue } from "@book-maker/core";
import saved from "../../../../packages/core/src/generation/testing/premiumQualityIssues.json" with { type: "json" };
import { qualityIssuesFromFinalQa } from "./exportQualityProvenance.js";
import { unresolvedPageQualityIssues } from "./unresolvedPageQuality.js";
import { finalRepairQualityIssues } from "../handlers/compileRepairOutcome.js";
import { parseStoredQualityIssue } from "../handlers/compileExportStoredQuality.js";
import crossPage from "../../../../packages/core/src/generation/testing/crossPageQualityIssues.json" with { type: "json" };

it("scores the actual final-QA, page-QA and repair producers once across stored-report reconstruction", () => {
  const [diagnosis, guidance, rejection, missing] = saved as ManuscriptQualityIssue[];
  const issues = [
    ...qualityIssuesFromFinalQa({ approved: false, issues: [diagnosis!.message], requiredFixes: [guidance!.message] }, 30),
    ...finalRepairQualityIssues({ repairFailures: [{ pageId: "p10", targetPageIndex: 10, failureClass: "verification_failed",
      reason: rejection!.message.replace(/^Automatic repair was rejected: /u, "").replace(/ Saved prose was retained\.$/u, ""), affectedPageIndexes: [10] }] }, [{ id: "p10", index: 10 }]),
    missing!,
    ...unresolvedPageQualityIssues([{ index: 10, status: "FAILED_QA", qualityReport: { approved: false, score: 78,
      issues: [diagnosis!.message.replace(/^Page 10: /u, "")], requiredRevisions: [guidance!.message.replace(/^Page 10: /u, "")] } }])
  ];
  expect(issues).toHaveLength(5);
  const initial = buildManuscriptQualityReport([], issues, { finalReviewRan: true });
  expect(initial.score).toBe(90);
  const parsed = JSON.parse(JSON.stringify(initial)).issues.map(parseStoredQualityIssue);
  expect(parsed.every(Boolean)).toBe(true);
  const resumed = buildManuscriptQualityReport([], parsed, { finalReviewRan: true });
  expect(resumed.score).toBe(90);
  expect(resumed.findings).toEqual(initial.findings);
});

it("carries one cross-page identity through the real producers and stored report parsing", () => {
  const diagnosis = crossPage.premium[0]!, guidance = crossPage.premium[1]!, unresolved = crossPage.premium[4]!;
  const pages = [{ index: 29, status: "FAILED_QA", qualityReport: { approved: false, score: 88,
    issues: [unresolved.message.replace(/^Page QA did not approve the saved draft: /u, "")], requiredRevisions: [unresolved.guidance] } }];
  const rows = [...qualityIssuesFromFinalQa({ approved: false, issues: [diagnosis.message], requiredFixes: [guidance.message] }, 30, pages),
    ...unresolvedPageQualityIssues(pages)];
  expect(rows).toHaveLength(3);
  expect(new Set(rows.map(row => row.provenance?.findingId)).size).toBe(1);
  const parsed = JSON.parse(JSON.stringify(rows)).map(parseStoredQualityIssue);
  expect(parsed).toEqual(rows);
  expect(buildManuscriptQualityReport([], parsed, { finalReviewRan: true }).score).toBe(95);
});
