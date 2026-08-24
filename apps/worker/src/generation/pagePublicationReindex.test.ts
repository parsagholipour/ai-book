import type { PageQualityReport } from "@book-maker/core";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  prisma: {
    $transaction: vi.fn(),
    page: { updateMany: vi.fn() },
    imageAsset: { findMany: vi.fn(), deleteMany: vi.fn() },
    continuityNote: { createMany: vi.fn() }
  },
  enqueueWorkerJob: vi.fn()
}));

vi.mock("@book-maker/db", async () => ({
  prisma: mocks.prisma,
  Prisma: {},
  ...(await import("../testing/dbScopeMocks.js")).dbScopeMocks()
}));
vi.mock("../runtime/dispatch.js", () => ({ enqueueWorkerJob: mocks.enqueueWorkerJob }));

import {
  GeneratedPagePublicationClaimLostError,
  publishStagedGeneratedPage,
  stageGeneratedPageWithClient
} from "./pagePublication.js";

const approvedReport = {
  approved: true,
  score: 90,
  issues: [],
  requiredRevisions: [],
  notes: "",
  checks: { repetitionOk: true, progressionOk: true }
} as unknown as PageQualityReport;

describe("staged page completion across structural reindexing", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.prisma.$transaction.mockImplementation(
      async (run: (tx: typeof mocks.prisma) => Promise<unknown>) => run(mocks.prisma)
    );
    mocks.prisma.page.updateMany.mockResolvedValue({ count: 1 });
  });

  it("refuses to stage prose onto a stable page reindexed without a version change", async () => {
    const loadedAt = new Date("2026-01-01T00:00:00.000Z");
    const currentPageIndex = 4;
    mocks.prisma.page.updateMany.mockImplementation(async ({ where }: { where: { index?: number } }) => ({
      count: where.index === currentPageIndex ? 1 : 0
    }));

    await expect(
      stageGeneratedPageWithClient(mocks.prisma as never, {
        projectId: "project-1",
        chapterId: null,
        pageIndex: 3,
        draft: {
          title: "Stale position",
          markdown: "Prose drafted for page three.",
          summary: "A stale summary.",
          continuityNotes: []
        },
        revision: 2,
        qualityReport: approvedReport,
        status: "GENERATING",
        existingPage: {
          id: "page-row-1",
          status: "GENERATING",
          title: "Current keeper",
          markdown: "Current prose.",
          summary: "Current summary.",
          imagePrompt: null,
          revision: 1,
          updatedAt: loadedAt
        }
      })
    ).rejects.toBeInstanceOf(GeneratedPagePublicationClaimLostError);

    expect(mocks.prisma.page.updateMany).toHaveBeenCalledWith({
      where: {
        id: "page-row-1",
        index: 3,
        status: "GENERATING",
        updatedAt: loadedAt
      },
      data: expect.objectContaining({ title: "Stale position", status: "GENERATING" })
    });
    expect(mocks.prisma.imageAsset.findMany).not.toHaveBeenCalled();
  });

  it("supersedes continuity publication after a version-preserving reindex", async () => {
    const stagedAt = new Date("2026-01-01T00:00:00.000Z");
    const currentPageIndex = 4;
    mocks.prisma.page.updateMany.mockImplementation(async ({ where }: { where: { index?: number } }) => {
      return { count: where.index === currentPageIndex ? 1 : 0 };
    });

    const publication = await publishStagedGeneratedPage({
      projectId: "project-1",
      planId: "plan-1",
      pageIndex: 3,
      draft: {
        title: "First",
        markdown: "First text.",
        summary: "First summary.",
        continuityNotes: ["Pip keeps the brass key."]
      },
      stagedPage: { id: "page-row-1", revision: 1, updatedAt: stagedAt },
      willIllustrate: false,
      continuityTags: ["page", "3", "test-strategy"]
    });

    expect(publication).toBe("superseded");
    expect(mocks.prisma.page.updateMany).toHaveBeenCalledWith({
      where: expect.objectContaining({
        id: "page-row-1",
        index: 3,
        updatedAt: stagedAt
      }),
      data: expect.objectContaining({ status: "COMPLETED" })
    });
    expect(mocks.prisma.continuityNote.createMany).not.toHaveBeenCalled();
  });
});
