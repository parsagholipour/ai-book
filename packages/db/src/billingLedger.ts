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
import { jsonRecord, type BillingOperation } from "@book-maker/core";
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

const reversalRefundSelect = {
  ...ledgerRefundSelect,
  description: true,
  balanceAfterCredits: true,
  createdAt: true
} as const;

function refundClaimKeys(metadata: unknown): string[] {
  const value = jsonRecord(metadata).refundClaimKeys;
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string" && entry.length > 0)
    : [];
}

/**
 * One settlement that grew the cumulative reversal, oldest first.
 *
 * A charge has exactly one reversal row — `reversesEntryId` is unique and every
 * reader of `reversedByEntry` treats it as a single row — so a partial
 * settlement and the top-up that completes it share one row's columns. Those
 * columns can only describe one moment: `balanceAfterCredits` is the spendable
 * balance right after the write that *created* the row, and rewriting it on a
 * top-up made it name a moment nothing records (`updatedAt` is selected
 * nowhere), while the reason the first settlement gave was overwritten
 * outright. The row therefore keeps the stamp it was born with, and this trail
 * carries what one row cannot: each settlement's own amount, resulting balance,
 * reason and time. The row's `description` is the trail's reasons in order, so
 * the operator dashboard — the only surface that shows it — still reads why
 * every part of the charge came back.
 */
type RefundSettlement = {
  credits: number;
  reason: string;
  at: string;
  balanceAfterCredits?: number;
  claimKey?: string;
};

function refundSettlements(metadata: unknown): RefundSettlement[] {
  const value = jsonRecord(metadata).refundSettlements;
  if (!Array.isArray(value)) {
    return [];
  }
  return value.flatMap((item): RefundSettlement[] => {
    const record = jsonRecord(item);
    const { credits, reason, at, balanceAfterCredits, claimKey } = record;
    if (typeof credits !== "number" || typeof reason !== "string" || typeof at !== "string") {
      return [];
    }
    return [
      {
        credits,
        reason,
        at,
        ...(typeof balanceAfterCredits === "number" ? { balanceAfterCredits } : {}),
        ...(typeof claimKey === "string" && claimKey.length > 0 ? { claimKey } : {})
      }
    ];
  });
}

/**
 * The settlements already on a reversal row, reconstructing the one a row
 * written before this trail existed can only describe through its own columns.
 * Without that reconstruction the first deployed top-up would still lose the
 * partial settlement's reason and balance — the very rows this is here for.
 */
function recordedRefundSettlements(
  refund: {
    metadata: unknown;
    description: string | null;
    balanceAfterCredits: number | null;
    createdAt: Date;
  },
  refundedBefore: number
): RefundSettlement[] {
  const stored = refundSettlements(refund.metadata);
  if (stored.length > 0) {
    return stored;
  }
  return [
    {
      credits: refundedBefore,
      reason: refund.description ?? "",
      at: refund.createdAt.toISOString(),
      ...(refund.balanceAfterCredits !== null ? { balanceAfterCredits: refund.balanceAfterCredits } : {})
    }
  ];
}

/** Every distinct reason the trail holds, in order, as the row's description. */
function joinedRefundReasons(settlements: RefundSettlement[]): string {
  const seen = new Set<string>();
  for (const settlement of settlements) {
    const reason = settlement.reason.trim();
    if (reason) {
      seen.add(reason);
    }
  }
  return [...seen].join("; ");
}

/**
 * How much of a reversal goes back to each pool.
 *
 * `planShare` is the part of it that was spent out of the allowance, and it
 * only returns there while the period it was spent from is still the live one:
 * after a rollover that period's allowance has already been re-granted in full,
 * so topping it up again would hand out more than the plan allows. Whatever is
 * left lands in the purchased pool, which never expires — the user keeps the
 * value either way.
 *
 * The two callers differ only in what they can hand back at this moment: a
 * release returns the whole hold, a settled reversal returns the increment this
 * settlement adds. The period rule itself lives here once, or the two would
 * drift apart.
 */
