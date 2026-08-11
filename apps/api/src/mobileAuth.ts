import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import { createHash, randomBytes, scrypt as nodeScrypt, timingSafeEqual, type ScryptOptions } from "node:crypto";
import { prisma } from "@book-maker/db";
import { z } from "zod";
import {
  InMemoryRateLimiter,
  identityRateLimitKey,
  rateLimitKey,
  sendRateLimitError,
  type RateLimitConfig
} from "./rateLimit.js";
import { hasCurrentLegalAcceptance, legalAcceptanceEvidence } from "./legalAcceptance.js";

const ACCESS_TOKEN_PREFIX = "bma_at";
const REFRESH_TOKEN_PREFIX = "bma_rt";
const ACCESS_TOKEN_TTL_MS = 15 * 60 * 1000;
// 90 days: a reader who comes back after a quiet couple of months should not
// be met by a password prompt. Rotation on every refresh plus hash-only
// storage is what makes the longer window safe.
const REFRESH_TOKEN_TTL_MS = 90 * 24 * 60 * 60 * 1000;
const REFRESH_TOKEN_GRACE_MS = 30 * 1000;
const TOKEN_BYTE_LENGTH = 32;
const SCRYPT_N = 16_384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_KEY_LENGTH = 64;
const SCRYPT_MAXMEM = 64 * 1024 * 1024;
const DEFAULT_SIGN_UP_RATE_LIMIT = { maxAttempts: 5, windowMs: 15 * 60 * 1000 };
const DEFAULT_SIGN_IN_RATE_LIMIT = { maxAttempts: 10, windowMs: 15 * 60 * 1000 };

const emailSchema = z.string().trim().email().max(254).transform(normalizeEmail);
const passwordSchema = z.string().min(8).max(200);
const loginPasswordSchema = z.string().min(1).max(200);
const displayNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(120)
  .optional()
  .transform((value) => value || undefined);
const tokenSchema = z.string().trim().min(20).max(512);

const signUpBodySchema = z
  .object({
    email: emailSchema,
    password: passwordSchema,
    displayName: displayNameSchema,
    // Older shipped builds echo their compiled-in document versions. They are
    // accepted and ignored: the server stamps the versions in force, so a
    // version bump can never strand an installed app on a rejection loop.
    termsVersion: z.string().trim().max(40).optional(),
    privacyVersion: z.string().trim().max(40).optional(),
    termsAccepted: z.literal(true),
    ageGuardianAttested: z.literal(true)
  })
  .strict();
const signInBodySchema = z
  .object({
    email: emailSchema,
    password: loginPasswordSchema
  })
  .strict();
const refreshBodySchema = z.object({ refreshToken: tokenSchema }).strict();
const logoutBodySchema = z.object({ refreshToken: tokenSchema.optional() }).strict();

type MobileAuthRouteOptions = {
  signUpRateLimit?: Partial<RateLimitConfig>;
  signInRateLimit?: Partial<RateLimitConfig>;
};

