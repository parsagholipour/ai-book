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

import { VOICE_CALL_POLICY, settleVoiceCall } from "@book-maker/core";
import { bearer, mockPrisma, teardownMobileHarness } from "./testing/mobileApiHarness.js";
import {
  buildVoiceApp,
  characterRecord,
  callRecord,
  perMinute,
  resetVoiceCallTestState
} from "./testing/voiceCallTestUtils.js";

describe("mobile voice call metering", () => {
  beforeEach(resetVoiceCallTestState);
  afterEach(teardownMobileHarness);

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

    it("floors the meter at the server's clock, whatever the client reports", async () => {
      // The audio socket never touches the server, so elapsedSeconds is the
      // client's word — a doctored app reporting 0 forever used to keep the
      // call alive without ever topping up the hold, and settle for free.
      mockPrisma.voiceCall.findFirst.mockResolvedValue(
        callRecord({ startedAt: new Date(Date.now() - 200_000) })
      );
      const app = await buildVoiceApp();

      const response = await app.inject({
        method: "POST",
        url: "/api/mobile/voice/calls/call-1/heartbeat",
        headers: bearer("token-a"),
        payload: { elapsedSeconds: 0 }
      });

      expect(response.json().meter.elapsedSeconds).toBeGreaterThanOrEqual(200);
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
      expect(vi.mocked(releaseReservationsByKeyPrefix)).toHaveBeenCalledWith(
        "mobile:voice-call:call-1:hold:",
        expect.any(String)
      );
      expect(vi.mocked(spendCredits)).toHaveBeenCalledOnce();
      expect(vi.mocked(spendCredits)).toHaveBeenCalledWith(
        expect.objectContaining({ operation: "VOICE_CALL_MINUTE", amountCredits: 2 * perMinute })
      );
      await app.close();
    });

    it("charges by the server's clock when the client understates the call", async () => {
      mockPrisma.voiceCall.findFirst.mockResolvedValue(
        callRecord({ startedAt: new Date(Date.now() - 125_000) })
      );
      vi.mocked(spendCredits).mockResolvedValue({ id: "ledger-charge" } as never);
      const app = await buildVoiceApp();

      const response = await app.inject({
        method: "POST",
        url: "/api/mobile/voice/calls/call-1/end",
        headers: bearer("token-a"),
        payload: { elapsedSeconds: 2 }
      });

      // The call has verifiably been open ~125s; two client-reported seconds
      // must not talk the settle down to free.
      expect(response.json().meter.chargedCredits).toBe(settleVoiceCall(125).credits);
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
      expect(vi.mocked(releaseReservationsByKeyPrefix)).toHaveBeenCalledWith(
        "mobile:voice-call:call-1:hold:",
        expect.any(String)
      );
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
