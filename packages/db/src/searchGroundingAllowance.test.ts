import { describe, expect, it, vi } from "vitest";
import { claimSearchGroundingUnits, writeWithSearchGroundingClaim } from "./searchGroundingAllowance.ts";

/**
 * A stand-in client whose transactions behave like Postgres's for this one
 * statement: a claim is visible to the next only once its transaction commits,
 * and a transaction that throws takes its claim back. The real statement's
 * atomicity under concurrency is measured in `searchGroundingAllowance.integration.test.ts`.
 */
function counterClient() {
  const committed = new Map<string, number>();
  const rows: Array<{ countAfter: number | null; data: unknown }> = [];
  let chain = Promise.resolve();
  const create = vi.fn(async (args: { data: unknown }) => args);
  const client = {
    providerCallLog: { create },
    $transaction: vi.fn(<T>(fn: (tx: unknown) => Promise<T>): Promise<T> => {
      const run = chain.then(async () => {
        const pending = new Map(committed);
        const tx = {
          providerCallLog: { create },
          $queryRaw: async (_sql: TemplateStringsArray, pool: string, period: string, units: number) => {
            const next = (pending.get(`${pool}/${period}`) ?? 0) + units;
            pending.set(`${pool}/${period}`, next);
            return [{ units: next }];
          }
        };
        const result = await fn(tx);
        for (const [key, value] of pending) committed.set(key, value);
        return result;
      });
      chain = run.then(() => undefined, () => undefined);
      return run;
    })
  };
  return { client, committed, rows, create };
}

const claim = { pool: "gemini-2.5-flash", period: "2026-09-30", units: 1 };

describe("writeWithSearchGroundingClaim", () => {
  it("hands each concurrent writer its own ordinal, in order, with none repeated or skipped", async () => {
    const { client } = counterClient();
    const ordinals = await Promise.all(Array.from({ length: 25 }, () =>
      writeWithSearchGroundingClaim(client as never, claim, async (_tx, countAfter) => countAfter)
    ));
    expect([...ordinals].sort((a, b) => a! - b!)).toEqual(Array.from({ length: 25 }, (_, index) => index + 1));
  });

  it("takes the claim back when the row cannot be written, so the next call gets the same ordinal", async () => {
    const { client, committed } = counterClient();
    await writeWithSearchGroundingClaim(client as never, claim, async () => "first");
    await expect(writeWithSearchGroundingClaim(client as never, claim, async () => { throw new Error("insert failed"); }))
      .rejects.toThrow("insert failed");
    expect(await writeWithSearchGroundingClaim(client as never, claim, async (_tx, countAfter) => countAfter)).toBe(2);
    expect(committed.get("gemini-2.5-flash/2026-09-30")).toBe(2);
  });

  it("writes straight through, with no transaction, for a call that claims nothing", async () => {
    const { client } = counterClient();
    expect(await writeWithSearchGroundingClaim(client as never, null, async (tx, countAfter) => {
      await tx.providerCallLog.create({ data: {} as never });
      return countAfter;
    })).toBeNull();
    expect(await writeWithSearchGroundingClaim(client as never, { ...claim, units: 0 }, async (_tx, countAfter) => countAfter)).toBeNull();
    expect(client.$transaction).not.toHaveBeenCalled();
  });
});

describe("claimSearchGroundingUnits", () => {
  it("refuses a counter answer that cannot include its own units", async () => {
    await expect(claimSearchGroundingUnits({ $queryRaw: async () => [] } as never, claim)).rejects.toThrow("returned undefined");
    await expect(claimSearchGroundingUnits({ $queryRaw: async () => [{ units: 2 }] } as never, { ...claim, units: 4 })).rejects.toThrow();
  });
});
