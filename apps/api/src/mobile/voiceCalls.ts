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
import { InsufficientCreditsError, refundCreditLedgerEntry, reserveCredits, spendCredits } from "@book-maker/db/billing";

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
    // No hold means no call. Drop the row rather than leave a zero-credit
    // ACTIVE call for the sweep to reason about.
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
  // Elapsed time only moves forward. A retried or reordered heartbeat must not
  // be able to talk the meter back down.
  const elapsedSeconds = Math.min(
    Math.max(options.elapsedSeconds, call.elapsedSeconds),
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

  const elapsedSeconds = Math.min(
    Math.max(options.elapsedSeconds ?? call.elapsedSeconds, call.elapsedSeconds),
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
    await settleCall(call, call.elapsedSeconds, "heartbeat_lost");
  }
  return stale.length;
}

/** Credits a user must have available before a call is offered to them. */
export function voiceCallEntryCredits(): number {
  return voiceCallStartingCredits();
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
  elapsedSeconds: true
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
};

async function settleCall(call: VoiceCallRow, elapsedSeconds: number, reason: string): Promise<VoiceCallMeter> {
  for (const entryId of call.reservationEntryIds) {
    await refundCreditLedgerEntry(entryId, `Voice call hold released (${reason}).`).catch(() => null);
  }

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
    idempotencyKey: `mobile:voice-call:${options.callId}:hold:${options.reservationEntryIds.length}`,
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

  const heldCredits = options.heldCredits + plan.additionalCredits;
  await prisma.voiceCall.update({
    where: { id: options.callId },
    data: {
      heldCredits,
      reservationEntryIds: { push: entry.id }
    }
  });
  return { heldCredits };
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
