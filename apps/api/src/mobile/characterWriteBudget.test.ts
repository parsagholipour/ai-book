import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@book-maker/db", async () => (await import("./testing/mobileApiMocks.js")).dbModuleMock());
vi.mock("@book-maker/db/billing", async () => (await import("./testing/mobileApiMocks.js")).billingModuleMock());
vi.mock("../queue.js", async () => (await import("./testing/mobileApiMocks.js")).queueModuleMock());
vi.mock("../projectStatus.js", async () => (await import("./testing/mobileApiMocks.js")).projectStatusModuleMock());

import {
  bearer,
  buildMobileApp,
  mockAccessTokens,
  mockPrisma,
  resetMobileHarness,
  teardownMobileHarness
} from "./testing/mobileApiHarness.js";
import {
  CHARACTER_MENTION_TRANSACTION_OPTIONS,
  CHARACTER_RETRY_FLOOR_MS,
  CHARACTER_WRITE_CLIENT_BUDGET_MS,
  characterRetryTransactionOptions
} from "./characterWriteConflicts.js";

/**
 * How long a character write is allowed to take, and who is still listening.
 *
 * Split from `characterWriteConflicts.test.ts`, which is about *what* a write
 * answers when a rename lands under it. This is the other axis of the same
 * module: `CHARACTER_MENTION_TRANSACTION_OPTIONS` is a lock window over up to
 * 99 sibling rows, `CHARACTER_WRITE_CLIENT_BUDGET_MS` is the wall clock the
 * whole request has to answer inside, and `characterRetryTransactionOptions`
 * rations the second against the first. The two stories share no assertion and
 * kept colliding in one file's size budget; what they do share are the record
 * factories below, which are small enough to spell twice and were only ever
 * fixtures.
 *
 * The thing every test here is really measuring is a **sum**: an answer written
 * after the app's 20 s receive timeout is an answer nobody reads, whatever its
 * status code says.
 */

function characterRecord(overrides: Record<string, unknown> = {}) {
  return {
    id: "char-1",
    userId: "user-a",
    name: "Luna",
    description: "A brave night-flying rabbit.",
    fields: [],
    photoPath: null,
    photoKind: null,
    suggestedDescription: null,
    appearance: null,
    portraitPath: null,
    portraitSource: null,
    portraitStatus: "NONE",
    portraitError: null,
    portraitJobId: null,
    createdAt: new Date("2026-08-01T10:00:00.000Z"),
    updatedAt: new Date("2026-08-01T10:00:00.000Z"),
    outgoingMentions: [],
    ...overrides
  };
}

/** A source description that mentions Bram, as `rewriteIncoming`/`unlinkIncoming` read it. */
const mentioningSource = (description = "Friends with @Bram.") => [
  {
    sourceCharacter: {
      id: "char-1",
      userId: "user-a",
      name: "Mina",
      description,
      outgoingMentions: [
        { targetKind: "CHARACTER", targetCharacter: { id: "char-2", name: "Bram" } }
      ]
    }
  }
];

const bramRecord = () => characterRecord({ id: "char-2", name: "Bram" });

function findCharactersById(rows: Array<{ id: string }>) {
  const byId = new Map(rows.map((row) => [row.id, row]));
  mockPrisma.libraryCharacter.findFirst.mockImplementation(
    async ({ where }: { where: { id?: string } }) => (where.id ? (byId.get(where.id) ?? null) : null)
  );
}

