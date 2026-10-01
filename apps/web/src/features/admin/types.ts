export type NamedTotal = { key: string; label: string; value: number; secondary?: number };

export type MoneySeriesPoint = {
  date: string;
  cashUsd: number;
  providerUsd: number;
  creditsDeliveredUsd: number;
  newUsers: number;
  booksCompleted: number;
};

export type AdminOverview = {
  window: { days: number; since: string; until: string };
  creditUsdValue: number;
  money: {
    cashCollectedUsd: number;
    providerSpendUsd: number;
    cashMarginUsd: number;
    cashMarginPercent: number | null;
    creditsDelivered: number;
    creditsDeliveredUsd: number;
    /** Charged in the window, then given back. Not counted in the above. */
    creditsRefunded: number;
    creditsRefundedUsd: number;
    unitMarginUsd: number;
    unitMarginPercent: number | null;
    creditsOutstanding: number;
    creditsOutstandingUsd: number;
    unpricedCalls: number;
  };
  people: {
    totalUsers: number;
    newUsers: number;
    activeUsers: number;
    disabledUsers: number;
    activeSubscriptions: number;
    payingUsers: number;
  };
  work: {
    projectsCreated: number;
    projectsCompleted: number;
    projectsFailed: number;
    booksInFlight: number;
    jobsRun: number;
    jobsFailed: number;
    jobFailureRate: number | null;
    voiceCalls: number;
    voiceMinutes: number;
    pendingModerationReports: number;
  };
  /** Mirrors `ShareFunnel` in apps/api/src/admin/shareFunnel.ts: shares and remix drafts created in the window. */
  sharing: ShareFunnel;
  series: MoneySeriesPoint[];
  creditsByOperation: NamedTotal[];
  spendByProvider: NamedTotal[];
  projectsByStatus: NamedTotal[];
  jobsByType: NamedTotal[];
};

/** Mirrors `apps/api/src/admin/costBreakdown.ts` — read its header before using these. */
export type CostKind = "text" | "image" | "audio";

export type CostUsage = {
  calls: number;
  pricedCalls: number;
  failedCalls: number;
  inFlightCalls: number;
  estimatedCalls: number;
  unratedCalls: number;
  usd: number;
  promptTokens: number;
  cachedPromptTokens: number;
  outputTokens: number;
  images: number;
  audioSeconds: number;
};

export type ModelCost = CostUsage & { key: string; provider: string; model: string; kind: CostKind };

export type OperationCost = CostUsage & { key: string; label: string; kind: CostKind; models: ModelCost[] };

/** Mirrors `apps/api/src/admin/searchGrounding.ts` — `billedFeeUsd` is the grounding part of `totals`, nothing more. */
export type SearchGroundingPeriodSummary = {
  pool: string;
  period: string;
  units: number;
  freeUnits: number;
  countedThrough: number;
  allowance: number | null;
  billedFeeUsd: number;
  listFeeUsd: number;
};

export type SearchGroundingSummary = {
  searchCalls: number;
  groundedPrompts: number;
  searchQueries: number;
  units: number;
  freeUnits: number;
  billedFeeUsd: number;
  listFeeUsd: number;
  unpricedCalls: number;
  periods: SearchGroundingPeriodSummary[];
};

export type AdminCostBreakdown = {
  window: { days: number; since: string; until: string };
  totals: CostUsage;
  byKind: Array<CostUsage & { kind: CostKind }>;
  operations: OperationCost[];
  models: ModelCost[];
  searchGrounding: SearchGroundingSummary;
};

/** Mirrors `apps/api/src/admin/operationEconomics.ts` — read its header on attribution. */
export type OperationEconomics = CostUsage & {
  key: string;
  label: string;
  runs: number;
  credits: number;
  refundedRuns: number;
  refundedCredits: number;
  revenueUsd: number;
  providerUsd: number;
  marginUsd: number;
  marginPercent: number | null;
  costPerRunUsd: number | null;
  creditsPerRun: number | null;
  note: string | null;
  models: ModelCost[];
};

export type UnbilledSpend = CostUsage & { key: string; label: string; description: string; models: ModelCost[] };

