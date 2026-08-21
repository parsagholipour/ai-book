import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@book-maker/db", async () => (await import("./testing/mobileApiMocks.js")).dbModuleMock());
vi.mock("@book-maker/db/billing", async () => (await import("./testing/mobileApiMocks.js")).billingModuleMock());
vi.mock("../queue.js", async () => (await import("./testing/mobileApiMocks.js")).queueModuleMock());
vi.mock("../projectStatus.js", async () => (await import("./testing/mobileApiMocks.js")).projectStatusModuleMock());

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { enqueueGenerationJob } from "../queue.js";
import {
  bearer,
  buildMobileApp,
  mockAccessTokens,
  mockPrisma,
  resetMobileHarness,
  state,
  teardownMobileHarness
} from "./testing/mobileApiHarness.js";

/** A real 1x1 PNG, so sharp can decode and re-encode what the upload sends. */
const ONE_PIXEL_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64"
);

/**
 * Which read each character route takes.
 *
 * Two rules that only work together. `ownedCharacter` loads the row and nothing
 * else, because the routes that serve picture bytes are the hottest character
 * path the app has and none of them serializes a character; every route that
 * *does* serialize one reads through `ownedCharacterWithMentions`, because
 * `mentions` is a field the editor sheet writes back — an empty one it believed
 * would PATCH away every durable link whose `@Name` is still in the prose.
 *
 * The rules are about reads, not about routes, which is why the tests below
 * count them one at a time: a route that both works and answers takes the
 * graph on the read that answers and on no other. The photo upload took it
 * twice, and the first of the two waited out a vision call before joining a
 * `LibraryMention` scan for a name.
 *
 * Its own suite because `characters.test.ts` is at its size budget, the same
 * reason `characterWriteConflicts.test.ts` is its own.
 */

function characterRecord(overrides: Record<string, unknown> = {}) {
  return {
    id: "char-1",
    userId: "user-a",
    name: "Luna",
    description: "Knows @Bram.",
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
    outgoingMentions: [
      {
        sourceCharacterId: "char-1",
        targetKind: "CHARACTER",
        targetId: "char-2",
        targetCharacterId: "char-2",
        otherType: null,
        sortOrder: 0,
        targetCharacter: { id: "char-2", name: "Bram" }
      }
    ],
    ...overrides
  };
}

const bramRef = { id: "char-2", name: "Bram", kind: "character", otherType: null };

/** Every read of the character row, and whether it asked for the graph. */
const readIncludes = () =>
  mockPrisma.libraryCharacter.findFirst.mock.calls.map((call: any[]) => "include" in call[0]);

function writeCharacterFile(fileName: string): void {
  const dir = join(state.imageStorageDir!, "characters", "user-a");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, fileName), "fake-bytes");
}

