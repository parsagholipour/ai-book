import { createHash, randomBytes, randomInt, timingSafeEqual } from "node:crypto";
import { prisma } from "@book-maker/db";
import type { MailMessage, Mailer } from "./mailer.js";

/**
 * The 6-digit codes that prove a reader receives mail at their account's
 * address — the proof the welcome grant waits for (`User.emailVerifiedAt`,
 * packages/db/src/welcomeCredits.ts). Issued here, by sign-up and by
 * `POST /api/mobile/auth/email/verification`; confirmed in
 * `mobileEmailVerification.ts`.
 *
 * Deliberately not a module of the routes: `mobileAuth.ts` sends the first code
 * at sign-up, and the routes import `mobileAuth.ts`, so the shared half lives
 * where neither import is a cycle.
 *
 * A code is stored as a salted SHA-256, not through scrypt like a reset code.
 * A reset code is a credential — whoever holds it chooses the password — so its
 * hash is worth slowing down. This one only confirms an address for a reader
 * who already holds a session, so a stolen hash is worth nothing, and staying
 * off the scrypt gate keeps a busy gate from failing the sign-up that sends it.
 */

export const EMAIL_VERIFICATION_CODE_TTL_MS = 30 * 60 * 1000;
// A million-entry keyspace, so the guess cap per code is the online defense, as
// it is for reset codes: five wrong entries and the reader asks for a new one.
export const EMAIL_VERIFICATION_MAX_ATTEMPTS = 5;
/** How soon a reader may ask for another code; the app counts down the same. */
export const EMAIL_VERIFICATION_RESEND_MS = 60 * 1000;
/** Codes one account may be sent in a day: fifty guesses, ten emails. */
export const EMAIL_VERIFICATION_DAILY_CODES = 10;
export const EMAIL_VERIFICATION_DAY_MS = 24 * 60 * 60 * 1000;

type VerificationRecipient = { id: string; email: string; displayName: string | null };

type IssuedVerificationCode = { id: string; code: string; expiresAt: Date };

type VerificationLogger = {
  warn(obj: object, msg?: string): void;
  error(obj: object, msg?: string): void;
};

export function generateVerificationCode(): string {
  return String(randomInt(0, 1_000_000)).padStart(6, "0");
}

export function hashVerificationCode(code: string): string {
  const salt = randomBytes(16).toString("base64url");
  return `${salt}.${digest(salt, code)}`;
}

export function verificationCodeMatches(code: string, stored: string): boolean {
  const [salt, expected] = stored.split(".");
  if (!salt || !expected) {
    return false;
  }
  const actual = Buffer.from(digest(salt, code));
  const wanted = Buffer.from(expected);
  return actual.length === wanted.length && timingSafeEqual(actual, wanted);
}

function digest(salt: string, code: string): string {
  return createHash("sha256").update(`email-verification:${salt}:${code}`).digest("base64url");
}

/**
 * Writes a new code for the account's current address. The newest code is the
 * only one that works: pending codes expire in place, and stay as rows so the
 * day's count survives a restart. Rows older than that day go.
 */
export async function issueEmailVerificationCode(
  user: VerificationRecipient,
  options: { requestIpHash?: string | null | undefined; now?: Date } = {}
): Promise<IssuedVerificationCode> {
  const now = options.now ?? new Date();
  const code = generateVerificationCode();
  const expiresAt = new Date(now.getTime() + EMAIL_VERIFICATION_CODE_TTL_MS);
  const [, , created] = await prisma.$transaction([
    prisma.emailVerificationRequest.deleteMany({
      where: { userId: user.id, createdAt: { lt: new Date(now.getTime() - EMAIL_VERIFICATION_DAY_MS) } }
    }),
    prisma.emailVerificationRequest.updateMany({
      where: { userId: user.id, consumedAt: null, expiresAt: { gt: now } },
      data: { expiresAt: now }
    }),
    prisma.emailVerificationRequest.create({
      data: {
        userId: user.id,
        email: user.email,
        codeHash: hashVerificationCode(code),
        expiresAt,
        ...(options.requestIpHash ? { requestIpHash: options.requestIpHash } : {})
      },
      select: { id: true }
    })
  ]);
  return { id: created.id, code, expiresAt };
}

export function emailVerificationEmail(to: string, displayName: string | null, code: string): MailMessage {
  const greeting = displayName ? `Hi ${displayName},` : "Hi,";
  return {
    to,
    subject: "Your Tomeza verification code",
    text: [
      greeting,
      "",
      "Your Tomeza verification code is:",
      "",
      `    ${code}`,
      "",
      "Enter it in the Tomeza app within 30 minutes to verify your email address.",
      "",
      "If you didn't create a Tomeza account, you can ignore this email."
    ].join("\n")
  };
}

/**
 * Sign-up's first code. Never throws and is not waited for: the account and its
 * session already exist, a slow SMTP server must not hold the sign-up response,
 * and a code that never arrives is asked for again from the verify screen.
 */
export async function sendFirstEmailVerificationCode(
  user: VerificationRecipient,
  mailer: Mailer | null | undefined,
  options: { requestIpHash?: string | null | undefined; log: VerificationLogger }
): Promise<void> {
  if (!mailer) {
    options.log.warn({ event: "email.verification_unconfigured" }, "No mailer; the reader can ask for a code later");
    return;
  }
  try {
    const issued = await issueEmailVerificationCode(user, { requestIpHash: options.requestIpHash });
    await mailer.send(emailVerificationEmail(user.email, user.displayName, issued.code));
  } catch (error) {
    options.log.error({ err: error, event: "email.verification_failed" }, "Sign-up verification email failed");
  }
}
