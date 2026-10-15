import { type MobileBillingDto } from "./dto.js";
import { googlePlayAccountId } from "../googlePlayAccount.js";
import {
  DEFAULT_BILLING_PRODUCTS,
  SUBSCRIPTION_INTRO_OFFERS,
  billingProductOfferedTo,
  creditPricing,
  isUltraTierEnabled,
  maxGeneratedBookPages,
  monthlyPlanCredits
} from "@book-maker/core";
import {
  describePendingWelcomeGrant,
  getCreditBalance,
  getWelcomeCreditsGranted,
  isWelcomeCreditGrantPending,
  getMessageAllowance,
  getImageQuota,
  getPlanSummary,
  listActiveUserEntitlements
} from "@book-maker/db/billing";
import { spendBreaker } from "../spendBreaker.js";

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
  // the app is enough to settle a pending welcome grant — unless the AI spend
  // breaker is holding it, which is why its view of today is brought up to
  // date first (it is read at most once a minute).
  await spendBreaker.globalView();
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
  const [welcomeCredits, welcomeCreditsPending] = await Promise.all([
    getWelcomeCreditsGranted(userId),
    isWelcomeCreditGrantPending(userId)
  ]);
  // Only a pending grant has a reason, so only it pays for the second read.
  const pendingWelcome = welcomeCreditsPending ? ((await describePendingWelcomeGrant(userId)) ?? null) : null;
  return {
    purchaseAccountId: googlePlayAccountId(userId),
    welcomeCreditsPending,
    welcomeCreditsPendingReason: pendingWelcome?.reason ?? null,
    welcomeCreditsPendingCredits: pendingWelcome?.credits ?? null,
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
      purchaseTokenHash: plan.purchaseTokenHash ?? null,
      ...(plan.pendingChange
        ? { pendingChange: { productSku: plan.pendingChange.productSku, startsAt: plan.pendingChange.startsAt?.toISOString() ?? null } }
        : {})
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
    // Two operator switches the app draws pickers from (`bookPageLimit.ts`,
    // `ultraTier.ts`), read off the same snapshot as everything else here.
    paidMaxBookPages: maxGeneratedBookPages(pricing),
    ultraTierEnabled: isUltraTierEnabled(pricing),
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
      monthlyCreditAmount: monthlyPlanCredits(product),
      priceMicros: product.priceMicros,
      currency: product.currency,
      billingPeriod: product.billingPeriod,
      offered: billingProductOfferedTo(product.sku, plan.tier),
      ...introOfferFields(product.sku)
    }))
  };
}

/** The offer the app buys a plan through, and what its discounted period grants. */
function introOfferFields(sku: string): { introOfferId: string | null; introOfferCredits: number | null } {
  const offer = SUBSCRIPTION_INTRO_OFFERS.find((entry) => entry.sku === sku);
  return { introOfferId: offer?.offerId ?? null, introOfferCredits: offer?.creditAmount ?? null };
}
