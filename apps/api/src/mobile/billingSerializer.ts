import { type MobileBillingDto } from "./dto.js";
import { googlePlayAccountId } from "../googlePlayAccount.js";
import { DEFAULT_BILLING_PRODUCTS, creditPricing } from "@book-maker/core";
import {
  getCreditBalance,
  getWelcomeCreditsGranted,
  getMessageAllowance,
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

export async function serializeMobileBilling(
  userId: string,
  options: { canCancelInApp: boolean }
): Promise<MobileBillingDto> {
  // `getCreditBalance` rolls the plan period forward first, so simply opening
  // the app is enough to settle a pending welcome grant.
  // Recover expired message holds before reading the balance so a returned
  // slot and its refunded credits are visible in the same billing response.
  const messageAllowance = await getMessageAllowance(userId);
  const [balance, entitlements, plan, imageQuota] = await Promise.all([
    getCreditBalance(userId),
    listActiveUserEntitlements(userId),
    getPlanSummary(userId),
    getImageQuota(userId)
  ]);
  // Read once: an operator edit landing between the plan block and `creditCosts`
  // would otherwise describe the free tier two different ways in one payload.
  const pricing = creditPricing();
  const welcomeCredits = await getWelcomeCreditsGranted(userId);
  return {
    purchaseAccountId: googlePlayAccountId(userId),
    messageAllowance,
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
      cancelAtPeriodEnd: plan.cancelAtPeriodEnd,
      endsAt: plan.endsAt?.toISOString() ?? null,
      // Nothing to cancel on the free tier, whatever this backend can do.
      canCancelInApp: options.canCancelInApp && plan.tier !== "free",
      productSku: plan.productSku,
      purchaseTokenHash: plan.purchaseTokenHash ?? null
    },
    freeTier: {
      monthlyCredits: pricing.freeMonthlyCredits,
      welcomeCredits,
      illustratedBooksPerMonth: pricing.freeIllustratedBooksPerMonth,
      maxBookPages: pricing.freeMaxBookPages
    },
    // `getBookPageLimit`'s answer, read off the tier already resolved above
    // rather than resolving it a second time.
    maxBookPages: plan.tier === "free" ? pricing.freeMaxBookPages : null,
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
    creditCosts: pricing,
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
