import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_CREDIT_COSTS, resetCreditPricing, setCreditPricing } from "@book-maker/core";

const db = await vi.hoisted(async () => (await import("./testing/voiceRelayTestDb.ts")).createVoiceRelayTestDb());
vi.mock("./client.ts", () => ({ prisma: db.prisma, Prisma: db.Prisma }));
const {
  startVoiceRelayCall, saveVoiceRelaySession, claimVoiceRelayCall, authorizeVoiceRelay,
  readVoiceRelayMeter, requestVoiceRelayEnd, finishVoiceRelay, recoverVoiceRelayCalls
} = await import("./voiceRelayBilling.ts");
const { getCreditBalance } = await import("./billingLedger.ts");
const epoch = new Date("2026-10-04T12:00:00Z");
const at = (seconds: number) => new Date(epoch.getTime() + seconds * 1000);
const tokenHash = "a".repeat(64);
const start = () => startVoiceRelayCall({ userId: "user-a", callee: { libraryCharacterId: "lib-1" }, tokenHash });
const balance = () => getCreditBalance("user-a");

beforeEach(() => {
  db.reset(); vi.useFakeTimers(); vi.setSystemTime(epoch);
  setCreditPricing({ ...DEFAULT_CREDIT_COSTS, welcomeCreditsEnabled: 0, voiceCallPerMinute: 10 });
  db.state.accounts.set("user-a", {
    userId: "user-a", availableCredits: 1000, reservedCredits: 0, lifetimeCreditsGranted: 1000,
    lifetimeCreditsSpent: 0, planCredits: 0, planCreditsPerPeriod: 0,
    planPeriodStart: null, planPeriodEnd: null, planPeriodKey: null
  });
});
afterEach(() => { resetCreditPricing(); vi.useRealTimers(); });

async function connect() {
  const call = await start();
  await saveVoiceRelaySession(call.id, "user-a", { token: "private-provider-token", model: "model", expiresAt: at(1800).toISOString() });
  const claim = await claimVoiceRelayCall(call.id, tokenHash);
  await authorizeVoiceRelay(claim.lease);
  return claim;
}
async function runUntil(lease: Parameters<typeof authorizeVoiceRelay>[0], seconds: number) {
  for (let second = 5; second <= seconds; second += 5) {
    vi.setSystemTime(at(second));
    await authorizeVoiceRelay(lease);
  }
}

