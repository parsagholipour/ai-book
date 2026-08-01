import { type MobileBillingDto } from "./dto.js";
import { DEFAULT_BILLING_PRODUCTS, creditPricing } from "@book-maker/core";
import {
  getCreditBalance,
  getImageQuota,
  getPlanSummary,
  listActiveUserEntitlements
} from "@book-maker/db/billing";

/**
 * The billing payload the Flutter app reads: what the reader can spend, which
 * plan they are on, and what the plan's monthly limits leave them.
 *
 * Split out from `projectSerializers.ts` because none of it is about a project.
 * Like those, it is the API contract — widen it deliberately.
 */

export async function serializeMobileBilling(userId: string): Promise<MobileBillingDto> {
  // `getCreditBalance` rolls the plan period forward first, so simply opening
  // the app is enough to be granted the month's allowance.
  const [balance, entitlements, plan, imageQuota] = await Promise.all([
    getCreditBalance(userId),
    listActiveUserEntitlements(userId),
    getPlanSummary(userId),
    getImageQuota(userId)
  ]);
  return {
    credits: {
      available: balance.availableCredits,
      purchased: balance.purchasedCredits,
      reserved: balance.reservedCredits,
      lifetimeGranted: balance.lifetimeCreditsGranted,
      lifetimeSpent: balance.lifetimeCreditsSpent
    },
    plan: {
      tier: plan.tier,
      source: plan.source,
      status: plan.status,
      renewsAt: plan.renewsAt?.toISOString() ?? null,
      productSku: plan.productSku
    },
    allowance: {
      monthlyCredits: balance.planCreditsPerPeriod,
      planCredits: balance.planCredits,
      resetsAt: balance.planPeriodEnd?.toISOString() ?? null
    },
    imageQuota: imageQuota
      ? {
          used: imageQuota.used,
          limit: imageQuota.limit,
          resetsAt: imageQuota.resetsAt.toISOString()
        }
      : null,
    entitlements: entitlements.map((entitlement) => ({
      id: entitlement.id,
      type: entitlement.type,
      projectId: entitlement.projectId,
      status: entitlement.status,
      source: entitlement.source,
      creditsCost: entitlement.creditsCost,
      startsAt: entitlement.startsAt.toISOString(),
      expiresAt: entitlement.expiresAt?.toISOString() ?? null
    })),
    // The live prices, so an operator's change reaches the app without a client
    // release. The Flutter side reads this map with per-key fallbacks.
    creditCosts: creditPricing(),
    products: DEFAULT_BILLING_PRODUCTS.map((product) => ({
      sku: product.sku,
      title: product.title,
      description: product.description,
      productType: product.productType,
      creditAmount: product.creditAmount,
      priceMicros: product.priceMicros,
      currency: product.currency
    }))
  };
}
