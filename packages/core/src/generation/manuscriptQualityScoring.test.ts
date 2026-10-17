import { describe, expect, it } from "vitest";
import captured from "./testing/premiumQualityIssues.json" with { type: "json" };
import { appendQualityIssue, buildManuscriptQualityReport, type ManuscriptQualityIssue } from "./manuscriptQuality.js";
import { groupManuscriptQualityFindings, manuscriptQualityCards, manuscriptQualityPenalty } from "./manuscriptQualityFindings.js";

const issues = captured as ManuscriptQualityIssue[];
/**
 * The ledger's own charge: the score these findings would carry if a reader saw
 * them all. Since the split the reader's `score` counts only `readerFindings`,
 * and none of these captured types is one, so the grouping is measured here.
 */
const ledgerScore = (report: { findings?: Parameters<typeof manuscriptQualityPenalty>[0] }) =>
  Math.max(0, 100 - manuscriptQualityPenalty(report.findings ?? []));
describe("finding-based quality scores", () => {
  it("charges the captured Premium defect once, retaining every diagnostic", () => {
    const report = buildManuscriptQualityReport([], issues, { finalReviewRan: true });
    expect(report.state).toBe("passed");
    expect(report.score).toBe(100);
    expect(ledgerScore(report)).toBe(90);
    expect(report.issues).toEqual(issues);
    expect(report.scoreBasis).toBe("unresolved_findings");
    expect(report.findings?.map(f => f.issueIndexes.length)).toEqual([4, 1]);
    const cards = manuscriptQualityCards(report.issues);
    expect(cards).toHaveLength(2);
    expect(cards[0]?.message).toContain("Automatic repair was rejected");
    expect(cards[0]?.guidance).toContain("Add a concrete comparison");
  });

  it("does not charge a repeated diagnosis when appending repair history", () => {
    const original = buildManuscriptQualityReport([], issues.filter(i => i.code !== "FINAL_QA_REPAIR_REJECTED"), { finalReviewRan: true });
    const updated = appendQualityIssue(original, issues.find(i => i.code === "FINAL_QA_REPAIR_REJECTED")!);
    expect(ledgerScore(updated)).toBe(90);
    expect(updated.issues).toHaveLength(5);
  });

  it("reconciles earlier observations when page QA supplies their relationship", () => {
    const priorIssues = issues.filter(i => i.code !== "PAGE_QA_UNRESOLVED");
    const original = buildManuscriptQualityReport([], priorIssues, { finalReviewRan: true });
    const updated = appendQualityIssue(original, issues.find(i => i.code === "PAGE_QA_UNRESOLVED")!);
    expect(ledgerScore(updated)).toBe(90);
    expect(ledgerScore(updated)).toBe(ledgerScore(buildManuscriptQualityReport([], issues, { finalReviewRan: true })));
    expect(updated.state).toBe("passed");
    expect(updated.issues).toHaveLength(5);
    // A report made before the split grades every issue on append, as it always did.
    const { scoreBasis: _basis, findings: _findings, readerFindings: _reader, readerPolicy: _policy, ...legacy } = original;
    expect(appendQualityIssue(legacy, issues.find(i => i.code === "PAGE_QA_UNRESOLVED")!).score).toBe(90);
  });

  it("keeps distinct same-page defects, unrelated repair failures and severity", () => {
    const extra: ManuscriptQualityIssue[] = [
      { ...issues[0]!, message: "Page 10: A second unrelated continuity defect." },
      { ...issues[2]!, message: "Automatic repair was rejected: A new contradiction was introduced." },
      { ...issues[2]!, code: "FINAL_QA_REPAIR_UNAVAILABLE", message: "Provider failed." },
      { ...issues[0]!, code: "PLACEHOLDER_TEXT", message: "TODO remains.", severity: "error" }
    ];
    const result = buildManuscriptQualityReport(extra, issues, { finalReviewRan: false, deterministicWarningsAffectVerdict: false });
    expect(result.findings).toHaveLength(6);
    expect(result.state).toBe("passed");
    expect(ledgerScore(result)).toBe(57);
  });

  it("does not link a repair with multiple diagnoses of the same requirement", () => {
    const separate = { ...issues[0]!, message: issues[0]!.message.replace("Wise Turtle reads", "A separate scene shows that Wise Turtle reads") };
    expect(groupManuscriptQualityFindings([...issues, separate])).toHaveLength(4);
  });

  it("keeps all pages in identity and makes grouping stable across serialization and order", () => {
    const ids = (rows: ManuscriptQualityIssue[]) => groupManuscriptQualityFindings(rows).map(f => f.id).sort();
    expect(ids([...issues].reverse())).toEqual(ids(issues));
    expect(ids(JSON.parse(JSON.stringify(issues)))).toEqual(ids(issues));
    const elsewhere = { ...issues[2]!, affectedPageIndexes: [10, 11] };
    expect(groupManuscriptQualityFindings([...issues, elsewhere])).toHaveLength(3);
  });

  it("escalates an exact duplicate's severity once without changing its identity", () => {
    const warning = issues[3]!;
    const report = buildManuscriptQualityReport([], [warning], { finalReviewRan: true });
    const error = { ...warning, severity: "error" as const };
    const next = appendQualityIssue(report, error);
    expect(ledgerScore(next)).toBe(82);
    expect(next.state).toBe("passed");
    expect(next.findings?.[0]?.id).toBe(report.findings?.[0]?.id);
    expect(ledgerScore(appendQualityIssue(next, error))).toBe(82);
  });

  it("retains a diagnosis even when duplicate guidance has the same text", () => {
    const issue = { ...issues[3]!, message: "Restore Rabbit's playfulness.", guidance: "Restore Rabbit's playfulness." };
    expect(manuscriptQualityCards([issue, { ...issue }])[0]?.message).toBe(issue.message);
  });
});
