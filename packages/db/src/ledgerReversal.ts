/**
 * A settled charge's one cumulative reversal: how much comes back, to which
 * pool, and the trail of settlements that grew it. `billingLedger.ts` owns the
 * entry points (`refundCreditLedgerEntryTx`, `refundCreditLedgerEntryPortion`);
 * this module is what they share once a charge has settled, split out of that
 * file when the user-stop rules below pushed it past its size budget.
 *
 * Two rules arrive with a user stop's stamp (`userStopSettlement.ts`) and are
 * applied here, so no refund path can skip them: the reversal never grows past
 * what the stop left refundable, and a plan share whose period has ended lapses
 * instead of landing in the purchased pool.
 */
import { jsonRecord, type BillingOperation } from "@book-maker/core";
import {
  type BillingTx,
  type CreditLedgerEntryRecord,
  jsonInput,
  ledgerData,
  ledgerRefundSelect,
  ledgerSelect,
  planPeriodKeyFromMetadata,
  imageQuotaPeriodKeyFromMetadata,
  revokeEntitlementsForLedgerEntryTx,
  spendableCredits
} from "./billingInternals.ts";
import { type PlanAccountRow, ensureCreditAccountRow, releaseIllustratedBookUseTx } from "./planPeriods.ts";
import { refundableCredits, userStopSettlement } from "./userStopSettlement.ts";

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
  /** The part of `credits` that expired with its ended allowance period instead of landing. */
  lapsedPlanCredits?: number;
};