type AuthUserRecord = {
  id: string;
  email: string;
  displayName: string | null;
  status: string;
  disabledAt?: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

type SessionWithUser = {
  id: string;
  userId: string;
  accessTokenExpiresAt: Date;
  refreshTokenExpiresAt: Date;
  revokedAt: Date | null;
  user: AuthUserRecord;
};

type MobileSessionContext = {
  userAgent?: string | null;
  ipHash?: string | null;
};

type IssuedMobileSession = {
  accessToken: string;
  refreshToken: string;
  accessTokenExpiresAt: Date;
  refreshTokenExpiresAt: Date;
};

export type AuthUser = {
  id: string;
  email: string;
  displayName: string | null;
  status: string;
  createdAt: string;
  updatedAt: string;
  legalAcceptanceRequired: boolean;
};

export type AuthFailure = {
  ok: false;
  statusCode: number;
  code: string;
  message: string;
};

export type VerifiedAccessToken =
  | {
      ok: true;
      user: AuthUser;
      sessionId: string;
    }
  | AuthFailure;

type RefreshedSession =
  | {
      ok: true;
      user: AuthUser;
      session: IssuedMobileSession;
    }
  | AuthFailure;

export const mobileAuthRoutes: FastifyPluginAsync<MobileAuthRouteOptions> = async (fastify, options) => {
  const signUpLimiter = new InMemoryRateLimiter({
    ...DEFAULT_SIGN_UP_RATE_LIMIT,
    ...options.signUpRateLimit
  });
  const signInLimiter = new InMemoryRateLimiter({
    ...DEFAULT_SIGN_IN_RATE_LIMIT,
    ...options.signInRateLimit
  });

  fastify.post(
    "/api/mobile/auth/signup",
    { attachValidation: true, schema: signUpRouteSchema },
    async (request, reply) => {
      if (hasValidationError(request)) {
        return sendAuthError(reply, 400, "VALIDATION_ERROR", "Enter a valid email and a password with at least 8 characters.");
      }

      const parsed = signUpBodySchema.safeParse(request.body);
      if (!parsed.success) {
        return sendAuthError(
          reply,
          400,
          "LEGAL_ACCEPTANCE_REQUIRED",
          "Accept the current Terms and Privacy Policy and confirm the age requirement to create an account."
        );
      }

      const limit = signUpLimiter.hit(rateLimitKey(request, parsed.data.email));
      if (!limit.allowed) {
        return sendRateLimitError(reply, limit.retryAfterSeconds);
      }

      const existing = await prisma.user.findUnique({
        where: { email: parsed.data.email },
        select: { id: true }
      });
      if (existing) {
        return sendAuthError(reply, 409, "EMAIL_ALREADY_REGISTERED", "An account with this email already exists.");
      }

      const passwordHash = await hashPassword(parsed.data.password);
      try {
        const user = await prisma.user.create({
          data: {
            email: parsed.data.email,
            ...(parsed.data.displayName ? { displayName: parsed.data.displayName } : {}),
            passwordCredential: {
              create: { passwordHash }
            },
            legalAcceptances: {
              create: legalAcceptanceEvidence(parsed.data, "mobile_signup", request)
            }
          }
        });
        const session = await createMobileSession(user.id, requestSessionContext(request));
        return reply.code(201).send(authSessionResponse(user, session, true));
      } catch (error) {
        if (isUniqueConstraintError(error)) {
          return sendAuthError(reply, 409, "EMAIL_ALREADY_REGISTERED", "An account with this email already exists.");
        }
        throw error;
      }
    }
  );

  fastify.post(
    "/api/mobile/auth/signin",
    { attachValidation: true, schema: signInRouteSchema },
    async (request, reply) => {
      if (hasValidationError(request)) {
        return sendAuthError(reply, 400, "VALIDATION_ERROR", "Enter a valid email and password.");
      }

      const parsed = signInBodySchema.safeParse(request.body);
      if (!parsed.success) {
        return sendAuthError(reply, 400, "VALIDATION_ERROR", "Enter a valid email and password.");
      }

      const limit = signInLimiter.hit(rateLimitKey(request, parsed.data.email));
      if (!limit.allowed) {
        return sendRateLimitError(reply, limit.retryAfterSeconds);
      }
      // Second dimension with no IP in it: rotating addresses — free on
      // carrier NAT — minted a fresh per-IP bucket per hop for the same target
      // mailbox, so the per-IP limit alone never slowed credential stuffing.
      // Wider than the per-IP ceiling so one shared office NAT cannot lock a
      // household out of a mailbox, but finite.
      const emailLimit = signInLimiter.hit(
        identityRateLimitKey("signin", parsed.data.email),
        Date.now(),
        signInLimiter.maxAttempts * 4
      );
      if (!emailLimit.allowed) {
        return sendRateLimitError(reply, emailLimit.retryAfterSeconds);
      }

      const user = await prisma.user.findUnique({
        where: { email: parsed.data.email },
        include: { passwordCredential: true }
      });
      if (!user?.passwordCredential) {
        await simulatePasswordVerification(parsed.data.password);
        return invalidCredentials(reply);
      }

      const passwordMatches = await verifyPassword(parsed.data.password, user.passwordCredential.passwordHash);
      if (!passwordMatches || !isActiveUser(user)) {
        return invalidCredentials(reply);
      }

      const session = await createMobileSession(user.id, requestSessionContext(request));
      return authSessionResponse(user, session, await hasCurrentLegalAcceptance(user.id));
    }
  );

  fastify.post(
    "/api/mobile/auth/refresh",
    { attachValidation: true, schema: refreshRouteSchema },
    async (request, reply) => {
      if (hasValidationError(request)) {
        return sendAuthError(reply, 400, "VALIDATION_ERROR", "Provide a valid refresh token.");
      }

      const parsed = refreshBodySchema.safeParse(request.body);
      if (!parsed.success) {
        return sendAuthError(reply, 400, "VALIDATION_ERROR", "Provide a valid refresh token.");
      }

      const refreshed = await refreshMobileSession(parsed.data.refreshToken, requestSessionContext(request));
      if (!refreshed.ok) {
        return sendAuthError(reply, refreshed.statusCode, refreshed.code, refreshed.message);
      }
      return authSessionResponse(refreshed.user, refreshed.session, !refreshed.user.legalAcceptanceRequired);
    }
  );

  fastify.post(
    "/api/mobile/auth/logout",
    { attachValidation: true, schema: logoutRouteSchema },
    async (request, reply) => {
      if (hasValidationError(request)) {
        return sendAuthError(reply, 400, "VALIDATION_ERROR", "Provide a valid session token.");
      }

      const parsed = logoutBodySchema.safeParse(request.body ?? {});
      if (!parsed.success) {
        return sendAuthError(reply, 400, "VALIDATION_ERROR", "Provide a valid session token.");
      }

      if (parsed.data.refreshToken) {
        await revokeMobileSessionByRefreshToken(parsed.data.refreshToken);
        return { ok: true };
      }

      const accessToken = readBearerToken(request);
      if (!accessToken) {
        return sendAuthError(reply, 401, "AUTH_REQUIRED", "Sign in to continue.");
      }

      await revokeMobileSessionByAccessToken(accessToken);
      return { ok: true };
    }
  );

  fastify.get("/api/mobile/auth/me", { schema: currentUserRouteSchema }, async (request, reply) => {
    const accessToken = readBearerToken(request);
    if (!accessToken) {
      return sendAuthError(reply, 401, "AUTH_REQUIRED", "Sign in to continue.");
    }

    const verified = await verifyMobileAccessToken(accessToken);
    if (!verified.ok) {
      return sendAuthError(reply, verified.statusCode, verified.code, verified.message);
    }

    const accepted = await hasCurrentLegalAcceptance(verified.user.id);
    return { user: { ...verified.user, legalAcceptanceRequired: !accepted } };
  });
};

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const derivedKey = await deriveScryptKey(password, salt, SCRYPT_KEY_LENGTH);
  return ["scrypt", SCRYPT_N, SCRYPT_R, SCRYPT_P, SCRYPT_KEY_LENGTH, salt.toString("base64url"), derivedKey.toString("base64url")].join("$");
}

