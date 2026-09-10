import type { PlanTier } from "./billing.js";
import { creditPricing, type CreditPricing } from "./creditPricing.js";

const PLAN_SUFFIX = { free: "Free", creator: "Creator", pro: "Pro", max: "Max" } as const;

/** Zero daily limit disables chat for this plan; zero price makes the action free. */
export function messagePolicy(tier: PlanTier, pricing: CreditPricing = creditPricing()) {
  const suffix = PLAN_SUFFIX[tier];
  return {
    creditsPerMessage: pricing[`messageCredits${suffix}`],
    dailyLimit: pricing[`messageDailyLimit${suffix}`],
    resetCredits: pricing[`messageResetCredits${suffix}`],
    resetEnabled: pricing[`messageResetEnabled${suffix}`] === 1,
    messagePricingKey: `messageCredits${suffix}` as const,
    resetPricingKey: `messageResetCredits${suffix}` as const
  };
}
