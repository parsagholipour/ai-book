import { hasActiveSubscriptionEntitlement } from "@book-maker/db/billing";
import type { FastifyReply } from "fastify";
import { sendSubscriptionRequired } from "./httpErrors.js";

/**
 * The perks only a paid plan starts: a voice call (with a book's character or
 * a saved one) and an audiobook narration.
 *
 * Both spend real money on a tier-blind provider — a busy ten-minute call was
 * modelled at $0.57–2.60 and never measured, and a free account narrating its
 * welcome credits away cost the product the speech bill (launch review,
 * 2026-10-13) — so neither is offered to a free account at any price.
 *
 * "Paid" is the spend breaker's notion, `hasActiveSubscriptionEntitlement`, a
 * fresh read like the Word export's, never the 60-second rate-limit cache that
 * reads a lookup failure as free. The answer is the Word export's too: 403
 * `SUBSCRIPTION_REQUIRED`, which every shipped app already answers with the
 * paywall (or, on a surface that predates it, the sentence), and each perk owns
 * its sentence here, beside the code.
 *
 * Where it sits: after auth, validation and any replay of work already paid
 * for, and before the spend breaker, every rate-limit bucket the kind owns,
 * every hold and every row — so a refusal spends and claims nothing, and a free
 * reader is told what unlocks it rather than that Tomeza is busy.
 */

export const VOICE_CALL_PLAN_MESSAGE = "Voice calls are part of the Creator plan.";

export const AUDIOBOOK_PLAN_MESSAGE = "Audiobooks are part of the Creator plan.";

export type PlanPerk = "voice_call" | "audiobook";

const PLAN_PERK_MESSAGE: Record<PlanPerk, string> = {
  voice_call: VOICE_CALL_PLAN_MESSAGE,
  audiobook: AUDIOBOOK_PLAN_MESSAGE
};

/** True when the request may go on; otherwise the 403 has been sent. */
export async function requirePaidPlanPerk(reply: FastifyReply, userId: string, perk: PlanPerk): Promise<boolean> {
  if (await hasActiveSubscriptionEntitlement(userId)) {
    return true;
  }
  sendSubscriptionRequired(reply, PLAN_PERK_MESSAGE[perk]);
  return false;
}
