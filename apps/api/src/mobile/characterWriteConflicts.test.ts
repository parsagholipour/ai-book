import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@book-maker/db", async () => (await import("./testing/mobileApiMocks.js")).dbModuleMock());
vi.mock("@book-maker/db/billing", async () => (await import("./testing/mobileApiMocks.js")).billingModuleMock());
vi.mock("../queue.js", async () => (await import("./testing/mobileApiMocks.js")).queueModuleMock());
vi.mock("../projectStatus.js", async () => (await import("./testing/mobileApiMocks.js")).projectStatusModuleMock());

import {
  bearer,
  buildMobileApp,
  mockAccessTokens,
  MockPrismaKnownRequestError,
  mockPrisma,
  resetMobileHarness,
  teardownMobileHarness
} from "./testing/mobileApiHarness.js";
import { LibraryMentionError } from "./httpErrors.js";
import { LibraryMentionError as reExportedMentionError } from "./libraryMentionRewrites.js";

/**
 * The two character write paths under concurrency.
 *
 * `PATCH /:id` and `DELETE /:id` read the row before their transaction opens
 * and then rewrite *other* characters' descriptions from what they read, so a
 * rename landing in that window is the whole subject of this file: the token
 * work has to be driven by what the transaction found, and whatever collision
 * survives that has to come back as something the app can retry.
 *
 * Its own suite because `characters.test.ts` is at its size budget, and because
 * these are all one story — the one `characterWriteConflicts.ts` tells about
 * *what* a write answers. How long it is allowed to take and who is still
 * listening when it answers belongs to
 * `characterWriteBudget.test.ts`: no assertion is shared between them, and the
 * record factories are.
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

/** The `where` of the row claim, which is where the staleness guard lives. */
const claimGuard = () => mockPrisma.libraryCharacter.updateMany.mock.calls[0]![0].where as Record<string, unknown>;

/**
 * The one statement that rewrites the descriptions naming this character: a set
 * update over the whole claimed set (`UPDATE "LibraryCharacter" … FROM
 * unnest(…)`) rather than a `libraryCharacter.update` per row, so it is on no
 * model mock. It is a write, so it is the lane\'s only `$executeRaw` — the
 * target lock and the row claim are reads and stay on `$queryRaw` — and the
 * verb in front of the table separates it from them in any shared list.
 */
const SIBLING_REWRITE = 'UPDATE "LibraryCharacter"';

/** Every issue of that statement, oldest first — empty when the lane never reached it. */
const rewriteStatements = () =>
  (mockPrisma.$executeRaw.mock.calls as unknown[][]).filter((call) =>
    (call[0] as readonly string[]).join("?").includes(SIBLING_REWRITE)
  );

/** The `(id, description)` pairs the last one carried, off its two bound arrays. */
function rewrittenDescriptions(): Array<{ id: string; description: string }> {
  type Issued = [readonly string[], Date, string[], string[]];
  const [, , ids = [], descriptions = []] = (rewriteStatements().at(-1) ?? []) as Issued;
  return ids.map((id, index) => ({ id, description: descriptions[index] ?? "" }));
}

/**
 * Fails the sibling rewrite and nothing else.
 *
 * It used to have to pick the statement out of a shared `$queryRaw`: the lock,
 * the claim and the rewrite were all on that one mock, and rejecting it
 * outright settled the request at the target lock — before the statement these
 * tests are about ever ran. The rewrite is the lane\'s only `$executeRaw`,
 * being its only raw *write*, so the mock can simply refuse.
 */
function failSiblingRewrite(failure: unknown): void {
  mockPrisma.$executeRaw.mockRejectedValue(failure);
}

