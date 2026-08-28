import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  bookEditOperationFindUnique: vi.fn(),
  bookEditOperationUpdateMany: vi.fn(),
  failGenerationAttempt: vi.fn(),
  refundCreditLedgerEntry: vi.fn()
}));

vi.mock("@book-maker/db", () => ({
  prisma: {
    bookEditOperation: {
      findUnique: mocks.bookEditOperationFindUnique,
      updateMany: mocks.bookEditOperationUpdateMany
    }
  }
}));

vi.mock("@book-maker/db/billing", () => ({
  failGenerationAttempt: mocks.failGenerationAttempt,
  refundCreditLedgerEntry: mocks.refundCreditLedgerEntry,
  refundCreditLedgerEntryPortion: vi.fn()
}));

import { ReaderEditFailure, failEditOperation } from "./editOperationSettlement.js";

/**
 * `BookEditOperation.error` is a reader-facing column: `serializeBookEditOperation`
 * copies it onto the mobile DTO and the app draws it on the failed edit card.
 *
 * The worker is the dominant writer of it and used to store `errorMessage(error)`
 * — so a Prisma pool timeout, a null-deref inside a structural apply and
 * `GenerationAttemptJobClaimError`'s debugging sentence all reached the device
 * verbatim. Classifying at the three API catch sites left every one of these
 * paths untouched, which is why the rule now sits on the write itself.
 */
describe("failing an edit operation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.bookEditOperationUpdateMany.mockResolvedValue({ count: 1 });
    mocks.bookEditOperationFindUnique.mockResolvedValue({ ledgerEntryId: "ledger-1" });
    mocks.refundCreditLedgerEntry.mockResolvedValue({});
  });

  const storedError = () => {
    const call = mocks.bookEditOperationUpdateMany.mock.calls.at(-1) as [{ data: { error: string } }] | undefined;
    return call?.[0].data.error;
  };

  const CLAIM_FAULT =
    "Generation attempt attempt-2 may not claim generation job job-1: it is already attempt attempt-1's work. " +
    "A create() callback must enqueue its own job with this attemptId, never return one it found under a spent dedupeKey.";

  it("never stores an internal fault's own words on the column the app reads", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});

    for (const cause of [
      new Error(CLAIM_FAULT),
      new TypeError("Cannot read properties of undefined (reading 'index')"),
      Object.assign(new Error("Timed out fetching a new connection from the connection pool."), { code: "P2024" }),
      Object.assign(new Error("Transaction already closed"), { code: "P2028" })
    ]) {
      mocks.bookEditOperationUpdateMany.mockClear();

      await failEditOperation("operation-1", cause, { refund: false });

      expect(storedError()).toBe("That change couldn’t be finished. Send it again to try once more.");
      expect(storedError()).not.toMatch(/dedupeKey|attemptId|P20\d\d|connection pool|undefined/);
    }
    // Lost nowhere: the classification sits at the write precisely because the
    // serializer could not do this half — by the time the column is read the
    // cause is gone.
    expect(logged).toHaveBeenCalledWith(expect.stringContaining("Edit operation operation-1 failed"), expect.any(Error));
    expect(logged.mock.calls[0]?.[1]).toMatchObject({ message: CLAIM_FAULT });
    logged.mockRestore();
  });

  it("clears the structural lease with the terminal verdict, as it always did", async () => {
    await failEditOperation("operation-1", new Error("drafting died"), { refund: false });

    expect(mocks.bookEditOperationUpdateMany).toHaveBeenCalledWith({
      where: { id: "operation-1", status: { in: ["QUEUED", "ACTIVE"] } },
      data: {
        status: "FAILED",
        error: "That change couldn’t be finished. Send it again to try once more.",
        structuralLeaseToken: null,
        structuralLeaseExpiresAt: null
      }
    });
  });

  /**
   * A ledger description is operator reading — `MobileCreditLogEntryDto.title`
   * is built rather than copied for exactly that reason — so the diagnostic
   * survives the classification instead of being replaced by it.
   */
  it("hands the raw cause to the refund it books, and the sentence to the reader", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});

    await failEditOperation("operation-1", new Error(CLAIM_FAULT));

    expect(mocks.refundCreditLedgerEntry).toHaveBeenCalledWith("ledger-1", CLAIM_FAULT);
    expect(storedError()).toBe("That change couldn’t be finished. Send it again to try once more.");
    vi.mocked(console.error).mockRestore();
  });

  /**
   * A sentence written for the reader on purpose says so by arriving as a
   * `ReaderEditFailure`. Letting a bare `string` mean "already reader copy" is
   * the trap the whole change closes: the next caller to hand this an
   * `errorMessage(error)` would ship it.
   */
  it("passes deliberate reader copy through, and logs nothing for it", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});

    await failEditOperation("operation-1", new ReaderEditFailure("Stopped by user"), { refund: false });

    expect(storedError()).toBe("Stopped by user");
    expect(logged).not.toHaveBeenCalled();
    logged.mockRestore();
  });

  /**
   * The refusals a reader can act on keep the sentence their HTTP twin ships,
   * and are not incidents: logging them at error level buries the ones that are.
   */
  it("keeps the answered refusals' sentences and does not log them", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});

    await failEditOperation("operation-1", Object.assign(new Error("nope"), { code: "INSUFFICIENT_CREDITS" }), {
      refund: false
    });
    expect(storedError()).toBe("There weren’t enough credits for that change. Add credits, then send it again.");

    await failEditOperation(
      "operation-1",
      Object.assign(new Error("internal quota wording"), {
        code: "IMAGE_LIMIT_REACHED",
        claim: { used: 3, limit: 3 }
      }),
      { refund: false }
    );
    expect(storedError()).toBe(
      "Free plans include 3 illustrated books a month. Upgrade for unlimited, or turn visuals off."
    );

    expect(logged).not.toHaveBeenCalled();
    logged.mockRestore();
  });

  it("still refuses to touch a row that is no longer open", async () => {
    mocks.bookEditOperationUpdateMany.mockResolvedValue({ count: 0 });
    vi.spyOn(console, "error").mockImplementation(() => {});

    await failEditOperation("operation-1", new Error("late failure"));

    expect(mocks.refundCreditLedgerEntry).not.toHaveBeenCalled();
    vi.mocked(console.error).mockRestore();
  });
});
