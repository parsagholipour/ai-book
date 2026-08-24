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
});
