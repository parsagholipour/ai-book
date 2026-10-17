import { modelTierForInput } from "./adapters/modelTiers.js";
import { type CreditPricing, creditPricing } from "./creditPricing.js";
import { messagePolicy } from "./messagePricing.js";
import { coverArtSourceFor } from "./generation/coverSource.js";
import { interiorIllustrationLaunchCap, interiorIllustrationSlotCount } from "./generation/illustrationSlots.js";
import { narrationParagraphs } from "./audiobook/narration.js";
import { countReadableWords } from "./generation/proseShape.js";
import { modelTierSchema } from "./schemas/book.js";
import type { CreateProjectInput, ModelTier } from "./schemas/book.js";
import { jsonRecord } from "./schemas/jsonCoercion.js";

/**
 * A notional list rate, **not what a credit earns**: no credit is sold at a
 * cent, and after Google's fee a plan credit earns $0.0021–0.0028 and a pack
 * credit $0.0064–0.0068 (`netUsdPerCredit`), while welcome credits earn
 * nothing. It survives only as the figure quotes record in their assumptions.
 * Nothing that reports revenue or a margin may multiply by it: the dashboard
 * values spend by where its credits came from
 * (`apps/api/src/admin/creditValuation.ts`), and a projection with no ledger
 * behind it — the pricing editor's preview and projected profit among them —
 * uses `CHEAPEST_PAID_CREDIT_USD_VALUE`.
 */
export const CREDIT_USD_VALUE = 0.01;
export const STANDARD_EXPORT_CREDIT_AMOUNT = 1_000;

export const PROVIDER_COST_ASSUMPTIONS_USD = {
  textBase: 0.08,
  textPerPage: 0.018,
  imageGeneration: 0.039,
  coverIncluded: 0.039,
  premiumReview: 0.12,
  exportCompile: 0.03
} as const;

export type ProviderCostAssumptions = { [K in keyof typeof PROVIDER_COST_ASSUMPTIONS_USD]: number };

/**
 * Per-tier provider cost assumptions. Fast books draft on flash-class models;
 * premium books pay for gemini-2.5-pro prose (with best-of candidates and
 * bounded thinking), the 3.1 flash image model, and a pro cover — while the
 * mechanical review/QA phases run on cheap flash models in every tier.
 *
 * **Exhaustive by type.** As a `Partial` record it resolved an unlisted
 * tier to the balanced base table through a `||` fallback, so a fifth
 * `ModelTier` would have been *costed* as balanced while running whatever
 * models it actually routes — nothing fails to compile, no book fails, and the
 * admin margin columns simply report a healthy number for a book that never ran
 * balanced models. `balanced` therefore spells out the base table it used to
 * inherit; a tier nobody costed here is a compile error until somebody does.
 */
const MODEL_TIER_COST_ASSUMPTIONS_USD: Record<ModelTier, ProviderCostAssumptions> = {
  fast: {
    ...PROVIDER_COST_ASSUMPTIONS_USD,
    // `textBase` stays at the base rate: fast always drew one draft of page 1.
    textPerPage: 0.008
  },
  balanced: {
    ...PROVIDER_COST_ASSUMPTIONS_USD,
    // Balanced sampled page 1 twice and judged the pair until 2026-10-16, when
    // best-of drafting was removed on every tier (E4: blind readers preferred
    // the judged pick 5 / 8 / 6 against the single draft); that extra was
    // +$0.0024, inside this table's error bars, so the base was left as it was.
    // Spelled out anyway: balanced is the default tier and what the free tier runs on, so
    // it is the row the margin dashboard reports most often, and a tier that
    // silently inherited the base table is the shape this record was made
    // exhaustive to prevent. On the per-book base for the reason premium's is
    // — measured once per book, whatever the book's length.
    textBase: 0.083
  },
  premium: {
    ...PROVIDER_COST_ASSUMPTIONS_USD,
    // Page 1 was drafted best-of-3 and judged until 2026-10-16 (best-of is
    // removed on every tier; page 1 is drafted once), measured at +$0.048 over
    // the single draft it replaced. The base still carries it, an overestimate
    // left for whoever re-measures. It landed on the per-book base and never on `textPerPage`,
    // because it happens **once per book however long the book is**: the same
    // $0.048 is 12% of an 8-page book's per-page text spend and 0.16% of a
    // 600-page book's, so no per-page adder can be right for both — set to
    // cover the short book and a 600-page book is billed ~33x the real
    // one-off. `textPerPage` is also what the Max-plan break-even floor is
    // tested against (`billing.test.ts`), and that test is per page.
    textBase: 0.14,
    textPerPage: 0.05,
    imageGeneration: 0.067,
    coverIncluded: 0.134,
    premiumReview: 0.05
  },
  ultra: {
    ...PROVIDER_COST_ASSUMPTIONS_USD,
    // Same one-off as premium, priced at ultra's worst realistic shape when
    // page 1 drew three writer-tool candidates plus a judge (+$0.087; removed
    // 2026-10-16, an overestimate now). Per-book for the reason spelled out on premium above.
    textBase: 0.17,
    // Per *page*, and unchanged by the page-1 work: draft ~$0.05 + polish
    // ~$0.05 + judge/tools/extract ~$0.02, on every page, as measured before
    // the page polish and best-of were removed (2026-10-16); an overestimate now. Premium's 0.05 only
    // covers one prose call; ultra adds a second full draft, a judge,
    // writer-tool rounds, and extract/audit per page.
    textPerPage: 0.12,
    imageGeneration: 0.067,
    coverIncluded: 0.134,
    premiumReview: 0.05
  }
};

