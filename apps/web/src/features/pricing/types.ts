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
  // Not prices — the free tier's monthly limits. Same table, same audit trail.
  | "freeMonthlyCredits"
  | "freeIllustratedBooksPerMonth"
  | "freeManuscriptImportsPerMonth";

export type CreditPricingValues = Record<CreditPricingKey, number>;

export type PricingPreview = {
  label: string;
  targetPages: number;
  totalCredits: number;
  estimatedUsd: number;
  lineItems: Array<{ code: string; label: string; quantity: number; unitCredits: number; credits: number }>;
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
