import { vi } from "vitest";
import { getCreditBalance, reserveCredits } from "@book-maker/db/billing";
import { VOICE_CALL_POLICY, creditPricing } from "@book-maker/core";
import {
  buildMobileApp,
  creditBalance,
  mockAccessTokens,
  mockPrisma,
  resetMobileHarness
} from "./mobileApiHarness.js";

/**
 * Fixtures shared by the voice-call suites (voiceCalls.test.ts and
 * voiceCallMetering.test.ts). Imported from the test files only, after their
 * vi.mock declarations, so every module here resolves through the same mock
 * registry the suites set up.
 */

export const perMinute = creditPricing().voiceCallPerMinute;
export const openingHold = VOICE_CALL_POLICY.reserveBlockMinutes * perMinute;

export function characterRecord(overrides: Record<string, unknown> = {}) {
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

export function callRecord(overrides: Record<string, unknown> = {}) {
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
    // Fresh by default so the server-clock floor stays out of the way of tests
    // about the client-reported meter; the wall-clock tests override these.
    startedAt: new Date(),
    lastHeartbeatAt: new Date(),
    ...overrides
  };
}

/** Reserves succeed with a fresh ledger id unless a test says otherwise. */
export function allowReservations() {
  let entry = 0;
  vi.mocked(reserveCredits).mockImplementation(async (options: { amountCredits: number }) => {
    entry += 1;
    // Reservations are stored as negative rows; the caller reads the entry's
    // own amount back when summing what a call holds.
    return { id: `ledger-${entry}`, amountCredits: -options.amountCredits } as never;
  });
}

export async function buildVoiceApp(options: Record<string, unknown> = {}) {
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

/** The shared beforeEach body: a fresh harness with a funded, callable user. */
export function resetVoiceCallTestState() {
  resetMobileHarness();
  process.env.GEMINI_API_KEY = "test-key";
  mockAccessTokens({ "token-a": "user-a" });
  vi.mocked(getCreditBalance).mockResolvedValue(creditBalance({ availableCredits: 5_000 }));
  mockPrisma.voiceCall.findMany.mockResolvedValue([]);
  mockPrisma.voiceCall.create.mockResolvedValue({ id: "call-1" });
  mockPrisma.voiceCall.update.mockResolvedValue({});
  mockPrisma.imageAsset.findMany.mockResolvedValue([]);
  allowReservations();
}
