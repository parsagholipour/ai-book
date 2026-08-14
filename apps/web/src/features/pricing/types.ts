export type CreditPricingKey =
  | "planGeneration"
  | "previewGeneration"
  | "fullBookBase"
  | "fullBookPerPage"
  | "imageGeneration"
  | "coverRegeneration"
  | "premiumReview"
  | "exportUnlock"
  | "planRevision"
  | "bookTextEditBase"
  | "bookTextEditPerPage"
  | "pageRegenerationPerPage"
  | "bookReplanBase"
  | "voiceCallPerMinute"
  | "audiobookBase"
  | "audiobookPerPage"
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
  | "freeIllustratedBooksPerMonth"
  | "freeManuscriptImportsPerMonth";

export type CreditPricingValues = Record<CreditPricingKey, number>;

export type PricingTierQuote = {
  tier: "fast" | "balanced" | "premium" | "ultra";
  totalCredits: number;
  estimatedUsd: number;
  lineItems: Array<{ code: string; label: string; quantity: number; unitCredits: number; credits: number }>;
};

export type PricingPreview = {
  label: string;
  targetPages: number;
  /** The balanced quote, which is what the top-level fields have always meant. */
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
  creditUsdValue: number;
  preview: PricingPreview;
  revisions: PricingRevision[];
};

export type PricingSaveResponse = {
  values: CreditPricingValues;
  version: number;
  applied: boolean;
};
