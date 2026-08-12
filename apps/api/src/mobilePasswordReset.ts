import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import { randomInt } from "node:crypto";
import { prisma } from "@book-maker/db";
import { z } from "zod";
import { hasCurrentLegalAcceptance } from "./legalAcceptance.js";
import type { Mailer } from "./mailer.js";
import {
  authErrorResponseSchema,
  authSessionResponseSchema,
  authSessionResponse,
  createMobileSession,
  emailSchema,
  hashPassword,
  isActiveUser,
  passwordSchema,
  requestSessionContext,
  sendAuthError,
  verifyPassword
} from "./mobileAuth.js";
import {
  InMemoryRateLimiter,
  identityRateLimitKey,
  rateLimitKey,
  sendRateLimitError,
  type RateLimitConfig
} from "./rateLimit.js";

const RESET_CODE_TTL_MS = 15 * 60 * 1000;
// The code has a million-entry keyspace, so the guess cap is the whole online
// defense: five wrong entries kill the code and the reader asks for a new one.
const RESET_CODE_MAX_ATTEMPTS = 5;
const DEFAULT_FORGOT_RATE_LIMIT = { maxAttempts: 3, windowMs: 15 * 60 * 1000 };
const DEFAULT_RESET_RATE_LIMIT = { maxAttempts: 10, windowMs: 15 * 60 * 1000 };

const resetCodeSchema = z
  .string()
  .trim()
  .regex(/^\d{6}$/, "Enter the 6-digit code from the email.");

const forgotBodySchema = z.object({ email: emailSchema }).strict();
const resetBodySchema = z
  .object({
    email: emailSchema,
    code: resetCodeSchema,
    newPassword: passwordSchema
  })
  .strict();

type MobilePasswordResetRouteOptions = {
  mailer: Mailer | null;
  forgotRateLimit?: Partial<RateLimitConfig>;
  resetRateLimit?: Partial<RateLimitConfig>;
};

export const mobilePasswordResetRoutes: FastifyPluginAsync<MobilePasswordResetRouteOptions> = async (
  fastify,
  options
) => {
  const mailer = options.mailer;
  const forgotLimiter = new InMemoryRateLimiter({
    ...DEFAULT_FORGOT_RATE_LIMIT,
    ...options.forgotRateLimit
  });
  const resetLimiter = new InMemoryRateLimiter({
    ...DEFAULT_RESET_RATE_LIMIT,
    ...options.resetRateLimit
  });

  fastify.post(
    "/api/mobile/auth/password/forgot",
    { attachValidation: true, schema: forgotRouteSchema },
    async (request, reply) => {
      const parsed = hasValidationError(request) ? undefined : forgotBodySchema.safeParse(request.body);
      if (!parsed?.success) {
        return sendAuthError(reply, 400, "VALIDATION_ERROR", "Enter a valid email.");
      }

      const limit = forgotLimiter.hit(rateLimitKey(request, parsed.data.email));
      if (!limit.allowed) {
        return sendRateLimitError(reply, limit.retryAfterSeconds);
      }
      // Second, IP-free dimension: rotating addresses must not turn the limit
      // into unlimited codes mailed to one victim's inbox. Twice the per-IP
      // ceiling so a household NAT doesn't lock a mailbox out entirely.
      const emailLimit = forgotLimiter.hit(
        identityRateLimitKey("password-forgot", parsed.data.email),
        Date.now(),
        forgotLimiter.maxAttempts * 2
      );
      if (!emailLimit.allowed) {
        return sendRateLimitError(reply, emailLimit.retryAfterSeconds);
      }

      // Config-shaped, not account-shaped: this fires for every email equally,
      // so it leaks nothing — and it beats answering "sent" from a process
      // that cannot send anything.
      if (!mailer) {
        return sendAuthError(
          reply,
          503,
          "EMAIL_UNAVAILABLE",
          "Password reset is not available right now. Contact support."
        );
      }

      const code = generateResetCode();
      const codeHash = await hashPassword(code);

      const user = await prisma.user.findUnique({ where: { email: parsed.data.email } });
      if (!user || !isActiveUser(user)) {
        // Same 200 as the real path, with the scrypt work already spent above,
        // so neither the response nor its timing says whether the account exists.
        return { ok: true };
      }

      const context = requestSessionContext(request);
      // The newest email is the only one that works: pending codes for this
      // account die when a new one is issued.
      await prisma.$transaction([
        prisma.passwordResetRequest.deleteMany({
          where: { userId: user.id, consumedAt: null }
        }),
        prisma.passwordResetRequest.create({
          data: {
            userId: user.id,
            codeHash,
            expiresAt: new Date(Date.now() + RESET_CODE_TTL_MS),
            ...(context.ipHash ? { requestIpHash: context.ipHash } : {})
          }
        })
      ]);

      try {
        await mailer.send(passwordResetEmail(user.email, user.displayName, code));
      } catch (error) {
        // An outage must not confirm the account exists; the reader retries
        // when nothing arrives, and the log is where the outage shows up.
        request.log.error({ err: error, event: "email.password_reset_failed" }, "Password reset email failed");
      }

      return { ok: true };
    }
  );

  fastify.post(
    "/api/mobile/auth/password/reset",
    { attachValidation: true, schema: resetRouteSchema },
    async (request, reply) => {
      const parsed = hasValidationError(request) ? undefined : resetBodySchema.safeParse(request.body);
      if (!parsed?.success) {
        return sendAuthError(
          reply,
          400,
          "VALIDATION_ERROR",
          "Enter the 6-digit code and a new password with at least 8 characters."
        );
      }

      const limit = resetLimiter.hit(rateLimitKey(request, parsed.data.email));
      if (!limit.allowed) {
        return sendRateLimitError(reply, limit.retryAfterSeconds);
      }
      const emailLimit = resetLimiter.hit(
        identityRateLimitKey("password-reset", parsed.data.email),
        Date.now(),
        resetLimiter.maxAttempts * 2
      );
      if (!emailLimit.allowed) {
        return sendRateLimitError(reply, emailLimit.retryAfterSeconds);
      }

      const now = new Date();
      const user = await prisma.user.findUnique({ where: { email: parsed.data.email } });
      if (!user || !isActiveUser(user)) {
        await simulateCodeVerification(parsed.data.code);
        return invalidResetCode(reply);
      }

      const resetRequest = await prisma.passwordResetRequest.findFirst({
        where: { userId: user.id, consumedAt: null, expiresAt: { gt: now } },
        orderBy: { createdAt: "desc" }
      });
      if (!resetRequest) {
        await simulateCodeVerification(parsed.data.code);
        return invalidResetCode(reply);
      }

      // Claim the attempt before verifying, atomically: two guesses racing
      // must both count, or the cap is only advisory.
      const claimed = await prisma.passwordResetRequest.updateMany({
        where: { id: resetRequest.id, consumedAt: null, attempts: { lt: RESET_CODE_MAX_ATTEMPTS } },
        data: { attempts: { increment: 1 } }
      });
      if (claimed.count === 0) {
        await simulateCodeVerification(parsed.data.code);
        return invalidResetCode(reply);
      }

      const codeMatches = await verifyPassword(parsed.data.code, resetRequest.codeHash);
      if (!codeMatches) {
        return invalidResetCode(reply);
      }

      // Single use, even against a concurrent reset presenting the same code.
      const consumed = await prisma.passwordResetRequest.updateMany({
        where: { id: resetRequest.id, consumedAt: null },
        data: { consumedAt: now }
      });
      if (consumed.count === 0) {
        return invalidResetCode(reply);
      }

      const passwordHash = await hashPassword(parsed.data.newPassword);
      await prisma.userPasswordCredential.upsert({
        where: { userId: user.id },
        update: { passwordHash },
        create: { userId: user.id, passwordHash }
      });

      // Whoever knew the old password is signed out everywhere; the mint below
      // is the one session that survives.
      await prisma.mobileSession.updateMany({
        where: { userId: user.id, revokedAt: null },
        data: { revokedAt: now }
      });

      const session = await createMobileSession(user.id, requestSessionContext(request));
      return authSessionResponse(user, session, await hasCurrentLegalAcceptance(user.id));
    }
  );
};