export async function verifyPassword(password: string, encodedHash: string): Promise<boolean> {
  const parsed = parsePasswordHash(encodedHash);
  if (!parsed) {
    return false;
  }

  const derivedKey = await deriveScryptKey(password, parsed.salt, parsed.keyLength, {
    N: parsed.n,
    r: parsed.r,
    p: parsed.p
  });
  return safeEqual(derivedKey, parsed.hash);
}

export async function createMobileSession(
  userId: string,
  context: MobileSessionContext = {},
  options: { now?: Date } = {}
): Promise<IssuedMobileSession> {
  const now = options.now ?? new Date();
  const accessToken = generateToken(ACCESS_TOKEN_PREFIX);
  const refreshToken = generateToken(REFRESH_TOKEN_PREFIX);
  const accessTokenExpiresAt = new Date(now.getTime() + ACCESS_TOKEN_TTL_MS);
  const refreshTokenExpiresAt = new Date(now.getTime() + REFRESH_TOKEN_TTL_MS);

  await prisma.mobileSession.create({
    data: {
      userId,
      accessTokenHash: hashToken(accessToken),
      refreshTokenHash: hashToken(refreshToken),
      accessTokenExpiresAt,
      refreshTokenExpiresAt,
      ...(context.userAgent ? { userAgent: context.userAgent } : {}),
      ...(context.ipHash ? { ipHash: context.ipHash } : {})
    }
  });

  return {
    accessToken,
    refreshToken,
    accessTokenExpiresAt,
    refreshTokenExpiresAt
  };
}

