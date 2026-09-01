import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockPrisma } = vi.hoisted(() => ({
  mockPrisma: {
    project: { findUnique: vi.fn(async () => null as unknown) },
    generationJob: {
      count: vi.fn(async () => 0),
      findMany: vi.fn(async () => [] as unknown[]),
      findFirst: vi.fn(async () => null as unknown)
    },
    generationAttempt: { findMany: vi.fn(async () => [] as unknown[]) },
    bookEditOperation: { findMany: vi.fn(async () => [] as unknown[]) },
    imageAsset: { count: vi.fn(async () => 0), findMany: vi.fn(async () => [] as unknown[]) },
    providerCallLog: { findMany: vi.fn(async () => [] as unknown[]) },
    $queryRawUnsafe: vi.fn(async (..._args: unknown[]) => [] as unknown[])
  }
}));

vi.mock("@book-maker/db", () => ({
  prisma: mockPrisma,
  Prisma: { DbNull: "DbNull" }
}));

import { buildProjectStatus } from "./projectStatus.js";

describe("operator project-status quality report serialization", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPrisma.generationJob.findMany.mockResolvedValue([]);
    mockPrisma.bookEditOperation.findMany.mockResolvedValue([]);
    mockPrisma.$queryRawUnsafe.mockResolvedValue([]);
  });

  it("keeps worker-private compile provenance out of the DTO shared by polling and SSE", async () => {
    const publicReport = {
      state: "review_recommended",
      score: 84,
      issues: [
        {
          code: "CHAPTER_TRANSITION",
          severity: "warning",
          source: "model",
          message: "The transition is abrupt.",
          guidance: "Smooth the handoff between chapters.",
          affectedPageIndexes: [2]
        }
      ],
      affectedPageIndexes: [2]
    };
    const storedReport = {
      ...publicReport,
      _standDownProvenance: {
        version: 1,
        finalReviewRan: true,
        reviewedPages: [{ index: 2, revision: 7, contentHash: "private-page-fingerprint" }]
      }
    };
    mockPrisma.project.findUnique.mockResolvedValue({
      id: "project-1",
      status: "GENERATING",
      targetPages: 6,
      currentPlanId: "plan-1",
      currentPlan: { id: "plan-1", createdAt: new Date("2026-08-20T00:00:00.000Z") },
      jobs: [
        {
          id: "compile-1",
          type: "COMPILE_EXPORT",
          status: "COMPLETED",
          progress: 100,
          payload: { planId: "plan-1" },
          steps: [],
          bullJobId: null,
          qualityReport: storedReport,
          createdAt: new Date("2026-08-21T00:00:00.000Z")
        }
      ],
      _count: { pages: 6, images: 0, research: 0 }
    });
    mockPrisma.generationJob.findFirst.mockResolvedValueOnce({ qualityReport: storedReport });

    const status = await buildProjectStatus("project-1");
    const serializedJob = status?.project.jobs[0];

    expect(serializedJob).toMatchObject({
      id: "compile-1",
      status: "COMPLETED",
      progress: 100,
      payload: { planId: "plan-1" },
      qualityReport: publicReport
    });
    expect(serializedJob?.qualityReport).not.toHaveProperty("_standDownProvenance");
    expect(status?.quality).toEqual(publicReport);
    expect(storedReport).toHaveProperty("_standDownProvenance.reviewedPages.0.contentHash");
  });

  it("surfaces canonical and duplicate pages on corroborated cluster issues", async () => {
    const storedReport = {
      state: "blocked",
      score: 64,
      issues: [
        {
          code: "CORROBORATED_STRUCTURAL_DUPLICATION",
          severity: "error",
          source: "model",
          message: "Page 1 is the strongest treatment; pages 2, 3 repeat its subject.",
          guidance: "Review the canonical page and the duplicates in Edit Mode.",
          affectedPageIndexes: [1, 2, 3],
          evidence: [
            { pageIndex: 1, excerpt: "Cubical chert weights" },
            { pageIndex: 2, excerpt: "The 13.63 gram unit" }
          ],
          cluster: { canonicalPageIndex: 1, duplicatePageIndexes: [3, 2] }
        }
      ],
      affectedPageIndexes: [1, 2, 3],
      diagnostics: {
        detectorVersion: "manuscript-structural-audit-v1",
        wouldBlock: true,
        findings: [
          {
            code: "CORROBORATED_STRUCTURAL_DUPLICATION",
            detectorVersion: "manuscript-structural-audit-v1",
            severity: "error",
            affectedPageCount: 3,
            occurrences: 3,
            affectedPageRatio: 0.5,
            clusterCount: 1,
            wouldBlock: true
          }
        ]
      }
    };
    mockPrisma.project.findUnique.mockResolvedValue({
      id: "project-1",
      status: "REVIEW_REQUIRED",
      targetPages: 6,
      currentPlanId: "plan-1",
      currentPlan: { id: "plan-1", createdAt: new Date("2026-08-20T00:00:00.000Z") },
      jobs: [],
      _count: { pages: 6, images: 0, research: 0 }
    });
    mockPrisma.generationJob.findFirst.mockResolvedValueOnce({ qualityReport: storedReport });

    const status = await buildProjectStatus("project-1");

    expect(status?.quality.issues[0]?.cluster).toEqual({
      canonicalPageIndex: 1,
      duplicatePageIndexes: [2, 3]
    });
    expect(status?.quality.issues[0]?.affectedPageIndexes).toEqual([1, 2, 3]);
    expect(status?.quality.diagnostics?.detectorVersion).toBe("manuscript-structural-audit-v1");
  });

  it("recovers canonical vs duplicates from stored evidence when cluster was not persisted", async () => {
    mockPrisma.project.findUnique.mockResolvedValue({
      id: "project-1",
      status: "REVIEW_REQUIRED",
      targetPages: 6,
      currentPlanId: "plan-1",
      currentPlan: { id: "plan-1", createdAt: new Date("2026-08-20T00:00:00.000Z") },
      jobs: [],
      _count: { pages: 6, images: 0, research: 0 }
    });
    mockPrisma.generationJob.findFirst.mockResolvedValueOnce({
      qualityReport: {
        state: "blocked",
        score: 64,
        issues: [
          {
            code: "CORROBORATED_STRUCTURAL_DUPLICATION",
            severity: "error",
            source: "model",
            message: "Page 4 is the strongest treatment; pages 5 repeat its subject.",
            guidance: "Review the canonical page and the duplicates in Edit Mode.",
            affectedPageIndexes: [4, 5],
            evidence: [
              { pageIndex: 4, excerpt: "The balance pans" },
              { pageIndex: 5, excerpt: "The same pans again" }
            ]
          }
        ],
        affectedPageIndexes: [4, 5]
      }
    });

    const status = await buildProjectStatus("project-1");
    expect(status?.quality.issues[0]?.cluster).toEqual({
      canonicalPageIndex: 4,
      duplicatePageIndexes: [5]
    });
  });
});