export function generateResetCode(): string {
  return String(randomInt(0, 1_000_000)).padStart(6, "0");
}

export function passwordResetEmail(
  to: string,
  displayName: string | null,
  code: string
): { to: string; subject: string; text: string } {
  const greeting = displayName ? `Hi ${displayName},` : "Hi,";
  return {
    to,
    subject: "Your Tomeza password reset code",
    text: [
      greeting,
      "",
      "Your password reset code is:",
      "",
      `    ${code}`,
      "",
      "Enter it in the Tomeza app within 15 minutes to choose a new password.",
      "",
      "If you didn't request this, you can ignore this email — your password is unchanged."
    ].join("\n")
  };
}

async function simulateCodeVerification(code: string): Promise<void> {
  // The scrypt spend of a real verification, so a missing account or missing
  // request answers in the same time as a wrong code.
  await hashPassword(code);
}

function invalidResetCode(reply: Parameters<typeof sendAuthError>[0]) {
  return sendAuthError(reply, 400, "INVALID_RESET_CODE", "That code is not valid anymore. Request a new one.");
}

function hasValidationError(request: FastifyRequest): boolean {
  return Boolean((request as FastifyRequest & { validationError?: unknown }).validationError);
}

const okResponseSchema = {
  type: "object",
  required: ["ok"],
  properties: { ok: { type: "boolean" } },
  additionalProperties: false
} as const;

const forgotRequestSchema = {
  type: "object",
  required: ["email"],
  properties: {
    email: { type: "string", maxLength: 254 }
  },
  additionalProperties: false
} as const;

const resetRequestSchema = {
  type: "object",
  required: ["email", "code", "newPassword"],
  properties: {
    email: { type: "string", maxLength: 254 },
    code: { type: "string", minLength: 6, maxLength: 6 },
    newPassword: { type: "string", minLength: 8, maxLength: 200 }
  },
  additionalProperties: false
} as const;

const forgotRouteSchema = {
  tags: ["Mobile Auth"],
  operationId: "mobileAuthForgotPassword",
  body: forgotRequestSchema,
  response: {
    200: okResponseSchema,
    400: authErrorResponseSchema,
    429: authErrorResponseSchema,
    503: authErrorResponseSchema
  }
} as const;

const resetRouteSchema = {
  tags: ["Mobile Auth"],
  operationId: "mobileAuthResetPassword",
  body: resetRequestSchema,
  response: {
    200: authSessionResponseSchema,
    400: authErrorResponseSchema,
    429: authErrorResponseSchema
  }
} as const;
