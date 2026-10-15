import { isUltraTierEnabled, type ModelTier } from "@book-maker/core";
import type { FastifyReply } from "fastify";
import { sendChatPayload } from "./chatStreaming.js";

/**
 * The operator's Ultra switch (`ultraTierEnabled` in the price list, default
 * off), and every door a *new* book at Ultra could start through.
 *
 * Ultra is unmeasured on today's routing — its one measured run failed and cost
 * $8 — so it launched hidden: the billing payload ships the switch and the app's
 * Effort picker drops Ultra while it is off. The server does not trust the
 * picker. While the switch is off, a book may not *start* at Ultra:
 *
 * - the creation Build, its preflight and the legacy create
 *   (`prepareMobileCreationBuild`, on the presets the book is built from);
 * - the first plan of a draft project (`queueInitialMobilePlan`, before its
 *   replay check so a paid plan replays);
 * - plan approval, the door that writes the book (never its replay).
 *
 * A book that already started at Ultra keeps its tier for everything after:
 * chat edits and rebuilds, retries, the Studio's assists, narration. That is
 * the least surprising rule for the reader who chose it, and the set of such
 * books is whatever was approved while the switch was on. Turning the switch on
 * at `/pricing` needs no release; turning it off strands nobody mid-book.
 *
 * The refusal is 422 `QUALITY_TIER_UNAVAILABLE` with one sentence, which every
 * installed app shows as it shows any refusal (`userFacingError`), so an older
 * build that still offers Ultra tells its reader what to do.
 */

export const ULTRA_TIER_UNAVAILABLE_MESSAGE =
  "Ultra effort isn't available right now. Choose Premium or another effort and try again.";

/** Whether starting a new book at `tier` is refused because Ultra is switched off. */
export function ultraTierRefused(tier: ModelTier): boolean {
  return tier === "ultra" && !isUltraTierEnabled();
}

/** Raised by a shared start path; `sendGenerationAttemptError` answers it. */
export class UltraTierUnavailableError extends Error {
  readonly code = "QUALITY_TIER_UNAVAILABLE";

  constructor() {
    super(ULTRA_TIER_UNAVAILABLE_MESSAGE);
    this.name = "UltraTierUnavailableError";
  }
}

export function sendUltraTierUnavailable(reply: FastifyReply): FastifyReply {
  return sendChatPayload(reply, 422, {
    error: { code: "QUALITY_TIER_UNAVAILABLE", message: ULTRA_TIER_UNAVAILABLE_MESSAGE }
  });
}
