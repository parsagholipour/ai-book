import { expect, it } from "vitest";
import captured from "./testing/crossPageQualityIssues.json" with { type: "json" };
import { buildManuscriptQualityReport, type ManuscriptQualityIssue } from "./manuscriptQuality.js";
import { groupManuscriptQualityFindings, manuscriptQualityCards } from "./manuscriptQualityFindings.js";
import { pageFindingProvenance, optionalQualityProvenance } from "./manuscriptQualityProvenance.js";

it.each([['balanced', 70, 6], ['premium', 85, 3]] as const)("scores the captured %s cross-page findings once", (tier, score, count) => {
  const issues = captured[tier] as ManuscriptQualityIssue[];
  const result = buildManuscriptQualityReport([], issues, { finalReviewRan: true });
  expect(result.score).toBe(score);
  expect(result.findings).toHaveLength(count);
  expect(manuscriptQualityCards(result.issues)).toHaveLength(count);
  expect(result.issues.map(i => i.message)).toEqual(issues.map(i => i.message));
});

it("does not merge distinct explicit findings even when their wording matches", () => {
  const base = captured.premium[0] as ManuscriptQualityIssue;
  const a = { ...base, provenance: { ...pageFindingProvenance(29, "a"), findingId: "a" } };
  const b = { ...base, provenance: { ...pageFindingProvenance(29, "b"), findingId: "b" } };
  expect(groupManuscriptQualityFindings([a, b])).toHaveLength(2);
});

it("does not merge two diagnoses through shared generic guidance", () => {
  const whole = captured.premium[0] as ManuscriptQualityIssue;
  const page = captured.premium[4] as ManuscriptQualityIssue;
  const rows = [whole, { ...whole, message: "Page 29: A separate problem." },
    { ...page, guidance: "Improve this page." }, { ...page, message: "Page QA did not approve the saved draft: A separate problem.", guidance: "Improve this page." },
    { ...whole, message: "Page 29: Improve this page.", affectedPageIndexes: [29] }];
  expect(groupManuscriptQualityFindings(rows)).toHaveLength(3);
});

it("retains the identity before and after page-QA observation and preserves related pages in the card", () => {
  const diagnosis = captured.premium[0] as ManuscriptQualityIssue;
  const page = captured.premium[4] as ManuscriptQualityIssue;
  const tagged = { ...diagnosis, provenance: pageFindingProvenance(29, diagnosis.message.replace(/^Page 29: /u, ""), [27]) };
  const taggedPage = { ...page, provenance: pageFindingProvenance(29, page.message.replace(/^Page QA did not approve the saved draft: /u, "")) };
  const before = groupManuscriptQualityFindings([tagged]);
  const after = groupManuscriptQualityFindings([taggedPage, tagged]);
  expect(after).toHaveLength(1);
  expect(after[0]?.id).toBe(before[0]?.id);
  expect(manuscriptQualityCards([taggedPage, tagged])[0]?.provenance).toMatchObject({ primaryPageIndex: 29, relatedPageIndexes: [27] });
});

it("separates repair operations and ignores malformed provenance fields", () => {
  const issue = captured.premium[2] as ManuscriptQualityIssue;
  const groups = groupManuscriptQualityFindings([1, 2].map(n => ({ ...issue, provenance: { kind: "repair", repairOperationId: `op-${n}` } })));
  expect(groups).toHaveLength(2);
  expect(new Set(groups.map(g => g.id)).size).toBe(2);
  expect(optionalQualityProvenance({ findingId: [], primaryPageIndex: -1, relatedPageIndexes: [2, "3"], kind: "invented", verification: "approved" })).toEqual({});
});

it("keeps a separate finding whose primary page is only related evidence for another", () => {
  const diagnosis = captured.balanced[2] as ManuscriptQualityIssue;
  const page = captured.balanced[9] as ManuscriptQualityIssue;
  const unrelated = { ...page, affectedPageIndexes: [6] };
  const result = buildManuscriptQualityReport([], [diagnosis, page, unrelated], { finalReviewRan: true });
  expect(result.findings).toHaveLength(2);
});
