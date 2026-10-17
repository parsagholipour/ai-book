vi.mock("@book-maker/db", async () => (await import("./testing/mobileApiMocks.js")).dbModuleMock());

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ProjectQualityStatus } from "../projectStatus.js";
import { loadProjectQualityReport, qualityForReader, qualityWithExportsOnDisk } from "./qualityVerdict.js";
import { mockPrisma } from "./testing/mobileApiMocks.js";

const reviewRecommended: ProjectQualityStatus = {
  state: "review_recommended",
  score: 90,
  issues: [
    {
      code: "CHAPTER_TRANSITION",
      severity: "warning",
      source: "model",
      message: "Chapter 3 opens on a scene chapter 2 never leaves.",
      guidance: "Review the affected pages.",
      affectedPageIndexes: [7]
    }
  ],
  affectedPageIndexes: [7]
};

describe("loadProjectQualityReport", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("asks the database for the owning compile instead of scanning recent jobs", async () => {
    mockPrisma.generationJob.findFirst.mockResolvedValue({ qualityReport: reviewRecommended });

    expect(await loadProjectQualityReport("project-1")).toBe(reviewRecommended);
    // Ownership is a column, so no repair, presentation recompile or unrelated
    // job can push the verdict out of a window — there is no window.
    const query = mockPrisma.generationJob.findFirst.mock.calls[0]?.[0];
    expect(query.where).toMatchObject({
      projectId: "project-1",
      type: "COMPILE_EXPORT",
      ownsQualityVerdict: true
    });
    expect(query.orderBy).toEqual({ createdAt: "desc" });
    expect(query.take).toBeUndefined();
  });

  it("skips an owning compile that has not written its report yet", async () => {
    mockPrisma.generationJob.findFirst.mockResolvedValue(null);

    expect(await loadProjectQualityReport("project-1")).toBeNull();
    // A queued or in-flight compile owns a verdict it has not written. Reading
    // its empty report would blank the quality card for as long as it ran, so
    // the query refuses rows with no report and the older verdict stands.
    expect(mockPrisma.generationJob.findFirst.mock.calls[0]?.[0].where.qualityReport).toEqual({
      not: "DbNull"
    });
  });

  it("reports nothing when no compile owns a verdict", async () => {
    mockPrisma.generationJob.findFirst.mockResolvedValue(null);

    expect(await loadProjectQualityReport("project-1")).toBeNull();
  });
});

describe("qualityWithExportsOnDisk", () => {
  const epubFailed: ProjectQualityStatus = {
    state: "review_recommended",
    score: 95,
    issues: [
      {
        code: "EPUB_EXPORT_FAILED",
        severity: "warning",
        source: "deterministic",
        message: "EPUB export failed; PDF and markdown are available.",
        guidance: "Download the PDF, or re-run the export to retry the EPUB.",
        affectedPageIndexes: []
      }
    ],
    affectedPageIndexes: []
  };

  const docxFailed: ProjectQualityStatus = {
    state: "review_recommended",
    score: 95,
    issues: [
      {
        code: "DOCX_EXPORT_FAILED",
        severity: "warning",
        source: "deterministic",
        message: "Word export failed; PDF and EPUB are available.",
        guidance: "Download the PDF, or re-run the export to retry the Word file.",
        affectedPageIndexes: []
      }
    ],
    affectedPageIndexes: []
  };

  it("drops the EPUB failure once a repair has produced the file", () => {
    const quality = qualityWithExportsOnDisk(epubFailed, { epub: { available: true }, docx: { available: false } });

    expect(quality.issues).toEqual([]);
    expect(quality.state).toBe("passed");
  });

  it("drops the Word failure once a repair has produced the file", () => {
    const quality = qualityWithExportsOnDisk(docxFailed, { epub: { available: false }, docx: { available: true } });

    expect(quality.issues).toEqual([]);
    expect(quality.state).toBe("passed");
  });

  it("keeps it while the EPUB is still missing", () => {
    expect(qualityWithExportsOnDisk(epubFailed, { epub: { available: false }, docx: { available: true } })).toBe(epubFailed);
  });

  it("keeps only the companion still missing when the other has landed", () => {
    const both: ProjectQualityStatus = {
      ...epubFailed,
      issues: [...epubFailed.issues, ...docxFailed.issues]
    };
    const quality = qualityWithExportsOnDisk(both, { epub: { available: true }, docx: { available: false } });

    expect(quality.issues.map((issue) => issue.code)).toEqual(["DOCX_EXPORT_FAILED"]);
    expect(quality.state).toBe("review_recommended");
  });

  it("leaves manuscript issues alone", () => {
    expect(
      qualityWithExportsOnDisk(reviewRecommended, { epub: { available: true }, docx: { available: true } })
    ).toBe(reviewRecommended);
  });

  it("stays blocked when a deterministic error survives the drop", () => {
    const blocked: ProjectQualityStatus = {
      ...epubFailed,
      state: "blocked",
      issues: [
        ...epubFailed.issues,
        {
          code: "PAGE_TOO_SHORT",
          severity: "error",
          source: "deterministic",
          message: "Page 4 is nearly empty.",
          guidance: "Review the affected pages.",
          affectedPageIndexes: [4]
        }
      ],
      affectedPageIndexes: [4]
    };

    const quality = qualityWithExportsOnDisk(blocked, { epub: { available: true }, docx: { available: true } });

    expect(quality.state).toBe("blocked");
    expect(quality.issues.map((issue) => issue.code)).toEqual(["PAGE_TOO_SHORT"]);
  });
});

