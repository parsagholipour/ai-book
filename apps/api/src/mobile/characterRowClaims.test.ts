import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { claimCharacterRows } from "./characterRowClaims.js";
import { resetMobileHarness, teardownMobileHarness } from "./testing/mobileApiHarness.js";
import { mockPrisma } from "./testing/mobileApiMocks.js";

/**
 * The batched claim, at unit level: what it asserts, and how it takes it.
 *
 * The assertion is covered from the route above; this is about the statement,
 * which used to be a write whose only visible effect was on `updatedAt` — the
 * column the app spends as its avatar cache-buster.
 */
describe("claimCharacterRows", () => {
  beforeEach(resetMobileHarness);
  afterEach(teardownMobileHarness);

  const tx = () => mockPrisma as never;
  const source = (index: number) => ({ id: `char-${index}`, userId: "user-a", name: `Mina ${index}` });
  const lastClaim = () => {
    const [strings, ...values] = mockPrisma.$queryRaw.mock.calls.at(-1) as [readonly string[], ...unknown[]];
    return { sql: strings.join("?"), values };
  };

  it("locks rather than writes, because a claim that waits would stamp a clock from before the wait", async () => {
    // Called "leaves updatedAt to the row, so a claim that waited cannot move
    // it backwards" until that was measured and found false. Taking out
    // `data: { updatedAt: new Date() }` left the column to `@updatedAt`, and
    // Prisma stamps that when it *builds* the statement — bound from the
    // client's clock before the query is sent, which is the instant
    // `new Date()` was read at: a claim issued at T and blocked 4.0 s on a real
    // row lock wrote T + 20 ms. No `data` this side could have fixed that; a
    // statement that writes nothing does.
    expect(await claimCharacterRows(tx(), [source(1), source(2)])).toBe(true);

    expect(mockPrisma.libraryCharacter.updateMany).not.toHaveBeenCalled();
    const { sql } = lastClaim();
    expect(sql).toMatch(/^\s*SELECT "id" FROM "LibraryCharacter"/);
    expect(sql).toContain("FOR NO KEY UPDATE");
    // `FOR UPDATE` would additionally block the `FOR KEY SHARE` an FK check on
    // a `LibraryMention` insert takes, serializing mention writes against
    // claims that do not conflict with them.
    expect(sql).not.toMatch(/FOR UPDATE/);
  });

  it("matches the three columns row-wise, so no row is claimed under a sibling's name", async () => {
    // Matched column by column, a character renamed into a name another row of
    // the same claim was read under satisfies every term and is reported as a
    // row this claim holds. `[userId, name]` is unique, so it takes two renames
    // to arrange — and the claim's window is ten seconds. The row constructor
    // over three parallel arrays is what makes the tuples positional, so this
    // pins that the three arrays are bound in step.
    expect(await claimCharacterRows(tx(), [source(1), source(2)])).toBe(true);

    const { sql, values } = lastClaim();
    expect(sql).toContain('("id", "userId", "name") IN');
    expect(sql).toContain("unnest");
    expect(values).toEqual([
      ["char-1", "char-2"],
      ["user-a", "user-a"],
      ["Mina 1", "Mina 2"]
    ]);
  });

  it("takes one statement for a whole library, mixed owners included", async () => {
    // The old claim wrote each row its own `userId` back, and one statement has
    // one `data`, so mixed owners were two statements. A `SELECT` has no
    // `data` and every tuple carries its own owner, so the grouping is gone —
    // and the 99-row claim is still the single statement the transaction
    // ceiling was sized for.
    const mine = { id: "char-1", userId: "user-a", name: "Mina" };
    const theirs = { id: "char-2", userId: "user-b", name: "Bram" };

    expect(await claimCharacterRows(tx(), [mine, theirs])).toBe(true);
    expect(mockPrisma.$queryRaw).toHaveBeenCalledTimes(1);
    expect(lastClaim().values[1]).toEqual(["user-a", "user-b"]);

    mockPrisma.$queryRaw.mockClear();
    const rows = Array.from({ length: 99 }, (_, index) => source(index));
    expect(await claimCharacterRows(tx(), rows)).toBe(true);
    expect(mockPrisma.$queryRaw).toHaveBeenCalledTimes(1);
  });

  it("reads a row that came back missing as a row that moved", async () => {
    // The verdict is the returned row count against the count asked for, and a
    // row-locking SELECT re-checks its predicate against the version it waited
    // for — so a sibling renamed inside the window matches no tuple and comes
    // back short, exactly as the old statement's `count` did. Measured against
    // a real Postgres: two rows named, one renamed under it, one row back.
    const rows = Array.from({ length: 99 }, (_, index) => source(index));
    mockPrisma.$queryRaw.mockResolvedValueOnce(rows.slice(1).map((row) => ({ id: row.id })));

    expect(await claimCharacterRows(tx(), rows)).toBe(false);
  });

  it("claims nothing, and says so, for an empty set", async () => {
    expect(await claimCharacterRows(tx(), [])).toBe(true);
    expect(mockPrisma.$queryRaw).not.toHaveBeenCalled();
  });

  it("answers for a suite that only called vi.resetAllMocks()", async () => {
    // `resetCharacterMocks()` is deliberately not called here, because a
    // default a suite has to ask for is what this pins against. Vitest restores
    // the implementation a mock was *constructed* with and drops everything
    // configured onto it afterwards, so the same default written as
    // `vi.fn().mockResolvedValue(…)` beside the declaration survives until the
    // first `beforeEach` and no further — and the claim then read
    // `undefined.length` from inside `claimCharacterRows`, which is a stack
    // trace in production code where a missing fixture should have been an
    // assertion about the claim. Any suite that mocks prisma directly and so
    // much as renames a character arrives here.
    vi.resetAllMocks();

    expect(await claimCharacterRows(tx(), [source(1), source(2)])).toBe(true);
  });
});
