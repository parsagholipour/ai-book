import type { Prisma } from "./generated/prisma/client.ts";

/**
 * Provider spend in US dollars since a moment — everyone's, or one reader's.
 *
 * Spend is `SUM("costHint")` and nothing else: a non-null `costHint` *is* a
 * settled, priced call, and every provisional, in-flight, failed or unrated
 * row writes null (`apps/api/src/admin/CLAUDE.md`), so no rate card is
 * replayed here. That makes the number a floor on real spend, never an
 * overstatement — the right way round for a cap, which must not refuse a
 * reader for money nobody spent.
 *
 * A reader's spend is read off `ProviderCallLog.userId` alone, not through
 * `Project`, because the calls with no book behind them — the library
 * portrait, the creation chat, a library character's voice call — are exactly
 * the ones a project join misses. Rows written before migration 000098 carry
 * no user; a cap only ever reads a recent window, so nothing is backfilled.
 *
 * The client is an argument and Prisma is imported for types alone, so a suite
 * that mocks `@book-maker/db` wholesale still runs the real read against its
 * own stand-in client (the `./searchGroundingAllowance` pattern,
 * packages/db/CLAUDE.md). Served by `(userId, createdAt)` and `(createdAt)`
 * (migrations 000099 and 000100).
 */

type ProviderSpendReader = Pick<Prisma.TransactionClient, "providerCallLog">;

/** Six decimals: the precision `packages/core/src/costs.ts` prices a call at. */
const USD_PRECISION = 1_000_000;

export async function providerSpendSince(
  client: ProviderSpendReader,
  since: Date,
  options: { userId?: string } = {}
): Promise<number> {
  const result = await client.providerCallLog.aggregate({
    _sum: { costHint: true },
    where: {
      createdAt: { gte: since },
      costHint: { not: null },
      ...(options.userId !== undefined ? { userId: options.userId } : {})
    }
  });
  const usd = result._sum.costHint;
  return typeof usd === "number" && Number.isFinite(usd) ? Math.round(usd * USD_PRECISION) / USD_PRECISION : 0;
}
