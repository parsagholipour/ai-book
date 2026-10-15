import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import { prisma } from "@book-maker/db";
import { z } from "zod";
import {
  EMAIL_VERIFICATION_CODE_TTL_MS,
  EMAIL_VERIFICATION_DAILY_CODES,
  EMAIL_VERIFICATION_DAY_MS,
  EMAIL_VERIFICATION_MAX_ATTEMPTS,
  EMAIL_VERIFICATION_RESEND_MS,
  emailVerificationEmail,
  issueEmailVerificationCode,
  verificationCodeMatches
} from "./emailVerificationCodes.js";
import type { Mailer } from "./mailer.js";
import {
  type AuthUser,
  authErrorResponseSchema,
  authUserResponseSchema,
  readBearerToken,
  requestSessionContext,
  sendAuthError,
  verifyMobileAccessToken
} from "./mobileAuth.js";
import {
  InMemoryRateLimiter,
  clientNetworkRateLimitKey,
  identityRateLimitKey,
  sendRateLimitError,
  type RateLimitConfig
} from "./rateLimit.js";

/**
 * Proving the account's address: `POST /api/mobile/auth/email/verification`
 * mails a 6-digit code, `…/confirm` takes it and stamps `User.emailVerifiedAt`,
 * which is what the welcome grant waits for (packages/db/src/welcomeCredits.ts).
 * Sign-up mails the first code itself (`mobileAuth.ts`); Google sign-in needs
 * none, since its token must already say `email_verified`.
 *
 * Under `/api/mobile/auth/`, so the auth hook leaves them to their handlers, as
 * it does `/auth/me`: each one checks the bearer itself, and neither is behind
 * the terms gate — proving an address agrees to nothing. Signed in, so unlike
 * the password-reset routes there is no account to hide: a capped account is
 * told it is capped.
 */

/** Each wire code owns one sentence, here with the code. */
export const EMAIL_VERIFICATION_MESSAGES = {
  EMAIL_ALREADY_VERIFIED: "Your email is already verified.",
  INVALID_VERIFICATION_CODE: "That code didn't work. Check the newest email from Tomeza or send a new code.",
  VERIFICATION_EMAIL_UNAVAILABLE: "We can't send the verification email right now. Try again in a few minutes."
} as const;

type EmailVerificationCode = keyof typeof EMAIL_VERIFICATION_MESSAGES;

// Every send mails someone, so per caller it is held as tight as forgot-password;
// per account, the database's one-a-minute and ten-a-day are the real limits and
// this only stops a burst racing past them.
const DEFAULT_SEND_NETWORK_RATE_LIMIT = { maxAttempts: 10, windowMs: 15 * 60 * 1000 };
const DEFAULT_SEND_ACCOUNT_RATE_LIMIT = { maxAttempts: 5, windowMs: 15 * 60 * 1000 };
const DEFAULT_CONFIRM_NETWORK_RATE_LIMIT = { maxAttempts: 30, windowMs: 15 * 60 * 1000 };
const DEFAULT_CONFIRM_ACCOUNT_RATE_LIMIT = { maxAttempts: 10, windowMs: 15 * 60 * 1000 };

const confirmBodySchema = z
  .object({ code: z.string().trim().regex(/^\d{6}$/) })
  .strict();

type MobileEmailVerificationRouteOptions = {
  mailer: Mailer | null;
  sendNetworkRateLimit?: Partial<RateLimitConfig>;
  sendAccountRateLimit?: Partial<RateLimitConfig>;
  confirmNetworkRateLimit?: Partial<RateLimitConfig>;
  confirmAccountRateLimit?: Partial<RateLimitConfig>;
};