/**
 * A deadlock in every shape this ladder can be handed one in — and two of the
 * three are shapes only because of *which statement* raised it.
 *
 * Measured against `@prisma/client` 7.8 with `@prisma/adapter-pg`: a **model**
 * write hands `40P01` to a kind→code map with no entry for a plain `postgres`
 * error, so the bare `DriverAdapterError` is rethrown — no `code`, Postgres\'
 * own sentence as the message, the SQLSTATE only under `cause`. A **raw**
 * statement is wrapped instead, as `Raw query failed. Code: \`40P01\`. Message:
 * \`deadlock detected\`` on code `P2010` — Prisma naming the *wrapper* rather
 * than the failure, which is why `P2010` is no use to the predicate and the
 * SQLSTATE in the message is. `P2034` is what it raises for the conflicts it
 * does model. The sibling rewrite moved from the first shape to the second when
 * it became one statement, so both are pinned: a net woven to one wrapper
 * answers 500 through the other.
 */
const deadlockShapes = () => [
  // What Prisma raises for the write conflicts it models.
  new MockPrismaKnownRequestError("Transaction failed due to a write conflict or a deadlock", { code: "P2034" }),
  // A model write\'s: the driver error itself, no `code`, the SQLSTATE under
  // `cause` and Postgres\' sentence as the message.
  Object.assign(new Error("deadlock detected"), {
    name: "DriverAdapterError",
    cause: { kind: "postgres", code: "40P01", originalCode: "40P01", originalMessage: "deadlock detected" }
  }),
  // A raw statement\'s, which is the shape the sibling rewrite now raises.
  new MockPrismaKnownRequestError("Raw query failed. Code: `40P01`. Message: `deadlock detected`", {
    code: "P2010",
    meta: {
      driverAdapterError: {
        cause: { kind: "postgres", originalCode: "40P01", originalMessage: "deadlock detected" }
      }
    }
  })
];

const uniqueViolation = (meta: { modelName: string; target: string[] }) =>
  Object.assign(new MockPrismaKnownRequestError("Unique constraint failed", { code: "P2002" }), { meta });

/** The create these suites fail one statement of: Luna, saved with an `@Bram` in her description. */
function mockCreateKnowingBram(): void {
  mockPrisma.libraryCharacter.count.mockResolvedValue(0);
  mockPrisma.libraryCharacter.create.mockResolvedValue(characterRecord({ description: "Knows @Bram." }));
  mockPrisma.libraryCharacter.findMany.mockResolvedValue([bramRecord()]);
}

async function createKnowingBram() {
  const app = await buildMobileApp();
  const payload = { name: "Luna", description: "Knows @Bram.", mentionedCharacterIds: ["char-2"] };
  const url = "/api/mobile/characters";
  const response = await app.inject({ method: "POST", url, headers: bearer("token-a"), payload });
  await app.close();
  return response;
}