/**
 * The cost table a book is estimated against.
 *
 * Keyed through {@link modelTierForInput} rather than off the raw field, so a
 * book with no tier recorded costs as balanced by the same rule that prices it
 * as balanced — one answer, not two that happen to agree.
 */
export function providerCostAssumptionsForInput(input: CreateProjectInput): ProviderCostAssumptions {
  return MODEL_TIER_COST_ASSUMPTIONS_USD[modelTierForInput(input)];
}

/**
 * {@link modelTierForInput} for callers holding a raw `mediaSettings` JSON
 * column.
 *
 * Its twin lives in `adapters/modelTiers.ts`, beside the routing the tier field
 * actually drives; this half stays here because parsing an unvalidated column
 * needs zod and that module is kept free of every runtime import. Both answer
 * `balanced` for a book with no tier recorded, for the reason given there.
 */
export function modelTierFromMediaSettings(mediaSettings: unknown): ModelTier {
  const parsed = modelTierSchema.safeParse(jsonRecord(mediaSettings).modelTier);
  return parsed.success ? parsed.data : "balanced";
}

/**
 * The rates that vary by tier, and the only ones.
 *
 * A tier changes which models run, so a price follows it exactly as far as the
 * model spend does: the initial plan and every revision of it, the writing
 * rate, the images, and the per-page rate every post-generation rewrite is
 * billed at. Everything else is flat on purpose — an audiobook and a voice
 * call reach a tier-blind provider, and the `…Base` charges (`fullBookBase`'s siblings
 * `bookTextEditBase`, `bookReplanBase`) are request overhead rather than model
 * spend. A revision runs the planner the first plan ran, so it follows the
 * same ladder: a flat 40 made a Quick Draft revision cost twice the plan it
 * revised.
 *
 * The unsuffixed key is the balanced rate; the others add `Fast` / `Premium` /
 * `Ultra`. Keeping the convention mechanical is what lets one resolver serve
 * every call site, here and in the app's mirror of it.
 */
export const TIER_PRICED_KEYS = [
  "planGeneration",
  "planRevision",
  "fullBookBase",
  "fullBookPerPage",
  "imageGeneration",
  "pageRegenerationPerPage",
  "bookTextEditPerPage"
] as const;

export type TierPricedKey = (typeof TIER_PRICED_KEYS)[number];

export type PlanGenerationPricingKey =
  | "planGeneration"
  | "planGenerationFast"
  | "planGenerationPremium"
  | "planGenerationUltra";

export type PlanGenerationCreditQuote = {
  credits: number;
  modelTier: ModelTier;
  pricingKey: PlanGenerationPricingKey;
};

export type PlanRevisionPricingKey =
  | "planRevision"
  | "planRevisionFast"
  | "planRevisionPremium"
  | "planRevisionUltra";

export type PlanRevisionCreditQuote = {
  credits: number;
  modelTier: ModelTier;
  pricingKey: PlanRevisionPricingKey;
};

/**
 * Which price key a tier reads for one of {@link TIER_PRICED_KEYS}.
 *
 * The single place the suffix convention is written down, so the quote and the
 * dashboard's revenue projection cannot disagree about which key a book drove.
 */
export function tierPriceKey<K extends TierPricedKey>(
  key: K,
  tier: ModelTier
): K | `${K}Fast` | `${K}Premium` | `${K}Ultra` {
  if (tier === "fast") {
    return `${key}Fast`;
  }
  if (tier === "premium") {
    return `${key}Premium`;
  }
  if (tier === "ultra") {
    return `${key}Ultra`;
  }
  return key;
}

/** The tier's rate for one of {@link TIER_PRICED_KEYS}. */
export function tierPrice(pricing: CreditPricing, key: TierPricedKey, tier: ModelTier): number {
  return pricing[tierPriceKey(key, tier)];
}

