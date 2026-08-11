import { type AuthFailure } from "../mobileAuth.js";
import { InMemoryRateLimiter, identityRateLimitKey, sendRateLimitError } from "../rateLimit.js";
import { authenticateMobileBearer, sendMobileAuthFailure, type MobileAuthContext } from "../requestAuth.js";
import {
  InsufficientCreditsError,
  ensureProjectExportEntitlementOrSpend,
  hasActiveSubscriptionEntitlement
} from "@book-maker/db/billing";
import { type FastifyReply, type FastifyRequest } from "fastify";

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
  _request: FastifyRequest,
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
  _request: FastifyRequest,
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