describe("character writes under a concurrent rename", () => {
  beforeEach(() => {
    resetMobileHarness();
    mockAccessTokens({ "token-a": "user-a" });
    mockPrisma.libraryCharacter.updateMany.mockResolvedValue({ count: 1 });
    mockPrisma.libraryCharacter.deleteMany.mockResolvedValue({ count: 1 });
  });
  afterEach(teardownMobileHarness);

  it("refuses a delete whose row was renamed, rather than stripping the name it read", async () => {
    // Device 1 renamed Bram to Bramwell and rewrote every `@Bram` to
    // `@Bramwell`. Device 2's delete was built against `Bram`, and stripping
    // that token now matches nothing — after which the cascade takes the
    // mention rows, and `@Bramwell` is stranded in prose with nothing behind it.
    mockPrisma.libraryCharacter.findFirst
      .mockResolvedValueOnce(characterRecord({ id: "char-2", name: "Bram" }))
      .mockResolvedValue(characterRecord({ id: "char-2", name: "Bramwell" }));
    mockPrisma.libraryCharacter.updateMany.mockResolvedValue({ count: 0 });
    mockPrisma.libraryMention.findMany.mockResolvedValue(mentioningSource());

    const app = await buildMobileApp();
    const response = await app.inject({
      method: "DELETE",
      url: "/api/mobile/characters/char-2",
      headers: bearer("token-a")
    });

    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe("CHARACTER_EDIT_CONFLICT");
    // The claim named the name the request was built from, and losing it is
    // what stopped everything downstream.
    expect(claimGuard()).toMatchObject({ id: "char-2", name: "Bram" });
    // A delete writes no row of its own, so the sibling rewrite is the lane's
    // only description write — and it is a raw statement now, not a model call.
    expect(rewrittenDescriptions()).toEqual([]);
    expect(mockPrisma.libraryCharacter.deleteMany).not.toHaveBeenCalled();
    await app.close();
  });

  it("refuses a patch whose row was renamed, rather than rewriting the name it read", async () => {
    mockPrisma.libraryCharacter.findFirst.mockResolvedValue(characterRecord({ id: "char-2", name: "Bram" }));
    mockPrisma.libraryCharacter.updateMany.mockResolvedValue({ count: 0 });
    mockPrisma.libraryMention.findMany.mockResolvedValue(mentioningSource());

    const app = await buildMobileApp();
    const response = await app.inject({
      method: "PATCH",
      url: "/api/mobile/characters/char-2",
      headers: bearer("token-a"),
      payload: { name: "Bramble" }
    });

    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe("CHARACTER_EDIT_CONFLICT");
    expect(claimGuard()).toMatchObject({ id: "char-2", name: "Bram" });
    // No incoming description was read, let alone rewritten: the claim is the
    // first statement of the transaction, ahead of every sibling write. The
    // model mock is the route's own row here; the siblings are the raw one.
    expect(mockPrisma.libraryMention.findMany).not.toHaveBeenCalled();
    expect(mockPrisma.libraryCharacter.update).not.toHaveBeenCalled();
    expect(rewrittenDescriptions()).toEqual([]);
    await app.close();
  });

  it("answers a deadlocked transaction with a retryable conflict, not a 500", async () => {
    // Two renames of mutually mentioning characters can still meet head-on:
    // each writes the other's description. Postgres aborts one with 40P01,
    // which is neither a mention error nor a P2002 — it used to fall out of the
    // catch as a raw 500 for an edit that is valid and worth re-sending.
    for (const failure of deadlockShapes()) {
      for (const request of [
        { method: "PATCH" as const, payload: { name: "Bramwell" } },
        { method: "DELETE" as const }
      ]) {
        resetMobileHarness();
        mockAccessTokens({ "token-a": "user-a" });
        mockPrisma.libraryCharacter.updateMany.mockResolvedValue({ count: 1 });
        findCharactersById([bramRecord(), mentioningSource()[0]!.sourceCharacter]);
        mockPrisma.libraryMention.findMany.mockResolvedValue(mentioningSource());
        // The sibling description write is where the two transactions cross.
        failSiblingRewrite(failure);

        const app = await buildMobileApp();
        const response = await app.inject({
          url: "/api/mobile/characters/char-2",
          headers: bearer("token-a"),
          ...request
        });

        expect(response.statusCode).toBe(409);
        expect(response.json().error.code).toBe("CHARACTER_EDIT_CONFLICT");
        // Raised by the statement it is about: a lane that never reached the
        // rewrite would answer 409 for another reason and pin nothing.
        expect(rewriteStatements().length).toBeGreaterThan(0);
        await app.close();
      }
    }
  });

  it("answers a create off the same ladder its siblings answer", async () => {
    // Three catches spelling out one list is three lists, and they had drifted
    // in every direction three copies allow: create knew about the timeout and
    // not the conflict, delete about neither the refusal nor the mention
    // errors, and only patch asked whether its `P2002` really named the
    // library's own unique. So a create whose link set deadlocked, or collided
    // on the mention primary key, fell out as a raw 500 for a character the
    // reader typed correctly. The rung that matters next is the mention one:
    // LOCATION and OTHER share `LibraryMention` with the cast, and a refusal
    // added to one catch would have answered 500 from the other two.
    for (const failure of [
      ...deadlockShapes(),
      uniqueViolation({ modelName: "LibraryMention", target: ["sourceCharacterId", "targetKind", "targetId"] })
    ]) {
      resetMobileHarness();
      mockAccessTokens({ "token-a": "user-a" });
      mockCreateKnowingBram();
      // The link set is the one statement a create shares with its siblings.
      mockPrisma.libraryMention.createMany.mockRejectedValue(failure);

      const response = await createKnowingBram();

      expect(response.statusCode).toBe(409);
      expect(response.json().error.code).toBe("CHARACTER_EDIT_CONFLICT");
    }
  });

  it("tells a mention-key collision apart from a name that is genuinely taken", async () => {
    const bram = characterRecord({ id: "char-2", name: "Bram" });
    mockPrisma.libraryCharacter.findFirst.mockResolvedValue(characterRecord());
    mockPrisma.libraryCharacter.findMany.mockResolvedValue([bram]);
    // `replaceLibraryMentions` deletes and recreates the link set, and the
    // loser of two same-character patches deletes nothing and then collides on
    // [sourceCharacterId, targetKind, targetId]. The reader changed no name.
    mockPrisma.libraryMention.createMany.mockRejectedValue(
      uniqueViolation({ modelName: "LibraryMention", target: ["sourceCharacterId", "targetKind", "targetId"] })
    );

    const app = await buildMobileApp();
    const mentionRace = await app.inject({
      method: "PATCH",
      url: "/api/mobile/characters/char-1",
      headers: bearer("token-a"),
      payload: { description: "Knows @Bram.", mentionedCharacterIds: ["char-2"] }
    });
    expect(mentionRace.statusCode).toBe(409);
    expect(mentionRace.json().error.code).toBe("CHARACTER_EDIT_CONFLICT");

    // The library's own [userId, name] still speaks for itself.
    mockPrisma.libraryCharacter.update.mockRejectedValue(
      uniqueViolation({ modelName: "LibraryCharacter", target: ["userId", "name"] })
    );
    const nameTaken = await app.inject({
      method: "PATCH",
      url: "/api/mobile/characters/char-1",
      headers: bearer("token-a"),
      payload: { name: "Bram" }
    });
    expect(nameTaken.statusCode).toBe(409);
    expect(nameTaken.json().error.code).toBe("CHARACTER_NAME_TAKEN");
    await app.close();
  });

  it("strips a mentioning character from the description the claim found", async () => {
    // Device 1 saved "She loves tea." onto Mina while device 2's delete of
    // Bram was in flight. Rewriting the mention-list snapshot would drop the
    // tea sentence; the source claim re-reads Mina under the lock.
    const stale = mentioningSource()[0]!.sourceCharacter;
    const live = mentioningSource("Friends with @Bram. She loves tea.")[0]!.sourceCharacter;
    // The re-read is the mention query taken a second time under the claim, so
    // the live prose arrives there. `findFirst` is left holding the stale row on
    // purpose: nothing may read a source one at a time again.
    findCharactersById([bramRecord(), stale]);
    mockPrisma.libraryMention.findMany
      .mockResolvedValueOnce([{ sourceCharacter: stale }])
      .mockResolvedValue([{ sourceCharacter: live }]);
    mockPrisma.libraryCharacter.deleteMany.mockResolvedValue({ count: 1 });

    const app = await buildMobileApp();
    const response = await app.inject({
      method: "DELETE",
      url: "/api/mobile/characters/char-2",
      headers: bearer("token-a")
    });

    expect(response.statusCode).toBe(200);
    expect(rewrittenDescriptions()).toEqual([
      { id: "char-1", description: "Friends with Bram. She loves tea." }
    ]);
    await app.close();
  });

  it("writes the description the claim found, not the one the request was built from", async () => {
    // Device A sent a mention-set change and nothing else, so the description
    // it writes back is whichever one it read. Device B's description save
    // commits in between, and the claim does not notice: it asserts the name,
    // and no name moved. Driven from the outer snapshot, B's sentence is gone.
    const stale = characterRecord({ description: "Knows @Bram." });
    const live = characterRecord({ description: "Knows @Bram. She loves tea." });
    // The owner check takes no include; a read that carries one is a read taken
    // inside the transaction, under the claim.
    mockPrisma.libraryCharacter.findFirst.mockImplementation(async ({ include }: { include?: unknown }) =>
      include ? live : stale
    );
    mockPrisma.libraryCharacter.findMany.mockResolvedValue([bramRecord()]);
    mockPrisma.libraryCharacter.update.mockImplementation(
      async ({ data }: { data: Record<string, unknown> }) => characterRecord(data)
    );

    const app = await buildMobileApp();
    const response = await app.inject({
      method: "PATCH",
      url: "/api/mobile/characters/char-1",
      headers: bearer("token-a"),
      payload: { mentionedCharacterIds: ["char-2"] }
    });

    expect(response.statusCode).toBe(200);
    expect(mockPrisma.libraryCharacter.update).toHaveBeenCalledWith({
      where: { id: "char-1" },
      data: { description: "Knows @Bram. She loves tea." }
    });
    await app.close();
  });

  it("derives the surviving links from the row the claim found", async () => {
    // The other half of the same read. An old client sends prose and no link
    // set, so which links survive is computed from the ones the row holds — and
    // the snapshot held none. Answered from it, "nothing survived" is written
    // as an empty link set over an `@Bram` still sitting in the prose.
    const stale = characterRecord({ description: "Knows Bram." });
    const live = characterRecord({
      description: "Knows @Bram.",
      // The kind is what makes this row a character to `libraryMentionRefs`,
      // and `libraryMentionInclude` always selects it — a fixture that leaves
      // it out is not a row this read can return. Without it the surviving-link
      // set is empty and this test passes for the wrong reason.
      outgoingMentions: [
        { targetKind: "CHARACTER", targetCharacterId: "char-2", targetCharacter: { id: "char-2", name: "Bram" } }
      ]
    });
    mockPrisma.libraryCharacter.findFirst.mockImplementation(async ({ include }: { include?: unknown }) =>
      include ? live : stale
    );
    mockPrisma.libraryCharacter.findMany.mockResolvedValue([bramRecord()]);
    mockPrisma.libraryCharacter.update.mockImplementation(
      async ({ data }: { data: Record<string, unknown> }) => characterRecord(data)
    );

    const app = await buildMobileApp();
    const response = await app.inject({
      method: "PATCH",
      url: "/api/mobile/characters/char-1",
      headers: bearer("token-a"),
      payload: { description: "Still knows @bram." }
    });

    expect(response.statusCode).toBe(200);
    expect(mockPrisma.libraryMention.createMany).toHaveBeenCalledWith({
      data: [
        {
          sourceCharacterId: "char-1",
          targetKind: "CHARACTER",
          targetId: "char-2",
          targetCharacterId: "char-2",
          otherType: null,
          sortOrder: 0
        }
      ]
    });
    await app.close();
  });

  it("answers a transaction that ran out of time with a 503, not a raw 500", async () => {
    // `P2028` is nobody's collision: nothing raced this write, it simply did
    // not fit. It matches none of the conflict shapes above, so it used to fall
    // through the catch as a 500 — and re-sending it at once would only buy
    // another thirty seconds of the same, which is why it is not a 409.
    //
    // **The shape does not move when the statement does.** A deadlock arrives
    // wrapped by whichever of Prisma's two wrappers ran (`deadlockShapes`), but
    // a ceiling is raised by no statement at all: the transaction manager marks
    // the transaction `timed_out` and refuses every later query on its *id*,
    // before one is dispatched to a queryable. So `$queryRaw` and
    // `libraryCharacter.update` are handed the same `P2028`, verbatim.
    const timedOut = new MockPrismaKnownRequestError(
      "Transaction API error: A query cannot be executed on an expired transaction. " +
        "The timeout for this transaction was 10000 ms, however 10041 ms passed since the start of the transaction.",
      { code: "P2028" }
    );
    for (const request of [
      { method: "PATCH" as const, payload: { name: "Bramwell" } },
      { method: "DELETE" as const }
    ]) {
      resetMobileHarness();
      mockAccessTokens({ "token-a": "user-a" });
      mockPrisma.libraryCharacter.updateMany.mockResolvedValue({ count: 1 });
      findCharactersById([bramRecord(), mentioningSource()[0]!.sourceCharacter]);
      mockPrisma.libraryMention.findMany.mockResolvedValue(mentioningSource());
      // The sibling description write is the statement the window closes under.
      failSiblingRewrite(timedOut);

      const app = await buildMobileApp();
      const response = await app.inject({
        url: "/api/mobile/characters/char-2",
        headers: bearer("token-a"),
        ...request
      });

      expect(response.statusCode).toBe(503);
      expect(response.json().error.code).toBe("CHARACTER_EDIT_BUSY");
      expect(rewriteStatements().length).toBeGreaterThan(0);
      await app.close();
    }
  });

  it("refuses a delete when a mentioning character moved rather than overwriting it", async () => {
    findCharactersById([bramRecord(), mentioningSource()[0]!.sourceCharacter]);
    mockPrisma.libraryMention.findMany.mockResolvedValue(mentioningSource());
    // The row's own claim lands; the batched claim over the characters that
    // mention it comes back with nothing, which is a source that moved. What
    // that statement asserts and how it takes it — the row-wise `unnest`, the
    // lock mode, the one statement per set — is pinned at unit level in
    // `characterRowClaims.test.ts`; this is the route reading a short count.
    mockPrisma.libraryCharacter.updateMany.mockResolvedValue({ count: 1 });
    mockPrisma.$queryRaw.mockResolvedValue([]);

    const app = await buildMobileApp();
    const response = await app.inject({
      method: "DELETE",
      url: "/api/mobile/characters/char-2",
      headers: bearer("token-a")
    });

    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe("CHARACTER_EDIT_CONFLICT");
    expect(rewrittenDescriptions()).toEqual([]);
    expect(mockPrisma.libraryCharacter.deleteMany).not.toHaveBeenCalled();
    await app.close();
  });
});

