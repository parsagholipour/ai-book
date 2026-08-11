vi.mock("@book-maker/db", async () => (await import("./testing/mobileApiMocks.js")).dbModuleMock());

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ProjectQualityStatus } from "../projectStatus.js";
import { loadProjectQualityReport, qualityWithExportsOnDisk } from "./qualityVerdict.js";
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

  it("drops the EPUB failure once a repair has produced the file", () => {
    const quality = qualityWithExportsOnDisk(epubFailed, { epub: { available: true } });

    expect(quality.issues).toEqual([]);
    expect(quality.state).toBe("passed");
  });

  it("keeps it while the EPUB is still missing", () => {
    expect(qualityWithExportsOnDisk(epubFailed, { epub: { available: false } })).toBe(epubFailed);
  });

  it("leaves manuscript issues alone", () => {
    expect(qualityWithExportsOnDisk(reviewRecommended, { epub: { available: true } })).toBe(reviewRecommended);
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

    const quality = qualityWithExportsOnDisk(blocked, { epub: { available: true } });

    expect(quality.state).toBe("blocked");
    expect(quality.issues.map((issue) => issue.code)).toEqual(["PAGE_TOO_SHORT"]);
  });
});
