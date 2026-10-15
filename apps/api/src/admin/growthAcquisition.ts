import { prisma } from "@book-maker/db";
import { PAYWALL_TRIGGERS, PURCHASE_FAILURE_REASONS } from "../productEventNames.js";
import { DEFAULT_LOCAL_ADMIN_USER_ID } from "../requestAuth.js";
import type { AdminWindow } from "./metrics.js";

/**
 * The two halves of the growth funnel only the app can see (`ProductEvent`):
 * where an install came from, and what became of each checkout.
 *
 * Both count only what app builds that report them sent, so they start at the
 * build that shipped them and read low rather than wrong before it.
 */

/**
 * Installs by the Play install referrer's `utm_source` and `utm_medium`. The
 * app reports its referrer once per install, after its first sign-in, so an
 * install nobody signed in to is never seen. `installs` counts reports in the
 * window — reinstalls and second devices included. The rest follow each
 * reader's *first* report ever (first touch) when it fell in the window:
 * `newAccounts` signed up within a day before it (a reinstall by an older
 * account does not count), `fromShares` came through a share page's Play link,
 * `paid` has paid for anything since.
 */
export type InstallSource = {
  source: string;
  medium: string;
  installs: number;
  readers: number;
  newAccounts: number;
  fromShares: number;
  paid: number;
};

/**
 * Checkouts started in the window, per product: how many were started (of them
 * through the intro offer), cancelled in Play, failed (by class in
 * `failures`), and of the readers who started one, how many paid for that
 * product between their first start and a day after their last. A completed
 * purchase is a `PurchasePayment`, never an event.
 */
export type CheckoutFunnel = {
  bySku: Array<{
    sku: string;
    started: number;
    introStarted: number;
    cancelled: number;
    failed: number;
    starters: number;
    paidWithin1Day: number;
  }>;
  failures: Array<{ reason: string; events: number }>;
  /** Which paywall each checkout was started from. */
  bySurface: Array<{ surface: string; started: number }>;
};

export async function loadInstallSources(window: AdminWindow): Promise<InstallSource[]> {
  const [installs, readers] = await Promise.all([
    prisma.$queryRaw<Array<{ source: string | null; medium: string | null; installs: bigint }>>`
      SELECT e.properties ->> 'source' AS source, e.properties ->> 'medium' AS medium, count(*) AS installs
      FROM "ProductEvent" e
      WHERE e.name = 'install_attributed' AND e."createdAt" >= ${window.since} AND e."createdAt" <= ${window.until}
        AND e."userId" <> ${DEFAULT_LOCAL_ADMIN_USER_ID}
      GROUP BY 1, 2
    `,
    // First touch: each reader's earliest report, which the 400-day event
    // prune bounds (`tablePruneSweep.ts`), kept when it falls in the window.
    prisma.$queryRaw<
      Array<{ source: string | null; medium: string | null; readers: bigint; new_accounts: bigint; from_shares: bigint; paid: bigint }>
    >`
      WITH firsts AS (
        SELECT DISTINCT ON (e."userId") e."userId", e."createdAt", e.properties
        FROM "ProductEvent" e
        WHERE e.name = 'install_attributed' AND e."createdAt" <= ${window.until}
          AND e."userId" <> ${DEFAULT_LOCAL_ADMIN_USER_ID}
        ORDER BY e."userId", e."createdAt"
      )
      SELECT f.properties ->> 'source' AS source, f.properties ->> 'medium' AS medium,
        count(*) AS readers,
        count(*) FILTER (WHERE u."createdAt" >= f."createdAt" - interval '1 day') AS new_accounts,
        count(*) FILTER (WHERE (f.properties ->> 'shareSlug') IS NOT NULL) AS from_shares,
        count(*) FILTER (WHERE EXISTS (SELECT 1 FROM "PurchasePayment" p WHERE p."userId" = f."userId")) AS paid
      FROM firsts f JOIN "User" u ON u.id = f."userId"
      WHERE f."createdAt" >= ${window.since}
      GROUP BY 1, 2
    `
  ]);
  const key = (source: string | null, medium: string | null) => `${source ?? "unknown"}\u0000${medium ?? "none"}`;
  const merged = new Map<string, InstallSource>();
  const entry = (source: string | null, medium: string | null): InstallSource => {
    const found = merged.get(key(source, medium));
    if (found) return found;
    const created = {
      source: source ?? "unknown",
      medium: medium ?? "none",
      installs: 0,
      readers: 0,
      newAccounts: 0,
      fromShares: 0,
      paid: 0
    };
    merged.set(key(source, medium), created);
    return created;
  };
  for (const row of installs) entry(row.source, row.medium).installs += Number(row.installs);
  for (const row of readers) {
    const target = entry(row.source, row.medium);
    target.readers += Number(row.readers);
    target.newAccounts += Number(row.new_accounts);
    target.fromShares += Number(row.from_shares);
    target.paid += Number(row.paid);
  }
  return [...merged.values()].sort((left, right) => right.readers - left.readers || right.installs - left.installs);
}