/**
 * The rungs of `sendCharacterWriteError` that no route can reach on purpose.
 */
describe("character write failures nothing is supposed to raise", () => {
  beforeEach(() => {
    resetMobileHarness();
    mockAccessTokens({ "token-a": "user-a" });
    mockPrisma.libraryCharacter.updateMany.mockResolvedValue({ count: 1 });
  });
  afterEach(teardownMobileHarness);

  it("answers a mention CHECK violation with a typed error rather than a 500", async () => {
    // `LibraryMention_target_arc` and `LibraryMention_not_self` are the
    // database's copy of rules this API states in TypeScript, so a row that
    // fails one is a bug on this side — but a 500 for it is a whole character
    // save lost to a stack trace on a route whose every other refusal comes
    // back as a sentence the editor sheet can show. Prisma does not model a
    // CHECK violation: there is no `P` code and no `meta`, only
    // `PrismaClientUnknownRequestError` with the SQLSTATE and the constraint
    // name inside the message, so it fell through every rung of the ladder.
    const checkViolation = new Error(
      'Invalid `prisma.libraryMention.createMany()` invocation: Error occurred during query execution: ' +
        'ConnectorError(ConnectorError { kind: QueryError(PostgresError { code: "23514", ' +
        'message: "new row for relation \\"LibraryMention\\" violates check constraint \\"LibraryMention_target_arc\\"" }) })'
    );
    mockCreateKnowingBram();
    mockPrisma.libraryMention.createMany.mockRejectedValue(checkViolation);

    const response = await createKnowingBram();

    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe("INVALID_CHARACTER_MENTION");
    // Nothing internal on the wire: the constraint name is a schema detail and
    // the SQLSTATE is not a sentence.
    expect(response.json().error.message).not.toContain("LibraryMention");
    expect(response.json().error.message).not.toContain("23514");
  });

  it("answers the subtype's length rule the same way under either code it can raise", async () => {
    // The rule is stated twice — `@db.VarChar(80)` on the column and
    // `BETWEEN 1 AND 80` inside `LibraryMention_target_arc` — and Postgres
    // reaches the narrower one first, so an over-long subtype raises 22001
    // (Prisma `P2000`) and never gets as far as the CHECK. The trim half of the
    // same rule still raises 23514. One rule, two codes, and the rung above
    // only knew one of them until the column type landed.
    const tooLong = new MockPrismaKnownRequestError(
      "The provided value for the column is too long for the column's type. Column: otherType",
      { code: "P2000", meta: { column_name: "otherType" } }
    );
    mockCreateKnowingBram();
    mockPrisma.libraryMention.createMany.mockRejectedValue(tooLong);

    const response = await createKnowingBram();

    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe("INVALID_CHARACTER_MENTION");
    expect(response.json().error.message).not.toContain("otherType");
  });

  it("keeps one LibraryMentionError class for the thrower and the ladder", () => {
    // The class moved to `httpErrors.ts` to break the import cycle between the
    // module that throws it and the module that answers it — a cycle that held
    // only while neither read the other's binding during evaluation, and would
    // have become a `ReferenceError` at boot on the first top-level use of
    // either name. `libraryMentionRewrites.ts` re-exports it, and the `instanceof` in
    // `sendCharacterWriteError` is only true while both specifiers name one
    // class, which a second definition beside the re-export would quietly end.
    expect(reExportedMentionError).toBe(LibraryMentionError);
    expect(new reExportedMentionError("CHARACTER_NOT_FOUND", "gone")).toBeInstanceOf(LibraryMentionError);
  });
});

