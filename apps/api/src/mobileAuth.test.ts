import Fastify, { type FastifyInstance } from "fastify";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createMobileSession,
  hashPassword,
  hashToken,
  mobileAuthRoutes,
  refreshMobileSession,
  verifyMobileAccessToken,
  verifyPassword
} from "./mobileAuth.js";

const mockPrisma = vi.hoisted(() => ({
  user: {
    create: vi.fn(),
    findUnique: vi.fn()
  },
  mobileSession: {
    create: vi.fn(),
    findUnique: vi.fn(),
    update: vi.fn(),
    updateMany: vi.fn()
  }
}));

vi.mock("@book-maker/db", () => ({
  prisma: mockPrisma
}));

const NOW = new Date("2026-06-15T08:00:00.000Z");
const FUTURE = new Date("2999-06-15T09:00:00.000Z");
const PAST = new Date("2000-06-15T07:59:00.000Z");
const RAW_REFRESH_TOKEN = "refresh-token-value-long-enough";

describe("mobile auth service", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockMobileSessionCreate();
  });

  it("hashes and verifies passwords without storing the raw password", async () => {
    const passwordHash = await hashPassword("CorrectPass123");

    expect(passwordHash).toMatch(/^scrypt\$/);
    expect(passwordHash).not.toContain("CorrectPass123");
    await expect(verifyPassword("CorrectPass123", passwordHash)).resolves.toBe(true);
    await expect(verifyPassword("wrong-password", passwordHash)).resolves.toBe(false);
  });

  it("creates access and refresh tokens while storing only token hashes", async () => {
    const session = await createMobileSession("user-1", { userAgent: "Vitest", ipHash: "hashed-ip" }, { now: NOW });
    const createCall = mockPrisma.mobileSession.create.mock.calls.at(0)?.[0] as { data: Record<string, unknown> };

    expect(session.accessToken).toMatch(/^bma_at_/);
    expect(session.refreshToken).toMatch(/^bma_rt_/);
    expect(session.accessTokenExpiresAt.toISOString()).toBe("2026-06-15T08:15:00.000Z");
    expect(session.refreshTokenExpiresAt.toISOString()).toBe("2026-07-15T08:00:00.000Z");
    expect(createCall.data.accessTokenHash).toBe(hashToken(session.accessToken));
    expect(createCall.data.refreshTokenHash).toBe(hashToken(session.refreshToken));
    expect(JSON.stringify(createCall.data)).not.toContain(session.accessToken);
    expect(JSON.stringify(createCall.data)).not.toContain(session.refreshToken);
  });

  it("verifies active access tokens and rejects expired or revoked sessions", async () => {
    mockPrisma.mobileSession.findUnique.mockResolvedValueOnce(sessionWithUser());
    await expect(verifyMobileAccessToken("access-token", { now: NOW })).resolves.toMatchObject({
      ok: true,
      user: { id: "user-1", email: "reader@example.com" }
    });
    expect(mockPrisma.mobileSession.findUnique).toHaveBeenCalledWith({
      where: { accessTokenHash: hashToken("access-token") },
      include: { user: true }
    });

    mockPrisma.mobileSession.findUnique.mockResolvedValueOnce(sessionWithUser({ accessTokenExpiresAt: PAST }));
    await expect(verifyMobileAccessToken("expired-token", { now: NOW })).resolves.toMatchObject({
      ok: false,
      code: "SESSION_EXPIRED"
    });

    mockPrisma.mobileSession.findUnique.mockResolvedValueOnce(sessionWithUser({ revokedAt: NOW }));
    await expect(verifyMobileAccessToken("revoked-token", { now: NOW })).resolves.toMatchObject({
      ok: false,
      code: "SESSION_REVOKED"
    });
  });

  it("rotates refresh sessions and rejects revoked refresh tokens", async () => {
    mockPrisma.mobileSession.findUnique.mockResolvedValueOnce(sessionWithUser());
    mockPrisma.mobileSession.update.mockResolvedValueOnce({});

    const refreshed = await refreshMobileSession("refresh-token", {}, { now: NOW });

    expect(refreshed).toMatchObject({
      ok: true,
      user: { id: "user-1", email: "reader@example.com" }
    });
    if (!refreshed.ok) {
      throw new Error("Expected refresh to succeed");
    }
    expect(refreshed.session.refreshToken).not.toBe("refresh-token");
    expect(mockPrisma.mobileSession.update).toHaveBeenCalledWith({
      where: { id: "session-1" },
      data: expect.objectContaining({
        accessTokenHash: hashToken(refreshed.session.accessToken),
        refreshTokenHash: hashToken(refreshed.session.refreshToken),
        lastUsedAt: NOW
      })
    });

    mockPrisma.mobileSession.findUnique.mockResolvedValueOnce(sessionWithUser({ revokedAt: NOW }));
    await expect(refreshMobileSession("revoked-refresh", {}, { now: NOW })).resolves.toMatchObject({
      ok: false,
      code: "SESSION_REVOKED"
    });
  });
});

