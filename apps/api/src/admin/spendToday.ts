import type { Prisma } from "@book-maker/db";

/**
 * Today's biggest spenders, for the spend-controls panel: provider spend per
 * reader since the start of the UTC day, summed from `costHint` alone the way
 * `providerSpendSince` sums it, so a reader's row here is the same number their
 * daily cap is compared against. Rows that name no reader (calls from before
 * migration 000098, operator-console inline calls) are in the panel's global
 * total and in no row here — a top-N list is a partial list by design.
 */

type SpendTodayReader = Pick<Prisma.TransactionClient, "providerCallLog" | "user">;

export type TopSpender = { userId: string; email: string | null; spendUsd: number };

const USD_PRECISION = 1_000_000;

export async function topSpendersSince(client: SpendTodayReader, since: Date, limit = 10): Promise<TopSpender[]> {
  const groups = await client.providerCallLog.groupBy({
    by: ["userId"],
    where: { createdAt: { gte: since }, costHint: { not: null }, userId: { not: null } },
    _sum: { costHint: true },
    orderBy: { _sum: { costHint: "desc" } },
    take: limit
  });
  const ranked = groups.flatMap((group) =>
    group.userId ? [{ userId: group.userId, spendUsd: roundUsd(group._sum.costHint ?? 0) }] : []
  );
  if (ranked.length === 0) return [];
  const users = await client.user.findMany({
    where: { id: { in: ranked.map((row) => row.userId) } },
    select: { id: true, email: true }
  });
  const emails = new Map(users.map((user) => [user.id, user.email]));
  return ranked.map((row) => ({ ...row, email: emails.get(row.userId) ?? null }));
}

function roundUsd(value: number): number {
  return Number.isFinite(value) ? Math.round(value * USD_PRECISION) / USD_PRECISION : 0;
}
