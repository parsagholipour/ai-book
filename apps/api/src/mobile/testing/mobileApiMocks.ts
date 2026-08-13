import { vi } from "vitest";

/**
 * Module mocks for the mobile API suites.
 *
 * This file must import nothing but `vitest`. Vitest calls the factories below
 * from inside `vi.mock(...)`, and reaching any module that transitively imports
 * a mocked module from there deadlocks the mock registry.
 */

export const mockPrisma = ({
  $transaction: vi.fn(),
  user: { upsert: vi.fn() },
  mobileSession: { findUnique: vi.fn() },
  mobileCreationDraft: { findUnique: vi.fn(), findFirst: vi.fn(), findMany: vi.fn(), create: vi.fn(), update: vi.fn(), updateMany: vi.fn() },
  mobileCreationOutput: { create: vi.fn(), findFirst: vi.fn() },
  template: { findFirst: vi.fn(), findMany: vi.fn() },
  productCatalog: { findUnique: vi.fn() },
  project: { findUnique: vi.fn(), findFirst: vi.fn(), findMany: vi.fn(), create: vi.fn(), update: vi.fn(), updateMany: vi.fn(), delete: vi.fn() },
  page: { findFirst: vi.fn(), findMany: vi.fn(), update: vi.fn(), count: vi.fn() },
  pageEditSnapshot: { create: vi.fn() },
  planVersion: { findFirst: vi.fn(), findMany: vi.fn(), updateMany: vi.fn(), update: vi.fn() },
  projectChatMessage: { create: vi.fn(), findUnique: vi.fn(), findFirst: vi.fn(), findMany: vi.fn(), update: vi.fn(), updateMany: vi.fn() },
  bookEditOperation: {
    create: vi.fn(),
    update: vi.fn(),
    updateMany: vi.fn(),
    findUnique: vi.fn(),
    findUniqueOrThrow: vi.fn(),
    findFirst: vi.fn(),
    findMany: vi.fn()
  },
  generationJob: { count: vi.fn(), findUnique: vi.fn(), findFirst: vi.fn(), findMany: vi.fn(), create: vi.fn(), update: vi.fn() },
  generationAttempt: {
    findUnique: vi.fn(),
    findFirst: vi.fn(),
    findMany: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    updateMany: vi.fn()
  },
  creditLedgerEntry: { findMany: vi.fn(), update: vi.fn() },
  subscriptionState: { findMany: vi.fn(), findFirst: vi.fn(), update: vi.fn() },
  providerCallLog: { aggregate: vi.fn(), findMany: vi.fn(), groupBy: vi.fn() },
  imageAsset: { findFirst: vi.fn(), findMany: vi.fn(), findUnique: vi.fn(), update: vi.fn(), updateMany: vi.fn() },
  voiceCharacter: { findUnique: vi.fn(), findFirst: vi.fn(), findMany: vi.fn(), update: vi.fn() },
  voiceCall: { findFirst: vi.fn(), findMany: vi.fn(), create: vi.fn(), update: vi.fn(), updateMany: vi.fn(), delete: vi.fn() },
  voiceCallEvent: { create: vi.fn() },
  voiceConversation: { create: vi.fn(), findMany: vi.fn(), findUnique: vi.fn() },
  audiobook: {
    findUnique: vi.fn(),
    findFirst: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    deleteMany: vi.fn()
  },
  audiobookChapter: { findMany: vi.fn(), upsert: vi.fn(), update: vi.fn(), deleteMany: vi.fn() },
  libraryCharacter: {
    findFirst: vi.fn(),
    findMany: vi.fn(),
    count: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    updateMany: vi.fn(),
    deleteMany: vi.fn()
  },
  libraryCharacterImage: {
    findFirst: vi.fn(),
    findMany: vi.fn(),
    create: vi.fn(),
    delete: vi.fn(),
    deleteMany: vi.fn()
  }
});

/**
 * Defaults for the retained character pictures, re-applied after each
 * `vi.resetAllMocks()`.
 *
 * Every character write records one, so the useful default is "the row was
 * written and there is no history yet" rather than `undefined` — which would
 * 500 every upload in every suite that so much as touches a character. Lives
 * here rather than in the harness because that file is at its size budget, and
 * because everything this needs is already in this module.
 */
export function resetCharacterImageMocks(): void {
  mockPrisma.libraryCharacterImage.create.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({
    id: "character-image-1",
    createdAt: new Date("2026-08-01T10:00:00.000Z"),
    byteSize: null,
    width: null,
    height: null,
    photoKind: null,
    referenceEligible: false,
    ...data
  }));
  mockPrisma.libraryCharacterImage.findMany.mockResolvedValue([]);
  mockPrisma.libraryCharacterImage.findFirst.mockResolvedValue(null);
  mockPrisma.libraryCharacterImage.deleteMany.mockResolvedValue({ count: 1 });
  mockPrisma.libraryCharacterImage.delete.mockResolvedValue({ id: "character-image-1" });
}

