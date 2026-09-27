import { describe, expect, it } from "vitest";
import captured from "./testing/premiumQualityIssues.json" with { type: "json" };
import { appendQualityIssue, buildManuscriptQualityReport, type ManuscriptQualityIssue } from "./manuscriptQuality.js";
import { groupManuscriptQualityFindings, manuscriptQualityCards } from "./manuscriptQualityFindings.js";

const issues = captured as ManuscriptQualityIssue[];
describe("finding-based quality scores", () => {
  it("charges the captured Premium defect once, retaining every diagnostic", () => {
    const report = buildManuscriptQualityReport([], issues, { finalReviewRan: true });
    expect(report.state).toBe("review_recommended");
    expect(report.score).toBe(90);
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
    expect(updated.score).toBe(90);
    expect(updated.issues).toHaveLength(5);
  });

  it("reconciles earlier observations when page QA supplies their relationship", () => {
    const priorIssues = issues.filter(i => i.code !== "PAGE_QA_UNRESOLVED");
    const original = buildManuscriptQualityReport([], priorIssues, { finalReviewRan: true });
    const updated = appendQualityIssue(original, issues.find(i => i.code === "PAGE_QA_UNRESOLVED")!);
    expect(updated.score).toBe(90);
    expect(updated.score).toBe(buildManuscriptQualityReport([], issues, { finalReviewRan: true }).score);
    expect(updated.state).toBe("review_recommended");
    expect(updated.issues).toHaveLength(5);
    const { scoreBasis: _basis, findings: _findings, ...legacy } = original;
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
    expect(result.state).toBe("blocked");
    expect(result.score).toBe(57);
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
    expect(next.score).toBe(82);
    expect(next.state).toBe("blocked");
    expect(next.findings?.[0]?.id).toBe(report.findings?.[0]?.id);
    expect(appendQualityIssue(next, error).score).toBe(82);
  });

  it("retains a diagnosis even when duplicate guidance has the same text", () => {
    const issue = { ...issues[3]!, message: "Restore Rabbit's playfulness.", guidance: "Restore Rabbit's playfulness." };
    expect(manuscriptQualityCards([issue, { ...issue }])[0]?.message).toBe(issue.message);
  });
});
