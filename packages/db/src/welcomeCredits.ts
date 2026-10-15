/**
 * One-time welcome credits for a new account.
 *
 * Signup writes a PENDING `WelcomeCreditGrant`. Settlement is lazy: the first
 * balance read or reserve (through `ensureCurrentPlanPeriodTx`) decides whether
 * to grant, and a failure is retried on the next read. A user with no row is a
 * pre-existing account and is never welcomed.
 *
 * Credits land in the purchased pool so they do not evaporate at a period
 * boundary. The operator toggle and amount live on the same price list as the
 * other free-tier limits, including separate per-IP account caps for high-income
 * and low/middle-income signup countries inside {@link WELCOME_CREDITS_IP_WINDOW_DAYS}.
 * Unknown countries use the low/middle-income cap; a zero cap disables that gift.
 * Further claims settle as RECENT_IP without telling the reader. A missing IP
 * settles as NO_IP — no grant, also silent.
 *
 * Nothing is GRANTED to an account whose email is unverified
 * (`User.emailVerifiedAt`, migration 000106): its grant stays PENDING until a
 * code is confirmed or Google vouches for the address. The outcomes that grant
 * nothing still settle while it waits, so the app never promises credits the
 * signup address could not receive.
 */
import { creditPricing, welcomeCreditAmount, welcomeCreditIpLimit } from "@book-maker/core";
import { prisma } from "./client.ts";
import {
  type BillingTx,
  type PlanAccountRow,
  accountSelect,
  effectivePlanCredits,
  ledgerData,
  ledgerSelect
} from "./billingInternals.ts";

export const WELCOME_CREDITS_IP_WINDOW_DAYS = 30;
const WELCOME_CREDITS_IP_WINDOW_MS = WELCOME_CREDITS_IP_WINDOW_DAYS * 24 * 60 * 60 * 1000;

export function welcomeGrantIdempotencyKey(userId: string): string {
  return `welcome:${userId}`;
}

/**
 * Whether the host process is holding pending grants back for free accounts.
 *
 * The API's spend breaker installs this (`apps/api/src/spendBreaker.ts`): while
 * the day's provider spend is past the operator's soft cap, or AI work is
 * paused, a free account's PENDING grant stays PENDING, and the next balance
 * read or reserve after the breaker clears settles it exactly as it would have.
 * It is a process-wide predicate rather than an argument because every balance
 * read and every reservation in the product reaches this function through
 * `ensureCurrentPlanPeriodTx`, and a hold threaded through each of their callers
 * is a hold the first forgotten caller grants past. This package never reads
 * the spend controls itself; with nothing installed (the worker, the suites)
 * nothing is held.
 */
let welcomeGrantHold: (() => boolean) | null = null;

export function setWelcomeGrantHold(hold: (() => boolean) | null): void {
  welcomeGrantHold = hold;
}

function welcomeGrantsHeld(): boolean {
  try {
    return welcomeGrantHold?.() === true;
  } catch {
    // A broken predicate must not fail every balance read; grant as before.
    return false;
  }
}

export async function ensureWelcomeCreditsTx(
  tx: BillingTx,
  account: PlanAccountRow,
  now: Date,
  options: {
    /**
     * Whether the account is on a paid plan, asked only while grants are held:
     * the hold restricts free accounts, so a reader who subscribed on day one
     * is welcomed regardless. Absent means free.
     */
    onPaidPlan?: () => Promise<boolean>;
  } = {}
): Promise<PlanAccountRow> {
  const pending = await tx.welcomeCreditGrant.findUnique({
    where: { userId: account.userId },
    include: { user: { select: { emailVerifiedAt: true } } }
  });
  if (!pending || pending.outcome !== "PENDING") {
    return account;
  }
  if (welcomeGrantsHeld() && !(await options.onPaidPlan?.())) {
    // Deferred, not refused: the row stays PENDING and nothing is written.
    return account;
  }

  const pricing = creditPricing();
  const amount = Math.max(0, Math.floor(welcomeCreditAmount(pending.countryCode, pricing)));
  const ipLimit = welcomeCreditIpLimit(pending.countryCode, pricing);
  if (amount <= 0 || ipLimit <= 0) {
    await settleWelcomeClaim(tx, account.userId, { outcome: "DISABLED", amountCredits: 0, now });
    return account;
  }

  if (!pending.ipHash) {
    await settleWelcomeClaim(tx, account.userId, { outcome: "NO_IP", amountCredits: 0, now });
    return account;
  }

  // The verification gate is here, inside the one function every balance read
  // and reservation reaches, for the reason the spend-breaker hold is: a gate
  // threaded through the callers is one the first forgotten caller grants past.
  // An unverified account settles only what grants nothing — an address already
  // at its cap — and otherwise waits, PENDING, for its code. Unlocked, because
  // it writes no grant: the count only grows inside the window, so a full
  // address read here is still full under the lock.
  if (!pending.user.emailVerifiedAt) {
    if ((await recentWelcomeGrants(tx, pending.ipHash, account.userId, now)) >= ipLimit) {
      await settleWelcomeClaim(tx, account.userId, { outcome: "RECENT_IP", amountCredits: 0, now });
    }
    return account;
  }

  await tx.$queryRaw`SELECT "userId" FROM "WelcomeCreditGrant" WHERE "ipHash" = ${pending.ipHash} FOR UPDATE`;

  const recentGrants = await recentWelcomeGrants(tx, pending.ipHash, account.userId, now);
  if (recentGrants >= ipLimit) {
    await settleWelcomeClaim(tx, account.userId, { outcome: "RECENT_IP", amountCredits: 0, now });
    return account;
  }

  const existing = await tx.creditLedgerEntry.findUnique({
    where: { idempotencyKey: welcomeGrantIdempotencyKey(account.userId) },
    select: ledgerSelect
  });
  if (existing) {
    await settleWelcomeClaim(tx, account.userId, {
      outcome: "GRANTED",
      amountCredits: existing.amountCredits,
      ledgerEntryId: existing.id,
      now
    });
    return readAccount(tx, account);
  }

  const updated = await tx.userCreditAccount.update({
    where: { userId: account.userId },
    data: {
      availableCredits: { increment: amount },
      lifetimeCreditsGranted: { increment: amount }
    },
    select: accountSelect
  });

  const spendableBefore = account.availableCredits + effectivePlanCredits(account, now);
  const entry = await tx.creditLedgerEntry.create({
    data: ledgerData({
      userId: account.userId,
      operation: "WELCOME_GRANT",
      entryType: "GRANT",
      status: "SETTLED",
      amountCredits: amount,
      balanceAfterCredits: spendableBefore + amount,
      idempotencyKey: welcomeGrantIdempotencyKey(account.userId),
      description: "Welcome credits"
    }),
    select: ledgerSelect
  });

  await settleWelcomeClaim(tx, account.userId, {
    outcome: "GRANTED",
    amountCredits: amount,
    ledgerEntryId: entry.id,
    now
  });
  return updated;
}