function refundSettlements(metadata: unknown): RefundSettlement[] {
  const value = jsonRecord(metadata).refundSettlements;
  if (!Array.isArray(value)) {
    return [];
  }
  return value.flatMap((item): RefundSettlement[] => {
    const record = jsonRecord(item);
    const { credits, reason, at, balanceAfterCredits, claimKey, lapsedPlanCredits } = record;
    if (typeof credits !== "number" || typeof reason !== "string" || typeof at !== "string") {
      return [];
    }
    return [
      {
        credits,
        reason,
        at,
        ...(typeof balanceAfterCredits === "number" ? { balanceAfterCredits } : {}),
        ...(typeof claimKey === "string" && claimKey.length > 0 ? { claimKey } : {}),
        ...(typeof lapsedPlanCredits === "number" && lapsedPlanCredits > 0 ? { lapsedPlanCredits } : {})
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
 * so topping it up again would hand out more than the plan allows.
 *
 * What happens to it then depends on who asked. A failure the reader did not
 * cause — a provider outage, a crash, a lost delivery — lands it in the
 * purchased pool, which never expires: the reader keeps the value. A refund the
 * reader *chose* (`lapseExpiredPlanShare`, a user stop or delete) lets it lapse
 * with the period it came from, exactly as it would have had it never been
 * spent; otherwise starting books before a reset and deleting them after turned
 * a whole month's expiring allowance into permanent credits.
 *
 * The two callers differ only in what they can hand back at this moment: a
 * release returns the whole hold, a settled reversal returns the increment this
 * settlement adds. The period rule itself lives here once, or the two would
 * drift apart.
 */
export function refundPoolSplit(options: {
  account: Pick<PlanAccountRow, "planPeriodKey" | "planPeriodEnd">;
  entryMetadata: unknown;
  planShare: number;
  credits: number;
  now: Date;
  lapseExpiredPlanShare: boolean;
}): { toPlan: number; toPurchased: number; lapsed: number } {
  const entryPeriodKey = planPeriodKeyFromMetadata(options.entryMetadata);
  const samePeriod =
    options.planShare > 0 &&
    entryPeriodKey !== null &&
    entryPeriodKey === options.account.planPeriodKey &&
    options.account.planPeriodEnd !== null &&
    options.account.planPeriodEnd > options.now;
  const toPlan = samePeriod ? options.planShare : 0;
  const lapsed = !samePeriod && options.lapseExpiredPlanShare ? Math.max(0, options.planShare) : 0;
  return { toPlan, toPurchased: options.credits - toPlan - lapsed, lapsed };
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
 *
 * A user stop's stamp bounds the whole thing: "the unpaid remainder" is never
 * more than `refundableCredits`, so no top-up — whatever path asks — turns a
 * stop that kept delivered pages into a whole refund. A lapsed plan share still
 * counts as reversed (the charge is settled, and the quota slot it carried is
 * released once nothing is kept), and is written down as its own expiry row so
 * the reader's log adds up and a later store refund of that period counts it as
 * allowance that expired rather than value the reader kept.
 */
export async function refundSettledCreditLedgerEntryTx(
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
  const userStopped = userStopSettlement(entry.metadata) !== null;
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
  const remaining = Math.max(0, refundableCredits(entry) - refundedBefore);
  const increment = Math.min(Math.max(Math.trunc(options.requestedCredits), 0), remaining);
  if (increment <= 0) {
    return existingRefund;
  }

  const account = await ensureCreditAccountRow(tx, entry.userId);
  const chargedFromPlan = Math.min(charged, Math.abs(entry.planCreditsDelta));
  const chargedFromPurchased = charged - chargedFromPlan;
  // Which part of the total returned so far came out of the allowance. A
  // failure's refund consumes the source allowance share first, independent of
  // where an earlier refund landed: after a period rollover that share
  // correctly lands in purchased credits instead. A user stop returns the
  // charge's *tail*: what it kept consumed the charge the way spending does,
  // allowance first, so what comes back is the purchased share first — the
  // reader ends where a run priced at the kept amount would have left them,
  // and an ended allowance never lapses while purchased credits pay for pages.
  const planShareOf = (refunded: number) =>
    userStopped ? Math.max(0, refunded - chargedFromPurchased) : Math.min(refunded, chargedFromPlan);
  const sourcePlanIncrement = planShareOf(refundedBefore + increment) - planShareOf(refundedBefore);
  const { toPlan, toPurchased, lapsed } = refundPoolSplit({
    account,
    entryMetadata: entry.metadata,
    planShare: sourcePlanIncrement,
    credits: increment,
    now: options.now,
    lapseExpiredPlanShare: userStopped
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
  // A lapsed share went back to its own period's allowance and expired with
  // it, which is why it is counted here and taken out again by the expiry row
  // below: `SUM("planCreditsDelta")` keeps reconciling against the pool.
  const refundedToPlanCredits = (existingRefund?.planCreditsDelta ?? 0) + toPlan + lapsed;
  const lapsedPlanCredits = (typeof existingMetadata.lapsedPlanCredits === "number"
    ? existingMetadata.lapsedPlanCredits
    : 0) + lapsed;
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
      ...(options.claimKey ? { claimKey: options.claimKey } : {}),
      ...(lapsed > 0 ? { lapsedPlanCredits: lapsed } : {})
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
    ...(lapsedPlanCredits > 0 ? { lapsedPlanCredits } : {}),
    refundSettlements: settlements,
    ...(nextClaimKeys.length > 0 ? { refundClaimKeys: nextClaimKeys } : {})
  });

  // Entitlements and quota claims are indivisible. A partial reversal leaves
  // them in place; the top-up that reaches the whole charge revokes/releases
  // them exactly once, in this same transaction. A user stop that kept
  // delivered work never reaches the whole charge, so it keeps both.
  if (refundedTotal === charged) {
    await revokeEntitlementsForLedgerEntryTx(tx, entry.id);
    await releaseUsageForEntryTx(tx, entry);
  }

  const reversal = existingRefund
    ? await tx.creditLedgerEntry.update({
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
      })
    : await tx.creditLedgerEntry.create({
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

  if (lapsed > 0) {
    // The same shape a period boundary gives the allowance it expires
    // (`applyPlanPeriodTx`): an ADJUSTMENT whose `expiredPlanPeriodKey` is the
    // period the share came from, which `googlePlayRefunds.ts` reads to tell
    // expired allowance from value the reader kept. One per settlement. Its
    // operation is the allowance's, never the charge's: a negative SETTLED row
    // under the charge's operation and project is exactly what
    // `refundLatestProjectOperationCredits` scans for, and it would "refund"
    // the lapse straight into the purchased pool.
    await tx.creditLedgerEntry.create({
      data: ledgerData({
        userId: entry.userId,
        ...(entry.projectId ? { projectId: entry.projectId } : {}),
        entryType: "ADJUSTMENT",
        status: "SETTLED",
        operation: "PLAN_ALLOWANCE_GRANT",
        amountCredits: -lapsed,
        planCreditsDelta: -lapsed,
        balanceAfterCredits: balanceAfterCredits - lapsed,
        idempotencyKey: `refund:${entry.id}:lapsed:${settlements.length}`,
        description: "Refunded monthly credits expired with their period",
        metadata: {
          expiredPlanPeriodKey: planPeriodKeyFromMetadata(entry.metadata),
          lapsedRefundOfEntryId: entry.id
        }
      }),
      select: { id: true }
    });
  }
  return reversal;
}

/**
 * A monthly quota slot is claimed before the charge and released with it. Three
 * illustrated books a month is tight enough that losing one to an infrastructure
 * failure is worth the ten lines it takes to hand it back — and riding the
 * refund funnel means every failure path already covers it.
 */
export async function releaseUsageForEntryTx(
  tx: BillingTx,
  entry: { userId: string; metadata: unknown }
): Promise<void> {
  const periodKey = imageQuotaPeriodKeyFromMetadata(entry.metadata);
  if (periodKey) {
    await releaseIllustratedBookUseTx(tx, entry.userId, periodKey);
  }
}
