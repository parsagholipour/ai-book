import Fastify, { type FastifyInstance } from "fastify";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { hashPassword, verifyPassword } from "./mobileAuth.js";
import { generateResetCode, mobilePasswordResetRoutes } from "./mobilePasswordReset.js";
import type { Mailer, MailMessage } from "./mailer.js";

const mockPrisma = vi.hoisted(() => ({
  user: {
    findUnique: vi.fn()
  },
  passwordResetRequest: {
    create: vi.fn(),
    deleteMany: vi.fn(),
    findFirst: vi.fn(),
    updateMany: vi.fn()
  },
  userPasswordCredential: {
    upsert: vi.fn()
  },
  mobileSession: {
    create: vi.fn(),
    updateMany: vi.fn()
  },
  $transaction: vi.fn((operations: Promise<unknown>[]) => Promise.all(operations))
}));

vi.mock("@book-maker/db", () => ({
  prisma: mockPrisma
}));

const USER = {
  id: "user-1",
  email: "reader@example.com",
  displayName: "Reader",
  status: "ACTIVE",
  disabledAt: null,
  createdAt: new Date("2026-01-01T00:00:00.000Z"),
  updatedAt: new Date("2026-01-01T00:00:00.000Z")
};

function captureMailer(): { mailer: Mailer; sent: MailMessage[] } {
  const sent: MailMessage[] = [];
  return {
    sent,
    mailer: {
      async send(message) {
        sent.push(message);
      }
    }
  };
}

async function buildApp(
  mailer: Mailer | null,
  overrides: { forgotRateLimit?: { maxAttempts: number }; resetRateLimit?: { maxAttempts: number } } = {}
): Promise<FastifyInstance> {
  const app = Fastify();
  await app.register(mobilePasswordResetRoutes, { mailer, ...overrides });
  return app;
}

function emailedCode(message: MailMessage): string {
  const match = message.text.match(/\b(\d{6})\b/);
  if (!match?.[1]) {
    throw new Error(`No 6-digit code in email: ${message.text}`);
  }
  return match[1];
}

