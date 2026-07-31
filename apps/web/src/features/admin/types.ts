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

export type AdminUserRow = {
  id: string;
  email: string;
  displayName: string | null;
  status: string;
  createdAt: string;
  availableCredits: number;
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
  credits: { available: number; reserved: number; lifetimeGranted: number; lifetimeSpent: number };
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
