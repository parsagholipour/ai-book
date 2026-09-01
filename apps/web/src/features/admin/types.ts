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

export type AdminCostBreakdown = {
  window: { days: number; since: string; until: string };
  totals: CostUsage;
  byKind: Array<CostUsage & { kind: CostKind }>;
  operations: OperationCost[];
  models: ModelCost[];
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
  qualityGates: QualityGateCost[];
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

/** Shape of `serializeModerationReport` in apps/api/src/mobileSafety.ts — enums arrive lowercased. */
export type ModerationReport = {
  id: string;
  reporterUserId: string | null;
  reporterEmail: string | null;
  projectId: string | null;
  projectTitle: string | null;
  imageAssetId: string | null;
  targetType: string;
  reason: string;
  comment: string | null;
  status: string;
  reviewerUserId: string | null;
  reviewedAt: string | null;
  reviewNotes: string | null;
  createdAt: string;
  updatedAt: string;
};