/**
 * The charge for creating an initial plan.
 *
 * Initial planning follows the selected model tier, and so does every revision
 * of the plan ({@link planRevisionCreditCost}); a book replan keeps its flat
 * base. Returning the resolved key with the amount gives the charge and the
 * ledger audit stamp one indivisible answer.
 */
export function planGenerationCreditCost(
  input: CreateProjectInput,
  pricing: CreditPricing = creditPricing()
): PlanGenerationCreditQuote {
  const modelTier = modelTierForInput(input);
  const pricingKey = tierPriceKey("planGeneration", modelTier);
  // Indexed on the key this quote is about to hand back, rather than through
  // `tierPrice` — which would resolve the same suffix a second time and leave
  // the amount and the audit stamp two answers that merely agree.
  return { credits: pricing[pricingKey], modelTier, pricingKey };
}

/**
 * The charge for revising a plan, at the tier of the book being revised.
 *
 * Takes the book's raw `mediaSettings` because every caller holds a project
 * row rather than a parsed input. The chat quote, the direct route and the
 * charge all read it here, so the price a reader is shown is the one taken.
 */
export function planRevisionCreditCost(
  mediaSettings: unknown,
  pricing: CreditPricing = creditPricing()
): PlanRevisionCreditQuote {
  const modelTier = modelTierFromMediaSettings(mediaSettings);
  const pricingKey = tierPriceKey("planRevision", modelTier);
  return { credits: pricing[pricingKey], modelTier, pricingKey };
}

/**
 * The plan a user is on. Free is the absence of a paid entitlement rather than a
 * product, so it has no SKU; the other three each map to one subscription SKU
 * and one entitlement type.
 */
export type PlanTier = "free" | "creator" | "pro" | "max";

export const PLAN_TIER_ORDER: PlanTier[] = ["free", "creator", "pro", "max"];

/** Subscription SKU → tier. The single place that mapping is written down. */
export const PLAN_TIER_BY_SKU: Record<string, Exclude<PlanTier, "free">> = {
  "tomeza.creator_monthly": "creator",
  "tomeza.creator_yearly": "creator",
  "tomeza.pro_monthly": "pro",
  "tomeza.max_monthly": "max"
};

export const PLAN_ENTITLEMENT_TYPE_BY_TIER = {
  creator: "CREATOR_PLAN",
  pro: "PRO_PLAN",
  max: "MAX_PLAN"
} as const;

export type PlanEntitlementType = (typeof PLAN_ENTITLEMENT_TYPE_BY_TIER)[keyof typeof PLAN_ENTITLEMENT_TYPE_BY_TIER];

export const PLAN_ENTITLEMENT_TYPES: PlanEntitlementType[] = Object.values(PLAN_ENTITLEMENT_TYPE_BY_TIER);

const PLAN_TIER_BY_ENTITLEMENT_TYPE: Record<string, Exclude<PlanTier, "free">> = {
  CREATOR_PLAN: "creator",
  PRO_PLAN: "pro",
  MAX_PLAN: "max"
};

export function planTierForSubscriptionSku(sku: string): Exclude<PlanTier, "free"> | null {
  return PLAN_TIER_BY_SKU[sku] ?? null;
}

export function planEntitlementTypeForSubscriptionSku(sku: string): PlanEntitlementType | null {
  const tier = planTierForSubscriptionSku(sku);
  return tier ? PLAN_ENTITLEMENT_TYPE_BY_TIER[tier] : null;
}

export function planTierForEntitlementType(type: string): PlanTier {
  return PLAN_TIER_BY_ENTITLEMENT_TYPE[type] ?? "free";
}

/** Highest tier wins when a user somehow holds two plan entitlements at once. */
export function highestPlanTier(tiers: readonly PlanTier[]): PlanTier {
  return tiers.reduce<PlanTier>(
    (best, tier) => (PLAN_TIER_ORDER.indexOf(tier) > PLAN_TIER_ORDER.indexOf(best) ? tier : best),
    "free"
  );
}

/**
 * Products the app no longer sells. `ensureDefaultProductCatalog` marks their
 * catalog rows inactive, so a purchase of one is refused at verification and an
 * old app build cannot sell it either.
 *
 * `tomeza.one_book_export` granted the same 1,000 credits as `credit_pack_1`
 * for $9.99 against $7.99 — a worse deal listed first. Every generated book
 * already includes its export, so it bought nothing a pack does not.
 */
export const RETIRED_BILLING_PRODUCT_SKUS = ["tomeza.one_book_export"] as const;