export async function verifyMobileAccessToken(
  accessToken: string,
  options: { now?: Date } = {}
): Promise<VerifiedAccessToken> {
  const session = await prisma.mobileSession.findUnique({
    where: { accessTokenHash: hashToken(accessToken) },
    include: { user: true }
  });
  if (!session) {
    return authFailure(401, "INVALID_SESSION", "Sign in again to continue.");
  }

  const failure = sessionAuthFailure(session, "access", options.now ?? new Date());
  if (failure) {
    return failure;
  }

  return {
    ok: true,
    user: toAuthUser(session.user, true),
    sessionId: session.id
  };
}

export async function refreshMobileSession(
  refreshToken: string,
  context: MobileSessionContext = {},
  options: { now?: Date } = {}
): Promise<RefreshedSession> {
  const now = options.now ?? new Date();
  const presentedHash = hashToken(refreshToken);

  // Rotation invalidates the presented token, so a retry after a lost response
  // or a racing second refresh from the same device would otherwise kill the
  // session. The previous token stays accepted for a short grace window, and
  // the conditional update below keeps concurrent rotations from silently
  // overwriting each other.
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const session = await prisma.mobileSession.findFirst({
      where: {
        OR: [{ refreshTokenHash: presentedHash }, { previousRefreshTokenHash: presentedHash }]
      },
      include: { user: true }
    });
    if (!session) {
      return authFailure(401, "INVALID_SESSION", "Sign in again to continue.");
    }

    const failure = sessionAuthFailure(session, "refresh", now);
    if (failure) {
      return failure;
    }

    if (session.refreshTokenHash !== presentedHash) {
      const rotatedAt = session.refreshTokenRotatedAt;
      const withinGrace =
        rotatedAt != null && now.getTime() - rotatedAt.getTime() <= REFRESH_TOKEN_GRACE_MS;
      if (!withinGrace) {
        // Reuse of a rotated token outside the grace window is the classic
        // sign of a stolen refresh token: whoever presented this stale copy is
        // not the client that rotated it — and answering with a bare 401 left
        // the thief's *rotated* chain alive for the rest of the session's 90
        // days. Revoke the whole session so both chains die; the legitimate
        // user signs in again and gets a clean one.
        await prisma.mobileSession.updateMany({
          where: { id: session.id, revokedAt: null },
          data: { revokedAt: now }
        });
        return authFailure(401, "INVALID_SESSION", "Sign in again to continue.");
      }
    }

    const nextSession = issueSessionTokens(now);
    const rotated = await prisma.mobileSession.updateMany({
      where: {
        id: session.id,
        refreshTokenHash: session.refreshTokenHash
      },
      data: {
        accessTokenHash: hashToken(nextSession.accessToken),
        refreshTokenHash: hashToken(nextSession.refreshToken),
        previousRefreshTokenHash: session.refreshTokenHash,
        refreshTokenRotatedAt: now,
        accessTokenExpiresAt: nextSession.accessTokenExpiresAt,
        refreshTokenExpiresAt: nextSession.refreshTokenExpiresAt,
        lastUsedAt: now,
        ...(context.userAgent ? { userAgent: context.userAgent } : {}),
        ...(context.ipHash ? { ipHash: context.ipHash } : {})
      }
    });
    if (rotated.count === 0) {
      // A concurrent refresh rotated first; re-read and go through the grace
      // window check against the fresh session state.
      continue;
    }

    return {
      ok: true,
      user: toAuthUser(session.user, await hasCurrentLegalAcceptance(session.user.id)),
      session: nextSession
    };
  }

  return authFailure(401, "INVALID_SESSION", "Sign in again to continue.");
}

