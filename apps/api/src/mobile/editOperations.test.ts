import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  prisma: {
    bookEditOperation: { create: vi.fn(), update: vi.fn(), findFirst: vi.fn() },
    generationJob: { count: vi.fn(), findUniqueOrThrow: vi.fn() },
    project: { update: vi.fn(), updateMany: vi.fn() },
    $transaction: vi.fn()
  },
  reserveCredits: vi.fn(),
  commitReservedCredits: vi.fn(),
  refundCreditLedgerEntry: vi.fn(),
  cancelUndispatchedGenerationJob: vi.fn(),
  dispatchGenerationJob: vi.fn(),
  enqueueGenerationJob: vi.fn()
}));

vi.mock("@book-maker/db", () => ({
  PLAN_REVISION_AUTOMATIC_RETRY_LIMIT: 2,
  Prisma: {},
  prisma: mocks.prisma
}));
vi.mock("@book-maker/db/billing", () => ({
  InsufficientCreditsError: class InsufficientCreditsError extends Error {},
  commitReservedCredits: mocks.commitReservedCredits,
  refundCreditLedgerEntry: mocks.refundCreditLedgerEntry,
  reserveCredits: mocks.reserveCredits
}));
vi.mock("../queue.js", () => ({
  cancelUndispatchedGenerationJob: mocks.cancelUndispatchedGenerationJob,
  dispatchGenerationJob: mocks.dispatchGenerationJob,
  enqueueGenerationJob: mocks.enqueueGenerationJob
}));
vi.mock("./bookEditIntents.js", () => ({
  affectedPagesForIntent: vi.fn(),
  busyEditReply: vi.fn(),
  continuationNewPageCount: vi.fn(),
  exactReplacementFromMessage: vi.fn(),
  operationQueuedMessage: vi.fn()
}));
vi.mock("./bookEditPricing.js", () => ({
  billingOperationForIntent: vi.fn(),
  bookEditCreditCost: vi.fn(),
  operationKindForIntent: vi.fn()
}));
vi.mock("./exactReplacementPreview.js", () => ({ planExactReplacement: vi.fn() }));
vi.mock("./projectChat.js", () => ({
  createAssistantChatMessage: vi.fn(),
  insufficientCreditsChatMessage: vi.fn()
}));
vi.mock("./projectRecords.js", () => ({ createReplanProjectCopy: vi.fn() }));
vi.mock("./support.js", () => ({
  cleanTargetLanguage: vi.fn(),
  errorMessage: (error: unknown) => (error instanceof Error ? error.message : "Unknown error"),
  hashString: (value: string) => value,
  isPrismaUniqueConflict: () => false,
  jsonInputValue: (value: unknown) => value,
  languageDisplayName: vi.fn()
}));
vi.mock("@book-maker/core", () => ({ creditCostForOperation: () => 25 }));

import { withChargedEnqueue } from "./editOperations.js";

const reservation = { id: "reservation-1" };
const spend = { id: "spend-1" };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.reserveCredits.mockResolvedValue(reservation);
  mocks.commitReservedCredits.mockResolvedValue(spend);
  mocks.refundCreditLedgerEntry.mockResolvedValue({});
  mocks.cancelUndispatchedGenerationJob.mockResolvedValue(true);
});

