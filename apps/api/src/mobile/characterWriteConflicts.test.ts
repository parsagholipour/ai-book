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
 * these are all one story — the one `characterWriteConflicts.ts` tells.
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
      outgoingMentions: [{ targetCharacter: { id: "char-2", name: "Bram" } }]
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

const deadlockShapes = () => [
  // What Prisma raises for the write conflicts it models.
  new MockPrismaKnownRequestError("Transaction failed due to a write conflict or a deadlock", { code: "P2034" }),
  // And what a statement it does not model hands back: no `code` at all, the
  // SQLSTATE only in the message, the way PrismaClientUnknownRequestError does.
  new Error('raw query failed. code: "40P01". message: "deadlock detected"')
];

const uniqueViolation = (meta: { modelName: string; target: string[] }) =>
  Object.assign(new MockPrismaKnownRequestError("Unique constraint failed", { code: "P2002" }), { meta });

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
    mockPrisma.libraryCharacterMention.findMany.mockResolvedValue(mentioningSource());

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
    expect(mockPrisma.libraryCharacter.update).not.toHaveBeenCalled();
    expect(mockPrisma.libraryCharacter.deleteMany).not.toHaveBeenCalled();
    await app.close();
  });

  it("refuses a patch whose row was renamed, rather than rewriting the name it read", async () => {
    mockPrisma.libraryCharacter.findFirst.mockResolvedValue(characterRecord({ id: "char-2", name: "Bram" }));
    mockPrisma.libraryCharacter.updateMany.mockResolvedValue({ count: 0 });
    mockPrisma.libraryCharacterMention.findMany.mockResolvedValue(mentioningSource());

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
    // first statement of the transaction, ahead of every sibling write.
    expect(mockPrisma.libraryCharacterMention.findMany).not.toHaveBeenCalled();
    expect(mockPrisma.libraryCharacter.update).not.toHaveBeenCalled();
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
        mockPrisma.libraryCharacterMention.findMany.mockResolvedValue(mentioningSource());
        // The sibling description write is where the two transactions cross.
        mockPrisma.libraryCharacter.update.mockRejectedValue(failure);

        const app = await buildMobileApp();
        const response = await app.inject({
          url: "/api/mobile/characters/char-2",
          headers: bearer("token-a"),
          ...request
        });

        expect(response.statusCode).toBe(409);
        expect(response.json().error.code).toBe("CHARACTER_EDIT_CONFLICT");
        await app.close();
      }
    }
  });

  it("tells a mention-key collision apart from a name that is genuinely taken", async () => {
    const bram = characterRecord({ id: "char-2", name: "Bram" });
    mockPrisma.libraryCharacter.findFirst.mockResolvedValue(characterRecord());
    mockPrisma.libraryCharacter.findMany.mockResolvedValue([bram]);
    // `replaceCharacterMentions` deletes and recreates the link set, and the
    // loser of two same-character patches deletes nothing and then collides on
    // [sourceCharacterId, targetCharacterId]. The reader changed no name.
    mockPrisma.libraryCharacterMention.createMany.mockRejectedValue(
      uniqueViolation({ modelName: "LibraryCharacterMention", target: ["sourceCharacterId", "targetCharacterId"] })
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
    findCharactersById([bramRecord(), live]);
    mockPrisma.libraryCharacterMention.findMany.mockResolvedValue([{ sourceCharacter: stale }]);
    mockPrisma.libraryCharacter.deleteMany.mockResolvedValue({ count: 1 });

    const app = await buildMobileApp();
    const response = await app.inject({
      method: "DELETE",
      url: "/api/mobile/characters/char-2",
      headers: bearer("token-a")
    });

    expect(response.statusCode).toBe(200);
    expect(mockPrisma.libraryCharacter.update).toHaveBeenCalledWith({
      where: { id: "char-1" },
      data: { description: "Friends with Bram. She loves tea." }
    });
    await app.close();
  });

  it("refuses a delete when a mentioning character moved rather than overwriting it", async () => {
    findCharactersById([bramRecord(), mentioningSource()[0]!.sourceCharacter]);
    mockPrisma.libraryCharacterMention.findMany.mockResolvedValue(mentioningSource());
    mockPrisma.libraryCharacter.updateMany
      .mockResolvedValueOnce({ count: 1 })
      .mockResolvedValue({ count: 0 });

    const app = await buildMobileApp();
    const response = await app.inject({
      method: "DELETE",
      url: "/api/mobile/characters/char-2",
      headers: bearer("token-a")
    });

    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe("CHARACTER_EDIT_CONFLICT");
    expect(mockPrisma.libraryCharacter.update).not.toHaveBeenCalled();
    expect(mockPrisma.libraryCharacter.deleteMany).not.toHaveBeenCalled();
    await app.close();
  });
});
