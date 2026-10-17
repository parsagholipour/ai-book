import { describe, expect, it, vi } from "vitest";
import { buildManuscriptQualityReport, pageFindingProvenance, type ManuscriptQualityIssue } from "@book-maker/core";
import captured from "../../../packages/core/src/generation/testing/premiumQualityIssues.json" with { type: "json" };
import crossPage from "../../../packages/core/src/generation/testing/crossPageQualityIssues.json" with { type: "json" };
vi.mock("@book-maker/db", () => ({ prisma: {} }));
import { normalizeProjectQuality } from "./projectStatus.js";

describe("quality finding cards", () => {
  it("does not silently change historical groups while leaving their saved score unchanged", () => {
    const groups = [[0, 8], [1, 10], [2], [3], [4], [5], [6], [7], [9], [11]];
    const historical = { score: 50, state: "review_recommended", scoreBasis: "unresolved_findings", issues: crossPage.balanced,
      findings: groups.map((issueIndexes, n) => ({ id: `historical-${n}`, issueIndexes, severity: "warning" })) };
    expect(normalizeProjectQuality(historical)).toMatchObject({ score: 50, issues: expect.any(Array) });
    expect(normalizeProjectQuality(historical).issues).toHaveLength(10);
    // Graded since the split: these are all console diagnostics, grouped into the same six cards,
    // and the reader's card is an unblemished pass.
    const rebuilt = buildManuscriptQualityReport([], crossPage.balanced as ManuscriptQualityIssue[], { finalReviewRan: true });
    expect(normalizeProjectQuality(rebuilt).issues).toHaveLength(0);
    expect(normalizeProjectQuality(rebuilt).diagnosticIssues).toHaveLength(6);
    expect(normalizeProjectQuality(rebuilt).score).toBe(100);
  });
  it("preserves cross-page identity and related evidence through API normalization", () => {
    const provenance = pageFindingProvenance(9, "The lantern is no longer there.", [6, 7]);
    const base: ManuscriptQualityIssue = { code: "WHOLE_BOOK_REVIEW", severity: "warning", source: "model", message: "Page 9: The lantern is no longer there.",
      guidance: "Correct the location.", affectedPageIndexes: [9, 6, 7], provenance };
    const report = buildManuscriptQualityReport([], [base, { ...base, code: "PAGE_QA_UNRESOLVED", affectedPageIndexes: [9],
      message: "Page QA did not approve the saved draft: The lantern is no longer there." }], { finalReviewRan: true });
    const result = normalizeProjectQuality(JSON.parse(JSON.stringify(report)));
    expect(result.score).toBe(100);
    expect(result.issues).toHaveLength(0);
    expect(result.diagnosticIssues).toHaveLength(1);
    expect(result.diagnosticIssues?.[0]).toMatchObject({ affectedPageIndexes: [9, 6, 7], provenance });
  });
  it("shows one card per finding while preserving repair history and the saved ledger", () => {
    const report = buildManuscriptQualityReport([], captured as ManuscriptQualityIssue[], { finalReviewRan: true });
    const serialized = JSON.parse(JSON.stringify(report));
    const normalized = normalizeProjectQuality(serialized);
    expect(normalized.score).toBe(100);
    expect(normalized.scoreBasis).toBe("unresolved_findings");
    expect(normalized.state).toBe("passed");
    expect(normalized.issues).toHaveLength(0);
    expect(normalized.diagnosticIssues).toHaveLength(2);
    expect(normalized.diagnosticIssues?.[0]?.message).toContain("Automatic repair was rejected");
    expect(normalized.diagnosticIssues?.[0]?.affectedPageIndexes).toEqual([10]);
    expect(serialized.issues).toHaveLength(5);
  });

  it("does not reinterpret old reports or erase an error behind a warning", () => {
    const legacy = { state: "review_recommended", score: 75, issues: captured };
    expect(normalizeProjectQuality(legacy).issues).toHaveLength(5);
    const report = buildManuscriptQualityReport([], [
      ...(captured as ManuscriptQualityIssue[]),
      { ...captured[0]!, source: "deterministic", severity: "error", code: "PLACEHOLDER_TEXT", message: "TODO remains." }
    ], { finalReviewRan: true });
    const normalized = normalizeProjectQuality(report);
    // An unmeasured integrity error blocks no reader since the split; the console keeps its severity.
    expect(normalized.state).toBe("passed");
    expect(normalized.diagnosticIssues).toHaveLength(3);
    expect(normalized.diagnosticIssues?.find(i => i.code === "PLACEHOLDER_TEXT")?.severity).toBe("error");
  });
});