describe("withChargedEnqueue", () => {
  const reserve = () => mocks.reserveCredits({});

  it("reserves, commits, and hands the committed spend to the work", async () => {
    const result = await withChargedEnqueue({
      reserve,
      refundReason: "nope",
      run: async ({ spend: committed }) => {
        expect(committed).toBe(spend);
        return "done";
      }
    });

    expect(result).toBe("done");
    expect(mocks.commitReservedCredits).toHaveBeenCalledWith("reservation-1");
    expect(mocks.refundCreditLedgerEntry).not.toHaveBeenCalled();
    expect(mocks.cancelUndispatchedGenerationJob).not.toHaveBeenCalled();
  });

  it("refunds the committed spend when the work fails before any job was queued", async () => {
    const onFailureWhenDead = vi.fn();

    await expect(
      withChargedEnqueue({
        reserve,
        refundReason: "Edit could not be queued.",
        onFailureWhenDead,
        run: async () => {
          throw new Error("enqueue exploded");
        }
      })
    ).rejects.toThrow("enqueue exploded");

    expect(mocks.cancelUndispatchedGenerationJob).not.toHaveBeenCalled();
    expect(onFailureWhenDead).toHaveBeenCalledWith({ jobWasQueued: false });
    expect(mocks.refundCreditLedgerEntry).toHaveBeenCalledWith("spend-1", "Edit could not be queued.");
  });

  it("refunds the reservation when the commit itself never ran", async () => {
    mocks.commitReservedCredits.mockRejectedValue(new Error("commit failed"));

    await expect(
      withChargedEnqueue({
        reserve,
        refundReason: "Edit could not be queued.",
        run: async () => "unreachable"
      })
    ).rejects.toThrow("commit failed");

    expect(mocks.refundCreditLedgerEntry).toHaveBeenCalledWith("reservation-1", "Edit could not be queued.");
  });

  it("cancels a queued job before refunding, and compensates only then", async () => {
    const onFailureWhenDead = vi.fn();
    const order: string[] = [];
    mocks.cancelUndispatchedGenerationJob.mockImplementation(async () => {
      order.push("cancel");
      return true;
    });
    onFailureWhenDead.mockImplementation(async () => {
      order.push("compensate");
    });
    mocks.refundCreditLedgerEntry.mockImplementation(async () => {
      order.push("refund");
      return {};
    });

    await expect(
      withChargedEnqueue({
        reserve,
        refundReason: "Edit could not be queued.",
        onFailureWhenDead,
        run: async ({ registerQueuedJob }) => {
          registerQueuedJob("job-1");
          throw new Error("bookkeeping failed");
        }
      })
    ).rejects.toThrow("bookkeeping failed");

    expect(mocks.cancelUndispatchedGenerationJob).toHaveBeenCalledWith("job-1", "Edit could not be queued.");
    expect(onFailureWhenDead).toHaveBeenCalledWith({ jobWasQueued: true });
    // Refund strictly after the cancel claimed the row: a QUEUED row is still
    // reachable by both reconcilers, so refunding first pays back work that
    // may still run.
    expect(order).toEqual(["cancel", "compensate", "refund"]);
  });

  it("keeps the charge and skips compensation when the queued job could not be claimed", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const onFailureWhenDead = vi.fn();
    mocks.cancelUndispatchedGenerationJob.mockResolvedValue(false);

    await expect(
      withChargedEnqueue({
        reserve,
        refundReason: "Edit could not be queued.",
        onFailureWhenDead,
        run: async ({ registerQueuedJob }) => {
          registerQueuedJob("job-1");
          throw new Error("reply write failed");
        }
      })
    ).rejects.toThrow("reply write failed");

    // The job was already dispatched (or a reconciler claimed it): the work
    // will run, so the charge must stand and the domain state must stay put.
    expect(onFailureWhenDead).not.toHaveBeenCalled();
    expect(mocks.refundCreditLedgerEntry).not.toHaveBeenCalled();
    expect(consoleError).toHaveBeenCalled();
    consoleError.mockRestore();
  });

  it("treats a cancel that itself failed as an unclaimed job and keeps the charge", async () => {
    mocks.cancelUndispatchedGenerationJob.mockRejectedValue(new Error("db down"));
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(
      withChargedEnqueue({
        reserve,
        refundReason: "Edit could not be queued.",
        run: async ({ registerQueuedJob }) => {
          registerQueuedJob("job-1");
          throw new Error("late failure");
        }
      })
    ).rejects.toThrow("late failure");

    expect(mocks.refundCreditLedgerEntry).not.toHaveBeenCalled();
    consoleError.mockRestore();
  });

  it("propagates a reservation failure with nothing to refund", async () => {
    mocks.reserveCredits.mockRejectedValue(new Error("Insufficient credits"));

    await expect(
      withChargedEnqueue({
        reserve,
        refundReason: "Edit could not be queued.",
        run: async () => "unreachable"
      })
    ).rejects.toThrow("Insufficient credits");

    expect(mocks.refundCreditLedgerEntry).not.toHaveBeenCalled();
  });

  it("handles a free operation (null reservation) without touching billing", async () => {
    mocks.reserveCredits.mockResolvedValue(null);

    await expect(
      withChargedEnqueue({
        reserve,
        refundReason: "nope",
        run: async ({ spend: committed }) => {
          expect(committed).toBeNull();
          throw new Error("failed anyway");
        }
      })
    ).rejects.toThrow("failed anyway");

    expect(mocks.commitReservedCredits).not.toHaveBeenCalled();
    expect(mocks.refundCreditLedgerEntry).not.toHaveBeenCalled();
  });
});
