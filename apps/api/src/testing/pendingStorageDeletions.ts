import type { StorageDeletionDatabase } from "../storageDeletionSweep.js";

export type PendingStorageDeletionRow = {
  prefix: string;
  projectId: string | null;
  requestedAt: Date;
  lastSweptAt: Date | null;
  lastFound: number | null;
  attempts: number;
  lastError: string | null;
};

type Where = { prefix?: string; requestedAt?: Date; OR?: Array<{ lastSweptAt: null | { lte: Date } }> };
type Data = Partial<Omit<PendingStorageDeletionRow, "attempts">> & { attempts?: { increment: number } };

function matches(row: PendingStorageDeletionRow, where: Where): boolean {
  if (where.prefix !== undefined && row.prefix !== where.prefix) return false;
  if (where.requestedAt !== undefined && row.requestedAt.getTime() !== where.requestedAt.getTime()) return false;
  if (where.OR) {
    return where.OR.some(({ lastSweptAt }) =>
      lastSweptAt === null ? row.lastSweptAt === null : row.lastSweptAt !== null && row.lastSweptAt <= lastSweptAt.lte
    );
  }
  return true;
}

/** An in-memory `PendingStorageDeletion` table for the shapes the sweep and the recorder send. */
export function memoryPendingStorageDeletions() {
  const rows = new Map<string, PendingStorageDeletionRow>();
  const apply = (row: PendingStorageDeletionRow, data: Data) => {
    const { attempts, ...rest } = data;
    Object.assign(row, rest);
    if (attempts) row.attempts += attempts.increment;
  };
  const table = {
    async upsert({ where, create, update }: { where: { prefix: string }; create: Partial<PendingStorageDeletionRow> & { prefix: string }; update: Data }) {
      const existing = rows.get(where.prefix);
      if (existing) {
        apply(existing, update);
        return existing;
      }
      const row: PendingStorageDeletionRow = {
        projectId: null, requestedAt: new Date(), lastSweptAt: null, lastFound: null, attempts: 0, lastError: null, ...create
      };
      rows.set(row.prefix, row);
      return row;
    },
    async findMany({ where, take }: { where: Where; take: number }) {
      return [...rows.values()]
        .filter((row) => matches(row, where))
        .sort((left, right) => (left.lastSweptAt?.getTime() ?? -Infinity) - (right.lastSweptAt?.getTime() ?? -Infinity))
        .slice(0, take)
        .map((row) => ({ ...row }));
    },
    async updateMany({ where, data }: { where: Where; data: Data }) {
      const hit = [...rows.values()].filter((row) => matches(row, where));
      for (const row of hit) apply(row, data);
      return { count: hit.length };
    },
    async deleteMany({ where }: { where: Where }) {
      const hit = [...rows.values()].filter((row) => matches(row, where));
      for (const row of hit) rows.delete(row.prefix);
      return { count: hit.length };
    }
  };
  return { rows, db: { pendingStorageDeletion: table } as unknown as StorageDeletionDatabase };
}