export const DEFAULT_BILLING_PRODUCTS = [
  {
    sku: "tomeza.creator_monthly",
    title: "Creator",
    description: "6,000 credits a month. Illustrated books with no monthly cap (they use credits), and manuscript import.",
    productType: "SUBSCRIPTION",
    creditAmount: STANDARD_EXPORT_CREDIT_AMOUNT * 6,
    priceMicros: 19_990_000,
    currency: "USD",
    billingPeriod: "P1M"
  },
  {
    // A year of Creator, paid once, granted a month at a time: 6,000 credits at
    // the start of each month of the paid year, each month's lapsing at its end
    // exactly as Creator monthly's does (`monthlyPlanCredits`, and the month
    // schedule in packages/db/src/subscriptionAllowance.ts). It used to grant
    // all 72,000 at once, so a reader could spend the year in days and then
    // refund inside Play's window (launch review, 2026-10-15). `creditAmount`
    // stays what one payment buys in all, which is what a credit's value is
    // measured against: $179.99 is 25% under twelve months and still earns
    // $0.002125 a credit after Play's cut — the Max plan's rate, which every
    // per-page price is floored at. Cheaper, and an ultra book bought with
    // these credits would cost more than it brought in.
    sku: "tomeza.creator_yearly",
    title: "Creator yearly",
    description: "6,000 credits every month, billed yearly. Illustrated books with no monthly cap (they use credits), and manuscript import.",
    productType: "SUBSCRIPTION",
    creditAmount: STANDARD_EXPORT_CREDIT_AMOUNT * 72,
    priceMicros: 179_990_000,
    currency: "USD",
    billingPeriod: "P1Y"
  },
  {
    sku: "tomeza.pro_monthly",
    title: "Pro",
    description: "15,000 credits a month for creators shipping a book a week.",
    productType: "SUBSCRIPTION",
    creditAmount: STANDARD_EXPORT_CREDIT_AMOUNT * 15,
    priceMicros: 39_990_000,
    currency: "USD",
    billingPeriod: "P1M"
  },
  {
    sku: "tomeza.max_monthly",
    title: "Max",
    description: "80,000 credits a month for the heaviest writers.",
    productType: "SUBSCRIPTION",
    creditAmount: STANDARD_EXPORT_CREDIT_AMOUNT * 80,
    priceMicros: 199_990_000,
    currency: "USD",
    billingPeriod: "P1M"
  },
  {
    sku: "tomeza.credit_pack_1",
    title: "One extra credit",
    description: "One extra standard export credit.",
    productType: "CREDIT_PACK",
    creditAmount: STANDARD_EXPORT_CREDIT_AMOUNT,
    priceMicros: 7_990_000,
    currency: "USD",
    billingPeriod: null
  },
  {
    sku: "tomeza.credit_pack_2",
    title: "Two extra credits",
    description: "Two extra standard export credits.",
    productType: "CREDIT_PACK",
    creditAmount: STANDARD_EXPORT_CREDIT_AMOUNT * 2,
    priceMicros: 14_990_000,
    currency: "USD",
    billingPeriod: null
  }
] as const;

/**
 * Calendar months one billing period covers: 1 for "P1M", 12 for "P1Y". Null
 * for a one-time product, or a period not counted in months or years.
 */
export function billingPeriodMonths(billingPeriod: string | null | undefined): number | null {
  const match = /^P(\d+)([MY])$/.exec(billingPeriod ?? "");
  if (!match) return null;
  const count = Number(match[1]);
  return count > 0 ? (match[2] === "Y" ? count * 12 : count) : null;
}

/**
 * What one month of a plan grants. Every plan's allowance is granted a month
 * at a time whatever its billing period, so the yearly plan's `creditAmount` —
 * what one payment buys in all — arrives as 6,000 at the start of each month
 * of its paid year. Null for anything that is not a plan.
 */
export function monthlyPlanCredits(product: { creditAmount: number; billingPeriod: string | null }): number | null {
  const months = billingPeriodMonths(product.billingPeriod);
  return months ? Math.floor(product.creditAmount / months) : null;
}

/**
 * Introductory prices configured in Play Console, by the offer ID given there.
 *
 * Google reports *that* a subscription is in its introductory phase
 * (`lineItems[].offerPhase`) but not what that phase cost, so the cash a
 * payment records comes from here. An intro offer under any other ID still
 * grants its allowance and is recorded at the catalog price, marked as such
 * (`amountSource`), so the dashboard can tell an estimate from a known price.
 * A free trial needs no entry: it grants the plan but no credits, and records
 * no payment (`billingSubscriptions.ts`).
 *
 * **An intro period grants `creditAmount`, not the plan's allowance.** It used
 * to grant all 6,000: $9.99 for 6,000 credits is $0.00142 a credit after Play's
 * 15%, a third under the Max plan's $0.002125 that every per-page price is
 * floored at, so a reader could buy the intro, spend it on long premium books,
 * cancel, and leave a loss (pre-launch review, 2026-10). 4,000 is that floor at
 * the intro's price (9.99 × 0.85 / 4,000 = $0.0021229, 0.1% under Max's own
 * rate, which is rounding). The full-price renewal that follows grants the
 * plan's allowance as usual. An intro offer under an unknown ID still grants
 * the full allowance, since nothing here says what it cost: add it here first.
 */
