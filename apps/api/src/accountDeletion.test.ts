import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { seedObject, testObjectStore } from "./testing/objectStorage.js";

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
    sourceDocument: model(),
    generationJob: model(),
    mobileSession: model(),
    passwordResetRequest: model(),
    userPasswordCredential: model(),
    legalAcceptance: model(),
    user: model(),
    accountDeletionRequest: model(),
    $queryRaw: vi.fn(async () => []),
    $executeRaw: vi.fn(async () => 0),
    $transaction: vi.fn(async (writes: unknown[]) => writes)
  };
});
const jobs = vi.hoisted(() => ({ stopProjectGenerationJobs: vi.fn(async () => ({})) }));
const projectStorage = vi.hoisted(() => ({
  deleteProjectStorage: vi.fn(async () => ({ book: true, images: true, voice: true, audio: true }))
}));

vi.mock("@book-maker/db", () => ({ prisma: db }));
vi.mock("./queue.js", () => jobs);
vi.mock("./projectStorage.js", () => projectStorage);

import { ACCOUNT_DELETION_GRACE_MS, deletedAccountEmail, executeAccountDeletion, runAccountDeletionSweep } from "./accountDeletion.js";

const log = { warn: vi.fn(), info: vi.fn() };

/**
 * A deletion request used to be recorded and never carried out. These pin what
 * carrying one out means: every book through its own delete, the person's
 * content gone, and the row left as a disabled tombstone that keeps the
 * financial records.
 */