describe("character route reads", () => {
  beforeEach(() => {
    resetMobileHarness();
    mockAccessTokens({ "token-a": "user-a" });
    mockPrisma.libraryCharacter.updateMany.mockResolvedValue({ count: 1 });
  });
  afterEach(teardownMobileHarness);

  it("serves pictures, and the strip beside them, without joining the mention graph", async () => {
    mockPrisma.libraryCharacter.findFirst.mockResolvedValue(
      characterRecord({
        photoPath: "char-1-photo.webp",
        portraitPath: "char-1-portrait.webp",
        portraitStatus: "READY"
      })
    );
    writeCharacterFile("char-1-photo.webp");
    writeCharacterFile("char-1-portrait.webp");

    const app = await buildMobileApp();
    for (const kind of ["photo", "portrait"]) {
      const served = await app.inject({
        method: "GET",
        url: `/api/mobile/characters/char-1/${kind}`,
        headers: bearer("token-a")
      });
      expect(served.statusCode).toBe(200);
    }
    // The strip is the same rule one step out: it answers with images alone,
    // and every flag on one of them is about a pointer. It used to build the
    // pair and return half of it, so the grid paid for a graph nobody read.
    const strip = await app.inject({
      method: "GET",
      url: "/api/mobile/characters/char-1/images",
      headers: bearer("token-a")
    });
    expect(strip.statusCode).toBe(200);
    // A file name is all any of the three wants, and the join is a
    // `LibraryMention` scan plus a nested select on every request for a picture.
    expect(readIncludes()).toEqual([false, false, false]);
    await app.close();
  });

  it("answers with the links the row holds rather than an empty set", async () => {
    // Every route that serializes a character reads the graph. A response that
    // said `mentions: []` because its caller forgot the include is the one the
    // editor sheet seeds from, and the next description save writes that back.
    mockPrisma.libraryCharacter.findFirst.mockResolvedValue(
      characterRecord({ photoPath: "char-1-photo.webp" })
    );
    mockPrisma.libraryCharacter.update.mockImplementation(
      async ({ data }: { data: Record<string, unknown> }) => characterRecord(data)
    );
    vi.mocked(enqueueGenerationJob).mockResolvedValue({ id: "job-portrait" } as never);

    const app = await buildMobileApp();
    const photoCleared = await app.inject({
      method: "DELETE",
      url: "/api/mobile/characters/char-1/photo",
      headers: bearer("token-a")
    });
    expect(photoCleared.statusCode).toBe(200);
    expect(photoCleared.json().character.mentions).toEqual([bramRef]);

    // One read, and it joined: this route serializes the row it just cleared.
    expect(readIncludes()).toEqual([true]);

    mockPrisma.libraryCharacter.findFirst.mockClear();
    const portrait = await app.inject({
      method: "POST",
      url: "/api/mobile/characters/char-1/portrait",
      headers: bearer("token-a"),
      payload: { requestId: "portrait-request-1" }
    });
    expect(portrait.statusCode).toBe(202);
    expect(portrait.json().character.mentions).toEqual([bramRef]);

    // The priced route reads twice — the prompt's own inputs and the status it
    // is about to claim, then the row that claim moved — and only the second
    // one is serialized, so only the second one joins.
    expect(readIncludes()).toEqual([false, true]);
    await app.close();
  });

  it("uploads a photo on the cheap read, and takes the graph only to answer", async () => {
    // The upload's own read wants a name for the vision prompt and an id for
    // its writes. It sits in front of a call that may spend the whole vision
    // budget, so the join it used to take was a `LibraryMention` scan the app
    // waited on and the handler then threw away. The read that answers is the
    // one after the writes, which is also the only copy that describes them.
    mockPrisma.libraryCharacter.findFirst.mockResolvedValue(characterRecord());
    mockPrisma.libraryCharacter.update.mockResolvedValue(characterRecord());
    const app = await buildMobileApp({
      characterPhotoVision: vi.fn().mockResolvedValue({
        imageKind: "photograph",
        confidence: 0.9,
        subjectCount: 1,
        suggestedDescription: "A round-faced girl in a yellow raincoat.",
        suggestedAppearance: "Around eight, short black hair, yellow raincoat.",
        suggestedFields: []
      })
    });

    const uploaded = await app.inject({
      method: "PUT",
      url: "/api/mobile/characters/char-1/photo?filename=me.png&mimeType=image%2Fpng",
      headers: { ...bearer("token-a"), "content-type": "application/octet-stream" },
      payload: ONE_PIXEL_PNG
    });

    expect(uploaded.statusCode).toBe(200);
    // Three round trips: the upload's own read, the prune's two pointers, and
    // the one that answers.
    expect(readIncludes()).toEqual([false, false, true]);
    expect(uploaded.json().character.mentions).toEqual([bramRef]);
    await app.close();
  });

  it("answers a photo upload onto a character that vanished with a 404", async () => {
    // The pre-upload copy is not a stand-in for the row that answers: it
    // predates every write above it, so falling back to it reported
    // `hasPhoto: false` for the picture just stored — about a character that
    // is no longer in the library at all.
    mockPrisma.libraryCharacter.findFirst
      .mockResolvedValueOnce(characterRecord())
      .mockResolvedValue(null);
    mockPrisma.libraryCharacter.update.mockResolvedValue(characterRecord());
    const app = await buildMobileApp();

    const uploaded = await app.inject({
      method: "PUT",
      url: "/api/mobile/characters/char-1/photo?filename=me.png&mimeType=image%2Fpng",
      headers: { ...bearer("token-a"), "content-type": "application/octet-stream" },
      payload: ONE_PIXEL_PNG
    });

    expect(uploaded.statusCode).toBe(404);
    expect(uploaded.json().error.code).toBe("CHARACTER_NOT_FOUND");
    // The refusal is the *answer*, not an early exit: the picture was recorded
    // before the row went away, and it stays recorded.
    expect(mockPrisma.libraryCharacterImage.create).toHaveBeenCalled();
    await app.close();
  });

  it("reads the patch's own row twice, and the first time for the name alone", async () => {
    // The outer read is what the claim is built from and nothing else. It used
    // to be the whole row, which leaves a stale description in scope for the
    // length of the handler — and writing that back over one saved from another
    // device is exactly what moved the real read under the claim.
    mockPrisma.libraryCharacter.findFirst.mockResolvedValue(characterRecord());
    mockPrisma.libraryMention.findMany.mockResolvedValue([]);
    mockPrisma.libraryCharacter.update.mockImplementation(
      async ({ data }: { data: Record<string, unknown> }) => characterRecord(data)
    );

    const app = await buildMobileApp();
    const renamed = await app.inject({
      method: "PATCH",
      url: "/api/mobile/characters/char-1",
      headers: bearer("token-a"),
      payload: { name: "Lunaria" }
    });

    expect(renamed.statusCode).toBe(200);
    // Two round trips, and the graph is joined only on the one under the claim.
    expect(readIncludes()).toEqual([false, true]);
    expect(mockPrisma.libraryCharacter.findFirst.mock.calls[0]![0].select).toEqual({ id: true, name: true });
    await app.close();
  });
});
