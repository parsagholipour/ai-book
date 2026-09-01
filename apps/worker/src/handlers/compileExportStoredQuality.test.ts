import { describe, expect, it } from "vitest";
import { parseStoredQualityIssue } from "./compileExportStoredQuality.js";

describe("parseStoredQualityIssue", () => {
  it("keeps canonical and duplicate pages on a corroborated cluster", () => {
    const issue = parseStoredQualityIssue({
      code: "CORROBORATED_STRUCTURAL_DUPLICATION",
      severity: "error",
      source: "model",
      message: "Page 1 is the strongest treatment; pages 2, 3 repeat its subject.",
      guidance: "Review the canonical page and the duplicates in Edit Mode.",
      affectedPageIndexes: [1, 2, 3],
      cluster: { canonicalPageIndex: 1, duplicatePageIndexes: [3, 2] }
    });
    expect(issue?.cluster).toEqual({ canonicalPageIndex: 1, duplicatePageIndexes: [2, 3] });
  });

  it("omits an invalid cluster rather than inventing pages", () => {
    const issue = parseStoredQualityIssue({
      code: "CORROBORATED_STRUCTURAL_DUPLICATION",
      severity: "error",
      source: "model",
      message: "Page 1 is the strongest treatment; pages 2 repeat its subject.",
      guidance: "Review the canonical page and the duplicates in Edit Mode.",
      affectedPageIndexes: [1, 2],
      cluster: { canonicalPageIndex: 1, duplicatePageIndexes: [1] }
    });
    expect(issue?.cluster).toBeUndefined();
  });
});
