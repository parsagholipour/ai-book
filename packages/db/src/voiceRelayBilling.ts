import { randomUUID, timingSafeEqual } from "node:crypto";
import { creditPricing, VOICE_CALL_POLICY } from "@book-maker/core";
import { prisma, Prisma } from "./client.ts";
import { InsufficientCreditsError, runSerializable, type BillingTx } from "./billingInternals.ts";
import { commitReservedCreditsTx, refundCreditLedgerEntryTx, reserveCreditsTx } from "./billingLedger.ts";

/** A relay must close both sockets before this lease expires, even if the DB is down. */
export const VOICE_RELAY_LEASE_MS = 15_000;
export const VOICE_RELAY_RECOVERY_GRACE_MS = 5_000;
const CONNECT_WINDOW_MS = 60_000;
const MAX_SECONDS = VOICE_CALL_POLICY.maxCallMinutes * 60;

export type VoiceRelaySession = { token: string; model: string; expiresAt: string };
export type VoiceRelayLease = { callId: string; userId: string; leaseId: string };
export type VoiceRelayMeter = {
  callId: string; elapsedSeconds: number; secondsRemaining: number; chargedCredits: number;
  endingSoon: boolean; endingReason: "credits" | "limit" | null;
};
export class VoiceRelayError extends Error {
  constructor(readonly code: "VOICE_CALL_ACTIVE" | "VOICE_CALL_NOT_FOUND" | "VOICE_CALL_CLOSED") {
    super(code === "VOICE_CALL_ACTIVE" ? "End your current call before starting another." : "That call has ended. Start a new call.");
  }
}

type Call = Prisma.VoiceCallGetPayload<{}>;
type Callee = { projectId: string; characterId: string } | { libraryCharacterId: string };
const holdKey = (id: string, minute: number) => `mobile:voice-call:${id}:hold:${minute}`;

/** User -> call -> credit account is the lock order for every relay transition. */
async function callTransaction<T>(callId: string, userId: string, work: (tx: BillingTx, call: Call) => Promise<T>): Promise<T> {
  return runSerializable(async (tx) => {
    await tx.$queryRaw`SELECT "id" FROM "User" WHERE "id" = ${userId} FOR UPDATE`;
    await tx.$queryRaw`SELECT "id" FROM "VoiceCall" WHERE "id" = ${callId} AND "userId" = ${userId} FOR UPDATE`;
    const call = await tx.voiceCall.findFirst({ where: { id: callId, userId } });
    if (!call?.relayTokenHash) throw new VoiceRelayError("VOICE_CALL_NOT_FOUND");
    return work(tx, call);
  });
}

export async function startVoiceRelayCall(options: { userId: string; callee: Callee; tokenHash: string; now?: Date }): Promise<Call> {
  const now = options.now ?? new Date();
  return runSerializable(async (tx) => {
    await tx.$queryRaw`SELECT "id" FROM "User" WHERE "id" = ${options.userId} FOR UPDATE`;
    const active = await tx.voiceCall.findFirst({ where: { userId: options.userId, status: { in: ["ACTIVE", "ENDING"] } } });
    if (active) throw new VoiceRelayError("VOICE_CALL_ACTIVE");
    const rate = creditPricing().voiceCallPerMinute;
    const call = await tx.voiceCall.create({ data: {
      userId: options.userId, ...options.callee, status: "ACTIVE", startedAt: now, lastHeartbeatAt: now,
      relayTokenHash: options.tokenHash, voiceCreditsPerMinute: rate
    } });
    // Separate minute holds can be committed/refunded atomically without ever
    // releasing used money into the spendable balance between those operations.
    const ids: string[] = [];
    for (let minute = 0; minute < VOICE_CALL_POLICY.reserveBlockMinutes; minute++) {
      const entry = await reserveMinute(tx, call, minute, rate, now);
      if (entry) ids.push(entry.id);
    }
    return tx.voiceCall.update({ where: { id: call.id }, data: {
      heldCredits: VOICE_CALL_POLICY.reserveBlockMinutes * rate,
      reservationEntryIds: ids, relayReservedMinutes: VOICE_CALL_POLICY.reserveBlockMinutes
    } });
  });
}

