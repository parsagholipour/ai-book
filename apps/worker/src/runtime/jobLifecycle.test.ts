import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  generationJobFindUnique: vi.fn(),
  generationJobFindMany: vi.fn(),
  generationJobUpdate: vi.fn(),
  projectUpdate: vi.fn(),
  projectUpdateMany: vi.fn(),
  projectFindUnique: vi.fn(),
  audiobookUpdateMany: vi.fn(),
  bookEditOperationFindUnique: vi.fn(),
  bookEditOperationUpdate: vi.fn(),
  bookEditOperationUpdateMany: vi.fn(),
  pageFindUnique: vi.fn(),
  refundCreditLedgerEntry: vi.fn(),
  refundLatestProjectOperationCredits: vi.fn()
}));

vi.mock("@book-maker/db", () => ({
  Prisma: {},
  planRevisionRetryDelayMs: () => 1_000,
  prisma: {
    generationJob: {
      findUnique: mocks.generationJobFindUnique,
      findMany: mocks.generationJobFindMany,
      update: mocks.generationJobUpdate
    },
    project: {
      findUnique: mocks.projectFindUnique,
      update: mocks.projectUpdate,
      updateMany: mocks.projectUpdateMany
    },
    audiobook: { updateMany: mocks.audiobookUpdateMany },
    bookEditOperation: {
      findUnique: mocks.bookEditOperationFindUnique,
      update: mocks.bookEditOperationUpdate,
      updateMany: mocks.bookEditOperationUpdateMany
    },
    page: { findUnique: mocks.pageFindUnique }
  }
}));

vi.mock("@book-maker/db/billing", () => ({
  refundCreditLedgerEntry: mocks.refundCreditLedgerEntry,
  refundLatestProjectOperationCredits: mocks.refundLatestProjectOperationCredits
}));

import { markFailed, markRecovering, markStopped, staleGenerationJobReason } from "./jobLifecycle.js";

