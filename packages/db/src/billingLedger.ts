/**
 * The credit ledger: every balance mutation in the product goes through one of
 * these functions, inside a serializable transaction, keyed by a caller-supplied
 * idempotency key so a retried request can never move credits twice.
 *
 * Balances are two pools — the monthly allowance and what the user bought — and
 * spending draws on the allowance first, so the pool that expires is the one
 * that gets used. Each entry records how much of itself came from the allowance
 * (`planCreditsDelta`), which is what lets a refund put credits back where they
 * came from. See `planPeriods.ts` for how periods are granted.
 */
import type { BillingOperation } from "@book-maker/core";
import { prisma } from "./client.ts";
import {
  InsufficientCreditsError,
  type BillingTx,
  type CreditBalance,
  type CreditLedgerEntryRecord,
  type LedgerContext,
  imageQuotaPeriodKeyFromMetadata,
  jsonInput,
  ledgerData,
  ledgerRefundSelect,
  ledgerSelect,
  planPeriodKeyFromMetadata,
  revokeEntitlementsForLedgerEntryTx,
  runSerializable
} from "./billingInternals.ts";
import {
  type PlanAccountRow,
  effectivePlanCredits,
  ensureCreditAccountRow,
  ensureCurrentPlanPeriod,
  ensureCurrentPlanPeriodTx,
  releaseIllustratedBookUseTx
} from "./planPeriods.ts";

export async function getCreditBalance(userId: string, now: Date = new Date()): Promise<CreditBalance> {
  const account = await ensureCurrentPlanPeriod(userId, now);
  return serializeCreditBalance(account, now);
}

export async function grantCredits(options: LedgerContext & {
  amountCredits: number;
  operation?: BillingOperation | undefined;
  idempotencyKey: string;
}): Promise<CreditLedgerEntryRecord> {
  if (!Number.isInteger(options.amountCredits) || options.amountCredits <= 0) {
    throw new Error("Credit grants must be positive whole-credit amounts.");
  }

  return runSerializable(async (tx) => {
    const existing = await tx.creditLedgerEntry.findUnique({
      where: { idempotencyKey: options.idempotencyKey },
      select: ledgerSelect
    });
    if (existing) {
      return existing;
    }

    // Grants land in the purchased pool: they are bought or awarded outright and
    // must not evaporate at the next period boundary. Allowances are granted by
    // `planPeriods.ts` instead, which owns the pool that resets.
    const account = await ensureCreditAccountRow(tx, options.userId);
    await tx.userCreditAccount.update({
      where: { userId: options.userId },
      data: {
        availableCredits: { increment: options.amountCredits },
        lifetimeCreditsGranted: { increment: options.amountCredits }
      }
    });

    return tx.creditLedgerEntry.create({
      data: ledgerData({
        ...options,
        operation: options.operation ?? "ADMIN_GRANT",
        entryType: "GRANT",
        status: "SETTLED",
        amountCredits: options.amountCredits,
        balanceAfterCredits: spendableCredits(account) + options.amountCredits
      }),
      select: ledgerSelect
    });
  });
}

export async function reserveCredits(options: LedgerContext & {
  amountCredits: number;
  operation: BillingOperation;
  idempotencyKey: string;
  now?: Date | undefined;
}): Promise<CreditLedgerEntryRecord | null> {
  return runSerializable((tx) => reserveCreditsTx(tx, options));
}

