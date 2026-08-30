import type { Job } from "bullmq";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { PRE_EDIT_PROJECT_STATUS } from "@book-maker/core";

const mocks = vi.hoisted(() => ({
  prisma: {
    bookEditOperation: { updateMany: vi.fn(), findUnique: vi.fn(), update: vi.fn() },
    project: { findUnique: vi.fn(), update: vi.fn(), updateMany: vi.fn() },
    page: { findFirst: vi.fn() },
    imageAsset: { findFirst: vi.fn() },
    $transaction: vi.fn()
  },
  tx: {
    bookEditOperation: { updateMany: vi.fn(), findUnique: vi.fn(), update: vi.fn() },
    page: { findUnique: vi.fn(), findMany: vi.fn(), update: vi.fn() },
    pageEditSnapshot: { create: vi.fn() },
    project: { update: vi.fn(), findUnique: vi.fn() },
    imageAsset: { findUnique: vi.fn(), findFirst: vi.fn(), update: vi.fn() }
  },
  getProjectOrThrow: vi.fn(),
  invalidateProjectExports: vi.fn(),
  maybeEnqueueCompile: vi.fn(),
  claimAppliedEditPublication: vi.fn(async () => true),
  restoreEditProjectStatus: vi.fn(async () => true)
}));

vi.mock("@book-maker/db", () => ({ prisma: mocks.prisma, Prisma: {} }));
vi.mock("../runtime/dispatch.js", () => ({ maybeEnqueueCompile: mocks.maybeEnqueueCompile }));
vi.mock("../runtime/jobLifecycle.js", () => ({ advanceJobStep: vi.fn() }));
vi.mock("../generation/bookHelpers.js", () => ({
  getProjectOrThrow: mocks.getProjectOrThrow,
  invalidateProjectExports: mocks.invalidateProjectExports
}));
vi.mock("../generation/editProjectStatus.js", () => ({
  claimAppliedEditPublication: mocks.claimAppliedEditPublication,
  restoreEditProjectStatus: mocks.restoreEditProjectStatus
}));

import { applyImageLayout } from "./applyImageLayout.js";

const job = (data: Record<string, unknown> = {}) =>
  ({
    id: "job-1",
    data: {
      projectId: "project-1",
      operationId: "op-1",
      request: "Move the picture to page 2",
      affectedPageIndexes: [1, 2],
      planId: "plan-1",
      intentKind: "move_image",
      generationJobId: "gen-1",
      ...data
    }
  }) as unknown as Job;

beforeEach(() => {
  vi.clearAllMocks();
  mocks.prisma.$transaction.mockImplementation(async (run: (tx: unknown) => Promise<unknown>) => run(mocks.tx));
  mocks.prisma.bookEditOperation.updateMany.mockResolvedValue({ count: 1 });
  mocks.prisma.bookEditOperation.findUnique.mockResolvedValue({ id: "op-1", status: "QUEUED", classifier: {} });
  mocks.prisma.project.findUnique.mockResolvedValue({ status: "COMPLETE", currentPlanId: "plan-1" });
  mocks.prisma.project.update.mockResolvedValue({});
  mocks.prisma.project.updateMany.mockResolvedValue({ count: 1 });
  mocks.tx.bookEditOperation.updateMany.mockResolvedValue({ count: 1 });
  mocks.tx.bookEditOperation.findUnique.mockResolvedValue({ classifier: {} });
  mocks.tx.bookEditOperation.update.mockResolvedValue({});
  mocks.tx.project.update.mockResolvedValue({ contentRevision: 8 });
  mocks.tx.project.findUnique.mockResolvedValue({ language: "en", currentPlanId: "plan-1" });
  mocks.getProjectOrThrow.mockResolvedValue({ id: "project-1", currentPlanId: "plan-1" });
  mocks.maybeEnqueueCompile.mockResolvedValue("compile");
  mocks.claimAppliedEditPublication.mockResolvedValue(true);
  mocks.restoreEditProjectStatus.mockResolvedValue(true);
});

describe("applyImageLayout APPLIED publication replay", () => {
  it("does not invalidate or enqueue when the APPLIED layout claim is stale", async () => {
    mocks.claimAppliedEditPublication.mockResolvedValue(false);

    await applyImageLayout(job({ imageLayout: undefined }), { status: "APPLIED", classifier: {} });

    expect(mocks.invalidateProjectExports).not.toHaveBeenCalled();
    expect(mocks.maybeEnqueueCompile).not.toHaveBeenCalled();
    expect(mocks.restoreEditProjectStatus).not.toHaveBeenCalled();
  });

  it("logs and restores the stamped status when an APPLIED replay has no plan to compile", async () => {
    mocks.tx.project.findUnique.mockResolvedValue({ language: "en", currentPlanId: null });
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await expect(
      applyImageLayout(
        job({ planId: undefined, imageLayout: undefined, [PRE_EDIT_PROJECT_STATUS]: "REVIEW_REQUIRED" }),
        { status: "APPLIED", classifier: {} }
      )
    ).resolves.toBeUndefined();

    expect(mocks.invalidateProjectExports).not.toHaveBeenCalled();
    expect(mocks.maybeEnqueueCompile).not.toHaveBeenCalled();
    expect(mocks.claimAppliedEditPublication.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.tx.project.findUnique.mock.invocationCallOrder[0]!
    );
    expect(mocks.restoreEditProjectStatus).toHaveBeenCalledWith(
      mocks.tx,
      "project-1",
      "op-1",
      "REVIEW_REQUIRED"
    );
    expect(logged).toHaveBeenCalledWith(
      "Cannot replay APPLIED image layout op-1 for project project-1: no plan version is available"
    );
    logged.mockRestore();
  });
});
