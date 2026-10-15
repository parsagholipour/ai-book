import Fastify from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mobileGoogleAuthRoutes } from "./mobileGoogleAuth.js";
import { hashPassword } from "./mobileAuth.js";

const db = vi.hoisted(() => ({
  user: { findUnique: vi.fn(), create: vi.fn(), updateMany: vi.fn() },
  mobileSession: { create: vi.fn() },
  legalAcceptance: { findFirst: vi.fn() }
}));
vi.mock("@book-maker/db", () => ({ prisma: db }));
vi.mock("./signupCountry.js", () => ({ lookupSignupCountry: vi.fn(async () => "US") }));

const identity = { subject: "google-reader", email: "reader@example.com", displayName: "Reader" };
const user = {
  id: "user-1", email: identity.email, displayName: "Reader", googleSubject: identity.subject,
  status: "ACTIVE", disabledAt: null, createdAt: new Date(), updatedAt: new Date()
};
const verifier = vi.fn(async () => identity);
const apps: ReturnType<typeof Fastify>[] = [];

async function app(enabled = true) {
  const instance = Fastify();
  apps.push(instance);
  await instance.register(mobileGoogleAuthRoutes, { verifier: enabled ? verifier : null });
  return instance;
}
function post(instance: ReturnType<typeof Fastify>, payload: Record<string, unknown> = {}) {
  return instance.inject({ method: "POST", url: "/api/mobile/auth/google", payload: { idToken: "signed-token", ...payload } });
}

