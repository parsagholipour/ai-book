import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./signupCountry.js", () => ({ lookupSignupCountry: vi.fn(async () => null) }));

type UserRow = {
  id: string;
  email: string;
  displayName: string | null;
  status: string;
  disabledAt: Date | null;
  emailVerifiedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

type CodeRow = {
  id: string;
  userId: string;
  email: string;
  codeHash: string;
  expiresAt: Date;
  attempts: number;
  consumedAt: Date | null;
  requestIpHash: string | null;
  createdAt: Date;
};

/**
 * Just enough of the two tables these routes write, honest about which guarded
 * writes would have matched: the claim, the consume and the stamp are
 * conditional `updateMany`s, and the suite is only worth anything if a write
 * that would miss in Postgres misses here.
 */
const store = vi.hoisted(() => {
  const state = { users: new Map<string, UserRow>(), codes: new Map<string, CodeRow>(), seq: 0 };
  const after = (value: Date, bound: { gt?: Date; gte?: Date; lt?: Date } | undefined) =>
    !bound ||
    ((bound.gt === undefined || value > bound.gt) &&
      (bound.gte === undefined || value >= bound.gte) &&
      (bound.lt === undefined || value < bound.lt));
  const codeMatches = (row: CodeRow, where: any) =>
    (where.id === undefined || row.id === where.id) &&
    (where.userId === undefined || row.userId === where.userId) &&
    (where.email === undefined || row.email === where.email) &&
    (where.consumedAt !== null || row.consumedAt === null) &&
    after(row.expiresAt, where.expiresAt) &&
    after(row.createdAt, where.createdAt) &&
    (where.attempts?.lt === undefined || row.attempts < where.attempts.lt);
  const newestFirst = (rows: CodeRow[]) =>
    rows.sort((left, right) => right.createdAt.getTime() - left.createdAt.getTime() || right.id.localeCompare(left.id));
  const prisma = {
    mobileSession: {
      findUnique: vi.fn(async ({ where }: any) => {
        const userId = where.accessTokenHash ? sessions.get(where.accessTokenHash) : undefined;
        const user = userId ? state.users.get(userId) : undefined;
        return user
          ? {
              id: `session-${user.id}`,
              userId: user.id,
              accessTokenExpiresAt: new Date("2999-01-01T00:00:00.000Z"),
              refreshTokenExpiresAt: new Date("2999-01-01T00:00:00.000Z"),
              revokedAt: null,
              user: { ...user }
            }
          : null;
      }),
      create: vi.fn(async ({ data }: any) => ({ id: "session-new", ...data }))
    },
    user: {
      findUnique: vi.fn(async ({ where }: any) =>
        where.id ? (state.users.get(where.id) ?? null) : ([...state.users.values()].find((u) => u.email === where.email) ?? null)
      ),
      create: vi.fn(async ({ data }: any) => {
        const user: UserRow = {
          id: `user-${++state.seq}`,
          email: data.email,
          displayName: data.displayName ?? null,
          status: "ACTIVE",
          disabledAt: null,
          emailVerifiedAt: data.emailVerifiedAt ?? null,
          createdAt: new Date(),
          updatedAt: new Date()
        };
        state.users.set(user.id, user);
        return { ...user };
      }),
      updateMany: vi.fn(async ({ where, data }: any) => {
        const user = state.users.get(where.id);
        if (!user || (where.email !== undefined && user.email !== where.email)) return { count: 0 };
        if (where.emailVerifiedAt === null && user.emailVerifiedAt !== null) return { count: 0 };
        Object.assign(user, data);
        return { count: 1 };
      })
    },
    emailVerificationRequest: {
      findMany: vi.fn(async ({ where, take }: any) =>
        newestFirst([...state.codes.values()].filter((row) => codeMatches(row, where)))
          .slice(0, take ?? Infinity)
          .map((row) => ({ createdAt: row.createdAt }))
      ),
      findFirst: vi.fn(async ({ where }: any) => newestFirst([...state.codes.values()].filter((row) => codeMatches(row, where)))[0] ?? null),
      create: vi.fn(async ({ data }: any) => {
        const row: CodeRow = {
          id: `code-${++state.seq}`,
          attempts: 0,
          consumedAt: null,
          requestIpHash: null,
          createdAt: new Date(),
          ...data
        };
        state.codes.set(row.id, row);
        return { id: row.id };
      }),
      updateMany: vi.fn(async ({ where, data }: any) => {
        const rows = [...state.codes.values()].filter((row) => codeMatches(row, where));
        for (const row of rows) {
          if (data.attempts?.increment) row.attempts += data.attempts.increment;
          if (data.expiresAt) row.expiresAt = data.expiresAt;
          if (data.consumedAt) row.consumedAt = data.consumedAt;
        }
        return { count: rows.length };
      }),
      deleteMany: vi.fn(async ({ where }: any) => {
        const rows = [...state.codes.values()].filter((row) => codeMatches(row, { ...where, consumedAt: undefined }));
        for (const row of rows) state.codes.delete(row.id);
        return { count: rows.length };
      })
    },
    userActiveDay: { createMany: vi.fn(async () => ({ count: 1 })) },
    $transaction: vi.fn(async (writes: Promise<unknown>[]) => Promise.all(writes))
  };
  const sessions = new Map<string, string>();
  return { state, prisma, sessions };
});

vi.mock("@book-maker/db", () => ({ prisma: store.prisma }));

const { hashToken, mobileAuthRoutes } = await import("./mobileAuth.js");
const { EMAIL_VERIFICATION_MESSAGES, mobileEmailVerificationRoutes } = await import("./mobileEmailVerification.js");
const { verificationCodeMatches } = await import("./emailVerificationCodes.js");

const NOW = new Date("2026-10-13T08:00:00.000Z");
const mailer = { send: vi.fn(async (_message: { to: string; subject: string; text: string }) => {}) };
const apps: FastifyInstance[] = [];

async function buildApp(options: { mailer?: typeof mailer | null } = {}): Promise<FastifyInstance> {
  const app = Fastify();
  apps.push(app);
  const configured = options.mailer === undefined ? mailer : options.mailer;
  await app.register(mobileAuthRoutes, { mailer: configured });
  await app.register(mobileEmailVerificationRoutes, { mailer: configured });
  return app;
}

function seedUser(overrides: Partial<UserRow> = {}): UserRow {
  const user: UserRow = {
    id: "user-a",
    email: "reader@example.com",
    displayName: "Reader",
    status: "ACTIVE",
    disabledAt: null,
    emailVerifiedAt: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides
  };
  store.state.users.set(user.id, user);
  store.sessions.set(hashToken(`token-${user.id}`), user.id);
  return user;
}

const auth = (userId = "user-a") => ({ authorization: `Bearer token-${userId}` });

function send(app: FastifyInstance, userId = "user-a", remoteAddress = "203.0.113.5") {
  return app.inject({ method: "POST", url: "/api/mobile/auth/email/verification", headers: auth(userId), remoteAddress });
}

function confirm(app: FastifyInstance, code: string, userId = "user-a") {
  return app.inject({
    method: "POST",
    url: "/api/mobile/auth/email/verification/confirm",
    headers: auth(userId),
    payload: { code }
  });
}

function mailedCode(index = -1): string {
  const message = mailer.send.mock.calls.at(index)?.[0];
  const code = message?.text.match(/^\s{4}(\d{6})$/m)?.[1];
  if (!code) throw new Error("No code was mailed");
  return code;
}

function wrongCode(code: string): string {
  return code === "000000" ? "111111" : "000000";
}

describe("email verification", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
    store.state.users.clear();
    store.state.codes.clear();
    store.sessions.clear();
    mailer.send.mockReset();
    mailer.send.mockResolvedValue(undefined);
  });
  afterEach(async () => {
    await Promise.all(apps.splice(0).map((app) => app.close()));
    vi.useRealTimers();
  });

  it("refuses a request with no session", async () => {
    const app = await buildApp();
    const response = await app.inject({ method: "POST", url: "/api/mobile/auth/email/verification" });
    expect(response.statusCode).toBe(401);
    expect(response.json().error.code).toBe("AUTH_REQUIRED");
    expect(mailer.send).not.toHaveBeenCalled();
  });

  it("mails a code to the account's address, stores only its hash, and verifies the account with it", async () => {
    seedUser();
    const app = await buildApp();

    const sent = await send(app);
    expect(sent.statusCode).toBe(200);
    expect(sent.json()).toEqual({ sent: true, email: "reader@example.com", expiresInSeconds: 1800, resendAfterSeconds: 60 });
    expect(mailer.send).toHaveBeenCalledWith(expect.objectContaining({ to: "reader@example.com" }));
    const code = mailedCode();
    const [row] = [...store.state.codes.values()];
    expect(row).toMatchObject({ userId: "user-a", email: "reader@example.com", requestIpHash: hashToken("ip:203.0.113.5") });
    expect(row!.codeHash).not.toContain(code);
    expect(verificationCodeMatches(code, row!.codeHash)).toBe(true);

    const confirmed = await confirm(app, code);
    expect(confirmed.statusCode).toBe(200);
    expect(confirmed.json().user).toMatchObject({ id: "user-a", emailVerified: true });
    expect(store.state.users.get("user-a")!.emailVerifiedAt).toEqual(NOW);
    expect(row!.consumedAt).toEqual(NOW);
    // Single use: the consumed code proves nothing a second time.
    store.state.users.get("user-a")!.emailVerifiedAt = null;
    expect((await confirm(app, code)).json().error.code).toBe("INVALID_VERIFICATION_CODE");
  });

  it("kills a code after five wrong guesses, even against the right one", async () => {
    seedUser();
    const app = await buildApp();
    await send(app);
    const code = mailedCode();

    for (let attempt = 0; attempt < 5; attempt++) {
      const response = await confirm(app, wrongCode(code));
      expect(response.statusCode).toBe(400);
      expect(response.json().error).toEqual({
        code: "INVALID_VERIFICATION_CODE",
        message: EMAIL_VERIFICATION_MESSAGES.INVALID_VERIFICATION_CODE
      });
    }
    expect((await confirm(app, code)).json().error.code).toBe("INVALID_VERIFICATION_CODE");
    expect(store.state.users.get("user-a")!.emailVerifiedAt).toBeNull();
  });

  it("waits a minute between codes, and only the newest code works", async () => {
    seedUser();
    const app = await buildApp();
    await send(app);
    const first = mailedCode();

    vi.setSystemTime(new Date(NOW.getTime() + 20_000));
    const early = await send(app);
    expect(early.statusCode).toBe(429);
    expect(early.headers["retry-after"]).toBe("40");
    expect(mailer.send).toHaveBeenCalledTimes(1);

    vi.setSystemTime(new Date(NOW.getTime() + 61_000));
    expect((await send(app)).statusCode).toBe(200);
    const second = mailedCode();
    if (first !== second) {
      expect((await confirm(app, first)).json().error.code).toBe("INVALID_VERIFICATION_CODE");
    }
    expect((await confirm(app, second)).statusCode).toBe(200);
  });

  it("sends at most ten codes a day, counted from the rows so a restart forgets nothing", async () => {
    seedUser();
    for (let index = 0; index < 10; index++) {
      store.state.codes.set(`old-${index}`, {
        id: `old-${index}`,
        userId: "user-a",
        email: "reader@example.com",
        codeHash: "x.y",
        expiresAt: new Date(NOW.getTime() - 1),
        attempts: 0,
        consumedAt: null,
        requestIpHash: null,
        createdAt: new Date(NOW.getTime() - (index + 1) * 60 * 60 * 1000)
      });
    }
    const app = await buildApp();

    const capped = await send(app);
    expect(capped.statusCode).toBe(429);
    // The oldest of the ten counted codes is ten hours old: it leaves the day in fourteen.
    expect(capped.headers["retry-after"]).toBe(String(14 * 60 * 60));
    expect(mailer.send).not.toHaveBeenCalled();
  });

  it("tells a verified account it is done, and treats a repeated confirm as success", async () => {
    seedUser({ emailVerifiedAt: NOW });
    const app = await buildApp();

    const sent = await send(app);
    expect(sent.statusCode).toBe(409);
    expect(sent.json().error).toEqual({ code: "EMAIL_ALREADY_VERIFIED", message: EMAIL_VERIFICATION_MESSAGES.EMAIL_ALREADY_VERIFIED });

    const confirmed = await confirm(app, "123456");
    expect(confirmed.statusCode).toBe(200);
    expect(confirmed.json().user.emailVerified).toBe(true);
    expect(mailer.send).not.toHaveBeenCalled();
  });

  it("answers 503 with no mailer, and a failed send costs the reader no wait", async () => {
    seedUser();
    const unconfigured = await buildApp({ mailer: null });
    const refused = await send(unconfigured);
    expect(refused.statusCode).toBe(503);
    expect(refused.json().error.code).toBe("VERIFICATION_EMAIL_UNAVAILABLE");

    const app = await buildApp();
    mailer.send.mockRejectedValueOnce(new Error("SMTP down"));
    const failed = await send(app);
    expect(failed.statusCode).toBe(503);
    expect(failed.json().error).toEqual({
      code: "VERIFICATION_EMAIL_UNAVAILABLE",
      message: EMAIL_VERIFICATION_MESSAGES.VERIFICATION_EMAIL_UNAVAILABLE
    });
    expect(store.state.codes.size).toBe(0);
    expect((await send(app)).statusCode).toBe(200);
  });

  it("never verifies an address the code was not mailed to", async () => {
    seedUser();
    const app = await buildApp();
    await send(app);
    const code = mailedCode();
    store.state.users.get("user-a")!.email = "changed@example.com";

    expect((await confirm(app, code)).json().error.code).toBe("INVALID_VERIFICATION_CODE");
    expect(store.state.users.get("user-a")!.emailVerifiedAt).toBeNull();
  });

  it("rejects a malformed code before it counts as a guess", async () => {
    seedUser();
    const app = await buildApp();
    await send(app);
    for (const code of ["12345", "abcdef", "1234567"]) {
      const response = await confirm(app, code);
      expect(response.statusCode).toBe(400);
      expect(response.json().error.code).toBe("VALIDATION_ERROR");
    }
    expect([...store.state.codes.values()][0]!.attempts).toBe(0);
  });

  it("limits sends per client network, whichever account asks", async () => {
    const app = await buildApp();
    for (let index = 0; index < 11; index++) {
      seedUser({ id: `user-${index}`, email: `reader${index}@example.com` });
    }
    for (let index = 0; index < 10; index++) {
      expect((await send(app, `user-${index}`)).statusCode).toBe(200);
    }
    expect((await send(app, "user-10")).statusCode).toBe(429);
  });

  it("mails the first code at sign-up, without holding or failing the sign-up", async () => {
    const app = await buildApp();
    const signUp = () =>
      app.inject({
        method: "POST",
        url: "/api/mobile/auth/signup",
        payload: { email: "New@Example.com", password: "CorrectPass123", termsAccepted: true, ageGuardianAttested: true }
      });

    const response = await signUp();
    expect(response.statusCode).toBe(201);
    expect(response.json().user.emailVerified).toBe(false);
    await vi.waitFor(() => expect(mailer.send).toHaveBeenCalledWith(expect.objectContaining({ to: "new@example.com" })));
    const userId = response.json().user.id as string;
    store.sessions.set(hashToken(`token-${userId}`), userId);

    // The first code counts toward the minute, so the screen's resend waits.
    expect((await send(app, userId)).statusCode).toBe(429);
    expect((await confirm(app, mailedCode(), userId)).json().user.emailVerified).toBe(true);

    mailer.send.mockRejectedValueOnce(new Error("SMTP down"));
    const second = await app.inject({
      method: "POST",
      url: "/api/mobile/auth/signup",
      payload: { email: "other@example.com", password: "CorrectPass123", termsAccepted: true, ageGuardianAttested: true }
    });
    expect(second.statusCode).toBe(201);
  });
});
