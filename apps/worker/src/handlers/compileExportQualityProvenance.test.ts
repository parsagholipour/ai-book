import { describe, expect, it } from "vitest";
import type { ManuscriptQualityReport } from "@book-maker/core";
import {
  qualityReportWithProvenance,
  storedQualityProvenance
} from "./compileExportQualityProvenance.js";

const report: ManuscriptQualityReport = {
  state: "review_recommended",
  score: 95,
  issues: [],
  affectedPageIndexes: [],
  checkedAt: "2026-09-01T00:00:00.000Z"
};

describe("compile quality provenance", () => {
  it("preserves an initial warning verdict when model review did not run", () => {
    const stored = qualityReportWithProvenance(report, {
      finalReviewRan: false,
      deterministicWarningsAffectVerdict: true,
      reviewedPages: [{ index: 1, revision: 2, title: "Opening", markdown: "Prose." }]
    });

    expect(storedQualityProvenance(stored)).toMatchObject({
      version: 1,
      finalReviewRan: false,
      deterministicWarningsAffectVerdict: true,
      reviewedPages: [expect.objectContaining({ index: 1, revision: 2 })]
    });
  });

  it("reconstructs legacy reports with the old final-review warning policy", () => {
    const legacy = {
      ...report,
      _standDownProvenance: {
        version: 1,
        finalReviewRan: false,
        reviewedPages: [{ index: 1, revision: 2, contentHash: "a".repeat(64) }]
      }
    };

    expect(storedQualityProvenance(legacy)).toMatchObject({
      finalReviewRan: false,
      deterministicWarningsAffectVerdict: false
    });
  });
});
