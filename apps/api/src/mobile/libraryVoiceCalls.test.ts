import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@book-maker/db", async () => (await import("./testing/mobileApiMocks.js")).dbModuleMock());
vi.mock("@book-maker/db/billing", async () => (await import("./testing/mobileApiMocks.js")).billingModuleMock());
vi.mock("../queue.js", async () => (await import("./testing/mobileApiMocks.js")).queueModuleMock());
vi.mock("../projectStatus.js", async () => (await import("./testing/mobileApiMocks.js")).projectStatusModuleMock());

import { InsufficientCreditsError, reserveCredits, spendCredits } from "@book-maker/db/billing";
import { bearer, mockPrisma, teardownMobileHarness } from "./testing/mobileApiHarness.js";
import { buildVoiceApp, callRecord, openingHold, perMinute, resetVoiceCallTestState } from "./testing/voiceCallTestUtils.js";

/**
 * Calling one of the reader's own saved characters, outside any book.
 *
 * The book suite (`voiceCalls.test.ts`) owns the meter; what this one pins is
 * everything the library callee does differently — no project on the row or
 * the ledger, a persona composed from the reader's notes rather than built by
 * a job, and a memory keyed by the library character — and everything it must
 * do the same.
 */

function libraryRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "lib-1",
    userId: "user-a",
    name: "Mina Park",
    description: "Brave and curious, always muddy. Cousin of @Bram.",
    fields: [{ key: "Age", value: "9" }],
    appearance: "A yellow raincoat and red boots.",
    photoPath: "photo.jpg",
    photoKind: "ILLUSTRATION",
    suggestedDescription: null,
    portraitPath: "portrait.png",
    portraitSource: "GENERATED",
    portraitStatus: "READY",
    portraitError: null,
    portraitJobId: null,
    createdAt: new Date("2026-08-01T10:00:00.000Z"),
    updatedAt: new Date("2026-08-01T10:00:00.000Z"),
    outgoingMentions: [
      {
        sourceCharacterId: "lib-1",
        targetKind: "CHARACTER",
        targetId: "lib-2",
        targetCharacterId: "lib-2",
        otherType: null,
        sortOrder: 0,
        targetCharacter: { id: "lib-2", name: "Bram" }
      }
    ],
    ...overrides
  };
}

function bramRow() {
  return libraryRow({
    id: "lib-2",
    name: "Bram",
    description: "Mina's older cousin, a worrier.",
    fields: [],
    appearance: null,
    photoPath: null,
    portraitPath: null,
    portraitStatus: "NONE",
    outgoingMentions: []
  });
}

function sessionMint() {
  return vi.fn().mockResolvedValue({
    type: "gemini_live_token",
    token: "auth_tokens/abc",
    expiresAt: "2026-07-27T12:30:00.000Z",
    newSessionExpiresAt: "2026-07-27T12:01:00.000Z",
    provider: "gemini_live",
    model: "gemini-3.1-flash-live-preview",
    voiceId: "Achird",
    metadata: {}
  });
}

async function startLibraryCall(app: Awaited<ReturnType<typeof buildVoiceApp>>, payload: Record<string, unknown> = {}) {
  return app.inject({
    method: "POST",
    url: "/api/mobile/voice/characters/lib-1/calls",
    headers: bearer("token-a"),
    payload
  });
}

