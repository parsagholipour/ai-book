import {
  FREE_CALL_SECONDS,
  VOICE_CALL_POLICY,
  creditPricing,
  planVoiceCallHold,
  settleVoiceCall,
  voiceCallEndingReason,
  voiceCallSecondsRemaining,
  voiceCallStartingCredits,
  type VoiceCallEndingReason
} from "@book-maker/core";
import { prisma } from "@book-maker/db";
import {
  InsufficientCreditsError,
  releaseReservationsByKeyPrefix,
  reserveCredits,
  spendCredits,
  readVoiceRelayMeter, requestVoiceRelayEnd, recoverVoiceRelayCalls
} from "@book-maker/db/billing";
import { stopLocalVoiceRelay } from "./voiceRelayConnection.js";

/**
 * HTTP metering facade and compatibility settlement for legacy direct calls.
 * New calls use `voiceRelayBilling.ts` in the DB package; their HTTP heartbeat
 * is only a read, and their end request retains holds until the relay stops.
 * The older arithmetic below remains for calls issued before the relay rollout.
 */

export type VoiceCallMeter = {
  callId: string;
  elapsedSeconds: number;
  secondsRemaining: number;
  chargedCredits: number;
  /** True when the hold could not be topped up — the app should wind the call down. */
  endingSoon: boolean;
  /**
   * Why the call is winding down, while there is still time to say so. The app
   * needs the distinction: running dry is fixed by buying credits, and reaching
   * the length cap is not.
   */
  endingReason: VoiceCallEndingReason | null;
};

export type VoiceCallStart = {
  callId: string;
  secondsRemaining: number;
  creditsPerMinute: number;
  heartbeatSeconds: number;
  maxCallSeconds: number;
};

export class VoiceCallNotFoundError extends Error {
  readonly code = "VOICE_CALL_NOT_FOUND";
}

/**
 * Who a call is to.
 *
 * A book call is a cast row inside a finished book, so it carries the project
 * for the ledger and the cast row for the persona; a library call is one of the
 * reader's own saved characters and has no project at all. Every metering path
 * below is the same for both — the callee only decides which columns the row
 * names, and which earlier calls count as this character's memory.
 */
export type VoiceCallee =
  | { kind: "book"; projectId: string; characterId: string }
  | { kind: "library"; libraryCharacterId: string };

/** The `VoiceCall` columns a create writes for one callee. */
export function voiceCalleeColumns(
  callee: VoiceCallee
): { projectId: string; characterId: string } | { libraryCharacterId: string } {
  return callee.kind === "book"
    ? { projectId: callee.projectId, characterId: callee.characterId }
    : { libraryCharacterId: callee.libraryCharacterId };
}

/**
 * The one column that names a callee in a `where`: a cast row belongs to one
 * project, so the project adds nothing to the lookup and only changes its plan.
 */
export function voiceCalleeIdentity(callee: VoiceCallee): { characterId: string } | { libraryCharacterId: string } {
  return callee.kind === "book"
    ? { characterId: callee.characterId }
    : { libraryCharacterId: callee.libraryCharacterId };
}

/**
 * Opens a metered call, reserving the first block of credits.
 *
 * Any call the same user left open is settled first. Two live calls would mean
 * two microphones and two holds, and in practice the stale one is a call whose
 * app was killed rather than one the user is still on.
 */
export async function startVoiceCall(options: { userId: string; callee: VoiceCallee }): Promise<VoiceCallStart> {
  await settleOpenCallsForUser(options.userId, "superseded");

  const call = await prisma.voiceCall.create({
    data: {
      userId: options.userId,
      ...voiceCalleeColumns(options.callee),
      status: "ACTIVE"
    },
    select: { id: true }
  });

  try {
    const held = await extendVoiceCallHold({
      callId: call.id,
      userId: options.userId,
      projectId: options.callee.kind === "book" ? options.callee.projectId : null,
      elapsedSeconds: 0,
      heldCredits: 0,
      reservationEntryIds: []
    });
    return {
      callId: call.id,
      secondsRemaining: voiceCallSecondsRemaining({ elapsedSeconds: 0, heldCredits: held.heldCredits }),
      creditsPerMinute: creditPricing().voiceCallPerMinute,
      heartbeatSeconds: VOICE_CALL_POLICY.heartbeatSeconds,
      maxCallSeconds: VOICE_CALL_POLICY.maxCallMinutes * 60
    };
  } catch (error) {
    // No hold means no call. Release anything the failed hold managed to
    // reserve — the pointer write is what failed, so the row cannot name it —
    // then drop the row rather than leave a zero-credit ACTIVE call for the
    // sweep to reason about.
    await releaseReservationsByKeyPrefix(
      voiceCallHoldKeyPrefix(call.id),
      "Voice call hold released (call failed to start)."
    ).catch(() => null);
    await prisma.voiceCall.delete({ where: { id: call.id } }).catch(() => undefined);
    throw error;
  }
}

