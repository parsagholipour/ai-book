import { AsyncLocalStorage } from "node:async_hooks";
import { prisma } from "@book-maker/db";
import type { AnyWorkerJob } from "./jobPayloads.js";

/**
 * Whose spend a delivery's provider calls are, for `ProviderCallLog.userId`.
 *
 * Every recorder in `providers/usageAccounting.ts` stamps the row with the
 * user on this context, so a reader's spend can be summed off the log alone
 * (`@book-maker/db/providerSpend`) — including the portrait job, which has no
 * project to join through. The adapters are built synchronously from the job,
 * deep inside every handler, so threading a looked-up id through each of their
 * constructors would mean making all of them async; the delivery's async
 * context reaches every call they make instead, the way
 * `generationAttemptContext.ts` carries the attempt.
 *
 * Resolved lazily and once per delivery: a compile or a stale delivery that
 * makes no provider call costs no query, and every call after the first awaits
 * the same promise. A book's owner never changes, so there is nothing to
 * invalidate. A lookup that fails resolves to null — an unattributed row —
 * because accounting must never fail or delay the call it records.
 */

type SpendUserResolver = () => Promise<string | null>;

const spendUserStorage = new AsyncLocalStorage<SpendUserResolver>();

export function runWithProviderSpendUser<T>(job: AnyWorkerJob, run: () => Promise<T>): Promise<T> {
  return spendUserStorage.run(memoized(() => resolveProviderSpendUserId(job)), run);
}

/**
 * Spend that is not a delivery's: a source read (`sourceProcessing.ts`) has an
 * owner and neither a project nor a `GenerationJob`, so its owner is named here.
 */
export function runWithProviderSpendUserId<T>(userId: string, run: () => Promise<T>): Promise<T> {
  const resolved = Promise.resolve<string | null>(userId);
  return spendUserStorage.run(() => resolved, run);
}

/** The user the current delivery spends for; null outside a delivery or when it has none. */
export async function currentProviderSpendUserId(): Promise<string | null> {
  const resolve = spendUserStorage.getStore();
  return resolve ? resolve() : null;
}

/**
 * The portrait job carries its user in the payload, because it is the one
 * `GenerationJob` with no project (`handlers/CLAUDE.md`); every other job
 * names a project, and the project's owner is whose credits paid for it.
 */
export async function resolveProviderSpendUserId(job: AnyWorkerJob): Promise<string | null> {
  if (job.name === "generate-character-portrait") {
    return job.data.userId;
  }
  try {
    const project = await prisma.project.findUnique({ where: { id: job.data.projectId }, select: { userId: true } });
    return project?.userId ?? null;
  } catch (error) {
    console.error("Failed to resolve the provider spend user", error);
    return null;
  }
}

function memoized(resolve: SpendUserResolver): SpendUserResolver {
  let pending: Promise<string | null> | undefined;
  return () => (pending ??= resolve());
}