describe("qualityForReader", () => {
  const issue = (code: string, message: string) => ({
    code, severity: "warning" as const, source: "model" as const, message, guidance: "", affectedPageIndexes: []
  });
  const noFiles = { epub: { available: true }, docx: { available: true } };

  it("leaves the reviewer's own uncertainty off a finished book's card", () => {
    // Mira (2026-10-01): a positive read-aloud assessment whose quote did not
    // validate was the book's only note, and it read "Review recommended".
    const quality: ProjectQualityStatus = {
      state: "review_recommended",
      score: 90,
      issues: [issue("BRIEF_COVERAGE_UNVERIFIED", "The manuscript's coverage of the brief and promises could not be fully verified.")],
      affectedPageIndexes: []
    };

    expect(qualityForReader(quality, noFiles)).toMatchObject({ state: "passed", issues: [] });
  });

  it("keeps every note about the book itself", () => {
    const quality: ProjectQualityStatus = {
      state: "review_recommended",
      score: 80,
      issues: [
        issue("BRIEF_COVERAGE_UNVERIFIED", "could not be fully verified"),
        issue("MISSING_BRIEF_REQUIREMENT", "The shopping list is missing.")
      ],
      affectedPageIndexes: []
    };

    const reader = qualityForReader(quality, noFiles);
    expect(reader.state).toBe("review_recommended");
    expect(reader.issues.map((entry) => entry.code)).toEqual(["MISSING_BRIEF_REQUIREMENT"]);
  });
});

describe("a split report on the wire", () => {
  // Built by the worker's own grader, so the shape is the one a compile stores.
  const stored = async () => {
    const { buildManuscriptQualityReport } = await import("@book-maker/core");
    return buildManuscriptQualityReport([
      {
        code: "PROMPT_LEAKAGE", severity: "error", source: "deterministic",
        message: "Page 3 appears to expose generation instructions or hidden prompt text: “system prompt”.",
        guidance: "Regenerate this page without internal instructions.", affectedPageIndexes: [3],
        evidence: [{ pageIndex: 3, excerpt: "system prompt" }]
      },
      { code: "CHAPTER_LENGTH_SHORTFALL", severity: "error", source: "deterministic", message: "Chapter 2 is 40 words short.",
        guidance: "Develop the chapter.", affectedPageIndexes: [5, 6] }
    ], [{ code: "WHOLE_BOOK_REVIEW", severity: "warning", source: "model", message: "Page 7: The pacing sags.",
      guidance: "Review page 7.", affectedPageIndexes: [7] }], { finalReviewRan: true });
  };

  it("gives the console both halves and the app the reader's findings alone, in the fields installed builds read", async () => {
    const { normalizeProjectQuality } = await import("../projectStatus.js");
    const operator = normalizeProjectQuality(await stored());
    expect(operator).toMatchObject({ state: "review_recommended", score: 95, affectedPageIndexes: [3] });
    expect(operator.issues.map((entry) => [entry.code, entry.severity])).toEqual([["PROMPT_LEAKAGE", "warning"]]);
    expect(operator.diagnosticIssues?.map((entry) => entry.code)).toEqual(["CHAPTER_LENGTH_SHORTFALL", "WHOLE_BOOK_REVIEW"]);

    const reader = qualityForReader(operator, { epub: { available: false }, docx: { available: false } });
    expect(reader).not.toHaveProperty("diagnosticIssues");
    expect(reader).toMatchObject({ state: "review_recommended", score: 95, affectedPageIndexes: [3],
      issues: [expect.objectContaining({ code: "PROMPT_LEAKAGE", severity: "warning", affectedPageIndexes: [3] })] });
  });

  it("serves a report made before the split exactly as it was graded", async () => {
    const { normalizeProjectQuality } = await import("../projectStatus.js");
    const legacy = normalizeProjectQuality({ state: "blocked", score: 82, affectedPageIndexes: [5, 6], checkedAt: "2026-01-01T00:00:00.000Z",
      issues: [{ code: "CHAPTER_LENGTH_SHORTFALL", severity: "error", source: "deterministic", message: "Chapter 2 is short.",
        guidance: "Develop it.", affectedPageIndexes: [5, 6] }] });
    expect(legacy).not.toHaveProperty("diagnosticIssues");
    expect(qualityForReader(legacy, { epub: { available: true }, docx: { available: true } }))
      .toMatchObject({ state: "blocked", issues: [expect.objectContaining({ code: "CHAPTER_LENGTH_SHORTFALL" })] });
  });
});