describe("library voice calls", () => {
  beforeEach(() => {
    resetVoiceCallTestState();
    mockPrisma.libraryCharacter.findFirst.mockResolvedValue(libraryRow());
    mockPrisma.libraryCharacter.findMany.mockResolvedValue([]);
    mockPrisma.libraryMention.findMany.mockResolvedValue([]);
    mockPrisma.libraryCharacterImage.findMany.mockResolvedValue([]);
  });
  afterEach(teardownMobileHarness);

  describe("the cast", () => {
    it("lists every saved character as ready, with what a call costs", async () => {
      mockPrisma.libraryCharacter.findMany.mockResolvedValue([libraryRow(), bramRow()]);
      const app = await buildVoiceApp();

      const response = await app.inject({
        method: "GET",
        url: "/api/mobile/voice/characters",
        headers: bearer("token-a")
      });

      expect(response.statusCode).toBe(200);
      const cast = response.json().cast;
      expect(cast.characters).toHaveLength(2);
      expect(cast.characters[0]).toMatchObject({
        id: "lib-1",
        projectId: null,
        name: "Mina Park",
        status: "ready",
        needsPreparation: false,
        libraryCharacterId: "lib-1"
      });
      expect(cast.creditsPerMinute).toBe(perMinute);
      expect(cast.creditsToStart).toBe(openingHold);
      expect(cast.availableCredits).toBe(5_000);
      // Only the reader's own library, and the description's links ride along
      // so the `@` markers can be stripped.
      expect(mockPrisma.libraryCharacter.findMany.mock.calls[0]?.[0]).toMatchObject({
        where: { userId: "user-a" },
        include: { outgoingMentions: expect.anything() }
      });
      await app.close();
    });

    it("strips the @ markers out of the description it shows", async () => {
      mockPrisma.libraryCharacter.findMany.mockResolvedValue([libraryRow()]);
      const app = await buildVoiceApp();

      const response = await app.inject({
        method: "GET",
        url: "/api/mobile/voice/characters",
        headers: bearer("token-a")
      });

      expect(response.json().cast.characters[0].description).toBe(
        "Brave and curious, always muddy. Cousin of Bram."
      );
      await app.close();
    });

    it("draws the profile's main picture through its immutable retained-image URL", async () => {
      mockPrisma.libraryCharacter.findMany.mockResolvedValue([libraryRow(), bramRow()]);
      mockPrisma.libraryCharacterImage.findMany.mockResolvedValue([
        { id: "img-old", characterId: "lib-1", fileName: "photo.jpg" },
        { id: "img-portrait", characterId: "lib-1", fileName: "portrait.png" }
      ]);
      const app = await buildVoiceApp();

      const response = await app.inject({
        method: "GET",
        url: "/api/mobile/voice/characters",
        headers: bearer("token-a")
      });

      const [mina, bram] = response.json().cast.characters;
      // The reference outranks the photo, exactly as it does on the profile.
      expect(mina.libraryPortraitUrl).toBe("/api/mobile/characters/lib-1/images/img-portrait");
      expect(mina.image).toBeNull();
      expect(bram.libraryPortraitUrl).toBeNull();
      await app.close();
    });

    it("falls back to the alias URL for a picture retained before images had rows", async () => {
      mockPrisma.libraryCharacter.findMany.mockResolvedValue([
        libraryRow({ portraitPath: null, portraitStatus: "NONE" })
      ]);
      const app = await buildVoiceApp();

      const response = await app.inject({
        method: "GET",
        url: "/api/mobile/voice/characters",
        headers: bearer("token-a")
      });

      expect(response.json().cast.characters[0].libraryPortraitUrl).toBe("/api/mobile/characters/lib-1/photo");
      await app.close();
    });
  });

  describe("starting a call", () => {
    it("holds credits with no project and hands back the same session a book call gets", async () => {
      const app = await buildVoiceApp();

      const response = await startLibraryCall(app);

      expect(response.statusCode).toBe(200);
      expect(response.json().session).toMatchObject({
        callId: "call-1",
        characterId: "lib-1",
        characterName: "Mina Park",
        token: "auth_tokens/abc",
        inputSampleRate: 16000,
        outputSampleRate: 24000,
        creditsPerMinute: perMinute
      });
      // The row names the library callee and nothing of a book.
      expect(mockPrisma.voiceCall.create.mock.calls[0]?.[0].data).toMatchObject({
        userId: "user-a",
        libraryCharacterId: "lib-1",
        status: "ACTIVE"
      });
      expect(mockPrisma.voiceCall.create.mock.calls[0]?.[0].data).not.toHaveProperty("projectId");
      expect(mockPrisma.voiceCall.create.mock.calls[0]?.[0].data).not.toHaveProperty("characterId");
      expect(vi.mocked(reserveCredits)).toHaveBeenCalledWith(
        expect.objectContaining({ operation: "VOICE_CALL_MINUTE", amountCredits: openingHold, projectId: null })
      );
      expect(vi.mocked(spendCredits)).not.toHaveBeenCalled();
      await app.close();
    });

    it("composes the persona from the reader's own notes, with no job and no waiting", async () => {
      const voiceSession = sessionMint();
      const app = await buildVoiceApp({ voiceSession });

      const response = await startLibraryCall(app);

      expect(response.statusCode).toBe(200);
      const request = voiceSession.mock.calls[0]?.[0];
      const instructions = request.instructions as string;
      expect(instructions).toContain("You are Mina Park, a character the caller created themselves");
      expect(instructions).toContain("Brave and curious, always muddy. Cousin of Bram.");
      expect(instructions).not.toContain("@Bram");
      expect(instructions).toContain("What you look like: A yellow raincoat and red boots.");
      expect(instructions).toContain("Age: 9.");
      expect(instructions).toContain("no plot to protect and nothing to spoil");
      expect(instructions).toContain("live phone call with the person who created you");
      // Nine, per the notes: the voice follows the same inference a plan
      // character's does.
      expect(request.voiceProfile).toMatchObject({ ageBand: "child" });
      expect(mockPrisma.voiceCharacter.update).not.toHaveBeenCalled();
      await app.close();
    });

    it("grounds the character in the saved characters linked to it, in both directions", async () => {
      // Mina mentions Bram; Sol mentions Mina and is mentioned by nobody.
      mockPrisma.libraryMention.findMany.mockResolvedValue([{ sourceCharacterId: "lib-3" }]);
      mockPrisma.libraryCharacter.findMany.mockResolvedValue([
        libraryRow({
          id: "lib-3",
          name: "Sol",
          description: "Knows @Mina Park from school.",
          outgoingMentions: [
            {
              sourceCharacterId: "lib-3",
              targetKind: "CHARACTER",
              targetId: "lib-1",
              targetCharacterId: "lib-1",
              otherType: null,
              sortOrder: 0,
              targetCharacter: { id: "lib-1", name: "Mina Park" }
            }
          ]
        }),
        bramRow()
      ]);
      const voiceSession = sessionMint();
      const app = await buildVoiceApp({ voiceSession });

      await startLibraryCall(app);

      const instructions = voiceSession.mock.calls[0]?.[0].instructions as string;
      expect(instructions).toContain("People you know — the caller's other saved characters:");
      expect(instructions).toContain("- Bram: Mina's older cousin, a worrier.");
      expect(instructions).toContain("- Sol: Knows Mina Park from school.");
      expect(instructions.indexOf("- Bram")).toBeLessThan(instructions.indexOf("- Sol"));
      expect(mockPrisma.libraryCharacter.findMany.mock.calls[0]?.[0].where).toMatchObject({
        id: { in: ["lib-2", "lib-3"] },
        userId: "user-a"
      });
      await app.close();
    });

    it("remembers earlier calls by the library character, never by a book's cast row", async () => {
      mockPrisma.voiceCall.findMany.mockImplementation(async (args: { where: Record<string, unknown> }) =>
        args.where.status === "ACTIVE"
          ? []
          : [
              {
                startedAt: new Date(Date.now() - 60 * 60 * 1000),
                transcript: [{ speaker: "caller", text: "Remember the raincoat." }]
              }
            ]
      );
      const voiceSession = sessionMint();
      const app = await buildVoiceApp({ voiceSession });

      await startLibraryCall(app);

      const historyRead = mockPrisma.voiceCall.findMany.mock.calls.find(
        (call) => call[0]?.where?.status !== "ACTIVE"
      );
      expect(historyRead?.[0].where).toEqual({ userId: "user-a", libraryCharacterId: "lib-1" });
      const instructions = voiceSession.mock.calls[0]?.[0].instructions as string;
      expect(instructions).toContain("You have spoken with this reader before.");
      expect(instructions).toContain("Remember the raincoat.");
      await app.close();
    });

    it("is never scoped to a page, whatever the app sends", async () => {
      // There is no book, so there is no spoiler guard to raise and no page
      // to read: a stray `pageIndex` changes nothing.
      const voiceSession = sessionMint();
      const app = await buildVoiceApp({ voiceSession });

      const response = await startLibraryCall(app, { pageIndex: 3 });

      expect(response.statusCode).toBe(200);
      expect(mockPrisma.page.findFirst).not.toHaveBeenCalled();
      const instructions = voiceSession.mock.calls[0]?.[0].instructions as string;
      expect(instructions).not.toContain("currently on page");
      expect(instructions).not.toContain("do not reveal");
      await app.close();
    });

    it("refuses to call a character that is not in the reader's library", async () => {
      mockPrisma.libraryCharacter.findFirst.mockResolvedValue(null);
      const app = await buildVoiceApp();

      const response = await startLibraryCall(app);

      expect(response.statusCode).toBe(404);
      expect(response.json().error.code).toBe("CHARACTER_NOT_FOUND");
      expect(mockPrisma.libraryCharacter.findFirst.mock.calls[0]?.[0].where).toEqual({
        id: "lib-1",
        userId: "user-a"
      });
      await app.close();
    });

    it("sends a user who cannot cover a call to the paywall", async () => {
      vi.mocked(reserveCredits).mockRejectedValue(
        new InsufficientCreditsError({ requiredCredits: openingHold, availableCredits: 10, reservedCredits: 0 })
      );
      mockPrisma.voiceCall.delete.mockResolvedValue({});
      const app = await buildVoiceApp();

      const response = await startLibraryCall(app);

      expect(response.statusCode).toBe(402);
      expect(response.json().error.code).toBe("INSUFFICIENT_CREDITS");
      await app.close();
    });

    it("counts against the same call budget as a book call", async () => {
      const app = await buildVoiceApp({ voiceCallRateLimit: { maxAttempts: 1, windowMs: 60_000 } });

      const first = await startLibraryCall(app);
      const second = await startLibraryCall(app);

      expect(first.statusCode).toBe(200);
      expect(second.statusCode).toBe(429);
      await app.close();
    });
  });

  describe("ending a call", () => {
    it("settles a library call on the ledger with no project", async () => {
      mockPrisma.voiceCall.findFirst.mockResolvedValue(
        callRecord({ projectId: null, characterId: null, libraryCharacterId: "lib-1", elapsedSeconds: 130 })
      );
      vi.mocked(spendCredits).mockResolvedValue({ id: "ledger-spend" } as never);
      const app = await buildVoiceApp();

      const response = await app.inject({
        method: "POST",
        url: "/api/mobile/voice/calls/call-1/end",
        headers: bearer("token-a"),
        payload: { elapsedSeconds: 130 }
      });

      expect(response.statusCode).toBe(200);
      expect(vi.mocked(spendCredits)).toHaveBeenCalledWith(
        expect.objectContaining({
          projectId: null,
          operation: "VOICE_CALL_MINUTE",
          metadata: expect.objectContaining({ characterId: null, libraryCharacterId: "lib-1" })
        })
      );
      await app.close();
    });
  });
});
