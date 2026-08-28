import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * One render pass against a world that moved under it.
 *
 * `characterReferenceRenderLease.test.ts` is the other half: two live passes
 * over one cast, and which of their two answers the plan keeps. Nothing here is
 * about arbitration. These are the four ways this pass loses its footing —
 * the job's wait budget spent before a wait is entered, the plan version deleted
 * while the cast renders, no pooled connection to commit a paid render through,
 * and the clock the lease itself is measured in — so they drive the lease
 * directly rather than through `ensureCharacterReferenceAssets`.
 */

const mocks = vi.hoisted(() => ({
  planVersion: { findUnique: vi.fn() },
  imageAsset: { findMany: vi.fn() },
  executeRaw: vi.fn(),
  queryRawUnsafe: vi.fn(),
  executeRawUnsafe: vi.fn(),
  transaction: vi.fn(),
  assertJobNotStopped: vi.fn(),
  mkdir: vi.fn(),
  appendFile: vi.fn()
}));

const tx = {
  planVersion: mocks.planVersion,
  imageAsset: mocks.imageAsset,
  $executeRaw: mocks.executeRaw,
  $queryRawUnsafe: mocks.queryRawUnsafe,
  $executeRawUnsafe: mocks.executeRawUnsafe
};

vi.mock("@book-maker/db", () => ({
  prisma: {
    planVersion: mocks.planVersion,
    imageAsset: mocks.imageAsset,
    $transaction: mocks.transaction,
    $executeRaw: mocks.executeRaw,
    $queryRawUnsafe: mocks.queryRawUnsafe,
    $executeRawUnsafe: mocks.executeRawUnsafe
  },
  Prisma: { DbNull: "DbNull" }
}));
vi.mock("../runtime/config.js", () => ({ config: { BOOK_STORAGE_DIR: "/tmp/books" } }));
vi.mock("../runtime/jobLifecycle.js", () => ({ assertJobNotStopped: mocks.assertJobNotStopped }));
vi.mock("node:fs/promises", () => ({ mkdir: mocks.mkdir, appendFile: mocks.appendFile }));
vi.mock("@book-maker/core", () => ({ safePathPart: (value: string) => value }));

import {
  CHARACTER_REFERENCE_LEASE_MAX_WAIT_MS,
  CHARACTER_REFERENCE_LEASE_MS,
  runCharacterReferenceRenderPass
} from "./characterReferenceRenderLease.js";

/** The wait polls at 2s, so two of them is "let it look again". */
const TWO_POLLS_MS = 4_000;

const stopRequested = () => Object.assign(new Error("Stopped by user"), { name: "StopRequestedError" });

/** Every stand-down line this pass appended, oldest first. */
const standDownLines = (): Array<Record<string, unknown>> =>
  mocks.appendFile.mock.calls.map(([, line]) => JSON.parse(String(line)) as Record<string, unknown>);

const isLeaseClaim = (sql: unknown): boolean => String(sql).includes('UPDATE "PlanVersion"');

type PassReadState = { answer: string; settled: boolean };

const passWith = (read: () => PassReadState, render: () => void = () => {}) => ({
  projectId: "project-1",
  planId: "plan-1",
  generationJobId: "gj-1",
  read: vi.fn(async () => read()),
  render: vi.fn(async () => {
    render();
    return "the cast this pass drew";
  }),
  supersedes: vi.fn(() => true),
  commit: vi.fn(async () => "committed"),
  // The sheets a pass wrote and did not publish are its own to unlink; the
  // stand-downs below are three of the four ways that happens. Each of them
  // reaches the end of the commit transaction, so none of them asks
  // `published` — that question exists for the fourth way, a throw.
  discard: vi.fn(async () => undefined),
  published: vi.fn(() => false)
});

/** Everything the mocks do resolves in microtasks, so this drains the pass. */
const drain = async (): Promise<void> => {
  for (let tick = 0; tick < 5; tick += 1) {
    await new Promise((resolve) => {
      setImmediate(resolve);
    });
  }
};

