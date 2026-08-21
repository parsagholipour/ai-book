import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@book-maker/db", async () => (await import("./testing/mobileApiMocks.js")).dbModuleMock());
vi.mock("@book-maker/db/billing", async () => (await import("./testing/mobileApiMocks.js")).billingModuleMock());
vi.mock("../queue.js", async () => (await import("./testing/mobileApiMocks.js")).queueModuleMock());
vi.mock("../projectStatus.js", async () => (await import("./testing/mobileApiMocks.js")).projectStatusModuleMock());

import { mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { dispatchGenerationJob, enqueueGenerationJob } from "../queue.js";
import { reserveCredits } from "@book-maker/db/billing";
import { LIBRARY_MENTION_LIMIT } from "@book-maker/core";
import {
  bearer,
  buildMobileApp,
  mockAccessTokens,
  MockPrismaKnownRequestError,
  mockPrisma,
  resetMobileHarness,
  state,
  teardownMobileHarness
} from "./testing/mobileApiHarness.js";
import { rawStatementsMatching } from "./testing/mobileApiMocks.js";

function characterRecord(overrides: Record<string, unknown> = {}) {
  return {
    id: "char-1",
    userId: "user-a",
    name: "Luna",
    description: "A brave night-flying rabbit.",
    fields: [{ key: "Age", value: "9" }],
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

function outgoingMention(target: Record<string, unknown>, sortOrder: number) {
  return {
    sourceCharacterId: "char-1",
    targetKind: "CHARACTER",
    targetId: target.id,
    targetCharacterId: target.id,
    otherType: null,
    sortOrder,
    targetCharacter: target
  };
}

function libraryMentionWrite(targetId: string, sortOrder: number) {
  return {
    sourceCharacterId: "char-1",
    targetKind: "CHARACTER",
    targetId,
    targetCharacterId: targetId,
    otherType: null,
    sortOrder
  };
}

/**
 * The `(id, description)` pairs the sibling rewrite carried.
 *
 * `rewriteMentioningDescriptions` (`libraryMentionRewrites.ts`) is one set
 * update for the whole claimed set, so it lands on `$queryRaw` and not on a
 * model mock. `UPDATE "LibraryCharacter"` is what tells it from this lane's other
 * two raw statements: the target lock ends in `FOR UPDATE` and the row claim
 * selects `FROM "LibraryCharacter"`.
 */
function rewrittenDescriptions(): Array<{ id: string; description: string }> {
  const [, , ids = [], descriptions = []] = (rawStatementsMatching('UPDATE "LibraryCharacter"').at(-1) ?? []) as [
    readonly string[],
    Date,
    string[],
    string[]
  ];
  return ids.map((id, index) => ({ id, description: descriptions[index] ?? "" }));
}

/** One more distinct id than a description is allowed to mention. */
const overCapMentionIds = () =>
  Array.from({ length: LIBRARY_MENTION_LIMIT + 1 }, (_unused, index) => `char-${index + 2}`);

/** As many targets as a description may hold, named so no `@token` nests in another. */
const fullMentionCast = () =>
  ["Ana", "Bram", "Cora", "Dara", "Elio", "Fen", "Gus", "Hana", "Iris", "Juno"]
    .slice(0, LIBRARY_MENTION_LIMIT)
    .map((name, index) => ({ id: `char-${index + 2}`, name }));

const createCharacter = (app: Awaited<ReturnType<typeof buildMobileApp>>, payload: Record<string, unknown>) =>
  app.inject({ method: "POST", url: "/api/mobile/characters", headers: bearer("token-a"), payload });

const patchCharacter = (app: Awaited<ReturnType<typeof buildMobileApp>>, id: string, payload: Record<string, unknown>) =>
  app.inject({ method: "PATCH", url: `/api/mobile/characters/${id}`, headers: bearer("token-a"), payload });

describe("mobile character library routes", () => {
  beforeEach(() => {
    resetMobileHarness();
    mockAccessTokens({ "token-a": "user-a" });
    // Both write paths open their transaction by claiming the row they edit.
    // Won by default — the uncontended case these tests are about; the races
    // live in `characterWriteConflicts.test.ts`.
    mockPrisma.libraryCharacter.updateMany.mockResolvedValue({ count: 1 });
  });
  afterEach(teardownMobileHarness);

  it("lists the user's characters with the current portrait price", async () => {
    mockPrisma.libraryCharacter.findMany.mockResolvedValue([
      characterRecord(),
      characterRecord({ id: "char-2", name: "Bram", portraitStatus: "READY", portraitPath: "char-2-portrait.webp" })
    ]);
    const app = await buildMobileApp();
    const response = await app.inject({ method: "GET", url: "/api/mobile/characters", headers: bearer("token-a") });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.portraitCredits).toBe(45);
    expect(body.characters).toHaveLength(2);
    expect(body.characters[0]).toMatchObject({
      id: "char-1",
      name: "Luna",
      portraitStatus: "none",
      portraitUrl: null,
      hasPhoto: false
    });
    expect(body.characters[1]).toMatchObject({
      portraitStatus: "ready",
      portraitUrl: "/api/mobile/characters/char-2/portrait"
    });
    await app.close();
  });

  it("creates a character and rejects a duplicate name with 409", async () => {
    mockPrisma.libraryCharacter.count.mockResolvedValue(0);
    mockPrisma.libraryCharacter.create.mockResolvedValue(characterRecord());
    const app = await buildMobileApp();
    const created = await createCharacter(app, {
      name: "Luna",
      description: "A brave night-flying rabbit.",
      appearance: "Grey rabbit with one folded ear and a red scarf.",
      fields: [{ key: "Age", value: "9" }]
    });
    expect(created.statusCode).toBe(201);
    expect(created.json().character.name).toBe("Luna");
    expect(mockPrisma.libraryCharacter.create.mock.calls[0]![0].data).toMatchObject({
      appearance: "Grey rabbit with one folded ear and a red scarf."
    });

    mockPrisma.libraryCharacter.create.mockRejectedValue(
      new MockPrismaKnownRequestError("duplicate", { code: "P2002" })
    );
    const duplicate = await createCharacter(app, { name: "Luna" });
    expect(duplicate.statusCode).toBe(409);
    expect(duplicate.json().error.code).toBe("CHARACTER_NAME_TAKEN");
    await app.close();
  });

  it("answers a create whose transaction ran out of time with a 503, not a raw 500", async () => {
    // `P2028` is nobody's collision: nothing raced this save, its window closed
    // — a pool under pressure, or a slow read over the mentioned ids. It is
    // neither a `LibraryMentionError` nor a `P2002`, so it used to fall through
    // this route's catch as a 500 for a character the reader typed correctly,
    // while PATCH and DELETE already answered the same shape as retryable.
    mockPrisma.libraryCharacter.count.mockResolvedValue(0);
    mockPrisma.libraryCharacter.create.mockResolvedValue(characterRecord({ description: "Knows @Bram." }));
    mockPrisma.libraryCharacter.findMany.mockRejectedValue(
      new MockPrismaKnownRequestError("Transaction already closed: expired transaction.", { code: "P2028" })
    );
    const app = await buildMobileApp();
    const response = await createCharacter(app, {
      name: "Luna",
      description: "Knows @Bram.",
      mentionedCharacterIds: ["char-2"]
    });
    expect(response.statusCode).toBe(503);
    expect(response.json().error.code).toBe("CHARACTER_EDIT_BUSY");
    await app.close();
  });

  it("creates canonical durable mentions in first-token order", async () => {
    const bram = characterRecord({ id: "char-2", name: "Bram" });
    const mina = characterRecord({ id: "char-3", name: "Mina" });
    const source = characterRecord({
      description: "@bram met @Mina, then @Bram returned."
    });
    const hydrated = characterRecord({
      description: "@Bram met @Mina, then @Bram returned.",
      outgoingMentions: [outgoingMention(bram, 0), outgoingMention(mina, 1)]
    });
    mockPrisma.libraryCharacter.count.mockResolvedValue(0);
    mockPrisma.libraryCharacter.create.mockResolvedValue(source);
    // An IN query has no caller order; the stored order must come from prose.
    mockPrisma.libraryCharacter.findMany.mockResolvedValue([mina, bram]);
    // The canonicalizing write hands back the row it wrote, which is the whole
    // of what the reload used to be for.
    mockPrisma.libraryCharacter.update.mockResolvedValue(hydrated);

    const app = await buildMobileApp();
    const response = await createCharacter(app, {
      name: "Luna",
      description: source.description,
      // A duplicate id represents repeated prose, not another cast slot.
      mentionedCharacterIds: ["char-2", "char-3", "char-2"]
    });

    expect(response.statusCode).toBe(201);
    expect(response.json().character).toMatchObject({
      description: "@Bram met @Mina, then @Bram returned.",
      mentions: [
        { id: "char-2", name: "Bram", kind: "character", otherType: null },
        { id: "char-3", name: "Mina", kind: "character", otherType: null }
      ]
    });
    expect(mockPrisma.libraryMention.createMany).toHaveBeenCalledWith({
      data: [libraryMentionWrite("char-2", 0), libraryMentionWrite("char-3", 1)]
    });
    // **Those `mentions` are the batch above, not a read of it.** The write
    // already holds the rows and the names it resolved them from, in the order
    // `libraryMentionInclude` would hand them back, so a create takes no read
    // of its own row at all — the reload it used to end with was one more
    // indexed read plus the nested join, inside the transaction holding the new
    // row's lock.
    expect(mockPrisma.libraryCharacter.findFirst).not.toHaveBeenCalled();
    await app.close();
  });

  it("rejects missing, foreign, self, and tokenless mention targets", async () => {
    const cases = [
      { ids: ["char-foreign"], targets: [], description: "Knows @Bram.", status: 404 },
      {
        ids: ["char-1"],
        targets: [characterRecord()],
        description: "Knows @Luna.",
        status: 400
      },
      {
        ids: ["char-2"],
        targets: [characterRecord({ id: "char-2", name: "Bram" })],
        description: "Knows Bram.",
        status: 400
      }
    ];
    const app = await buildMobileApp();
    for (const testCase of cases) {
      vi.mocked(mockPrisma.libraryCharacter.findMany).mockReset();
      mockPrisma.libraryCharacter.count.mockResolvedValue(0);
      mockPrisma.libraryCharacter.create.mockResolvedValue(
        characterRecord({ description: testCase.description })
      );
      mockPrisma.libraryCharacter.findMany.mockResolvedValue(testCase.targets);
      const response = await createCharacter(app, {
        name: "Luna",
        description: testCase.description,
        mentionedCharacterIds: testCase.ids
      });
      expect(response.statusCode).toBe(testCase.status);
    }
    await app.close();
  });

  /**
   * The cast the write allows, refused in the sentence that is true.
   *
   * The door bounds *entries* — `maxItems` and `z.array().max()` can count
   * nothing else — while the rule counts *distinct ids*, so the two cannot be
   * one number. Held to the mention limit the door refused a legal set the
   * moment it repeated an id, and refused every over-cap set through the route's
   * generic parse fallback — "Give the character a name.", "Send at least one
   * change." — which `character_editor_sheet.dart` snackbars verbatim, telling
   * the reader about a field that was fine.
   */
  it("names the mention cap when a write sends more characters than a description may hold", async () => {
    const description = "Knows everyone.";
    mockPrisma.libraryCharacter.count.mockResolvedValue(0);
    mockPrisma.libraryCharacter.create.mockResolvedValue(characterRecord({ description }));
    mockPrisma.libraryCharacter.findFirst.mockResolvedValue(characterRecord({ description }));
    const app = await buildMobileApp();
    const over = { description, mentionedCharacterIds: overCapMentionIds() };

    for (const response of [
      await createCharacter(app, { name: "Luna", ...over }),
      await patchCharacter(app, "char-1", over)
    ]) {
      expect(response.statusCode).toBe(400);
      expect(response.json().error.code).toBe("INVALID_CHARACTER_MENTION");
      expect(response.json().error.message).toBe(
        `A description can mention up to ${LIBRARY_MENTION_LIMIT} characters.`
      );
    }
    await app.close();
  });

  it("collapses a repeated id rather than counting it against the cap", async () => {
    // A full cast sent with one id twice is `LIBRARY_MENTION_LIMIT + 1` entries
    // and `LIBRARY_MENTION_LIMIT` characters. `uniqueIds` is what the rule
    // counts, so this is a legal set — and a door bounding entries at the
    // mention limit is exactly what turned it into a refusal about a name.
    const cast = fullMentionCast();
    const description = `Knows ${cast.map((target) => `@${target.name}`).join(", ")}.`;
    mockPrisma.libraryCharacter.count.mockResolvedValue(0);
    mockPrisma.libraryCharacter.create.mockResolvedValue(characterRecord({ description }));
    mockPrisma.libraryCharacter.findMany.mockResolvedValue(cast);
    mockPrisma.libraryCharacter.findFirst.mockResolvedValue(characterRecord({ description }));
    const app = await buildMobileApp();

    const response = await createCharacter(app, {
      name: "Luna",
      description,
      mentionedCharacterIds: [cast[0]!.id, ...cast.map((target) => target.id)]
    });

    expect(response.statusCode).toBe(201);
    const [written] = vi.mocked(mockPrisma.libraryMention.createMany).mock.calls.at(-1) ?? [];
    expect((written as { data: unknown[] }).data).toHaveLength(LIBRARY_MENTION_LIMIT);
    await app.close();
  });

  it("preserves surviving links for old clients and honors an explicit empty set", async () => {
    const bram = characterRecord({ id: "char-2", name: "Bram" });
    const linked = characterRecord({
      description: "Knows @Bram.",
      outgoingMentions: [outgoingMention(bram, 0)]
    });
    // Two reads per PATCH and no third: the lean owner check, and the re-read
    // taken under the claim. What the reply says about the links is the set the
    // write itself computed, so the reload that used to follow the `update` —
    // one more indexed read plus the nested join, with the claim still held —
    // is gone; the count below is what keeps it gone.
    mockPrisma.libraryCharacter.findFirst.mockResolvedValue(linked);
    mockPrisma.libraryCharacter.findMany.mockResolvedValue([bram]);
    // The stored link set, as the row above already claims to hold it. Without
    // this the character reads as linked through `outgoingMentions` but empty
    // through the rows themselves, and the explicit clear below would be
    // skipped as empty-over-empty rather than honored.
    mockPrisma.libraryMention.findMany.mockResolvedValue([
      { targetKind: "CHARACTER", targetId: "char-2", sortOrder: 0 }
    ]);
    mockPrisma.libraryCharacter.update.mockImplementation(
      async ({ data }: { data: Record<string, unknown> }) => characterRecord(data)
    );
    const app = await buildMobileApp();

    const legacy = await patchCharacter(app, "char-1", { description: "Still knows @bram." });
    expect(legacy.statusCode).toBe(200);
    // The old client sent no `mentionedCharacterIds`, so the link survives — and
    // surviving means the batch equals the stored rows, which is a write worth
    // skipping. That skip is also the assertion: a path that dropped the link
    // instead would emit an empty batch, and an empty batch against a stored row
    // deletes.
    expect(legacy.json().character.mentions).toHaveLength(1);
    expect(mockPrisma.libraryMention.deleteMany).not.toHaveBeenCalled();
    expect(mockPrisma.libraryMention.createMany).not.toHaveBeenCalled();

    const explicitClear = await patchCharacter(app, "char-1", {
      description: "Knows Bram.",
      mentionedCharacterIds: []
    });
    expect(explicitClear.statusCode).toBe(200);
    expect(explicitClear.json().character.mentions).toEqual([]);
    expect(mockPrisma.libraryMention.deleteMany).toHaveBeenCalledTimes(1);
    expect(mockPrisma.libraryCharacter.findFirst).toHaveBeenCalledTimes(4);
    await app.close();
  });

  it("rewrites incoming tokens on rename and rejects descriptions that would overflow", async () => {
    const bram = characterRecord({ id: "char-2", name: "Bram" });
    const mina = characterRecord({
      id: "char-1",
      name: "Mina",
      description: "Friends with @Bram and @BRAM.",
      outgoingMentions: [{ targetCharacter: { id: "char-2", name: "Bram" } }]
    });
    mockPrisma.libraryCharacter.findFirst.mockImplementation(
      async ({ where }: { where: { id?: string } }) => (where.id === "char-1" ? mina : bram)
    );
    mockPrisma.libraryMention.findMany.mockResolvedValue([{ sourceCharacter: mina }]);
    mockPrisma.libraryCharacter.update.mockImplementation(
      async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) =>
        characterRecord({ id: where.id, ...data })
    );
    const app = await buildMobileApp();
    const renamed = await patchCharacter(app, "char-2", { name: "Bramwell" });
    expect(renamed.statusCode).toBe(200);
    expect(rewrittenDescriptions()).toEqual([
      { id: "char-1", description: "Friends with @Bramwell and @Bramwell." }
    ]);

    mina.description = `${"x".repeat(1993)} @Bram`;
    const conflict = await patchCharacter(app, "char-2", { name: "B".repeat(80) });
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json().error.code).toBe("CHARACTER_MENTION_TOO_LONG");
    await app.close();
  });

  it("turns incoming mentions into plain names when deleting a character", async () => {
    const bram = characterRecord({ id: "char-2", name: "Bram" });
    const mina = characterRecord({
      id: "char-1",
      name: "Mina",
      description: "Knows @Bram and @Bram.",
      outgoingMentions: [{ targetCharacter: { id: "char-2", name: "Bram" } }]
    });
    mockPrisma.libraryCharacter.findFirst.mockImplementation(
      async ({ where }: { where: { id?: string } }) => (where.id === "char-1" ? mina : bram)
    );
    mockPrisma.libraryMention.findMany.mockResolvedValue([{ sourceCharacter: mina }]);
    mockPrisma.libraryCharacter.deleteMany.mockResolvedValue({ count: 1 });
    const app = await buildMobileApp();
    const response = await app.inject({
      method: "DELETE",
      url: "/api/mobile/characters/char-2",
      headers: bearer("token-a")
    });
    expect(response.statusCode).toBe(200);
    expect(rewrittenDescriptions()).toEqual([{ id: "char-1", description: "Knows Bram and Bram." }]);
    await app.close();
  });

  it("rations delete in a lane of its own, so a cleanup cannot spend the edits' budget", async () => {
    // Rationed, because it is the most expensive write in the group and was
    // once the only one with no ceiling at all: each pass runs the owner read
    // and then up to two transactions, each claiming this row plus every
    // character that mentions it — up to 99 — for as much of the client budget
    // as `characterRetryTransactionOptions` still has to give. The retained
    // picture names are not a second read out here: they come through `tx`
    // under the claim, and putting them back in front of the transaction is the
    // `PUT /:id/photo` race — an upload's file outliving a cascade that never
    // learned its name.
    //
    // Rationed *apart*, because the two facts do not fit in one bucket. The
    // library caps at 100 characters, so emptying a full one is a hundred
    // deletes against a ceiling of 120 sized for drafting — and the few edits
    // or promotes either side of a cleanup then answered 429 on a gesture the
    // reader had already confirmed row by row, with nothing on the character
    // screen able to say why some went and some did not. Both directions are
    // asserted here: neither lane can draw the other down.
    mockPrisma.libraryCharacter.findFirst.mockResolvedValue(characterRecord());
    mockPrisma.libraryCharacter.deleteMany.mockResolvedValue({ count: 1 });
    mockPrisma.libraryCharacter.update.mockImplementation(
      async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) =>
        characterRecord({ id: where.id, ...data })
    );
    const app = await buildMobileApp({
      draftRateLimit: { maxAttempts: 1, windowMs: 60_000 },
      characterDeleteRateLimit: { maxAttempts: 2, windowMs: 60_000 }
    });
    const remove = () =>
      app.inject({ method: "DELETE", url: "/api/mobile/characters/char-1", headers: bearer("token-a") });

    expect((await remove()).statusCode).toBe(200);
    expect((await remove()).statusCode).toBe(200);
    const limited = await remove();

    expect(limited.statusCode).toBe(429);
    expect(limited.json().error.code).toBe("RATE_LIMITED");
    // The cleanup spent its own lane and nothing of the writes': the edit
    // straight after it still has its token, which is the whole split.
    expect((await patchCharacter(app, "char-1", { name: "Nova" })).statusCode).toBe(200);
    // And that one token was the writes' whole budget — POST and PATCH still
    // share `character-write` between them, keyed on the account.
    const create = await createCharacter(app, { name: "Bram" });
    expect(create.statusCode).toBe(429);
    expect(create.json().error.code).toBe("RATE_LIMITED");
    await app.close();
  });

  /**
   * A body the route refuses, answered in the shape the app reads.
   *
   * Declaring the statuses these handlers reach is also declaring how *every*
   * answer at those statuses is serialized, Fastify's own included — and
   * Fastify's error body is `{ statusCode, error: "Bad Request", message }`,
   * where `mobileAuthError` wants `error` to be an object with a `code`. So
   * naming the 400 turned each of these into a 500
   * (`FST_ERR_FAILED_ERROR_SERIALIZATION`), for requests that were merely
   * mistyped. `attachValidation` moves the ajv rejections onto the handler's own
   * Zod parse — the portrait route's fix, one file over — and the route
   * `errorHandler` covers the body the JSON parser could not read at all, which
   * never reaches a handler to attach anything to.
   *
   * Asserted on the wire code rather than on "not 500", because a 400 the app
   * cannot read a code out of is the same dead end one status up.
   */
  it("refuses an unreadable body as a 400 the app can read, never a 500", async () => {
    const app = await buildMobileApp();
    const malformed = (method: "POST" | "PATCH", url: string) =>
      app.inject({
        method,
        url,
        headers: { ...bearer("token-a"), "content-type": "application/json" },
        payload: "{ name: unquoted"
      });

    const cases = [
      // Both ends of the ajv bound ajv used to enforce itself.
      { response: await createCharacter(app, { name: "" }), message: "Give the character a name." },
      { response: await createCharacter(app, { name: "x".repeat(200) }), message: "Give the character a name." },
      {
        response: await patchCharacter(app, "char-1", { description: "x".repeat(3000) }),
        message: "Send at least one change."
      },
      // And the half `attachValidation` cannot reach, on both routes.
      { response: await malformed("POST", "/api/mobile/characters"), message: "That request could not be read." },
      {
        response: await malformed("PATCH", "/api/mobile/characters/char-1"),
        message: "That request could not be read."
      }
    ];

    for (const { response, message } of cases) {
      expect(response.statusCode).toBe(400);
      expect(response.json()).toEqual({ error: { code: "VALIDATION_ERROR", message } });
    }
    // Nothing got as far as a row on any of them.
    expect(mockPrisma.libraryCharacter.create).not.toHaveBeenCalled();
    expect(mockPrisma.libraryCharacter.update).not.toHaveBeenCalled();
    await app.close();
  });

  it("does not ask a character it just created what links it already holds", async () => {
    // The row was minted by this transaction and is visible to nothing, so the
    // read that spares PATCH a delete/insert pair can only come back empty —
    // one round trip inside the transaction holding the new row's own lock.
    const bram = characterRecord({ id: "char-2", name: "Bram" });
    const source = characterRecord({ description: "Knows @Bram." });
    mockPrisma.libraryCharacter.count.mockResolvedValue(0);
    mockPrisma.libraryCharacter.create.mockResolvedValue(source);
    mockPrisma.libraryCharacter.findMany.mockResolvedValue([bram]);
    const app = await buildMobileApp();

    const response = await createCharacter(app, {
      name: "Luna",
      description: "Knows @Bram.",
      mentionedCharacterIds: ["char-2"]
    });

    expect(response.statusCode).toBe(201);
    expect(response.json().character.mentions).toEqual([
      { id: "char-2", name: "Bram", kind: "character", otherType: null }
    ]);
    expect(mockPrisma.libraryMention.findMany).not.toHaveBeenCalled();
    expect(mockPrisma.libraryMention.createMany).toHaveBeenCalledWith({
      data: [{ ...libraryMentionWrite("char-2", 0), sourceCharacterId: "char-1" }]
    });
    await app.close();
  });

  it("refuses creation past the library cap", async () => {
    mockPrisma.libraryCharacter.count.mockResolvedValue(100);
    const app = await buildMobileApp();
    const response = await createCharacter(app, { name: "One Too Many" });
    expect(response.statusCode).toBe(403);
    expect(response.json().error.code).toBe("CHARACTER_LIMIT_REACHED");
    expect(mockPrisma.libraryCharacter.create).not.toHaveBeenCalled();
    await app.close();
  });

  it("blocks deleting a character while its portrait job is genuinely running", async () => {
    mockPrisma.libraryCharacter.findFirst.mockResolvedValue(
      characterRecord({ portraitStatus: "GENERATING", portraitJobId: "job-portrait" })
    );
    // The portrait guard now rides the claim, so it is the claim that loses.
    mockPrisma.libraryCharacter.updateMany.mockResolvedValue({ count: 0 });
    mockPrisma.generationJob.findUnique.mockResolvedValue({ status: "ACTIVE" });
    const app = await buildMobileApp();
    const response = await app.inject({
      method: "DELETE",
      url: "/api/mobile/characters/char-1",
      headers: bearer("token-a")
    });
    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe("PORTRAIT_IN_PROGRESS");
    await app.close();
  });

  it("lets delete reclaim a character whose portrait claim outlived its job", async () => {
    // A worker killed hard never runs its failure path: the row says
    // GENERATING but the backing job is terminal. Delete is the escape hatch.
    mockPrisma.libraryCharacter.findFirst.mockResolvedValue(
      characterRecord({ portraitStatus: "GENERATING", portraitJobId: "job-portrait" })
    );
    mockPrisma.libraryCharacter.updateMany
      .mockResolvedValueOnce({ count: 0 })
      .mockResolvedValueOnce({ count: 1 });
    mockPrisma.libraryCharacter.deleteMany.mockResolvedValue({ count: 1 });
    mockPrisma.generationJob.findUnique.mockResolvedValue({ status: "FAILED" });
    const app = await buildMobileApp();
    const response = await app.inject({
      method: "DELETE",
      url: "/api/mobile/characters/char-1",
      headers: bearer("token-a")
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().deleted).toBe(true);
    await app.close();
  });

  it("refuses a delete for a portrait that started after the row was read", async () => {
    // The stale window is the whole lane, not a moment: `ownedCharacter` runs
    // behind whatever the pool made the session read wait for, and the guarded
    // claim queues for a connection of its own after it. A Redraw tapped on
    // another device inside that window moves the row to QUEUED under a job that
    // snapshot never heard of, and the guarded claim loses — which is the lane
    // working. The snapshot then decided the answer: READY, no job at all,
    // therefore "stale claim", therefore drop the guard and delete the character
    // out from under a portrait still being drawn. The worker failed on a
    // character that no longer existed, and the 409 this two-attempt lane exists
    // to produce could not fire.
    mockPrisma.libraryCharacter.findFirst
      .mockResolvedValueOnce(characterRecord({ portraitStatus: "READY", portraitJobId: null }))
      .mockResolvedValue(characterRecord({ portraitStatus: "QUEUED", portraitJobId: "job-redraw" }));
    // Only the guarded claim loses; an unguarded second attempt would win and
    // take the row, which is what this used to answer 200 by doing.
    mockPrisma.libraryCharacter.updateMany.mockResolvedValueOnce({ count: 0 }).mockResolvedValue({ count: 1 });
    mockPrisma.libraryCharacter.deleteMany.mockResolvedValue({ count: 1 });
    mockPrisma.generationJob.findUnique.mockResolvedValue({ status: "QUEUED" });
    const app = await buildMobileApp();

    const response = await app.inject({
      method: "DELETE",
      url: "/api/mobile/characters/char-1",
      headers: bearer("token-a")
    });

    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe("PORTRAIT_IN_PROGRESS");
    // Asked about the job the row names now. The snapshot named none, so the
    // question used to be answered without a job read at all.
    expect(mockPrisma.generationJob.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "job-redraw" } })
    );
    expect(mockPrisma.libraryCharacter.deleteMany).not.toHaveBeenCalled();
    await app.close();
  });

  it("pins the delete's second attempt to the dead claim it just checked", async () => {
    // The escape hatch drops the portrait guard, and dropping it outright leaves
    // one more window a Redraw can start inside — between the liveness answer
    // and the retry's own claim. `portraitJobId` is the claim's identity, so the
    // retry names the job it was told is dead and a row claimed by another one
    // matches nothing. The reader is asked to send the delete again, which is
    // true; "that character is not in your library" would not be.
    mockPrisma.libraryCharacter.findFirst
      .mockResolvedValueOnce(characterRecord({ portraitStatus: "GENERATING", portraitJobId: "job-dead" }))
      .mockResolvedValueOnce(characterRecord({ portraitStatus: "GENERATING", portraitJobId: "job-dead" }))
      .mockResolvedValue(characterRecord({ portraitStatus: "QUEUED", portraitJobId: "job-redraw" }));
    mockPrisma.libraryCharacter.updateMany.mockResolvedValue({ count: 0 });
    mockPrisma.generationJob.findUnique.mockResolvedValue({ status: "FAILED" });
    const app = await buildMobileApp();

    const response = await app.inject({
      method: "DELETE",
      url: "/api/mobile/characters/char-1",
      headers: bearer("token-a")
    });

    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe("CHARACTER_EDIT_CONFLICT");
    const retryClaim = mockPrisma.libraryCharacter.updateMany.mock.calls[1]![0] as {
      where: Record<string, unknown>;
    };
    expect(retryClaim.where).toMatchObject({ id: "char-1", name: "Luna", portraitJobId: "job-dead" });
    expect(mockPrisma.libraryCharacter.deleteMany).not.toHaveBeenCalled();
    await app.close();
  });

  it("sweeps every retained file the deleted character leaves behind", async () => {
    // Nothing sweeps `IMAGE_STORAGE_DIR/characters/` and the cascade takes the
    // rows naming these files, so a name this tail misses is unreachable for
    // good. They go in one round of I/O rather than a dozen sequential ones: the
    // tail runs after the commit and outside the window
    // `characterRetryTransactionOptions` sizes, so on slow storage it was pure
    // overrun past the app's 20 s receive timeout — a bare network error for a
    // delete that had already happened.
    const history = ["char-1-photo-aa1.webp", "char-1-portrait-bb2.webp", "char-1-portrait-cc3.webp"];
    const userDir = join(state.imageStorageDir!, "characters", "user-a");
    mkdirSync(userDir, { recursive: true });
    for (const fileName of history) {
      writeFileSync(join(userDir, fileName), "fake-webp");
    }
    mockPrisma.libraryCharacter.findFirst.mockResolvedValue(
      characterRecord({ photoPath: history[0], portraitPath: history[1] })
    );
    mockPrisma.libraryCharacterImage.findMany.mockResolvedValue(history.map((fileName) => ({ fileName })));
    mockPrisma.libraryCharacter.deleteMany.mockResolvedValue({ count: 1 });
    const app = await buildMobileApp();

    const response = await app.inject({
      method: "DELETE",
      url: "/api/mobile/characters/char-1",
      headers: bearer("token-a")
    });

    expect(response.statusCode).toBe(200);
    expect(readdirSync(userDir)).toEqual([]);
    // Read *inside* the transaction, after the claim and before the cascade —
    // under the `FOR UPDATE` `unlinkIncomingLibraryMentions` takes on this row.
    // Read before the transaction, as this lane used to, it misses a version row
    // a photo upload inserts while the delete is in flight and leaks that file
    // for good.
    const order = (mock: { mock: { invocationCallOrder: number[] } }) => mock.mock.invocationCallOrder[0]!;
    expect(order(mockPrisma.libraryCharacterImage.findMany)).toBeGreaterThan(
      order(mockPrisma.libraryCharacter.updateMany)
    );
    expect(order(mockPrisma.libraryCharacterImage.findMany)).toBeLessThan(
      order(mockPrisma.libraryCharacter.deleteMany)
    );
    await app.close();
  });

  it("charges and queues a portrait, stamping the ledger entry on the job payload", async () => {
    mockPrisma.libraryCharacter.findFirst.mockResolvedValue(characterRecord());
    mockPrisma.libraryCharacter.updateMany.mockResolvedValue({ count: 1 });
    mockPrisma.libraryCharacter.update.mockResolvedValue(characterRecord({ portraitStatus: "QUEUED" }));
    vi.mocked(enqueueGenerationJob).mockResolvedValue({ id: "job-portrait" } as never);
    const app = await buildMobileApp();
    const response = await app.inject({
      method: "POST",
      url: "/api/mobile/characters/char-1/portrait",
      headers: bearer("token-a"),
      payload: { requestId: "portrait-request-1" }
    });
    expect(response.statusCode).toBe(202);
    expect(response.json().creditsCharged).toBe(45);
    expect(reserveCredits).toHaveBeenCalledWith(
      expect.objectContaining({ operation: "CHARACTER_PORTRAIT_GENERATION", amountCredits: 45 })
    );
    expect(enqueueGenerationJob).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: null,
        type: "GENERATE_CHARACTER_PORTRAIT",
        dispatch: false,
        payload: expect.objectContaining({
          libraryCharacterId: "char-1",
          userId: "user-a",
          billingLedgerEntryId: expect.any(String)
        })
      })
    );
    expect(dispatchGenerationJob).toHaveBeenCalledWith("job-portrait");
    await app.close();
  });

  it("replays the same portrait requestId instead of charging twice", async () => {
    mockPrisma.libraryCharacter.findFirst.mockResolvedValue(characterRecord());
    mockPrisma.libraryCharacter.updateMany.mockResolvedValue({ count: 1 });
    mockPrisma.libraryCharacter.update.mockResolvedValue(characterRecord({ portraitStatus: "QUEUED" }));
    vi.mocked(enqueueGenerationJob).mockResolvedValue({ id: "job-portrait" } as never);
    const app = await buildMobileApp();
    const send = () =>
      app.inject({
        method: "POST",
        url: "/api/mobile/characters/char-1/portrait",
        headers: bearer("token-a"),
        payload: { requestId: "portrait-request-2" }
      });
    expect((await send()).statusCode).toBe(202);
    expect((await send()).statusCode).toBe(202);
    expect(vi.mocked(reserveCredits)).toHaveBeenCalledTimes(1);
    await app.close();
  });

  it("answers 409 while a portrait is already in flight", async () => {
    mockPrisma.libraryCharacter.findFirst.mockResolvedValue(characterRecord({ portraitStatus: "QUEUED" }));
    const app = await buildMobileApp();
    const response = await app.inject({
      method: "POST",
      url: "/api/mobile/characters/char-1/portrait",
      headers: bearer("token-a"),
      payload: {}
    });
    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe("PORTRAIT_IN_PROGRESS");
    await app.close();
  });

  it("never serves another user's character files", async () => {
    mockAccessTokens({ "token-a": "user-a", "token-b": "user-b" });
    mockPrisma.libraryCharacter.findFirst.mockImplementation(async ({ where }: { where: { userId: string } }) =>
      where.userId === "user-a" ? characterRecord({ portraitPath: "char-1-portrait.webp" }) : null
    );
    const dir = join(state.imageStorageDir!, "characters", "user-a");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "char-1-portrait.webp"), "fake-webp");
    const app = await buildMobileApp();
    const stranger = await app.inject({
      method: "GET",
      url: "/api/mobile/characters/char-1/portrait",
      headers: bearer("token-b")
    });
    expect(stranger.statusCode).toBe(404);
    const owner = await app.inject({
      method: "GET",
      url: "/api/mobile/characters/char-1/portrait",
      headers: bearer("token-a")
    });
    expect(owner.statusCode).toBe(200);
    await app.close();
  });
});
