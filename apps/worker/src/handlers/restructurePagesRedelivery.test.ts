import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  releaseStructuralPageLease: vi.fn(),
  redeliverWorkerGenerationJob: vi.fn()
}));

vi.mock("../generation/structuralPageLease.js", () => ({
  releaseStructuralPageLease: mocks.releaseStructuralPageLease
}));
vi.mock("../runtime/dispatch.js", () => ({
  redeliverWorkerGenerationJob: mocks.redeliverWorkerGenerationJob
}));

import { redeliverUnrevertedStructuralEdit } from "./restructurePagesRedelivery.js";
import { StructuralRollbackRedeliveryError } from "../runtime/jobTypes.js";

describe("redeliverUnrevertedStructuralEdit", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.releaseStructuralPageLease.mockResolvedValue(true);
    mocks.redeliverWorkerGenerationJob.mockResolvedValue(undefined);
  });

  it("yields the lease, requeues the durable job, and never returns", async () => {
    await expect(redeliverUnrevertedStructuralEdit("project-1", "op-1", "owner-1", "gj-1")).rejects.toBeInstanceOf(
      StructuralRollbackRedeliveryError
    );

    expect(mocks.releaseStructuralPageLease).toHaveBeenCalledWith("op-1", "owner-1");
    expect(mocks.redeliverWorkerGenerationJob).toHaveBeenCalledWith("gj-1");
  });

  it("still throws when the requeue itself fails, so markFailed cannot run", async () => {
    mocks.redeliverWorkerGenerationJob.mockRejectedValue(new Error("queue unavailable"));
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await expect(redeliverUnrevertedStructuralEdit("project-1", "op-1", "owner-1", "gj-1")).rejects.toBeInstanceOf(
      StructuralRollbackRedeliveryError
    );

    expect(logged).toHaveBeenCalled();
    logged.mockRestore();
  });

  it("skips the durable requeue when the payload carries no job id", async () => {
    await expect(
      redeliverUnrevertedStructuralEdit("project-1", "op-1", "owner-1", undefined)
    ).rejects.toBeInstanceOf(StructuralRollbackRedeliveryError);

    expect(mocks.releaseStructuralPageLease).toHaveBeenCalled();
    expect(mocks.redeliverWorkerGenerationJob).not.toHaveBeenCalled();
  });
});