export const SUBSCRIPTION_INTRO_OFFERS: ReadonlyArray<{
  sku: string;
  offerId: string;
  priceMicros: number;
  creditAmount: number;
}> = [
  { sku: "tomeza.creator_monthly", offerId: "creator-intro-first-month", priceMicros: 9_990_000, creditAmount: 4_000 }
];

/**
 * Google Play's service fee on an auto-renewing subscription: 15% from the
 * first payment. Every net figure the dashboard shows for a subscription, and
 * the value of every allowance credit, is the catalog price less this.
 */
export const PLAY_SUBSCRIPTION_FEE_RATE = 0.15;

/**
 * Google Play's service fee on a one-time product (a credit pack). **15% only
 * while the developer account is enrolled in Play's 15% service-fee tier** (the
 * first $1M of earnings a year); an account that is not enrolled pays 30%. The
 * owner must enrol in that tier, or set this to 0.3 — every pack credit's value
 * and every net cash figure for a pack reads it.
 */
export const PLAY_ONE_TIME_PRODUCT_FEE_RATE = 0.15;

/** Google's cut of a payment for a product of this type. Anything but a subscription is a one-time product. */
export function playServiceFeeRate(productType: string | null | undefined): number {
  return productType === "SUBSCRIPTION" ? PLAY_SUBSCRIPTION_FEE_RATE : PLAY_ONE_TIME_PRODUCT_FEE_RATE;
}

/**
 * What one credit of a product brings in once Google has taken its fee:
 * catalog price × (1 − fee) ÷ the credits one purchase grants. 0 for a product
 * with no price or no credits — nothing says what such a credit earned.
 */
export function netUsdPerCredit(product: {
  priceMicros: number | bigint | null | undefined;
  creditAmount: number | null | undefined;
  productType: string | null | undefined;
}): number {
  const priceUsd = product.priceMicros === null || product.priceMicros === undefined ? 0 : Number(product.priceMicros) / 1_000_000;
  const credits = product.creditAmount ?? 0;
  if (!(priceUsd > 0) || !(credits > 0)) {
    return 0;
  }
  return (priceUsd * (1 - playServiceFeeRate(product.productType))) / credits;
}

/**
 * The intro offer an `allowanceBasis: "intro_offer"` grant of `sku` was sold
 * under. The grant names its plan but not its offer, so the offer that grants
 * exactly that many credits wins, then the plan's only offer.
 */
export function introOfferForGrant(sku: string, grantedCredits: number): (typeof SUBSCRIPTION_INTRO_OFFERS)[number] | null {
  const offers = SUBSCRIPTION_INTRO_OFFERS.filter((offer) => offer.sku === sku);
  return offers.find((offer) => offer.creditAmount === grantedCredits) ?? offers[0] ?? null;
}

/**
 * The least any credit sold for money earns after Google's fee — every product
 * and every intro offer (today the intro month, $0.0021229, a hair under Max's
 * $0.0021249). The conservative value of a credit when nothing says where it
 * came from: a projection or an estimate with no ledger behind it.
 */
export const CHEAPEST_PAID_CREDIT_USD_VALUE = Math.min(
  ...DEFAULT_BILLING_PRODUCTS.map((product) => netUsdPerCredit(product)),
  ...SUBSCRIPTION_INTRO_OFFERS.map((offer) => netUsdPerCredit({ ...offer, productType: "SUBSCRIPTION" }))
);

/**
 * The plans a reader on each tier is shown. Every product stays sellable — the
 * catalog row is active and restore still finds it — this only decides what the
 * paywall lists.
 *
 * Max ($199.99) is offered at launch only to someone already on Pro, who can
 * outgrow 15,000 credits, or on Max itself. Shown to a first-time buyer beside
 * $19.99 it reads as the price of the app rather than an upgrade.
 */
const PLAN_OFFERED_TO_TIERS: Readonly<Partial<Record<string, readonly PlanTier[]>>> = {
  "tomeza.max_monthly": ["pro", "max"]
};

export function billingProductOfferedTo(sku: string, planTier: PlanTier): boolean {
  const tiers = PLAN_OFFERED_TO_TIERS[sku];
  return tiers === undefined || tiers.includes(planTier);
}