describe("Google mobile authentication", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    verifier.mockResolvedValue(identity);
    db.user.findUnique.mockResolvedValue(null);
    db.user.create.mockResolvedValue(user);
    db.user.updateMany.mockResolvedValue({ count: 1 });
    db.mobileSession.create.mockResolvedValue({});
    db.legalAcceptance.findFirst.mockResolvedValue({ id: "acceptance" });
  });
  afterEach(async () => {
    await Promise.all(apps.splice(0).map((instance) => instance.close()));
  });

  it("refuses unconfigured sign-in and never creates an account", async () => {
    const response = await post(await app(false));
    expect(response.statusCode).toBe(503);
    expect(verifier).not.toHaveBeenCalled();
    expect(db.user.create).not.toHaveBeenCalled();
  });

  it("requires a bounded token and rejects unverified identity before touching accounts", async () => {
    const instance = await app();
    expect((await post(instance, { idToken: "" })).statusCode).toBe(400);
    expect((await post(instance, { idToken: "x".repeat(8193) })).statusCode).toBe(400);
    verifier.mockRejectedValue(new Error("bad signature"));
    expect((await post(instance)).statusCode).toBe(401);
    expect(db.user.findUnique).not.toHaveBeenCalled();
    expect(db.mobileSession.create).not.toHaveBeenCalled();
  });

  it("requires both legal attestations before a new Google account is written", async () => {
    const instance = await app();
    for (const payload of [{}, { termsAccepted: true }, { ageGuardianAttested: true }]) {
      const response = await post(instance, payload);
      expect(response.json().error.code).toBe("GOOGLE_SIGNUP_REQUIRED");
    }
    expect(db.user.create).not.toHaveBeenCalled();
    expect(db.mobileSession.create).not.toHaveBeenCalled();
  });

  it("creates a passwordless account with legal evidence, welcome claim, and hashed app sessions", async () => {
    const response = await post(await app(), { termsAccepted: true, ageGuardianAttested: true });
    expect(response.statusCode).toBe(201);
    expect(response.json().user).toMatchObject({ id: user.id, legalAcceptanceRequired: false });
    expect(response.json().user).not.toHaveProperty("googleSubject");
    expect(response.json().session.accessToken).toMatch(/^bma_at_/);
    const data = db.user.create.mock.calls[0]![0].data;
    expect(data).toMatchObject({ email: identity.email, googleSubject: identity.subject, displayName: "Reader" });
    // Google's `email_verified` is the proof the welcome grant waits for.
    expect(data.emailVerifiedAt).toBeInstanceOf(Date);
    expect(data).not.toHaveProperty("passwordCredential");
    expect(data.legalAcceptances.create).toMatchObject({ source: "mobile_google_signup", termsAttested: true, ageGuardianAttested: true });
    expect(data.welcomeCreditGrant.create).toHaveProperty("ipHash");
    expect(JSON.stringify(db.mobileSession.create.mock.calls)).not.toContain(response.json().session.accessToken);
  });

  it("signs in by immutable subject even after the Google email changes, without a second gift", async () => {
    verifier.mockResolvedValue({ ...identity, email: "changed@example.com" });
    db.user.findUnique.mockResolvedValueOnce(user);
    db.legalAcceptance.findFirst.mockResolvedValue(null);
    const response = await post(await app());
    expect(response.statusCode).toBe(200);
    expect(response.json().user).toMatchObject({ id: user.id, email: user.email, legalAcceptanceRequired: true });
    expect(db.user.findUnique).toHaveBeenCalledExactlyOnceWith({ where: { googleSubject: identity.subject } });
    expect(db.user.create).not.toHaveBeenCalled();
    expect(db.user.updateMany).not.toHaveBeenCalled();
  });

  it.each([{ status: "DISABLED" }, { disabledAt: new Date() }])("never signs in a disabled account: %j", async (disabled) => {
    db.user.findUnique.mockResolvedValueOnce({ ...user, ...disabled });
    expect((await post(await app())).statusCode).toBe(403);
    expect(db.mobileSession.create).not.toHaveBeenCalled();
  });

  it("does not link matching emails without the existing password, even with signup consent", async () => {
    db.user.findUnique.mockResolvedValueOnce(null).mockResolvedValueOnce({ ...user, googleSubject: null });
    const response = await post(await app(), { termsAccepted: true, ageGuardianAttested: true });
    expect(response.json().error.code).toBe("GOOGLE_LINK_REQUIRED");
    expect(db.user.updateMany).not.toHaveBeenCalled();
    expect(db.mobileSession.create).not.toHaveBeenCalled();
  });

  it("rejects a wrong linking password", async () => {
    db.user.findUnique.mockResolvedValueOnce(null).mockResolvedValueOnce({
      ...user, googleSubject: null, passwordCredential: { passwordHash: await hashPassword("correct-password") }
    });
    const response = await post(await app(), { password: "wrong" });
    expect(response.json().error.code).toBe("INVALID_CREDENTIALS");
    expect(db.user.updateMany).not.toHaveBeenCalled();
    expect(db.mobileSession.create).not.toHaveBeenCalled();
  });

  it("connects Google only after password proof and preserves the existing account", async () => {
    db.user.findUnique.mockResolvedValueOnce(null).mockResolvedValueOnce({
      ...user, googleSubject: null, passwordCredential: { passwordHash: await hashPassword("correct-password") }
    });
    const response = await post(await app(), { password: "correct-password" });
    expect(response.statusCode).toBe(200);
    expect(response.json().user.id).toBe(user.id);
    expect(db.user.updateMany).toHaveBeenCalledWith({
      where: expect.objectContaining({ id: user.id, googleSubject: null, status: "ACTIVE", disabledAt: null }),
      data: { googleSubject: identity.subject, emailVerifiedAt: expect.any(Date) }
    });
    expect(response.json().user.emailVerified).toBe(true);
    expect(db.user.create).not.toHaveBeenCalled();
  });

  it("keeps an earlier verification when linking", async () => {
    const verifiedAt = new Date("2026-06-01T00:00:00.000Z");
    db.user.findUnique.mockResolvedValueOnce(null).mockResolvedValueOnce({
      ...user, googleSubject: null, emailVerifiedAt: verifiedAt,
      passwordCredential: { passwordHash: await hashPassword("correct-password") }
    });
    const response = await post(await app(), { password: "correct-password" });
    expect(response.statusCode).toBe(200);
    expect(db.user.updateMany.mock.calls[0]![0].data).toEqual({ googleSubject: identity.subject });
    expect(response.json().user.emailVerified).toBe(true);
  });

  it("marks an unverified account verified when Google vouches for its own address", async () => {
    db.user.findUnique.mockResolvedValueOnce({ ...user, emailVerifiedAt: null });
    const response = await post(await app());
    expect(response.statusCode).toBe(200);
    expect(db.user.updateMany).toHaveBeenCalledWith({
      where: { id: user.id, email: identity.email, emailVerifiedAt: null },
      data: { emailVerifiedAt: expect.any(Date) }
    });
    expect(response.json().user.emailVerified).toBe(true);
  });

  it("does not replace a different linked Google identity", async () => {
    db.user.findUnique.mockResolvedValueOnce(null).mockResolvedValueOnce({ ...user, googleSubject: "someone-else" });
    expect((await post(await app(), { password: "anything" })).json().error.code).toBe("GOOGLE_ACCOUNT_CONFLICT");
    expect(db.user.updateMany).not.toHaveBeenCalled();
    expect(db.mobileSession.create).not.toHaveBeenCalled();
  });

  it("cannot link after a concurrent password reset or account disable", async () => {
    db.user.findUnique.mockResolvedValueOnce(null).mockResolvedValueOnce({
      ...user, googleSubject: null, passwordCredential: { passwordHash: await hashPassword("correct-password") }
    });
    db.user.updateMany.mockResolvedValueOnce({ count: 0 });
    expect((await post(await app(), { password: "correct-password" })).statusCode).toBe(409);
    expect(db.mobileSession.create).not.toHaveBeenCalled();
  });

  it("recovers a concurrent signup only by subject, without another welcome claim", async () => {
    db.user.findUnique.mockResolvedValueOnce(null).mockResolvedValueOnce(null).mockResolvedValueOnce(user);
    db.user.create.mockRejectedValueOnce({ code: "P2002" });
    const response = await post(await app(), { termsAccepted: true, ageGuardianAttested: true });
    expect(response.statusCode).toBe(200);
    expect(db.user.create).toHaveBeenCalledTimes(1);
    expect(db.user.findUnique).toHaveBeenLastCalledWith({ where: { googleSubject: identity.subject } });
  });

  it("requires linking when a password signup wins the email race", async () => {
    db.user.create.mockRejectedValueOnce({ code: "P2002" });
    const response = await post(await app(), { termsAccepted: true, ageGuardianAttested: true });
    expect(response.json().error.code).toBe("GOOGLE_LINK_REQUIRED");
    expect(db.mobileSession.create).not.toHaveBeenCalled();
  });

  it("rate limits invalid tokens before repeated Google verification", async () => {
    const instance = await app();
    verifier.mockRejectedValue(new Error("bad token"));
    for (let i = 0; i < 20; i++) await post(instance);
    const response = await post(instance);
    expect(response.statusCode).toBe(429);
    expect(response.headers).toHaveProperty("retry-after");
    expect(verifier).toHaveBeenCalledTimes(20);
  });

  it("counts an IPv6 caller rotating through its /64 as one caller", async () => {
    const instance = await app();
    verifier.mockRejectedValue(new Error("bad token"));
    const fromAddress = (remoteAddress: string) =>
      instance.inject({ method: "POST", url: "/api/mobile/auth/google", remoteAddress, payload: { idToken: "signed-token" } });

    for (let i = 1; i <= 20; i++) await fromAddress(`2001:db8:abcd:12::${i.toString(16)}`);

    expect((await fromAddress("2001:db8:abcd:12:ffff::1")).statusCode).toBe(429);
    expect((await fromAddress("2001:db8:abcd:13::1")).statusCode).toBe(401);
    expect(verifier).toHaveBeenCalledTimes(21);
  });
});
