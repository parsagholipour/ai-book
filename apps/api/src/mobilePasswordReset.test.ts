import Fastify, { type FastifyInstance } from "fastify";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { hashPassword, verifyPassword } from "./mobileAuth.js";
import { generateResetCode, mobilePasswordResetRoutes } from "./mobilePasswordReset.js";
import type { Mailer, MailMessage } from "./mailer.js";
import { PasswordHashingBusyError, passwordHashGate } from "./passwordHashing.js";

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
  updatedAt: new Date("2026-01-01T00:00:00.000Z"),
  // What forgot's lookup includes: the codes this account was sent in the last day.
  _count: { passwordResetRequests: 0 }
};

type ResetRow = {
  id: string;
  userId: string;
  codeHash: string;
  expiresAt: Date;
  attempts: number;
  consumedAt: Date | null;
  createdAt: Date;
};

type Where = Record<string, unknown>;

function matches(row: ResetRow, where: Where): boolean {
  return Object.entries(where).every(([key, condition]) => {
    const value = row[key as keyof ResetRow];
    if (condition !== null && typeof condition === "object" && !(condition instanceof Date)) {
      const { lt, gt, gte } = condition as { lt?: Date | number; gt?: Date | number; gte?: Date | number };
      const at = value instanceof Date ? value.getTime() : (value as number);
      const ms = (bound: Date | number) => (bound instanceof Date ? bound.getTime() : bound);
      return (
        (lt === undefined || at < ms(lt)) && (gt === undefined || at > ms(gt)) && (gte === undefined || at >= ms(gte))
      );
    }
    return value === condition;
  });
}

/**
 * The reset rows as the database would hold them, behind the same mock
 * methods the routes call — the rows are what survives a restart.
 */
