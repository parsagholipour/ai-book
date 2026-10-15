import { prisma, type Prisma } from "@book-maker/db";

/**
 * Rows that were written forever and read for a bounded while: provider call
 * logs, product analytics events, and mobile sessions that are dead. Nothing
 * pruned them, so each table grew with every call, tap and sign-in for the
 * life of the product (launch review, 2026-10-13). Once a day, in bounded
 * batches, this deletes what no reader can still ask for:
 *
 * - **`ProviderCallLog` rows with no project, older than 400 days.** Every
 *   windowed reader — the spend breaker (today), the audiobook budget (24 h),
 *   and every admin dashboard, whose window is clamped to 365 days
 *   (`resolveWindow`, the routes' zod schemas) — fits inside that. A row that
 *   still names a project is kept whatever its age, because the operator's
 *   per-book views (`projectCosts.ts`, `admin/generatedBooks.ts`,
 *   `admin/inspection.ts`) sum a book's whole bill, and a book's margin with
 *   its first year of spend cut away would read as profit. Deleting the book
 *   sets the column null, and its rows age out from there.
 * - **`ProductEvent` rows older than 400 days.** The paywall funnel reads them
 *   within the same 365-day window and nothing else reads them.
 * - **`MobileSession` rows revoked, or past their refresh expiry, more than 30
 *   days ago.** Neither can authenticate again; a token from one answers
 *   `INVALID_SESSION` instead of `SESSION_REVOKED`, and the app treats both as
 *   the end of the session at the refresh route. Their push devices cascade,
 *   and are unreachable already (`livePushDeviceWhere`).
 *
 * Each batch selects at most `PRUNE_BATCH_SIZE` ids and deletes exactly those,
 * so no statement holds locks over a large range, and a pass stops after
 * `PRUNE_MAX_BATCHES` per table, so a backlog drains over a few days rather
 * than in one long pass. Several API processes may prune at once; a delete by
 * id is idempotent.
 */

export const RETENTION_DAYS = Object.freeze({
  projectlessProviderCalls: 400,
  productEvents: 400,
  deadSessions: 30
});
export const PRUNE_INTERVAL_MS = 24 * 60 * 60_000;
export const PRUNE_BATCH_SIZE = 1_000;
export const PRUNE_MAX_BATCHES = 100;
/** Between batches, so the database serves requests in between. */
const PRUNE_PAUSE_MS = 50;
const DAY_MS = 24 * 60 * 60_000;

export type PruneDatabase = {
  providerCallLog: Pick<Prisma.TransactionClient["providerCallLog"], "findMany" | "deleteMany">;
  productEvent: Pick<Prisma.TransactionClient["productEvent"], "findMany" | "deleteMany">;
  mobileSession: Pick<Prisma.TransactionClient["mobileSession"], "findMany" | "deleteMany">;
};

export type TablePruneResult = { providerCallLogs: number; productEvents: number; sessions: number };

type BatchTable = {
  findIds(take: number): Promise<Array<{ id: string }>>;
  deleteIds(ids: string[]): Promise<{ count: number }>;
};

export async function runTablePruneSweep(
  input: {
    db?: PruneDatabase;
    now?: Date;
    batchSize?: number;
    maxBatches?: number;
    pause?: () => Promise<void>;
  } = {}
): Promise<TablePruneResult> {
  const db = input.db ?? prisma;
  const now = (input.now ?? new Date()).getTime();
  const before = (days: number) => new Date(now - days * DAY_MS);
  const batchSize = input.batchSize ?? PRUNE_BATCH_SIZE;
  const maxBatches = input.maxBatches ?? PRUNE_MAX_BATCHES;
  const pause = input.pause ?? (() => new Promise<void>((resolve) => setTimeout(resolve, PRUNE_PAUSE_MS)));

  const callsWhere: Prisma.ProviderCallLogWhereInput = {
    projectId: null,
    createdAt: { lt: before(RETENTION_DAYS.projectlessProviderCalls) }
  };
  const eventsWhere: Prisma.ProductEventWhereInput = { createdAt: { lt: before(RETENTION_DAYS.productEvents) } };
  const sessionCutoff = before(RETENTION_DAYS.deadSessions);
  const sessionsWhere: Prisma.MobileSessionWhereInput = {
    OR: [{ revokedAt: { lt: sessionCutoff } }, { refreshTokenExpiresAt: { lt: sessionCutoff } }]
  };

  const prune = (table: BatchTable) => pruneInBatches(table, batchSize, maxBatches, pause);
  // One table after another: three concurrent delete loops would be the load this paces.
  const providerCallLogs = await prune({
    findIds: (take) => db.providerCallLog.findMany({ where: callsWhere, select: { id: true }, take }),
    deleteIds: (ids) => db.providerCallLog.deleteMany({ where: { id: { in: ids } } })
  });
  const productEvents = await prune({
    findIds: (take) => db.productEvent.findMany({ where: eventsWhere, select: { id: true }, take }),
    deleteIds: (ids) => db.productEvent.deleteMany({ where: { id: { in: ids } } })
  });
  const sessions = await prune({
    findIds: (take) => db.mobileSession.findMany({ where: sessionsWhere, select: { id: true }, take }),
    deleteIds: (ids) => db.mobileSession.deleteMany({ where: { id: { in: ids } } })
  });
  return { providerCallLogs, productEvents, sessions };
}

async function pruneInBatches(table: BatchTable, batchSize: number, maxBatches: number, pause: () => Promise<void>): Promise<number> {
  let deleted = 0;
  for (let batch = 0; batch < maxBatches; batch += 1) {
    const rows = await table.findIds(batchSize);
    if (rows.length === 0) break;
    deleted += (await table.deleteIds(rows.map(({ id }) => id))).count;
    if (rows.length < batchSize) break;
    await pause();
  }
  return deleted;
}
