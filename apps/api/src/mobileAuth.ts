import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import { createHash, randomBytes, scrypt as nodeScrypt, timingSafeEqual, type ScryptOptions } from "node:crypto";
import { prisma } from "@book-maker/db";
import { z } from "zod";

const ACCESS_TOKEN_PREFIX = "bma_at";
const REFRESH_TOKEN_PREFIX = "bma_rt";
const ACCESS_TOKEN_TTL_MS = 15 * 60 * 1000;
const REFRESH_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;
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
    displayName: displayNameSchema
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

type RateLimitConfig = {
  maxAttempts: number;
  windowMs: number;
};

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

class InMemoryRateLimiter {
  private readonly buckets = new Map<string, { count: number; resetAt: number }>();
  private readonly config: RateLimitConfig;

  constructor(config: RateLimitConfig) {
    this.config = config;
  }

  hit(key: string, now = Date.now()): { allowed: true } | { allowed: false; retryAfterSeconds: number } {
    const existing = this.buckets.get(key);
    if (!existing || existing.resetAt <= now) {
      this.buckets.set(key, { count: 1, resetAt: now + this.config.windowMs });
      return { allowed: true };
    }

    existing.count += 1;
    if (existing.count <= this.config.maxAttempts) {
      return { allowed: true };
    }

    return {
      allowed: false,
      retryAfterSeconds: Math.max(1, Math.ceil((existing.resetAt - now) / 1000))
    };
  }
}

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
        return sendAuthError(reply, 400, "VALIDATION_ERROR", "Enter a valid email and a password with at least 8 characters.");
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
            }
          }
        });
        const session = await createMobileSession(user.id, requestSessionContext(request));
        return reply.code(201).send(authSessionResponse(user, session));
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
      return authSessionResponse(user, session);
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
      return authSessionResponse(refreshed.user, refreshed.session);
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

    return { user: verified.user };
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
    user: toAuthUser(session.user),
    sessionId: session.id
  };
}

export async function refreshMobileSession(
  refreshToken: string,
  context: MobileSessionContext = {},
  options: { now?: Date } = {}
): Promise<RefreshedSession> {
  const now = options.now ?? new Date();
  const session = await prisma.mobileSession.findUnique({
    where: { refreshTokenHash: hashToken(refreshToken) },
    include: { user: true }
  });
  if (!session) {
    return authFailure(401, "INVALID_SESSION", "Sign in again to continue.");
  }

  const failure = sessionAuthFailure(session, "refresh", now);
  if (failure) {
    return failure;
  }

  const nextSession = issueSessionTokens(now);
  await prisma.mobileSession.update({
    where: { id: session.id },
    data: {
      accessTokenHash: hashToken(nextSession.accessToken),
      refreshTokenHash: hashToken(nextSession.refreshToken),
      accessTokenExpiresAt: nextSession.accessTokenExpiresAt,
      refreshTokenExpiresAt: nextSession.refreshTokenExpiresAt,
      lastUsedAt: now,
      ...(context.userAgent ? { userAgent: context.userAgent } : {}),
      ...(context.ipHash ? { ipHash: context.ipHash } : {})
    }
  });

  return {
    ok: true,
    user: toAuthUser(session.user),
    session: nextSession
  };
}

export async function revokeMobileSessionByRefreshToken(refreshToken: string, options: { now?: Date } = {}): Promise<void> {
  await prisma.mobileSession.updateMany({
    where: { refreshTokenHash: hashToken(refreshToken), revokedAt: null },
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

function rateLimitKey(request: FastifyRequest, email: string): string {
  return `${request.ip || "unknown"}:${email}`;
}

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

function authSessionResponse(user: AuthUserRecord | AuthUser, session: IssuedMobileSession) {
  return {
    user: isSerializedAuthUser(user) ? user : toAuthUser(user),
    session: {
      accessToken: session.accessToken,
      accessTokenExpiresAt: session.accessTokenExpiresAt.toISOString(),
      refreshToken: session.refreshToken,
      refreshTokenExpiresAt: session.refreshTokenExpiresAt.toISOString()
    }
  };
}

function toAuthUser(user: AuthUserRecord): AuthUser {
  return {
    id: user.id,
    email: user.email,
    displayName: user.displayName ?? null,
    status: user.status,
    createdAt: user.createdAt.toISOString(),
    updatedAt: user.updatedAt.toISOString()
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

function sendRateLimitError(reply: FastifyReply, retryAfterSeconds: number): FastifyReply {
  reply.header("Retry-After", String(retryAfterSeconds));
  return sendAuthError(reply, 429, "RATE_LIMITED", "Too many attempts. Try again soon.");
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
  required: ["id", "email", "displayName", "status", "createdAt", "updatedAt"],
  properties: {
    id: { type: "string" },
    email: { type: "string" },
    displayName: { type: "string", nullable: true },
    status: { type: "string" },
    createdAt: { type: "string" },
    updatedAt: { type: "string" }
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
  required: ["email", "password"],
  properties: {
    email: { type: "string", maxLength: 254 },
    password: { type: "string", minLength: 8, maxLength: 200 },
    displayName: { type: "string", minLength: 1, maxLength: 120 }
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