function useResetRowStore(rows: ResetRow[] = []): ResetRow[] {
  let next = rows.length;
  mockPrisma.user.findUnique.mockImplementation(
    async (args: {
      where: { email: string };
      include?: { _count: { select: { passwordResetRequests: { where: Where } } } };
    }) => {
      if (args.where.email !== USER.email) return null;
      const dayWhere = args.include?._count.select.passwordResetRequests.where;
      const counted = dayWhere ? rows.filter((row) => row.userId === USER.id && matches(row, dayWhere)).length : 0;
      return { ...USER, _count: { passwordResetRequests: counted } };
    }
  );
  mockPrisma.passwordResetRequest.create.mockImplementation(
    async ({ data }: { data: { userId: string; codeHash: string; expiresAt: Date } }) => {
      const row: ResetRow = {
        id: `reset-${(next += 1)}`,
        attempts: 0,
        consumedAt: null,
        createdAt: new Date(),
        ...data
      };
      rows.push(row);
      return row;
    }
  );
  mockPrisma.passwordResetRequest.deleteMany.mockImplementation(async ({ where }: { where: Where }) => {
    const doomed = rows.filter((row) => matches(row, where));
    for (const row of doomed) rows.splice(rows.indexOf(row), 1);
    return { count: doomed.length };
  });
  mockPrisma.passwordResetRequest.updateMany.mockImplementation(
    async ({ where, data }: { where: Where; data: Partial<ResetRow> & { attempts?: { increment: number } } }) => {
      const hit = rows.filter((row) => matches(row, where));
      for (const row of hit) {
        if (data.expiresAt) row.expiresAt = data.expiresAt;
        if (data.consumedAt) row.consumedAt = data.consumedAt;
        if (data.attempts) row.attempts += data.attempts.increment;
      }
      return { count: hit.length };
    }
  );
  mockPrisma.passwordResetRequest.findFirst.mockImplementation(async ({ where }: { where: Where }) => {
    const live = rows.filter((row) => matches(row, where));
    return live.at(-1) ?? null;
  });
  mockPrisma.userPasswordCredential.upsert.mockResolvedValue({});
  mockPrisma.mobileSession.updateMany.mockResolvedValue({ count: 0 });
  return rows;
}

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
  overrides: Omit<Parameters<typeof mobilePasswordResetRoutes>[1], "mailer"> = {}
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
    // Older pending codes expire with the new issue, and stay to be counted.
    expect(mockPrisma.passwordResetRequest.updateMany).toHaveBeenCalledWith({
      where: { userId: "user-1", consumedAt: null, expiresAt: { gt: expect.any(Date) } },
      data: { expiresAt: expect.any(Date) }
    });
    // Only rows past the counted day are deleted.
    expect(mockPrisma.passwordResetRequest.deleteMany).toHaveBeenCalledWith({
      where: { userId: "user-1", createdAt: { lt: expect.any(Date) } }
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
      where: { id: "reset-1", consumedAt: null, expiresAt: { gt: expect.any(Date) } },
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
      where: { id: "reset-1", consumedAt: null, expiresAt: { gt: expect.any(Date) }, attempts: { lt: 5 } },
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

  it("limits one address asking codes for invented emails before any lookup or hash", async () => {
    const { mailer } = captureMailer();
    const app = await buildApp(mailer, { forgotNetworkRateLimit: { maxAttempts: 2 } });
    mockPrisma.user.findUnique.mockResolvedValue(null);
    // Every scrypt derivation enters through the gate, so its call count is the hash count.
    const hashes = vi.spyOn(passwordHashGate, "run");
    try {
      const statuses: number[] = [];
      for (const email of ["a@example.com", "b@example.com", "c@example.com"]) {
        const response = await app.inject({
          method: "POST",
          url: "/api/mobile/auth/password/forgot",
          remoteAddress: "2001:db8:abcd:12::" + (statuses.length + 1),
          payload: { email }
        });
        statuses.push(response.statusCode);
      }

      expect(statuses).toEqual([200, 200, 429]);
      expect(mockPrisma.user.findUnique).toHaveBeenCalledTimes(2);
      expect(hashes).toHaveBeenCalledTimes(2);
    } finally {
      hashes.mockRestore();
    }
  });

  it("limits one address guessing codes for invented emails before any lookup or hash", async () => {
    const { mailer } = captureMailer();
    const app = await buildApp(mailer, { resetNetworkRateLimit: { maxAttempts: 2 } });
    mockPrisma.user.findUnique.mockResolvedValue(null);
    const hashes = vi.spyOn(passwordHashGate, "run");
    try {
      const statuses: number[] = [];
      for (const email of ["a@example.com", "b@example.com", "c@example.com"]) {
        const response = await app.inject({
          method: "POST",
          url: "/api/mobile/auth/password/reset",
          remoteAddress: "203.0.113.7",
          payload: { email, code: "123456", newPassword: "BrandNewPass9" }
        });
        statuses.push(response.statusCode);
      }

      expect(statuses).toEqual([400, 400, 429]);
      expect(mockPrisma.user.findUnique).toHaveBeenCalledTimes(2);
      expect(hashes).toHaveBeenCalledTimes(2);
    } finally {
      hashes.mockRestore();
    }
  });

  it("caps the codes one email is sent a day, answering a known and an unknown email alike", async () => {
    const { mailer, sent } = captureMailer();
    // Wide shorter limits, so the daily cap is the one that fires; every
    // request from a fresh address, so no per-address bucket is shared.
    const app = await buildApp(mailer, { forgotRateLimit: { maxAttempts: 10 }, forgotDailyRateLimit: { maxAttempts: 2 } });
    mockPrisma.user.findUnique.mockImplementation(async ({ where }: { where: { email: string } }) =>
      where.email === USER.email ? USER : null
    );
    let address = 0;
    const forgot = (email: string) =>
      app.inject({
        method: "POST",
        url: "/api/mobile/auth/password/forgot",
        remoteAddress: `198.51.100.${(address += 1)}`,
        payload: { email }
      });

    const known = [await forgot(USER.email), await forgot(USER.email), await forgot(USER.email)];
    const unknown = [
      await forgot("nobody@example.com"),
      await forgot("nobody@example.com"),
      await forgot("nobody@example.com")
    ];

    expect(known.map((response) => response.statusCode)).toEqual([200, 200, 429]);
    expect(unknown.map((response) => response.statusCode)).toEqual([200, 200, 429]);
    expect(known[2]!.json()).toEqual(unknown[2]!.json());
    expect(known[2]!.json().error.code).toBe("RATE_LIMITED");
    expect(Number(known[2]!.headers["retry-after"])).toBeGreaterThan(23 * 60 * 60);
    expect(sent).toHaveLength(2);
    // Counted before the lookup, so the capped requests never reached it.
    expect(mockPrisma.user.findUnique).toHaveBeenCalledTimes(4);
  });

  it("keeps an address's daily cap across a restart, answering a known and an unknown email alike", async () => {
    const { mailer, sent } = captureMailer();
    const options = { forgotRateLimit: { maxAttempts: 10 }, forgotDailyRateLimit: { maxAttempts: 2 } };
    const rows = useResetRowStore();
    let address = 0;
    const forgot = (app: FastifyInstance, email: string) =>
      app.inject({
        method: "POST",
        url: "/api/mobile/auth/password/forgot",
        remoteAddress: `198.51.100.${(address += 1)}`,
        payload: { email }
      });

    const before = await buildApp(mailer, options);
    expect((await forgot(before, USER.email)).statusCode).toBe(200);
    expect((await forgot(before, USER.email)).statusCode).toBe(200);
    expect(sent).toHaveLength(2);
    expect(rows).toHaveLength(2);

    // A deploy: every limiter starts empty, the rows do not.
    const after = await buildApp(mailer, options);
    const known = await forgot(after, USER.email);
    const unknown = await forgot(after, "nobody@example.com");

    expect(known.statusCode).toBe(200);
    expect(unknown.statusCode).toBe(200);
    expect(known.json()).toEqual(unknown.json());
    expect(known.body).toBe(unknown.body);
    // Capped: nothing issued, nothing mailed.
    expect(sent).toHaveLength(2);
    expect(rows).toHaveLength(2);
    expect(mockPrisma.passwordResetRequest.create).toHaveBeenCalledTimes(2);
  });

  it("does not count codes from before the day, and deletes them on the next issue", async () => {
    const { mailer, sent } = captureMailer();
    const app = await buildApp(mailer, { forgotDailyRateLimit: { maxAttempts: 2 } });
    const dayAgo = Date.now() - 25 * 60 * 60 * 1000;
    const stale = (id: string): ResetRow => ({
      id,
      userId: USER.id,
      codeHash: "old",
      expiresAt: new Date(dayAgo + 15 * 60 * 1000),
      attempts: 0,
      consumedAt: null,
      createdAt: new Date(dayAgo)
    });
    const rows = useResetRowStore([stale("old-1"), stale("old-2"), stale("old-3")]);

    const response = await app.inject({
      method: "POST",
      url: "/api/mobile/auth/password/forgot",
      payload: { email: USER.email }
    });

    expect(response.statusCode).toBe(200);
    expect(sent).toHaveLength(1);
    expect(rows.map((row) => row.id)).toEqual(["reset-4"]);
  });

  it("refuses a code a newer one superseded, even read before it was, and takes the newest", async () => {
    const { mailer, sent } = captureMailer();
    const app = await buildApp(mailer);
    const rows = useResetRowStore();
    for (const remoteAddress of ["198.51.100.1", "198.51.100.2"]) {
      const issued = await app.inject({
        method: "POST",
        url: "/api/mobile/auth/password/forgot",
        remoteAddress,
        payload: { email: USER.email }
      });
      expect(issued.statusCode).toBe(200);
    }
    const [first, second] = rows;
    const [firstCode, secondCode] = sent.map(emailedCode);
    expect(first!.expiresAt.getTime()).toBeLessThanOrEqual(Date.now());
    expect(second!.expiresAt.getTime()).toBeGreaterThan(Date.now());

    // A reset that read the first code before the second was issued.
    mockPrisma.passwordResetRequest.findFirst.mockResolvedValueOnce({ ...first! });
    const stale = await app.inject({
      method: "POST",
      url: "/api/mobile/auth/password/reset",
      payload: { email: USER.email, code: firstCode, newPassword: "BrandNewPass9" }
    });
    expect(stale.statusCode).toBe(400);
    expect(stale.json().error.code).toBe("INVALID_RESET_CODE");
    expect(first!.attempts).toBe(0);
    expect(first!.consumedAt).toBeNull();
    expect(mockPrisma.userPasswordCredential.upsert).not.toHaveBeenCalled();

    const newest = await app.inject({
      method: "POST",
      url: "/api/mobile/auth/password/reset",
      payload: { email: USER.email, code: secondCode, newPassword: "BrandNewPass9" }
    });
    expect(newest.statusCode).toBe(200);
    expect(second!.consumedAt).toBeInstanceOf(Date);
    expect(first!.consumedAt).toBeNull();
  });

  it("leaves the code unspent when the new password's hash is refused", async () => {
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
    const runThroughGate = passwordHashGate.run.bind(passwordHashGate);
    // The code verifies; the gate is full by the time the new password is hashed.
    const hashes = vi
      .spyOn(passwordHashGate, "run")
      .mockImplementationOnce((task) => runThroughGate(task))
      .mockImplementationOnce(() => Promise.reject(new PasswordHashingBusyError()));
    try {
      const response = await app.inject({
        method: "POST",
        url: "/api/mobile/auth/password/reset",
        payload: { email: "reader@example.com", code: "123456", newPassword: "BrandNewPass9" }
      });

      expect(response.statusCode).toBe(429);
      expect(response.json().error.code).toBe("RATE_LIMITED");
      expect(hashes).toHaveBeenCalledTimes(2);
      // Only the attempt claim ran; the consume never did.
      expect(mockPrisma.passwordResetRequest.updateMany).toHaveBeenCalledTimes(1);
      expect(mockPrisma.userPasswordCredential.upsert).not.toHaveBeenCalled();
      expect(mockPrisma.mobileSession.updateMany).not.toHaveBeenCalled();
    } finally {
      hashes.mockRestore();
    }
  });

  it("generates zero-padded 6-digit codes", () => {
    for (let i = 0; i < 50; i += 1) {
      expect(generateResetCode()).toMatch(/^\d{6}$/);
    }
  });
});