export async function revokeMobileSessionByRefreshToken(refreshToken: string, options: { now?: Date } = {}): Promise<void> {
  const presentedHash = hashToken(refreshToken);
  await prisma.mobileSession.updateMany({
    where: {
      OR: [{ refreshTokenHash: presentedHash }, { previousRefreshTokenHash: presentedHash }],
      revokedAt: null
    },
    data: { revokedAt: options.now ?? new Date() }
  });
}

export async function revokeMobileSessionByAccessToken(accessToken: string, options: { now?: Date } = {}): Promise<void> {
  await prisma.mobileSession.updateMany({
    where: { accessTokenHash: hashToken(accessToken), revokedAt: null },
    data: { revokedAt: options.now ?? new Date() }
  });
}

export function readBearerToken(request: FastifyRequest): string | null {
  const authorization = request.headers.authorization;
  if (!authorization) {
    return null;
  }
  const match = authorization.match(/^Bearer\s+(.+)$/i);
  const token = match?.[1]?.trim();
  return token || null;
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("base64url");
}

function issueSessionTokens(now: Date): IssuedMobileSession {
  const accessToken = generateToken(ACCESS_TOKEN_PREFIX);
  const refreshToken = generateToken(REFRESH_TOKEN_PREFIX);
  return {
    accessToken,
    refreshToken,
    accessTokenExpiresAt: new Date(now.getTime() + ACCESS_TOKEN_TTL_MS),
    refreshTokenExpiresAt: new Date(now.getTime() + REFRESH_TOKEN_TTL_MS)
  };
}

function generateToken(prefix: string): string {
  return `${prefix}_${randomBytes(TOKEN_BYTE_LENGTH).toString("base64url")}`;
}

async function simulatePasswordVerification(password: string): Promise<void> {
  await deriveScryptKey(password, Buffer.from("missing-mobile-user"), SCRYPT_KEY_LENGTH);
}

async function deriveScryptKey(
  password: string,
  salt: Buffer,
  keyLength: number,
  overrides: Partial<{ N: number; r: number; p: number }> = {}
): Promise<Buffer> {
  return scryptBuffer(password, salt, keyLength, {
    N: overrides.N ?? SCRYPT_N,
    r: overrides.r ?? SCRYPT_R,
    p: overrides.p ?? SCRYPT_P,
    maxmem: SCRYPT_MAXMEM
  });
}

function scryptBuffer(password: string, salt: Buffer, keyLength: number, options: ScryptOptions): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    nodeScrypt(password, salt, keyLength, options, (error, derivedKey) => {
      if (error) {
        reject(error);
        return;
      }
      resolve(derivedKey);
    });
  });
}

function parsePasswordHash(encodedHash: string):
  | {
      n: number;
      r: number;
      p: number;
      keyLength: number;
      salt: Buffer;
      hash: Buffer;
    }
  | null {
  const [algorithm, rawN, rawR, rawP, rawKeyLength, rawSalt, rawHash, extra] = encodedHash.split("$");
  if (algorithm !== "scrypt" || extra !== undefined || !rawN || !rawR || !rawP || !rawKeyLength || !rawSalt || !rawHash) {
    return null;
  }

  const n = Number(rawN);
  const r = Number(rawR);
  const p = Number(rawP);
  const keyLength = Number(rawKeyLength);
  if (![n, r, p, keyLength].every((value) => Number.isInteger(value) && value > 0)) {
    return null;
  }

  try {
    return {
      n,
      r,
      p,
      keyLength,
      salt: Buffer.from(rawSalt, "base64url"),
      hash: Buffer.from(rawHash, "base64url")
    };
  } catch {
    return null;
  }
}