describe("carrying out an account deletion", () => {
  beforeEach(() => vi.resetAllMocks());
  afterEach(() => vi.restoreAllMocks());

  it("deletes every book through its own delete", async () => {
    db.project.findMany.mockResolvedValueOnce([{ id: "book-1" }, { id: "book-2" }] as never);
    const result = await executeAccountDeletion("user-1", log);
    expect(jobs.stopProjectGenerationJobs).toHaveBeenCalledWith("book-1");
    expect(db.project.delete).toHaveBeenCalledWith({ where: { id: "book-2" } });
    expect(projectStorage.deleteProjectStorage).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({ projects: 2, storageFailures: 0 });
  });

  it("removes saved characters' pictures and leaves a tombstone that keeps the ledger", async () => {
    seedObject("images/characters/user-1/portrait.webp", "private portrait");
    seedObject("images/characters/user-10/portrait.webp", "another user's portrait");
    await executeAccountDeletion("user-1", log);
    expect(await testObjectStore.get("images/characters/user-1/portrait.webp")).toBeNull();
    expect(await testObjectStore.get("images/characters/user-10/portrait.webp")).not.toBeNull();
    expect(db.user.update).toHaveBeenCalledWith({
      where: { id: "user-1" },
      data: expect.objectContaining({ email: deletedAccountEmail("user-1"), displayName: null, googleSubject: null, status: "DISABLED" })
    });
    expect(db.mobileSession.deleteMany).toHaveBeenCalledWith({ where: { userId: "user-1" } });
    // Financial records are kept with the tombstone, not deleted.
    expect(db).not.toHaveProperty("creditLedgerEntry");
    expect(db.accountDeletionRequest.updateMany).toHaveBeenCalledWith({
      where: { userId: "user-1", status: "PENDING" },
      data: expect.objectContaining({ status: "COMPLETED", email: deletedAccountEmail("user-1"), reason: null })
    });
  });

  it("deletes imported originals even when their project was already deleted", async () => {
    db.bookImport.findMany.mockResolvedValueOnce([{ id: "import-1" }, { id: "import-deleted-book" }] as never);
    seedObject("attachments/import-1/source", "manuscript");
    seedObject("attachments/import-deleted-book/source", "retained manuscript");
    seedObject("attachments/import-10/source", "another user's manuscript");

    await executeAccountDeletion("user-1", log);

    expect([...testObjectStore.objects.keys()].sort()).toEqual(["attachments/import-10/source", "books/.account-runs/user-1/deleted"]);
    expect(db.bookImport.findMany).toHaveBeenCalledWith({ where: { userId: "user-1" }, select: { id: true } });
    expect(db.bookImport.deleteMany).toHaveBeenCalledWith({ where: { userId: "user-1" } });
  });

  it("deletes account-owned and legacy portrait logs, including deleted characters' jobs", async () => {
    db.generationJob.findMany.mockResolvedValueOnce([{ id: "portrait-old", type: "GENERATE_CHARACTER_PORTRAIT" }] as never);
    const owned = [
      "books/.account-runs/user-1/runs/portrait-new-generate-character-portrait.jsonl.events/1.json",
      "books/_unknown-project/runs/portrait-old-generate-character-portrait.jsonl.events/1.json",
      "books/_unknown-project/runs/portrait-old-generate-character-portrait.jsonl"
    ];
    for (const key of owned) seedObject(key, "private character name, description and appearance");
    const other = "books/_unknown-project/runs/portrait-old-other-generate-character-portrait.jsonl.events/1.json";
    seedObject(other, "another account's prompt");
    seedObject("books/.account-runs/user-10/runs/other.jsonl.events/1.json", "another account's prompt");

    await executeAccountDeletion("user-1", log);

    for (const key of owned) expect(await testObjectStore.get(key), key).toBeNull();
    expect(await testObjectStore.get(other)).not.toBeNull();
    expect(await testObjectStore.get("books/.account-runs/user-10/runs/other.jsonl.events/1.json")).not.toBeNull();
    expect(db.generationJob.findMany).toHaveBeenCalledWith({
      where: { projectId: null, type: "GENERATE_CHARACTER_PORTRAIT", payload: { path: ["userId"], equals: "user-1" } },
      select: { id: true }
    });
  });

  it("keeps log cleanup retryable when storage is unavailable", async () => {
    db.accountDeletionRequest.findMany.mockResolvedValue([{ id: "request-1", userId: "user-1" }] as never);
    db.generationJob.findMany.mockResolvedValue([{ id: "portrait-old", type: "GENERATE_CHARACTER_PORTRAIT" }] as never);
    const key = "books/_unknown-project/runs/portrait-old-generate-character-portrait.jsonl.events/1.json";
    seedObject(key, "private prompt");
    vi.spyOn(testObjectStore, "delete").mockRejectedValueOnce(new Error("S3 unavailable"));

    expect(await runAccountDeletionSweep(log)).toBe(0);
    expect(db.accountDeletionRequest.updateMany).not.toHaveBeenCalled();
    expect(await testObjectStore.get(key)).not.toBeNull();
    expect(await runAccountDeletionSweep(log)).toBe(1);
    expect(await testObjectStore.get(key)).toBeNull();
  });

  it("repairs logs left by an already-completed account deletion", async () => {
    db.$queryRaw.mockResolvedValue([{ id: "deleted-request", userId: "user-1" }] as never);
    db.generationJob.findMany.mockResolvedValue([{ id: "portrait-old", type: "GENERATE_CHARACTER_PORTRAIT" }] as never);
    const key = "books/_unknown-project/runs/portrait-old-generate-character-portrait.jsonl.events/1.json";
    seedObject(key, "private prompt left by an old deletion");
    vi.spyOn(testObjectStore, "delete").mockRejectedValueOnce(new Error("S3 unavailable"));

    await runAccountDeletionSweep(log);
    expect(db.$executeRaw).not.toHaveBeenCalled();
    expect(await testObjectStore.get(key)).not.toBeNull();
    await runAccountDeletionSweep(log);
    expect(await testObjectStore.get(key)).toBeNull();
    expect(db.$executeRaw).toHaveBeenCalledTimes(1);
    expect(db.project.delete).not.toHaveBeenCalled();
    expect(db.user.update).not.toHaveBeenCalled();
  });

  it("deletes retained source content and originals after their chat was deleted", async () => {
    db.project.findMany.mockResolvedValueOnce([{ id: "book-1" }] as never);
    // No MobileCreationDraft remains: storageDraftId still locates its original.
    db.sourceDocument.findMany.mockResolvedValueOnce([
      { id: "source-1", storageDraftId: "deleted-chat" },
      { id: "source-expired", storageDraftId: "deleted-chat" }
    ] as never);
    seedObject("attachments/deleted-chat/source-1", "private source document");
    seedObject("attachments/other-chat/source-2", "another user's source document");

    await executeAccountDeletion("user-1", log);

    expect([...testObjectStore.objects.keys()].sort()).toEqual(["attachments/other-chat/source-2", "books/.account-runs/user-1/deleted"]);
    expect(db.sourceDocument.findMany).toHaveBeenCalledWith({
      where: { userId: "user-1" }, select: { id: true, storageDraftId: true }
    });
    // SourceDocument deletion cascades to every extraction version and chunk;
    // the book's ProjectSource references must be removed first (RESTRICT).
    expect(db.sourceDocument.deleteMany).toHaveBeenCalledWith({ where: { userId: "user-1" } });
    expect(db.project.delete.mock.invocationCallOrder[0]).toBeLessThan(db.sourceDocument.deleteMany.mock.invocationCallOrder[0]!);
    expect(db.sourceDocument.deleteMany.mock.invocationCallOrder[0]).toBeLessThan(db.accountDeletionRequest.updateMany.mock.invocationCallOrder[0]!);
  });

  it("keeps the import record and deletion request retryable when an original cannot be removed", async () => {
    db.accountDeletionRequest.findMany.mockResolvedValue([{ id: "request-1", userId: "user-1" }] as never);
    db.bookImport.findMany.mockResolvedValue([{ id: "import-1" }] as never);
    seedObject("attachments/import-1/source", "private manuscript");
    const remove = vi.spyOn(testObjectStore, "delete").mockRejectedValueOnce(new Error("S3 unavailable"));

    expect(await runAccountDeletionSweep(log)).toBe(0);
    expect(db.bookImport.deleteMany).not.toHaveBeenCalled();
    expect(db.accountDeletionRequest.updateMany).not.toHaveBeenCalled();
    expect(await testObjectStore.get("attachments/import-1/source")).not.toBeNull();

    expect(await runAccountDeletionSweep(log)).toBe(1);
    expect(await testObjectStore.get("attachments/import-1/source")).toBeNull();
    expect(remove).toHaveBeenCalledTimes(2);
  });

  it("keeps detached sources retryable when their original cannot be removed", async () => {
    db.sourceDocument.findMany.mockResolvedValueOnce([{ id: "source-1", storageDraftId: "deleted-chat" }] as never);
    seedObject("attachments/deleted-chat/source-1", "private source document");
    vi.spyOn(testObjectStore, "delete").mockRejectedValueOnce(new Error("S3 unavailable"));

    await expect(executeAccountDeletion("user-1", log)).rejects.toThrow("S3 unavailable");
    expect(db.sourceDocument.deleteMany).not.toHaveBeenCalled();
    expect(db.accountDeletionRequest.updateMany).not.toHaveBeenCalled();
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