describe("mobile password reset routes", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockPrisma.$transaction.mockImplementation((operations: Promise<unknown>[]) => Promise.all(operations));
    mockPrisma.passwordResetRequest.deleteMany.mockResolvedValue({ count: 0 });
    mockPrisma.passwordResetRequest.create.mockResolvedValue({});
    mockPrisma.mobileSession.create.mockResolvedValue({});
  });

  it("emails a code and stores only its hash", async () => {
    const { mailer, sent } = captureMailer();
    const app = await buildApp(mailer);
    mockPrisma.user.findUnique.mockResolvedValueOnce(USER);

    const response = await app.inject({
      method: "POST",
      url: "/api/mobile/auth/password/forgot",
      payload: { email: "Reader@Example.com" }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: true });
    expect(sent).toHaveLength(1);
    expect(sent[0]?.to).toBe("reader@example.com");

    const code = emailedCode(sent[0]!);
    const createCall = mockPrisma.passwordResetRequest.create.mock.calls.at(0)?.[0] as {
      data: { userId: string; codeHash: string; expiresAt: Date };
    };
    expect(createCall.data.userId).toBe("user-1");
    expect(createCall.data.codeHash).not.toContain(code);
    await expect(verifyPassword(code, createCall.data.codeHash)).resolves.toBe(true);
    // Older pending codes die with the new issue.
    expect(mockPrisma.passwordResetRequest.deleteMany).toHaveBeenCalledWith({
      where: { userId: "user-1", consumedAt: null }
    });
  });

  it("answers ok without sending anything for an unknown account", async () => {
    const { mailer, sent } = captureMailer();
    const app = await buildApp(mailer);
    mockPrisma.user.findUnique.mockResolvedValueOnce(null);

    const response = await app.inject({
      method: "POST",
      url: "/api/mobile/auth/password/forgot",
      payload: { email: "nobody@example.com" }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: true });
    expect(sent).toHaveLength(0);
    expect(mockPrisma.passwordResetRequest.create).not.toHaveBeenCalled();
  });

  it("still answers ok when the email fails to send", async () => {
    const app = await buildApp({
      send: vi.fn().mockRejectedValue(new Error("smtp down"))
    });
    mockPrisma.user.findUnique.mockResolvedValueOnce(USER);

    const response = await app.inject({
      method: "POST",
      url: "/api/mobile/auth/password/forgot",
      payload: { email: "reader@example.com" }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: true });
  });

  it("answers 503 when no mailer is configured", async () => {
    const app = await buildApp(null);

    const response = await app.inject({
      method: "POST",
      url: "/api/mobile/auth/password/forgot",
      payload: { email: "reader@example.com" }
    });

    expect(response.statusCode).toBe(503);
    expect(response.json().error.code).toBe("EMAIL_UNAVAILABLE");
    expect(mockPrisma.user.findUnique).not.toHaveBeenCalled();
  });

  it("rate limits repeated forgot requests", async () => {
    const { mailer } = captureMailer();
    const app = await buildApp(mailer, { forgotRateLimit: { maxAttempts: 1 } });
    mockPrisma.user.findUnique.mockResolvedValue(USER);

    const first = await app.inject({
      method: "POST",
      url: "/api/mobile/auth/password/forgot",
      payload: { email: "reader@example.com" }
    });
    const second = await app.inject({
      method: "POST",
      url: "/api/mobile/auth/password/forgot",
      payload: { email: "reader@example.com" }
    });

    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(429);
  });

  it("resets the password, revokes every session and signs the reader in", async () => {
    const { mailer } = captureMailer();
    const app = await buildApp(mailer);
    mockPrisma.user.findUnique.mockResolvedValue(USER);
    mockPrisma.passwordResetRequest.findFirst.mockResolvedValueOnce({
      id: "reset-1",
      userId: "user-1",
      codeHash: await hashPassword("123456"),
      attempts: 0,
      consumedAt: null,
      expiresAt: new Date(Date.now() + 60_000)
    });
    // First updateMany claims the attempt, second consumes the code.
    mockPrisma.passwordResetRequest.updateMany
      .mockResolvedValueOnce({ count: 1 })
      .mockResolvedValueOnce({ count: 1 });
    mockPrisma.userPasswordCredential.upsert.mockResolvedValueOnce({});
    mockPrisma.mobileSession.updateMany.mockResolvedValueOnce({ count: 2 });

    const response = await app.inject({
      method: "POST",
      url: "/api/mobile/auth/password/reset",
      payload: { email: "reader@example.com", code: "123456", newPassword: "BrandNewPass9" }
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.user.id).toBe("user-1");
    expect(body.session.accessToken).toMatch(/^bma_at_/);
    expect(body.session.refreshToken).toMatch(/^bma_rt_/);

    const upsertCall = mockPrisma.userPasswordCredential.upsert.mock.calls.at(0)?.[0] as {
      where: { userId: string };
      update: { passwordHash: string };
    };
    expect(upsertCall.where.userId).toBe("user-1");
    await expect(verifyPassword("BrandNewPass9", upsertCall.update.passwordHash)).resolves.toBe(true);

    expect(mockPrisma.mobileSession.updateMany).toHaveBeenCalledWith({
      where: { userId: "user-1", revokedAt: null },
      data: { revokedAt: expect.any(Date) }
    });
    expect(mockPrisma.passwordResetRequest.updateMany).toHaveBeenNthCalledWith(2, {
      where: { id: "reset-1", consumedAt: null },
      data: { consumedAt: expect.any(Date) }
    });
  });

  it("rejects a wrong code after counting the attempt, without consuming it", async () => {
    const { mailer } = captureMailer();
    const app = await buildApp(mailer);
    mockPrisma.user.findUnique.mockResolvedValue(USER);
    mockPrisma.passwordResetRequest.findFirst.mockResolvedValueOnce({
      id: "reset-1",
      userId: "user-1",
      codeHash: await hashPassword("123456"),
      attempts: 0,
      consumedAt: null,
      expiresAt: new Date(Date.now() + 60_000)
    });
    mockPrisma.passwordResetRequest.updateMany.mockResolvedValueOnce({ count: 1 });

    const response = await app.inject({
      method: "POST",
      url: "/api/mobile/auth/password/reset",
      payload: { email: "reader@example.com", code: "654321", newPassword: "BrandNewPass9" }
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe("INVALID_RESET_CODE");
    expect(mockPrisma.passwordResetRequest.updateMany).toHaveBeenCalledTimes(1);
    expect(mockPrisma.passwordResetRequest.updateMany).toHaveBeenCalledWith({
      where: { id: "reset-1", consumedAt: null, attempts: { lt: 5 } },
      data: { attempts: { increment: 1 } }
    });
    expect(mockPrisma.userPasswordCredential.upsert).not.toHaveBeenCalled();
    expect(mockPrisma.mobileSession.create).not.toHaveBeenCalled();
  });

  it("rejects the right code once the attempt cap is spent", async () => {
    const { mailer } = captureMailer();
    const app = await buildApp(mailer);
    mockPrisma.user.findUnique.mockResolvedValue(USER);
    mockPrisma.passwordResetRequest.findFirst.mockResolvedValueOnce({
      id: "reset-1",
      userId: "user-1",
      codeHash: await hashPassword("123456"),
      attempts: 5,
      consumedAt: null,
      expiresAt: new Date(Date.now() + 60_000)
    });
    // The conditional claim refuses: attempts is no longer < 5.
    mockPrisma.passwordResetRequest.updateMany.mockResolvedValueOnce({ count: 0 });

    const response = await app.inject({
      method: "POST",
      url: "/api/mobile/auth/password/reset",
      payload: { email: "reader@example.com", code: "123456", newPassword: "BrandNewPass9" }
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe("INVALID_RESET_CODE");
    expect(mockPrisma.userPasswordCredential.upsert).not.toHaveBeenCalled();
  });

  it("rejects when no pending reset request exists", async () => {
    const { mailer } = captureMailer();
    const app = await buildApp(mailer);
    mockPrisma.user.findUnique.mockResolvedValue(USER);
    mockPrisma.passwordResetRequest.findFirst.mockResolvedValueOnce(null);

    const response = await app.inject({
      method: "POST",
      url: "/api/mobile/auth/password/reset",
      payload: { email: "reader@example.com", code: "123456", newPassword: "BrandNewPass9" }
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe("INVALID_RESET_CODE");
  });

  it("rejects an unknown account with the same error as a wrong code", async () => {
    const { mailer } = captureMailer();
    const app = await buildApp(mailer);
    mockPrisma.user.findUnique.mockResolvedValue(null);

    const response = await app.inject({
      method: "POST",
      url: "/api/mobile/auth/password/reset",
      payload: { email: "nobody@example.com", code: "123456", newPassword: "BrandNewPass9" }
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe("INVALID_RESET_CODE");
  });

  it("generates zero-padded 6-digit codes", () => {
    for (let i = 0; i < 50; i += 1) {
      expect(generateResetCode()).toMatch(/^\d{6}$/);
    }
  });
});