describe("what a character write has left of the client budget", () => {
  beforeEach(() => {
    resetMobileHarness();
    mockAccessTokens({ "token-a": "user-a" });
    mockPrisma.libraryCharacter.updateMany.mockResolvedValue({ count: 1 });
    mockPrisma.libraryCharacter.deleteMany.mockResolvedValue({ count: 1 });
  });
  afterEach(teardownMobileHarness);

  it("gives both mention-rewriting transactions a ceiling of their own", async () => {
    // Up to 99 characters can mention one target, and the whole set costs three
    // statements plus a write per row that moved — inside 10 s with room to
    // spare, and still well outside Prisma's 5 s default, which aborts a rename
    // nothing is wrong with midway, with a code no catch here recognised. The
    // top of the range is not the loop any more, it is the reader: the app stops
    // listening at 20 s, so `maxWait + timeout` past that answers nobody.
    findCharactersById([bramRecord(), mentioningSource()[0]!.sourceCharacter]);
    mockPrisma.libraryMention.findMany.mockResolvedValue(mentioningSource());
    mockPrisma.libraryCharacter.update.mockImplementation(
      async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) =>
        characterRecord({ id: where.id, ...data })
    );

    const app = await buildMobileApp();
    for (const request of [
      { method: "PATCH" as const, payload: { name: "Bramwell" } },
      { method: "DELETE" as const }
    ]) {
      mockPrisma.$transaction.mockClear();
      const response = await app.inject({
        url: "/api/mobile/characters/char-2",
        headers: bearer("token-a"),
        ...request
      });
      expect(response.statusCode).toBe(200);
      expect(mockPrisma.$transaction.mock.calls[0]![1]).toEqual({ timeout: 10_000, maxWait: 5_000 });
    }
    await app.close();
  });

  it("keeps both of the delete's attempts inside one client budget", async () => {
    // The ceiling above is a statement about one transaction, and the delete is
    // not one: a lost portrait claim buys a second full window with a pool
    // acquisition wedged between them, so the worst case was 5 + 10 twice — 30 s
    // behind a 20 s receive timeout. That is not a slow path, it is a silent
    // one: the second window is only ever *spent* under the pressure that makes
    // `CHARACTER_EDIT_BUSY` the right answer, and it was written after the
    // device had already given up and shown a bare network error instead.
    // 2 s is held back for the reply and for the liveness question between the
    // attempts, which takes a pool connection of its own. The range stops where
    // the floor starts, and the test below owns the other side of that line —
    // where there is no longer enough budget to open a transaction that can
    // commit, and the answer is no window at all rather than a wider one.
    for (const elapsed of [0, 3_000, 8_000, 12_000, 13_500]) {
      const retry = characterRetryTransactionOptions(elapsed);
      if (!retry) throw new Error(`no window at ${elapsed}ms`);
      expect(elapsed + retry.maxWait + retry.timeout).toBeLessThanOrEqual(CHARACTER_WRITE_CLIENT_BUDGET_MS - 2_000);
      // The ceiling's own 1:2 split survives the shrinking, because a retry
      // that spent two thirds of a short window queueing has answered nothing.
      expect(retry.timeout).toBeGreaterThanOrEqual(retry.maxWait);
    }
    // A first attempt that lost its claim in milliseconds costs the retry
    // nothing — it is the attempt that unlinks up to 99 descriptions, and a
    // halved constant would take that window away from it in every case.
    expect(characterRetryTransactionOptions(0)).toEqual(CHARACTER_MENTION_TRANSACTION_OPTIONS);
  });

  it("floors the shrinking transaction, not the window it is cut from", async () => {
    // The floor is what the claim and the unlink of up to 99 descriptions need
    // to commit, and all of that runs *inside* the transaction — so the number
    // that has to clear it is `timeout`, never `maxWait + timeout`. Held
    // against the pair, the 1:2 split spent a third of the floor on queueing
    // before the transaction opened: a lane at 15 s got 1 s of queue and 2 s of
    // work under a constant promising 3, so the delete's second attempt — the
    // one that actually claims the row and unlinks — P2028'd under exactly the
    // pressure the floor was written for and answered a 503 no reader can act on.
    for (const elapsed of [12_000, 13_000, 13_500]) {
      const retry = characterRetryTransactionOptions(elapsed);
      if (!retry) throw new Error(`no window at ${elapsed}ms`);
      expect(retry.timeout).toBeGreaterThanOrEqual(CHARACTER_RETRY_FLOOR_MS);
      // With a queue still in front of it: a `maxWait` of zero answers a busy
      // pool with `P2024`, which is neither of the shapes the route catches and
      // would come back as a raw 500 instead of the retryable answer.
      expect(retry.maxWait).toBeGreaterThan(0);
      expect(retry.timeout).toBeGreaterThanOrEqual(retry.maxWait);
    }
  });

  it("hands out no window at all once the budget cannot fund the floor", async () => {
    // The floor used to be a clamp, and a clamp is the one arithmetic that can
    // put the lane back over the budget every other case here holds: a first
    // attempt that spent its full 15 s leaves 3 s, floored to 4.5 s, so the
    // delete answered at ~19.5 s plus the liveness read — past the 18 s the
    // reserve was sized to leave and at or over the app's 20 s receive timeout.
    // Both halves of the trade were being paid: a window too small to commit
    // in, *and* a `CHARACTER_EDIT_BUSY` written to a device that had already
    // shown a bare network error. So it refuses instead, and the route answers
    // that same 503 while there is still someone to read it.
    for (const elapsed of [15_000, 16_000, 18_000, 60_000]) {
      expect(characterRetryTransactionOptions(elapsed)).toBeNull();
    }
    // Which makes the bound inductive rather than approximate: every window it
    // does hand out is what is left or less, so no attempt of either lane can
    // put `elapsed + window` past the budget.
    for (const elapsed of [0, 4_000, 9_000, 13_000, 13_499, 13_500]) {
      const window = characterRetryTransactionOptions(elapsed);
      if (!window) continue;
      expect(elapsed + window.maxWait + window.timeout).toBeLessThanOrEqual(
        CHARACTER_WRITE_CLIENT_BUDGET_MS - 2_000
      );
    }
  });

  it("hands the delete's retry what its first attempt left rather than a fresh window", async () => {
    const drawing = characterRecord({
      id: "char-2",
      name: "Bram",
      portraitStatus: "QUEUED",
      portraitJobId: "job-1"
    });
    findCharactersById([drawing, mentioningSource()[0]!.sourceCharacter]);
    mockPrisma.libraryMention.findMany.mockResolvedValue(mentioningSource());
    mockPrisma.libraryCharacter.update.mockImplementation(
      async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) =>
        characterRecord({ id: where.id, ...data })
    );
    // The claim behind a dead worker: the row still says QUEUED, so the guarded
    // claim loses, and the job it names settled without ever resetting it.
    mockPrisma.generationJob.findUnique.mockResolvedValue({ status: "FAILED" });
    const realNow = Date.now;
    mockPrisma.libraryCharacter.updateMany.mockImplementationOnce(async () => {
      // That first claim did not fail fast: it sat on the row lock of a write
      // that had it first, which is the case the doubled window was hiding.
      Date.now = () => realNow() + 12_000;
      return { count: 0 };
    });

    const app = await buildMobileApp();
    try {
      const response = await app.inject({
        method: "DELETE",
        url: "/api/mobile/characters/char-2",
        headers: bearer("token-a")
      });
      expect(response.statusCode).toBe(200);
    } finally {
      Date.now = realNow;
    }

    const [first, retry] = mockPrisma.$transaction.mock.calls.map((call: any[]) => call[1]);
    // The first attempt is sized against elapsed too, but its pre-attempt reads
    // were instant here, so an elapsed of ~0 hands it the whole ceiling — the
    // next test is the one that makes those reads cost something.
    expect(first).toEqual(CHARACTER_MENTION_TRANSACTION_OPTIONS);
    // 12 s gone and 2 s held back leaves 6 s, not another 15.
    expect(retry.maxWait + retry.timeout).toBeLessThanOrEqual(6_000);
    expect(retry.maxWait + retry.timeout).toBeGreaterThan(4_000);
    await app.close();
  });

  it("sizes the delete's first attempt from what its pre-attempt reads left of the budget", async () => {
    // DELETE reads twice before its first transaction — the session lookup and
    // `ownedCharacter`, one fewer than PATCH — and each is a pool acquisition
    // under the pressure this budget is sized for. The retained file names are
    // read under the claim, so they are charged to the window rather than to the
    // clock in front of it. The first attempt is the one that unlinks up to 99
    // descriptions, so it keeps the whole ceiling when those two reads are cheap;
    // when they are not, its window comes out of the same 20 s, or the
    // `CHARACTER_EDIT_BUSY` that ceiling leaves room for is written past it —
    // the delete's copy of the per-request budget the PATCH test below owns.
    const bram = bramRecord(); // portraitStatus NONE → the guarded claim wins first try
    findCharactersById([bram, mentioningSource()[0]!.sourceCharacter]);
    mockPrisma.libraryMention.findMany.mockResolvedValue(mentioningSource());
    const realNow = Date.now;
    // `ownedCharacter`'s read queued for a pool connection behind everything else
    // this account is writing, and that time is gone before the first claim opens.
    mockPrisma.libraryCharacter.findFirst.mockImplementationOnce(async () => {
      Date.now = () => realNow() + 7_000;
      return bram;
    });

    const app = await buildMobileApp();
    try {
      const response = await app.inject({
        method: "DELETE",
        url: "/api/mobile/characters/char-2",
        headers: bearer("token-a")
      });
      expect(response.statusCode).toBe(200);
    } finally {
      Date.now = realNow;
    }

    const first = mockPrisma.$transaction.mock.calls[0]![1] as { maxWait: number; timeout: number };
    expect(first).not.toEqual(CHARACTER_MENTION_TRANSACTION_OPTIONS);
    // 7 s gone and 2 s held back for the reply and the liveness question leaves 11.
    expect(7_000 + first.maxWait + first.timeout).toBeLessThanOrEqual(CHARACTER_WRITE_CLIENT_BUDGET_MS - 2_000);
    await app.close();
  });

  it("answers the patch's 503 itself rather than opening a window under the floor", async () => {
    // The null above is a value until a route acts on it, and all three call
    // sites were pinned by nothing: every test here reads
    // `characterRetryTransactionOptions` directly, and the largest elapsed any
    // of them drove through a route was 13 s — under the 13.5 s cliff, so the
    // guards could all be traded back for the clamp they replaced and stay
    // green. What the guard has to produce is this exact pair: the 503 the
    // window would have produced anyway, and **no transaction at all**, because
    // the alternative is up to 99 sibling row locks held open for a claim and a
    // rewrite that cannot commit inside what is left.
    findCharactersById([bramRecord(), mentioningSource()[0]!.sourceCharacter]);
    mockPrisma.libraryMention.findMany.mockResolvedValue(mentioningSource());
    const realNow = Date.now;
    // The claim subject read queued 17 s behind everything else this account is
    // writing, which leaves 1 s of the budget — less than the floor plus its
    // queue, so there is no window to open.
    mockPrisma.libraryCharacter.findFirst.mockImplementationOnce(async () => {
      Date.now = () => realNow() + 17_000;
      return bramRecord();
    });

    const app = await buildMobileApp();
    try {
      const response = await app.inject({
        method: "PATCH",
        url: "/api/mobile/characters/char-2",
        headers: bearer("token-a"),
        payload: { name: "Bramwell" }
      });
      expect(response.statusCode).toBe(503);
      expect(response.json().error.code).toBe("CHARACTER_EDIT_BUSY");
    } finally {
      Date.now = realNow;
    }

    expect(mockPrisma.$transaction).not.toHaveBeenCalled();
    await app.close();
  });

  it("answers the delete's 503 before its first attempt, not from inside one", async () => {
    // Same guard, the other lane, and the one with *fewer* reads in front of
    // it: the delete's session lookup and `ownedCharacter` against the patch's
    // session lookup and the `Promise.all` pair above, so it is the patch that
    // spends more of the client budget before the guard is asked. Neither lane
    // gets to the cliff on its own reads here — the same 17 s drives both. What
    // earns this one a test of its own is what the guard refuses on it: the
    // attempt that unlinks up to 99 descriptions, which is exactly why it may
    // not be opened on a window too small to commit in.
    findCharactersById([bramRecord(), mentioningSource()[0]!.sourceCharacter]);
    mockPrisma.libraryMention.findMany.mockResolvedValue(mentioningSource());
    const realNow = Date.now;
    mockPrisma.libraryCharacter.findFirst.mockImplementationOnce(async () => {
      Date.now = () => realNow() + 17_000;
      return bramRecord();
    });

    const app = await buildMobileApp();
    try {
      const response = await app.inject({
        method: "DELETE",
        url: "/api/mobile/characters/char-2",
        headers: bearer("token-a")
      });
      expect(response.statusCode).toBe(503);
      expect(response.json().error.code).toBe("CHARACTER_EDIT_BUSY");
    } finally {
      Date.now = realNow;
    }

    expect(mockPrisma.$transaction).not.toHaveBeenCalled();
    await app.close();
  });

  it("stops the delete's retry at one attempt when the first spent the budget", async () => {
    // The case the floor's clamp used to overrun, driven through the route that
    // meets it: a first attempt that sat on a row lock for 17 s leaves 1 s, and
    // the clamp widened that back to 4.5 s — a window too small for the claim
    // and the unlink to commit in, *and* a `CHARACTER_EDIT_BUSY` written at
    // ~19.5 s plus the liveness read, to a device that stopped listening at 20.
    // So the retry is refused where it stands: one transaction opened, not two.
    const drawing = characterRecord({
      id: "char-2",
      name: "Bram",
      portraitStatus: "QUEUED",
      portraitJobId: "job-1"
    });
    findCharactersById([drawing, mentioningSource()[0]!.sourceCharacter]);
    mockPrisma.libraryMention.findMany.mockResolvedValue(mentioningSource());
    // The claim behind a dead worker, as the test above: the row still says
    // QUEUED, so the guarded claim loses and the retry is the lane that would
    // drop the guard and take the character out.
    mockPrisma.generationJob.findUnique.mockResolvedValue({ status: "FAILED" });
    const realNow = Date.now;
    mockPrisma.libraryCharacter.updateMany.mockImplementationOnce(async () => {
      Date.now = () => realNow() + 17_000;
      return { count: 0 };
    });

    const app = await buildMobileApp();
    try {
      const response = await app.inject({
        method: "DELETE",
        url: "/api/mobile/characters/char-2",
        headers: bearer("token-a")
      });
      expect(response.statusCode).toBe(503);
      expect(response.json().error.code).toBe("CHARACTER_EDIT_BUSY");
    } finally {
      Date.now = realNow;
    }

    expect(mockPrisma.$transaction).toHaveBeenCalledTimes(1);
    await app.close();
  });

  it("sizes the patch's transaction from what its own reads left of the budget", async () => {
    // PATCH opens one transaction, but never before two pool acquisitions of
    // its own: `characterClaimSubject`, then the copyright flag — which is read
    // out there precisely so it is not read while the transaction holds up to
    // 99 sibling row locks. Under pool pressure that is where the budget goes,
    // and the window opened after them was still the whole 15 s ceiling: the
    // `CHARACTER_EDIT_BUSY` that ceiling leaves room for was written past 20 s,
    // to a device that had already given up and shown a bare network error.
    findCharactersById([bramRecord(), mentioningSource()[0]!.sourceCharacter]);
    mockPrisma.libraryMention.findMany.mockResolvedValue(mentioningSource());
    mockPrisma.libraryCharacter.update.mockImplementation(
      async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) =>
        characterRecord({ id: where.id, ...data })
    );
    const realNow = Date.now;
    // The claim subject read did not come back fast: it queued for a pool
    // connection behind everything else this account is writing.
    mockPrisma.libraryCharacter.findFirst.mockImplementationOnce(async () => {
      Date.now = () => realNow() + 13_000;
      return bramRecord();
    });

    const app = await buildMobileApp();
    try {
      const response = await app.inject({
        method: "PATCH",
        url: "/api/mobile/characters/char-2",
        headers: bearer("token-a"),
        payload: { name: "Bramwell" }
      });
      expect(response.statusCode).toBe(200);
    } finally {
      Date.now = realNow;
    }

    const options = mockPrisma.$transaction.mock.calls[0]![1] as { maxWait: number; timeout: number };
    expect(options).not.toEqual(CHARACTER_MENTION_TRANSACTION_OPTIONS);
    // 13 s gone and 2 s held back for the reply leaves 5, not another 15.
    expect(13_000 + options.maxWait + options.timeout).toBeLessThanOrEqual(CHARACTER_WRITE_CLIENT_BUDGET_MS - 2_000);
    await app.close();
  });
});