describe("job lifecycle ownership", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.generationJobFindUnique.mockResolvedValue({ steps: [] });
    mocks.generationJobFindMany.mockResolvedValue([]);
    mocks.generationJobUpdate.mockResolvedValue({});
    mocks.projectUpdate.mockResolvedValue({});
    mocks.projectUpdateMany.mockResolvedValue({ count: 0 });
    mocks.audiobookUpdateMany.mockResolvedValue({ count: 1 });
    mocks.bookEditOperationFindUnique.mockResolvedValue(null);
    mocks.bookEditOperationUpdate.mockResolvedValue({});
    mocks.bookEditOperationUpdateMany.mockResolvedValue({ count: 0 });
    mocks.refundCreditLedgerEntry.mockResolvedValue({});
    mocks.refundLatestProjectOperationCredits.mockResolvedValue({});
  });

  it("requeues audiobook work without moving the completed book back to generating", async () => {
    await markRecovering(job("generate-audiobook", { audiobookId: "audio-1" }), new Error("network interruption"));

    expect(mocks.generationJobUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: "QUEUED" }) })
    );
    expect(mocks.projectUpdate).not.toHaveBeenCalled();
    expect(mocks.audiobookUpdateMany).not.toHaveBeenCalled();
  });

  it("fails and refunds an audiobook without changing the book", async () => {
    await markFailed(
      job("generate-audiobook", { audiobookId: "audio-1", billingLedgerEntryId: "ledger-audio" }),
      new Error("speech quota exhausted")
    );

    expect(mocks.refundCreditLedgerEntry).toHaveBeenCalledWith("ledger-audio", "speech quota exhausted");
    expect(mocks.audiobookUpdateMany).toHaveBeenCalledWith({
      where: { id: "audio-1", status: "GENERATING" },
      data: { status: "FAILED", error: "speech quota exhausted" }
    });
    expect(mocks.refundLatestProjectOperationCredits).not.toHaveBeenCalled();
    expect(mocks.projectUpdate).not.toHaveBeenCalled();
  });

  it("stops and refunds an audiobook without changing the book", async () => {
    await markStopped(job("generate-audiobook", { audiobookId: "audio-1", billingLedgerEntryId: "ledger-audio" }));

    expect(mocks.refundCreditLedgerEntry).toHaveBeenCalledWith("ledger-audio", "Stopped by user");
    expect(mocks.audiobookUpdateMany).toHaveBeenCalledWith({
      where: { id: "audio-1", status: "GENERATING" },
      data: { status: "FAILED", error: "Stopped by user" }
    });
    expect(mocks.projectUpdate).not.toHaveBeenCalled();
  });

  it("fails and stops derivative character work without failing the book", async () => {
    for (const name of ["prepare-character-candidates", "build-character-persona"]) {
      vi.clearAllMocks();
      mocks.generationJobFindUnique.mockResolvedValue({ steps: [] });
      mocks.generationJobUpdate.mockResolvedValue({});

      await markFailed(job(name), new Error("character operation failed"));

      expect(mocks.generationJobUpdate).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ status: "FAILED" }) })
      );
      expect(mocks.refundLatestProjectOperationCredits).not.toHaveBeenCalled();
      expect(mocks.projectUpdate).not.toHaveBeenCalled();

      vi.clearAllMocks();
      mocks.generationJobFindUnique.mockResolvedValue({ steps: [] });
      mocks.generationJobUpdate.mockResolvedValue({});
      await markStopped(job(name));

      expect(mocks.generationJobUpdate).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ status: "FAILED" }) })
      );
      expect(mocks.refundLatestProjectOperationCredits).not.toHaveBeenCalled();
      expect(mocks.projectUpdate).not.toHaveBeenCalled();
    }
  });

  it("refunds a failed plan against its own charge, not the book's", async () => {
    await markFailed(job("plan-book", { billingLedgerEntryId: "ledger-plan" }), new Error("planner outage"));

    expect(mocks.refundCreditLedgerEntry).toHaveBeenCalledWith("ledger-plan", "planner outage");
    expect(mocks.refundLatestProjectOperationCredits).not.toHaveBeenCalled();
    expect(mocks.projectUpdate).toHaveBeenCalledWith({ where: { id: "project-1" }, data: { status: "FAILED" } });
  });

  it("falls back to the latest PLAN_GENERATION charge for plan rows without a stamp", async () => {
    await markFailed(job("plan-book"), new Error("planner outage"));

    expect(mocks.refundCreditLedgerEntry).not.toHaveBeenCalled();
    expect(mocks.refundLatestProjectOperationCredits).toHaveBeenCalledWith({
      projectId: "project-1",
      operation: "PLAN_GENERATION",
      reason: "planner outage"
    });
  });

  it("refunds a stopped plan the same way", async () => {
    await markStopped(job("plan-book", { billingLedgerEntryId: "ledger-plan" }));

    expect(mocks.refundCreditLedgerEntry).toHaveBeenCalledWith("ledger-plan", "Stopped by user");
    expect(mocks.projectUpdate).toHaveBeenCalledWith({ where: { id: "project-1" }, data: { status: "FAILED" } });
  });

  it("refunds a failed fan-out job against its own run's charge, not the latest one", async () => {
    // Run 1 (plan-1) still has a straggler page job; run 2 (plan-2) was charged
    // later. The straggler must refund entry-1, never entry-2.
    mocks.generationJobFindMany.mockResolvedValue([
      { payload: { planId: "plan-2", billingLedgerEntryId: "entry-2" } },
      { payload: { planId: "plan-1", billingLedgerEntryId: "entry-1" } }
    ]);

    await markFailed(job("generate-page", { planId: "plan-1" }), new Error("page failed"));

    expect(mocks.refundCreditLedgerEntry).toHaveBeenCalledWith("entry-1", "page failed");
    expect(mocks.refundLatestProjectOperationCredits).not.toHaveBeenCalled();
  });

  it("settles a stopped edit against the operation's ledger entry, leaving the book alone", async () => {
    mocks.bookEditOperationFindUnique.mockResolvedValue({ ledgerEntryId: "ledger-op" });

    await markStopped(job("apply-book-edit", { operationId: "op-1" }));

    expect(mocks.refundCreditLedgerEntry).toHaveBeenCalledWith("ledger-op", "Stopped by user");
    expect(mocks.bookEditOperationUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "op-1" }, data: expect.objectContaining({ status: "FAILED" }) })
    );
    // The edit belongs to a COMPLETE book: restore EDITING, never fail the
    // project or touch its FULL_BOOK_GENERATION charge.
    expect(mocks.projectUpdateMany).toHaveBeenCalledWith({
      where: { id: "project-1", status: "EDITING" },
      data: { status: "COMPLETE" }
    });
    expect(mocks.projectUpdate).not.toHaveBeenCalled();
    expect(mocks.refundLatestProjectOperationCredits).not.toHaveBeenCalled();
  });

  it("treats a CANCELED durable row as stale so refunded work never runs", async () => {
    mocks.projectFindUnique.mockResolvedValue({ currentPlanId: "plan-1", contentRevision: 0 });
    mocks.generationJobFindUnique.mockResolvedValue({
      projectId: "project-1",
      type: "PLAN_BOOK",
      contentRevision: null,
      status: "CANCELED"
    });

    await expect(staleGenerationJobReason(job("plan-book"))).resolves.toBe(
      "The durable job was canceled before it could run."
    );

    // Strictly CANCELED: FAILED rows are legitimately re-run by BullMQ retries.
    mocks.generationJobFindUnique.mockResolvedValue({
      projectId: "project-1",
      type: "PLAN_BOOK",
      contentRevision: null,
      status: "FAILED"
    });
    await expect(staleGenerationJobReason(job("plan-book"))).resolves.toBeNull();
  });

  it("preserves project recovery, failure and stop transitions for book jobs", async () => {
    await markRecovering(job("generate-book"), new Error("network interruption"));
    expect(mocks.projectUpdate).toHaveBeenCalledWith({
      where: { id: "project-1" },
      data: { status: "GENERATING" }
    });

    vi.clearAllMocks();
    mocks.generationJobFindUnique.mockResolvedValue({ steps: [] });
    mocks.generationJobUpdate.mockResolvedValue({});
    mocks.projectUpdate.mockResolvedValue({});
    mocks.refundLatestProjectOperationCredits.mockResolvedValue({});
    await markFailed(job("generate-page"), new Error("page failed"));
    expect(mocks.projectUpdate).toHaveBeenCalledWith({ where: { id: "project-1" }, data: { status: "FAILED" } });
    expect(mocks.refundLatestProjectOperationCredits).toHaveBeenCalledWith({
      projectId: "project-1",
      operation: "FULL_BOOK_GENERATION",
      reason: "page failed"
    });

    vi.clearAllMocks();
    mocks.generationJobFindUnique.mockResolvedValue({ steps: [] });
    mocks.generationJobUpdate.mockResolvedValue({});
    mocks.projectUpdate.mockResolvedValue({});
    mocks.refundLatestProjectOperationCredits.mockResolvedValue({});
    await markStopped(job("compile-export"));
    expect(mocks.projectUpdate).toHaveBeenCalledWith({ where: { id: "project-1" }, data: { status: "FAILED" } });
  });
});

function job(name: string, data: Record<string, unknown> = {}) {
  return {
    name,
    data: { projectId: "project-1", generationJobId: `job-${name}`, ...data },
    attemptsMade: 0,
    opts: { attempts: 3 }
  } as never;
}