function refundPoolSplit(options: {
  account: Pick<PlanAccountRow, "planPeriodKey" | "planPeriodEnd">;
  entryMetadata: unknown;
  planShare: number;
  credits: number;
  now: Date;
}): { toPlan: number; toPurchased: number } {
  const entryPeriodKey = planPeriodKeyFromMetadata(options.entryMetadata);
  const samePeriod =
    options.planShare > 0 &&
    entryPeriodKey !== null &&
    entryPeriodKey === options.account.planPeriodKey &&
    options.account.planPeriodEnd !== null &&
    options.account.planPeriodEnd > options.now;
  const toPlan = samePeriod ? options.planShare : 0;
  return { toPlan, toPurchased: options.credits - toPlan };
}

/**
 * Add up to `requestedCredits` to a settled charge's one reversal row.
 *
 * The row is cumulative: its amount is the authoritative total returned so
 * far. Partial callers also supply a stable claim key, stored in metadata, so
 * replaying one settlement is a no-op while a later full failure can still add
 * exactly the unpaid remainder. Keeping one linked reversal preserves every
 * deployed reader of `reversedByEntry`; those readers must compare its amount,
 * not treat its presence as a whole-charge boolean.
 *
 * Only the amount is cumulative. `balanceAfterCredits` is written once, when
 * the row is created, and a top-up leaves it alone: it is a point-in-time stamp
 * and the row has only one point in time it can name. The reasons accumulate
 * instead of replacing each other, and `metadata.refundSettlements` keeps the
 * per-settlement amounts, balances and timestamps the single row cannot.
 */
async function refundSettledCreditLedgerEntryTx(
  tx: BillingTx,
  entry: {
    id: string;
    userId: string;
    projectId: string | null;
    operation: string;
    amountCredits: number;
    planCreditsDelta: number;
    metadata: unknown;
  },
  options: {
    requestedCredits: number;
    reason: string;
    now: Date;
    claimKey?: string | undefined;
  }
): Promise<CreditLedgerEntryRecord | null> {
  const charged = Math.abs(entry.amountCredits);
  const existingRefund = await tx.creditLedgerEntry.findUnique({
    where: { reversesEntryId: entry.id },
    select: reversalRefundSelect
  });
  const existingMetadata = jsonRecord(existingRefund?.metadata);
  const existingClaimKeys = refundClaimKeys(existingRefund?.metadata);

  if (options.claimKey && existingClaimKeys.includes(options.claimKey)) {
    return existingRefund;
  }

  // Compatibility for a partial row written before claim keys were recorded:
  // the same amount and reason is the only settlement that old code could have
  // made for this charge. Adopt its key without moving the balance again.
  if (
    options.claimKey &&
    existingRefund &&
    existingClaimKeys.length === 0 &&
    existingMetadata.partialRefund === true &&
    existingRefund.amountCredits === Math.min(options.requestedCredits, charged) &&
    existingRefund.description === options.reason
  ) {
    return tx.creditLedgerEntry.update({
      where: { id: existingRefund.id },
      data: {
        metadata: jsonInput({ ...existingMetadata, refundClaimKeys: [options.claimKey] })
      },
      select: ledgerSelect
    });
  }

  const refundedBefore = Math.min(Math.max(existingRefund?.amountCredits ?? 0, 0), charged);
  const remaining = charged - refundedBefore;
  const increment = Math.min(Math.max(Math.trunc(options.requestedCredits), 0), remaining);
  if (increment <= 0) {
    return existingRefund;
  }

  const account = await ensureCreditAccountRow(tx, entry.userId);
  const chargedFromPlan = Math.min(charged, Math.abs(entry.planCreditsDelta));
  // Refunds consume the source allowance share first. This is independent of
  // where an earlier refund landed: after a period rollover that source share
  // correctly lands in purchased credits instead.
  const sourcePlanRefundedBefore = Math.min(refundedBefore, chargedFromPlan);
  const sourcePlanIncrement = Math.min(increment, chargedFromPlan - sourcePlanRefundedBefore);
  const { toPlan, toPurchased } = refundPoolSplit({
    account,
    entryMetadata: entry.metadata,
    planShare: sourcePlanIncrement,
    credits: increment,
    now: options.now
  });
  // Read off the account before the pools move, so the stamp this settlement
  // records cannot depend on whether `account` is a snapshot or a live row.
  const balanceAfterCredits = spendableCredits(account, options.now) + increment;

  await tx.userCreditAccount.update({
    where: { userId: entry.userId },
    data: {
      planCredits: { increment: toPlan },
      availableCredits: { increment: toPurchased },
      lifetimeCreditsSpent: { decrement: increment }
    }
  });

  const refundedTotal = refundedBefore + increment;
  const refundedToPlanCredits = (existingRefund?.planCreditsDelta ?? 0) + toPlan;
  const nextClaimKeys = options.claimKey
    ? [...new Set([...existingClaimKeys, options.claimKey])]
    : existingClaimKeys;
  const settlements: RefundSettlement[] = [
    ...(existingRefund ? recordedRefundSettlements(existingRefund, refundedBefore) : []),
    {
      credits: increment,
      reason: options.reason,
      at: options.now.toISOString(),
      balanceAfterCredits,
      ...(options.claimKey ? { claimKey: options.claimKey } : {})
    }
  ];
  const description = joinedRefundReasons(settlements);
  const metadata = jsonInput({
    ...existingMetadata,
    // `reason` stays the most recent settlement's; `refundSettlements` is where
    // every settlement's own reason, amount, balance and time survive.
    reason: options.reason,
    partialRefund: refundedTotal < charged,
    chargedCredits: charged,
    refundedToPlanCredits,
    refundedToPurchasedCredits: refundedTotal - refundedToPlanCredits,
    refundSettlements: settlements,
    ...(nextClaimKeys.length > 0 ? { refundClaimKeys: nextClaimKeys } : {})
  });

  // Entitlements and quota claims are indivisible. A partial reversal leaves
  // them in place; the top-up that reaches the whole charge revokes/releases
  // them exactly once, in this same transaction.
  if (refundedTotal === charged) {
    await revokeEntitlementsForLedgerEntryTx(tx, entry.id);
    await releaseUsageForEntryTx(tx, entry);
  }

  if (existingRefund) {
    return tx.creditLedgerEntry.update({
      where: { id: existingRefund.id },
      data: {
        amountCredits: refundedTotal,
        planCreditsDelta: refundedToPlanCredits,
        // `balanceAfterCredits` is deliberately not written here. It stamps the
        // balance at this row's `createdAt`, which a top-up arriving later
        // cannot honestly restate — every settlement's own stamp is in
        // `metadata.refundSettlements` instead.
        description,
        metadata
      },
      select: ledgerSelect
    });
  }

  return tx.creditLedgerEntry.create({
    data: {
      userId: entry.userId,
      ...(entry.projectId ? { projectId: entry.projectId } : {}),
      entryType: "REFUND",
      status: "SETTLED",
      operation: entry.operation as BillingOperation,
      amountCredits: refundedTotal,
      planCreditsDelta: refundedToPlanCredits,
      balanceAfterCredits,
      idempotencyKey: `refund:${entry.id}`,
      reversesEntryId: entry.id,
      description,
      metadata
    },
    select: ledgerSelect
  });
}

