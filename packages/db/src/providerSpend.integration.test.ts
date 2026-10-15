import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "./client.ts";
import { providerSpendSince } from "./providerSpend.ts";

/**
 * Opt-in integration suite for what a stand-in client cannot vouch for: that
 * Postgres sums `costHint` skipping the nulls, that the user filter and the
 * window are the ones the cap means, and that the foreign key migration 000098
 * adds lets a row outlive its user as unattributed spend.
 *
 *   DB_INTEGRATION=true pnpm -F @book-maker/db exec vitest run src/providerSpend.integration.test.ts
 *
 * The target must be migrated through `000100`. Its rows sit in a window a
 * century out, so no real spend can fall inside it, and are deleted afterwards.
 */
const enabled = process.env.DB_INTEGRATION === "true";
const run = randomUUID();
const readerA = `spend-a-${run}`;
const readerB = `spend-b-${run}`;
const since = new Date(Date.UTC(2126, 0, 1) + Math.floor(Math.random() * 1e9));
const at = (minutes: number) => new Date(since.getTime() + minutes * 60_000);

describe.skipIf(!enabled)("provider spend on Postgres", () => {
  beforeAll(async () => {
    await prisma.user.createMany({ data: [readerA, readerB].map((id) => ({ id, email: `${id}@test.invalid` })) });
    const row = (userId: string | null, costHint: number | null, minutes: number) => ({
      userId, costHint, createdAt: at(minutes), provider: "gemini", model: "test", purpose: `test-${run}`, metadata: {}
    });
    await prisma.providerCallLog.createMany({ data: [
      row(readerA, 0.25, 1),
      row(readerA, null, 2),
      row(readerB, 1.5, 3),
      row(null, 0.125, 4),
      row(readerA, 7, -1)
    ] });
  });

  afterAll(async () => {
    await prisma.providerCallLog.deleteMany({ where: { purpose: `test-${run}` } });
    await prisma.user.deleteMany({ where: { id: { in: [readerA, readerB] } } });
    await prisma.$disconnect();
  });

  it("sums everyone's priced spend in the window, and one reader's alone", async () => {
    expect(await providerSpendSince(prisma, since)).toBe(1.875);
    expect(await providerSpendSince(prisma, since, { userId: readerA })).toBe(0.25);
    expect(await providerSpendSince(prisma, since, { userId: readerB })).toBe(1.5);
    expect(await providerSpendSince(prisma, at(10), { userId: readerA })).toBe(0);
  });

  it("keeps a deleted user's rows as unattributed spend", async () => {
    await prisma.user.delete({ where: { id: readerB } });
    expect(await providerSpendSince(prisma, since, { userId: readerB })).toBe(0);
    expect(await providerSpendSince(prisma, since)).toBe(1.875);
  });
});
