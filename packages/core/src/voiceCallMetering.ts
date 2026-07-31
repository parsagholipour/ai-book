/**
 * Credit metering policy for realtime character voice calls.
 *
 * Every other priced operation in the product is charged per unit of work — a
 * page, an image, an export. A voice call is charged per unit of *time*, which
 * needs different bookkeeping: at the moment the call starts nobody knows what
 * it will cost.
 *
 * The rule this file encodes: hold enough credits to cover the next few
 * minutes, top the hold up while the call runs, and settle exactly once when it
 * ends. Nothing is spent mid-call, so a dropped connection can never leave a
 * user charged for time they did not get. `apps/api/src/mobile/voiceCalls.ts`
 * owns the ledger entries and the database row; everything here is pure so the
 * arithmetic can be tested without a database.
 */

import { type CreditPricing, creditPricing } from "./creditPricing.js";

/**
 * The *time* knobs only. The per-minute rate deliberately lives in
 * {@link creditPricing} instead: reading it here would freeze the price at
 * whatever it was when this module first loaded, which is exactly the bug the
 * pricing dashboard exists to prevent.
 */
export const VOICE_CALL_POLICY = {
  /** Minutes of headroom the held reservation keeps ahead of elapsed time. */
  reserveBlockMinutes: 3,
  /** Hard stop. A forgotten call in a pocket is the expensive failure mode. */
  maxCallMinutes: 30,
  /** How often the app reports elapsed time while a call is up. */
  heartbeatSeconds: 20,
  /**
   * How long a call may go unheard from before the server settles it on the
   * client's behalf. Generous enough to survive a tunnel, short enough that an
   * app killed mid-call does not hold credits for long.
   */
  heartbeatGraceSeconds: 90
} as const;

export type VoiceCallSettlement = {
  billableSeconds: number;
  billableMinutes: number;
  credits: number;
};

export type VoiceCallHoldPlan = {
  /** Credits the reservation should cover in total, given time used so far. */
  targetHeldCredits: number;
  /** Extra credits to reserve now; 0 when the current hold is deep enough. */
  additionalCredits: number;
};

/**
 * Whole minutes a call is charged for.
 *
 * Rounded up, because a started minute has already been paid for upstream, and
 * floored at zero so a call that failed before any audio flowed is free. The
 * "connected for two seconds then the line dropped" case is deliberately not
 * free-ridden into a minute: see {@link settleVoiceCall}.
 */
export function billableVoiceCallMinutes(seconds: number): number {
  if (!Number.isFinite(seconds) || seconds <= 0) {
    return 0;
  }
  return Math.ceil(seconds / 60);
}

/**
 * What a finished call actually costs.
 *
 * A call is capped at `maxCallMinutes` even if the client reports more — the
 * server stops extending the hold there, so charging past it would bill for
 * time the user was told they would not be charged for.
 *
 * Calls shorter than {@link FREE_CALL_SECONDS} cost nothing. That covers the
 * "connected, heard nothing, hung up" case, which reads as a broken feature
 * rather than a purchase.
 */
export function settleVoiceCall(elapsedSeconds: number, pricing: CreditPricing = creditPricing()): VoiceCallSettlement {
  const capped = Math.min(Math.max(elapsedSeconds, 0), VOICE_CALL_POLICY.maxCallMinutes * 60);
  const billableSeconds = capped < FREE_CALL_SECONDS ? 0 : capped;
  const billableMinutes = billableVoiceCallMinutes(billableSeconds);
  return {
    billableSeconds,
    billableMinutes,
    credits: billableMinutes * pricing.voiceCallPerMinute
  };
}

/** Below this, a call is treated as a failed connection rather than a call. */
export const FREE_CALL_SECONDS = 5;

/**
 * How deep the credit hold should be for a call that has run `elapsedSeconds`.
 *
 * The hold always covers the time already used plus a block of headroom, so the
 * client is never mid-sentence when the server decides it can no longer pay for
 * the next second.
 */
export function planVoiceCallHold(
  options: {
    elapsedSeconds: number;
    heldCredits: number;
  },
  pricing: CreditPricing = creditPricing()
): VoiceCallHoldPlan {
  const usedMinutes = billableVoiceCallMinutes(options.elapsedSeconds);
  const targetMinutes = Math.min(
    usedMinutes + VOICE_CALL_POLICY.reserveBlockMinutes,
    VOICE_CALL_POLICY.maxCallMinutes
  );
  const targetHeldCredits = targetMinutes * pricing.voiceCallPerMinute;
  return {
    targetHeldCredits,
    additionalCredits: Math.max(0, targetHeldCredits - Math.max(0, options.heldCredits))
  };
}

/**
 * Seconds of call the current hold still pays for.
 *
 * The app counts this down and ends the call itself when it reaches zero, so
 * running out of credits looks like a call ending rather than a call failing.
 */
export function voiceCallSecondsRemaining(
  options: {
    elapsedSeconds: number;
    heldCredits: number;
  },
  pricing: CreditPricing = creditPricing()
): number {
  // A free minute is infinitely long, not zero seconds long: dividing by a
  // per-minute rate of 0 has to answer "the cap", or a free call ends instantly.
  if (pricing.voiceCallPerMinute <= 0) {
    return Math.max(0, VOICE_CALL_POLICY.maxCallMinutes * 60 - Math.max(0, options.elapsedSeconds));
  }
  const paidMinutes = Math.floor(Math.max(0, options.heldCredits) / pricing.voiceCallPerMinute);
  const paidSeconds = Math.min(paidMinutes, VOICE_CALL_POLICY.maxCallMinutes) * 60;
  return Math.max(0, paidSeconds - Math.max(0, options.elapsedSeconds));
}

/** Credits a call needs on hand before it is allowed to start. */
export function voiceCallStartingCredits(pricing: CreditPricing = creditPricing()): number {
  return VOICE_CALL_POLICY.reserveBlockMinutes * pricing.voiceCallPerMinute;
}

export type VoiceCallEndingReason = "credits" | "limit";

/**
 * Why a call is running out, while it still has time left to say so.
 *
 * The app cannot work this out for itself. Running dry and reaching the length
 * cap both look like a shrinking clock from the outside, and they need different
 * words — one is fixed by buying credits and the other is not.
 *
 * The two are distinguishable here because they fail differently: a hold that
 * cannot be topped up throws, whereas the cap simply stops the hold growing, so
 * nothing ever throws and only the elapsed time gives it away.
 */
export function voiceCallEndingReason(options: {
  elapsedSeconds: number;
  heldCredits: number;
  topUpFailed: boolean;
}): VoiceCallEndingReason | null {
  if (options.topUpFailed) {
    return "credits";
  }
  // Inside the final block, the hold has stopped being extended because the cap
  // says so rather than because the balance ran out.
  const capSeconds = VOICE_CALL_POLICY.maxCallMinutes * 60;
  const warnFrom = capSeconds - VOICE_CALL_POLICY.reserveBlockMinutes * 60;
  if (options.elapsedSeconds >= warnFrom) {
    return "limit";
  }
  return null;
}