/**
 * Gives back part of a settled charge, for work priced by the page that
 * delivered fewer pages than it billed.
 *
 * The ledger's unit is the whole entry — a structural insert is charged
 * `pagesBilled × pageRegenerationPerPage` in a single spend — so an apply that
 * settles having written two of five pages can neither keep the money nor hand
 * back all of it. It is deliberately the *only* partial reversal in the ledger:
 * everything else either delivers what it billed or delivers nothing, and the
 * whole-entry path stays the answer for those. A portion covering the whole
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
export async function refundCreditLedgerEntryPortion(options: {
  entryId: string;
  amountCredits: number;
  reason: string;
  idempotencyKey: string;
  now?: Date | undefined;
}): Promise<CreditLedgerEntryRecord | null> {
  const now = options.now ?? new Date();
  const requested = Math.trunc(options.amountCredits);
  if (!Number.isFinite(requested) || requested <= 0) {
    return null;
  }
  return runSerializable(async (tx) => {
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
    const { toPlan, toPurchased } = refundPoolSplit({
      account,
      entryMetadata: entry.metadata,
      planShare: planPortion,
      credits: amountCredits,
      now
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

  return refundSettledCreditLedgerEntryTx(tx, entry, {
    requestedCredits: amountCredits,
    reason,
    now
  });
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
 * something Prisma has no `where` for, so it is decided here.
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
        reversedByEntry: { select: { amountCredits: true } }
      }
    });
    const entry = entries.find(
      (candidate) =>
        candidate.status === "RESERVED" ||
        (candidate.reversedByEntry?.amountCredits ?? 0) < Math.abs(candidate.amountCredits)
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