export type AdminOperationEconomics = {
  window: { days: number; since: string; until: string };
  creditUsdValue: number;
  totals: {
    runs: number;
    credits: number;
    refundedRuns: number;
    refundedCredits: number;
    revenueUsd: number;
    providerUsd: number;
    marginUsd: number;
    marginPercent: number | null;
    unbilledUsd: number;
  };
  operations: OperationEconomics[];
  unbilled: UnbilledSpend[];
};

export type AdminGeneratedBookSummary = {
  id: string;
  title: string;
  ownerEmail: string;
  pageCount: number;
  imageCount: number;
  completedAt: string;
  /** COMPLETE, or REVIEW_REQUIRED for a compiled book the quality card flagged. */
  status: string;
  grossCredits: number;
  refundedCredits: number;
  netCredits: number;
  revenueUsd: number;
  providerCostUsd: number;
  marginUsd: number;
  marginPercent: number | null;
};

export type AdminGeneratedBookList = {
  books: AdminGeneratedBookSummary[];
  total: number;
  limit: number;
  offset: number;
};

export type AdminGeneratedBookDetail = {
  bookId: string;
  chargeCount: number;
  refundCount: number;
  grossCredits: number;
  refundedCredits: number;
  netCredits: number;
  revenueUsd: number;
  providerCostUsd: number;
  marginUsd: number;
  marginPercent: number | null;
  totals: CostUsage;
  byKind: Array<CostUsage & { kind: CostKind }>;
  purposes: OperationCost[];
  qaRewriteTriggers: QaRewriteTriggerCost[];
  qualityGates: QualityGateCost[];
};

export type QaRewriteTriggerCost = {
  key: string;
  reasons: string[];
  calls: number;
  providerCostUsd: number;
};

export type QualityGateCost = {
  id: string;
  label: string;
  calls: number | null;
  providerCostUsd: number | null;
  costNote: string | null;
};

export type AdminGeneratedPlanSummary = {
  id: string;
  projectId: string;
  title: string;
  ownerEmail: string;
  targetPages: number;
  version: number;
  status: string;
  generatedAt: string;
  grossCredits: number;
  refundedCredits: number;
  netCredits: number;
  revenueUsd: number;
  providerCostUsd: number;
  marginUsd: number;
  marginPercent: number | null;
};

export type AdminGeneratedPlanList = {
  plans: AdminGeneratedPlanSummary[];
  total: number;
  limit: number;
  offset: number;
};

export type AdminGeneratedPlanDetail = {
  planId: string;
  chargeCount: number;
  refundCount: number;
  grossCredits: number;
  refundedCredits: number;
  netCredits: number;
  revenueUsd: number;
  providerCostUsd: number;
  marginUsd: number;
  marginPercent: number | null;
  totals: CostUsage;
  byKind: Array<CostUsage & { kind: CostKind }>;
  purposes: OperationCost[];
};

export type AdminUserRow = {
  id: string;
  email: string;
  displayName: string | null;
  status: string;
  createdAt: string;
  availableCredits: number;
  planCredits: number;
  planCreditsPerPeriod: number;
  reservedCredits: number;
  lifetimeGranted: number;
  lifetimeSpent: number;
  projects: number;
  booksCompleted: number;
  cashUsd: number;
  subscriptionStatus: string | null;
  lastActivityAt: string | null;
};

export type AdminUserList = { users: AdminUserRow[]; total: number; limit: number; offset: number };

export type AdminUserSort = "recent" | "spend" | "cash" | "credits" | "projects";

