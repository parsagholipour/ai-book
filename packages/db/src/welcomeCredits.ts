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

export async function ensureWelcomeCreditsTx(
  tx: BillingTx,
  account: PlanAccountRow,
  now: Date
): Promise<PlanAccountRow> {
  const pending = await tx.welcomeCreditGrant.findUnique({
    where: { userId: account.userId }
  });
  if (!pending || pending.outcome !== "PENDING") {
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

  await tx.$queryRaw`SELECT "userId" FROM "WelcomeCreditGrant" WHERE "ipHash" = ${pending.ipHash} FOR UPDATE`;

  const recentGrants = await tx.welcomeCreditGrant.count({
    where: {
      ipHash: pending.ipHash,
      outcome: "GRANTED",
      settledAt: { gte: new Date(now.getTime() - WELCOME_CREDITS_IP_WINDOW_MS) },
      userId: { not: account.userId }
    }
  });
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
