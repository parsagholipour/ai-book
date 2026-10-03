import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => {
  const model = () => ({
    findMany: vi.fn(async () => []),
    findFirst: vi.fn(),
    delete: vi.fn(async () => ({})),
    deleteMany: vi.fn(async () => ({ count: 0 })),
    update: vi.fn(async () => ({})),
    updateMany: vi.fn(async () => ({ count: 1 }))
  });
  return {
    project: model(),
    mobileCreationDraft: model(),
    libraryCharacter: model(),
    voiceCall: model(),
    bookImport: model(),
    mobileSession: model(),
    passwordResetRequest: model(),
    userPasswordCredential: model(),
    legalAcceptance: model(),
    user: model(),
    accountDeletionRequest: model(),
    $transaction: vi.fn(async (writes: unknown[]) => writes)
  };
});
const storage = vi.hoisted(() => ({ deletePrefix: vi.fn(async () => undefined) }));
const jobs = vi.hoisted(() => ({ stopProjectGenerationJobs: vi.fn(async () => ({})) }));
const projectStorage = vi.hoisted(() => ({
  deleteProjectStorage: vi.fn(async () => ({ book: true, images: true, voice: true, audio: true }))
}));

vi.mock("@book-maker/db", () => ({ prisma: db }));
vi.mock("@book-maker/storage", () => ({
  objectKey: (...parts: string[]) => parts.join("/"),
  objectStore: () => storage
}));
vi.mock("./queue.js", () => jobs);
vi.mock("./projectStorage.js", () => projectStorage);
vi.mock("./attachmentStorage.js", () => ({ deleteCreationAttachmentDraftDir: vi.fn(async () => undefined) }));

import { ACCOUNT_DELETION_GRACE_MS, deletedAccountEmail, executeAccountDeletion, runAccountDeletionSweep } from "./accountDeletion.js";

const log = { warn: vi.fn(), info: vi.fn() };

/**
 * A deletion request used to be recorded and never carried out. These pin what
 * carrying one out means: every book through its own delete, the person's
 * content gone, and the row left as a disabled tombstone that keeps the
 * financial records.
 */
describe("carrying out an account deletion", () => {
  beforeEach(() => vi.clearAllMocks());

  it("deletes every book through its own delete before anything else", async () => {
    db.project.findMany.mockResolvedValueOnce([{ id: "book-1" }, { id: "book-2" }] as never);
    const result = await executeAccountDeletion("user-1", log);
    expect(jobs.stopProjectGenerationJobs).toHaveBeenCalledWith("book-1");
    expect(db.project.delete).toHaveBeenCalledWith({ where: { id: "book-2" } });
    expect(projectStorage.deleteProjectStorage).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({ projects: 2, storageFailures: 0 });
  });

  it("removes saved characters' pictures and leaves a tombstone that keeps the ledger", async () => {
    await executeAccountDeletion("user-1", log);
    expect(storage.deletePrefix).toHaveBeenCalledWith("images/characters/user-1/");
    expect(db.user.update).toHaveBeenCalledWith({
      where: { id: "user-1" },
      data: expect.objectContaining({ email: deletedAccountEmail("user-1"), displayName: null, status: "DISABLED" })
    });
    expect(db.mobileSession.deleteMany).toHaveBeenCalledWith({ where: { userId: "user-1" } });
    // Financial records are kept with the tombstone, not deleted.
    expect(db).not.toHaveProperty("creditLedgerEntry");
    expect(db.accountDeletionRequest.updateMany).toHaveBeenCalledWith({
      where: { userId: "user-1", status: "PENDING" },
      data: expect.objectContaining({ status: "COMPLETED", email: deletedAccountEmail("user-1"), reason: null })
    });
  });

  it("waits out the grace period, and closes a request whose user is already gone", async () => {
    const now = new Date("2026-10-03T12:00:00Z");
    db.accountDeletionRequest.findMany.mockResolvedValueOnce([{ id: "request-1", userId: null }] as never);
    expect(await runAccountDeletionSweep(log, now)).toBe(1);
    expect(db.accountDeletionRequest.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { status: "PENDING", requestedAt: { lte: new Date(now.getTime() - ACCOUNT_DELETION_GRACE_MS) } }
      })
    );
    expect(db.accountDeletionRequest.update).toHaveBeenCalledWith({
      where: { id: "request-1" },
      data: expect.objectContaining({ status: "COMPLETED" })
    });
  });

  it("leaves a request that failed pending for the next pass", async () => {
    db.accountDeletionRequest.findMany.mockResolvedValueOnce([{ id: "request-2", userId: "user-2" }] as never);
    db.project.findMany.mockRejectedValueOnce(new Error("database unavailable"));
    expect(await runAccountDeletionSweep(log)).toBe(0);
    expect(log.warn).toHaveBeenCalled();
  });
});