export const mockBilling = (() => {
  class MockInsufficientCreditsError extends Error {
    readonly code = "INSUFFICIENT_CREDITS";
    readonly requiredCredits: number;
    readonly availableCredits: number;
    readonly reservedCredits: number;

    constructor(options: { requiredCredits: number; availableCredits: number; reservedCredits: number }) {
      super("Insufficient credits");
      this.requiredCredits = options.requiredCredits;
      this.availableCredits = options.availableCredits;
      this.reservedCredits = options.reservedCredits;
    }
  }

  class MockGenerationAttemptConflictError extends Error {
    readonly code = "GENERATION_COMMAND_CONFLICT";
  }

  class MockGenerationQuotaExceededError extends Error {
    readonly code = "IMAGE_LIMIT_REACHED";
    readonly claim: unknown;

    constructor(claim: unknown) {
      super("Image limit reached");
      this.claim = claim;
    }
  }

  return {
    InsufficientCreditsError: MockInsufficientCreditsError,
    GenerationAttemptConflictError: MockGenerationAttemptConflictError,
    GenerationQuotaExceededError: MockGenerationQuotaExceededError,
    ensureDefaultProductCatalog: vi.fn(),
    getCreditBalance: vi.fn(),
    listActiveUserEntitlements: vi.fn(),
    reserveCredits: vi.fn(),
    commitReservedCredits: vi.fn(),
    spendCredits: vi.fn(),
    refundCreditLedgerEntry: vi.fn(),
    releaseReservationsByKeyPrefix: vi.fn(async () => 0),
    grantProjectEntitlement: vi.fn(),
    hasActiveProjectEntitlement: vi.fn(),
    ensureProjectExportEntitlementOrSpend: vi.fn(),
    recordVerifiedGooglePlayPurchase: vi.fn(),
    endSubscriptionNow: vi.fn(async () => ({ ended: true, endedSubscriptionIds: ["sub-1"] })),
    hasActiveSubscriptionEntitlement: vi.fn(async () => false),
    ensureCurrentPlanPeriod: vi.fn(),
    resolvePlanTier: vi.fn(async () => "free"),
    getPlanSummary: vi.fn(async () => ({
      tier: "free",
      source: "free",
      status: null,
      renewsAt: null,
      cancelAtPeriodEnd: false,
      endsAt: null,
      productSku: null
    })),
    // Null is "no limit on this plan". Suites that want the free tier's limit
    // override this with a quota object.
    getImageQuota: vi.fn(async () => null),
    consumeIllustratedBookUse: vi.fn(async (_options?: unknown) => ({
      allowed: true,
      used: 1,
      limit: 3,
      periodKey: "2026-06",
      resetsAt: new Date("2026-07-01T00:00:00.000Z")
    })),
    releaseIllustratedBookUse: vi.fn(),
    startGenerationAttempt: vi.fn(),
    getGenerationAttempt: vi.fn(),
    markGenerationAttemptActive: vi.fn(),
    markGenerationAttemptSucceeded: vi.fn(),
    failGenerationAttempt: vi.fn(),
    reconcileGenerationAttemptRefunds: vi.fn()
  };
})();

export class MockPrismaKnownRequestError extends Error {
  readonly code: string;

  constructor(message: string, options: { code: string }) {
    super(message);
    this.code = options.code;
  }
}

export function dbModuleMock() {
  return {
    ensureSeedTemplates: vi.fn(),
    PLAN_REVISION_AUTOMATIC_RETRY_LIMIT: 2,
    canClaimPlanRevisionRetry: vi.fn(() => ({ eligible: true, staleActive: false, reason: null })),
    planRevisionRetryDelayMs: vi.fn(() => 30_000),
    retryRequestKey: vi.fn((id: string, attempt: number) => `plan-revision-retry:${id}:${attempt}`),
    // `DbNull` is a sentinel the quality-verdict query passes through to
    // Prisma; the mocks only ever compare the `where` it lands in, so any
    // stable, distinguishable value stands in for it.
    Prisma: {
      JsonNull: null,
      DbNull: "DbNull",
      PrismaClientKnownRequestError: MockPrismaKnownRequestError
    },
    prisma: mockPrisma
  };
}

export function billingModuleMock() {
  return mockBilling;
}

export const mockQueue = {
  cancelUndispatchedGenerationJob: vi.fn(),
  dispatchGenerationJob: vi.fn(),
  enqueueGenerationJob: vi.fn(),
  enqueueOrRequeueGenerationJob: vi.fn(),
  isBullJobActive: vi.fn(),
  requeueGenerationJob: vi.fn(),
  stopProjectGenerationJobs: vi.fn(),
  closeQueue: vi.fn()
};

export function queueModuleMock() {
  return mockQueue;
}

export const mockProjectStatus = {
  buildProjectStatus: vi.fn(),
    normalizeProjectQuality: vi.fn(() => ({
      state: "pending",
      score: null,
      issues: [],
      affectedPageIndexes: []
    })),
    normalizeTokenUsage: vi.fn(() => ({
      promptTokens: 0,
      outputTokens: 0,
      cacheHitTokens: 0,
      provisionalPromptTokens: 0,
      provisionalOutputTokens: 0,
      inFlightCalls: 0
  }))
};

export function projectStatusModuleMock() {
  return mockProjectStatus;
}

/** Resets every mock and rebuilds the default fixture. Call from `beforeEach`. */