export const mobileEmailVerificationRoutes: FastifyPluginAsync<MobileEmailVerificationRouteOptions> = async (
  fastify,
  options
) => {
  const mailer = options.mailer;
  const sendNetworkLimiter = new InMemoryRateLimiter({ ...DEFAULT_SEND_NETWORK_RATE_LIMIT, ...options.sendNetworkRateLimit });
  const sendAccountLimiter = new InMemoryRateLimiter({ ...DEFAULT_SEND_ACCOUNT_RATE_LIMIT, ...options.sendAccountRateLimit });
  const confirmNetworkLimiter = new InMemoryRateLimiter({
    ...DEFAULT_CONFIRM_NETWORK_RATE_LIMIT,
    ...options.confirmNetworkRateLimit
  });
  const confirmAccountLimiter = new InMemoryRateLimiter({
    ...DEFAULT_CONFIRM_ACCOUNT_RATE_LIMIT,
    ...options.confirmAccountRateLimit
  });

  fastify.post("/api/mobile/auth/email/verification", { schema: sendRouteSchema }, async (request, reply) => {
    const user = await authenticate(request, reply);
    if (!user) {
      return reply;
    }
    const networkLimit = sendNetworkLimiter.hit(clientNetworkRateLimitKey(request, "email-verification"));
    if (!networkLimit.allowed) {
      return sendRateLimitError(reply, networkLimit.retryAfterSeconds);
    }
    const accountLimit = sendAccountLimiter.hit(identityRateLimitKey("email-verification", user.id));
    if (!accountLimit.allowed) {
      return sendRateLimitError(reply, accountLimit.retryAfterSeconds);
    }
    if (user.emailVerified) {
      return sendVerificationError(reply, 409, "EMAIL_ALREADY_VERIFIED");
    }
    if (!mailer) {
      return sendVerificationError(reply, 503, "VERIFICATION_EMAIL_UNAVAILABLE");
    }

    // Counted from rows, not memory, so a deploy resets neither the minute
    // between codes nor the day's ten — and sign-up's own code counts.
    const now = new Date();
    const recent = await prisma.emailVerificationRequest.findMany({
      where: { userId: user.id, createdAt: { gte: new Date(now.getTime() - EMAIL_VERIFICATION_DAY_MS) } },
      select: { createdAt: true },
      orderBy: { createdAt: "desc" },
      take: EMAIL_VERIFICATION_DAILY_CODES
    });
    const newest = recent[0];
    if (newest && now.getTime() - newest.createdAt.getTime() < EMAIL_VERIFICATION_RESEND_MS) {
      return sendRateLimitError(reply, secondsUntil(newest.createdAt.getTime() + EMAIL_VERIFICATION_RESEND_MS, now));
    }
    const oldestCounted = recent[EMAIL_VERIFICATION_DAILY_CODES - 1];
    if (oldestCounted) {
      return sendRateLimitError(reply, secondsUntil(oldestCounted.createdAt.getTime() + EMAIL_VERIFICATION_DAY_MS, now));
    }

    const issued = await issueEmailVerificationCode(user, {
      requestIpHash: requestSessionContext(request).ipHash,
      now
    });
    try {
      await mailer.send(emailVerificationEmail(user.email, user.displayName, issued.code));
    } catch (error) {
      // A code nobody received must not cost the reader their minute or a tenth
      // of their day; the one it expired stays expired, which costs nothing.
      await prisma.emailVerificationRequest.deleteMany({ where: { id: issued.id } }).catch(() => undefined);
      request.log.error({ err: error, event: "email.verification_failed" }, "Verification email failed");
      return sendVerificationError(reply, 503, "VERIFICATION_EMAIL_UNAVAILABLE");
    }
    return {
      sent: true,
      email: user.email,
      expiresInSeconds: Math.floor(EMAIL_VERIFICATION_CODE_TTL_MS / 1000),
      resendAfterSeconds: Math.floor(EMAIL_VERIFICATION_RESEND_MS / 1000)
    };
  });

  fastify.post(
    "/api/mobile/auth/email/verification/confirm",
    { attachValidation: true, schema: confirmRouteSchema },
    async (request, reply) => {
      const user = await authenticate(request, reply);
      if (!user) {
        return reply;
      }
      const parsed = request.validationError ? undefined : confirmBodySchema.safeParse(request.body);
      if (!parsed?.success) {
        return sendAuthError(reply, 400, "VALIDATION_ERROR", "Enter the 6-digit code from the email.");
      }
      const networkLimit = confirmNetworkLimiter.hit(clientNetworkRateLimitKey(request, "email-verification-confirm"));
      if (!networkLimit.allowed) {
        return sendRateLimitError(reply, networkLimit.retryAfterSeconds);
      }
      const accountLimit = confirmAccountLimiter.hit(identityRateLimitKey("email-verification-confirm", user.id));
      if (!accountLimit.allowed) {
        return sendRateLimitError(reply, accountLimit.retryAfterSeconds);
      }
      // A second tap, or a confirm racing one that already landed, is done.
      if (user.emailVerified) {
        return { user };
      }

      const now = new Date();
      // Only a code mailed to the address the account has now can prove it.
      const pending = await prisma.emailVerificationRequest.findFirst({
        where: { userId: user.id, email: user.email, consumedAt: null, expiresAt: { gt: now } },
        orderBy: { createdAt: "desc" }
      });
      if (!pending) {
        return sendVerificationError(reply, 400, "INVALID_VERIFICATION_CODE");
      }
      // Claimed before it is compared, atomically, so racing guesses all count.
      // Expiry is re-tested on the clock as it is now: a newer code expires
      // this one in place, possibly since the read above.
      const claimed = await prisma.emailVerificationRequest.updateMany({
        where: {
          id: pending.id,
          consumedAt: null,
          expiresAt: { gt: new Date() },
          attempts: { lt: EMAIL_VERIFICATION_MAX_ATTEMPTS }
        },
        data: { attempts: { increment: 1 } }
      });
      if (claimed.count === 0 || !verificationCodeMatches(parsed.data.code, pending.codeHash)) {
        return sendVerificationError(reply, 400, "INVALID_VERIFICATION_CODE");
      }
      const consumed = await prisma.emailVerificationRequest.updateMany({
        where: { id: pending.id, consumedAt: null },
        data: { consumedAt: now }
      });
      if (consumed.count === 0) {
        return sendVerificationError(reply, 400, "INVALID_VERIFICATION_CODE");
      }
      // Stamped only while the address is still the one the code went to.
      const verified = await prisma.user.updateMany({
        where: { id: user.id, email: pending.email, emailVerifiedAt: null },
        data: { emailVerifiedAt: now }
      });
      if (verified.count === 0) {
        const current = await prisma.user.findUnique({
          where: { id: user.id },
          select: { emailVerifiedAt: true }
        });
        if (!current?.emailVerifiedAt) {
          return sendVerificationError(reply, 400, "INVALID_VERIFICATION_CODE");
        }
      }
      request.log.info({ event: "email.verified", userId: user.id }, "Email verified");
      // The welcome grant settles on the reader's next balance read, which the
      // app makes straight away by refreshing its billing.
      return { user: { ...user, emailVerified: true } };
    }
  );
};

