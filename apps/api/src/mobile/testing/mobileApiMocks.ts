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
  mobileCreationDraft: { findUnique: vi.fn(), findFirst: vi.fn(), findMany: vi.fn(), create: vi.fn(), update: vi.fn() },
  mobileCreationOutput: { create: vi.fn(), findFirst: vi.fn() },
  template: { findFirst: vi.fn(), findMany: vi.fn() },
  productCatalog: { findUnique: vi.fn() },
  project: { findUnique: vi.fn(), findFirst: vi.fn(), findMany: vi.fn(), create: vi.fn(), update: vi.fn(), delete: vi.fn() },
  page: { findMany: vi.fn(), update: vi.fn() },
  pageEditSnapshot: { create: vi.fn() },
  planVersion: { findFirst: vi.fn(), findMany: vi.fn(), updateMany: vi.fn(), update: vi.fn() },
  projectChatMessage: { create: vi.fn(), findUnique: vi.fn(), findFirst: vi.fn(), findMany: vi.fn(), update: vi.fn(), updateMany: vi.fn() },
  bookEditOperation: { create: vi.fn(), update: vi.fn(), updateMany: vi.fn(), findUnique: vi.fn(), findFirst: vi.fn(), findMany: vi.fn() },
  generationJob: { count: vi.fn(), findUnique: vi.fn(), findFirst: vi.fn(), findMany: vi.fn(), create: vi.fn(), update: vi.fn() },
  creditLedgerEntry: { update: vi.fn() },
  providerCallLog: { aggregate: vi.fn(), findMany: vi.fn(), groupBy: vi.fn() },
  imageAsset: { findFirst: vi.fn(), findMany: vi.fn() },
  voiceCharacter: { findUnique: vi.fn(), findFirst: vi.fn(), findMany: vi.fn() },
  voiceCallEvent: { create: vi.fn() },
  voiceConversation: { create: vi.fn(), findMany: vi.fn(), findUnique: vi.fn() }
});

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

  return {
    InsufficientCreditsError: MockInsufficientCreditsError,
    ensureDefaultProductCatalog: vi.fn(),
    getCreditBalance: vi.fn(),
    listActiveUserEntitlements: vi.fn(),
    reserveCredits: vi.fn(),
    commitReservedCredits: vi.fn(),
    refundCreditLedgerEntry: vi.fn(),
    grantProjectEntitlement: vi.fn(),
    hasActiveProjectEntitlement: vi.fn(),
    ensureProjectExportEntitlementOrSpend: vi.fn(),
    recordVerifiedGooglePlayPurchase: vi.fn()
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
    Prisma: { JsonNull: null, PrismaClientKnownRequestError: MockPrismaKnownRequestError },
    prisma: mockPrisma
  };
}

export function billingModuleMock() {
  return mockBilling;
}

export const mockQueue = {
  dispatchGenerationJob: vi.fn(),
  enqueueGenerationJob: vi.fn(),
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
