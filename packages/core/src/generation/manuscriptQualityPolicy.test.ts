import { describe, expect, it } from "vitest";
import { manuscriptWarning, type ManuscriptQualityIssue } from "./manuscriptQualityIssue.js";
import {
  PUBLICATION_CORROBORATION_CODES,
  evaluateManuscriptBlockingPolicy,
  manuscriptQualityDiagnostics
} from "./manuscriptQualityPolicy.js";

function warning(
  code: string,
  affectedPageIndexes: number[],
  metrics: {
    occurrences: number;
    affectedPageRatio: number;
    chaptersSpanned: number;
  }
): ManuscriptQualityIssue {
  return manuscriptWarning(code, `${code} warning`, "Review the repeated construction.", affectedPageIndexes, {
    metrics
  });
}

function policyFor(issues: readonly ManuscriptQualityIssue[], pageCount: number) {
  const policy = evaluateManuscriptBlockingPolicy(issues, pageCount);
  const diagnostics = manuscriptQualityDiagnostics(issues, pageCount);
  return { policy, diagnostics };
}

describe("evaluateManuscriptBlockingPolicy", () => {
  it("does not wouldBlock an original structural family on 3 pages of a long book", () => {
    for (const code of PUBLICATION_CORROBORATION_CODES) {
      const issues = [
        warning(code, [10, 11, 12], {
          occurrences: 3,
          affectedPageRatio: 3 / 120,
          chaptersSpanned: 1
        })
      ];
      const { policy, diagnostics } = policyFor(issues, 120);
      const finding = diagnostics.findings.find((entry) => entry.code === code);

      expect(policy.findingWouldBlock.get(`${code}:10,11,12`), code).toBe(false);
      expect(policy.wouldBlock, code).toBe(false);
      expect(policy.reasons, code).not.toContain("cluster");
      expect(finding?.wouldBlock, code).toBe(false);
      expect(diagnostics.wouldBlock, code).toBe(false);
    }
  });

  it("wouldBlocks a recap cluster of 3 pages even when it is well under saturation", () => {
    const issues = [
      warning("RECAP_BACKTRACKING", [4, 8, 19], {
        occurrences: 3,
        affectedPageRatio: 3 / 120,
        chaptersSpanned: 2
      })
    ];
    const { policy, diagnostics } = policyFor(issues, 120);
    const finding = diagnostics.findings.find((entry) => entry.code === "RECAP_BACKTRACKING");

    expect(policy.findingWouldBlock.get("RECAP_BACKTRACKING:4,8,19")).toBe(true);
    expect(policy.wouldBlock).toBe(true);
    expect(policy.reasons).toEqual(["cluster"]);
    expect(finding?.wouldBlock).toBe(true);
    expect(diagnostics.wouldBlock).toBe(true);
  });

  it("wouldBlocks a 4-page treatment cluster via the 3-page cluster rule", () => {
    const issues = [
      warning("SAME_CHAPTER_TREATMENT_REPETITION", [1, 2, 3, 4], {
        occurrences: 4,
        affectedPageRatio: 4 / 120,
        chaptersSpanned: 1
      })
    ];
    const { policy, diagnostics } = policyFor(issues, 120);

    expect(policy.wouldBlock).toBe(true);
    expect(policy.reasons).toEqual(["cluster"]);
    expect(diagnostics.findings[0]?.wouldBlock).toBe(true);
  });

  it("wouldBlocks the 40/120 hedge via page-share and occurrence-span, not the cluster floor", () => {
    const issues = [
      warning("SYMMETRICAL_HEDGING", Array.from({ length: 40 }, (_, offset) => offset + 1), {
        occurrences: 40,
        affectedPageRatio: 40 / 120,
        chaptersSpanned: 5
      })
    ];
    const { policy, diagnostics } = policyFor(issues, 120);

    expect(policy.wouldBlock).toBe(true);
    expect(policy.reasons).toEqual(expect.arrayContaining(["page-ratio", "occurrence-span"]));
    expect(policy.reasons).not.toContain("cluster");
    expect(diagnostics.findings[0]?.wouldBlock).toBe(true);
    expect(diagnostics.wouldBlock).toBe(true);
  });

  it("keeps sentence-opening cadence as a warning candidate, not a 3-page wouldBlock", () => {
    const issues = [
      warning("SENTENCE_OPENING_CADENCE", [1, 2, 3], {
        occurrences: 12,
        affectedPageRatio: 3 / 120,
        chaptersSpanned: 3
      })
    ];
    const { policy, diagnostics } = policyFor(issues, 120);

    expect(policy.findingWouldBlock.get("SENTENCE_OPENING_CADENCE:1,2,3")).toBe(false);
    expect(policy.wouldBlock).toBe(false);
    expect(policy.reasons).toEqual(["cadence-warning"]);
    expect(diagnostics.wouldBlock).toBe(false);
    expect(diagnostics.findings[0]?.wouldBlock).toBe(false);
  });

  it("still wouldBlocks three original families together via corroboration", () => {
    const issues = [
      warning("REPEATED_ANALYTICAL_GRID", [1, 2, 3], {
        occurrences: 3,
        affectedPageRatio: 3 / 120,
        chaptersSpanned: 1
      }),
      warning("SYMMETRICAL_HEDGING", [10, 11, 12], {
        occurrences: 3,
        affectedPageRatio: 3 / 120,
        chaptersSpanned: 1
      }),
      warning("FRAMEWORK_SATURATION", [20, 21, 22], {
        occurrences: 3,
        affectedPageRatio: 3 / 120,
        chaptersSpanned: 1
      })
    ];
    const { policy, diagnostics } = policyFor(issues, 120);

    expect(policy.corroboration).toBe(true);
    expect(policy.wouldBlock).toBe(true);
    expect(policy.reasons).toContain("corroboration");
    expect(policy.reasons).not.toContain("cluster");
    expect(diagnostics.wouldBlock).toBe(true);
    expect(diagnostics.findings.every((finding) => finding.wouldBlock)).toBe(true);
  });
});