async function authenticate(request: FastifyRequest, reply: FastifyReply): Promise<AuthUser | null> {
  const accessToken = readBearerToken(request);
  if (!accessToken) {
    sendAuthError(reply, 401, "AUTH_REQUIRED", "Sign in to continue.");
    return null;
  }
  const verified = await verifyMobileAccessToken(accessToken);
  if (!verified.ok) {
    sendAuthError(reply, verified.statusCode, verified.code, verified.message);
    return null;
  }
  return verified.user;
}

function sendVerificationError(reply: FastifyReply, statusCode: number, code: EmailVerificationCode): FastifyReply {
  return sendAuthError(reply, statusCode, code, EMAIL_VERIFICATION_MESSAGES[code]);
}

function secondsUntil(epochMs: number, now: Date): number {
  return Math.max(1, Math.ceil((epochMs - now.getTime()) / 1000));
}

const sendRouteSchema = {
  tags: ["Mobile Auth"],
  operationId: "mobileAuthSendEmailVerification",
  response: {
    200: {
      type: "object",
      required: ["sent", "email", "expiresInSeconds", "resendAfterSeconds"],
      properties: {
        sent: { type: "boolean" },
        email: { type: "string" },
        expiresInSeconds: { type: "integer", minimum: 0 },
        resendAfterSeconds: { type: "integer", minimum: 0 }
      },
      additionalProperties: false
    },
    401: authErrorResponseSchema,
    403: authErrorResponseSchema,
    409: authErrorResponseSchema,
    429: authErrorResponseSchema,
    503: authErrorResponseSchema
  }
} as const;

const confirmRouteSchema = {
  tags: ["Mobile Auth"],
  operationId: "mobileAuthConfirmEmailVerification",
  body: {
    type: "object",
    required: ["code"],
    properties: { code: { type: "string", minLength: 6, maxLength: 6 } },
    additionalProperties: false
  },
  response: {
    200: {
      type: "object",
      required: ["user"],
      properties: { user: authUserResponseSchema },
      additionalProperties: false
    },
    400: authErrorResponseSchema,
    401: authErrorResponseSchema,
    403: authErrorResponseSchema,
    429: authErrorResponseSchema
  }
} as const;