/** Transaction-aware form used by the generation-attempt boundary. */
export async function reserveCreditsTx(
  tx: BillingTx,
  options: LedgerContext & {
    amountCredits: number;
    operation: BillingOperation;
    idempotencyKey: string;
    now?: Date | undefined;
  }
): Promise<CreditLedgerEntryRecord | null> {
  if (options.amountCredits === 0) {
    return null;
  }
  if (!Number.isInteger(options.amountCredits) || options.amountCredits < 0) {
    throw new Error("Credit reservations must be non-negative whole-credit amounts.");
  }
  const now = options.now ?? new Date();

  const existing = await tx.creditLedgerEntry.findUnique({
    where: { idempotencyKey: options.idempotencyKey },
    select: ledgerSelect
  });
    // An idempotency key is a promise that this charge happens *once ever*, not
    // once per attempt: refunding leaves the entry SETTLED and never releases
    // the key, so a caller that reuses one after a refund gets the reversed row
    // back and `commitReservedCredits` short-circuits on it — the work is then
    // done for free. Any priced operation a user can retry has to vary its key
    // per attempt (see the audiobook route, which names the run it supersedes).
  if (existing) {
    // The short-circuit may only ever answer the account that owns the entry:
    // a key computed from shared material (a purchase token, a project id)
    // that collided across users would otherwise commit user B's charge
    // against user A's reservation and account.
    if (existing.userId !== options.userId) {
      throw new Error("Idempotency key already belongs to another account's charge.");
    }
    return existing;
  }

    // Anyone about to spend is owed their allowance first — this is what grants
    // the free month, and it is deliberately on the charging path rather than a
    // cron so no user can be missed.
  const account = await ensureCurrentPlanPeriodTx(tx, options.userId, now);
  const spendable = spendableCredits(account, now);
  if (spendable < options.amountCredits) {
    throw new InsufficientCreditsError({
      requiredCredits: options.amountCredits,
      availableCredits: spendable,
      reservedCredits: account.reservedCredits
    });
  }

  const fromPlan = Math.min(effectivePlanCredits(account, now), options.amountCredits);
  const fromPurchased = options.amountCredits - fromPlan;
  const updated = await tx.userCreditAccount.updateMany({
    where: {
      userId: options.userId,
      planCredits: { gte: fromPlan },
      availableCredits: { gte: fromPurchased }
    },
    data: {
      planCredits: { decrement: fromPlan },
      availableCredits: { decrement: fromPurchased },
      reservedCredits: { increment: options.amountCredits }
    }
  });
  if (updated.count !== 1) {
    const latest = await ensureCreditAccountRow(tx, options.userId);
    throw new InsufficientCreditsError({
      requiredCredits: options.amountCredits,
      availableCredits: spendableCredits(latest, now),
      reservedCredits: latest.reservedCredits
    });
  }

  return tx.creditLedgerEntry.create({
    data: ledgerData({
      ...options,
      entryType: "RESERVE",
      status: "RESERVED",
      amountCredits: -options.amountCredits,
      planCreditsDelta: -fromPlan,
      balanceAfterCredits: spendable - options.amountCredits,
      // Which allowance period this drew on, so a refund knows whether that
      // period is still the one in force.
      ...(fromPlan > 0 && account.planPeriodKey
        ? { metadata: { ...options.metadata, planPeriodKey: account.planPeriodKey } }
        : {})
    }),
    select: ledgerSelect
  });
}

export async function commitReservedCredits(entryId: string): Promise<CreditLedgerEntryRecord> {
  return runSerializable((tx) => commitReservedCreditsTx(tx, entryId));
}

/** Transaction-aware form used by the generation-attempt boundary. */
export async function commitReservedCreditsTx(tx: BillingTx, entryId: string): Promise<CreditLedgerEntryRecord> {
    const entry = await tx.creditLedgerEntry.findUnique({
      where: { id: entryId },
      select: ledgerSelect
    });
    if (!entry) {
      throw new Error("Credit reservation not found.");
    }
    if (entry.status === "SETTLED" && entry.entryType === "SPEND") {
      return entry;
    }
    if (entry.status !== "RESERVED" || entry.amountCredits >= 0) {
      throw new Error(`Credit reservation ${entryId} cannot be committed from status ${entry.status}.`);
    }

    // The pools were debited at reserve time; committing only settles the hold.
    const amountCredits = Math.abs(entry.amountCredits);
    const updated = await tx.userCreditAccount.updateMany({
      where: {
        userId: entry.userId,
        reservedCredits: { gte: amountCredits }
      },
      data: {
        reservedCredits: { decrement: amountCredits },
        lifetimeCreditsSpent: { increment: amountCredits }
      }
    });
    if (updated.count !== 1) {
      throw new Error(`Credit reservation ${entryId} is not reflected in the account balance.`);
    }
    const account = await ensureCreditAccountRow(tx, entry.userId);

  return tx.creditLedgerEntry.update({
      where: { id: entry.id },
      data: {
        entryType: "SPEND",
        status: "SETTLED",
        balanceAfterCredits: spendableCredits(account)
      },
      select: ledgerSelect
  });
}