export type BillingOperation =
  | "CHAT_MESSAGE"
  | "MESSAGE_LIMIT_RESET"
  | "PLAN_GENERATION"
  | "PREVIEW_GENERATION"
  | "FULL_BOOK_GENERATION"
  | "IMAGE_GENERATION"
  | "COVER_REGENERATION"
  | "PREMIUM_REVIEW"
  | "EXPORT_UNLOCK"
  | "PLAN_REVISION"
  | "BOOK_TEXT_EDIT"
  | "PAGE_REGENERATION"
  | "BOOK_REPLAN"
  | "VOICE_CALL_MINUTE"
  | "AUDIOBOOK_GENERATION"
  | "CHARACTER_PORTRAIT_GENERATION"
  | "PURCHASE_CREDIT_GRANT"
  | "SUBSCRIPTION_CREDIT_GRANT"
  | "PLAN_ALLOWANCE_GRANT"
  | "WELCOME_GRANT"
  | "ADMIN_GRANT";

export type CreditLineItem = {
  code: BillingOperation;
  label: string;
  quantity: number;
  unitCredits: number;
  credits: number;
};

export type CreditCostEstimate = {
  totalCredits: number;
  lineItems: CreditLineItem[];
  assumptions: {
    creditUsdValue: number;
    estimatedInteriorImages: number;
    includesCover: boolean;
    includesPremiumReview: boolean;
    /**
     * The tier these prices came from. Recorded rather than derived, because
     * this estimate is written into the reservation's metadata and read back
     * long after the project row may have moved.
     */
    modelTier: ModelTier;
  };
};

export type ProviderCostEstimate = {
  estimatedUsd: number;
  assumptions: ProviderCostAssumptions & {
    estimatedInteriorImages: number;
    includesCover: boolean;
    includesPremiumReview: boolean;
  };
};

export type MarginEstimate = {
  estimatedRevenueUsd: number;
  estimatedProviderCostUsd: number;
  actualProviderCostUsd: number | null;
  estimatedMarginUsd: number;
  actualMarginUsd: number | null;
  estimatedMarginPercent: number | null;
  actualMarginPercent: number | null;
};

/**
 * `pricing` defaults to the live snapshot. Pass it explicitly only to price
 * against values that are not (or not yet) in effect — the pricing dashboard's
 * preview does exactly that, which is why the parameter exists at all.
 *
 * Message operations (`CHAT_MESSAGE`, `MESSAGE_LIMIT_RESET`) are quoted for
 * `planTier` (default free). Other operations ignore the tier.
 */
export function creditCostForOperation(
  operation: BillingOperation,
  pricing: CreditPricing = creditPricing(),
  planTier: PlanTier = "free"
): number {
  switch (operation) {
    case "CHAT_MESSAGE":
      return messagePolicy(planTier, pricing).creditsPerMessage;
    case "MESSAGE_LIMIT_RESET":
      return messagePolicy(planTier, pricing).resetCredits;
    case "PLAN_GENERATION":
      return pricing.planGeneration;
    case "PREVIEW_GENERATION":
      return pricing.previewGeneration;
    case "IMAGE_GENERATION":
      return pricing.imageGeneration;
    case "COVER_REGENERATION":
      return pricing.coverRegeneration;
    case "PREMIUM_REVIEW":
      return pricing.premiumReview;
    case "EXPORT_UNLOCK":
      // Retired 2026-10-15: every finished book downloads free. The operation
      // stays so old ledger rows keep their title; nothing charges it.
      return 0;
    case "PLAN_REVISION":
      return pricing.planRevision;
    case "BOOK_TEXT_EDIT":
      return pricing.bookTextEditBase;
    case "PAGE_REGENERATION":
      return pricing.pageRegenerationPerPage;
    case "BOOK_REPLAN":
      return pricing.bookReplanBase;
    case "VOICE_CALL_MINUTE":
      return pricing.voiceCallPerMinute;
    case "AUDIOBOOK_GENERATION":
      return pricing.audiobookBase;
    case "CHARACTER_PORTRAIT_GENERATION":
      return pricing.characterPortraitGeneration;
    case "FULL_BOOK_GENERATION":
      return pricing.fullBookBase;
    case "PURCHASE_CREDIT_GRANT":
    case "SUBSCRIPTION_CREDIT_GRANT":
    case "PLAN_ALLOWANCE_GRANT":
    case "WELCOME_GRANT":
    case "ADMIN_GRANT":
      return 0;
    default:
      return assertNever(operation);
  }
}

/**
 * What a generated book costs: one charge, taken when its plan is approved,
 * whoever approves it. The finished book downloads free, so no line here is
 * for taking its file out — the per-book export unlock was removed on
 * 2026-10-15 (`apps/api/src/mobile/CLAUDE.md`). A quote stored before then may
 * still carry an `EXPORT_UNLOCK` line; its readers find lines by code.
 *
 * See {@link creditCostForOperation} for why `pricing` is a parameter.
 */
