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
import { type BillingOperation } from "@book-maker/core";
import { prisma } from "./client.ts";
import {
  InsufficientCreditsError,
  type BillingTx,
  type CreditBalance,
  type CreditLedgerEntryRecord,
  type LedgerContext,
  ledgerData,
  ledgerRefundSelect,
  ledgerSelect,
  revokeEntitlementsForLedgerEntryTx,
  runSerializable,
  spendableCredits
} from "./billingInternals.ts";
import {
  type PlanAccountRow,
  effectivePlanCredits,
  ensureCreditAccountRow,
  ensureCurrentPlanPeriod,
  ensureCurrentPlanPeriodTx
} from "./planPeriods.ts";
import { refundPoolSplit, refundSettledCreditLedgerEntryTx, releaseUsageForEntryTx } from "./ledgerReversal.ts";
import { refundableCredits, userStopSettlement } from "./userStopSettlement.ts";

export async function getCreditBalance(userId: string, now: Date = new Date()): Promise<CreditBalance> {
  const account = await ensureCurrentPlanPeriod(userId, now);
  return serializeCreditBalance(account, now);
}

type CreditGrantOptions = LedgerContext & {
  amountCredits: number;
  operation?: BillingOperation | undefined;
  idempotencyKey: string;
};

export async function grantCredits(options: CreditGrantOptions): Promise<CreditLedgerEntryRecord> {
  return runSerializable((tx) => grantCreditsTx(tx, options));
}

