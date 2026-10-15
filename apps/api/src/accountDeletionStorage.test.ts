import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { seedObject, testObjectStore } from "./testing/objectStorage.js";

const db = vi.hoisted(() => {
  const model = () => ({
    findMany: vi.fn(async (_args?: unknown): Promise<unknown[]> => []),
    delete: vi.fn(async (_args?: unknown) => ({})),
    deleteMany: vi.fn(async (_args?: unknown) => ({ count: 0 })),
    update: vi.fn(async (_args?: unknown) => ({})),
    updateMany: vi.fn(async (_args?: unknown) => ({ count: 1 }))
  });
  return {
    project: model(), mobileCreationDraft: model(), libraryCharacter: model(), voiceCall: model(),
    bookImport: model(), sourceDocument: model(), generationJob: model(), mobileSession: model(),
    passwordResetRequest: model(), emailVerificationRequest: model(), userPasswordCredential: model(), legalAcceptance: model(),
    authorProfile: model(), user: model(), accountDeletionRequest: model(),
    subscriptionState: model(), productEvent: model(), welcomeCreditGrant: model(),
    // Every prefix a deletion removes is written down first (`storageDeletionSweep.ts`).
    pendingStorageDeletion: { upsert: vi.fn(async (_args?: unknown) => ({})) },
    $queryRaw: vi.fn(async (_sql: TemplateStringsArray, ..._values: unknown[]): Promise<unknown[]> => []),
    $executeRaw: vi.fn(async () => 0),
    $transaction: vi.fn(async (writes: unknown[]) => writes)
  };
});
const jobs = vi.hoisted(() => ({ stopProjectGenerationJobs: vi.fn(async (_id: string) => ({})) }));
vi.mock("@book-maker/db", () => ({ prisma: db }));
vi.mock("@book-maker/db/billing", () => ({ WELCOME_CREDITS_IP_WINDOW_DAYS: 30 }));
vi.mock("./queue.js", () => jobs);

import { runAccountDeletionSweep } from "./accountDeletion.js";

const log = { warn: vi.fn(), info: vi.fn() };

