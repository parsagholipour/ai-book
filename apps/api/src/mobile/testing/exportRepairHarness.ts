import { readFileSync } from "node:fs";
import { join } from "node:path";
import { mockPrisma, mockQueue } from "./mobileApiMocks.js";
import { state, writeProjectFile } from "./mobileApiHarness.js";

/**
 * Fixtures shared by the two export-repair suites.
 *
 * `exportRepair.test.ts` covers which surfaces queue a rebuild and what they
 * answer; `exportRepairPublicationRace.test.ts` covers what happens when two
 * callers — or a compile publishing underneath them — decide at the same
 * moment. Both drive the same decision, so the queue double and the
 * transaction serializer live here rather than in one of them.
 */

/** What the repair asks of the config: where this fixture's books live. */
export function repairStorage(): { BOOK_STORAGE_DIR: string } {
  if (!state.bookStorageDir) {
    throw new Error("Storage dir was not initialized");
  }
  return { BOOK_STORAGE_DIR: state.bookStorageDir };
}

/** A file in the fixture project's storage directory, as it is on disk now. */
export function readProjectFile(filename: string, projectId = "project-a"): string {
  return readFileSync(join(repairStorage().BOOK_STORAGE_DIR, projectId, filename), "utf8");
}

/**
 * Publishes an export at the instant the repair reads the pending compiles.
 *
 * That read is the serialized decision point, and a real compile lands on
 * exactly this side of it: `publishCompiledExports` renames the artifact into
 * place inside its own transaction, and the worker marks the row COMPLETED only
 * after the handler has returned — so a compile already invisible to this read
 * has necessarily installed its file. Publishing here rather than before the
 * request is what makes a test sensitive to *where* the check runs: a look
 * taken any earlier still sees a missing file and orders the compile.
 *
 * The where-clause match keeps this to the repair's own read; other reads of
 * `generationJob` go through the same mock.
 */
export function publishAtPendingCompileRead(filename: string, content: string, alsoPublish?: () => void): void {
  mockPrisma.generationJob.findFirst.mockImplementation(async (args: { where?: Record<string, any> } = {}) => {
    if (args.where?.type === "COMPILE_EXPORT" && Array.isArray(args.where?.status?.in)) {
      writeProjectFile(state.bookStorageDir, "project-a", filename, content);
      alsoPublish?.();
    }
    return null;
  });
}

/**
 * `enqueueGenerationJob`, deduping the way the real one does: a row already
 * stored under the key is handed back and nothing new is created.
 *
 * The bare `vi.fn()` in the harness makes every call look successful, which is
 * exactly how a dedupe key that had gone terminal could enqueue nothing while
 * the route still looked like it was doing its job.
 */
export function fakeDedupingQueue(): Map<string, { id: string; status: string; dedupeKey: string }> {
  const jobs = new Map<string, { id: string; status: string; dedupeKey: string }>();
  let created = 0;
  mockQueue.enqueueGenerationJob.mockImplementation((async (options: { dedupeKey?: string }) => {
    const key = options.dedupeKey;
    const existing = key ? jobs.get(key) : undefined;
    if (existing) {
      return existing;
    }
    created += 1;
    const job = { id: `job-${created}`, status: "QUEUED", dedupeKey: key ?? `undeduped-${created}` };
    if (key) {
      jobs.set(key, job);
    }
    return job;
  }) as never);
  return jobs;
}

/**
 * A `$transaction` that runs one callback at a time.
 *
 * Serializable does not queue transactions — it lets them run and refuses the
 * loser — but what it guarantees is the outcome of *some* serial order, and that
 * is what a test can hold the code to: whoever goes second reads the first one's
 * row and stands down, which is where the refused caller's next poll lands too.
 */
export function serializeTransactions(): void {
  let previous = Promise.resolve();
  mockPrisma.$transaction.mockImplementation(async (run: unknown) => {
    const result = previous.then(() => (run as (tx: typeof mockPrisma) => Promise<unknown>)(mockPrisma));
    previous = result.then(
      () => undefined,
      () => undefined
    );
    return result;
  });
}
