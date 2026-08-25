import { type AuthFailure } from "../mobileAuth.js";
import { InMemoryRateLimiter, identityRateLimitKey, sendRateLimitError } from "../rateLimit.js";
import { authenticateMobileBearer, sendMobileAuthFailure, type MobileAuthContext } from "../requestAuth.js";
import {
  GenerationAttemptConflictError,
  GenerationQuotaExceededError,
  InsufficientCreditsError,
  ensureProjectExportEntitlementOrSpend,
  hasActiveSubscriptionEntitlement
} from "@book-maker/db/billing";
import { type FastifyError, type FastifyReply, type FastifyRequest } from "fastify";

/**
 * Mobile auth guard, rate-limit guard, and the shared error response helpers.
 */

export async function requireMobileAuth(request: FastifyRequest, reply: FastifyReply): Promise<MobileAuthContext | null> {
  const auth = await authenticateMobileBearer(request);
  if (!auth) {
    sendMobileError(reply, 401, "AUTH_REQUIRED", "Sign in to continue.");
    return null;
  }
  if (isAuthFailure(auth)) {
    sendMobileAuthFailure(reply, auth);
    return null;
  }
  return auth;
}

export function hitAuthenticatedLimit(
  limiter: InMemoryRateLimiter,
  reply: FastifyReply,
  userId: string,
  action: string
): boolean {
  // Keyed by the account alone: these limits are about the *user*, and an IP
  // prefix handed a fresh bucket to every address a rotating carrier NAT
  // walked through.
  const limit = limiter.hit(identityRateLimitKey(userId, action));
  if (limit.allowed) {
    return true;
  }
  sendRateLimitError(reply, limit.retryAfterSeconds);
  return false;
}

/**
 * Subscribers get this much more headroom on the tier-aware limits. The
 * defaults were sized for free-tier abuse, and a Max subscriber generating
 * books all afternoon is the customer, not the abuser.
 */
const SUBSCRIBER_RATE_LIMIT_MULTIPLIER = 5;
const SUBSCRIBER_CACHE_TTL_MS = 60_000;
const subscriberCache = new Map<string, { subscribed: boolean; expiresAt: number }>();

async function isSubscriberForRateLimit(userId: string): Promise<boolean> {
  const now = Date.now();
  const cached = subscriberCache.get(userId);
  if (cached && cached.expiresAt > now) {
    return cached.subscribed;
  }
  // A lookup failure means the default ceiling, never a blocked request.
  const subscribed = await hasActiveSubscriptionEntitlement(userId).catch(() => false);
  subscriberCache.set(userId, { subscribed: subscribed === true, expiresAt: now + SUBSCRIBER_CACHE_TTL_MS });
  return subscribed === true;
}

/**
 * [hitAuthenticatedLimit] with a subscriber-scaled ceiling, for the limits a
 * heavy *paying* user can realistically reach (generation, the advisor).
 * Free-tier limits are unchanged; the subscription check is cached briefly so
 * the limit check stays cheap.
 */
export async function hitTieredLimit(
  limiter: InMemoryRateLimiter,
  reply: FastifyReply,
  userId: string,
  action: string
): Promise<boolean> {
  const multiplier = (await isSubscriberForRateLimit(userId)) ? SUBSCRIBER_RATE_LIMIT_MULTIPLIER : 1;
  // Account-keyed for the same reason as `hitAuthenticatedLimit`.
  const limit = limiter.hit(identityRateLimitKey(userId, action), Date.now(), limiter.maxAttempts * multiplier);
  if (limit.allowed) {
    return true;
  }
  sendRateLimitError(reply, limit.retryAfterSeconds);
  return false;
}

export function isAuthFailure(auth: MobileAuthContext | AuthFailure): auth is AuthFailure {
  return "ok" in auth && auth.ok === false;
}

export function sendMobileError(reply: FastifyReply, statusCode: number, code: string, message: string): FastifyReply {
  return reply.code(statusCode).send({
    error: {
      code,
      message
    }
  });
}

/** The one answer every mobile route gives when its project lookup misses. */
export function sendProjectNotFound(reply: FastifyReply): FastifyReply {
  return sendMobileError(reply, 404, "PROJECT_NOT_FOUND", "Project not found.");
}

/** The one answer every mobile route gives when its edit-operation lookup misses. */
export function sendOperationNotFound(reply: FastifyReply): FastifyReply {
  return sendMobileError(reply, 404, "OPERATION_NOT_FOUND", "That edit was not found.");
}

