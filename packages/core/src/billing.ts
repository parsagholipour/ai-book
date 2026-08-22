import { type CreditPricing, creditPricing } from "./creditPricing.js";
import { coverArtSourceFor } from "./generation/coverSource.js";
import { interiorIllustrationSlotCount } from "./generation/illustrationSlots.js";
import { modelTierSchema } from "./schemas/book.js";
import type { CreateProjectInput, ModelTier } from "./schemas/book.js";
import { jsonRecord } from "./schemas/jsonCoercion.js";

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
 * **Exhaustive by type, for the same reason `FIRST_PAGE_CANDIDATES_BY_TIER`
 * (`generation/bestOf.ts`) is.** As a `Partial` record it resolved an unlisted
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
    // `textBase` stays at the base rate: fast draws one draft of page 1
    // (`FIRST_PAGE_CANDIDATES_BY_TIER`), so best-of costs it nothing.
    textPerPage: 0.008
  },
  balanced: {
    ...PROVIDER_COST_ASSUMPTIONS_USD,
    // Balanced samples page 1 twice and judges the pair, which measures at
    // +$0.0024 — one extra `deepseek-v4-pro` draft plus a `deepseek-v4-flash`
    // judge. Small enough to sit inside this table's error bars, and carried
    // anyway: balanced is the default tier and what the free tier runs on, so
    // it is the row the margin dashboard reports most often, and a tier that
    // silently inherited the base table is the shape this record was made
    // exhaustive to prevent. On the per-book base for the reason premium's is
    // — measured once per book, whatever the book's length.
    textBase: 0.083
  },
  premium: {
    ...PROVIDER_COST_ASSUMPTIONS_USD,
    // Page 1 is drafted best-of-3 and judged (`firstPageCandidateCount`,
    // `generation/bestOf.ts`), measured at +$0.048 over the single draft it
    // replaces. That lands on the per-book base and never on `textPerPage`,
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
    // Same one-off as premium, priced at ultra's worst realistic shape: an
    // operator-created ultra book on the sequential path draws three page-1
    // candidates that are each a full writer-tool loop, plus the judge, for
    // +$0.087. Per-book for the reason spelled out on premium above.
    textBase: 0.17,
    // Per *page*, and unchanged by the page-1 work: draft ~$0.05 + polish
    // ~$0.05 + judge/tools/extract ~$0.02, on every page. Premium's 0.05 only
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
 * Which tier a book is *priced* at.
 *
 * `mediaSettings.modelTier` and nothing else. It is the field that actually
 * routes the models (`adapters/modelTiers.ts`), it is typed and validated, and
 * it is what the provider-cost table above already reads — pricing off
 * `mediaSettings.mobile.qualityPreset` instead, as this file used to, meant a
 * project that set the tier directly got premium models for free, because that
 * echo is only ever written by the app.
 *
 * No tier recorded is `balanced`, which is the honest answer rather than a
 * default: a book from before tier routing runs the legacy single model, and
 * balanced is what the unsuffixed price keys have always meant.
 */
export function modelTierForInput(input: CreateProjectInput): ModelTier {
  return input.mediaSettings.modelTier ?? "balanced";
}

/** {@link modelTierForInput} for callers holding a raw `mediaSettings` JSON column. */
export function modelTierFromMediaSettings(mediaSettings: unknown): ModelTier {
  const parsed = modelTierSchema.safeParse(jsonRecord(mediaSettings).modelTier);
  return parsed.success ? parsed.data : "balanced";
}

/**
 * The rates that vary by tier, and the only ones.
 *
 * A tier changes which models run, so a price follows it exactly as far as the
 * model spend does: the writing rate, the images, and the per-page rate every
 * post-generation rewrite is billed at. Everything else is flat on purpose —
 * `exportUnlock` compiles the same PDF whatever wrote it, an audiobook and a
 * voice call reach a tier-blind provider, and `fullBookBase`'s siblings
 * (`bookTextEditBase`, `bookReplanBase`) are fixed overheads rather than model
 * spend.
 *
 * The unsuffixed key is the balanced rate; the other two are that key plus
 * `Fast` / `Premium`. Keeping the convention mechanical is what lets one
 * resolver serve every call site, here and in the app's mirror of it.
 */
export const TIER_PRICED_KEYS = [
  "fullBookBase",
  "fullBookPerPage",
  "imageGeneration",
  "pageRegenerationPerPage",
  "bookTextEditPerPage"
] as const;

export type TierPricedKey = (typeof TIER_PRICED_KEYS)[number];

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
  | "CHARACTER_PORTRAIT_GENERATION"
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
    case "CHARACTER_PORTRAIT_GENERATION":
      return pricing.characterPortraitGeneration;
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
      includesPremiumReview,
      modelTier
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
      includesPremiumReview: false,
      // Narration reaches a tier-blind speech provider, so this estimate is the
      // same at every tier. Recorded as balanced rather than left out because
      // the field says which prices were used, and these are the flat ones.
      modelTier: "balanced"
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
  // Slots are the pages generation will actually try to illustrate. The /4
  // ceiling used to charge a 5-page short story for two interiors while
  // `shouldIllustratePage` only fired for page 1. Cap still bounds KIDS
  // every-page books so a 32-page picture book is not billed for 32 images.
  return Math.max(0, Math.min(launchCap, interiorIllustrationSlotCount(input)));
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

/**
 * The app's own metadata echo, read for the one thing only it knows: which of
 * the mobile book shapes this is, which sets the illustration cap. The quality
 * preset also lives here and is deliberately *not* read — pricing follows
 * `mediaSettings.modelTier`, see {@link modelTierForInput}.
 */
function mobileMetadata(mediaSettings: CreateProjectInput["mediaSettings"]): {
  bookType?: "lead_magnet" | "workbook" | "short_story";
  imagesEnabled?: boolean;
} | null {
  const record = jsonRecord((mediaSettings as CreateProjectInput["mediaSettings"] & { mobile?: unknown }).mobile);
  const bookType = stringValue(record.bookType);
  return {
    ...(bookType === "lead_magnet" || bookType === "workbook" || bookType === "short_story" ? { bookType } : {}),
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
