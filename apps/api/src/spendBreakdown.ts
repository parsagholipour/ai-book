import { PLAN_ENTITLEMENT_TYPES } from "@book-maker/core";
import type { Prisma } from "@book-maker/db";
import { DEFAULT_LOCAL_ADMIN_USER_ID } from "./localAdminUser.js";

/**
 * Provider spend over a window, split by who it was spent for: readers with no
 * plan, readers with one, and calls that name no reader. It is what the spend
 * breaker's global caps read (`spendBreaker.ts`): the soft, hard and monthly
 * caps count free spend — free readers plus unattributed calls, which are a
 * floor anyway — and the paid cap counts the rest.
 *
 * Spend is `SUM("costHint")`, exactly as `providerSpendSince` sums it
 * (`apps/api/src/admin/CLAUDE.md`), so the three parts add up to the same
 * floor the old single number was. The read is one `groupBy` over the window's
 * rows (the `(createdAt)` index of migration 000100) and one entitlement read
 * for the readers it found, chunked; both are bounded by the window's readers,
 * not by the table.
 *
 * **"Paid" is a plan held at any moment of the window.** It is the breaker's
 * notion of paid (`hasActiveSubscriptionEntitlement`: an ACTIVE plan
 * entitlement not yet expired) asked over the window rather than at an
 * instant. Asked at an instant, a subscriber whose plan lapsed this afternoon
 * would move the whole day's — or month's — spend into the free counter and
 * could trip the free caps for every free reader; held over the window, a plan
 * that ended keeps the spend it backed. An expired plan carries `expiresAt` =
 * the moment it ended (every EXPIRED write in `billingSubscriptions.ts` sets
 * it), so it counts only for windows it overlapped. A REVOKED plan was
 * refunded: its spend was never paid for, and counts as free. A reader who
 * subscribed during the window counts as paid for all of it, which only
 * undercounts free spend — the fail-open direction.
 *
 * The console's `local-admin` is never a free account: its books are the
 * operator's own choice to spend, and they count as paid (the door side
 * exempts it the same way). A deleted account's rows lose their user
 * (`onDelete: SetNull`) and count as unattributed.
 */

export type SpendBreakdown = {
  /** Readers with no plan in the window. */
  freeUsd: number;
  /** Readers who held a plan in the window, and the operator. */
  paidUsd: number;
  /** Calls that name no reader. */
  unattributedUsd: number;
};

export const NO_SPEND: SpendBreakdown = { freeUsd: 0, paidUsd: 0, unattributedUsd: 0 };

/** What the free caps compare: free readers plus calls that name nobody. */
export function freeSideUsd(spend: SpendBreakdown): number {
  return roundUsd(spend.freeUsd + spend.unattributedUsd);
}

export function totalUsd(spend: SpendBreakdown): number {
  return roundUsd(spend.freeUsd + spend.paidUsd + spend.unattributedUsd);
}

type SpendBreakdownReader = Pick<Prisma.TransactionClient, "providerCallLog" | "userEntitlement">;

/** Six decimals: the precision `packages/core/src/costs.ts` prices a call at. */
const USD_PRECISION = 1_000_000;
/** Ids per entitlement read: far under Postgres's bind-parameter limit. */
const PLAN_READ_CHUNK = 1_000;

/** Spend on rows written in `[since, until)`. A failed read throws; the breaker decides what that means. */
export async function readSpendBreakdown(client: SpendBreakdownReader, since: Date, until: Date): Promise<SpendBreakdown> {
  const groups = await client.providerCallLog.groupBy({
    by: ["userId"],
    where: { createdAt: { gte: since, lt: until }, costHint: { not: null } },
    _sum: { costHint: true }
  });
  const readers = groups.flatMap((group) => (group.userId ? [group.userId] : []));
  const paid = await planHoldersBetween(client, readers, since, until);
  let freeUsd = 0;
  let paidUsd = 0;
  let unattributedUsd = 0;
  for (const group of groups) {
    const usd = group._sum.costHint;
    if (typeof usd !== "number" || !Number.isFinite(usd)) continue;
    if (!group.userId) unattributedUsd += usd;
    else if (paid.has(group.userId)) paidUsd += usd;
    else freeUsd += usd;
  }
  return { freeUsd: roundUsd(freeUsd), paidUsd: roundUsd(paidUsd), unattributedUsd: roundUsd(unattributedUsd) };
}

/** Which of these readers held a plan at some moment of `[since, until)`; the operator always does. */
export async function planHoldersBetween(
  client: Pick<Prisma.TransactionClient, "userEntitlement">,
  userIds: readonly string[],
  since: Date,
  until: Date
): Promise<Set<string>> {
  const holders = new Set<string>();
  const readers = [...new Set(userIds)].filter((userId) => {
    if (userId !== DEFAULT_LOCAL_ADMIN_USER_ID) return true;
    holders.add(userId);
    return false;
  });
  for (let start = 0; start < readers.length; start += PLAN_READ_CHUNK) {
    const rows = await client.userEntitlement.findMany({
      where: {
        userId: { in: readers.slice(start, start + PLAN_READ_CHUNK) },
        type: { in: PLAN_ENTITLEMENT_TYPES },
        status: { in: ["ACTIVE", "EXPIRED"] },
        startsAt: { lt: until },
        OR: [{ expiresAt: null }, { expiresAt: { gt: since } }]
      },
      select: { userId: true },
      distinct: ["userId"]
    });
    for (const row of rows) holders.add(row.userId);
  }
  return holders;
}

function roundUsd(value: number): number {
  return Number.isFinite(value) ? Math.round(value * USD_PRECISION) / USD_PRECISION : 0;
}
