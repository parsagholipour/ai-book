import { PLAN_ENTITLEMENT_TYPES } from "@book-maker/core";
import { describe, expect, it, vi } from "vitest";
import { freeSideUsd, planHoldersBetween, readSpendBreakdown, totalUsd } from "./spendBreakdown.js";

const SINCE = new Date("2026-10-13T00:00:00.000Z");
const UNTIL = new Date("2026-10-14T00:00:00.000Z");

function clientWith(groups: Array<{ userId: string | null; usd: number | null }>, planHolders: string[]) {
  const groupBy = vi.fn(async () => groups.map(({ userId, usd }) => ({ userId, _sum: { costHint: usd } })));
  const findMany = vi.fn(async ({ where }: { where: { userId: { in: string[] } } }) =>
    where.userId.in.filter((userId) => planHolders.includes(userId)).map((userId) => ({ userId }))
  );
  return { client: { providerCallLog: { groupBy }, userEntitlement: { findMany } } as never, groupBy, findMany };
}

describe("readSpendBreakdown", () => {
  it("splits the window's priced spend into free readers, paid readers and calls that name nobody", async () => {
    const { client, groupBy } = clientWith(
      [
        { userId: "free-a", usd: 0.1 },
        { userId: "free-b", usd: 0.2 },
        { userId: "paid-a", usd: 4 },
        { userId: null, usd: 0.3 },
        { userId: "free-c", usd: null }
      ],
      ["paid-a"]
    );

    const spend = await readSpendBreakdown(client, SINCE, UNTIL);

    expect(spend).toEqual({ freeUsd: 0.3, paidUsd: 4, unattributedUsd: 0.3 });
    expect(freeSideUsd(spend)).toBe(0.6);
    expect(totalUsd(spend)).toBe(4.6);
    // Priced rows only, summed the way providerSpendSince sums them.
    expect(groupBy).toHaveBeenCalledWith({
      by: ["userId"],
      where: { createdAt: { gte: SINCE, lt: UNTIL }, costHint: { not: null } },
      _sum: { costHint: true }
    });
  });

  it("asks nothing about plans when no reader is named", async () => {
    const { client, findMany } = clientWith([{ userId: null, usd: 2 }], []);

    expect(await readSpendBreakdown(client, SINCE, UNTIL)).toEqual({ freeUsd: 0, paidUsd: 0, unattributedUsd: 2 });
    expect(findMany).not.toHaveBeenCalled();
  });
});

describe("planHoldersBetween", () => {
  it("asks for a plan held at any moment of the window, refunded plans excluded", async () => {
    const { client, findMany } = clientWith([], ["paid-a"]);

    expect(await planHoldersBetween(client, ["paid-a", "free-a", "paid-a"], SINCE, UNTIL)).toEqual(new Set(["paid-a"]));
    expect(findMany).toHaveBeenCalledWith({
      where: {
        userId: { in: ["paid-a", "free-a"] },
        type: { in: PLAN_ENTITLEMENT_TYPES },
        status: { in: ["ACTIVE", "EXPIRED"] },
        startsAt: { lt: UNTIL },
        OR: [{ expiresAt: null }, { expiresAt: { gt: SINCE } }]
      },
      select: { userId: true },
      distinct: ["userId"]
    });
  });

  it("reads a large set in chunks, and counts the operator as paid without asking", async () => {
    const readers = Array.from({ length: 2_500 }, (_, index) => `reader-${index}`);
    const { client, findMany } = clientWith([], ["reader-0", "reader-2499"]);

    const holders = await planHoldersBetween(client, [...readers, "local-admin"], SINCE, UNTIL);

    expect(holders).toEqual(new Set(["reader-0", "reader-2499", "local-admin"]));
    expect(findMany.mock.calls.map(([args]) => args.where.userId.in.length)).toEqual([1_000, 1_000, 500]);
    expect(findMany.mock.calls.some(([args]) => args.where.userId.in.includes("local-admin"))).toBe(false);
  });
});