export async function saveVoiceRelaySession(callId: string, userId: string, session: VoiceRelaySession): Promise<void> {
  await callTransaction(callId, userId, async (tx, call) => {
    if (call.status !== "ACTIVE" || call.relaySession) throw new VoiceRelayError("VOICE_CALL_CLOSED");
    await tx.voiceCall.update({ where: { id: callId }, data: { relaySession: session } });
  });
}

/** Claims are never stolen: an expired owner is stopped and settled by recovery. */
export async function claimVoiceRelayCall(callId: string, tokenHash: string, now = new Date()): Promise<{
  lease: VoiceRelayLease; session: VoiceRelaySession; deadline: Date;
}> {
  const found = await prisma.voiceCall.findFirst({ where: { id: callId } });
  if (!found?.relayTokenHash || !sameHash(found.relayTokenHash, tokenHash)) throw new VoiceRelayError("VOICE_CALL_NOT_FOUND");
  return callTransaction(callId, found.userId, async (tx, call) => {
    const user = await tx.user.findUnique({ where: { id: call.userId }, select: { status: true, disabledAt: true } });
    if (!user || user.status !== "ACTIVE" || user.disabledAt || call.status !== "ACTIVE" || call.relayLeaseId ||
        now.getTime() >= call.startedAt.getTime() + CONNECT_WINDOW_MS) throw new VoiceRelayError("VOICE_CALL_CLOSED");
    const session = readSession(call.relaySession);
    if (!session || Date.parse(session.expiresAt) <= now.getTime()) throw new VoiceRelayError("VOICE_CALL_CLOSED");
    const leaseId = randomUUID();
    const deadline = new Date(now.getTime() + VOICE_RELAY_LEASE_MS);
    await tx.voiceCall.update({ where: { id: call.id }, data: {
      relayLeaseId: leaseId, relayLeaseExpiresAt: deadline, lastHeartbeatAt: now
    } });
    return { lease: { callId, userId: call.userId, leaseId }, session, deadline };
  });
}

/** Only the socket owner may buy/extend provider access. HTTP heartbeats are reads. */
export async function authorizeVoiceRelay(lease: VoiceRelayLease, now = new Date()): Promise<{
  deadline: Date; meter: VoiceRelayMeter;
}> {
  return callTransaction(lease.callId, lease.userId, async (tx, call) => {
    assertLiveLease(call, lease, now);
    const user = await tx.user.findUnique({ where: { id: call.userId }, select: { status: true, disabledAt: true } });
    if (!user || user.status !== "ACTIVE" || user.disabledAt) throw new VoiceRelayError("VOICE_CALL_CLOSED");
    const connectedAt = call.relayConnectedAt ?? now;
    const elapsed = elapsedSeconds(connectedAt, now);
    const session = readSession(call.relaySession);
    if (elapsed >= MAX_SECONDS || !session || Date.parse(session.expiresAt) <= now.getTime()) throw new VoiceRelayError("VOICE_CALL_CLOSED");
    const rate = call.voiceCreditsPerMinute!;
    // Authorize a little ahead of the minute boundary. Unused whole minutes
    // are refunded only after the owner has closed the provider connection.
    const wantedMinutes = Math.min(VOICE_CALL_POLICY.maxCallMinutes, Math.floor((elapsed + 10) / 60) + 1);
    let reservedMinutes = call.relayReservedMinutes;
    const ids = [...call.reservationEntryIds];
    while (reservedMinutes < wantedMinutes) {
      try {
        const entry = await reserveMinute(tx, call, reservedMinutes, rate, now);
        if (entry) ids.push(entry.id);
        reservedMinutes++;
      } catch (error) {
        if (!(error instanceof InsufficientCreditsError)) throw error;
        break;
      }
    }
    const fundedMinutes = Math.min(wantedMinutes, reservedMinutes);
    for (let minute = call.relayFundedSeconds / 60; minute < fundedMinutes; minute++) {
      if (rate > 0) {
        const entry = await tx.creditLedgerEntry.findUnique({ where: { idempotencyKey: holdKey(call.id, minute) } });
        if (!entry || entry.status !== "RESERVED") throw new Error("Voice minute reservation is missing");
        await commitReservedCreditsTx(tx, entry.id);
      }
    }
    const fundedSeconds = Math.max(call.relayFundedSeconds, fundedMinutes * 60);
    const deadline = new Date(Math.min(
      connectedAt.getTime() + fundedSeconds * 1000,
      now.getTime() + VOICE_RELAY_LEASE_MS,
      Date.parse(session.expiresAt)
    ));
    const updated = await tx.voiceCall.update({ where: { id: call.id }, data: {
      relayConnectedAt: connectedAt, relayFundedSeconds: fundedSeconds, relayReservedMinutes: reservedMinutes,
      relayLeaseExpiresAt: deadline, lastHeartbeatAt: now, elapsedSeconds: elapsed,
      reservationEntryIds: ids, chargedCredits: fundedSeconds / 60 * rate,
      heldCredits: (reservedMinutes - fundedSeconds / 60) * rate
    } });
    return { deadline, meter: meterFor(updated, now) };
  });
}