export type AdminUserDetail = {
  user: { id: string; email: string; displayName: string | null; status: string; createdAt: string; disabledAt: string | null };
  credits: {
    available: number;
    purchased: number;
    planCredits: number;
    planCreditsPerPeriod: number;
    planPeriodEnd: string | null;
    reserved: number;
    lifetimeGranted: number;
    lifetimeSpent: number;
  };
  plan: { tier: string; illustratedBooksUsed: number | null };
  spendByOperation: NamedTotal[];
  purchases: Array<{ id: string; status: string; provider: string; creditsGranted: number; amountUsd: number | null; purchasedAt: string | null }>;
  subscriptions: Array<{ id: string; status: string; creditsPerPeriod: number; currentPeriodEnd: string | null; canceledAt: string | null }>;
  ledger: Array<{
    id: string;
    operation: string;
    entryType: string;
    status: string;
    amountCredits: number;
    projectId: string | null;
    pricingVersion: number | null;
    description: string | null;
    createdAt: string;
  }>;
  projects: Array<{
    id: string;
    title: string;
    status: string;
    targetPages: number;
    pages: number;
    createdAt: string;
    providerUsd: number;
    creditsCharged: number;
  }>;
  deletionRequests: Array<{ id: string; status: string; requestedAt: string }>;
};

export type AdminProjectDetail = {
  project: {
    id: string;
    title: string;
    status: string;
    category: string;
    language: string;
    targetPages: number;
    pages: number;
    images: number;
    createdAt: string;
    updatedAt: string;
  };
  owner: { id: string; email: string } | null;
  economics: {
    creditsCharged: number;
    revenueUsd: number;
    providerUsd: number;
    marginUsd: number;
    marginPercent: number | null;
    unpricedCalls: number;
  };
  spendByPurpose: NamedTotal[];
  jobs: Array<{ id: string; type: string; status: string; progress: number; durationMs: number | null; error: string | null; createdAt: string }>;
  ledger: Array<{ id: string; operation: string; entryType: string; status: string; amountCredits: number; pricingVersion: number | null; createdAt: string }>;
};

export type ShareFunnel = {
  sharesCreated: number;
  previewShares: number;
  fullShares: number;
  pdfViews: number;
  remixDrafts: number;
  remixBooks: number;
};

/** Shape of `serializeModerationReport` in apps/api/src/mobileSafety.ts — enums arrive lowercased. */
export type ModerationReport = {
  id: string;
  reporterUserId: string | null;
  reporterEmail: string | null;
  projectId: string | null;
  projectTitle: string | null;
  imageAssetId: string | null;
  bookShareId: string | null;
  /** "project", "image_asset" or "book_share". */
  targetType: string;
  /** What the target looked like when the report was filed; read through `readShareSnapshot`. */
  targetSnapshot?: unknown;
  /** The share as it is now, on the list route only. Null once the share is gone. */
  share?: AdminShare | null;
  reason: string;
  comment: string | null;
  status: string;
  reviewerUserId: string | null;
  reviewedAt: string | null;
  reviewNotes: string | null;
  createdAt: string;
  updatedAt: string;
};

/** Mirrors `AdminShareDto` in apps/api/src/routes/adminShares.ts. */
export type AdminShare = {
  id: string;
  slug: string;
  /** The public page; opened in a new tab. */
  url: string;
  projectId: string;
  mode: "preview" | "full";
  previewPages: number | null;
  status: "active" | "revoked" | "taken_down";
  caption: string | null;
  captionStatus: "none" | "allowed" | "pending_review" | "removed";
  /** A JSON column on the server; read through `readCaptionVerdict`, never trusted as typed. */
  captionVerdict: unknown;
  takedownReason: string | null;
  viewCount: number;
};

/** One physical call to the moderation gate — `ModerationAttemptRecord` in apps/api/src/userTextModeration.ts. */
export type ModerationAttempt = {
  role: "primary" | "fallback";
  provider: string;
  model: string;
  durationMs: number;
  selectedOption?: string;
  /** Jev's distribution over the options, summing to 1. */
  probabilities?: Record<string, number>;
  escalationReason?: string;
  error?: string;
};

/** `verdictRecord` in apps/api/src/mobile/shares/shareRecords.ts, plus the operator's decision once one is made. */
export type CaptionVerdict = {
  surface: string | null;
  verdict: "allowed" | "refused" | "undecided";
  reason: string | null;
  decidedBy: string | null;
  violation: string | null;
  decidedAt: string | null;
  attempts: ModerationAttempt[];
  operator: { action: string; reviewerUserId: string | null; at: string | null; reason: string | null } | null;
};

export type ShareModerationAction = "approve_caption" | "remove_caption" | "take_down";
