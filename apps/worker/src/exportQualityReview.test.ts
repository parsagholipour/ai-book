import { describe, expect, it } from "vitest";
import {
  clipQualityText,
  clipQualityTextPrefix,
  clipQualityTextSuffix,
  qualityIssuesFromFinalQa
} from "./exportQualityReview.js";

describe("clipQualityText", () => {
  it("returns short text unchanged", () => {
    expect(clipQualityText("Finished sentence.", 2200)).toBe("Finished sentence.");
  });

  it("preserves the real page ending when truncating", () => {
    const head = "START " + "a".repeat(3000);
    const tail = " the final complete sentence ends here.";
    const full = `${head}${tail}`;
    const clipped = clipQualityText(full, 2200);
    expect(clipped.length).toBeLessThanOrEqual(2200);
    expect(clipped).toContain("\n…\n");
    expect(clipped.startsWith("START ")).toBe(true);
    expect(clipped.endsWith(tail.trimStart())).toBe(true);
    expect(clipped).not.toMatch(/a{10}…$/);
  });

  it("does not look like a mid-sentence-only ending for long pages", () => {
    const full = `${"Word ".repeat(800)}Color: green. Domain: forests and abundance.`;
    const clipped = clipQualityText(full, 2200);
    expect(clipped.endsWith("Color: green. Domain: forests and abundance.")).toBe(true);
    expect(clipped).not.toMatch(/Color: gr…$/);
  });
});

describe("clipQualityTextPrefix and clipQualityTextSuffix", () => {
  it("keeps openings from the start and endings from the end", () => {
    const text = "OPENING paragraph one. " + "x".repeat(2000) + " CLOSING paragraph end.";
    expect(clipQualityTextPrefix(text, 1000).startsWith("OPENING paragraph one.")).toBe(true);
    expect(clipQualityTextSuffix(text, 1000).endsWith("CLOSING paragraph end.")).toBe(true);
    expect(clipQualityTextSuffix(text, 1000).startsWith("…")).toBe(true);
  });
});

describe("qualityIssuesFromFinalQa", () => {
  it("ignores advisory issues when final QA approved the book", () => {
    const issues = qualityIssuesFromFinalQa(
      {
        approved: true,
        issues: ["Page 7 summary ends with 'They...' which is acceptable as a pageMap truncation."],
        requiredFixes: []
      },
      [7]
    );
    expect(issues).toEqual([]);
  });

  it("still surfaces requiredFixes when approved", () => {
    const issues = qualityIssuesFromFinalQa(
      {
        approved: true,
        issues: ["Soft advisory note."],
        requiredFixes: ["Fix the placeholder on page 3."]
      },
      [3]
    );
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({
      code: "WHOLE_BOOK_REVIEW",
      message: "Fix the placeholder on page 3.",
      affectedPageIndexes: [3]
    });
  });

  it("maps issues and requiredFixes when not approved", () => {
    const issues = qualityIssuesFromFinalQa(
      {
        approved: false,
        issues: ["Broken continuity on page 2."],
        requiredFixes: ["Rewrite the ending."]
      },
      [2]
    );
    expect(issues.map((issue) => issue.message)).toEqual([
      "Broken continuity on page 2.",
      "Rewrite the ending."
    ]);
  });
});