export async function readVoiceRelayMeter(callId: string, userId: string, now = new Date()): Promise<VoiceRelayMeter | null> {
  const call = await prisma.voiceCall.findFirst({ where: { id: callId, userId } });
  return call?.relayTokenHash ? meterFor(call, now) : null;
}

/** Request a stop; the owner closes upstream BEFORE releasing any credit. */
export async function requestVoiceRelayEnd(callId: string, userId: string, reason: string): Promise<VoiceRelayMeter> {
  return callTransaction(callId, userId, async (tx, call) => {
    if (call.status === "ENDED") return meterFor(call);
    // No owner means no provider connection could have been opened.
    if (!call.relayLeaseId) return finishTx(tx, call, new Date(), reason);
    const updated = await tx.voiceCall.update({ where: { id: call.id }, data: { status: "ENDING", endReason: reason } });
    return meterFor(updated);
  });
}

/** Called only after both sockets are closed, with the server-observed stop time. */
export async function finishVoiceRelay(lease: VoiceRelayLease, stoppedAt: Date, reason: string): Promise<VoiceRelayMeter> {
  return callTransaction(lease.callId, lease.userId, async (tx, call) => {
    if (call.status === "ENDED") return meterFor(call);
    if (call.relayLeaseId !== lease.leaseId) throw new VoiceRelayError("VOICE_CALL_CLOSED");
    return finishTx(tx, call, stoppedAt, reason);
  });
}

/** Recover a dead API process only after its enforced socket deadline has passed. */
export async function recoverVoiceRelayCalls(now = new Date()): Promise<number> {
  const cutoff = new Date(now.getTime() - VOICE_RELAY_RECOVERY_GRACE_MS);
  const calls = await prisma.voiceCall.findMany({ where: {
    relayTokenHash: { not: null }, status: { in: ["ACTIVE", "ENDING"] },
    OR: [
      { relayLeaseExpiresAt: { lte: cutoff } },
      { relayLeaseId: null, startedAt: { lte: new Date(now.getTime() - CONNECT_WINDOW_MS) } }
    ]
  }, take: 100 });
  let settled = 0;
  for (const candidate of calls) {
    settled += await callTransaction(candidate.id, candidate.userId, async (tx, call) => {
      if (call.status === "ENDED") return 0;
      if (call.relayLeaseId && (!call.relayLeaseExpiresAt || call.relayLeaseExpiresAt > cutoff)) return 0;
      if (!call.relayLeaseId && call.startedAt.getTime() + CONNECT_WINDOW_MS > now.getTime()) return 0;
      await finishTx(tx, call, call.relayLeaseExpiresAt ?? now, "connection_lost");
      return 1;
    });
  }
  return settled;
}

