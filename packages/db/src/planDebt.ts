/**
 * Store-refund debt, and the plan allowance that pays it off.
 *
 * A Google Play refund of credits already spent leaves the purchased pool
 * negative (`googlePlayRefunds.ts`). A reservation is checked against both
 * pools together, so while that debt stands it hides as much of a live
 * allowance — and the allowance is the pool that resets. Nothing used to settle
 * it: the hidden part expired unspent at every boundary, the next grant reset
 * the allowance beside the same debt, and a subscriber whose spent month was
 * refunded paid for every later month while able to spend none of it.
 *
 * A period transition now settles the debt, in this order and each part once:
 *
 *  1. **the outgoing allowance's remainder**, up to the debt. That is exactly
 *     the part the debt kept out of reach, and it would otherwise expire. Without
 *     this step a debt that arrived mid-period is paid twice — once by the
 *     allowance it hid, which expires, and again out of the next grant;
 *  2. **the incoming allowance**, for whatever is still owed. A debt larger
 *     than one allowance is spread over the periods it takes.
 *
 * Each part moves credits from the allowance pool to the purchased pool, so the
 * total does not change: an ADJUSTMENT of amount 0 whose `planCreditsDelta` is
 * the move. It deliberately carries no top-level `expiredPlanPeriodKey`: a later
 * refund of the period that paid it must count that part as used, not expired,
 * or the debt it paid would not come back.
 *
 * A debt that arrives mid-period stays on the purchased pool until the next
 * transition; the live allowance is never cut under the reader. Purchases and
 * welcome credits need nothing here — they are added to the purchased pool,
 * which is the pool the debt is in.
 */
import { activeCreditPricingVersion } from "./creditPricing.ts";
import { type BillingTx, type PlanAccountRow, jsonInput } from "./billingInternals.ts";

/** Where a settled part came from, and the row key that makes it happen once. */
export type PlanDebtSettlementPart = {
  credits: number;
  idempotencyKey: string;
};

export type PlanDebtSettlement = {
  /** Owed when the transition began. */
  debtCredits: number;
  /** Paid by the outgoing allowance's remainder instead of expiring. */
  fromRemainder: PlanDebtSettlementPart;
  /** Paid out of the incoming period's fresh allowance. */
  fromAllowance: PlanDebtSettlementPart;
};

/** What an account owes: a negative purchased pool, left by a store refund of spent credits. */
export function planDebtCredits(account: Pick<PlanAccountRow, "availableCredits">): number {
  return Math.max(0, -account.availableCredits);
}

/**
 * How much of the account's debt the transition onto `periodKey` settles.
 *
 * Both parts are keyed on the incoming period, and the remainder's also on the
 * outgoing one, so a re-run of the same transition — the concurrent-grant race
 * `runSerializable` retries, or a period adopted rather than re-granted — finds
 * its row and settles nothing a second time. `applyPlanPeriodTx` already
 * returns early on a period the account is sitting on; this is the backstop,
 * and it reads rather than relying on the unique index, because a violation
 * inside the caller's transaction would abort the whole balance read.
 */
export async function planDebtSettlementTx(
  tx: BillingTx,
  options: { userId: string; account: PlanAccountRow; periodKey: string; granted: number }
): Promise<PlanDebtSettlement> {
  const base = `plan-debt:${options.userId}:${options.periodKey}`;
  const remainderKey = `${base}:remainder:${options.account.planPeriodKey ?? "none"}`;
  const debtCredits = planDebtCredits(options.account);
  const remainder = Math.max(0, options.account.planCredits);
  const fromRemainder = await unsettled(tx, remainderKey, Math.min(debtCredits, remainder));
  const fromAllowance = await unsettled(tx, base, Math.min(debtCredits - fromRemainder, Math.max(0, options.granted)));
  return {
    debtCredits,
    fromRemainder: { credits: fromRemainder, idempotencyKey: remainderKey },
    fromAllowance: { credits: fromAllowance, idempotencyKey: base }
  };
}

async function unsettled(tx: BillingTx, idempotencyKey: string, credits: number): Promise<number> {
  if (credits <= 0) {
    return 0;
  }
  const settled = await tx.creditLedgerEntry.findUnique({ where: { idempotencyKey }, select: { id: true } });
  return settled ? 0 : credits;
}

/**
 * The ledger row for one settled part. The caller moves the pools; this only
 * records the move, so `SUM("planCreditsDelta")` still reconciles the allowance
 * and the credit log can say why a fresh allowance reads short of its size.
 */
export async function recordPlanDebtSettlementTx(
  tx: BillingTx,
  options: {
    userId: string;
    operation: "PLAN_ALLOWANCE_GRANT" | "SUBSCRIPTION_CREDIT_GRANT";
    source: "remainder" | "allowance";
    part: PlanDebtSettlementPart;
    /** The period whose allowance paid this part. */
    paidFromPlanPeriodKey: string | null;
    debtBeforeCredits: number;
    balanceAfterCredits: number;
  }
): Promise<void> {
  await tx.creditLedgerEntry.create({
    data: {
      userId: options.userId,
      entryType: "ADJUSTMENT",
      status: "SETTLED",
      operation: options.operation,
      amountCredits: 0,
      planCreditsDelta: -options.part.credits,
      balanceAfterCredits: options.balanceAfterCredits,
      idempotencyKey: options.part.idempotencyKey,
      description: "Refunded purchase paid off from monthly credits",
      metadata: jsonInput({
        pricingVersion: activeCreditPricingVersion(),
        // Nested on purpose: a top-level `planPeriodKey` names the period a
        // charge drew on, and `expiredPlanPeriodKey` an allowance that expired.
        planDebtSettlement: {
          source: options.source,
          credits: options.part.credits,
          planPeriodKey: options.paidFromPlanPeriodKey,
          debtBeforeCredits: options.debtBeforeCredits,
          debtAfterCredits: options.debtBeforeCredits - options.part.credits
        }
      })
    },
    select: { id: true }
  });
}
