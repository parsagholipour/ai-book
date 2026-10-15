import { describe, expect, it, vi } from "vitest";
import { providerSpendSince } from "./providerSpend.ts";

type AggregateArgs = { _sum: { costHint: true }; where: Record<string, unknown> };

/**
 * A stand-in that answers the aggregate the way Postgres would over `rows`:
 * `SUM` skips nulls and answers null over no rows. It reads the where clause it
 * was handed rather than trusting it, so a filter the helper forgets to send is
 * a wrong total here rather than a passing assertion about arguments.
 */
function clientOver(rows: Array<{ userId: string | null; costHint: number | null; createdAt: Date }>) {
  const aggregate = vi.fn(async (args: AggregateArgs) => {
    const where = args.where as { createdAt: { gte: Date }; costHint?: { not: null }; userId?: string };
    const matching = rows.filter((row) =>
      row.createdAt >= where.createdAt.gte &&
      (where.costHint === undefined || row.costHint !== null) &&
      (!("userId" in where) || row.userId === where.userId)
    );
    const priced = matching.map((row) => row.costHint).filter((cost): cost is number => cost !== null);
    return { _sum: { costHint: priced.length > 0 ? priced.reduce((sum, cost) => sum + cost, 0) : null } };
  });
  return { client: { providerCallLog: { aggregate } } as unknown as Parameters<typeof providerSpendSince>[0], aggregate };
}

const since = new Date("2026-10-13T00:00:00Z");
const rows = [
  { userId: "reader-a", costHint: 0.12, createdAt: new Date("2026-10-13T01:00:00Z") },
  { userId: "reader-a", costHint: null, createdAt: new Date("2026-10-13T02:00:00Z") },
  { userId: "reader-b", costHint: 0.5, createdAt: new Date("2026-10-13T03:00:00Z") },
  { userId: null, costHint: 0.03, createdAt: new Date("2026-10-13T04:00:00Z") },
  // Yesterday's spend is outside every window below.
  { userId: "reader-a", costHint: 9, createdAt: new Date("2026-10-12T23:59:59Z") }
];

describe("providerSpendSince", () => {
  it("sums everyone's priced spend since the moment, unattributed rows included", async () => {
    const { client, aggregate } = clientOver(rows);
    await expect(providerSpendSince(client, since)).resolves.toBe(0.65);
    expect(aggregate.mock.calls[0]![0].where).not.toHaveProperty("userId");
  });

  it("sums one reader's priced spend and nobody else's", async () => {
    const { client } = clientOver(rows);
    await expect(providerSpendSince(client, since, { userId: "reader-a" })).resolves.toBe(0.12);
    await expect(providerSpendSince(client, since, { userId: "reader-b" })).resolves.toBe(0.5);
  });

  it("asks only for priced rows, because a null costHint is never a dollar figure", async () => {
    const { client, aggregate } = clientOver(rows);
    await providerSpendSince(client, since, { userId: "reader-a" });
    expect(aggregate.mock.calls[0]![0].where).toMatchObject({ costHint: { not: null }, createdAt: { gte: since } });
  });

  it("answers zero, not null, when nothing was spent", async () => {
    const { client } = clientOver([{ userId: "reader-a", costHint: null, createdAt: new Date("2026-10-13T05:00:00Z") }]);
    await expect(providerSpendSince(client, since, { userId: "reader-a" })).resolves.toBe(0);
    await expect(providerSpendSince(client, since, { userId: "nobody" })).resolves.toBe(0);
  });

  it("rounds to the precision a call is priced at, so float noise never crosses a cap", async () => {
    const { client } = clientOver([
      { userId: "reader-a", costHint: 0.1, createdAt: new Date("2026-10-13T05:00:00Z") },
      { userId: "reader-a", costHint: 0.2, createdAt: new Date("2026-10-13T06:00:00Z") }
    ]);
    await expect(providerSpendSince(client, since)).resolves.toBe(0.3);
  });
});