/**
 * Records how far a live call has got and keeps the hold ahead of it.
 *
 * A failed top-up is reported rather than thrown: the call is still paid for
 * up to `secondsRemaining`, and ending it mid-word to deliver an error would be
 * a worse experience than letting it finish the sentence it is on.
 */
export async function heartbeatVoiceCall(options: {
  callId: string;
  userId: string;
  elapsedSeconds: number;
}): Promise<VoiceCallMeter> {
  const relayMeter = await readVoiceRelayMeter(options.callId, options.userId);
  if (relayMeter) return relayMeter;
  const call = await activeCallOrThrow(options.callId, options.userId);
  // Elapsed time only moves forward, and never below the server's own clock.
  // The audio runs on a socket the server never sees, so `elapsedSeconds` is
  // the client's word — a retried or reordered heartbeat must not talk the
  // meter back down, and a doctored client reporting 0 forever must not talk
  // itself into a free call. Wall clock since `startedAt` is the floor: the
  // call has verifiably been open that long, whatever the app reports.
  const elapsedSeconds = Math.min(
    Math.max(options.elapsedSeconds, call.elapsedSeconds, wallClockElapsedSeconds(call.startedAt)),
    VOICE_CALL_POLICY.maxCallMinutes * 60
  );

  let heldCredits = call.heldCredits;
  let endingSoon = false;
  try {
    const held = await extendVoiceCallHold({
      callId: call.id,
      userId: call.userId,
      projectId: call.projectId,
      elapsedSeconds,
      heldCredits: call.heldCredits,
      reservationEntryIds: call.reservationEntryIds
    });
    heldCredits = held.heldCredits;
  } catch (error) {
    if (!(error instanceof InsufficientCreditsError)) {
      throw error;
    }
    endingSoon = true;
  }

  await prisma.voiceCall.update({
    where: { id: call.id },
    data: { elapsedSeconds, lastHeartbeatAt: new Date() }
  });

  const secondsRemaining = voiceCallSecondsRemaining({ elapsedSeconds, heldCredits });
  return {
    callId: call.id,
    elapsedSeconds,
    secondsRemaining,
    chargedCredits: settleVoiceCall(elapsedSeconds).credits,
    endingSoon: endingSoon || secondsRemaining <= 0,
    endingReason: voiceCallEndingReason({ elapsedSeconds, heldCredits, topUpFailed: endingSoon })
  };
}

/**
 * Closes a call and charges for it.
 *
 * Every hold is released and one spend is written for the true duration, so the
 * ledger reads as "held, released, charged N" rather than as a run of partial
 * charges nobody can reconcile against a call that was still going.
 */
export async function endVoiceCall(options: {
  callId: string;
  userId: string;
  elapsedSeconds?: number | undefined;
  reason: string;
}): Promise<VoiceCallMeter> {
  const relayMeter = await readVoiceRelayMeter(options.callId, options.userId);
  if (relayMeter) {
    const ending = await requestVoiceRelayEnd(options.callId, options.userId, options.reason);
    await stopLocalVoiceRelay(options.callId, options.reason);
    return await readVoiceRelayMeter(options.callId, options.userId) ?? ending;
  }
  const call = await prisma.voiceCall.findFirst({
    where: { id: options.callId, userId: options.userId },
    select: voiceCallSelect
  });
  if (!call) {
    throw new VoiceCallNotFoundError("Voice call not found.");
  }
  if (call.status !== "ACTIVE") {
    return {
      callId: call.id,
      elapsedSeconds: call.elapsedSeconds,
      secondsRemaining: 0,
      chargedCredits: call.chargedCredits,
      endingSoon: true,
      endingReason: null
    };
  }

  // The same server-clock floor as the heartbeat: the client names how long it
  // talked, but never less than how long the call has been open.
  const elapsedSeconds = Math.min(
    Math.max(
      options.elapsedSeconds ?? call.elapsedSeconds,
      call.elapsedSeconds,
      wallClockElapsedSeconds(call.startedAt)
    ),
    VOICE_CALL_POLICY.maxCallMinutes * 60
  );
  return settleCall(call, elapsedSeconds, options.reason);
}

/**
 * Recovers expired relay leases, legacy calls and orphaned holds.
 * Relay recovery uses server-owned deadlines, never a client's last heartbeat.
 */
