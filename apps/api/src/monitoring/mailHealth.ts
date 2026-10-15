import type { MailMessage, Mailer } from "../mailer.js";
import { failureReason } from "./readiness.js";

/**
 * Whether outgoing mail works, asked of the SMTP server rather than assumed.
 *
 * The production check reads only `SMTP_URL`'s scheme, so a wrong password
 * booted fine and then failed every password-reset code and every operator
 * alert with nothing but a log line — and the alert that mail is broken is
 * the one alert that cannot be emailed (launch review, 2026-10-13). So the
 * transport is verified (connect, greet, authenticate, send nothing) at boot
 * and every ten minutes, the answer is cached, and `/api/ready`'s `mail` check
 * reads the cache: the external uptime monitor sees a broken mailer even though
 * no email can say so, and the public URL never opens an SMTP connection.
 *
 * Until the first verification answers, mail counts as working, so a boot is
 * not reported as an outage. A real send's outcome — the operator's test alert,
 * and every password-reset and email-verification code (`mailerFeedingHealth`)
 * — is recorded the same way, since it proves or disproves the same thing, so a
 * mailer that breaks between two verifications shows on `/api/ready` at the
 * first reader it fails rather than up to ten minutes later.
 */

export const MAIL_VERIFY_INTERVAL_MS = 10 * 60_000;
/** Longer than nodemailer's own 15 s connect and greeting bounds (`SMTP_TIMEOUTS`), so theirs speak first. */
export const MAIL_VERIFY_TIMEOUT_MS = 40_000;

export type MailVerification =
  | { state: "unconfigured" }
  | { state: "pending" }
  | { state: "ok"; checkedAt: Date }
  | { state: "failing"; checkedAt: Date; reason: string };

type MailHealthLogger = {
  info(object: Record<string, unknown>, message: string): void;
  error(object: Record<string, unknown>, message: string): void;
};

export type MailHealth = {
  /** The cached answer; never connects. */
  current(): MailVerification;
  /** Verifies now (single-flight, bounded), caches and returns the answer. Never rejects. */
  verify(): Promise<MailVerification>;
  /** Records what a real send proved. */
  record(outcome: { ok: true } | { ok: false; error: unknown }): void;
  /** For `/api/ready`: resolves while mail works or is unchecked, rejects with the reason otherwise. */
  readinessCheck(): Promise<void>;
};

export function createMailHealth(input: {
  mailer: Mailer | null;
  log: MailHealthLogger;
  now?: () => Date;
  timeoutMs?: number;
}): MailHealth {
  const now = input.now ?? (() => new Date());
  const timeoutMs = input.timeoutMs ?? MAIL_VERIFY_TIMEOUT_MS;
  let current: MailVerification = input.mailer ? { state: "pending" } : { state: "unconfigured" };
  let inFlight: Promise<MailVerification> | null = null;

  const settle = (outcome: { ok: true } | { ok: false; error: unknown }, source: "verify" | "send"): MailVerification => {
    const previous = current;
    if (outcome.ok) {
      current = { state: "ok", checkedAt: now() };
      if (previous.state !== "ok") {
        input.log.info(
          { event: previous.state === "failing" ? "email.recovered" : "email.verified", source },
          previous.state === "failing" ? "Outgoing mail works again" : "Outgoing mail verified"
        );
      }
    } else {
      const reason = failureReason(outcome.error);
      current = { state: "failing", checkedAt: now(), reason };
      input.log.error(
        { event: "email.verify_failed", source, reason },
        "Outgoing mail is not working: password-reset codes and operator alerts cannot be sent (check SMTP_URL)"
      );
    }
    return current;
  };

  return {
    current: () => current,
    verify() {
      const mailer = input.mailer;
      if (!mailer?.verify) return Promise.resolve(current);
      const verifyTransport = mailer.verify.bind(mailer);
      inFlight ??= withinMs(verifyTransport(), timeoutMs, "SMTP verification")
        .then(
          () => settle({ ok: true }, "verify"),
          (error: unknown) => settle({ ok: false, error }, "verify")
        )
        .finally(() => {
          inFlight = null;
        });
      return inFlight;
    },
    record(outcome) {
      if (input.mailer) settle(outcome, "send");
    },
    async readinessCheck() {
      if (current.state === "unconfigured") throw new Error("no mail transport is configured (SMTP_URL)");
      if (current.state === "failing") throw new Error(current.reason);
    }
  };
}

/**
 * The mailer the reader-facing sends go through: password reset, email
 * verification, and the code sign-up mails. Each send's outcome is recorded in
 * the health cache, as the test alert's is, and the send answers its caller
 * exactly as before. A refusal of the *recipient* is not recorded as a failure:
 * the address came from a reader (a typo, a domain with no mail server), the
 * transport worked, and recording it would let anyone signing up with a bad
 * address fail `/api/ready` for everyone.
 */
export function mailerFeedingHealth(mailer: Mailer | null, health: Pick<MailHealth, "record">): Mailer | null {
  if (!mailer) return null;
  return {
    async send(message: MailMessage) {
      try {
        await mailer.send(message);
      } catch (error) {
        if (!isRecipientRejection(error)) health.record({ ok: false, error });
        throw error;
      }
      health.record({ ok: true });
    },
    ...(mailer.verify ? { verify: mailer.verify.bind(mailer) } : {})
  };
}

/**
 * nodemailer's answer when the server refused the address or the address would
 * not parse (`EENVELOPE` on `RCPT TO`, or its own "Invalid recipient"). A
 * refused sender (`MAIL FROM`), a refused login, a dead socket or a timeout is
 * the transport's fault and stays a failure.
 */
export function isRecipientRejection(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const { code, command, message } = error as { code?: unknown; command?: unknown; message?: unknown };
  if (code !== "EENVELOPE") return false;
  return command === "RCPT TO" || (typeof message === "string" && message.startsWith("Invalid recipient"));
}

/** Rejects when `work` has not settled within `ms`; the work itself is left to finish or fail on its own. */
export async function withinMs<T>(work: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${what} did not answer within ${ms} ms`)), ms);
        timer.unref?.();
      })
    ]);
  } finally {
    clearTimeout(timer);
  }
}
