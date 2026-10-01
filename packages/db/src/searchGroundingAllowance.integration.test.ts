import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { prisma } from "./client.ts";
import { claimSearchGroundingUnits, writeWithSearchGroundingClaim } from "./searchGroundingAllowance.ts";

/**
 * Opt-in integration suite for the one property of the grounding counter that
 * only a real Postgres can settle: that `INSERT … ON CONFLICT DO UPDATE …
 * RETURNING`, run by many transactions at once on one key — the very first
 * insert included — hands out every ordinal exactly once, and that a claim
 * rolled back with its transaction is not spent.
 *
 *   DB_INTEGRATION=true pnpm -F @book-maker/db exec vitest run src/searchGroundingAllowance.integration.test.ts
 *
 * The target must be migrated through `000082`. It writes only counter rows
 * under a random `test-` pool, and deletes them afterwards.
 */
const enabled = process.env.DB_INTEGRATION === "true";
const pool = `test-${randomUUID()}`;

describe.skipIf(!enabled)("search grounding counter on Postgres", () => {
  afterAll(async () => {
    await prisma.searchGroundingAllowanceCounter.deleteMany({ where: { pool } });
    await prisma.$disconnect();
  });

  it("gives 40 concurrent first claims on a fresh key the ordinals 1–40, once each", async () => {
    const claim = { pool, period: "2026-09-30", units: 1 };
    const ordinals = await Promise.all(Array.from({ length: 40 }, () =>
      prisma.$transaction((tx) => claimSearchGroundingUnits(tx, claim), { timeout: 30_000, maxWait: 30_000 })
    ));
    expect([...ordinals].sort((a, b) => a - b)).toEqual(Array.from({ length: 40 }, (_, index) => index + 1));
  });

  it("counts a multi-unit claim as a block, and keeps periods apart", async () => {
    const results = await Promise.all([3, 4, 5].map((units) =>
      prisma.$transaction((tx) => claimSearchGroundingUnits(tx, { pool, period: "2026-09", units }), { timeout: 30_000, maxWait: 30_000 })
    ));
    expect(Math.max(...results)).toBe(12);
    expect(await prisma.$transaction((tx) => claimSearchGroundingUnits(tx, { pool, period: "2026-10", units: 1 }))).toBe(1);
  });

  it("does not spend a claim whose row was never written", async () => {
    const claim = { pool, period: "2026-10-01", units: 1 };
    await expect(writeWithSearchGroundingClaim(prisma, claim, async () => { throw new Error("insert failed"); })).rejects.toThrow("insert failed");
    expect(await writeWithSearchGroundingClaim(prisma, claim, async (_tx, countAfter) => countAfter)).toBe(1);
  });
});