describe("mobile auth routes", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockMobileSessionCreate();
  });

  it("signs up a new user and returns a mobile session", async () => {
    mockPrisma.user.findUnique.mockResolvedValue(null);
    mockPrisma.user.create.mockImplementation(async ({ data }: { data: any }) =>
      activeUser({ email: data.email, displayName: data.displayName ?? null })
    );
    const app = await buildApp();

    const response = await app.inject({
      method: "POST",
      url: "/api/mobile/auth/signup",
      payload: {
        email: "Reader@Example.COM",
        password: "CorrectPass123",
        displayName: "Reader"
      }
    });
    const body = response.json();
    const createCall = mockPrisma.user.create.mock.calls.at(0)?.[0] as { data: any };

    expect(response.statusCode).toBe(201);
    expect(body.user).toMatchObject({ id: "user-1", email: "reader@example.com", displayName: "Reader" });
    expect(body.session.accessToken).toMatch(/^bma_at_/);
    expect(body.session.refreshToken).toMatch(/^bma_rt_/);
    expect(createCall.data.passwordCredential.create.passwordHash).not.toContain("CorrectPass123");
    await app.close();
  });

  it("signs in an existing user and returns fresh session tokens", async () => {
    const passwordHash = await hashPassword("CorrectPass123");
    mockPrisma.user.findUnique.mockResolvedValue({
      ...activeUser(),
      passwordCredential: { passwordHash }
    });
    const app = await buildApp();

    const response = await app.inject({
      method: "POST",
      url: "/api/mobile/auth/signin",
      payload: {
        email: "reader@example.com",
        password: "CorrectPass123"
      }
    });
    const body = response.json();

    expect(response.statusCode).toBe(200);
    expect(body.user.email).toBe("reader@example.com");
    expect(body.session.accessToken).toMatch(/^bma_at_/);
    expect(mockPrisma.mobileSession.create).toHaveBeenCalledOnce();
    await app.close();
  });

  it("returns the current user for a valid bearer access token", async () => {
    mockPrisma.mobileSession.findUnique.mockResolvedValue(sessionWithUser());
    const app = await buildApp();

    const response = await app.inject({
      method: "GET",
      url: "/api/mobile/auth/me",
      headers: { authorization: "Bearer access-token" }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().user).toMatchObject({ id: "user-1", email: "reader@example.com" });
    expect(mockPrisma.mobileSession.findUnique).toHaveBeenCalledWith({
      where: { accessTokenHash: hashToken("access-token") },
      include: { user: true }
    });
    await app.close();
  });

  it("refreshes a session by rotating access and refresh tokens", async () => {
    mockPrisma.mobileSession.findUnique.mockResolvedValue(sessionWithUser());
    mockPrisma.mobileSession.update.mockResolvedValue({});
    const app = await buildApp();

    const response = await app.inject({
      method: "POST",
      url: "/api/mobile/auth/refresh",
      payload: { refreshToken: RAW_REFRESH_TOKEN }
    });
    const body = response.json();

    expect(response.statusCode).toBe(200);
    expect(body.session.accessToken).toMatch(/^bma_at_/);
    expect(body.session.refreshToken).toMatch(/^bma_rt_/);
    expect(body.session.refreshToken).not.toBe(RAW_REFRESH_TOKEN);
    expect(mockPrisma.mobileSession.update).toHaveBeenCalledOnce();
    await app.close();
  });

  it("logs out by revoking refresh session state", async () => {
    mockPrisma.mobileSession.updateMany.mockResolvedValue({ count: 1 });
    const app = await buildApp();

    const response = await app.inject({
      method: "POST",
      url: "/api/mobile/auth/logout",
      payload: { refreshToken: RAW_REFRESH_TOKEN }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: true });
    expect(mockPrisma.mobileSession.updateMany).toHaveBeenCalledWith({
      where: { refreshTokenHash: hashToken(RAW_REFRESH_TOKEN), revokedAt: null },
      data: { revokedAt: expect.any(Date) }
    });
    await app.close();
  });

  it("returns mobile-friendly invalid credential errors", async () => {
    mockPrisma.user.findUnique.mockResolvedValue(null);
    const app = await buildApp();

    const response = await app.inject({
      method: "POST",
      url: "/api/mobile/auth/signin",
      payload: {
        email: "reader@example.com",
        password: "wrong"
      }
    });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({
      error: {
        code: "INVALID_CREDENTIALS",
        message: "Email or password is incorrect."
      }
    });
    expect(mockPrisma.mobileSession.create).not.toHaveBeenCalled();
    await app.close();
  });

  it("rejects expired access tokens and revoked refresh sessions", async () => {
    mockPrisma.mobileSession.findUnique.mockResolvedValueOnce(sessionWithUser({ accessTokenExpiresAt: PAST }));
    const app = await buildApp();

    const currentUser = await app.inject({
      method: "GET",
      url: "/api/mobile/auth/me",
      headers: { authorization: "Bearer expired-token" }
    });

    mockPrisma.mobileSession.findUnique.mockResolvedValueOnce(sessionWithUser({ revokedAt: NOW }));
    const refresh = await app.inject({
      method: "POST",
      url: "/api/mobile/auth/refresh",
      payload: { refreshToken: "revoked-refresh-token-long-enough" }
    });

    expect(currentUser.statusCode).toBe(401);
    expect(currentUser.json().error.code).toBe("SESSION_EXPIRED");
    expect(refresh.statusCode).toBe(401);
    expect(refresh.json().error.code).toBe("SESSION_REVOKED");
    await app.close();
  });

  it("rate limits repeated sign-in attempts", async () => {
    mockPrisma.user.findUnique.mockResolvedValue(null);
    const app = await buildApp({ signInRateLimit: { maxAttempts: 2, windowMs: 60_000 } });

    const first = await signIn(app);
    const second = await signIn(app);
    const third = await signIn(app);

    expect(first.statusCode).toBe(401);
    expect(second.statusCode).toBe(401);
    expect(third.statusCode).toBe(429);
    expect(third.json().error.code).toBe("RATE_LIMITED");
    await app.close();
  });

  it("rate limits repeated sign-up attempts", async () => {
    mockPrisma.user.findUnique.mockResolvedValue(null);
    mockPrisma.user.create.mockResolvedValue(activeUser());
    const app = await buildApp({ signUpRateLimit: { maxAttempts: 2, windowMs: 60_000 } });

    const first = await signUp(app);
    const second = await signUp(app);
    const third = await signUp(app);

    expect(first.statusCode).toBe(201);
    expect(second.statusCode).toBe(201);
    expect(third.statusCode).toBe(429);
    expect(third.json().error.code).toBe("RATE_LIMITED");
    await app.close();
  });
});