export function estimateFullBookCreditCost(
  input: CreateProjectInput,
  pricing: CreditPricing = creditPricing()
): CreditCostEstimate {
  // Resolved once for the whole quote: reading it per line item would let a
  // caller hand in one input and be priced at two different tiers.
  const modelTier = modelTierForInput(input);
  const perPageCredits = tierPrice(pricing, "fullBookPerPage", modelTier);
  const imageCredits = tierPrice(pricing, "imageGeneration", modelTier);
  const estimatedInteriorImages = estimateInteriorImageCount(input);
  const includesCover = coverArtSourceFor(input.mediaSettings) === "ai";
  const fullBookCredits = tierPrice(pricing, "fullBookBase", modelTier) + input.targetPages * perPageCredits;
  const interiorImageCredits = estimatedInteriorImages * imageCredits;
  const coverCredits = includesCover ? imageCredits : 0;
  const includesPremiumReview = isPremiumProject(input);
  const premiumCredits = includesPremiumReview ? pricing.premiumReview : 0;
  const lineItems: CreditLineItem[] = [
    {
      code: "FULL_BOOK_GENERATION",
      label: "Full book generation",
      quantity: input.targetPages,
      unitCredits: perPageCredits,
      credits: fullBookCredits
    },
    {
      code: "IMAGE_GENERATION",
      label: "Interior image generation",
      quantity: estimatedInteriorImages,
      unitCredits: imageCredits,
      credits: interiorImageCredits
    },
    {
      code: "IMAGE_GENERATION",
      label: "Cover image generation",
      quantity: includesCover ? 1 : 0,
      unitCredits: imageCredits,
      credits: coverCredits
    },
    {
      code: "PREMIUM_REVIEW",
      label: "Premium review",
      quantity: includesPremiumReview ? 1 : 0,
      unitCredits: pricing.premiumReview,
      credits: premiumCredits
    }
  ];

  return {
    totalCredits: lineItems.reduce((total, item) => total + item.credits, 0),
    lineItems,
    assumptions: {
      creditUsdValue: CREDIT_USD_VALUE,
      estimatedInteriorImages,
      includesCover,
      includesPremiumReview,
      modelTier
    }
  };
}

/**
 * What a chat `book_replan` (a rebuild or a translated copy) is charged: the
 * flat `bookReplanBase` for re-planning, then a fresh full book of the copy it
 * creates. The same total `bookEditCreditCost` quotes, itemised, so the charge
 * can store it as its `creditEstimate` and a reader's own stop of the copy can
 * be priced by what was delivered (`packages/db/src/userStopSettlement.ts`).
 */
export function estimateBookReplanCreditCost(
  input: CreateProjectInput,
  pricing: CreditPricing = creditPricing()
): CreditCostEstimate {
  const book = estimateFullBookCreditCost(input, pricing);
  return {
    ...book,
    totalCredits: pricing.bookReplanBase + book.totalCredits,
    lineItems: [
      {
        code: "BOOK_REPLAN",
        label: "Book rebuild",
        quantity: 1,
        unitCredits: pricing.bookReplanBase,
        credits: pricing.bookReplanBase
      },
      ...book.lineItems
    ]
  };
}

/**
 * What narrating a finished book costs.
 *
 * Priced off the finished book rather than `targetPages`, because by the time
 * anyone can ask for an audiobook the book exists and its length is a fact —
 * and off its narrated **words**, because the speech provider bills by the
 * second of audio. A page is no unit of that: a picture-book page is sixty
 * words and a composed nonfiction page four hundred and fifty. Words are
 * counted by {@link narrationWordCount}, over the text the narrator reads.
 * See {@link creditCostForOperation} for why `pricing` is a parameter.
 */
export function estimateAudiobookCreditCost(
  book: { pageCount: number; wordCount: number },
  pricing: CreditPricing = creditPricing()
): CreditCostEstimate {
  const pages = Math.max(0, Math.round(book.pageCount));
  const hundreds = Math.ceil(Math.max(0, Math.round(book.wordCount)) / 100);
  const pageCredits = pages * pricing.audiobookPerPage;
  const wordCredits = hundreds * pricing.audiobookPer100Words;
  const credits = pricing.audiobookBase + pageCredits + wordCredits;
  return {
    totalCredits: credits,
    lineItems: [
      {
        code: "AUDIOBOOK_GENERATION",
        label: "Audiobook narration",
        quantity: hundreds,
        unitCredits: pricing.audiobookPer100Words,
        credits: pricing.audiobookBase + wordCredits
      },
      ...(pageCredits > 0
        ? [
            {
              code: "AUDIOBOOK_GENERATION" as const,
              label: "Audiobook narration per page",
              quantity: pages,
              unitCredits: pricing.audiobookPerPage,
              credits: pageCredits
            }
          ]
        : [])
    ],
    assumptions: {
      creditUsdValue: CREDIT_USD_VALUE,
      estimatedInteriorImages: 0,
      includesCover: false,
      includesPremiumReview: false,
      // Narration reaches a tier-blind speech provider, so this estimate is the
      // same at every tier. Recorded as balanced rather than left out because
      // the field says which prices were used, and these are the flat ones.
      modelTier: "balanced"
    }
  };
}