export async function sweepStaleVoiceCalls(now = new Date()): Promise<number> {
  const cutoff = new Date(now.getTime() - VOICE_CALL_POLICY.heartbeatGraceSeconds * 1000);
  const stale = await prisma.voiceCall.findMany({
    where: { status: "ACTIVE", relayTokenHash: null, lastHeartbeatAt: { lt: cutoff } },
    select: voiceCallSelect
  });
  for (const call of stale) {
    // Legacy direct tokens could outlive client heartbeats. Never treat
    // silence as evidence that the provider connection ended.
    const elapsedSeconds = Math.min(
      Math.max(call.elapsedSeconds, wallClockElapsedSeconds(call.startedAt, now)),
      VOICE_CALL_POLICY.maxCallMinutes * 60
    );
    await settleCall(call, elapsedSeconds, "heartbeat_lost");
  }
  return stale.length + (await recoverVoiceRelayCalls(now)) + (await releaseOrphanedVoiceCallHolds(cutoff));
}

/** A hold's key, `{prefix}{n}`, read back into the call it belongs to. */
const VOICE_CALL_HOLD_KEY = /^mobile:voice-call:([^:]+):hold:\d+$/;

/**
 * Releases the holds of calls that are no longer running.
 *
 * `settleCall` releases by the call's key prefix, so a call it settles cannot
 * strand one. A call settled before it did could: the hold was reserved in one
 * statement and its pointer written in the next, and a call that ended between
 * the two released only the holds its row knew about. One such hold sat
 * RESERVED from July to October 2026, shown to the reader as "180 on hold for
 * books in progress" with nothing in progress, and nothing would ever have let
 * it go — the stale sweep reads ACTIVE calls, and this call had ENDED. So the
 * ledger is read for any hold whose call is not ACTIVE (or no longer exists),
 * and the release goes through the same prefix `settleCall` uses.
 */
async function releaseOrphanedVoiceCallHolds(cutoff: Date): Promise<number> {
  const holds = await prisma.creditLedgerEntry.findMany({
    where: {
      status: "RESERVED",
      operation: "VOICE_CALL_MINUTE",
      idempotencyKey: { startsWith: "mobile:voice-call:" },
      createdAt: { lt: cutoff }
    },
    select: { idempotencyKey: true },
    take: 100
  });
  const callIds = [
    ...new Set(holds.flatMap((hold) => VOICE_CALL_HOLD_KEY.exec(hold.idempotencyKey)?.slice(1, 2) ?? []))
  ];
  if (callIds.length === 0) {
    return 0;
  }
  const running = await prisma.voiceCall.findMany({
    where: { id: { in: callIds }, status: { in: ["ACTIVE", "ENDING"] } },
    select: { id: true }
  });
  const runningIds = new Set(running.map((call) => call.id));
  let released = 0;
  for (const callId of callIds) {
    if (runningIds.has(callId)) continue;
    released += await releaseReservationsByKeyPrefix(
      voiceCallHoldKeyPrefix(callId),
      "Voice call hold released (the call had already ended)."
    );
  }
  return released;
}

/** Whole seconds this call has verifiably been open, by the server's clock. */
function wallClockElapsedSeconds(startedAt: Date, until: Date = new Date()): number {
  return Math.max(0, Math.floor((until.getTime() - startedAt.getTime()) / 1000));
}

/** Credits a user must have available before a call is offered to them. */
export function voiceCallEntryCredits(): number {
  return voiceCallStartingCredits();
}

/**
 * Every hold this call reserves carries a key under this prefix — the hold's
 * own key appends `{n}` for the nth top-up. `settleCall` releases by the
 * prefix, so the two must never drift apart.
 */
function voiceCallHoldKeyPrefix(callId: string): string {
  return `mobile:voice-call:${callId}:hold:`;
}

const voiceCallSelect = {
  id: true,
  userId: true,
  projectId: true,
  characterId: true,
  libraryCharacterId: true,
  status: true,
  reservationEntryIds: true,
  heldCredits: true,
  chargedCredits: true,
  elapsedSeconds: true,
  startedAt: true,
  lastHeartbeatAt: true
} as const;

type VoiceCallRow = {
  id: string;
  userId: string;
  projectId: string | null;
  characterId: string | null;
  libraryCharacterId: string | null;
  status: string;
  reservationEntryIds: string[];
  heldCredits: number;
  chargedCredits: number;
  elapsedSeconds: number;
  startedAt: Date;
  lastHeartbeatAt: Date;
};

