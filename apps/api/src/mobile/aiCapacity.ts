import type { FastifyReply, FastifyRequest } from "fastify";
import { modelTierFromMediaSettings, type ModelTier } from "@book-maker/core";
import { spendBreaker, type AiAccessDecision, type AiWorkKind, type BreakerLogger } from "../spendBreaker.js";
import { sendChatPayload } from "./chatStreaming.js";
import type { PendingEditState } from "./pendingEditState.js";

/**
 * The door side of the AI spend breaker (`../spendBreaker.ts`).
 *
 * Every mobile route that starts AI work calls {@link requireAiCapacity} once
 * it knows who is asking and what kind of work it is, and before it reserves
 * credits, claims a free-tier slot or hits a rate limiter — so a refusal costs
 * the reader nothing and claims nothing, and asking again while the breaker is
 * open never spends a rate-limit bucket either. A replay of work already paid
 * for answers before the gate, because that work is already running.
 *
 * Each wire code owns one sentence, here, beside the code: the app shows
 * `error.message` verbatim (`userFacingError`), so a route never spells one.
 */

export const AI_PAUSED_MESSAGE =
  "Tomeza has paused new AI work for a little while. Your credits and books are safe — please try again later.";

/** A free account while free spend is past the hard daily cap. Paying readers are not stopped by it. */
export const AI_PAUSED_FREE_TODAY_MESSAGE =
  "Tomeza is very busy today, so new AI work is paused for free accounts until 00:00 UTC. Your credits and books are safe, and paid plans are not affected.";

/** A free account while free spend is past the monthly ceiling, which lasts until the month turns or the operator raises it. */
export const AI_PAUSED_FREE_MONTH_MESSAGE =
  "Tomeza has used this month's AI capacity for free accounts, so new AI work is paused for them for now. Your credits and books are safe, and paid plans are not affected.";

/**
 * Names only Ultra: voice calls and audiobooks are plan perks, refused to a
 * free account with SUBSCRIPTION_REQUIRED before the breaker is asked
 * (`planPerks.ts`), so a free account never meets this code on them.
 */
export const AI_BUSY_MESSAGE =
  "Tomeza is very busy today, so Ultra quality is paused for free accounts until 00:00 UTC. Your credits are safe, everything else still works, and paid plans are not affected.";

export const AI_DAILY_LIMIT_MESSAGE =
  "You've reached today's AI limit for this account. It resets at 00:00 UTC, and your credits are safe until then.";

/** The kind of work a generation at this tier is. */
export function aiWorkKindForTier(tier: ModelTier): AiWorkKind {
  return tier === "ultra" ? "ultra" : "standard";
}

/** The kind of work a book's own tier makes an edit, assist or regeneration of it. */
export function aiWorkKindForMediaSettings(mediaSettings: unknown): AiWorkKind {
  return aiWorkKindForTier(modelTierFromMediaSettings(mediaSettings));
}

/**
 * Whether applying a priced edit card runs a model. The free edits are not
 * doors: moving or removing a picture, deleting or moving pages, a verified
 * exact replacement and a title change over a designed cover all quote 0 and
 * make no model call (the exact replacement's publication still re-embeds the
 * pages it changed). Every other card drafts, draws or replans something.
 */
export function proposalRunsModel(pending: Pick<PendingEditState, "intent" | "credits" | "structuralPlan">): boolean {
  const intent = pending.intent;
  if (!intent) return false;
  switch (intent.kind) {
    case "move_image":
    case "remove_image":
      return false;
    case "restructure_pages":
      return (pending.structuralPlan?.action ?? intent.structuralEdit?.action) === "insert";
    case "local_patch":
    case "book_title":
      return (pending.credits ?? 1) > 0;
    default:
      return true;
  }
}

/** True when the request may go on; otherwise the refusal has been sent. */
export async function requireAiCapacity(
  request: FastifyRequest,
  reply: FastifyReply,
  userId: string,
  kind: AiWorkKind
): Promise<boolean> {
  const decision = await spendBreaker.check(userId, kind, request.log);
  if (decision.allowed) return true;
  sendAiCapacityRefusal(reply, decision);
  return false;
}

/**
 * The same question for a door with no reply of its own to write — a service
 * function several routes share. The route's catch answers it with
 * {@link sendAiCapacityRefusal}, which `sendGenerationAttemptError` already does.
 */
export class AiCapacityRefusedError extends Error {
  constructor(readonly decision: Exclude<AiAccessDecision, { allowed: true }>) {
    super(`AI capacity refused: ${decision.code}`);
    this.name = "AiCapacityRefusedError";
  }
}

export async function assertAiCapacity(userId: string, kind: AiWorkKind, log?: BreakerLogger): Promise<void> {
  const decision = await spendBreaker.check(userId, kind, log);
  if (!decision.allowed) throw new AiCapacityRefusedError(decision);
}

export function sendAiCapacityRefusal(
  reply: FastifyReply,
  decision: Exclude<AiAccessDecision, { allowed: true }>
): FastifyReply {
  // The operator's pause and the paid cap have no end the reader can be told.
  if (!("resetsAt" in decision)) {
    return sendChatPayload(reply, 503, { error: { code: "AI_PAUSED", message: AI_PAUSED_MESSAGE } });
  }
  // A known end, so a client that honours `Retry-After` waits for it.
  reply.header("Retry-After", String(Math.max(1, Math.ceil((decision.resetsAt.getTime() - Date.now()) / 1000))));
  if (decision.code === "AI_PAUSED") {
    return sendChatPayload(reply, 503, {
      error: {
        code: "AI_PAUSED",
        message: decision.state === "monthly" ? AI_PAUSED_FREE_MONTH_MESSAGE : AI_PAUSED_FREE_TODAY_MESSAGE,
        resetsAt: decision.resetsAt.toISOString()
      }
    });
  }
  if (decision.code === "AI_BUSY") {
    return sendChatPayload(reply, 503, {
      error: { code: "AI_BUSY", message: AI_BUSY_MESSAGE, resetsAt: decision.resetsAt.toISOString() }
    });
  }
  return sendChatPayload(reply, 429, {
    error: { code: "AI_DAILY_LIMIT", message: AI_DAILY_LIMIT_MESSAGE, resetsAt: decision.resetsAt.toISOString() }
  });
}

/**
 * The OpenAPI shape of every refusal above: `mobileAuthError` plus the reset
 * time. A route that declares 429 or 503 declares it with this, because
 * fast-json-stringify drops a field the declared schema does not name.
 */
export const aiCapacityError = {
  type: "object",
  properties: {
    error: {
      type: "object",
      properties: {
        code: { type: "string" },
        message: { type: "string" },
        resetsAt: { type: "string", format: "date-time" }
      },
      required: ["code", "message"]
    }
  },
  required: ["error"]
} as const;
