import { type AuthFailure } from "../mobileAuth.js";
import { InMemoryRateLimiter, rateLimitKey, sendRateLimitError } from "../rateLimit.js";
import { authenticateMobileBearer, sendMobileAuthFailure, type MobileAuthContext } from "../requestAuth.js";
import { InsufficientCreditsError, ensureProjectExportEntitlementOrSpend } from "@book-maker/db/billing";
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
  request: FastifyRequest,
  reply: FastifyReply,
  userId: string,
  action: string
): boolean {
  const limit = limiter.hit(rateLimitKey(request, userId, action));
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
