import type { FastifyPluginAsync } from "fastify";
import { prisma } from "@book-maker/db";
import { z } from "zod";
import { createGoogleIdentityVerifier, type GoogleIdentityVerifier } from "./googleIdentity.js";
import { hasCurrentLegalAcceptance, legalAcceptanceEvidence } from "./legalAcceptance.js";
import {
  authErrorResponseSchema, authSessionResponseSchema, authSessionResponse,
  createMobileSession, isActiveUser, requestSessionContext, sendAuthError, verifyPassword
} from "./mobileAuth.js";
import { InMemoryRateLimiter, identityRateLimitKey, rateLimitKey, sendRateLimitError } from "./rateLimit.js";
import { lookupSignupCountry } from "./signupCountry.js";

const bodySchema = z.object({
  idToken: z.string().min(1).max(8192),
  termsAccepted: z.boolean().default(false),
  ageGuardianAttested: z.boolean().default(false),
  password: z.string().min(1).max(200).optional()
}).strict();

type Options = { verifier?: GoogleIdentityVerifier | null };

export const mobileGoogleAuthRoutes: FastifyPluginAsync<Options> = async (fastify, options) => {
  const verifier = options.verifier === undefined ? createGoogleIdentityVerifier() : options.verifier;
  const limiter = new InMemoryRateLimiter({ maxAttempts: 20, windowMs: 15 * 60 * 1000 });
  const signupLimiter = new InMemoryRateLimiter({ maxAttempts: 5, windowMs: 15 * 60 * 1000 });

  fastify.post("/api/mobile/auth/google", { attachValidation: true, schema: routeSchema }, async (request, reply) => {
    const parsed = bodySchema.safeParse(request.body);
    if (request.validationError || !parsed.success) {
      return sendAuthError(reply, 400, "VALIDATION_ERROR", "Provide a Google sign-in token.");
    }
    const limit = limiter.hit(rateLimitKey(request, "google"));
    if (!limit.allowed) return sendRateLimitError(reply, limit.retryAfterSeconds);
    if (!verifier) {
      return sendAuthError(reply, 503, "GOOGLE_SIGN_IN_UNAVAILABLE", "Google sign-in is not available right now. Use email instead.");
    }
    const identity = await verifier(parsed.data.idToken).catch(() => null);
    if (!identity) {
      return sendAuthError(reply, 401, "INVALID_GOOGLE_TOKEN", "Google sign-in could not be verified. Please try again.");
    }
    // The identity-only cap also bounds password guesses when linking, even
    // if the caller rotates IPs or signs in through different Google accounts.
    const identityLimit = limiter.hit(identityRateLimitKey("google", identity.email));
    if (!identityLimit.allowed) return sendRateLimitError(reply, identityLimit.retryAfterSeconds);

    let user = await prisma.user.findUnique({ where: { googleSubject: identity.subject } });
    let created = false;
    if (!user) {
      const existing = await prisma.user.findUnique({
        where: { email: identity.email }, include: { passwordCredential: true }
      });
      if (existing) {
        if (!isActiveUser(existing)) {
          return sendAuthError(reply, 403, "ACCOUNT_DISABLED", "This account is not active.");
        }
        if (existing.googleSubject && existing.googleSubject !== identity.subject) {
          return sendAuthError(reply, 409, "GOOGLE_ACCOUNT_CONFLICT", "Use the Google account already connected to this account, or sign in with email.");
        }
        // An email match is not proof of account ownership, particularly for
        // third-party email addresses used with Google. Link only after proof
        // of the existing password; subsequent logins use the immutable sub.
        if (existing.googleSubject !== identity.subject) {
          if (!parsed.data.password) {
            return sendAuthError(reply, 409, "GOOGLE_LINK_REQUIRED", "An account with this email exists. Enter its Tomeza password to connect Google.");
          }
          if (!existing.passwordCredential ||
              !await verifyPassword(parsed.data.password, existing.passwordCredential.passwordHash)) {
            return sendAuthError(reply, 401, "INVALID_CREDENTIALS", "That password is incorrect. Use Forgot password on the sign-in screen if needed.");
          }
          try {
            const linked = await prisma.user.updateMany({
              where: {
                id: existing.id, googleSubject: null, status: "ACTIVE", disabledAt: null,
                passwordCredential: { is: { passwordHash: existing.passwordCredential.passwordHash } }
              },
              data: { googleSubject: identity.subject }
            });
            if (linked.count !== 1) {
              return sendAuthError(reply, 409, "GOOGLE_ACCOUNT_CONFLICT", "Your account changed. Please sign in again.");
            }
          } catch (error) {
            if (!isUniqueConflict(error)) throw error;
            return sendAuthError(reply, 409, "GOOGLE_ACCOUNT_CONFLICT", "Your account changed. Please sign in again.");
          }
        }
        user = existing;
      } else {
        if (!parsed.data.termsAccepted || !parsed.data.ageGuardianAttested) {
          return sendAuthError(reply, 409, "GOOGLE_SIGNUP_REQUIRED", "Accept the Terms and Privacy Policy and confirm the age requirement to create your account.");
        }
        const signupLimit = signupLimiter.hit(rateLimitKey(request, "google-signup"));
        if (!signupLimit.allowed) return sendRateLimitError(reply, signupLimit.retryAfterSeconds);
        const context = requestSessionContext(request);
        const countryCode = context.ipHash ? await lookupSignupCountry(request.ip).catch(() => {
          request.log.warn({ event: "signup.country_lookup_failed" }, "Using the fallback welcome-credit amount");
          return null;
        }) : null;
        try {
          user = await prisma.user.create({ data: {
            email: identity.email,
            googleSubject: identity.subject,
            ...(identity.displayName ? { displayName: identity.displayName } : {}),
            legalAcceptances: { create: legalAcceptanceEvidence(parsed.data, "mobile_google_signup", request) },
            welcomeCreditGrant: { create: {
              ...(context.ipHash ? { ipHash: context.ipHash } : {}),
              ...(countryCode ? { countryCode } : {})
            } }
          } });
          created = true;
        } catch (error) {
          if (!isUniqueConflict(error)) throw error;
          // A simultaneous Google signup can win. Only its sub is safe to
          // reuse; a simultaneous password signup must still prove ownership.
          user = await prisma.user.findUnique({ where: { googleSubject: identity.subject } });
          if (!user) return sendAuthError(reply, 409, "GOOGLE_LINK_REQUIRED", "An account with this email exists. Enter its Tomeza password to connect Google.");
        }
      }
    }
    if (!isActiveUser(user)) return sendAuthError(reply, 403, "ACCOUNT_DISABLED", "This account is not active.");
    const session = await createMobileSession(user.id, requestSessionContext(request));
    return reply.code(created ? 201 : 200).send(
      authSessionResponse(user, session, created || await hasCurrentLegalAcceptance(user.id))
    );
  });
};

function isUniqueConflict(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "P2002";
}

const routeSchema = {
  tags: ["Mobile Auth"], operationId: "mobileAuthGoogle",
  body: {
    type: "object", required: ["idToken"], additionalProperties: false,
    properties: {
      idToken: { type: "string", minLength: 1, maxLength: 8192 },
      termsAccepted: { type: "boolean" }, ageGuardianAttested: { type: "boolean" },
      password: { type: "string", minLength: 1, maxLength: 200 }
    }
  },
  response: {
    200: authSessionResponseSchema, 201: authSessionResponseSchema,
    400: authErrorResponseSchema, 401: authErrorResponseSchema, 403: authErrorResponseSchema,
    409: authErrorResponseSchema, 429: authErrorResponseSchema, 503: authErrorResponseSchema
  }
} as const;
