import type { Prisma, PrismaClient } from "./generated/prisma/client.ts";

/**
 * Where each grounded search falls in Google's free allowance.
 *
 * Google waives the first N grounded prompts (Gemini 2.5) or search queries
 * (3.x) per Google project per Pacific-time day or month, and bills list price
 * past them. A call is priced by its ordinal in that pool-period, and the
 * ordinal comes from one counter row per `(pool, period)`, claimed in the same
 * transaction that writes the call's `ProviderCallLog` row:
 *
 * - **No repeats.** `INSERT … ON CONFLICT DO UPDATE … RETURNING` is atomic in
 *   Postgres: concurrent claims on one key queue on its row lock — the first
 *   insert included — and each gets back the count *including* its own units.
 * - **No skips.** The claim and the row commit together, so a write that fails
 *   rolls its claim back with it, and the count is always the units of the rows
 *   that exist.
 *
 * Several workers and the API record concurrently, which is why the count is a
 * row rather than a `COUNT(*)` over the log: a count read and then written is
 * the race this exists to remove. The pricing itself is core's
 * (`applySearchGroundingAllowance`); this module only owns the claim, and
 * takes the client as an argument with Prisma imported for types alone, so a
 * suite that mocks `@book-maker/db` wholesale still runs the real claim against
 * its own stand-in client (the `./libraryMentions` pattern, packages/db/CLAUDE.md).
 */

/** One call's claim on its pool's counter, as core's `searchGroundingClaim` plans it. */
export type SearchGroundingCounterClaim = { pool: string; period: string; units: number };

type RawQueryClient = Pick<Prisma.TransactionClient, "$queryRaw">;
type ProviderCallLogWriter = Pick<Prisma.TransactionClient, "providerCallLog">;

/** Adds the claim's units to its pool-period and returns the new count, which is this claim's last ordinal. */
export async function claimSearchGroundingUnits(tx: RawQueryClient, claim: SearchGroundingCounterClaim): Promise<number> {
  const rows = await tx.$queryRaw<Array<{ units: number }>>`
    INSERT INTO "SearchGroundingAllowanceCounter" ("pool", "period", "units", "updatedAt")
    VALUES (${claim.pool}, ${claim.period}, ${claim.units}, now())
    ON CONFLICT ("pool", "period") DO UPDATE
      SET "units" = "SearchGroundingAllowanceCounter"."units" + EXCLUDED."units", "updatedAt" = now()
    RETURNING "units"
  `;
  const units = Number(rows[0]?.units);
  if (!Number.isInteger(units) || units < claim.units) {
    throw new Error(`Search grounding counter ${claim.pool}/${claim.period} returned ${String(rows[0]?.units)}.`);
  }
  return units;
}

/**
 * Writes one search call's row, claiming its allowance units first when it has
 * any. `write` gets the transaction and the pool-period's count including this
 * call (`null` when nothing was claimed) and prices the row from it.
 */
export async function writeWithSearchGroundingClaim<T>(
  client: Pick<PrismaClient, "$transaction"> & ProviderCallLogWriter,
  claim: SearchGroundingCounterClaim | null,
  write: (tx: ProviderCallLogWriter, countAfter: number | null) => Promise<T>
): Promise<T> {
  if (!claim || claim.units <= 0) {
    return write(client, null);
  }
  return client.$transaction(async (tx) => write(tx, await claimSearchGroundingUnits(tx, claim)));
}
