import { randomUUID } from "node:crypto";
import { activeCreditPricingVersion } from "./creditPricing.ts";
import { accountSelect, jsonInput, type BillingTx, type PlanAccountRow } from "./billingInternals.ts";

/** Retire only unused legacy free-month credits; welcome, purchases and paid periods stay intact. */
export async function retireFreePlanCreditsTx(tx: BillingTx, account: PlanAccountRow): Promise<PlanAccountRow> {
  if (!account.planPeriodKey?.startsWith("free:") || (account.planCredits === 0 && account.planCreditsPerPeriod === 0)) {
    return account;
  }
  const removed = Math.max(0, account.planCredits);
  const updated = await tx.userCreditAccount.update({
    where: { userId: account.userId },
    data: { planCredits: 0, planCreditsPerPeriod: 0 },
    select: accountSelect
  });
  if (removed > 0) {
    // The caller's serializable transaction owns the balance read and write.
    // A later refund into the same legacy period is a separate retirement.
    await tx.creditLedgerEntry.create({
      data: {
        userId: account.userId,
        entryType: "ADJUSTMENT",
        status: "SETTLED",
        operation: "PLAN_ALLOWANCE_GRANT",
        amountCredits: -removed,
        planCreditsDelta: -removed,
        balanceAfterCredits: account.availableCredits,
        idempotencyKey: `free-allowance-disabled:${account.userId}:${randomUUID()}`,
        description: "Free monthly allowance discontinued",
        metadata: jsonInput({ pricingVersion: activeCreditPricingVersion(), expiredPlanPeriodKey: account.planPeriodKey })
      }
    });
  }
  return updated;
}
