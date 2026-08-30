import { describe, expect, it, vi } from "vitest";
import {
  claimDurableEditCompletionTx,
  settleDurableEditAttemptTx,
  settleReplanAttemptTx,
  type DurableEditCompletionClaim
} from "./durableEditCompletion.js";

const claim: DurableEditCompletionClaim = {
  generationJobId: "job-1",
  projectId: "project-1",
  operationId: "operation-1",
  attemptId: "attempt-1",
  type: "APPLY_BOOK_EDIT",
  message: "Book edit applied"
};

function client() {
  return {
    generationJob: {
      updateMany: vi.fn(async () => ({ count: 1 })),
      findUnique: vi.fn(async () => ({
        steps: [{ key: "apply", label: "Apply", status: "active" }]
      })),
      update: vi.fn(async () => ({}))
    },
    generationAttempt: { updateMany: vi.fn(async () => ({ count: 1 })) }
  };
}

describe("durable edit completion", () => {
  it("terminalizes only the exact active linked job and completes its progress metadata", async () => {
    const tx = client();

    await expect(claimDurableEditCompletionTx(tx as never, claim)).resolves.toBe(true);

    expect(tx.generationJob.updateMany).toHaveBeenCalledWith({
      where: {
        id: "job-1",
        projectId: "project-1",
        type: "APPLY_BOOK_EDIT",
        status: "ACTIVE",
        attemptId: "attempt-1"
      },
      data: expect.objectContaining({
        status: "COMPLETED",
        progress: 100,
        message: "Book edit applied",
        error: null,
        finishedAt: expect.any(Date)
      })
    });
    expect(tx.generationJob.update).toHaveBeenCalledWith({
      where: { id: "job-1" },
      data: { steps: [{ key: "apply", label: "Apply", status: "done" }] }
    });
  });

  it("stands down without later writes when stop or another terminal verdict wins the job CAS", async () => {
    const tx = client();
    tx.generationJob.updateMany.mockResolvedValueOnce({ count: 0 });

    await expect(claimDurableEditCompletionTx(tx as never, claim)).resolves.toBe(false);

    expect(tx.generationJob.findUnique).not.toHaveBeenCalled();
    expect(tx.generationJob.update).not.toHaveBeenCalled();
    expect(tx.generationAttempt.updateMany).not.toHaveBeenCalled();
  });

  it("settles only the exact open paid attempt linked to the operation and primary job", async () => {
    const tx = client();

    await expect(settleDurableEditAttemptTx(tx as never, claim)).resolves.toBe(true);

    expect(tx.generationAttempt.updateMany).toHaveBeenCalledWith({
      where: {
        id: "attempt-1",
        projectId: "project-1",
        editOperationId: "operation-1",
        primaryJobId: "job-1",
        status: { in: ["QUEUED", "ACTIVE"] }
      },
      data: {
        status: "SUCCEEDED",
        finishedAt: expect.any(Date),
        error: null,
        refundPending: false
      }
    });
  });

  it("settles an active replan attempt through its exact generated-book successor", async () => {
    const tx = client();
    const replanClaim: DurableEditCompletionClaim = {
      ...claim,
      type: "GENERATE_BOOK",
      message: "Revised book published"
    };

    await expect(settleReplanAttemptTx(tx as never, replanClaim)).resolves.toBe(true);

    expect(tx.generationAttempt.updateMany).toHaveBeenCalledWith({
      where: {
        id: "attempt-1",
        projectId: "project-1",
        editOperationId: "operation-1",
        status: "ACTIVE",
        jobs: {
          some: {
            id: "job-1",
            projectId: "project-1",
            type: "GENERATE_BOOK",
            attemptId: "attempt-1"
          }
        }
      },
      data: {
        status: "SUCCEEDED",
        finishedAt: expect.any(Date),
        error: null,
        refundPending: false
      }
    });
  });

  it.each(["FAILED", "CANCELED"])(
    "refuses a %s replan attempt instead of publishing refunded work",
    async () => {
      const tx = client();
      tx.generationAttempt.updateMany.mockResolvedValueOnce({ count: 0 });

      await expect(
        settleReplanAttemptTx(tx as never, {
          ...claim,
          type: "GENERATE_BOOK",
          message: "Revised book published"
        })
      ).resolves.toBe(false);
    }
  );

  it("refuses a replan attempt whose successor linkage does not match", async () => {
    const tx = client();
    tx.generationAttempt.updateMany.mockResolvedValueOnce({ count: 0 });

    await expect(
      settleReplanAttemptTx(tx as never, {
        ...claim,
        generationJobId: "different-successor",
        type: "GENERATE_BOOK",
        message: "Revised book published"
      })
    ).resolves.toBe(false);

    expect(tx.generationAttempt.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          jobs: { some: expect.objectContaining({ id: "different-successor", attemptId: "attempt-1" }) }
        })
      })
    );
  });
});