function safeEqual(left: Buffer, right: Buffer): boolean {
  return left.length === right.length && timingSafeEqual(left, right);
}

function requestSessionContext(request: FastifyRequest): MobileSessionContext {
  const rawUserAgent = request.headers["user-agent"];
  const userAgent = Array.isArray(rawUserAgent) ? rawUserAgent.join(" ") : rawUserAgent;
  return {
    ...(userAgent ? { userAgent: userAgent.slice(0, 500) } : {}),
    ...(request.ip ? { ipHash: hashToken(`ip:${request.ip}`) } : {})
  };
}

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

function authSessionResponse(
  user: AuthUserRecord | AuthUser,
  session: IssuedMobileSession,
  legalAccepted: boolean
) {
  return {
    user: isSerializedAuthUser(user)
      ? { ...user, legalAcceptanceRequired: !legalAccepted }
      : toAuthUser(user, legalAccepted),
    session: {
      accessToken: session.accessToken,
      accessTokenExpiresAt: session.accessTokenExpiresAt.toISOString(),
      refreshToken: session.refreshToken,
      refreshTokenExpiresAt: session.refreshTokenExpiresAt.toISOString()
    }
  };
}

function toAuthUser(user: AuthUserRecord, legalAccepted: boolean): AuthUser {
  return {
    id: user.id,
    email: user.email,
    displayName: user.displayName ?? null,
    status: user.status,
    createdAt: user.createdAt.toISOString(),
    updatedAt: user.updatedAt.toISOString(),
    legalAcceptanceRequired: !legalAccepted
  };
}

function isSerializedAuthUser(user: AuthUserRecord | AuthUser): user is AuthUser {
  return typeof user.createdAt === "string";
}

function isActiveUser(user: AuthUserRecord): boolean {
  return user.status === "ACTIVE" && !user.disabledAt;
}

function sessionAuthFailure(session: SessionWithUser, tokenType: "access" | "refresh", now: Date): AuthFailure | null {
  if (session.revokedAt) {
    return authFailure(401, "SESSION_REVOKED", "Sign in again to continue.");
  }
  if (!isActiveUser(session.user)) {
    return authFailure(403, "ACCOUNT_DISABLED", "This account is not active.");
  }
  const expiresAt = tokenType === "access" ? session.accessTokenExpiresAt : session.refreshTokenExpiresAt;
  if (expiresAt.getTime() <= now.getTime()) {
    return authFailure(401, "SESSION_EXPIRED", "Sign in again to continue.");
  }
  return null;
}

function authFailure(statusCode: number, code: string, message: string): AuthFailure {
  return { ok: false, statusCode, code, message };
}

function invalidCredentials(reply: FastifyReply): FastifyReply {
  return sendAuthError(reply, 401, "INVALID_CREDENTIALS", "Email or password is incorrect.");
}

function sendAuthError(reply: FastifyReply, statusCode: number, code: string, message: string): FastifyReply {
  return reply.code(statusCode).send({
    error: {
      code,
      message
    }
  });
}

function hasValidationError(request: FastifyRequest): boolean {
  return Boolean((request as FastifyRequest & { validationError?: unknown }).validationError);
}

function isUniqueConstraintError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "P2002"
  );
}

const authErrorResponseSchema = {
  type: "object",
  required: ["error"],
  properties: {
    error: {
      type: "object",
      required: ["code", "message"],
      properties: {
        code: { type: "string" },
        message: { type: "string" }
      },
      additionalProperties: false
    }
  },
  additionalProperties: false
} as const;

const authUserResponseSchema = {
  type: "object",
  required: ["id", "email", "displayName", "status", "createdAt", "updatedAt", "legalAcceptanceRequired"],
  properties: {
    id: { type: "string" },
    email: { type: "string" },
    displayName: { type: "string", nullable: true },
    status: { type: "string" },
    createdAt: { type: "string" },
    updatedAt: { type: "string" },
    legalAcceptanceRequired: { type: "boolean" }
  },
  additionalProperties: false
} as const;

