import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Job } from "bullmq";

const mocks = vi.hoisted(() => ({
  tx: { project: { findUnique: vi.fn() } },
  projectUpdateMany: vi.fn(),
  getProjectOrThrow: vi.fn(),
  invalidateProjectExports: vi.fn(),
  maybeEnqueueCompile: vi.fn(),
  claimAppliedEditPublication: vi.fn(async () => true),
  restoreEditProjectStatus: vi.fn(async () => true)
}));

vi.mock("@book-maker/db", () => ({
  Prisma: {},
  prisma: {
    project: { updateMany: mocks.projectUpdateMany },
    $transaction: (run: (tx: typeof mocks.tx) => unknown) => run(mocks.tx)
  }
}));
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

import { PRE_EDIT_PROJECT_STATUS } from "@book-maker/core";
import { applyImageLayout } from "./applyImageLayout.js";

const job = (data: Record<string, unknown> = {}) =>
  ({
    id: "job-1",
    data: {
      projectId: "project-1",
      operationId: "op-1",
      planId: "plan-1",
      generationJobId: "gen-1",
      [PRE_EDIT_PROJECT_STATUS]: "REVIEW_REQUIRED",
      ...data
    }
  }) as unknown as Job;

beforeEach(() => {
  vi.clearAllMocks();
  mocks.projectUpdateMany.mockResolvedValue({ count: 1 });
  mocks.tx.project.findUnique.mockResolvedValue({ currentPlanId: "plan-1" });
  mocks.getProjectOrThrow.mockResolvedValue({ id: "project-1", currentPlanId: "plan-1", status: "EDITING" });
  mocks.maybeEnqueueCompile.mockResolvedValue("compile");
  mocks.claimAppliedEditPublication.mockResolvedValue(true);
  mocks.restoreEditProjectStatus.mockResolvedValue(true);
});

describe("applyImageLayout status restoration", () => {
  it("claims the EDITING publication window before replaying APPLIED exports from a settled project", async () => {
    await applyImageLayout(job(), { status: "APPLIED", classifier: {} });

    expect(mocks.claimAppliedEditPublication).toHaveBeenCalledWith(
      mocks.tx, "project-1", "op-1", "REVIEW_REQUIRED"
    );
    expect(mocks.claimAppliedEditPublication.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.invalidateProjectExports.mock.invocationCallOrder[0]!
    );
  });

  it("does not invalidate APPLIED layout exports when a FAILED or newer project state rejects the claim", async () => {
    mocks.claimAppliedEditPublication.mockResolvedValueOnce(false);

    await applyImageLayout(job(), { status: "APPLIED", classifier: {} });

    expect(mocks.claimAppliedEditPublication).toHaveBeenCalledWith(
      mocks.tx, "project-1", "op-1", "REVIEW_REQUIRED"
    );
    expect(mocks.invalidateProjectExports).not.toHaveBeenCalled();
    expect(mocks.maybeEnqueueCompile).not.toHaveBeenCalled();
  });

  it.each(["not-ready", "throw"])(
    "restores REVIEW_REQUIRED when an APPLIED compile handoff ends in %s",
    async (outcome) => {
      let logged: ReturnType<typeof vi.spyOn> | undefined;
      if (outcome === "throw") {
        mocks.maybeEnqueueCompile.mockRejectedValue(new Error("queue unavailable"));
        logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
      } else {
        mocks.maybeEnqueueCompile.mockResolvedValue("not-ready");
      }

      await applyImageLayout(job(), { status: "APPLIED", classifier: {} });

      expect(mocks.restoreEditProjectStatus).toHaveBeenCalledWith(
        mocks.tx, "project-1", "op-1", "REVIEW_REQUIRED"
      );
      logged?.mockRestore();
    }
  );

  it("restores REVIEW_REQUIRED when an APPLIED redelivery has no plan to compile", async () => {
    mocks.tx.project.findUnique.mockResolvedValue({ currentPlanId: null });
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await applyImageLayout(job({ planId: undefined }), { status: "APPLIED", classifier: {} });

    expect(mocks.restoreEditProjectStatus).toHaveBeenCalledWith(
      mocks.tx, "project-1", "op-1", "REVIEW_REQUIRED"
    );
    logged.mockRestore();
  });

  it("restores REVIEW_REQUIRED when an APPLIED no-op is redelivered", async () => {
    await applyImageLayout(job(), { status: "APPLIED", classifier: { layoutMissing: true } });

    expect(mocks.invalidateProjectExports).not.toHaveBeenCalled();
    expect(mocks.restoreEditProjectStatus).toHaveBeenCalledWith(
      mocks.tx, "project-1", "op-1", "REVIEW_REQUIRED", "APPLIED_NOOP"
    );
  });

  it.each(["compile", "waiting"])(
    "leaves the project EDITING while a %s handoff owns publication",
    async (outcome) => {
      mocks.maybeEnqueueCompile.mockResolvedValue(outcome);

      await applyImageLayout(job(), { status: "APPLIED", classifier: {} });

      expect(mocks.claimAppliedEditPublication).toHaveBeenCalledTimes(1);
      expect(mocks.restoreEditProjectStatus).not.toHaveBeenCalled();
    }
  );
});
