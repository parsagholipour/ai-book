import { type CreditPricing, creditPricing } from "./creditPricing.js";
import { coverArtSourceFor } from "./generation/coverSource.js";
import type { CreateProjectInput, ModelTier } from "./schemas/book.js";

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
 */
const MODEL_TIER_COST_ASSUMPTIONS_USD: Partial<Record<ModelTier, ProviderCostAssumptions>> = {
  fast: {
    ...PROVIDER_COST_ASSUMPTIONS_USD,
    textPerPage: 0.008
  },
  premium: {
    ...PROVIDER_COST_ASSUMPTIONS_USD,
    textPerPage: 0.05,
    imageGeneration: 0.067,
    coverIncluded: 0.134,
    premiumReview: 0.05
  }
};

export function providerCostAssumptionsForInput(input: CreateProjectInput): ProviderCostAssumptions {
  const tier = input.mediaSettings.modelTier;
  return (tier && MODEL_TIER_COST_ASSUMPTIONS_USD[tier]) || PROVIDER_COST_ASSUMPTIONS_USD;
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

export const DEFAULT_BILLING_PRODUCTS = [
  {
    sku: "tomeza.one_book_export",
    title: "One book export",
    description: "One standard export credit for a bounded PDF/EPUB book package.",
    productType: "ONE_TIME_UNLOCK",
    creditAmount: STANDARD_EXPORT_CREDIT_AMOUNT,
    priceMicros: 9_990_000,
    currency: "USD"
  },
  {
    sku: "tomeza.creator_monthly",
    title: "Creator",
    description: "6,000 credits a month, unlimited illustrated books, and manuscript import.",
    productType: "SUBSCRIPTION",
    creditAmount: STANDARD_EXPORT_CREDIT_AMOUNT * 6,
    priceMicros: 19_990_000,
    currency: "USD"
  },
  {
    sku: "tomeza.pro_monthly",
    title: "Pro",
    description: "15,000 credits a month for creators shipping a book a week.",
    productType: "SUBSCRIPTION",
    creditAmount: STANDARD_EXPORT_CREDIT_AMOUNT * 15,
    priceMicros: 39_990_000,
    currency: "USD"
  },
  {
    sku: "tomeza.max_monthly",
    title: "Max",
    description: "80,000 credits a month — effectively unlimited for one person.",
    productType: "SUBSCRIPTION",
    creditAmount: STANDARD_EXPORT_CREDIT_AMOUNT * 80,
    priceMicros: 199_990_000,
    currency: "USD"
  },
  {
    sku: "tomeza.credit_pack_1",
    title: "One extra credit",
    description: "One extra standard export credit.",
    productType: "CREDIT_PACK",
    creditAmount: STANDARD_EXPORT_CREDIT_AMOUNT,
    priceMicros: 7_990_000,
    currency: "USD"
  },
  {
    sku: "tomeza.credit_pack_2",
    title: "Two extra credits",
    description: "Two extra standard export credits.",
    productType: "CREDIT_PACK",
    creditAmount: STANDARD_EXPORT_CREDIT_AMOUNT * 2,
    priceMicros: 14_990_000,
    currency: "USD"
  }
] as const;

export type BillingOperation =
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
  | "PURCHASE_CREDIT_GRANT"
  | "SUBSCRIPTION_CREDIT_GRANT"
  | "PLAN_ALLOWANCE_GRANT"
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
    includesExportUnlock: boolean;
    includesPremiumReview: boolean;
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
 */
export function creditCostForOperation(operation: BillingOperation, pricing: CreditPricing = creditPricing()): number {
  switch (operation) {
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
      return pricing.exportUnlock;
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
    case "FULL_BOOK_GENERATION":
      return pricing.fullBookBase;
    case "PURCHASE_CREDIT_GRANT":
    case "SUBSCRIPTION_CREDIT_GRANT":
    case "PLAN_ALLOWANCE_GRANT":
    case "ADMIN_GRANT":
      return 0;
    default:
      return assertNever(operation);
  }
}

/** See {@link creditCostForOperation} for why `pricing` is a parameter. */
export function estimateFullBookCreditCost(
  input: CreateProjectInput,
  pricing: CreditPricing = creditPricing()
): CreditCostEstimate {
  const estimatedInteriorImages = estimateInteriorImageCount(input);
  const includesCover = coverArtSourceFor(input.mediaSettings) === "ai";
  const fullBookCredits = pricing.fullBookBase + input.targetPages * pricing.fullBookPerPage;
  const interiorImageCredits = estimatedInteriorImages * pricing.imageGeneration;
  const coverCredits = includesCover ? pricing.imageGeneration : 0;
  const includesPremiumReview = isPremiumProject(input);
  const premiumCredits = includesPremiumReview ? pricing.premiumReview : 0;
  const lineItems: CreditLineItem[] = [
    {
      code: "FULL_BOOK_GENERATION",
      label: "Full book generation",
      quantity: input.targetPages,
      unitCredits: pricing.fullBookPerPage,
      credits: fullBookCredits
    },
    {
      code: "IMAGE_GENERATION",
      label: "Interior image generation",
      quantity: estimatedInteriorImages,
      unitCredits: pricing.imageGeneration,
      credits: interiorImageCredits
    },
    {
      code: "IMAGE_GENERATION",
      label: "Cover image generation",
      quantity: includesCover ? 1 : 0,
      unitCredits: pricing.imageGeneration,
      credits: coverCredits
    },
    {
      code: "PREMIUM_REVIEW",
      label: "Premium review",
      quantity: includesPremiumReview ? 1 : 0,
      unitCredits: pricing.premiumReview,
      credits: premiumCredits
    },
    {
      code: "EXPORT_UNLOCK",
      label: "PDF/EPUB export unlock",
      quantity: 1,
      unitCredits: pricing.exportUnlock,
      credits: pricing.exportUnlock
    }
  ];

  return {
    totalCredits: lineItems.reduce((total, item) => total + item.credits, 0),
    lineItems,
    assumptions: {
      creditUsdValue: CREDIT_USD_VALUE,
      estimatedInteriorImages,
      includesCover,
      includesExportUnlock: true,
      includesPremiumReview
    }
  };
}

/**
 * What narrating a finished book costs.
 *
 * Priced off the real page count rather than `targetPages`, because by the time
 * anyone can ask for an audiobook the book exists and its length is a fact.
 * See {@link creditCostForOperation} for why `pricing` is a parameter.
 */
export function estimateAudiobookCreditCost(
  pageCount: number,
  pricing: CreditPricing = creditPricing()
): CreditCostEstimate {
  const pages = Math.max(0, Math.round(pageCount));
  const credits = pricing.audiobookBase + pages * pricing.audiobookPerPage;
  return {
    totalCredits: credits,
    lineItems: [
      {
        code: "AUDIOBOOK_GENERATION",
        label: "Audiobook narration",
        quantity: pages,
        unitCredits: pricing.audiobookPerPage,
        credits
      }
    ],
    assumptions: {
      creditUsdValue: CREDIT_USD_VALUE,
      estimatedInteriorImages: 0,
      includesCover: false,
      includesExportUnlock: false,
      includesPremiumReview: false
    }
  };
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
  const estimatedRevenueUsd = roundUsd(options.creditEstimate.totalCredits * CREDIT_USD_VALUE);
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

export function estimateInteriorImageCount(input: CreateProjectInput): number {
  if (!input.mediaSettings.fullIllustrations) {
    return 0;
  }
  const mobile = mobileMetadata(input.mediaSettings);
  const bookType = mobile?.bookType ?? inferMobileBookType(input.category, input.subcategory);
  const launchCap =
    bookType === "workbook"
      ? 6
      : bookType === "lead_magnet" || bookType === "short_story"
        ? 4
        : Math.max(1, Math.ceil(input.targetPages / 8));
  return Math.max(0, Math.min(launchCap, Math.ceil(input.targetPages / 4)));
}

export function isPremiumProject(input: CreateProjectInput): boolean {
  const mobile = mobileMetadata(input.mediaSettings);
  // The preset alone, deliberately not `draftCandidates`: best-of drafting is
  // consumed only by the sequential-pages strategy (books past the mobile
  // ceiling), so pricing on the knob charged premium review for a setting the
  // routed strategy never read. The preset's real value — premium model
  // routing — applies to every strategy.
  return mobile?.qualityPreset === "premium";
}

function mobileMetadata(mediaSettings: CreateProjectInput["mediaSettings"]): {
  bookType?: "lead_magnet" | "workbook" | "short_story";
  qualityPreset?: "fast" | "balanced" | "premium";
  imagesEnabled?: boolean;
} | null {
  const record = jsonRecord((mediaSettings as CreateProjectInput["mediaSettings"] & { mobile?: unknown }).mobile);
  const bookType = stringValue(record.bookType);
  const qualityPreset = stringValue(record.qualityPreset);
  return {
    ...(bookType === "lead_magnet" || bookType === "workbook" || bookType === "short_story" ? { bookType } : {}),
    ...(qualityPreset === "fast" || qualityPreset === "balanced" || qualityPreset === "premium" ? { qualityPreset } : {}),
    ...(typeof record.imagesEnabled === "boolean" ? { imagesEnabled: record.imagesEnabled } : {})
  };
}

function inferMobileBookType(category: string, subcategory?: string | null): "lead_magnet" | "workbook" | "short_story" | "custom" {
  if (subcategory === "Lead Magnet Ebook" || category === "BUSINESS" || category === "SELF_HELP") {
    return "lead_magnet";
  }
  if (subcategory === "Workbook or Study Guide" || category === "EDUCATION") {
    return "workbook";
  }
  if (subcategory === "Short Story" || category === "STORY") {
    return "short_story";
  }
  return "custom";
}

function jsonRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
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
