import { describe, expect, it } from "vitest";
import {
  MANUSCRIPT_STRUCTURAL_AUDIT_DETECTOR_VERSION,
  SENTENCE_OPENING_CLEAN_CORPUS_BASELINE,
  SENTENCE_OPENING_WARNING_BASELINE_MULTIPLIER,
  SENTENCE_OPENING_WARNING_MIN_OCCURRENCES,
  STRUCTURAL_FAMILY_PAGE_RATIO_BLOCKING,
  buildManuscriptQualityReport,
  runDeterministicManuscriptChecks
} from "./manuscriptQuality.js";
import { replayDeterministicManuscriptChecks } from "./manuscriptReplay.js";
import {
  bandhaRecapPages,
  fourParaphrasedIndusWeightPages,
  indusSubjectDistinctEvidencePages,
  interiorRatherThanCadencePages,
  isolatedBalancedCaveatPages,
  manuscriptWideSymmetricalHedgingPages,
  nonCountableCadenceDecoyPages,
  performanceManuscript,
  persianWithEnglishHedgeIslands,
  singleRatherThanUsePages
} from "./testing/manuscriptStructuralAuditFixtures.js";

describe("manuscript structural audit", () => {
  it("pins named shadow thresholds", () => {
    expect(SENTENCE_OPENING_WARNING_MIN_OCCURRENCES).toBe(12);
    expect(SENTENCE_OPENING_CLEAN_CORPUS_BASELINE * SENTENCE_OPENING_WARNING_BASELINE_MULTIPLIER).toBe(12);
    expect(STRUCTURAL_FAMILY_PAGE_RATIO_BLOCKING).toBe(0.2);
    expect(MANUSCRIPT_STRUCTURAL_AUDIT_DETECTOR_VERSION).toBe("manuscript-structural-audit-v1");
  });

  it("forms one same-chapter cluster from four paraphrased historical treatments", () => {
    const pages = fourParaphrasedIndusWeightPages();
    const issues = runDeterministicManuscriptChecks({ pages, expectedPageCount: pages.length, language: "en" });
    const treatment = issues.filter((issue) => issue.code === "SAME_CHAPTER_TREATMENT_REPETITION");

    expect(treatment).toHaveLength(1);
    expect(treatment[0]?.affectedPageIndexes).toEqual([1, 2, 3, 4]);
    expect(treatment[0]?.metrics?.clusterCount).toBe(1);
    expect(treatment[0]?.metrics?.occurrences).toBe(4);
    expect(treatment[0]?.metrics?.wouldBlock).toBe(true);
    expect(treatment[0]?.evidence?.length).toBeGreaterThanOrEqual(4);
    expect(treatment[0]?.evidence?.every((entry) => entry.excerpt.length > 0 && entry.excerpt.length <= 140)).toBe(true);
    expect(issues.map((issue) => issue.code)).not.toContain("NEAR_DUPLICATE_PAGES");
    expect(issues.map((issue) => issue.code)).not.toContain("STRUCTURAL_SLOP_SATURATION");

    const report = buildManuscriptQualityReport(issues, [], {
      finalReviewRan: true,
      manuscriptPageCount: pages.length
    });
    expect(report.state).toBe("review_recommended");
    expect(report.diagnostics?.wouldBlock).toBe(true);
    expect(report.diagnostics?.detectorVersion).toBe(MANUSCRIPT_STRUCTURAL_AUDIT_DETECTOR_VERSION);
  });

  it("leaves a shared subject with distinct evidence and conclusions clean", () => {
    const pages = indusSubjectDistinctEvidencePages();
    const issues = runDeterministicManuscriptChecks({ pages, expectedPageCount: pages.length, language: "en" });

    expect(issues.map((issue) => issue.code)).not.toContain("SAME_CHAPTER_TREATMENT_REPETITION");
    expect(issues.map((issue) => issue.code)).not.toContain("RECAP_BACKTRACKING");
  });

  it("protects an isolated balanced caveat", () => {
    const pages = isolatedBalancedCaveatPages();
    const issues = runDeterministicManuscriptChecks({ pages, expectedPageCount: pages.length, language: "en" });

    expect(issues.map((issue) => issue.code)).not.toContain("SYMMETRICAL_HEDGING");
    expect(issues.map((issue) => issue.code)).not.toContain("SENTENCE_OPENING_CADENCE");
  });

  it("records hedge occurrence and page ratios, and shadows would_block without publication blocking", () => {
    const pages = manuscriptWideSymmetricalHedgingPages();
    const issues = runDeterministicManuscriptChecks({ pages, expectedPageCount: pages.length, language: "en" });
    const hedging = issues.find((issue) => issue.code === "SYMMETRICAL_HEDGING");

    expect(hedging).toBeDefined();
    expect(hedging?.metrics?.occurrences).toBe(40);
    expect(hedging?.metrics?.affectedPageRatio).toBeCloseTo(40 / 120);
    expect(hedging?.metrics?.chaptersSpanned).toBeGreaterThanOrEqual(5);
    expect(hedging?.metrics?.wouldBlock).toBe(true);
    expect(issues.map((issue) => issue.code)).not.toContain("STRUCTURAL_SLOP_SATURATION");
    expect(issues.filter((issue) => issue.code === "SYMMETRICAL_HEDGING")).toHaveLength(1);

    const report = buildManuscriptQualityReport(issues, [], {
      finalReviewRan: true,
      manuscriptPageCount: 120
    });
    expect(report.state).toBe("review_recommended");
    expect(report.diagnostics?.wouldBlock).toBe(true);
    expect(report.diagnostics?.findings.some((finding) => finding.code === "SYMMETRICAL_HEDGING" && finding.wouldBlock)).toBe(
      true
    );
  });

  it("counts sentence-opening families inside pages, not only page-first sentences", () => {
    const pages = interiorRatherThanCadencePages(12);
    const issues = runDeterministicManuscriptChecks({ pages, expectedPageCount: pages.length, language: "en" });
    const cadence = issues.find((issue) => issue.code === "SENTENCE_OPENING_CADENCE");

    expect(cadence).toBeDefined();
    expect(cadence?.metrics?.occurrences).toBe(12);
    expect(cadence?.message).toMatch(/Rather than/i);
    expect(cadence?.severity).toBe("warning");
    expect(cadence?.metrics?.wouldBlock).toBe(false);
  });

  it("does not inflate cadence counts from headings, lists, quotations, fragments, or abbreviations", () => {
    const pages = nonCountableCadenceDecoyPages();
    const issues = runDeterministicManuscriptChecks({ pages, expectedPageCount: pages.length, language: "en" });

    expect(issues.map((issue) => issue.code)).not.toContain("SENTENCE_OPENING_CADENCE");
  });

  it("keeps one precise sentence-opening use clean", () => {
    const pages = singleRatherThanUsePages();
    const issues = runDeterministicManuscriptChecks({ pages, expectedPageCount: pages.length, language: "en" });

    expect(issues.map((issue) => issue.code)).not.toContain("SENTENCE_OPENING_CADENCE");
  });

  it("clusters recap and backtracking instead of emitting one issue per pair", () => {
    const pages = bandhaRecapPages();
    const issues = runDeterministicManuscriptChecks({ pages, expectedPageCount: pages.length, language: "en" });
    const recap = issues.filter((issue) => issue.code === "RECAP_BACKTRACKING");

    expect(recap).toHaveLength(1);
    expect(recap[0]?.affectedPageIndexes).toEqual([1, 2, 3]);
    expect(recap[0]?.metrics?.clusterCount).toBe(1);
    expect(recap[0]?.metrics?.wouldBlock).toBe(true);
    expect(recap[0]?.evidence?.some((entry) => entry.excerpt.length > 0)).toBe(true);

    const report = buildManuscriptQualityReport(issues, [], {
      finalReviewRan: true,
      manuscriptPageCount: pages.length
    });
    expect(report.state).toBe("review_recommended");
    expect(report.diagnostics?.wouldBlock).toBe(true);
  });

  it("does not run English phrase families on a non-English manuscript", () => {
    const pages = persianWithEnglishHedgeIslands();
    const issues = runDeterministicManuscriptChecks({
      pages,
      expectedPageCount: pages.length,
      language: "fa"
    });

    expect(issues.map((issue) => issue.code)).not.toContain("SYMMETRICAL_HEDGING");
    expect(issues.map((issue) => issue.code)).not.toContain("SENTENCE_OPENING_CADENCE");
    expect(issues.map((issue) => issue.code)).not.toContain("RESEARCH_META_FRAMING");
    expect(issues.map((issue) => issue.code)).not.toContain("GENERIC_HISTORICAL_PLACEHOLDERS");
  });

  it("replays supplied pages without reading storage paths", () => {
    const pages = fourParaphrasedIndusWeightPages();
    const replayed = replayDeterministicManuscriptChecks({ pages, language: "en" });

    expect(replayed.elapsedMs).toBeGreaterThanOrEqual(0);
    expect(replayed.diagnostics.detectorVersion).toBe(MANUSCRIPT_STRUCTURAL_AUDIT_DETECTOR_VERSION);
    expect(replayed.issues.some((issue) => issue.code === "SAME_CHAPTER_TREATMENT_REPETITION")).toBe(true);
  });

  it("audits 120 pages within the CI performance budget", () => {
    const pages = performanceManuscript(120);
    const replayed = replayDeterministicManuscriptChecks({ pages, language: "en" });

    expect(replayed.elapsedMs).toBeLessThan(1500);
    expect(replayed.issues.map((issue) => issue.code)).not.toContain("STRUCTURAL_SLOP_SATURATION");
  });
});