export async function grantCreditsTx(tx: BillingTx, options: CreditGrantOptions): Promise<CreditLedgerEntryRecord> {
  if (!Number.isInteger(options.amountCredits) || options.amountCredits <= 0) {
    throw new Error("Credit grants must be positive whole-credit amounts.");
  }

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

    // Anyone about to spend is owed their current period first — this is what
    // settles a pending welcome grant and writes off a lapsed allowance, and
    // it is deliberately on the charging path rather than a cron so no user
    // can be missed.
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
      ...(fromPurchased > 0 ? { availableCredits: { gte: fromPurchased } } : {})
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
 * user keeps the value in the pool that does not expire — unless the reader
 * stopped the work themselves, in which case that share lapses with its period
 * and a charge that kept delivered pages gives back only the rest
 * (`userStopSettlement.ts`).
 *
 * A charge whose paid attempt SUCCEEDED is never reversed whole: that work was
 * delivered (`deliveredAttemptCharge` below), and only an attempt-less path
 * that walked to the wrong charge could ask.
 */
export async function refundCreditLedgerEntry(
  entryId: string,
  reason: string,
  now: Date = new Date()
): Promise<CreditLedgerEntryRecord | null> {
  return runSerializable((tx) => refundCreditLedgerEntryTx(tx, entryId, reason, now));
}

/**
 * Gives back part of a settled charge, for work priced by the page that
 * delivered fewer pages than it billed.
 *
 * The ledger's unit is the whole entry — a full book is charged one package —
 * so a run the reader stopped after some of its pages were written can neither
 * keep the money nor hand back all of it. It is deliberately the *only* partial
 * reversal in the ledger, and its one production caller is the user-stop
 * settlement `refundCreditLedgerEntryTx` routes here, under the stop's own claim
 * key; everything else either delivers what it billed or delivers nothing, and
 * the whole-entry path stays the answer for those. A portion covering the whole
 * charge, or an entry still RESERVED (a hold has no half to release), delegates
 * straight to it, so there is one implementation of a full reversal.
 *
 * The reversal row is cumulative, while `idempotencyKey` identifies this
 * particular partial settlement. Replaying it returns the cumulative row
 * unchanged; a later failure refund tops that row up to the original charge.
 *
 * Entitlements and quota slots are left alone on purpose: an export unlock and a
 * free-tier illustrated-book slot are all-or-nothing grants, so a partial
 * reversal has no share of either to return.
 */
export async function refundCreditLedgerEntryPortion(options: PortionRefund): Promise<CreditLedgerEntryRecord | null> {
  const requested = Math.trunc(options.amountCredits);
  if (!Number.isFinite(requested) || requested <= 0) {
    return null;
  }
  return runSerializable((tx) => refundCreditLedgerEntryPortionTx(tx, options));
}

type PortionRefund = {
  entryId: string;
  amountCredits: number;
  reason: string;
  idempotencyKey: string;
  now?: Date | undefined;
};

async function refundCreditLedgerEntryPortionTx(
  tx: BillingTx,
  options: PortionRefund
): Promise<CreditLedgerEntryRecord | null> {
  const now = options.now ?? new Date();
  const requested = Math.trunc(options.amountCredits);
  if (!Number.isFinite(requested) || requested <= 0) {
    return null;
  }
  const entry = await tx.creditLedgerEntry.findUnique({
    where: { id: options.entryId },
    select: ledgerRefundSelect
  });
  if (!entry || entry.amountCredits >= 0) {
    return null;
  }
  const claimKey = options.idempotencyKey.trim();
  if (!claimKey) {
    throw new Error("Partial credit refunds require a stable idempotency key.");
  }
  const charged = Math.abs(entry.amountCredits);
  if (requested >= charged || entry.status !== "SETTLED") {
    return refundCreditLedgerEntryTx(tx, options.entryId, options.reason, now);
  }
  return refundSettledCreditLedgerEntryTx(tx, entry, {
    requestedCredits: requested,
    reason: options.reason,
    now,
    claimKey
  });
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
    select: {
      id: true,
      status: true,
      amountCredits: true,
      reversedByEntry: { select: { amountCredits: true } }
    }
  });
  return new Set(
    entries
      .filter(
        (entry) =>
          entry.status === "REFUNDED" ||
          (entry.reversedByEntry?.amountCredits ?? 0) >= Math.abs(entry.amountCredits)
      )
      .map((entry) => entry.id)
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

  // Only a release splits the pools here. A settled reversal is cumulative —
  // it has to weigh whatever an earlier partial already gave back — so it reads
  // the account and applies the same rule against its own increment, once.
  if (entry.status === "RESERVED") {
    const account = await ensureCreditAccountRow(tx, entry.userId);
    const planPortion = Math.min(amountCredits, Math.abs(entry.planCreditsDelta));
    // A user stop only ever stamps a settled spend, so a hold always splits
    // the way a failure's refund does.
    const { toPlan, toPurchased } = refundPoolSplit({
      account,
      entryMetadata: entry.metadata,
      planShare: planPortion,
      credits: amountCredits,
      now,
      lapseExpiredPlanShare: false
    });

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
  if (await deliveredAttemptCharge(tx, entry)) {
    console.warn(`Refused to reverse charge ${entry.id}: the attempt that paid it was delivered.`, { reason });
    return null;
  }

  // Whichever path settles a charge the reader stopped — the stop itself, the
  // worker noticing it, the attempt reconciler, a legacy fallback — it is the
  // stop's settlement, under the stop's claim. One that kept delivered work is
  // the partial reversal; the reversal itself refuses to grow past it anyway.
  const stop = userStopSettlement(entry.metadata);
  if (stop && stop.keptCredits > 0) {
    return refundCreditLedgerEntryPortionTx(tx, {
      entryId,
      amountCredits: refundableCredits(entry),
      reason,
      idempotencyKey: stop.claimKey,
      now
    });
  }
  return refundSettledCreditLedgerEntryTx(tx, entry, {
    requestedCredits: amountCredits,
    reason,
    now,
    ...(stop ? { claimKey: stop.claimKey } : {})
  });
}

/**
 * Whether this settled charge paid for a `GenerationAttempt` that SUCCEEDED.
 *
 * A delivered attempt's charge is final. `failGenerationAttemptTx` already
 * refuses a SUCCEEDED attempt, but the attempt-less settlements reach a charge
 * by walking to it — the API's legacy stop (`stopLegacySettlement.ts`), the
 * worker's `refundFailedProjectCredits`, the project-latest fallback below — and
 * a free recompile queued after the book was delivered walked its `planId` to
 * the book's own `FULL_BOOK_GENERATION` charge and gave the whole of it back on
 * a delete (launch review 2026-10-13, B3). The rule lives here so no walk can
 * reach past it. Every attempt-linked charge names its attempt in metadata
 * (`startGenerationAttempt`), and the attempt has to name the charge back.
 * Nothing that legitimately refunds an attempt's charge does so after it
 * SUCCEEDED: a failure or a stop terminalizes it FAILED or CANCELED first, and a
 * delivered shortfall is a partial reversal (`refundCreditLedgerEntryPortion`),
 * which does not come through here.
 */
async function deliveredAttemptCharge(
  tx: BillingTx,
  entry: { id: string; metadata: unknown }
): Promise<boolean> {
  const metadata = entry.metadata;
  const attemptId =
    metadata && typeof metadata === "object" && !Array.isArray(metadata)
      ? (metadata as Record<string, unknown>).generationAttemptId
      : undefined;
  if (typeof attemptId !== "string" || !attemptId) {
    return false;
  }
  const attempt = await tx.generationAttempt.findUnique({
    where: { id: attemptId },
    select: { status: true, ledgerEntryId: true }
  });
  return attempt?.status === "SUCCEEDED" && attempt.ledgerEntryId === entry.id;
}

/**
 * How many charges one round trip of the scan below weighs. The newest charge is
 * the answer in every ordinary case — a failure settles the spend it just made — but
 * a heavily edited book holds hundreds of `PAGE_REGENERATION` spends, and
 * loading all of them plus a reversal per row to look at the first one is what
 * this bounds.
 */
const PROJECT_REFUND_SCAN_PAGE = 25;

/**
 * Refunds the newest charge for this project and operation that still stands.
 *
 * "Still stands" is not "has no reversal row". A charge partly given back by
 * `refundCreditLedgerEntryPortion` keeps one cumulative reversal whose amount is
 * under the charge, and topping that row up by the unpaid remainder is exactly
 * what a failure reaching this path is here to do — so eligibility compares
 * `reversedByEntry.amountCredits` against the charge rather than testing the
 * relation for null. That comparison spans two rows of the same table, which is
 * something Prisma has no `where` for, so it is decided here. And it compares
 * against what the charge may still give back (`refundableCredits`), not its
 * whole amount: a charge a user stop settled to what it delivered no longer
 * stands, and topping it up is the one thing this path must not do to it. A
 * charge whose attempt SUCCEEDED still stands but is refused by the reversal
 * itself, so the scan stops there and refunds nothing older either: every
 * caller is an attempt-less fallback, and a delivered run is not its to settle.
 *
 * It is decided over a bounded window rather than the whole history: pages of
 * `PROJECT_REFUND_SCAN_PAGE`, newest first, stopping at the first eligible
 * charge. A project whose every charge is already fully reversed still gets the
 * right answer — `null` — it just pays one round trip per page to learn it,
 * instead of holding the entire history in memory to reach the same conclusion.
 */
export async function refundLatestProjectOperationCredits(options: {
  projectId: string;
  operation: BillingOperation;
  reason: string;
}): Promise<CreditLedgerEntryRecord | null> {
  let cursorId: string | null = null;
  for (;;) {
    // Annotated rather than spread inline: inferring these from `cursorId`,
    // which is assigned out of the rows this call returns, is a circular
    // reference TS refuses (TS7022).
    const pageCursor: { cursor?: { id: string }; skip?: number } = cursorId
      ? { cursor: { id: cursorId }, skip: 1 }
      : {};
    const entries = await prisma.creditLedgerEntry.findMany({
      where: {
        projectId: options.projectId,
        operation: options.operation,
        amountCredits: { lt: 0 },
        status: { in: ["RESERVED", "SETTLED"] }
      },
      // `id` only breaks ties: `createdAt` defaults to the transaction clock, so
      // two charges written together carry the same stamp, and a cursor over a
      // non-total order can step past a row or hand one back twice.
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: PROJECT_REFUND_SCAN_PAGE,
      ...pageCursor,
      select: {
        id: true,
        status: true,
        amountCredits: true,
        metadata: true,
        reversedByEntry: { select: { amountCredits: true } }
      }
    });
    const entry = entries.find(
      (candidate) =>
        candidate.status === "RESERVED" ||
        (candidate.reversedByEntry?.amountCredits ?? 0) < refundableCredits(candidate)
    );
    if (entry) {
      return refundCreditLedgerEntry(entry.id, options.reason);
    }
    const oldest = entries.at(-1);
    if (!oldest || entries.length < PROJECT_REFUND_SCAN_PAGE) {
      return null;
    }
    cursorId = oldest.id;
  }
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
