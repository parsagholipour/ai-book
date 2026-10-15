import { describe, expect, it, vi } from "vitest";

vi.mock("@book-maker/db", () => ({ prisma: {} }));

import { resolveWindow } from "./admin/metrics.js";
import { RETENTION_DAYS, runTablePruneSweep, type PruneDatabase } from "./tablePruneSweep.js";

const NOW = new Date("2026-10-13T00:00:00.000Z");
const daysAgo = (days: number) => new Date(NOW.getTime() - days * 24 * 60 * 60_000);

type Row = { id: string } & Record<string, unknown>;
type Where = Record<string, unknown>;

/** Just enough of Prisma's `where` for the shapes the sweep sends: null, `lt`, `in` and `OR`. */
function matches(row: Row, where: Where): boolean {
  return Object.entries(where).every(([field, condition]) => {
    if (field === "OR") return (condition as Where[]).some((branch) => matches(row, branch));
    const value = row[field];
    if (condition === null) return value === null || value === undefined;
    const { lt, in: within } = condition as { lt?: Date; in?: unknown[] };
    if (lt !== undefined && !(value instanceof Date && value < lt)) return false;
    if (within !== undefined && !within.includes(value)) return false;
    return true;
  });
}

function table(rows: Row[]) {
  const deleteCalls: number[] = [];
  return {
    rows,
    deleteCalls,
    delegate: {
      findMany: vi.fn(async ({ where, take }: { where: Where; take: number }) =>
        rows.filter((row) => matches(row, where)).slice(0, take).map(({ id }) => ({ id }))
      ),
      deleteMany: vi.fn(async ({ where }: { where: Where }) => {
        const doomed = rows.filter((row) => matches(row, where));
        deleteCalls.push(doomed.length);
        for (const row of doomed) rows.splice(rows.indexOf(row), 1);
        return { count: doomed.length };
      })
    }
  };
}

function database(input: { calls?: Row[]; events?: Row[]; sessions?: Row[] }) {
  const calls = table(input.calls ?? []);
  const events = table(input.events ?? []);
  const sessions = table(input.sessions ?? []);
  const db = { providerCallLog: calls.delegate, productEvent: events.delegate, mobileSession: sessions.delegate } as unknown as PruneDatabase;
  return { db, calls, events, sessions };
}

const noPause = async () => undefined;

describe("the daily table prune", () => {
  it("deletes only projectless provider calls past retention, and keeps every call a book still names", async () => {
    const { db, calls } = database({
      calls: [
        { id: "old-projectless", projectId: null, createdAt: daysAgo(401) },
        { id: "old-of-deleted-book", projectId: null, createdAt: daysAgo(900) },
        { id: "old-of-live-book", projectId: "project-1", createdAt: daysAgo(900) },
        { id: "recent-projectless", projectId: null, createdAt: daysAgo(399) }
      ]
    });
    const result = await runTablePruneSweep({ db, now: NOW, pause: noPause });
    expect(result.providerCallLogs).toBe(2);
    expect(calls.rows.map(({ id }) => id)).toEqual(["old-of-live-book", "recent-projectless"]);
  });

  it("deletes product events past retention", async () => {
    const { db, events } = database({
      events: [
        { id: "old", createdAt: daysAgo(401) },
        { id: "recent", createdAt: daysAgo(30) }
      ]
    });
    expect((await runTablePruneSweep({ db, now: NOW, pause: noPause })).productEvents).toBe(1);
    expect(events.rows.map(({ id }) => id)).toEqual(["recent"]);
  });

  it("deletes sessions revoked or expired over 30 days ago, and no session that can still sign in", async () => {
    const live = { revokedAt: null, refreshTokenExpiresAt: daysAgo(-60) };
    const { db, sessions } = database({
      sessions: [
        { id: "revoked-long-ago", revokedAt: daysAgo(31), refreshTokenExpiresAt: daysAgo(-50) },
        { id: "expired-long-ago", revokedAt: null, refreshTokenExpiresAt: daysAgo(45) },
        { id: "revoked-yesterday", revokedAt: daysAgo(1), refreshTokenExpiresAt: daysAgo(-80) },
        { id: "expired-last-week", revokedAt: null, refreshTokenExpiresAt: daysAgo(7) },
        { id: "live", ...live }
      ]
    });
    expect((await runTablePruneSweep({ db, now: NOW, pause: noPause })).sessions).toBe(2);
    expect(sessions.rows.map(({ id }) => id)).toEqual(["revoked-yesterday", "expired-last-week", "live"]);
  });

  it("deletes in bounded batches, pausing between them, and stops a pass at the batch limit", async () => {
    const events = Array.from({ length: 25 }, (_, n) => ({ id: `event-${n}`, createdAt: daysAgo(500) }));
    const { db, events: table } = database({ events });
    const pause = vi.fn(noPause);

    const first = await runTablePruneSweep({ db, now: NOW, batchSize: 10, maxBatches: 2, pause });
    expect(first.productEvents).toBe(20);
    expect(table.deleteCalls).toEqual([10, 10]);
    expect(table.rows).toHaveLength(5);

    // The next day's pass drains the rest.
    const second = await runTablePruneSweep({ db, now: NOW, batchSize: 10, maxBatches: 2, pause });
    expect(second.productEvents).toBe(5);
    expect(table.rows).toHaveLength(0);
    expect(table.deleteCalls).toEqual([10, 10, 5]);
  });

  it("keeps every row the widest admin window can ask for", () => {
    // The dashboards sum provider calls and paywall events over at most this many days.
    const widest = resolveWindow(100_000).days;
    expect(widest).toBeLessThan(RETENTION_DAYS.projectlessProviderCalls);
    expect(widest).toBeLessThan(RETENTION_DAYS.productEvents);
  });
});
