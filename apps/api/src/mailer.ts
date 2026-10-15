import { createTransport } from "nodemailer";
import type { AppConfig } from "@book-maker/core";

export type MailMessage = {
  to: string;
  subject: string;
  text: string;
};

export type Mailer = {
  send(message: MailMessage): Promise<void>;
  /**
   * Connects and authenticates without sending anything; rejects with the
   * cause when the server, the port or the credentials are wrong. Optional so
   * a test double can leave it out; both real mailers implement it.
   */
  verify?(): Promise<void>;
};

type MailerLogger = {
  info(obj: object, msg?: string): void;
};

/**
 * nodemailer waits two minutes to connect and ten minutes on a silent socket
 * by default, so one dead SMTP server held a password-reset request, or the
 * boot check, for that long. Idle bounds, not a cap on a send. Added to the
 * URL only where `SMTP_URL` does not already set them, because nodemailer
 * takes every other option from the URL's query and ignores what sits beside it.
 */
export const SMTP_TIMEOUTS = Object.freeze({ connectionTimeout: 15_000, greetingTimeout: 15_000, socketTimeout: 60_000 });

export function smtpUrlWithTimeouts(url: string): string {
  const parsed = new URL(url);
  for (const [key, value] of Object.entries(SMTP_TIMEOUTS)) {
    if (!parsed.searchParams.has(key)) parsed.searchParams.set(key, String(value));
  }
  return parsed.toString();
}

/**
 * The one place transactional email is wired. Three outcomes, mirroring the
 * Google Play verifier: a mock that logs the whole message in dev (the reset
 * code lands in the API log, no SMTP server needed), a real SMTP transport
 * when `SMTP_URL` is configured, and `null` in production with no SMTP — the
 * caller answers an explicit 503 rather than telling users mail was sent that
 * never left the process.
 *
 * The production check (`productionConfig.ts`) only reads the URL's scheme;
 * whether the server answers and takes the credentials is `verify()`, which
 * `monitoring/mailHealth.ts` runs at boot and every ten minutes.
 */
export function createMailerFromConfig(
  config: Pick<AppConfig, "SMTP_URL" | "EMAIL_FROM" | "MOCK_EMAIL">,
  log: MailerLogger
): Mailer | null {
  if (config.MOCK_EMAIL) {
    return {
      async send(message) {
        log.info(
          { event: "email.mock_delivered", to: message.to, subject: message.subject, text: message.text },
          "Mock email delivered (MOCK_EMAIL)"
        );
      },
      async verify() {}
    };
  }

  if (!config.SMTP_URL) {
    return null;
  }

  const transport = createTransport(smtpUrlWithTimeouts(config.SMTP_URL));
  const from = config.EMAIL_FROM;
  return {
    async send(message) {
      await transport.sendMail({
        from,
        to: message.to,
        subject: message.subject,
        text: message.text
      });
    },
    async verify() {
      await transport.verify();
    }
  };
}
