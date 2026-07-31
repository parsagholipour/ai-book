import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@book-maker/db", async () => (await import("./testing/mobileApiMocks.js")).dbModuleMock());
vi.mock("@book-maker/db/billing", async () => (await import("./testing/mobileApiMocks.js")).billingModuleMock());
vi.mock("../queue.js", async () => (await import("./testing/mobileApiMocks.js")).queueModuleMock());
vi.mock("../projectStatus.js", async () => (await import("./testing/mobileApiMocks.js")).projectStatusModuleMock());

import {
  InsufficientCreditsError,
  getCreditBalance,
  refundCreditLedgerEntry,
  reserveCredits,
  spendCredits
} from "@book-maker/db/billing";

import { VOICE_CALL_POLICY, creditPricing } from "@book-maker/core";
import { enqueueGenerationJob } from "../queue.js";
import {
  bearer,
  buildMobileApp,
  jobRecord,
  mockAccessTokens,
  mockPrisma,
  resetMobileHarness,
  teardownMobileHarness
} from "./testing/mobileApiHarness.js";

const perMinute = creditPricing().voiceCallPerMinute;
const openingHold = VOICE_CALL_POLICY.reserveBlockMinutes * perMinute;

function characterRecord(overrides: Record<string, unknown> = {}) {
  return {
    id: "character-1",
    projectId: "project-1",
    name: "Marlow",
    role: "The lighthouse keeper",
    description: "Keeps the light and his own counsel.",
    traits: ["weathered", "kind"],
    status: "READY",
    persona: { instructions: "You are Marlow." },
    profileImageAssetId: null,
    voiceProfile: {},
    project: { title: "The Long Night", status: "COMPLETE" },
    ...overrides
  };
}

function callRecord(overrides: Record<string, unknown> = {}) {
  return {
    id: "call-1",
    userId: "user-a",
    projectId: "project-1",
    characterId: "character-1",
    status: "ACTIVE",
    reservationEntryIds: ["ledger-1"],
    heldCredits: openingHold,
    chargedCredits: 0,
    elapsedSeconds: 0,
    ...overrides
  };
}

/** Reserves succeed with a fresh ledger id unless a test says otherwise. */
function allowReservations() {
  let entry = 0;
  vi.mocked(reserveCredits).mockImplementation(async () => {
    entry += 1;
    return { id: `ledger-${entry}` } as never;
  });
}

async function buildVoiceApp(options: Record<string, unknown> = {}) {
  return buildMobileApp({
    voiceSession: async () => ({
      type: "gemini_live_token" as const,
      token: "auth_tokens/abc",
      expiresAt: "2026-07-27T12:30:00.000Z",
      newSessionExpiresAt: "2026-07-27T12:01:00.000Z",
      provider: "gemini_live" as const,
      model: "gemini-3.1-flash-live-preview",
      voiceId: "Achird",
      metadata: {}
    }),
    ...options
  });
}

