import { describe, expect, it, vi } from "vitest";
import { createMailerFromConfig, smtpUrlWithTimeouts, SMTP_TIMEOUTS } from "../mailer.js";
import { createMailHealth, isRecipientRejection, mailerFeedingHealth } from "./mailHealth.js";

const log = () => ({ info: vi.fn(), error: vi.fn() });

describe("mail health", () => {
  it("counts mail as working until the first verification answers, then caches the answer", async () => {
    const verify = vi.fn(async () => undefined);
    const health = createMailHealth({ mailer: { send: vi.fn(), verify }, log: log() });
    expect(health.current()).toEqual({ state: "pending" });
    await expect(health.readinessCheck()).resolves.toBeUndefined();

    await health.verify();
    expect(health.current()).toMatchObject({ state: "ok" });
    // Readiness reads the cache; it never connects.
    await health.readinessCheck();
    await health.readinessCheck();
    expect(verify).toHaveBeenCalledTimes(1);
  });

  it("fails readiness with the server's reason after a refused login, logged at error level, and recovers", async () => {
    const logger = log();
    const verify = vi.fn(async (): Promise<void> => {
      throw new Error("Invalid login: 535 Authentication failed for smtps://user:hunter2@smtp.example.com");
    });
    const health = createMailHealth({ mailer: { send: vi.fn(), verify }, log: logger });

    await expect(health.verify()).resolves.toMatchObject({ state: "failing" });
    await expect(health.readinessCheck()).rejects.toThrow("Invalid login: 535 Authentication failed");
    await expect(health.readinessCheck()).rejects.not.toThrow("hunter2");
    expect(logger.error).toHaveBeenCalledWith(expect.objectContaining({ event: "email.verify_failed" }), expect.any(String));

    verify.mockResolvedValueOnce(undefined);
    await health.verify();
    await expect(health.readinessCheck()).resolves.toBeUndefined();
    expect(logger.info).toHaveBeenCalledWith(expect.objectContaining({ event: "email.recovered" }), expect.any(String));
  });

  it("gives up on a server that never answers, without stopping anything else", async () => {
    const health = createMailHealth({
      mailer: { send: vi.fn(), verify: () => new Promise<void>(() => undefined) },
      log: log(),
      timeoutMs: 20
    });
    await expect(health.verify()).resolves.toMatchObject({ state: "failing", reason: expect.stringContaining("did not answer within 20 ms") });
  });

  it("verifies once for callers that overlap", async () => {
    let release: () => void = () => undefined;
    const verify = vi.fn(() => new Promise<void>((resolve) => { release = resolve; }));
    const health = createMailHealth({ mailer: { send: vi.fn(), verify }, log: log() });
    const both = Promise.all([health.verify(), health.verify()]);
    release();
    await both;
    expect(verify).toHaveBeenCalledTimes(1);
  });

  it("fails readiness when no transport is configured at all", async () => {
    const health = createMailHealth({ mailer: null, log: log() });
    await expect(health.verify()).resolves.toEqual({ state: "unconfigured" });
    await expect(health.readinessCheck()).rejects.toThrow("SMTP_URL");
  });

  it("takes a real send's outcome as proof either way", async () => {
    const health = createMailHealth({ mailer: { send: vi.fn() }, log: log() });
    health.record({ ok: false, error: new Error("Greeting never received") });
    await expect(health.readinessCheck()).rejects.toThrow("Greeting never received");
    health.record({ ok: true });
    await expect(health.readinessCheck()).resolves.toBeUndefined();
  });
});