describe("a character reference render pass whose ground moved", () => {
  let consoleWarn: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => {});
    mocks.transaction.mockImplementation(async (callback: (client: typeof tx) => unknown) => callback(tx));
    mocks.executeRaw.mockResolvedValue(1);
    mocks.executeRawUnsafe.mockResolvedValue(1);
    mocks.assertJobNotStopped.mockResolvedValue(undefined);
    mocks.planVersion.findUnique.mockResolvedValue({ id: "plan-1" });
  });

  afterEach(() => {
    consoleWarn.mockRestore();
    vi.useRealTimers();
  });

  /**
   * The wait budget spent, with the second wait entered on the far side of it.
   *
   * A pass enters the wait twice and the ceiling belongs to the *job*, so the
   * first wait can relay through owners for the whole of it, answer `expired`
   * at a poll a couple of seconds short, and hand a re-claim that comes back
   * `busy` to a second wait with nothing left. That is the state under test:
   * the lease is live throughout except for the single read that ends the first
   * wait, and every read after it carries a fresh token, so only the ceiling can
   * ever end this.
   */
  const spendTheJobsWaitBudget = (options: { onSecondClaim?: () => void } = {}) => {
    vi.useFakeTimers({ toFake: ["setTimeout", "Date"] });
    const ceilingAt = Date.now() + CHARACTER_REFERENCE_LEASE_MAX_WAIT_MS;
    const state = { claims: 0, gapTaken: false };
    mocks.queryRawUnsafe.mockImplementation(async (sql: string) => {
      if (isLeaseClaim(sql)) {
        // Somebody owns it every time this caller asks, so it only ever waits.
        state.claims += 1;
        if (state.claims === 2) {
          options.onSecondClaim?.();
        }
        return [];
      }
      // One dead reading, exactly at the ceiling, is what ends the first wait —
      // and another worker has taken the gap by the time anyone looks again, so
      // this caller walks away from a live render rather than from nobody.
      if (Date.now() >= ceilingAt && !state.gapTaken) {
        state.gapTaken = true;
        return [{ live: false, token: null }];
      }
      return [{ live: true, token: `owner-${Date.now()}` }];
    });
    return { ceilingAt, state };
  };

  it("names a wait it had no budget to enter, instead of a fifteen-minute wait it never made", async () => {
    // The failure this is written for: `deadline` was `Math.min(ceiling, startedAt
    // + WAIT_MS)`, which for a wait entered at the ceiling is `startedAt`, so
    // `while (Date.now() < deadline)` ran zero times — no stop check, no read,
    // no lease read — and the give-up path underneath wrote
    // `character_reference_lease_abandoned` with `waitedMs: 0` and `relays: 0`.
    // In the run log that is indistinguishable from a caller that genuinely
    // waited the whole fifteen minutes, and it is the reader's page that pays:
    // an empty sheet set attached while an owner is seconds into the cast.
    spendTheJobsWaitBudget();
    const pass = passWith(() => ({ answer: "no-sheets-yet", settled: false }));

    const running = runCharacterReferenceRenderPass(pass);
    await drain();
    await vi.advanceTimersByTimeAsync(CHARACTER_REFERENCE_LEASE_MAX_WAIT_MS + TWO_POLLS_MS);

    await expect(running).resolves.toEqual({ answer: "no-sheets-yet", outcome: "abandoned" });
    const lines = standDownLines();
    expect(lines.map((line) => line.reason)).not.toContain("lease_abandoned");
    expect(lines.at(-1)).toMatchObject({
      event: "character.reference.stand_down",
      reason: "wait_ceiling_reached",
      // And it says the expensive half out loud: somebody was rendering when we
      // walked away, which is a different fact from a cast nobody is finishing.
      ownerRendering: true,
      projectId: "project-1",
      planId: "plan-1"
    });
    expect(Number(lines.at(-1)?.waitedMs)).toBeGreaterThanOrEqual(CHARACTER_REFERENCE_LEASE_MAX_WAIT_MS);
  });

  it("takes an answer that landed while it was re-claiming, rather than standing down over it", async () => {
    // The other thing a zero-length loop skipped: its `pass.read`. The set the
    // whole wait was for can land in the seconds between the first wait ending
    // and the second being entered, and handing that back as `abandoned` — with
    // a stand-down in the run log explaining why this book has no sheets — is a
    // lie about a cast that is sitting right there.
    const settled = { after: 0 };
    const budget = spendTheJobsWaitBudget({
      onSecondClaim: () => {
        settled.after = 1;
      }
    });
    const pass = passWith(() => {
      // The re-claim's own read is still unsettled; the owner commits directly
      // behind it, which is the read the stand-down takes.
      if (settled.after > 0) {
        settled.after += 1;
      }
      return settled.after > 1 ? { answer: "the whole cast", settled: true } : { answer: "no-sheets-yet", settled: false };
    });

    const running = runCharacterReferenceRenderPass(pass);
    await drain();
    await vi.advanceTimersByTimeAsync(CHARACTER_REFERENCE_LEASE_MAX_WAIT_MS + TWO_POLLS_MS);

    await expect(running).resolves.toEqual({ answer: "the whole cast", outcome: "settled" });
    expect(standDownLines()).toEqual([]);
    expect(budget.state.claims).toBe(2);
  });

  it("ends at the ceiling for a reader who pressed Stop, rather than settling as a finished book", async () => {
    // The stop check is first in every poll tick and a zero-length loop has no
    // tick, so the one caller that reaches this path with the run already ended
    // used to hand its job an empty answer — `processJob` completing a book the
    // reader stopped, instead of settling it through `markStopped`.
    spendTheJobsWaitBudget({
      onSecondClaim: () => {
        mocks.assertJobNotStopped.mockRejectedValue(stopRequested());
      }
    });
    const pass = passWith(() => ({ answer: "no-sheets-yet", settled: false }));

    const running = runCharacterReferenceRenderPass(pass).then(
      () => "resolved",
      (error: unknown) => (error as Error).name
    );
    await drain();
    await vi.advanceTimersByTimeAsync(CHARACTER_REFERENCE_LEASE_MAX_WAIT_MS + TWO_POLLS_MS);

    await expect(running).resolves.toBe("StopRequestedError");
    expect(standDownLines()).toEqual([]);
  });

  /**
   * A plan version deleted *during* the render, which the claim's own answer
   * could not cover.
   *
   * An undo of a structural edit deletes the plan version it approved
   * (`packages/db/src/pageRestructureRevert.ts`) with this book's image jobs
   * still fanned out, and it is as free to land in the minutes a cast takes to
   * draw as in the milliseconds a claim takes.
   */
  const claimGrantedThenPlanDeleted = () => {
    const row: { plan: { id: string } | null } = { plan: { id: "plan-1" } };
    mocks.queryRawUnsafe.mockImplementation(async (sql: string) =>
      isLeaseClaim(sql) ? [{ characterReferenceLeaseExpiresAt: new Date(Date.now() + CHARACTER_REFERENCE_LEASE_MS) }] : []
    );
    mocks.planVersion.findUnique.mockImplementation(async () => row.plan);
    return row;
  };

  it("writes nothing when the plan version goes away while the cast is rendering", async () => {
    // The failure this is written for: only the claim asked. `pass.read` finds
    // no assets and `planVersion.findUnique` returns null, so `settled` is
    // false, the supersedes gate is skipped, and the commit created a full cast
    // of `ImageAsset` rows whose `metadata.planId` points at a deleted row —
    // there is no foreign key, so nothing objects — while the settlement beside
    // them `updateMany`s a row that is gone and matches nothing. A paid render,
    // rows no current read resolves, and the one pairing this transaction exists
    // to make atomic half-kept.
    const row = claimGrantedThenPlanDeleted();
    const pass = passWith(
      () => ({ answer: "the sheets that exist", settled: false }),
      () => {
        row.plan = null;
      }
    );

    await expect(runCharacterReferenceRenderPass(pass)).resolves.toEqual({
      answer: "the sheets that exist",
      outcome: "plan-version-gone"
    });
    expect(pass.render).toHaveBeenCalled();
    expect(pass.commit).not.toHaveBeenCalled();
    expect(pass.supersedes).not.toHaveBeenCalled();
    // And it is the *commit's* stand-down, not the claim's: only this one was
    // reached with a cast already rendered and paid for.
    expect(standDownLines().at(-1)).toMatchObject({
      event: "character.reference.stand_down",
      reason: "plan_version_gone_at_commit",
      planId: "plan-1"
    });
    // The lease is still let go, so nothing waits out a budget nobody is using.
    expect(mocks.executeRawUnsafe).toHaveBeenCalled();
  });

  it("commits as usual for a plan version that is still there", async () => {
    // The other side of the same question, so the assertion above cannot be
    // satisfied by refusing to commit at all.
    claimGrantedThenPlanDeleted();
    const pass = passWith(() => ({ answer: "the sheets that exist", settled: false }));

    await expect(runCharacterReferenceRenderPass(pass)).resolves.toEqual({ answer: "committed", outcome: "rendered" });
    expect(pass.commit).toHaveBeenCalled();
    expect(standDownLines()).toEqual([]);
  });

  it("waits for a pooled connection on both transactions rather than throwing a paid cast away", async () => {
    // Prisma's default `maxWait` is 2s, and the claim is what starves the pool:
    // it holds a pooled connection while it blocks on `pg_advisory_xact_lock`,
    // and a book's image fan-out can queue several of them behind one commit. A
    // `P2024` on the claim fails `generate-book` over a lock wait; a `P2024` on
    // the commit additionally discards a cast that is already rendered, paid for
    // and on disk, because nothing between here and the seven call sites catches
    // it. The split is what made that reachable — the old single transaction was
    // entered before the renders, so failing to get a connection cost nothing.
    claimGrantedThenPlanDeleted();
    const pass = passWith(() => ({ answer: "the sheets that exist", settled: false }));

    await runCharacterReferenceRenderPass(pass);

    const [claimOptions, commitOptions] = mocks.transaction.mock.calls.map(
      ([, options]) => options as { timeout: number; maxWait: number }
    );
    expect(claimOptions).toMatchObject({ maxWait: 10_000 });
    expect(commitOptions).toMatchObject({ maxWait: 10_000 });
    // And the documented relationship between the two budgets still holds: a
    // claim allowed less time than a commit is a claim that dies waiting on one
    // that has done nothing wrong.
    expect(claimOptions!.timeout).toBeGreaterThan(commitOptions!.timeout);
  });

  it("stamps and compares the lease in one clock, and it is not the transaction's", async () => {
    // `CURRENT_TIMESTAMP` is `transaction_timestamp()` in Postgres — the moment
    // the transaction began — and this transaction's first statement is a
    // blocking `pg_advisory_xact_lock`, so the whole lock wait was subtracted
    // from a render budget nobody had started using. Measured on the stack's own
    // Postgres 16: behind a four-second holder, `CURRENT_TIMESTAMP + 300s` is
    // 295.983s away, and a lease that had genuinely run out (`expires_at <=
    // clock_timestamp()`) still read as live to the claim's `<=
    // CURRENT_TIMESTAMP`, `UPDATE 0`. The mixed pair is the bug: `readRenderLease`
    // is its own statement, so the waiter reads real time, calls the lease
    // expired and re-claims — paying for a second full cast while the first
    // renderer is still working.
    claimGrantedThenPlanDeleted();
    mocks.queryRawUnsafe.mockImplementation(async (sql: string) =>
      isLeaseClaim(sql) ? [] : [{ live: true, token: "another-worker" }]
    );
    vi.useFakeTimers({ toFake: ["setTimeout", "Date"] });
    // Unsettled through the claim and the first poll — a tick that finds the
    // set settled answers before it ever looks at the lease — then settled, so
    // the wait ends having emitted one of each statement.
    const reads = [
      { answer: "no-sheets-yet", settled: false },
      { answer: "no-sheets-yet", settled: false },
      { answer: "the whole cast", settled: true }
    ];
    const pass = passWith(() => reads.shift() ?? { answer: "the whole cast", settled: true });

    const running = runCharacterReferenceRenderPass(pass);
    await drain();
    await vi.advanceTimersByTimeAsync(TWO_POLLS_MS);
    await running;

    const statements = mocks.queryRawUnsafe.mock.calls.map(([sql]) => String(sql));
    expect(statements.some(isLeaseClaim)).toBe(true);
    expect(statements.some((sql) => !isLeaseClaim(sql))).toBe(true);
    for (const sql of statements) {
      expect(sql).not.toContain("CURRENT_TIMESTAMP");
      expect(sql).toContain("clock_timestamp()");
    }
    // Both halves of the claim, not one of the two: the expiry it writes and the
    // expiry it judges the incumbent by have to mean the same instant.
    const claim = statements.find(isLeaseClaim) ?? "";
    expect(claim.match(/clock_timestamp\(\)/g)).toHaveLength(2);
  });
});
