import { createTransport } from "nodemailer";
import type { AppConfig } from "@book-maker/core";

export type MailMessage = {
  to: string;
  subject: string;
  text: string;
};

export type Mailer = {
  send(message: MailMessage): Promise<void>;
};

type MailerLogger = {
  info(obj: object, msg?: string): void;
};

/**
 * The one place transactional email is wired. Three outcomes, mirroring the
 * Google Play verifier: a mock that logs the whole message in dev (the reset
 * code lands in the API log, no SMTP server needed), a real SMTP transport
 * when `SMTP_URL` is configured, and `null` in production with no SMTP — the
 * caller answers an explicit 503 rather than telling users mail was sent that
 * never left the process.
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
      }
    };
  }

  if (!config.SMTP_URL) {
    return null;
  }

  const transport = createTransport(config.SMTP_URL);
  const from = config.EMAIL_FROM;
  return {
    async send(message) {
      await transport.sendMail({
        from,
        to: message.to,
        subject: message.subject,
        text: message.text
      });
    }
  };
}