export async function loadCheckoutFunnel(window: AdminWindow): Promise<CheckoutFunnel> {
  const [events, starters] = await Promise.all([
    prisma.$queryRaw<
      Array<{ name: string; sku: string | null; reason: string | null; surface: string | null; intro: string | null; events: bigint }>
    >`
      SELECT e.name, e.properties ->> 'sku' AS sku, e.properties ->> 'reason' AS reason,
        e.properties ->> 'surface' AS surface, e.properties ->> 'intro' AS intro, count(*) AS events
      FROM "ProductEvent" e
      WHERE e.name IN ('purchase_started', 'purchase_cancelled', 'purchase_failed')
        AND e."createdAt" >= ${window.since} AND e."createdAt" <= ${window.until}
      GROUP BY 1, 2, 3, 4, 5
    `,
    prisma.$queryRaw<Array<{ sku: string | null; starters: bigint; paid: bigint }>>`
      WITH starts AS (
        SELECT e."userId", e.properties ->> 'sku' AS sku, min(e."createdAt") AS first_start, max(e."createdAt") AS last_start
        FROM "ProductEvent" e
        WHERE e.name = 'purchase_started' AND e."createdAt" >= ${window.since} AND e."createdAt" <= ${window.until}
        GROUP BY 1, 2
      )
      SELECT s.sku, count(*) AS starters,
        count(*) FILTER (WHERE EXISTS (
          SELECT 1 FROM "PurchasePayment" p
          JOIN "PurchaseRecord" r ON r.id = p."purchaseRecordId"
          JOIN "ProductCatalog" c ON c.id = r."productId"
          WHERE p."userId" = s."userId" AND c.sku = s.sku
            AND p."paidAt" >= s.first_start AND p."paidAt" <= s.last_start + interval '1 day'
        )) AS paid
      FROM starts s
      GROUP BY s.sku
    `
  ]);
  const reasons = new Set<string>(PURCHASE_FAILURE_REASONS);
  const surfaces = new Set<string>(PAYWALL_TRIGGERS);
  const skus = new Map<string, CheckoutFunnel["bySku"][number]>();
  const sku = (name: string | null) => {
    const id = name ?? "unknown";
    const found = skus.get(id);
    if (found) return found;
    const created = { sku: id, started: 0, introStarted: 0, cancelled: 0, failed: 0, starters: 0, paidWithin1Day: 0 };
    skus.set(id, created);
    return created;
  };
  const failures = new Map<string, number>();
  const bySurface = new Map<string, number>();
  for (const row of events) {
    const count = Number(row.events);
    const target = sku(row.sku);
    if (row.name === "purchase_started") {
      target.started += count;
      if (row.intro === "true") target.introStarted += count;
      const surface = row.surface && surfaces.has(row.surface) ? row.surface : "other";
      bySurface.set(surface, (bySurface.get(surface) ?? 0) + count);
    } else if (row.name === "purchase_cancelled") {
      target.cancelled += count;
    } else if (row.name === "purchase_failed") {
      target.failed += count;
      const reason = row.reason && reasons.has(row.reason) ? row.reason : "other";
      failures.set(reason, (failures.get(reason) ?? 0) + count);
    }
  }
  for (const row of starters) {
    const target = sku(row.sku);
    target.starters += Number(row.starters);
    target.paidWithin1Day += Number(row.paid);
  }
  return {
    bySku: [...skus.values()].sort((left, right) => right.started - left.started),
    failures: [...failures].map(([reason, count]) => ({ reason, events: count })).sort((left, right) => right.events - left.events),
    bySurface: [...bySurface].map(([surface, started]) => ({ surface, started })).sort((left, right) => right.started - left.started)
  };
}
