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
  spendCredits
} from "@book-maker/db/billing";

/**
 * The credit lifecycle of a realtime character call.
 *
 * A call holds credits while it runs and spends them exactly once when it ends.
 * Holding rather than spending is what makes a dropped call safe: the app can
 * die mid-sentence and the worst outcome is a hold that the stale-call sweep
 * releases a minute and a half later.
 *
 * `packages/core/src/voiceCallMetering.ts` owns the arithmetic. This file owns
 * the ledger entries and the `VoiceCall` row.
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
 * Opens a metered call, reserving the first block of credits.
 *
 * Any call the same user left open is settled first. Two live calls would mean
 * two microphones and two holds, and in practice the stale one is a call whose
 * app was killed rather than one the user is still on.
 */
export async function startVoiceCall(options: {
  userId: string;
  projectId: string;
  characterId: string;
}): Promise<VoiceCallStart> {
  await settleOpenCallsForUser(options.userId, "superseded");

  const call = await prisma.voiceCall.create({
    data: {
      userId: options.userId,
      projectId: options.projectId,
      characterId: options.characterId,
      status: "ACTIVE"
    },
    select: { id: true }
  });

  try {
    const held = await extendVoiceCallHold({
      callId: call.id,
      userId: options.userId,
      projectId: options.projectId,
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
 * Settles calls that stopped reporting in.
 *
 * Charges for the time the call was last known to have reached, which is at
 * most one heartbeat behind. `server.ts` runs this on the retention sweep.
 */
export async function sweepStaleVoiceCalls(now = new Date()): Promise<number> {
  const cutoff = new Date(now.getTime() - VOICE_CALL_POLICY.heartbeatGraceSeconds * 1000);
  const stale = await prisma.voiceCall.findMany({
    where: { status: "ACTIVE", lastHeartbeatAt: { lt: cutoff } },
    select: voiceCallSelect
  });
  for (const call of stale) {
    // Floor at the wall clock of the last heartbeat rather than of now: the
    // call was verifiably alive until then, and charging the grace window a
    // crashed app could not report would overbill the honest case.
    const elapsedSeconds = Math.min(
      Math.max(call.elapsedSeconds, wallClockElapsedSeconds(call.startedAt, call.lastHeartbeatAt)),
      VOICE_CALL_POLICY.maxCallMinutes * 60
    );
    await settleCall(call, elapsedSeconds, "heartbeat_lost");
  }
  return stale.length;
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
  projectId: string;
  characterId: string;
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
      metadata: { characterId: call.characterId, elapsedSeconds: settlement.billableSeconds, reason }
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
  projectId: string;
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
    where: { userId, status: "ACTIVE" },
    select: voiceCallSelect
  });
  for (const call of open) {
    await settleCall(call, call.elapsedSeconds, reason);
  }
}

export { FREE_CALL_SECONDS, VOICE_CALL_POLICY };