async function buildApp(options: Parameters<typeof mobileAuthRoutes>[1] = {}): Promise<FastifyInstance> {
  const app = Fastify();
  await app.register(mobileAuthRoutes, options);
  return app;
}

async function signIn(app: FastifyInstance) {
  return app.inject({
    method: "POST",
    url: "/api/mobile/auth/signin",
    payload: {
      email: "reader@example.com",
      password: "wrong"
    }
  });
}

async function signUp(app: FastifyInstance) {
  return app.inject({
    method: "POST",
    url: "/api/mobile/auth/signup",
    payload: {
      email: "reader@example.com",
      password: "CorrectPass123"
    }
  });
}

function mockMobileSessionCreate() {
  mockPrisma.mobileSession.create.mockImplementation(async ({ data }: { data: any }) => ({
    id: "session-1",
    revokedAt: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...data
  }));
}

function activeUser(overrides: Record<string, unknown> = {}) {
  return {
    id: "user-1",
    email: "reader@example.com",
    displayName: null,
    status: "ACTIVE",
    disabledAt: null,
    createdAt: new Date("2026-06-01T12:00:00.000Z"),
    updatedAt: new Date("2026-06-01T12:00:00.000Z"),
    ...overrides
  };
}

function sessionWithUser(overrides: Record<string, unknown> = {}) {
  return {
    id: "session-1",
    userId: "user-1",
    accessTokenExpiresAt: FUTURE,
    refreshTokenExpiresAt: FUTURE,
    revokedAt: null,
    user: activeUser(),
    ...overrides
  };
}
