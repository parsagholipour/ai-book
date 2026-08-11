import { describe, expect, it } from "vitest";
import { appendQualityIssue, buildManuscriptQualityReport, runDeterministicManuscriptChecks } from "./manuscriptQuality.js";

describe("persistent manuscript quality gate", () => {
  it("blocks publication for deterministic integrity failures", () => {
    const issues = runDeterministicManuscriptChecks({
      expectedPageCount: 2,
      pages: [
        { index: 1, title: "Opening", markdown: "TODO: insert the finished chapter here." }
      ]
    });
    const report = buildManuscriptQualityReport(issues);

    expect(report.state).toBe("blocked");
    expect(report.issues.map((issue) => issue.code)).toEqual(
      expect.arrayContaining(["PAGE_COUNT_MISMATCH", "PLACEHOLDER_TEXT"])
    );
    expect(report.affectedPageIndexes).toContain(1);
  });

  it("keeps model-only concerns non-blocking", () => {
    const report = buildManuscriptQualityReport([], [
      {
        code: "CHAPTER_TRANSITION",
        severity: "warning",
        source: "model",
        message: "The transition is abrupt.",
        guidance: "Smooth the handoff between chapters.",
        affectedPageIndexes: [4, 5]
      }
    ]);

    expect(report.state).toBe("review_recommended");
    expect(report.affectedPageIndexes).toEqual([4, 5]);
  });

  it("passes a complete clean manuscript", () => {
    const issues = runDeterministicManuscriptChecks({
      expectedPageCount: 2,
      pages: [
        { index: 1, title: "Opening", markdown: "# Opening\n\nA complete and useful opening section." },
        { index: 2, title: "Next step", markdown: "# Next step\n\nA distinct conclusion with a concrete next step." }
      ]
    });

    expect(buildManuscriptQualityReport(issues)).toMatchObject({ state: "passed", score: 100, issues: [] });
  });

  it("flags two nearly identical pages", () => {
    const body = words(120);
    const issues = runDeterministicManuscriptChecks({
      expectedPageCount: 2,
      pages: [
        { index: 1, title: "Opening", markdown: `${body} alpha.` },
        { index: 2, title: "Repeat", markdown: `${body} beta.` }
      ]
    });

    expect(issues.map((issue) => issue.code)).toContain("NEAR_DUPLICATE_PAGES");
    expect(issues.find((issue) => issue.code === "NEAR_DUPLICATE_PAGES")?.affectedPageIndexes).toEqual([1, 2]);
  });

  it("does not flag two distinct pages of the same length", () => {
    const issues = runDeterministicManuscriptChecks({
      expectedPageCount: 2,
      pages: [
        { index: 1, title: "Opening", markdown: words(120, "left") },
        { index: 2, title: "Closing", markdown: words(120, "right") }
      ]
    });

    expect(issues.map((issue) => issue.code)).not.toContain("NEAR_DUPLICATE_PAGES");
  });

  it("ignores pages under the 80-word floor even when identical", () => {
    const body = words(40);
    const issues = runDeterministicManuscriptChecks({
      expectedPageCount: 2,
      pages: [
        { index: 1, title: "Opening", markdown: body },
        { index: 2, title: "Repeat", markdown: body }
      ]
    });

    expect(issues.map((issue) => issue.code)).not.toContain("NEAR_DUPLICATE_PAGES");
  });

  it("does not flag a short page whose words are all reused by a much longer one", () => {
    // The Jaccard size bound rejects this in O(1). It has to agree with the
    // full computation: 100 shared words over a 300-word union is 0.33.
    const shared = words(100);
    const issues = runDeterministicManuscriptChecks({
      expectedPageCount: 2,
      pages: [
        { index: 1, title: "Short", markdown: shared },
        { index: 2, title: "Long", markdown: `${shared} ${words(200, "extra")}` }
      ]
    });

    expect(issues.map((issue) => issue.code)).not.toContain("NEAR_DUPLICATE_PAGES");
  });

  it("appends a post-hoc warning without erasing the original checks", () => {
    const report = buildManuscriptQualityReport([]);

    const degraded = appendQualityIssue(report, {
      code: "EPUB_EXPORT_FAILED",
      severity: "warning",
      source: "deterministic",
      message: "EPUB export failed; PDF and markdown are available.",
      guidance: "Download the PDF, or re-run the export to retry the EPUB.",
      affectedPageIndexes: []
    });

    expect(degraded.state).toBe("review_recommended");
    expect(degraded.score).toBe(95);
    expect(degraded.issues.map((issue) => issue.code)).toContain("EPUB_EXPORT_FAILED");
    // The original report is not mutated.
    expect(report.state).toBe("passed");
    expect(report.issues).toHaveLength(0);
  });

  it("never improves the state when appending to a blocked report", () => {
    const blocked = buildManuscriptQualityReport(
      runDeterministicManuscriptChecks({ expectedPageCount: 1, pages: [] })
    );

    const appended = appendQualityIssue(blocked, {
      code: "EPUB_EXPORT_FAILED",
      severity: "warning",
      source: "deterministic",
      message: "EPUB export failed.",
      guidance: "Retry the export.",
      affectedPageIndexes: []
    });

    expect(appended.state).toBe("blocked");
  });
});

/** `count` distinct words, so a page's vocabulary size is exactly `count`. */
function words(count: number, prefix = "word"): string {
  return Array.from({ length: count }, (_, index) => `${prefix}${index}`).join(" ");
}