describe("account storage deletion retries", () => {
  let pending: boolean;
  let metadata: Record<string, unknown>;
  let projectIds: Set<string>;
  let draftIds: Set<string>;
  let characters: number;

  beforeEach(() => {
    vi.resetAllMocks();
    pending = true;
    metadata = { existingNote: "keep", accountRunLogsDeleted: true };
    projectIds = new Set();
    draftIds = new Set();
    characters = 0;
    db.accountDeletionRequest.findMany.mockImplementation(async () => pending ? [{ id: "request-1", userId: "user-1" }] : []);
    db.accountDeletionRequest.updateMany.mockImplementation(async () => { pending = false; return { count: 1 }; });
    db.project.findMany.mockImplementation(async () => [...projectIds].map((id) => ({ id })));
    db.project.delete.mockImplementation(async (args) => {
      projectIds.delete((args as { where: { id: string } }).where.id);
      return {};
    });
    db.mobileCreationDraft.findMany.mockImplementation(async () => [...draftIds].map((id) => ({ id })));
    db.mobileCreationDraft.deleteMany.mockImplementation(async () => {
      const count = draftIds.size;
      draftIds.clear();
      return { count };
    });
    db.libraryCharacter.deleteMany.mockImplementation(async () => {
      const count = characters;
      characters = 0;
      return { count };
    });
    db.$queryRaw.mockImplementation(async (sql, ...values) => {
      // Model the journal's atomic JSON-object merge, independently of the
      // live Project rows. Other queries belong to completed run-log repair.
      if (!sql.join("").includes("accountStorageProjects")) return [];
      if (!pending) return [];
      metadata = {
        ...metadata,
        accountStorageProjects: {
          ...metadata.accountStorageProjects as object,
          ...JSON.parse(values[0] as string)
        }
      };
      return [{ projects: metadata.accountStorageProjects }];
    });
  });
  afterEach(() => vi.restoreAllMocks());

  it.each(["books", "images", "voice", "audio"])("retries failed %s cleanup after the project row is gone", async (namespace) => {
    projectIds.add("book-1");
    const key = `${namespace}/book-1/private-file`;
    seedObject(key, "private content");
    seedObject(`${namespace}/book-10/private-file`, "another account's content");
    vi.spyOn(testObjectStore, "delete").mockRejectedValueOnce(new Error("S3 unavailable"));

    expect(await runAccountDeletionSweep(log)).toBe(0);
    expect(pending).toBe(true);
    expect(projectIds.size).toBe(0);
    expect(metadata).toEqual({ existingNote: "keep", accountRunLogsDeleted: true, accountStorageProjects: { "book-1": true } });
    expect(await testObjectStore.get(key)).not.toBeNull();

    expect(await runAccountDeletionSweep(log)).toBe(1);
    expect(pending).toBe(false);
    expect(await testObjectStore.get(key)).toBeNull();
    expect(await testObjectStore.get(`${namespace}/book-10/private-file`)).not.toBeNull();
    expect(db.project.delete).toHaveBeenCalledTimes(1);
    expect(jobs.stopProjectGenerationJobs).toHaveBeenCalledTimes(1);
  });

  it("retains draft IDs and originals until a failed deletion succeeds on the next sweep", async () => {
    draftIds.add("draft-1");
    seedObject("attachments/draft-1/original", "private upload");
    vi.spyOn(testObjectStore, "delete").mockRejectedValueOnce(new Error("S3 unavailable"));

    expect(await runAccountDeletionSweep(log)).toBe(0);
    expect(pending).toBe(true);
    expect([...draftIds]).toEqual(["draft-1"]);
    expect(await testObjectStore.get("attachments/draft-1/original")).not.toBeNull();

    expect(await runAccountDeletionSweep(log)).toBe(1);
    expect(pending).toBe(false);
    expect(draftIds.size).toBe(0);
    expect(await testObjectStore.get("attachments/draft-1/original")).toBeNull();
  });

  it("retains character cleanup ownership until the failed picture deletion succeeds", async () => {
    characters = 1;
    seedObject("images/characters/user-1/portrait.webp", "private portrait");
    vi.spyOn(testObjectStore, "delete").mockRejectedValueOnce(new Error("S3 unavailable"));

    expect(await runAccountDeletionSweep(log)).toBe(0);
    expect(pending).toBe(true);
    expect(characters).toBe(1);
    expect(await testObjectStore.get("images/characters/user-1/portrait.webp")).not.toBeNull();

    expect(await runAccountDeletionSweep(log)).toBe(1);
    expect(pending).toBe(false);
    expect(characters).toBe(0);
    expect(await testObjectStore.get("images/characters/user-1/portrait.webp")).toBeNull();
  });

  it("merges prior cleanup ownership when another project is discovered", async () => {
    metadata.accountStorageProjects = { "book-old": true };
    projectIds.add("book-new");
    seedObject("books/book-old/book.pdf", "old private content");
    seedObject("books/book-new/book.pdf", "new private content");

    expect(await runAccountDeletionSweep(log)).toBe(1);
    expect(metadata.accountStorageProjects).toEqual({ "book-old": true, "book-new": true });
    expect(await testObjectStore.get("books/book-old/book.pdf")).toBeNull();
    expect(await testObjectStore.get("books/book-new/book.pdf")).toBeNull();
  });

  it.each(["missing request", "database error"])("retains projects when cleanup ownership cannot be saved: %s", async (failure) => {
    projectIds.add("book-1");
    if (failure === "missing request") db.$queryRaw.mockResolvedValueOnce([]);
    else db.$queryRaw.mockRejectedValueOnce(new Error("database unavailable"));

    expect(await runAccountDeletionSweep(log)).toBe(0);
    expect([...projectIds]).toEqual(["book-1"]);
    expect(db.project.delete).not.toHaveBeenCalled();
    expect(db.accountDeletionRequest.updateMany).not.toHaveBeenCalled();
  });

  it("waits for job shutdown and row deletion before storage cleanup", async () => {
    projectIds.add("book-1");
    seedObject("books/book-1/book.pdf", "private content");
    jobs.stopProjectGenerationJobs.mockRejectedValueOnce(new Error("stop failed"));

    expect(await runAccountDeletionSweep(log)).toBe(0);
    expect(db.project.delete).not.toHaveBeenCalled();
    expect(await testObjectStore.get("books/book-1/book.pdf")).not.toBeNull();
    const remove = vi.spyOn(testObjectStore, "delete").mockImplementation(async (key) => {
      expect(projectIds.size).toBe(0);
      testObjectStore.objects.delete(key);
    });

    expect(await runAccountDeletionSweep(log)).toBe(1);
    expect(remove).toHaveBeenCalledWith("books/book-1/book.pdf");
    expect(jobs.stopProjectGenerationJobs.mock.invocationCallOrder[1]).toBeLessThan(db.project.delete.mock.invocationCallOrder[0]!);
  });
});