/**
 * The words an audiobook of these pages reads aloud: the same reduction the
 * narrator applies (`narrationParagraphs` — no code, tables or images), counted
 * the way every length rule in the pipeline counts (`countReadableWords`, which
 * estimates unspaced scripts from their characters).
 */
export function narrationWordCount(pageMarkdowns: readonly string[]): number {
  let words = 0;
  for (const markdown of pageMarkdowns) {
    for (const paragraph of narrationParagraphs(markdown)) {
      words += countReadableWords(paragraph);
    }
  }
  return words;
}

export function estimateProviderCostForProject(input: CreateProjectInput): ProviderCostEstimate {
  const assumptions = providerCostAssumptionsForInput(input);
  const estimatedInteriorImages = estimateInteriorImageCount(input);
  const includesCover = coverArtSourceFor(input.mediaSettings) === "ai";
  const includesPremiumReview = isPremiumProject(input);
  const estimatedUsd =
    assumptions.textBase +
    input.targetPages * assumptions.textPerPage +
    estimatedInteriorImages * assumptions.imageGeneration +
    (includesCover ? assumptions.coverIncluded : 0) +
    (includesPremiumReview ? assumptions.premiumReview : 0) +
    assumptions.exportCompile;

  return {
    estimatedUsd: roundUsd(estimatedUsd),
    assumptions: {
      ...assumptions,
      estimatedInteriorImages,
      includesCover,
      includesPremiumReview
    }
  };
}

export function buildMarginEstimate(options: {
  creditEstimate: CreditCostEstimate;
  providerEstimate: ProviderCostEstimate;
  actualProviderCostUsd?: number | null | undefined;
}): MarginEstimate {
  // A margin, so what the credits earn at the cheapest they are sold — never the list cent.
  const estimatedRevenueUsd = roundUsd(options.creditEstimate.totalCredits * CHEAPEST_PAID_CREDIT_USD_VALUE);
  const estimatedProviderCostUsd = options.providerEstimate.estimatedUsd;
  const actualProviderCostUsd =
    typeof options.actualProviderCostUsd === "number" && Number.isFinite(options.actualProviderCostUsd)
      ? roundUsd(options.actualProviderCostUsd)
      : null;
  const estimatedMarginUsd = roundUsd(estimatedRevenueUsd - estimatedProviderCostUsd);
  const actualMarginUsd = actualProviderCostUsd === null ? null : roundUsd(estimatedRevenueUsd - actualProviderCostUsd);

  return {
    estimatedRevenueUsd,
    estimatedProviderCostUsd,
    actualProviderCostUsd,
    estimatedMarginUsd,
    actualMarginUsd,
    estimatedMarginPercent: marginPercent(estimatedRevenueUsd, estimatedMarginUsd),
    actualMarginPercent: actualMarginUsd === null ? null : marginPercent(estimatedRevenueUsd, actualMarginUsd)
  };
}

/**
 * How many interior illustrations a book is billed for: exactly the slots
 * generation will draw. `interiorIllustrationSlotCount` already thins an app
 * book's slots to its launch cap, so the cap here only binds an operator book,
 * which draws every slot and is never billed past the cap. One rule in
 * `illustrationSlots.ts` decides both, so the charge cannot exceed the
 * drawing or the drawing the charge.
 */
export function estimateInteriorImageCount(input: CreateProjectInput): number {
  return Math.min(interiorIllustrationLaunchCap(input), interiorIllustrationSlotCount(input));
}

/**
 * Whether this book runs the extra premium review pass.
 *
 * The tier, deliberately not `draftCandidates`: best-of drafting is consumed
 * only by the sequential-pages strategy (books past the mobile ceiling), so
 * pricing on that knob charged premium review for a setting the routed strategy
 * never read. And deliberately not `mediaSettings.mobile.qualityPreset`, which
 * is only ever written by the app — see {@link modelTierForInput}.
 */
export function isPremiumProject(input: CreateProjectInput): boolean {
  const tier = modelTierForInput(input);
  return tier === "premium" || tier === "ultra";
}

function roundUsd(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

function marginPercent(revenueUsd: number, marginUsd: number): number | null {
  if (revenueUsd <= 0) {
    return null;
  }
  return Math.round((marginUsd / revenueUsd) * 10_000) / 100;
}

function assertNever(value: never): never {
  throw new Error(`Unhandled billing operation: ${String(value)}`);
}