/** Read after balance settlement; describe what this account actually received. */
export async function getWelcomeCreditsGranted(userId: string): Promise<number> {
  const grant = await prisma.welcomeCreditGrant.findUnique({
    where: { userId },
    select: { outcome: true, amountCredits: true }
  });
  return grant?.outcome === "GRANTED" ? grant.amountCredits : 0;
}

/**
 * Read after balance settlement: true when a grant is still owed — which, past
 * a settlement, means the email is unverified or the spend breaker is holding
 * it (see {@link setWelcomeGrantHold}); {@link describePendingWelcomeGrant}
 * says which.
 */
export async function isWelcomeCreditGrantPending(userId: string): Promise<boolean> {
  const grant = await prisma.welcomeCreditGrant.findUnique({
    where: { userId },
    select: { outcome: true }
  });
  return grant?.outcome === "PENDING";
}

export type PendingWelcomeGrantReason = "email_unverified" | "spend_hold";

export type PendingWelcomeGrant = {
  /**
   * What the reader can do about it. `email_unverified` wins over the hold:
   * verifying is the one step the reader can take, and a grant held for both
   * still needs it once the hold clears.
   */
  reason: PendingWelcomeGrantReason;
  /**
   * What the grant would pay if it settled now: the price list's amount for the
   * signup country. An address already at its cap has settled RECENT_IP before
   * this is read (see {@link ensureWelcomeCreditsTx}), so this is not a promise
   * the cap will break — only another account on the same address verifying
   * first, or an operator price change, can still move it.
   */
  credits: number;
};

/** Read after balance settlement, as {@link isWelcomeCreditGrantPending} is. */
export async function describePendingWelcomeGrant(userId: string): Promise<PendingWelcomeGrant | null> {
  const grant = await prisma.welcomeCreditGrant.findUnique({
    where: { userId },
    select: { outcome: true, countryCode: true, user: { select: { emailVerifiedAt: true } } }
  });
  if (grant?.outcome !== "PENDING") {
    return null;
  }
  return {
    reason: grant.user.emailVerifiedAt ? "spend_hold" : "email_unverified",
    credits: Math.max(0, Math.floor(welcomeCreditAmount(grant.countryCode, creditPricing())))
  };
}

/** GRANTED claims on this address inside the window, this account's own excepted. */
async function recentWelcomeGrants(tx: BillingTx, ipHash: string, userId: string, now: Date): Promise<number> {
  return tx.welcomeCreditGrant.count({
    where: {
      ipHash,
      outcome: "GRANTED",
      settledAt: { gte: new Date(now.getTime() - WELCOME_CREDITS_IP_WINDOW_MS) },
      userId: { not: userId }
    }
  });
}

async function settleWelcomeClaim(
  tx: BillingTx,
  userId: string,
  options: {
    outcome: "GRANTED" | "DISABLED" | "RECENT_IP" | "NO_IP";
    amountCredits: number;
    ledgerEntryId?: string;
    now: Date;
  }
): Promise<void> {
  await tx.welcomeCreditGrant.update({
    where: { userId },
    data: {
      outcome: options.outcome,
      amountCredits: options.amountCredits,
      settledAt: options.now,
      ...(options.ledgerEntryId ? { ledgerEntryId: options.ledgerEntryId } : {})
    }
  });
}

async function readAccount(tx: BillingTx, fallback: PlanAccountRow): Promise<PlanAccountRow> {
  return (
    (await tx.userCreditAccount.findUnique({
      where: { userId: fallback.userId },
      select: accountSelect
    })) ?? fallback
  );
}
