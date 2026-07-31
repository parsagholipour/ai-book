import { type CreditPricing, creditPricing } from "./creditPricing.js";
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
    title: "Creator monthly",
    description: "Monthly creator plan with three standard export credits.",
    productType: "SUBSCRIPTION",
    creditAmount: STANDARD_EXPORT_CREDIT_AMOUNT * 3,
    priceMicros: 19_990_000,
    currency: "USD"
  },
  {
    sku: "tomeza.pro_monthly",
    title: "Pro monthly",
    description: "Monthly pro plan with six standard export credits for busier creators.",
    productType: "SUBSCRIPTION",
    creditAmount: STANDARD_EXPORT_CREDIT_AMOUNT * 6,
    priceMicros: 39_990_000,
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
  | "PURCHASE_CREDIT_GRANT"
  | "SUBSCRIPTION_CREDIT_GRANT"
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
    case "FULL_BOOK_GENERATION":
      return pricing.fullBookBase;
    case "PURCHASE_CREDIT_GRANT":
    case "SUBSCRIPTION_CREDIT_GRANT":
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
  const fullBookCredits = pricing.fullBookBase + input.targetPages * pricing.fullBookPerPage;
  const imageCredits = estimatedInteriorImages * pricing.imageGeneration;
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
      credits: imageCredits
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
      includesExportUnlock: true,
      includesPremiumReview
    }
  };
}

export function estimateProviderCostForProject(input: CreateProjectInput): ProviderCostEstimate {
  const assumptions = providerCostAssumptionsForInput(input);
  const estimatedInteriorImages = estimateInteriorImageCount(input);
  const includesCover = input.mediaSettings.includeCover === true;
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
  if (mobile?.imagesEnabled === false) {
    return 0;
  }
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
  return mobile?.qualityPreset === "premium" || (input.mediaSettings.draftCandidates ?? 1) > 1;
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