describe("a reader's code feeding mail health", () => {
  const message = { to: "reader@example.com", subject: "Your code", text: "123456" };
  /** nodemailer's own shape for a failed send (`_formatError` in smtp-connection). */
  const smtpError = (message: string, code: string, command: string) =>
    Object.assign(new Error(message), { code, command });

  it("fails readiness at the first code the transport cannot send, and the caller still sees the error", async () => {
    const send = vi.fn(async (): Promise<void> => {
      throw smtpError("Invalid login: 535 5.7.8 Authentication failed", "EAUTH", "AUTH PLAIN");
    });
    const health = createMailHealth({ mailer: { send }, log: log() });
    const reader = mailerFeedingHealth({ send }, health)!;

    await expect(reader.send(message)).rejects.toThrow("Authentication failed");
    expect(health.current()).toMatchObject({ state: "failing", reason: expect.stringContaining("535") });
    await expect(health.readinessCheck()).rejects.toThrow("Authentication failed");

    send.mockResolvedValueOnce(undefined);
    await reader.send(message);
    await expect(health.readinessCheck()).resolves.toBeUndefined();
  });

  it("does not let a refused or malformed reader address fail readiness for everyone", async () => {
    const refused = smtpError("Can't send mail - all recipients were rejected: 550 5.1.1 No such user", "EENVELOPE", "RCPT TO");
    const malformed = smtpError('Invalid recipient "a@b@c"', "EENVELOPE", "API");
    const send = vi.fn(async (): Promise<void> => {
      throw refused;
    });
    const health = createMailHealth({ mailer: { send }, log: log() });
    const reader = mailerFeedingHealth({ send }, health)!;

    await expect(reader.send(message)).rejects.toBe(refused);
    send.mockRejectedValueOnce(malformed);
    await expect(reader.send(message)).rejects.toBe(malformed);
    expect(health.current()).toEqual({ state: "pending" });

    // A refused *sender* is the configuration's fault, and is recorded.
    expect(isRecipientRejection(smtpError("Mail command failed: 553 sender rejected", "EENVELOPE", "MAIL FROM"))).toBe(false);
    expect(isRecipientRejection(smtpError("Connection timeout", "ETIMEDOUT", "CONN"))).toBe(false);
    expect(isRecipientRejection(new Error("boom"))).toBe(false);
  });

  it("passes verification through without recording it twice, and keeps no transport as none", async () => {
    const verify = vi.fn(async () => undefined);
    const record = vi.fn();
    const reader = mailerFeedingHealth({ send: vi.fn(async () => undefined), verify }, { record })!;
    await reader.verify?.();
    expect(verify).toHaveBeenCalledTimes(1);
    expect(record).not.toHaveBeenCalled();
    await reader.send(message);
    expect(record).toHaveBeenCalledWith({ ok: true });
    expect(mailerFeedingHealth(null, { record })).toBeNull();
  });
});

describe("the SMTP transport", () => {
  it("bounds connect, greeting and an idle socket unless SMTP_URL sets its own", () => {
    const url = new URL(smtpUrlWithTimeouts("smtps://user%40x.com:p%2Fss@smtp.example.com:465/?socketTimeout=90000"));
    expect(url.searchParams.get("connectionTimeout")).toBe(String(SMTP_TIMEOUTS.connectionTimeout));
    expect(url.searchParams.get("greetingTimeout")).toBe(String(SMTP_TIMEOUTS.greetingTimeout));
    expect(url.searchParams.get("socketTimeout")).toBe("90000");
    // The credentials survive the rewrite exactly as they were encoded.
    expect(url.username).toBe("user%40x.com");
    expect(url.password).toBe("p%2Fss");
  });

  it("verifies the mock transport without a server, and builds a verifiable SMTP one", async () => {
    const mock = createMailerFromConfig({ SMTP_URL: undefined, EMAIL_FROM: "Tomeza <a@b.c>", MOCK_EMAIL: true }, { info: vi.fn() });
    await expect(mock?.verify?.()).resolves.toBeUndefined();
    const smtp = createMailerFromConfig({ SMTP_URL: "smtp://u:p@127.0.0.1:1", EMAIL_FROM: "Tomeza <a@b.c>", MOCK_EMAIL: false }, { info: vi.fn() });
    expect(typeof smtp?.verify).toBe("function");
    // Port 1 refuses at once: the verification fails with the cause instead of hanging.
    await expect(smtp?.verify?.()).rejects.toThrow();
  });
});