async function settleCall(call: VoiceCallRow, elapsedSeconds: number, reason: string): Promise<VoiceCallMeter> {
  // Released by key prefix rather than by walking `reservationEntryIds`: the
  // hold is reserved in one statement and the pointer written in the next, so
  // a crash between the two leaves a RESERVED entry the row never learned
  // about. Every hold's key starts with this prefix, which finds the orphan
  // along with the tracked ones — and only still-RESERVED rows are touched.
  await releaseReservationsByKeyPrefix(
    voiceCallHoldKeyPrefix(call.id),
    `Voice call hold released (${reason}).`
  ).catch(() => null);

  const settlement = settleVoiceCall(elapsedSeconds);
  let chargedCredits = 0;
  if (settlement.credits > 0) {
    // The hold was released a moment ago, so this spend is covered by the same
    // credits it was holding. A user who cannot pay is not chased: the time was
    // already delivered, and the balance floor stops the next call instead.
    const entry = await spendCredits({
      userId: call.userId,
      projectId: call.projectId,
      operation: "VOICE_CALL_MINUTE",
      amountCredits: settlement.credits,
      idempotencyKey: `mobile:voice-call:${call.id}:charge`,
      description: `Character voice call, ${settlement.billableMinutes} min`,
      metadata: {
        characterId: call.characterId,
        libraryCharacterId: call.libraryCharacterId,
        elapsedSeconds: settlement.billableSeconds,
        reason
      }
    }).catch((error: unknown) => {
      if (error instanceof InsufficientCreditsError) {
        return null;
      }
      throw error;
    });
    chargedCredits = entry ? settlement.credits : 0;
  }

  await prisma.voiceCall.update({
    where: { id: call.id },
    data: {
      status: "ENDED",
      endReason: reason,
      endedAt: new Date(),
      elapsedSeconds,
      heldCredits: 0,
      chargedCredits,
      reservationEntryIds: []
    }
  });

  return {
    callId: call.id,
    elapsedSeconds,
    secondsRemaining: 0,
    chargedCredits,
    endingSoon: true,
    endingReason: null
  };
}

async function extendVoiceCallHold(options: {
  callId: string;
  userId: string;
  projectId: string | null;
  elapsedSeconds: number;
  heldCredits: number;
  reservationEntryIds: string[];
}): Promise<{ heldCredits: number }> {
  const plan = planVoiceCallHold({ elapsedSeconds: options.elapsedSeconds, heldCredits: options.heldCredits });
  if (plan.additionalCredits <= 0) {
    return { heldCredits: options.heldCredits };
  }

  const entry = await reserveCredits({
    userId: options.userId,
    projectId: options.projectId,
    operation: "VOICE_CALL_MINUTE",
    amountCredits: plan.additionalCredits,
    idempotencyKey: `${voiceCallHoldKeyPrefix(options.callId)}${options.reservationEntryIds.length}`,
    description: "Character voice call time"
  });
  if (!entry) {
    return { heldCredits: options.heldCredits };
  }
  // A retried heartbeat computes the same idempotency key and gets the existing
  // reservation back. Counting it twice would tell the app it has paid for
  // minutes nobody reserved, and the call would run past what it can settle.
  if (options.reservationEntryIds.includes(entry.id)) {
    return { heldCredits: options.heldCredits };
  }

  // The entry's own amount, not this plan's: an existing entry adopted here —
  // reserved by a call whose pointer write then crashed — holds whatever was
  // planned when it was reserved, and `heldCredits` claims to be the sum of
  // the still-RESERVED holds. For a fresh reservation the two are equal.
  //
  // The write is conditional on the entry not already being recorded: two
  // overlapping heartbeats can both hold the same entry (same idempotency key)
  // and both pass the stale `includes` check above — an unconditional push
  // would record it twice and inflate `heldCredits` by a block nobody
  // reserved. Postgres re-evaluates the predicate under the row lock, so
  // exactly one of them records it.
  const additionalCredits = Math.abs(entry.amountCredits);
  const recorded = await prisma.voiceCall.updateMany({
    where: { id: options.callId, NOT: { reservationEntryIds: { has: entry.id } } },
    data: {
      heldCredits: { increment: additionalCredits },
      reservationEntryIds: { push: entry.id }
    }
  });
  return {
    heldCredits: recorded.count === 1 ? options.heldCredits + additionalCredits : options.heldCredits
  };
}

async function activeCallOrThrow(callId: string, userId: string): Promise<VoiceCallRow> {
  const call = await prisma.voiceCall.findFirst({
    where: { id: callId, userId, status: "ACTIVE" },
    select: voiceCallSelect
  });
  if (!call) {
    throw new VoiceCallNotFoundError("Voice call not found.");
  }
  return call;
}

async function settleOpenCallsForUser(userId: string, reason: string): Promise<void> {
  const open = await prisma.voiceCall.findMany({
    where: { userId, status: "ACTIVE", relayTokenHash: null },
    select: voiceCallSelect
  });
  for (const call of open) {
    await settleCall(call, call.elapsedSeconds, reason);
  }
}

export { FREE_CALL_SECONDS, VOICE_CALL_POLICY };
