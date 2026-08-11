import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@book-maker/db", async () => (await import("./testing/mobileApiMocks.js")).dbModuleMock());
vi.mock("@book-maker/db/billing", async () => (await import("./testing/mobileApiMocks.js")).billingModuleMock());
vi.mock("../queue.js", async () => (await import("./testing/mobileApiMocks.js")).queueModuleMock());
vi.mock("../projectStatus.js", async () => (await import("./testing/mobileApiMocks.js")).projectStatusModuleMock());

import {
  InsufficientCreditsError,
  releaseReservationsByKeyPrefix,
  reserveCredits,
  spendCredits
} from "@book-maker/db/billing";

import { VOICE_CALL_POLICY } from "@book-maker/core";
import { enqueueOrRequeueGenerationJob } from "../queue.js";
import { bearer, jobRecord, mockPrisma, teardownMobileHarness } from "./testing/mobileApiHarness.js";
import {
  buildVoiceApp,
  characterRecord,
  callRecord,
  openingHold,
  perMinute,
  resetVoiceCallTestState
} from "./testing/voiceCallTestUtils.js";

describe("mobile voice calls", () => {
  beforeEach(resetVoiceCallTestState);
  afterEach(teardownMobileHarness);

  describe("the cast", () => {
    it("lists the characters of a finished book with what a call costs", async () => {
      mockPrisma.project.findFirst.mockResolvedValue({ id: "project-1", status: "COMPLETE" });
      mockPrisma.voiceCharacter.findMany.mockResolvedValue([characterRecord()]);
      const app = await buildVoiceApp();

      const response = await app.inject({
        method: "GET",
        url: "/api/mobile/projects/project-1/voice/cast",
        headers: bearer("token-a")
      });

      expect(response.statusCode).toBe(200);
      const cast = response.json().cast;
      expect(cast.characters).toHaveLength(1);
      expect(cast.characters[0]).toMatchObject({ name: "Marlow", status: "ready" });
      expect(cast.creditsPerMinute).toBe(perMinute);
      expect(cast.creditsToStart).toBe(openingHold);
      expect(cast.availableCredits).toBe(5_000);
      await app.close();
    });

    it("keeps the provider, model and persona out of the response", async () => {
      mockPrisma.project.findFirst.mockResolvedValue({ id: "project-1", status: "COMPLETE" });
      mockPrisma.voiceCharacter.findMany.mockResolvedValue([characterRecord()]);
      const app = await buildVoiceApp();

      const response = await app.inject({
        method: "GET",
        url: "/api/mobile/projects/project-1/voice/cast",
        headers: bearer("token-a")
      });

      const body = response.payload;
      expect(body).not.toContain("gemini");
      expect(body).not.toContain("persona");
      expect(body).not.toContain("You are Marlow");
      await app.close();
    });

    it("returns an empty cast while the book is still being written", async () => {
      mockPrisma.project.findFirst.mockResolvedValue({ id: "project-1", status: "GENERATING" });
      const app = await buildVoiceApp();

      const response = await app.inject({
        method: "GET",
        url: "/api/mobile/projects/project-1/voice/cast",
        headers: bearer("token-a")
      });

      expect(response.statusCode).toBe(200);
      expect(response.json().cast.characters).toEqual([]);
      expect(mockPrisma.voiceCharacter.findMany).not.toHaveBeenCalled();
      await app.close();
    });

    it("does not expose another user's cast", async () => {
      mockPrisma.project.findFirst.mockResolvedValue(null);
      const app = await buildVoiceApp();

      const response = await app.inject({
        method: "GET",
        url: "/api/mobile/projects/project-1/voice/cast",
        headers: bearer("token-a")
      });

      expect(response.statusCode).toBe(404);
      await app.close();
    });
  });

  describe("starting a call", () => {
    it("holds credits and hands back connection details for the app's own socket", async () => {
      mockPrisma.voiceCharacter.findFirst.mockResolvedValue(characterRecord());
      const app = await buildVoiceApp();

      const response = await app.inject({
        method: "POST",
        url: "/api/mobile/projects/project-1/voice/characters/character-1/calls",
        headers: bearer("token-a"),
        payload: {}
      });

      expect(response.statusCode).toBe(200);
      const session = response.json().session;
      expect(session).toMatchObject({
        callId: "call-1",
        characterName: "Marlow",
        token: "auth_tokens/abc",
        inputSampleRate: 16000,
        outputSampleRate: 24000,
        creditsPerMinute: perMinute
      });
      expect(session.secondsRemaining).toBe(VOICE_CALL_POLICY.reserveBlockMinutes * 60);
      expect(vi.mocked(reserveCredits)).toHaveBeenCalledWith(
        expect.objectContaining({ operation: "VOICE_CALL_MINUTE", amountCredits: openingHold })
      );
      // Nothing is spent up front: a call that never happens must not cost.
      expect(vi.mocked(spendCredits)).not.toHaveBeenCalled();
      await app.close();
    });

    it("scopes the character to the page the reader is on", async () => {
      mockPrisma.voiceCharacter.findFirst.mockResolvedValue(characterRecord());
      mockPrisma.page.findFirst.mockResolvedValue({
        index: 12,
        title: "The storm",
        markdown: "The lamp guttered as the wind came off the water."
      });
      const voiceSession = vi.fn().mockResolvedValue({
        type: "gemini_live_token",
        token: "auth_tokens/abc",
        expiresAt: "2026-07-27T12:30:00.000Z",
        newSessionExpiresAt: "2026-07-27T12:01:00.000Z",
        provider: "gemini_live",
        model: "gemini-3.1-flash-live-preview",
        voiceId: "Achird",
        metadata: {}
      });
      const app = await buildVoiceApp({ voiceSession });

      await app.inject({
        method: "POST",
        url: "/api/mobile/projects/project-1/voice/characters/character-1/calls",
        headers: bearer("token-a"),
        payload: { pageIndex: 12 }
      });

      const instructions = voiceSession.mock.calls[0]?.[0].instructions as string;
      expect(instructions).toContain("page 13");
      expect(instructions).toContain("The lamp guttered");
      // The spoiler guard is the point of sending the page at all.
      expect(instructions).toContain("do not reveal");
      await app.close();
    });

    it("grounds an existing persona in the other characters from the same book", async () => {
      mockPrisma.voiceCharacter.findFirst.mockResolvedValue(
        characterRecord({
          name: "Harry Potter",
          persona: { instructions: "You are Harry Potter." }
        })
      );
      mockPrisma.voiceCharacter.findMany.mockResolvedValue([
        {
          name: "Harry Potter",
          role: "Visiting wizard",
          description: "Fights beside the heroes."
        },
        {
          name: "Rostam",
          role: "Main hero",
          description: "The champion at the center of the battle."
        }
      ]);
      const voiceSession = vi.fn().mockResolvedValue({
        type: "gemini_live_token",
        token: "auth_tokens/abc",
        expiresAt: "2026-07-27T12:30:00.000Z",
        newSessionExpiresAt: "2026-07-27T12:01:00.000Z",
        provider: "gemini_live",
        model: "gemini-3.1-flash-live-preview",
        voiceId: "Achird",
        metadata: {}
      });
      const app = await buildVoiceApp({ voiceSession });

      const response = await app.inject({
        method: "POST",
        url: "/api/mobile/projects/project-1/voice/characters/character-1/calls",
        headers: bearer("token-a"),
        payload: {}
      });

      expect(response.statusCode).toBe(200);
      const instructions = voiceSession.mock.calls[0]?.[0].instructions as string;
      expect(instructions).toContain("Rostam: Main hero The champion at the center of the battle.");
      expect(instructions).toContain("recognize every listed character");
      await app.close();
    });

    it("builds the persona on the first call and answers as still preparing", async () => {
      mockPrisma.voiceCharacter.findFirst.mockResolvedValue(characterRecord({ status: "CANDIDATE" }));
      mockPrisma.voiceCharacter.update.mockResolvedValue({});
      vi.mocked(enqueueOrRequeueGenerationJob).mockResolvedValue(jobRecord({ id: "job-persona" }));
      const app = await buildVoiceApp();

      const response = await app.inject({
        method: "POST",
        url: "/api/mobile/projects/project-1/voice/characters/character-1/calls",
        headers: bearer("token-a"),
        payload: {}
      });

      expect(response.statusCode).toBe(409);
      expect(response.json().error.code).toBe("CHARACTER_PREPARING");
      // Or-requeue, not the plain enqueue: a FAILED build has already spent
      // the dedupe key, and answering with that row enqueues nothing —
      // "getting ready" forever with no way to move it from the app.
      expect(vi.mocked(enqueueOrRequeueGenerationJob)).toHaveBeenCalledWith(
        expect.objectContaining({ type: "BUILD_CHARACTER_PERSONA" })
      );
      // Nothing was held for a call that could not be placed.
      expect(vi.mocked(reserveCredits)).not.toHaveBeenCalled();
      await app.close();
    });

    it("does not spend rate-limit budget on a character that is still preparing", async () => {
      // The app polls while a persona builds. Charging those replies against
      // the budget let one first-time call lock the user out for an hour.
      mockPrisma.voiceCharacter.findFirst.mockResolvedValue(characterRecord({ status: "CANDIDATE" }));
      mockPrisma.voiceCharacter.update.mockResolvedValue({});
      vi.mocked(enqueueOrRequeueGenerationJob).mockResolvedValue(jobRecord({ id: "job-persona" }));
      const app = await buildVoiceApp({ voiceCallRateLimit: { maxAttempts: 2, windowMs: 60_000 } });

      for (let attempt = 0; attempt < 5; attempt += 1) {
        const response = await app.inject({
          method: "POST",
          url: "/api/mobile/projects/project-1/voice/characters/character-1/calls",
          headers: bearer("token-a"),
          payload: {}
        });
        expect(response.statusCode).toBe(409);
        expect(response.json().error.code).toBe("CHARACTER_PREPARING");
      }

      // The budget is untouched, so the call still goes through once ready.
      mockPrisma.voiceCharacter.findFirst.mockResolvedValue(characterRecord());
      const ready = await app.inject({
        method: "POST",
        url: "/api/mobile/projects/project-1/voice/characters/character-1/calls",
        headers: bearer("token-a"),
        payload: {}
      });
      expect(ready.statusCode).toBe(200);
      await app.close();
    });

    it("does not share the book-generation budget", async () => {
      // Voice calls are metered in credits; the limiter is only there to stop a
      // runaway client, and must not ration book writing.
      mockPrisma.voiceCharacter.findFirst.mockResolvedValue(characterRecord());
      const app = await buildVoiceApp({ generationRateLimit: { maxAttempts: 1, windowMs: 60_000 } });

      for (let attempt = 0; attempt < 3; attempt += 1) {
        const response = await app.inject({
          method: "POST",
          url: "/api/mobile/projects/project-1/voice/characters/character-1/calls",
          headers: bearer("token-a"),
          payload: {}
        });
        expect(response.statusCode).toBe(200);
      }
      await app.close();
    });

    it("still rate limits a client that will not stop calling", async () => {
      mockPrisma.voiceCharacter.findFirst.mockResolvedValue(characterRecord());
      const app = await buildVoiceApp({ voiceCallRateLimit: { maxAttempts: 1, windowMs: 60_000 } });

      const first = await app.inject({
        method: "POST",
        url: "/api/mobile/projects/project-1/voice/characters/character-1/calls",
        headers: bearer("token-a"),
        payload: {}
      });
      const second = await app.inject({
        method: "POST",
        url: "/api/mobile/projects/project-1/voice/characters/character-1/calls",
        headers: bearer("token-a"),
        payload: {}
      });

      expect(first.statusCode).toBe(200);
      expect(second.statusCode).toBe(429);
      await app.close();
    });

    it("refuses a call on a book that is not finished", async () => {
      mockPrisma.voiceCharacter.findFirst.mockResolvedValue(
        characterRecord({ project: { title: "The Long Night", status: "GENERATING" } })
      );
      const app = await buildVoiceApp();

      const response = await app.inject({
        method: "POST",
        url: "/api/mobile/projects/project-1/voice/characters/character-1/calls",
        headers: bearer("token-a"),
        payload: {}
      });

      expect(response.statusCode).toBe(409);
      expect(response.json().error.code).toBe("BOOK_NOT_READY");
      await app.close();
    });

    it("sends a user who cannot cover a call to the paywall", async () => {
      mockPrisma.voiceCharacter.findFirst.mockResolvedValue(characterRecord());
      vi.mocked(reserveCredits).mockRejectedValue(
        new InsufficientCreditsError({ requiredCredits: openingHold, availableCredits: 10, reservedCredits: 0 })
      );
      mockPrisma.voiceCall.delete.mockResolvedValue({});
      const app = await buildVoiceApp();

      const response = await app.inject({
        method: "POST",
        url: "/api/mobile/projects/project-1/voice/characters/character-1/calls",
        headers: bearer("token-a"),
        payload: {}
      });

      expect(response.statusCode).toBe(402);
      expect(response.json().error.code).toBe("INSUFFICIENT_CREDITS");
      await app.close();
    });

    it("releases the hold when the provider will not connect", async () => {
      mockPrisma.voiceCharacter.findFirst.mockResolvedValue(characterRecord());
      mockPrisma.voiceCall.findFirst.mockResolvedValue(callRecord());
      const app = await buildVoiceApp({
        voiceSession: async () => {
          throw new Error("Gemini Live is unavailable.");
        }
      });

      const response = await app.inject({
        method: "POST",
        url: "/api/mobile/projects/project-1/voice/characters/character-1/calls",
        headers: bearer("token-a"),
        payload: {}
      });

      expect(response.statusCode).toBe(503);
      // Released by key prefix, which also frees a hold whose pointer write
      // never landed — the row cannot name what a crash orphaned.
      expect(vi.mocked(releaseReservationsByKeyPrefix)).toHaveBeenCalledWith(
        "mobile:voice-call:call-1:hold:",
        expect.any(String)
      );
      // A call that never connected is free.
      expect(vi.mocked(spendCredits)).not.toHaveBeenCalled();
      await app.close();
    });

    it("refuses to call a character from someone else's book", async () => {
      mockPrisma.voiceCharacter.findFirst.mockResolvedValue(null);
      const app = await buildVoiceApp();

      const response = await app.inject({
        method: "POST",
        url: "/api/mobile/projects/project-1/voice/characters/character-1/calls",
        headers: bearer("token-a"),
        payload: {}
      });

      expect(response.statusCode).toBe(404);
      await app.close();
    });
  });
});