async function finishTx(tx: BillingTx, call: Call, stoppedAt: Date, reason: string): Promise<VoiceRelayMeter> {
  const seconds = call.relayConnectedAt
    ? Math.min(call.relayFundedSeconds, elapsedSeconds(call.relayConnectedAt, stoppedAt)) : 0;
  // A provider connection that actually opened costs at least one minute.
  // The previous five-second free window could be repeated indefinitely.
  const usedMinutes = call.relayConnectedAt ? Math.min(call.relayFundedSeconds / 60,
    Math.max(1, Math.ceil((stoppedAt.getTime() - call.relayConnectedAt.getTime()) / 60_000))) : 0;
  const rate = call.voiceCreditsPerMinute!;
  if (rate > 0) {
    for (let minute = 0; minute < call.relayReservedMinutes; minute++) {
      const entry = await tx.creditLedgerEntry.findUnique({ where: { idempotencyKey: holdKey(call.id, minute) } });
      if (!entry) throw new Error("Voice minute reservation is missing at settlement");
      if (minute < usedMinutes) await commitReservedCreditsTx(tx, entry.id);
      else await refundCreditLedgerEntryTx(tx, entry.id, "Unused character call time", stoppedAt);
    }
  }
  const updated = await tx.voiceCall.update({ where: { id: call.id }, data: {
    status: "ENDED", endReason: reason, endedAt: stoppedAt, elapsedSeconds: seconds,
    chargedCredits: usedMinutes * rate, heldCredits: 0, reservationEntryIds: [],
    relaySession: Prisma.DbNull, relayLeaseId: null, relayLeaseExpiresAt: null
  } });
  return meterFor(updated, stoppedAt);
}

function reserveMinute(tx: BillingTx, call: Call, minute: number, rate: number, now: Date) {
  return reserveCreditsTx(tx, {
    userId: call.userId, projectId: call.projectId, operation: "VOICE_CALL_MINUTE", amountCredits: rate,
    idempotencyKey: holdKey(call.id, minute), description: "Character voice call time", now,
    metadata: { callId: call.id, minute: minute + 1, creditsPerMinute: rate }
  });
}

function meterFor(call: Call, now = new Date()): VoiceRelayMeter {
  const elapsed = call.status === "ENDED" ? call.elapsedSeconds
    : call.relayConnectedAt ? Math.min(call.relayFundedSeconds, elapsedSeconds(call.relayConnectedAt, now)) : 0;
  const remaining = call.status === "ACTIVE" ? Math.max(0, call.relayReservedMinutes * 60 - elapsed) : 0;
  return {
    callId: call.id, elapsedSeconds: elapsed, secondsRemaining: remaining,
    chargedCredits: call.status === "ENDED" ? call.chargedCredits : (call.relayConnectedAt ? Math.max(1, Math.ceil(elapsed / 60)) : 0) * call.voiceCreditsPerMinute!,
    endingSoon: remaining <= 20, endingReason: remaining <= 20 ? (elapsed >= MAX_SECONDS - 20 ? "limit" : "credits") : null
  };
}

function assertLiveLease(call: Call, lease: VoiceRelayLease, now: Date) {
  if (call.status !== "ACTIVE" || call.relayLeaseId !== lease.leaseId || !call.relayLeaseExpiresAt || call.relayLeaseExpiresAt <= now) {
    throw new VoiceRelayError("VOICE_CALL_CLOSED");
  }
}
function elapsedSeconds(startedAt: Date, now: Date) {
  return Math.min(MAX_SECONDS, Math.max(0, Math.floor((now.getTime() - startedAt.getTime()) / 1000)));
}
function sameHash(left: string, right: string) {
  return left.length === right.length && timingSafeEqual(Buffer.from(left), Buffer.from(right));
}
function readSession(value: unknown): VoiceRelaySession | null {
  if (!value || typeof value !== "object" || !("token" in value) || !("model" in value) || !("expiresAt" in value)) return null;
  return typeof value.token === "string" && typeof value.model === "string" && typeof value.expiresAt === "string" && Number.isFinite(Date.parse(value.expiresAt))
    ? { token: value.token, model: value.model, expiresAt: value.expiresAt } : null;
}