const sessionResponseSchema = {
  type: "object",
  required: ["accessToken", "accessTokenExpiresAt", "refreshToken", "refreshTokenExpiresAt"],
  properties: {
    accessToken: { type: "string" },
    accessTokenExpiresAt: { type: "string" },
    refreshToken: { type: "string" },
    refreshTokenExpiresAt: { type: "string" }
  },
  additionalProperties: false
} as const;

const authSessionResponseSchema = {
  type: "object",
  required: ["user", "session"],
  properties: {
    user: authUserResponseSchema,
    session: sessionResponseSchema
  },
  additionalProperties: false
} as const;

const signUpRequestSchema = {
  type: "object",
  required: ["email", "password", "termsAccepted", "ageGuardianAttested"],
  properties: {
    email: { type: "string", maxLength: 254 },
    password: { type: "string", minLength: 8, maxLength: 200 },
    displayName: { type: "string", minLength: 1, maxLength: 120 },
    termsVersion: {
      type: "string",
      maxLength: 40,
      description: "Deprecated. Accepted from older clients and ignored; the server records the versions in force."
    },
    privacyVersion: { type: "string", maxLength: 40, description: "Deprecated. Accepted and ignored." },
    termsAccepted: { type: "boolean", const: true },
    ageGuardianAttested: { type: "boolean", const: true }
  },
  additionalProperties: false
} as const;

const signInRequestSchema = {
  type: "object",
  required: ["email", "password"],
  properties: {
    email: { type: "string", maxLength: 254 },
    password: { type: "string", minLength: 1, maxLength: 200 }
  },
  additionalProperties: false
} as const;

const refreshRequestSchema = {
  type: "object",
  required: ["refreshToken"],
  properties: {
    refreshToken: { type: "string", minLength: 20, maxLength: 512 }
  },
  additionalProperties: false
} as const;

const logoutRequestSchema = {
  type: "object",
  properties: {
    refreshToken: { type: "string", minLength: 20, maxLength: 512 }
  },
  additionalProperties: false
} as const;

const signUpRouteSchema = {
  tags: ["Mobile Auth"],
  operationId: "mobileAuthSignUp",
  body: signUpRequestSchema,
  response: {
    201: authSessionResponseSchema,
    400: authErrorResponseSchema,
    409: authErrorResponseSchema,
    429: authErrorResponseSchema
  }
} as const;

const signInRouteSchema = {
  tags: ["Mobile Auth"],
  operationId: "mobileAuthSignIn",
  body: signInRequestSchema,
  response: {
    200: authSessionResponseSchema,
    400: authErrorResponseSchema,
    401: authErrorResponseSchema,
    429: authErrorResponseSchema
  }
} as const;

const refreshRouteSchema = {
  tags: ["Mobile Auth"],
  operationId: "mobileAuthRefresh",
  body: refreshRequestSchema,
  response: {
    200: authSessionResponseSchema,
    400: authErrorResponseSchema,
    401: authErrorResponseSchema,
    403: authErrorResponseSchema
  }
} as const;

const logoutRouteSchema = {
  tags: ["Mobile Auth"],
  operationId: "mobileAuthLogout",
  body: logoutRequestSchema,
  response: {
    200: {
      type: "object",
      required: ["ok"],
      properties: { ok: { type: "boolean" } },
      additionalProperties: false
    },
    400: authErrorResponseSchema,
    401: authErrorResponseSchema
  }
} as const;

const currentUserRouteSchema = {
  tags: ["Mobile Auth"],
  operationId: "mobileAuthCurrentUser",
  response: {
    200: {
      type: "object",
      required: ["user"],
      properties: { user: authUserResponseSchema },
      additionalProperties: false
    },
    401: authErrorResponseSchema,
    403: authErrorResponseSchema
  }
} as const;