/**
 * A body Fastify could not read at all, answered in the shape every other
 * refusal on these routes arrives in.
 *
 * A route that declares a status is declaring how *every* answer at that status
 * is serialized, Fastify's own included — and Fastify's error body is
 * `{ statusCode, error: "Bad Request", message }`, where `mobileAuthError` wants
 * `error` to be an object with a required `code`. A string cannot be pushed
 * through that, so the serializer throws and the reader gets a 500
 * (`FST_ERR_FAILED_ERROR_SERIALIZATION`) for a request that was merely
 * mis-encoded. Before those statuses were declared the fallback serializer
 * answered these correctly, which is why declaring them is what surfaced it.
 *
 * `attachValidation: true` closes the half of that which is *validation* — ajv
 * hands its rejection to the handler, whose own parse is then the only gate
 * that answers. It cannot close this half: `FST_ERR_CTP_INVALID_JSON_BODY` comes
 * out of the content-type parser, before validation runs and so before there is a
 * `request.validationError` for a handler to read — the request never reaches
 * one at all. So the parser's 400 is translated here into the one shape the app
 * reads a code out of, and everything else is handed straight back to Fastify's
 * own handler, which is what the 500s these routes can still throw are supposed
 * to get.
 *
 * It sits here rather than in either route group because both of them need it:
 * the two character writes in `routes/characters.ts` and, in
 * `routes/characterImages.ts`, the portrait request and the photo upload —
 * whose `application/octet-stream` parser does not stop a client from sending
 * `application/json` with something the JSON parser cannot read.
 *
 * **A route-level `errorHandler` is not a parser hook, so the parser has to be
 * recognised rather than assumed.** Fastify hands this every error the route's
 * hooks and its own handler throw as well, and `statusCode === 400` — which is
 * what this used to test — is the shape every Fastify-family error carries, not
 * the parser's signature. All four routes rethrow whatever
 * `sendCharacterWriteError` does not recognise, and `POST /:id/portrait` runs
 * `enqueueGenerationJob`, `dispatchGenerationJob` and `startGenerationAttempt`
 * long after the parse; any of those — or the next hook or plugin — surfacing a
 * 400 was answered "That request could not be read", with its own code and
 * message gone and nothing handed back to Fastify to log it.
 *
 * What the predicate does not claim goes to `reply.send(error)`, which is
 * Fastify's normal handling: a status no response schema names is serialized
 * whole, code and message intact. A status the route *does* declare with
 * `mobileAuthError` cannot be — that is the same serialization failure this
 * comment opens with, arriving loud, logged, and carrying `Original error: …`,
 * which is what a handler throwing where it should have sent deserves and is
 * the reason not to reach for the bare status test again. `FST_ERR_VALIDATION`
 * is a 400 that never gets here: every route installing this either carries
 * `attachValidation: true` or declares no schema for ajv to compile, so its own
 * parse is the only gate, and the ids in their paths carry no JSON schema
 * either.
 */
export function sendUnreadableBodyError(error: FastifyError, request: FastifyRequest, reply: FastifyReply): void {
  if (isUnreadableRequestBody(error, request)) {
    sendMobileError(reply, 400, "VALIDATION_ERROR", "That request could not be read.");
    return;
  }
  reply.send(error);
}

/**
 * The content-type parser names every refusal it invents after itself, which is
 * what makes the family a test rather than a guess:
 * `FST_ERR_CTP_INVALID_JSON_BODY` for prose the JSON parser cannot read,
 * `FST_ERR_CTP_EMPTY_JSON_BODY` for an empty one, `FST_ERR_CTP_INVALID_CONTENT_LENGTH`
 * for a body that did not match its header.
 */
const CONTENT_TYPE_PARSER_CODE_PREFIX = "FST_ERR_CTP_";

function isUnreadableRequestBody(error: FastifyError, request: FastifyRequest): boolean {
  // The parser's other two refusals answer at a status of their own —
  // `FST_ERR_CTP_BODY_TOO_LARGE` is 413 and `FST_ERR_CTP_INVALID_MEDIA_TYPE` is
  // 415 — and no route installing this declares either, so Fastify's fallback
  // serializer already answers them whole. Translating them would move a
  // reader's "that photo is too big" to a bare 400. Only the parser's 400s meet
  // a declared `mobileAuthError` and only they need the shape.
  if (error.statusCode !== 400) {
    return false;
  }
  const code: string | undefined = error.code;
  if (code !== undefined && code.startsWith(CONTENT_TYPE_PARSER_CODE_PREFIX)) {
    return true;
  }
  // The one unreadable body the parser does not name. When the payload stream
  // *itself* fails, `rawBody` stamps `statusCode = 400` onto whatever the stream
  // threw and sends that on — measured on this Fastify as
  // `Error { code: "ECONNRESET", message: "aborted", statusCode: 400 }` for a
  // client that hangs up mid-body. Nothing about that error says "parser", so it
  // is recognised by identity instead: Node destroys a stream *with* the error
  // that killed it, so `request.raw.errored` is this very object, where it is
  // null for a parser refusal and for anything a handler throws. Status is the
  // one thing it must not be recognised by — `request.body` is `undefined` here
  // and also for a bodyless `POST /:id/portrait`, whose body is optional and
  // whose handler is exactly the one that can throw a 400 of its own.
  return request.raw.errored === error;
}