export async function spendCredits(options: LedgerContext & {
  amountCredits: number;
  operation: BillingOperation;
  idempotencyKey: string;
  now?: Date | undefined;
}): Promise<CreditLedgerEntryRecord | null> {
  const reservation = await reserveCredits(options);
  if (!reservation) {
    return null;
  }
  return commitReservedCredits(reservation.id);
}

/**
 * Give a charge back, whether it was still held or already settled.
 *
 * Where the credits land depends on whether the allowance period they came from
 * is still the one in force. If it is, the allowance portion goes back to the
 * allowance; if the period has since rolled over, the whole amount goes to the
 * purchased pool instead — that period's allowance has already been re-granted
 * in full, so topping it up again would hand out more than the plan allows. The
 * user keeps the value either way, in the pool that does not expire.
 */
export async function refundCreditLedgerEntry(
  entryId: string,
  reason: string,
  now: Date = new Date()
): Promise<CreditLedgerEntryRecord | null> {
  return runSerializable((tx) => refundCreditLedgerEntryTx(tx, entryId, reason, now));
}

/**
 * Releases every reservation still RESERVED under an idempotency-key prefix.
 *
 * A holder that reserves first and records the entry id second can crash
 * between the two statements, leaving a RESERVED entry no row points to — and
 * a settle that walks only the recorded ids releases everything except the one
 * the crash orphaned, so those credits stay held forever. When the holder's
 * keys are deterministic (the voice-call holds are
 * `mobile:voice-call:{id}:hold:{n}`), the prefix finds what the pointer lost.
 * Only RESERVED rows are touched, so entries already released or committed to
 * a spend are never disturbed, and re-running is a no-op.
 */
export async function releaseReservationsByKeyPrefix(
  idempotencyKeyPrefix: string,
  reason: string
): Promise<number> {
  const open = await prisma.creditLedgerEntry.findMany({
    where: { idempotencyKey: { startsWith: idempotencyKeyPrefix }, status: "RESERVED" },
    select: { id: true }
  });
  let released = 0;
  for (const entry of open) {
    if (await refundCreditLedgerEntry(entry.id, reason)) {
      released += 1;
    }
  }
  return released;
}

/**
 * The subset of `entryIds` whose charge no longer stands: released
 * reservations and settled spends that a reversal entry paid back. Work
 * charged against these must never be delivered again for free.
 */
export async function refundedLedgerEntryIds(entryIds: string[]): Promise<Set<string>> {
  if (entryIds.length === 0) {
    return new Set();
  }
  const entries = await prisma.creditLedgerEntry.findMany({
    where: { id: { in: entryIds } },
    select: { id: true, status: true, reversedByEntry: { select: { id: true } } }
  });
  return new Set(
    entries.filter((entry) => entry.status === "REFUNDED" || entry.reversedByEntry).map((entry) => entry.id)
  );
}