describe("mobile voice calls", () => {
  beforeEach(() => {
    resetMobileHarness();
    process.env.GEMINI_API_KEY = "test-key";
    mockAccessTokens({ "token-a": "user-a" });
    vi.mocked(getCreditBalance).mockResolvedValue({
      availableCredits: 5_000,
      reservedCredits: 0,
      lifetimeCreditsGranted: 5_000,
      lifetimeCreditsSpent: 0
    });
    mockPrisma.voiceCall.findMany.mockResolvedValue([]);
    mockPrisma.voiceCall.create.mockResolvedValue({ id: "call-1" });
    mockPrisma.voiceCall.update.mockResolvedValue({});
    mockPrisma.imageAsset.findMany.mockResolvedValue([]);
    allowReservations();
  });
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

    it("builds the persona on the first call and answers as still preparing", async () => {
      mockPrisma.voiceCharacter.findFirst.mockResolvedValue(characterRecord({ status: "CANDIDATE" }));
      mockPrisma.voiceCharacter.update.mockResolvedValue({});
      vi.mocked(enqueueGenerationJob).mockResolvedValue(jobRecord({ id: "job-persona" }));
      const app = await buildVoiceApp();

      const response = await app.inject({
        method: "POST",
        url: "/api/mobile/projects/project-1/voice/characters/character-1/calls",
        headers: bearer("token-a"),
        payload: {}
      });

      expect(response.statusCode).toBe(409);
      expect(response.json().error.code).toBe("CHARACTER_PREPARING");
      expect(vi.mocked(enqueueGenerationJob)).toHaveBeenCalledWith(
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
      vi.mocked(enqueueGenerationJob).mockResolvedValue(jobRecord({ id: "job-persona" }));
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
      expect(vi.mocked(refundCreditLedgerEntry)).toHaveBeenCalledWith("ledger-1", expect.any(String));
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

  describe("metering a live call", () => {
    it("extends the hold as the call runs, without spending", async () => {
      mockPrisma.voiceCall.findFirst.mockResolvedValue(callRecord({ elapsedSeconds: 30 }));
      const app = await buildVoiceApp();

      const response = await app.inject({
        method: "POST",
        url: "/api/mobile/voice/calls/call-1/heartbeat",
        headers: bearer("token-a"),
        payload: { elapsedSeconds: 130 }
      });

      expect(response.statusCode).toBe(200);
      const meter = response.json().meter;
      expect(meter.elapsedSeconds).toBe(130);
      expect(meter.endingSoon).toBe(false);
      // Three minutes used, so the hold has to reach three plus the block.
      expect(vi.mocked(reserveCredits)).toHaveBeenCalledWith(
        expect.objectContaining({ amountCredits: 3 * perMinute })
      );
      expect(vi.mocked(spendCredits)).not.toHaveBeenCalled();
      await app.close();
    });

    it("never lets a replayed heartbeat wind the meter back", async () => {
      mockPrisma.voiceCall.findFirst.mockResolvedValue(callRecord({ elapsedSeconds: 200 }));
      const app = await buildVoiceApp();

      const response = await app.inject({
        method: "POST",
        url: "/api/mobile/voice/calls/call-1/heartbeat",
        headers: bearer("token-a"),
        payload: { elapsedSeconds: 5 }
      });

      expect(response.json().meter.elapsedSeconds).toBe(200);
      await app.close();
    });

    it("warns the app to wind down when the hold cannot be topped up", async () => {
      mockPrisma.voiceCall.findFirst.mockResolvedValue(callRecord({ elapsedSeconds: 170, heldCredits: 3 * perMinute }));
      vi.mocked(reserveCredits).mockRejectedValue(
        new InsufficientCreditsError({ requiredCredits: perMinute, availableCredits: 0, reservedCredits: 0 })
      );
      const app = await buildVoiceApp();

      const response = await app.inject({
        method: "POST",
        url: "/api/mobile/voice/calls/call-1/heartbeat",
        headers: bearer("token-a"),
        payload: { elapsedSeconds: 175 }
      });

      expect(response.statusCode).toBe(200);
      expect(response.json().meter.endingSoon).toBe(true);
      // Named, not just flagged: the app has to tell the caller which of the
      // two things is ending the call, because only one is fixable.
      expect(response.json().meter.endingReason).toBe("credits");
      await app.close();
    });

    it("names the length cap rather than credits on a long, well-funded call", async () => {
      const nearTheCap = (VOICE_CALL_POLICY.maxCallMinutes - 1) * 60;
      mockPrisma.voiceCall.findFirst.mockResolvedValue(
        callRecord({ elapsedSeconds: nearTheCap, heldCredits: VOICE_CALL_POLICY.maxCallMinutes * perMinute })
      );
      const app = await buildVoiceApp();

      const response = await app.inject({
        method: "POST",
        url: "/api/mobile/voice/calls/call-1/heartbeat",
        headers: bearer("token-a"),
        payload: { elapsedSeconds: nearTheCap }
      });

      expect(response.json().meter.endingReason).toBe("limit");
      await app.close();
    });

    it("says nothing is ending a healthy call", async () => {
      mockPrisma.voiceCall.findFirst.mockResolvedValue(callRecord({ elapsedSeconds: 30 }));
      const app = await buildVoiceApp();

      const response = await app.inject({
        method: "POST",
        url: "/api/mobile/voice/calls/call-1/heartbeat",
        headers: bearer("token-a"),
        payload: { elapsedSeconds: 60 }
      });

      expect(response.json().meter.endingReason).toBeNull();
      expect(response.json().meter.endingSoon).toBe(false);
      await app.close();
    });

    it("does not double-count a retried heartbeat's reservation", async () => {
      mockPrisma.voiceCall.findFirst.mockResolvedValue(
        callRecord({ elapsedSeconds: 30, reservationEntryIds: ["ledger-1"] })
      );
      // A retry computes the same idempotency key and gets the existing hold
      // back. Counting it again would promise time nobody reserved.
      vi.mocked(reserveCredits).mockResolvedValue({ id: "ledger-1" } as never);
      const app = await buildVoiceApp();

      await app.inject({
        method: "POST",
        url: "/api/mobile/voice/calls/call-1/heartbeat",
        headers: bearer("token-a"),
        payload: { elapsedSeconds: 130 }
      });

      expect(mockPrisma.voiceCall.update).not.toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ heldCredits: expect.anything() }) })
      );
      await app.close();
    });

    it("does not meter a call that belongs to someone else", async () => {
      mockPrisma.voiceCall.findFirst.mockResolvedValue(null);
      const app = await buildVoiceApp();

      const response = await app.inject({
        method: "POST",
        url: "/api/mobile/voice/calls/call-1/heartbeat",
        headers: bearer("token-a"),
        payload: { elapsedSeconds: 30 }
      });

      expect(response.statusCode).toBe(404);
      await app.close();
    });
  });

  describe("ending a call", () => {
    it("releases every hold and charges once for the time spoken", async () => {
      mockPrisma.voiceCall.findFirst.mockResolvedValue(
        callRecord({ reservationEntryIds: ["ledger-1", "ledger-2"], heldCredits: 5 * perMinute })
      );
      vi.mocked(spendCredits).mockResolvedValue({ id: "ledger-charge" } as never);
      const app = await buildVoiceApp();

      const response = await app.inject({
        method: "POST",
        url: "/api/mobile/voice/calls/call-1/end",
        headers: bearer("token-a"),
        payload: { elapsedSeconds: 95 }
      });

      expect(response.statusCode).toBe(200);
      expect(response.json().meter.chargedCredits).toBe(2 * perMinute);
      expect(vi.mocked(refundCreditLedgerEntry)).toHaveBeenCalledTimes(2);
      expect(vi.mocked(spendCredits)).toHaveBeenCalledOnce();
      expect(vi.mocked(spendCredits)).toHaveBeenCalledWith(
        expect.objectContaining({ operation: "VOICE_CALL_MINUTE", amountCredits: 2 * perMinute })
      );
      await app.close();
    });

    it("charges nothing when the line dropped before anyone spoke", async () => {
      mockPrisma.voiceCall.findFirst.mockResolvedValue(callRecord());
      const app = await buildVoiceApp();

      const response = await app.inject({
        method: "POST",
        url: "/api/mobile/voice/calls/call-1/end",
        headers: bearer("token-a"),
        payload: { elapsedSeconds: 2, reason: "disconnected" }
      });

      expect(response.json().meter.chargedCredits).toBe(0);
      expect(vi.mocked(spendCredits)).not.toHaveBeenCalled();
      expect(vi.mocked(refundCreditLedgerEntry)).toHaveBeenCalledWith("ledger-1", expect.any(String));
      await app.close();
    });

    it("never charges past the promised call limit", async () => {
      mockPrisma.voiceCall.findFirst.mockResolvedValue(callRecord());
      vi.mocked(spendCredits).mockResolvedValue({ id: "ledger-charge" } as never);
      const app = await buildVoiceApp();

      const response = await app.inject({
        method: "POST",
        url: "/api/mobile/voice/calls/call-1/end",
        headers: bearer("token-a"),
        payload: { elapsedSeconds: 4 * 60 * 60 }
      });

      expect(response.json().meter.chargedCredits).toBe(VOICE_CALL_POLICY.maxCallMinutes * perMinute);
      await app.close();
    });

    it("is safe to call twice", async () => {
      mockPrisma.voiceCall.findFirst.mockResolvedValue(
        callRecord({ status: "ENDED", chargedCredits: perMinute, elapsedSeconds: 40 })
      );
      const app = await buildVoiceApp();

      const response = await app.inject({
        method: "POST",
        url: "/api/mobile/voice/calls/call-1/end",
        headers: bearer("token-a"),
        payload: { elapsedSeconds: 40 }
      });

      expect(response.statusCode).toBe(200);
      expect(response.json().meter.chargedCredits).toBe(perMinute);
      expect(vi.mocked(spendCredits)).not.toHaveBeenCalled();
      await app.close();
    });
  });

  describe("what the character remembers", () => {
    /**
     * Two different reads use `voiceCall.findMany`: the history lookup, which
     * names a character, and the sweep for the caller's own open calls, which
     * does not. Answering both with the same rows would feed transcript records
     * to the settlement path.
     */
    function mockCallHistory(rows: unknown[] | Error) {
      mockPrisma.voiceCall.findMany.mockImplementation(async (args: { where?: { characterId?: string } }) => {
        if (!args?.where?.characterId) {
          return [];
        }
        if (rows instanceof Error) {
          throw rows;
        }
        return rows;
      });
    }

    /** The transcript written by the most recent `voiceCall.update`. */
    function storedTranscript() {
      const writes = mockPrisma.voiceCall.update.mock.calls.filter(
        (call) => (call[0] as { data?: { transcript?: unknown } }).data?.transcript !== undefined
      );
      const last = writes.at(-1)?.[0] as { data: { transcript: unknown } } | undefined;
      return last?.data.transcript;
    }

    it("stores what the app heard on the heartbeat it was already sending", async () => {
      mockPrisma.voiceCall.findFirst.mockResolvedValue(callRecord({ elapsedSeconds: 30, transcript: null }));
      const app = await buildVoiceApp();

      const response = await app.inject({
        method: "POST",
        url: "/api/mobile/voice/calls/call-1/heartbeat",
        headers: bearer("token-a"),
        payload: {
          elapsedSeconds: 60,
          messages: [
            { speaker: "caller", text: "Is the light still yours?" },
            { speaker: "character", text: "It is. Has been thirty years." }
          ]
        }
      });

      expect(response.statusCode).toBe(200);
      expect(storedTranscript()).toEqual([
        { speaker: "caller", text: "Is the light still yours?" },
        { speaker: "character", text: "It is. Has been thirty years." }
      ]);
      await app.close();
    });

    it("appends to what the call already had rather than replacing it", async () => {
      mockPrisma.voiceCall.findFirst.mockResolvedValue(
        callRecord({ transcript: [{ speaker: "caller", text: "Hello?" }] })
      );
      const app = await buildVoiceApp();

      await app.inject({
        method: "POST",
        url: "/api/mobile/voice/calls/call-1/heartbeat",
        headers: bearer("token-a"),
        payload: { elapsedSeconds: 60, messages: [{ speaker: "character", text: "Marlow speaking." }] }
      });

      expect(storedTranscript()).toEqual([
        { speaker: "caller", text: "Hello?" },
        { speaker: "character", text: "Marlow speaking." }
      ]);
      await app.close();
    });

    it("does not remember a retried batch twice", async () => {
      // A heartbeat that timed out is resent whole. Without the overlap check,
      // the character reads its own last answer back as a second exchange.
      mockPrisma.voiceCall.findFirst.mockResolvedValue(
        callRecord({
          transcript: [
            { speaker: "caller", text: "Are you there?" },
            { speaker: "character", text: "I am." }
          ]
        })
      );
      const app = await buildVoiceApp();

      await app.inject({
        method: "POST",
        url: "/api/mobile/voice/calls/call-1/heartbeat",
        headers: bearer("token-a"),
        payload: {
          elapsedSeconds: 60,
          messages: [
            { speaker: "caller", text: "Are you there?" },
            { speaker: "character", text: "I am." },
            { speaker: "caller", text: "Good." }
          ]
        }
      });

      expect(storedTranscript()).toEqual([
        { speaker: "caller", text: "Are you there?" },
        { speaker: "character", text: "I am." },
        { speaker: "caller", text: "Good." }
      ]);
      await app.close();
    });

    it("keeps only the last hundred messages of a call", async () => {
      const existing = Array.from({ length: 100 }, (_, index) => ({
        speaker: "caller" as const,
        text: `line ${index}`
      }));
      mockPrisma.voiceCall.findFirst.mockResolvedValue(callRecord({ transcript: existing }));
      const app = await buildVoiceApp();

      await app.inject({
        method: "POST",
        url: "/api/mobile/voice/calls/call-1/heartbeat",
        headers: bearer("token-a"),
        payload: { elapsedSeconds: 60, messages: [{ speaker: "character", text: "the newest thing said" }] }
      });

      const stored = storedTranscript() as { text: string }[];
      expect(stored).toHaveLength(100);
      expect(stored.at(0)?.text).toBe("line 1");
      expect(stored.at(-1)?.text).toBe("the newest thing said");
      await app.close();
    });

    it("catches the last words on the way out", async () => {
      mockPrisma.voiceCall.findFirst.mockResolvedValue(callRecord({ transcript: null }));
      vi.mocked(spendCredits).mockResolvedValue({ id: "ledger-charge" } as never);
      const app = await buildVoiceApp();

      const response = await app.inject({
        method: "POST",
        url: "/api/mobile/voice/calls/call-1/end",
        headers: bearer("token-a"),
        payload: {
          elapsedSeconds: 95,
          reason: "ended",
          messages: [{ speaker: "character", text: "Call again when the weather turns." }]
        }
      });

      expect(response.statusCode).toBe(200);
      expect(storedTranscript()).toEqual([
        { speaker: "character", text: "Call again when the weather turns." }
      ]);
      await app.close();
    });

    it("will not write a transcript onto someone else's call", async () => {
      // The meter answers 404 first, but the append is scoped by user too: a
      // transcript is the one part of a call worth planting in another.
      mockPrisma.voiceCall.findFirst.mockResolvedValue(null);
      const app = await buildVoiceApp();

      const response = await app.inject({
        method: "POST",
        url: "/api/mobile/voice/calls/call-1/heartbeat",
        headers: bearer("token-a"),
        payload: { elapsedSeconds: 60, messages: [{ speaker: "caller", text: "Planted." }] }
      });

      expect(response.statusCode).toBe(404);
      expect(storedTranscript()).toBeUndefined();
      await app.close();
    });

    it("opens the next call with what was said in the last one", async () => {
      mockPrisma.voiceCharacter.findFirst.mockResolvedValue(characterRecord());
      mockCallHistory([
        {
          startedAt: new Date(Date.now() - 3 * 24 * 60 * 60 * 1000),
          transcript: [
            { speaker: "caller", text: "Did you ever leave the island?" },
            { speaker: "character", text: "Once. It did not take." }
          ]
        }
      ]);
      const voiceSession = vi.fn().mockResolvedValue({
        type: "gemini_live_token",
        token: "auth_tokens/abc",
        expiresAt: "2026-07-28T12:30:00.000Z",
        newSessionExpiresAt: "2026-07-28T12:01:00.000Z",
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
        payload: {}
      });

      const instructions = voiceSession.mock.calls[0]?.[0].instructions as string;
      expect(instructions).toContain("Did you ever leave the island?");
      expect(instructions).toContain("3 days ago");
      // Memory, not resumption: the point is that this is a fresh conversation.
      expect(instructions).toContain("This is a new call, not a continuation");
      // And scoped to this reader and this character.
      expect(mockPrisma.voiceCall.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { userId: "user-a", characterId: "character-1" } })
      );
      await app.close();
    });

    it("says nothing about earlier calls on the first one", async () => {
      mockPrisma.voiceCharacter.findFirst.mockResolvedValue(characterRecord());
      mockCallHistory([]);
      const voiceSession = vi.fn().mockResolvedValue({
        type: "gemini_live_token",
        token: "auth_tokens/abc",
        expiresAt: "2026-07-28T12:30:00.000Z",
        newSessionExpiresAt: "2026-07-28T12:01:00.000Z",
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
        payload: {}
      });

      const instructions = voiceSession.mock.calls[0]?.[0].instructions as string;
      expect(instructions).not.toContain("Earlier calls");
      expect(instructions).not.toContain("You have spoken with this reader before");
      await app.close();
    });

    it("still places the call when the history cannot be read", async () => {
      mockPrisma.voiceCharacter.findFirst.mockResolvedValue(characterRecord());
      mockCallHistory(new Error("history unavailable"));
      const app = await buildVoiceApp();

      const response = await app.inject({
        method: "POST",
        url: "/api/mobile/projects/project-1/voice/characters/character-1/calls",
        headers: bearer("token-a"),
        payload: {}
      });

      expect(response.statusCode).toBe(200);
      await app.close();
    });
  });
});