/**
 * The two rungs the ladder grew last, both driven from the create path — the
 * link set is the one statement all three writes share. One is the mention
 * target that left the library mid-write: nobody's bug, and an answer that
 * existed before it had a rung to reach it from. The other is the pair of
 * sentences that must never be swapped — "try again in a moment" is a window
 * that closed, "open it again and retry" is a race that was lost.
 */
describe("the database rungs of the character write ladder", () => {
  beforeEach(() => {
    resetMobileHarness();
    mockAccessTokens({ "token-a": "user-a" });
    mockCreateKnowingBram();
  });
  afterEach(teardownMobileHarness);

  /** `P2003` with the constraint named in the message, and — under the pg driver adapter — the connector's own `23503` and name again in `meta`. */
  const foreignKeyViolation = (table: string, constraint: string) =>
    Object.assign(
      new MockPrismaKnownRequestError(`Foreign key constraint violated on the constraint: \`${constraint}\``, {
        code: "P2003"
      }),
      { meta: { modelName: table, driverAdapterError: { cause: { originalCode: "23503", constraint } } } }
    );

  it("answers a target deleted mid-write with the 404 the checked half of that race gives", async () => {
    // `mentionedTargets` SELECTs Bram with no lock and finds him; the reader
    // deletes Bram on their other device, and that DELETE takes his row's own
    // FOR UPDATE and commits; the `createMany` under it lands on a row that is
    // gone. Nothing here is wrong, which is what made the 500 expensive: a
    // whole character save lost to a stack trace over a delete the same reader
    // had just performed.
    for (const failure of [
      foreignKeyViolation("LibraryMention", "LibraryMention_targetCharacterId_fkey"),
      // And the shape Prisma does not model: no `P` code, the SQLSTATE and the
      // constraint name in prose, exactly as a CHECK arrives.
      new Error('raw query failed. code: "23503". constraint: "LibraryMention_targetCharacterId_fkey"')
    ]) {
      mockPrisma.libraryMention.createMany.mockRejectedValue(failure);
      const response = await createKnowingBram();

      expect(response.statusCode).toBe(404);
      expect(response.json().error.code).toBe("CHARACTER_NOT_FOUND");
      // Word for word what `mentionedTargets` says when the *read* is the half
      // that catches it: one race, one sentence, no constraint name on the wire.
      expect(response.json().error.message).toBe("A mentioned character is no longer in your library.");
      expect(response.json().error.message).not.toContain("fkey");
    }

  });

  it("tells a serialization failure that quotes the timeout apart from the timeout", async () => {
    // A wrapper can report `40001` in prose that also carries Prisma's timeout
    // sentence. Matched on the string alone that is a lost race told to wait
    // out a window which already closed — the reader re-sends nothing while the
    // edit they have to reopen goes stale. So the conflict predicate is asked
    // first and wins: its tests are exact, and this rung has only a sentence.
    // The classifier's exact and fallback shapes are pinned directly in
    // `characterWriteBudget.test.ts`; this is the response ladder preserving
    // their precedence on a real character write.
    const wrapped = new Error("could not serialize access due to concurrent update (transaction already closed)");
    mockPrisma.libraryMention.createMany.mockRejectedValue(wrapped);
    const response = await createKnowingBram();

    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe("CHARACTER_EDIT_CONFLICT");
  });
});