describe("funded provider access", () => {
  it("charges a ten-minute call without any client heartbeat or claimed duration", async () => {
    const { lease } = await connect();
    await runUntil(lease, 600);
    expect(await readVoiceRelayMeter(lease.callId, "user-a")).toMatchObject({ elapsedSeconds: 600, chargedCredits: 100 });
    expect(await finishVoiceRelay(lease, at(600), "disconnected")).toMatchObject({ chargedCredits: 100, secondsRemaining: 0 });
    expect(await balance()).toMatchObject({ availableCredits: 900, reservedCredits: 0, lifetimeCreditsSpent: 100 });
    expect(db.voice.calls.get(lease.callId)?.relaySession).toBeNull();
  });

  it("never authorizes beyond the three funded minutes when the balance runs out", async () => {
    db.state.accounts.get("user-a")!.availableCredits = 30;
    const { lease } = await connect();
    await runUntil(lease, 175);
    expect(db.voice.calls.get(lease.callId)?.relayLeaseExpiresAt).toEqual(at(180));
    await expect(authorizeVoiceRelay(lease, at(180))).rejects.toMatchObject({ code: "VOICE_CALL_CLOSED" });
    await finishVoiceRelay(lease, at(180), "credits");
    expect(await balance()).toMatchObject({ availableCredits: 0, reservedCredits: 0, lifetimeCreditsSpent: 30 });
  });

  it("keeps funds locked after an HTTP end until the owner closes the sockets", async () => {
    const { lease } = await connect();
    vi.setSystemTime(at(2));
    await requestVoiceRelayEnd(lease.callId, "user-a", "ended");
    expect(await balance()).toMatchObject({ availableCredits: 970, reservedCredits: 20 });
    await expect(authorizeVoiceRelay(lease)).rejects.toMatchObject({ code: "VOICE_CALL_CLOSED" });
    await expect(start()).rejects.toMatchObject({ code: "VOICE_CALL_ACTIVE" });
    await finishVoiceRelay(lease, at(2), "ended");
    expect(await balance()).toMatchObject({ availableCredits: 990, reservedCredits: 0, lifetimeCreditsSpent: 10 });
  });

  it("refunds unused authorized minutes exactly once after disconnect", async () => {
    const { lease } = await connect();
    await runUntil(lease, 50); // Second minute authorized ahead of its boundary.
    expect(await balance()).toMatchObject({ lifetimeCreditsSpent: 20, reservedCredits: 10 });
    await Promise.all([finishVoiceRelay(lease, at(55), "ended"), finishVoiceRelay(lease, at(55), "ended")]);
    expect(await balance()).toMatchObject({ availableCredits: 990, reservedCredits: 0, lifetimeCreditsSpent: 10 });
  });

  it("charges partial minutes including sub-second overruns and removes the repeatable free window", async () => {
    const { lease } = await connect();
    await runUntil(lease, 60);
    expect(await finishVoiceRelay(lease, at(60.1), "ended")).toMatchObject({ chargedCredits: 20 });
    const next = await connect();
    expect(await finishVoiceRelay(next.lease, at(60.2), "ended")).toMatchObject({ chargedCredits: 10 });
  });

  it("uses the price agreed at start even if pricing changes mid-call", async () => {
    const { lease } = await connect();
    setCreditPricing({ ...DEFAULT_CREDIT_COSTS, welcomeCreditsEnabled: 0, voiceCallPerMinute: 999 });
    await runUntil(lease, 200);
    await finishVoiceRelay(lease, at(200), "ended");
    expect(await balance()).toMatchObject({ availableCredits: 960, lifetimeCreditsSpent: 40 });
  });

  it("rolls back a partially reserved start and allows only one concurrent call", async () => {
    db.state.accounts.get("user-a")!.availableCredits = 20;
    await expect(start()).rejects.toMatchObject({ code: "INSUFFICIENT_CREDITS" });
    expect(db.voice.calls.size).toBe(0);
    expect(await balance()).toMatchObject({ availableCredits: 20, reservedCredits: 0 });
    db.state.accounts.get("user-a")!.availableCredits = 100;
    const results = await Promise.allSettled([start(), start()]);
    expect(results.map((result) => result.status).sort()).toEqual(["fulfilled", "rejected"]);
    expect(await balance()).toMatchObject({ availableCredits: 70, reservedCredits: 30 });
  });

  it("rolls back both billing and authorization when persisting a lease fails", async () => {
    const { lease } = await connect();
    await runUntil(lease, 45);
    db.prisma.voiceCall.update.mockRejectedValueOnce(new Error("database unavailable"));
    await expect(authorizeVoiceRelay(lease, at(50))).rejects.toThrow("database unavailable");
    expect(await balance()).toMatchObject({ reservedCredits: 20, lifetimeCreditsSpent: 10 });
    expect(db.voice.calls.get(lease.callId)?.relayFundedSeconds).toBe(60);
  });

  it("binds a single-use ticket to one call and refuses disabled users", async () => {
    const { lease } = await connect();
    await expect(claimVoiceRelayCall(lease.callId, "b".repeat(64))).rejects.toMatchObject({ code: "VOICE_CALL_NOT_FOUND" });
    await expect(claimVoiceRelayCall("another-call", tokenHash)).rejects.toMatchObject({ code: "VOICE_CALL_NOT_FOUND" });
    await expect(claimVoiceRelayCall(lease.callId, tokenHash)).rejects.toMatchObject({ code: "VOICE_CALL_CLOSED" });
    expect(await readVoiceRelayMeter(lease.callId, "another-user")).toBeNull();
    db.voice.enabled = false;
    await expect(authorizeVoiceRelay(lease)).rejects.toMatchObject({ code: "VOICE_CALL_CLOSED" });
  });

  it("recovers abandoned connections only after their last enforced deadline", async () => {
    const { lease } = await connect();
    await runUntil(lease, 50);
    expect(await recoverVoiceRelayCalls(at(69))).toBe(0);
    expect(await recoverVoiceRelayCalls(at(70))).toBe(1);
    expect(await balance()).toMatchObject({ reservedCredits: 0, lifetimeCreditsSpent: 20 });
    await expect(authorizeVoiceRelay(lease, at(70))).rejects.toMatchObject({ code: "VOICE_CALL_CLOSED" });
    expect(await recoverVoiceRelayCalls(at(100))).toBe(0);
  });

  it("returns the entire hold for a call that never connected", async () => {
    const call = await start();
    expect(await recoverVoiceRelayCalls(at(60))).toBe(1);
    expect(await balance()).toMatchObject({ availableCredits: 1000, reservedCredits: 0, lifetimeCreditsSpent: 0 });
    expect(await readVoiceRelayMeter(call.id, "user-a")).toMatchObject({ chargedCredits: 0, secondsRemaining: 0 });
  });

  it("caps even free-price calls at thirty minutes", async () => {
    setCreditPricing({ ...DEFAULT_CREDIT_COSTS, voiceCallPerMinute: 0, welcomeCreditsEnabled: 0 });
    const { lease } = await connect();
    await runUntil(lease, 1795);
    await expect(authorizeVoiceRelay(lease, at(1800))).rejects.toMatchObject({ code: "VOICE_CALL_CLOSED" });
    await finishVoiceRelay(lease, at(1800), "limit");
    expect(await balance()).toMatchObject({ availableCredits: 1000, reservedCredits: 0, lifetimeCreditsSpent: 0 });
  });
});