/**
 * A mention write refusing something the request asked for, on its way to the
 * one ladder that answers it.
 *
 * It lives in this leaf because `libraryMentionRewrites.ts` throws it while the
 * character response ladder catches it. Row claims now live in their own leaf,
 * so the thrower and response modules never import through each other. This
 * module imports neither implementation and never will: it is also where
 * `sendMobileError`, the endpoint of every response rung, lives.
 * `libraryMentionRewrites.ts` keeps its established re-export.
 */
export class LibraryMentionError extends Error {
  constructor(
    // These strings go out on the wire under `/api/mobile/*`, which serves app
    // builds already installed, so they keep the noun they shipped with even
    // where the module that throws them has stopped being character-only. A
    // stale noun in an opaque code costs nothing; a renamed one is a client
    // that stops recognising the error.
    readonly code: "INVALID_CHARACTER_MENTION" | "CHARACTER_NOT_FOUND" | "CHARACTER_MENTION_TOO_LONG",
    message: string
  ) {
    super(message);
    this.name = "LibraryMentionError";
  }
}

export function sendInsufficientCredits(reply: FastifyReply, error: InsufficientCreditsError): FastifyReply {
  return reply.code(402).send({
    error: {
      code: error.code,
      message: "You need more credits for this action.",
      requiredCredits: error.requiredCredits,
      availableCredits: error.availableCredits,
      reservedCredits: error.reservedCredits
    }
  });
}

/**
 * The serializer's copy of that body, for any route that documents its 402.
 *
 * The three numbers are the whole point of the reply — the message says nothing
 * a reader can act on, and `PaywallCreditsNeeded.fromApiError` builds the
 * shortfall card out of `requiredCredits` — but fast-json-stringify removes
 * whatever the response schema does not name, and `mobileAuthError` names
 * `code` and `message` only. A 402 documented with that one arrives as a bare
 * sentence however carefully this assembled it, which is exactly the hazard
 * `contentRestrictedError` exists for one status code up. Most 402 routes
 * declare no schema at all and are serialized whole; this is for the ones that
 * do declare one. It sits beside the sender rather than with the other OpenAPI
 * fragments in `schemas.ts` because the two halves only work together.
 */
export const insufficientCreditsError = {
  type: "object",
  properties: {
    error: {
      type: "object",
      properties: {
        code: { type: "string" },
        message: { type: "string" },
        requiredCredits: { type: "integer" },
        availableCredits: { type: "integer" },
        reservedCredits: { type: "integer" }
      },
      required: ["code", "message", "requiredCredits", "availableCredits", "reservedCredits"]
    }
  },
  required: ["error"]
} as const;

/**
 * The free tier's illustrated-book budget is spent for this month.
 *
 * Deliberately not a silent downgrade to a text-only book: the user asked for
 * illustrations, so they get the choice between upgrading and turning visuals
 * off, and the quota travels with the error so the app can say which it is.
 */
export function sendImageLimitReached(
  reply: FastifyReply,
  quota: { used: number; limit: number; resetsAt: Date }
): FastifyReply {
  return reply.code(403).send({
    error: {
      code: "IMAGE_LIMIT_REACHED",
      message: `Free plans include ${quota.limit} illustrated books a month. Upgrade for unlimited, or turn visuals off.`,
      imageQuota: {
        used: quota.used,
        limit: quota.limit,
        resetsAt: quota.resetsAt.toISOString()
      }
    }
  });
}

/**
 * The shared part of a generation-attempt catch ladder.
 *
 * Route-specific errors must be handled before this function. In particular,
 * some plan routes deliberately translate `GenerationAttemptConflictError` to
 * older, route-specific wire codes, and the resume and portrait routes have
 * local conflict classes whose answers take precedence over this fallback.
 *
 * The quota rung is intentionally present for every caller even when it cannot
 * currently be reached. Audiobook attempts do not pass `imageQuotaLimit` to
 * `startGenerationAttempt`, so they cannot throw `GenerationQuotaExceededError`;
 * sharing the complete ladder there is harmless and prevents the copies from
 * drifting when generation-attempt failures evolve.
 *
 * Returns whether it answered so callers can rethrow unknown errors and retain
 * Fastify's logging and 500 handling.
 */
export function sendGenerationAttemptError(reply: FastifyReply, error: unknown): boolean {
  if (error instanceof GenerationQuotaExceededError) {
    sendImageLimitReached(reply, error.claim);
    return true;
  }
  if (error instanceof InsufficientCreditsError) {
    sendInsufficientCredits(reply, error);
    return true;
  }
  if (error instanceof GenerationAttemptConflictError) {
    sendMobileError(reply, 409, error.code, error.message);
    return true;
  }
  return false;
}

export async function ensureExportEntitlementForDownload(
  reply: FastifyReply,
  userId: string,
  projectId: string
): Promise<true | null> {
  try {
    await ensureProjectExportEntitlementOrSpend({
      userId,
      projectId,
      idempotencyKey: `mobile:project:${projectId}:export-unlock`
    });
    return true;
  } catch (error) {
    if (error instanceof InsufficientCreditsError) {
      sendInsufficientCredits(reply, error);
      return null;
    }
    throw error;
  }
}