/** Transaction-aware form used when a failed attempt and its refund settle together. */
export async function refundCreditLedgerEntryTx(
  tx: BillingTx,
  entryId: string,
  reason: string,
  now: Date = new Date()
): Promise<CreditLedgerEntryRecord | null> {
    const entry = await tx.creditLedgerEntry.findUnique({
      where: { id: entryId },
      select: ledgerRefundSelect
    });
    if (!entry || entry.amountCredits >= 0) {
      return null;
    }

    const amountCredits = Math.abs(entry.amountCredits);
    const account = await ensureCreditAccountRow(tx, entry.userId);
    const planPortion = Math.min(amountCredits, Math.abs(entry.planCreditsDelta));
    const entryPeriodKey = planPeriodKeyFromMetadata(entry.metadata);
    const samePeriod =
      planPortion > 0 &&
      entryPeriodKey !== null &&
      entryPeriodKey === account.planPeriodKey &&
      account.planPeriodEnd !== null &&
      account.planPeriodEnd > now;
    const toPlan = samePeriod ? planPortion : 0;
    const toPurchased = amountCredits - toPlan;

    if (entry.status === "RESERVED") {
      const updated = await tx.userCreditAccount.updateMany({
        where: {
          userId: entry.userId,
          reservedCredits: { gte: amountCredits }
        },
        data: {
          planCredits: { increment: toPlan },
          availableCredits: { increment: toPurchased },
          reservedCredits: { decrement: amountCredits }
        }
      });
      if (updated.count !== 1) {
        return null;
      }
      await revokeEntitlementsForLedgerEntryTx(tx, entry.id);
      await releaseUsageForEntryTx(tx, entry);
    return tx.creditLedgerEntry.update({
        where: { id: entry.id },
        data: {
          entryType: "RELEASE",
          status: "REFUNDED",
          // Net effect on the allowance pool once released: nothing, if it went
          // back to the same period it came from.
          planCreditsDelta: toPlan - planPortion,
          description: reason
        },
        select: ledgerSelect
    });
    }

    if (entry.status !== "SETTLED") {
      return null;
    }

    const existingRefund = await tx.creditLedgerEntry.findUnique({
      where: { reversesEntryId: entry.id },
      select: ledgerSelect
    });
    if (existingRefund) {
      return existingRefund;
    }

    await tx.userCreditAccount.update({
      where: { userId: entry.userId },
      data: {
        planCredits: { increment: toPlan },
        availableCredits: { increment: toPurchased },
        lifetimeCreditsSpent: { decrement: amountCredits }
      }
    });
    await revokeEntitlementsForLedgerEntryTx(tx, entry.id);
    await releaseUsageForEntryTx(tx, entry);

  return tx.creditLedgerEntry.create({
      data: {
        userId: entry.userId,
        ...(entry.projectId ? { projectId: entry.projectId } : {}),
        entryType: "REFUND",
        status: "SETTLED",
        operation: entry.operation as BillingOperation,
        amountCredits,
        planCreditsDelta: toPlan,
        balanceAfterCredits: spendableCredits(account, now) + amountCredits,
        idempotencyKey: `refund:${entry.id}`,
        reversesEntryId: entry.id,
        description: reason,
        metadata: jsonInput({ reason, refundedToPlanCredits: toPlan, refundedToPurchasedCredits: toPurchased })
      },
      select: ledgerSelect
  });
}

export async function refundLatestProjectOperationCredits(options: {
  projectId: string;
  operation: BillingOperation;
  reason: string;
}): Promise<CreditLedgerEntryRecord | null> {
  const entry = await prisma.creditLedgerEntry.findFirst({
    where: {
      projectId: options.projectId,
      operation: options.operation,
      amountCredits: { lt: 0 },
      status: { in: ["RESERVED", "SETTLED"] },
      reversedByEntry: null
    },
    orderBy: { createdAt: "desc" },
    select: { id: true }
  });
  if (!entry) {
    return null;
  }
  return refundCreditLedgerEntry(entry.id, options.reason);
}

/**
 * A monthly quota slot is claimed before the charge and released with it. Three
 * illustrated books a month is tight enough that losing one to an infrastructure
 * failure is worth the ten lines it takes to hand it back — and riding the
 * refund funnel means every failure path already covers it.
 */
async function releaseUsageForEntryTx(tx: BillingTx, entry: { userId: string; metadata: unknown }): Promise<void> {
  const periodKey = imageQuotaPeriodKeyFromMetadata(entry.metadata);
  if (periodKey) {
    await releaseIllustratedBookUseTx(tx, entry.userId, periodKey);
  }
}

function spendableCredits(account: PlanAccountRow, now: Date = new Date()): number {
  return account.availableCredits + effectivePlanCredits(account, now);
}

function serializeCreditBalance(account: PlanAccountRow, now: Date): CreditBalance {
  return {
    availableCredits: spendableCredits(account, now),
    purchasedCredits: account.availableCredits,
    planCredits: effectivePlanCredits(account, now),
    planCreditsPerPeriod: account.planCreditsPerPeriod,
    planPeriodEnd: account.planPeriodEnd,
    planPeriodKey: account.planPeriodKey,
    reservedCredits: account.reservedCredits,
    lifetimeCreditsGranted: account.lifetimeCreditsGranted,
    lifetimeCreditsSpent: account.lifetimeCreditsSpent
  };
}
