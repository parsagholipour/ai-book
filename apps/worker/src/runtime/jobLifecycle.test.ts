import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  generationJobFindUnique: vi.fn(),
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

import { markFailed, markRecovering, markStopped } from "./jobLifecycle.js";

describe("job lifecycle ownership", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.generationJobFindUnique.mockResolvedValue({ steps: [] });
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
