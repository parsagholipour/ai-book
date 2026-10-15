export type CreditPricingKey =
  | "messageCreditsFree"
  | "messageDailyLimitFree"
  | "messageResetCreditsFree"
  | "messageResetEnabledFree"
  | "messageCreditsCreator"
  | "messageDailyLimitCreator"
  | "messageResetCreditsCreator"
  | "messageResetEnabledCreator"
  | "messageCreditsPro"
  | "messageDailyLimitPro"
  | "messageResetCreditsPro"
  | "messageResetEnabledPro"
  | "messageCreditsMax"
  | "messageDailyLimitMax"
  | "messageResetCreditsMax"
  | "messageResetEnabledMax"

  | "planGeneration"
  | "planGenerationFast"
  | "planGenerationPremium"
  | "planGenerationUltra"
  | "previewGeneration"
  | "fullBookBase"
  | "fullBookPerPage"
  | "imageGeneration"
  | "coverRegeneration"
  | "premiumReview"
  // Retired 2026-10-15 and held at 0 by the server: every finished book
  // downloads free. Still in the saved price list, so the editor sends it back
  // unchanged, but it has no field.
  | "exportUnlock"
  | "planRevision"
  | "planRevisionFast"
  | "planRevisionPremium"
  | "planRevisionUltra"
  | "bookTextEditBase"
  | "bookTextEditPerPage"
  | "pageRegenerationPerPage"
  | "addedPagesBase"
  | "bookReplanBase"
  | "voiceCallPerMinute"
  | "audiobookBase"
  | "audiobookPerPage"
  | "audiobookPer100Words"
  | "characterPortraitGeneration"
  // The quality tiers' own rates. The unsuffixed key above is the balanced one.
  | "fullBookBaseFast"
  | "fullBookBasePremium"
  | "fullBookBaseUltra"
  | "fullBookPerPageFast"
  | "fullBookPerPagePremium"
  | "fullBookPerPageUltra"
  | "imageGenerationFast"
  | "imageGenerationPremium"
  | "imageGenerationUltra"
  | "pageRegenerationPerPageFast"
  | "pageRegenerationPerPagePremium"
  | "pageRegenerationPerPageUltra"
  | "bookTextEditPerPageFast"
  | "bookTextEditPerPagePremium"
  | "bookTextEditPerPageUltra"
  // Not prices — the free tier's monthly limits. Same table, same audit trail.
  | "freeMonthlyCredits"
  | "welcomeCredits"
  | "welcomeCreditsEnabled"
  | "welcomeCreditsRegionalEnabled"
  | "welcomeCreditsHighIncome"
  | "welcomeCreditsLowMiddleIncome"
  | "welcomeCreditsAccountsPerIpHighIncome"
  | "welcomeCreditsAccountsPerIpLowMiddleIncome"
  | "freeIllustratedBooksPerMonth"
  | "freeManuscriptImportsPerMonth"
  | "freeMaxBookPages"
  // Not prices either: the longest book any account may have generated, and
  // the switch that lets new books start on Ultra effort.
  | "paidMaxBookPages"
  | "ultraTierEnabled";

export type CreditPricingValues = Record<CreditPricingKey, number>;

export type PricingTierQuote = {
  tier: "fast" | "balanced" | "premium" | "ultra";
  planningCredits: number;
  bookGenerationCredits: number;
  totalCredits: number;
  estimatedUsd: number;
  lineItems: Array<{ code: string; label: string; quantity: number; unitCredits: number; credits: number }>;
};

export type PricingPreview = {
  label: string;
  targetPages: number;
  /** The balanced reader journey, initial plan plus the later book package. */
  totalCredits: number;
  estimatedUsd: number;
  lineItems: Array<{ code: string; label: string; quantity: number; unitCredits: number; credits: number }>;
  /** The same book at each quality tier, fast first. */
  tiers: PricingTierQuote[];
};

export type PricingRevision = {
  version: number;
  changed: Partial<Record<CreditPricingKey, { from: number; to: number }>>;
  note: string | null;
  updatedBy: string | null;
  createdAt: string;
};

export type PricingState = {
  values: CreditPricingValues;
  version: number;
  note: string | null;
  updatedBy: string | null;
  updatedAt: string | null;
  defaults: CreditPricingValues;
  limits: CreditPricingValues;
  /** Per-key floors; an older API sends none, which reads as 0 (1 for free messages). */
  minimums?: Partial<CreditPricingValues>;
  /** Dollars per credit for every projection: the cheapest paid credit, net of Google's fee. */
  creditUsdValue: number;
  preview: PricingPreview;
  revisions: PricingRevision[];
};

export type PricingSaveResponse = {
  values: CreditPricingValues;
  version: number;
  applied: boolean;
};
