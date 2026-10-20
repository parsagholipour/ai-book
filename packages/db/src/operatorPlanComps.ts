/**
 * A paid plan an operator gives away: a plan entitlement with no store order
 * behind it, whose monthly allowance `ensureOperatorCompMonthTx`
 * (`planPeriods.ts`) grants a month at a time from the day it was given.
 *
 * Everything that asks "which plan is this reader on" reads the entitlement,
 * so a comp unlocks exactly what the plan does. Nothing that ends a store plan
 * can end it: every store path expires entitlements by their purchase record,
 * and a comp has none. Only `revokeOperatorPlanComp` takes it away. The
 * dashboard's subscriber and churn figures count `google_play_subscription`
 * entitlements alone, so a comp is not revenue there either.
 *
 * Run from `scripts/comp-plan.ts`.
 */
import { PLAN_ENTITLEMENT_TYPES, PLAN_ENTITLEMENT_TYPE_BY_TIER, type PlanTier } from "@book-maker/core";
import { type BillingTx, type PlanAccountRow, activeEntitlementWhere, jsonInput, runSerializable } from "./billingInternals.ts";
import {
  OPERATOR_COMP_SOURCE,
  ensureCreditAccountRow,
  ensureCurrentPlanPeriodTx,
  ensureOperatorCompMonthTx
} from "./planPeriods.ts";

export type OperatorCompTier = Exclude<PlanTier, "free">;

/** A comp the account cannot take: it already pays for a plan. */
export class OperatorPlanCompError extends Error {
  override name = "OperatorPlanCompError";
}

export type OperatorPlanCompGrant = {
  entitlementId: string;
  /** False when the same tier was already comped and only its month was checked. */
  created: boolean;
  account: PlanAccountRow;
};

/**
 * Comp `tier` to a reader, and grant the month it starts in.
 *
 * Re-running it for the tier already comped changes nothing. A different tier
 * replaces the comp, and its months count from now. A reader holding a store
 * plan is refused, because that plan's own grants own the allowance.
 */
export async function grantOperatorPlanComp(options: {
  userId: string;
  tier: OperatorCompTier;
  note?: string | undefined;
  now?: Date | undefined;
}): Promise<OperatorPlanCompGrant> {
  const now = options.now ?? new Date();
  const type = PLAN_ENTITLEMENT_TYPE_BY_TIER[options.tier];
  return runSerializable(async (tx) => {
    const held = await tx.userEntitlement.findMany({
      where: { ...activeEntitlementWhere(options.userId, now), type: { in: PLAN_ENTITLEMENT_TYPES } },
      select: { id: true, type: true, source: true }
    });
    const store = held.find((plan) => plan.source !== OPERATOR_COMP_SOURCE);
    if (store) {
      throw new OperatorPlanCompError(`The account already holds ${store.type} from ${store.source}.`);
    }

    // Settle the account as any request would before it changes plan: a
    // pending welcome grant, a legacy free allowance, this month's free period.
    let account = await ensureCurrentPlanPeriodTx(tx, options.userId, now);

    let entitlementId = held.find((plan) => plan.type === type)?.id ?? null;
    const created = entitlementId === null;
    if (created) {
      await expireCompsTx(tx, options.userId, now);
      const entitlement = await tx.userEntitlement.create({
        data: {
          userId: options.userId,
          type,
          source: OPERATOR_COMP_SOURCE,
          startsAt: now,
          expiresAt: null,
          metadata: jsonInput({ grantedAt: now.toISOString(), ...(options.note ? { note: options.note } : {}) })
        },
        select: { id: true }
      });
      entitlementId = entitlement.id;
    }
    account = await ensureOperatorCompMonthTx(tx, options.userId, account, now);
    return { entitlementId: entitlementId as string, created, account };
  });
}

/**
 * Take a comp back. The reader lands on the free tier at once, and what is
 * left of the comp's month expires as any lapsed allowance does; purchased and
 * welcome credits are untouched.
 */
export async function revokeOperatorPlanComp(options: {
  userId: string;
  now?: Date | undefined;
}): Promise<{ revoked: number; account: PlanAccountRow }> {
  const now = options.now ?? new Date();
  return runSerializable(async (tx) => {
    const revoked = await expireCompsTx(tx, options.userId, now);
    if (revoked.length > 0) {
      const account = await ensureCreditAccountRow(tx, options.userId);
      const onComp = revoked.some((id) => account.planPeriodKey?.startsWith(`comp:${id}:`));
      if (onComp && account.planPeriodEnd && account.planPeriodEnd > now) {
        // Cut the month short, keeping its key so the write that retires it is
        // keyed on this month and no other.
        await tx.userCreditAccount.update({ where: { userId: options.userId }, data: { planPeriodEnd: now } });
      }
    }
    const account = await ensureCurrentPlanPeriodTx(tx, options.userId, now);
    return { revoked: revoked.length, account };
  });
}

async function expireCompsTx(tx: BillingTx, userId: string, now: Date): Promise<string[]> {
  const comps = await tx.userEntitlement.findMany({
    where: { userId, status: "ACTIVE", source: OPERATOR_COMP_SOURCE, type: { in: PLAN_ENTITLEMENT_TYPES } },
    select: { id: true }
  });
  if (comps.length > 0) {
    await tx.userEntitlement.updateMany({
      where: { userId, status: "ACTIVE", source: OPERATOR_COMP_SOURCE, type: { in: PLAN_ENTITLEMENT_TYPES } },
      data: { status: "EXPIRED", expiresAt: now }
    });
  }
  return comps.map((comp) => comp.id);
}
