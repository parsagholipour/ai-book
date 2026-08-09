import Fastify, { type FastifyInstance } from "fastify";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { vi } from "vitest";
import { hashToken } from "../../mobileAuth.js";
import type { enqueueGenerationJob } from "../../queue.js";
import type { CreditBalance } from "@book-maker/db/billing";
import {
  MockPrismaKnownRequestError,
  mockBilling,
  mockPrisma,
  mockProjectStatus,
  mockQueue
} from "./mobileApiMocks.js";
import { installGenerationAttemptMock } from "./mobileApiGenerationAttemptMock.js";

/**
 * Shared harness for the mobile API suites in this directory.
 *
 * The suites are split by topic but share one set of module mocks and one
 * `beforeEach` fixture, so wiring changes stay in a single place. Each suite
 * file declares its own `vi.mock(...)` calls (Vitest hoists them per file) and
 * delegates to the `*ModuleMock` factories below.
 */

type QueuedGenerationJobRecord = Awaited<ReturnType<typeof enqueueGenerationJob>>;

/** Fixture state rebuilt by `resetMobileHarness` and reassignable from tests. */
export const state = {
  bookStorageDir: null as string | null,
  imageStorageDir: null as string | null,
  voiceStorageDir: null as string | null,
  audioStorageDir: null as string | null,
  projectChatMessages: [] as any[],
  planVersions: [] as any[],
  bookEditOperations: [] as any[],
  pages: [] as any[],
  pageEditSnapshots: [] as any[],
  generationAttempts: [] as any[]
};

export const originalEnv = { ...process.env };

export { MockPrismaKnownRequestError, mockBilling, mockPrisma, mockProjectStatus, mockQueue };

/** Resets every mock and rebuilds the default fixture. Call from `beforeEach`. */
export function resetMobileHarness(): void {
  vi.resetAllMocks();
  mockPrisma.user.upsert.mockResolvedValue({ id: "local-admin" });
  mockPrisma.project.findFirst.mockImplementation((...args: unknown[]) => mockPrisma.project.findUnique(...args));
  mockPrisma.$transaction.mockImplementation(async (operationOrOperations: unknown) => {
    if (Array.isArray(operationOrOperations)) {
      return Promise.all(operationOrOperations);
    }
    return (operationOrOperations as (tx: typeof mockPrisma) => Promise<unknown>)(mockPrisma);
  });
  mockBilling.ensureDefaultProductCatalog.mockResolvedValue(undefined);
  mockPrisma.productCatalog.findUnique.mockResolvedValue({
    sku: "tomeza.one_book_export",
    productType: "ONE_TIME_UNLOCK",
    active: true
  });
  mockBilling.getCreditBalance.mockResolvedValue({
    availableCredits: 0,
    reservedCredits: 0,
    lifetimeCreditsGranted: 0,
    lifetimeCreditsSpent: 0
  });
  mockBilling.listActiveUserEntitlements.mockResolvedValue([]);
  mockBilling.reserveCredits.mockImplementation(async ({ amountCredits, operation }: { amountCredits: number; operation: string }) =>
    amountCredits > 0
      ? {
          id: `ledger-${operation}`,
          userId: "user-a",
          projectId: "project-1",
          operation,
          amountCredits: -amountCredits,
          entryType: "RESERVE",
          status: "RESERVED",
          idempotencyKey: `test-${operation}`
        }
      : null
  );
  mockBilling.commitReservedCredits.mockImplementation(async (id: string) => ({
    id,
    userId: "user-a",
    projectId: "project-1",
    operation: id.includes("FULL_BOOK") ? "FULL_BOOK_GENERATION" : "PLAN_GENERATION",
    amountCredits: -1000,
    entryType: "SPEND",
    status: "SETTLED",
    idempotencyKey: `test-${id}`
  }));
  installGenerationAttemptMock({ mockBilling, mockPrisma, state });
  mockBilling.refundCreditLedgerEntry.mockResolvedValue(null);
  mockBilling.grantProjectEntitlement.mockResolvedValue({
    id: "entitlement-export",
    userId: "user-a",
    projectId: "project-1",
    type: "EXPORT_UNLOCK",
    status: "ACTIVE",
    source: "credits",
    creditsCost: 1000,
    startsAt: new Date("2026-06-15T12:00:00.000Z"),
    expiresAt: null
  });
  mockBilling.hasActiveProjectEntitlement.mockResolvedValue(false);
  mockBilling.ensureProjectExportEntitlementOrSpend.mockResolvedValue({
    entitlement: {
      id: "entitlement-export",
      userId: "user-a",
      projectId: "project-a",
      type: "EXPORT_UNLOCK",
      status: "ACTIVE",
      source: "credits",
      creditsCost: 150,
      startsAt: new Date("2026-06-15T12:00:00.000Z"),
      expiresAt: null
    },
    chargedLedgerEntry: null
  });
  mockBilling.recordVerifiedGooglePlayPurchase.mockResolvedValue({
    purchaseRecordId: "purchase-1",
    status: "GRANTED",
    creditsGranted: 1000,
    ledgerEntryId: "ledger-purchase",
    subscriptionStatus: null,
    entitlementType: null
  });
  // The approval guards read the counts of their conditional writes; a bare
  // vi.fn() resolving undefined would fail every approval in every suite.
  mockPrisma.planVersion.updateMany.mockResolvedValue({ count: 1 });
  mockPrisma.project.updateMany.mockResolvedValue({ count: 1 });
  mockQueue.enqueueGenerationJob.mockResolvedValue(jobRecord());
  mockQueue.dispatchGenerationJob.mockImplementation(async (id: string) => jobRecord({ id }));
  // Compensation paths refund only when the cancel claims the row; an
  // undispatched row in these tests is always claimable.
  mockQueue.cancelUndispatchedGenerationJob.mockResolvedValue(true);
  mockQueue.isBullJobActive.mockResolvedValue(false);
  mockQueue.requeueGenerationJob.mockResolvedValue(jobRecord({ id: "job-resumed", status: "QUEUED" }));
  mockProjectStatus.buildProjectStatus.mockResolvedValue(statusRecord());
  mockPrisma.generationJob.count.mockResolvedValue(0);
  mockPrisma.generationJob.findUnique.mockResolvedValue(null);
  mockPrisma.mobileCreationDraft.findUnique.mockResolvedValue({ revision: 3 });
  mockPrisma.mobileCreationDraft.update.mockResolvedValue(creationDraftRecord({ revision: 2 }));
  mockPrisma.creditLedgerEntry.findMany.mockResolvedValue([]);
  mockPrisma.creditLedgerEntry.update.mockResolvedValue({});
  mockPrisma.project.update.mockResolvedValue({ contentRevision: 1 });
  mockPrisma.project.delete.mockResolvedValue({});
  mockPrisma.project.create.mockImplementation(async ({ data }: { data: Record<string, any> }) =>
    projectRecord({
      id: "project-copy",
      ...data,
      currentPlanId: null,
      currentPlan: null,
      pages: [],
      createdAt: new Date("2026-06-15T12:30:00.000Z"),
      updatedAt: new Date("2026-06-15T12:30:00.000Z")
    })
  );
  state.projectChatMessages = [];
  state.planVersions = [];
  state.bookEditOperations = [];
  state.generationAttempts = [];
  mockPrisma.projectChatMessage.create.mockImplementation(async ({ data }: { data: Record<string, any> }) => {
    const record = {
      id: `chat-${state.projectChatMessages.length + 1}`,
      projectId: data.projectId,
      requestId: data.requestId ?? null,
      parentId: data.parentId ?? null,
      role: data.role,
      content: data.content,
      operationId: data.operationId ?? null,
      metadata: data.metadata ?? {},
      isActiveChild: data.isActiveChild ?? true,
      createdAt: new Date(`2026-06-15T12:${String(state.projectChatMessages.length).padStart(2, "0")}:00.000Z`)
    };
    state.projectChatMessages.push(record);
    return record;
  });
  mockPrisma.projectChatMessage.findFirst.mockImplementation(async ({ where }: { where: Record<string, any> }) => {
    return state.projectChatMessages.find((message) => matchesProjectChatWhere(message, where)) ?? null;
  });
  mockPrisma.projectChatMessage.findUnique.mockImplementation(
    async ({ where }: { where: { projectId_requestId?: { projectId: string; requestId: string } } }) => {
      const key = where.projectId_requestId;
      return key
        ? state.projectChatMessages.find(
            (message) => message.projectId === key.projectId && message.requestId === key.requestId
          ) ?? null
        : null;
    }
  );
  mockPrisma.projectChatMessage.findMany.mockImplementation(async ({ where, orderBy, take }: { where: Record<string, any>; orderBy?: { createdAt: "asc" | "desc" }; take?: number }) => {
    const rows = state.projectChatMessages.filter((message) => matchesProjectChatWhere(message, where));
    const sorted = [...rows].sort((a, b) =>
      orderBy?.createdAt === "desc"
        ? b.createdAt.getTime() - a.createdAt.getTime() || b.id.localeCompare(a.id)
        : a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id)
    );
    return typeof take === "number" ? sorted.slice(0, take) : sorted;
  });
  mockPrisma.projectChatMessage.update.mockImplementation(async ({ where, data }: { where: { id: string }; data: Record<string, any> }) => {
    const message = state.projectChatMessages.find((candidate) => candidate.id === where.id);
    if (!message) {
      throw new Error(`Chat message not found: ${where.id}`);
    }
    Object.assign(message, data);
    return message;
  });
  state.pages = [];
  state.pageEditSnapshots = [];
  mockPrisma.page.findMany.mockImplementation(async ({ where }: { where: Record<string, any> }) => {
    const matchesContainsClause = (page: Record<string, any>, clause: Record<string, any>) =>
      Object.entries(clause).every(([field, condition]) =>
        typeof (condition as { contains?: string })?.contains === "string"
          ? String(page[field] ?? "")
              .toLowerCase()
              .includes((condition as { contains: string }).contains.toLowerCase())
          : true
      );
    return state.pages
      .filter(
        (page) =>
          (where.projectId === undefined || page.projectId === where.projectId) &&
          (where.id?.in === undefined || where.id.in.includes(page.id)) &&
          (where.index?.in === undefined || where.index.in.includes(page.index)) &&
          (where.OR === undefined || where.OR.some((clause: Record<string, any>) => matchesContainsClause(page, clause)))
      )
      .map((page) => ({ ...page }));
  });
  mockPrisma.page.update.mockImplementation(async ({ where, data }: { where: { id: string }; data: Record<string, any> }) => {
    const page = state.pages.find((candidate) => candidate.id === where.id);
    if (!page) {
      throw new Error(`Page not found: ${where.id}`);
    }
    const { revision, ...rest } = data;
    Object.assign(page, rest);
    if (revision?.increment) {
      page.revision += revision.increment;
    }
    return { ...page };
  });
  mockPrisma.pageEditSnapshot.create.mockImplementation(async ({ data }: { data: Record<string, any> }) => {
    const record = { id: `snapshot-${state.pageEditSnapshots.length + 1}`, ...data };
    state.pageEditSnapshots.push(record);
    return record;
  });
  mockPrisma.projectChatMessage.updateMany.mockImplementation(async ({ where, data }: { where: Record<string, any>; data: Record<string, any> }) => {
    let count = 0;
    for (const message of state.projectChatMessages) {
      if (!matchesProjectChatWhere(message, where)) {
        continue;
      }
      Object.assign(message, data);
      count += 1;
    }
    return { count };
  });
  mockPrisma.planVersion.findMany.mockImplementation(async ({ where, orderBy, take }: { where: { projectId: string }; orderBy?: { version: "asc" | "desc" }; take?: number }) => {
    const rows = state.planVersions.filter((planVersion) => planVersion.projectId === where.projectId);
    const sorted = [...rows].sort((a, b) =>
      orderBy?.version === "desc" ? b.version - a.version : a.version - b.version
    );
    return typeof take === "number" ? sorted.slice(0, take) : sorted;
  });
  mockPrisma.bookEditOperation.create.mockImplementation(async ({ data }: { data: Record<string, any> }) => {
    // Production's @@unique([projectId, requestId]) is what settles a raced
    // Apply; without it here the loser path could never be exercised.
    if (
      data.requestId &&
      state.bookEditOperations.some(
        (operation) => operation.projectId === data.projectId && operation.requestId === data.requestId
      )
    ) {
      throw new MockPrismaKnownRequestError(
        "Unique constraint failed on the fields: (`projectId`,`requestId`)",
        { code: "P2002" }
      );
    }
    const record = {
      id: `operation-${state.bookEditOperations.length + 1}`,
      projectId: data.projectId,
      requestId: data.requestId ?? null,
      userMessageId: data.userMessageId ?? null,
      assistantMessageId: null,
      generationJobId: data.generationJobId ?? null,
      ledgerEntryId: data.ledgerEntryId ?? null,
      kind: data.kind,
      status: data.status ?? "QUEUED",
      request: data.request,
      classifier: data.classifier,
      affectedPageIndexes: data.affectedPageIndexes ?? [],
      creditsCharged: data.creditsCharged ?? 0,
      automaticRetryCount: data.automaticRetryCount ?? 0,
      automaticRetryLimit: data.automaticRetryLimit ?? 2,
      nextRetryAt: data.nextRetryAt ?? null,
      lastRetryAt: data.lastRetryAt ?? null,
      lastRetryReason: data.lastRetryReason ?? null,
      retryRequestId: data.retryRequestId ?? null,
      error: null,
      generationJob: null,
      createdAt: new Date(`2026-06-15T13:${String(state.bookEditOperations.length).padStart(2, "0")}:00.000Z`),
      updatedAt: new Date(`2026-06-15T13:${String(state.bookEditOperations.length).padStart(2, "0")}:00.000Z`),
      appliedAt: null
    };
    state.bookEditOperations.push(record);
    return record;
  });
  mockPrisma.bookEditOperation.update.mockImplementation(async ({ where, data, include }: { where: { id: string }; data: Record<string, any>; include?: unknown }) => {
    const record = state.bookEditOperations.find((operation) => operation.id === where.id);
    if (!record) {
      throw new Error(`Operation not found: ${where.id}`);
    }
    const { automaticRetryCount, ...rest } = data;
    Object.assign(record, rest, { updatedAt: new Date("2026-06-15T13:59:00.000Z") });
    if (typeof automaticRetryCount === "number") record.automaticRetryCount = automaticRetryCount;
    if (automaticRetryCount?.increment) record.automaticRetryCount += automaticRetryCount.increment;
    if (data.generationJobId) {
      record.generationJob = { id: data.generationJobId, status: "QUEUED" };
    }
    return include ? record : { ...record, generationJob: undefined };
  });
  mockPrisma.bookEditOperation.findMany.mockImplementation(async ({ where, orderBy, take, include }: { where: { projectId: string }; orderBy?: { createdAt: "asc" | "desc" }; take?: number; include?: Record<string, any> }) => {
    const rows = state.bookEditOperations.filter((operation) => operation.projectId === where.projectId);
    const sorted = [...rows].sort((a, b) =>
      orderBy?.createdAt === "asc"
        ? a.createdAt.getTime() - b.createdAt.getTime()
        : b.createdAt.getTime() - a.createdAt.getTime()
    );
    const page = typeof take === "number" ? sorted.slice(0, take) : sorted;
    if (!include?._count?.select?.snapshots) {
      return page;
    }
    return page.map((operation) => ({
      ...operation,
      _count: {
        snapshots:
          operation._count?.snapshots ??
          state.pageEditSnapshots.filter((snapshot) => snapshot.operationId === operation.id).length
      }
    }));
  });
  mockPrisma.bookEditOperation.findUnique.mockImplementation(async ({ where }: { where: { id?: string } }) =>
    state.bookEditOperations.find((operation) => operation.id === where.id) ?? null
  );
  mockPrisma.bookEditOperation.findUniqueOrThrow.mockImplementation(async ({ where }: { where: { id?: string } }) => {
    const operation = state.bookEditOperations.find((candidate) => candidate.id === where.id);
    if (!operation) throw new Error(`Operation not found: ${where.id}`);
    return operation;
  });
  mockPrisma.bookEditOperation.updateMany.mockImplementation(async ({ where, data }: { where: Record<string, any>; data: Record<string, any> }) => {
    const record = state.bookEditOperations.find((operation) => operation.id === where.id);
    if (
      !record ||
      (where.status !== undefined && record.status !== where.status) ||
      (where.generationJobId !== undefined && (record.generationJobId ?? null) !== where.generationJobId)
    )
      return { count: 0 };
    const { automaticRetryCount, ...rest } = data;
    Object.assign(record, rest);
    if (typeof automaticRetryCount === "number") record.automaticRetryCount = automaticRetryCount;
    if (automaticRetryCount?.increment) record.automaticRetryCount += automaticRetryCount.increment;
    return { count: 1 };
  });
  mockPrisma.bookEditOperation.findFirst.mockImplementation(async ({ where, include }: { where: Record<string, any>; include?: Record<string, any> }) => {
    const operation =
      state.bookEditOperations.find(
        (operation) =>
          (where.projectId === undefined || operation.projectId === where.projectId) &&
          (typeof where.id !== "string" || operation.id === where.id) &&
          (where.id?.not === undefined || operation.id !== where.id.not) &&
          (where.requestId === undefined || operation.requestId === where.requestId) &&
          (where.userMessageId === undefined || operation.userMessageId === where.userMessageId) &&
          (where.kind === undefined || operation.kind === where.kind) &&
          (typeof where.status !== "string" || operation.status === where.status) &&
          (where.status?.in === undefined || where.status.in.includes(operation.status))
      ) ?? null;
    if (!operation || !include?.snapshots) {
      return operation;
    }
    return {
      ...operation,
      snapshots: state.pageEditSnapshots
        .filter((snapshot) => snapshot.operationId === operation.id)
        .sort((a, b) => a.pageIndex - b.pageIndex)
    };
  });
  mockPrisma.mobileCreationOutput.create.mockImplementation(async ({ data, include }: { data: Record<string, any>; include?: unknown }) => ({
    id: `output-${data.projectId}`,
    draftId: data.draftId,
    projectId: data.projectId,
    requestId: data.requestId ?? null,
    title: data.title,
    sequence: data.sequence,
    createdAt: new Date("2026-06-15T12:00:00.000Z"),
    updatedAt: new Date("2026-06-15T12:00:00.000Z"),
    ...(include ? { project: { title: data.title, updatedAt: new Date("2026-06-15T12:00:00.000Z") } } : {})
  }));
  mockPrisma.mobileCreationOutput.findFirst.mockResolvedValue(null);
  state.bookStorageDir = mkdtempSync(join(tmpdir(), "book-maker-mobile-books-"));
  state.imageStorageDir = mkdtempSync(join(tmpdir(), "book-maker-mobile-images-"));
  state.voiceStorageDir = mkdtempSync(join(tmpdir(), "book-maker-mobile-voice-"));
  state.audioStorageDir = mkdtempSync(join(tmpdir(), "book-maker-mobile-audio-"));
  process.env = {
    ...originalEnv,
    WEB_PASSWORD: "",
    // All model provider keys are cleared so chat routing deterministically
    // uses the heuristic fallback instead of live LLM calls from .env keys.
    OPENAI_API_KEY: "",
    GEMINI_API_KEY: "",
    DEEPSEEK_API_KEY: "",
    DEEPINFRA_API_KEY: "",
    ALIBABA_API_KEY: "",
    LOCAL_TEXT_API_KEY: "",
    CLOUDFLARE_API_TOKEN: "",
    CLOUDFLARE_TURN_TOKEN: "",
    BOOK_STORAGE_DIR: state.bookStorageDir,
    IMAGE_STORAGE_DIR: state.imageStorageDir,
    VOICE_STORAGE_DIR: state.voiceStorageDir,
    AUDIO_STORAGE_DIR: state.audioStorageDir
  };
}

/** Restores env and removes temp storage dirs. Call from `afterEach`. */
export function teardownMobileHarness(): void {
  process.env = { ...originalEnv };
  if (state.bookStorageDir) {
    rmSync(state.bookStorageDir, { recursive: true, force: true });
    state.bookStorageDir = null;
  }
  if (state.imageStorageDir) {
    rmSync(state.imageStorageDir, { recursive: true, force: true });
    state.imageStorageDir = null;
  }
  if (state.voiceStorageDir) {
    rmSync(state.voiceStorageDir, { recursive: true, force: true });
    state.voiceStorageDir = null;
  }
  if (state.audioStorageDir) {
    rmSync(state.audioStorageDir, { recursive: true, force: true });
    state.audioStorageDir = null;
  }
}

export function mockAccessTokens(tokensByRawToken: Record<string, string>) {
  mockPrisma.mobileSession.findUnique.mockImplementation(async ({ where }: { where: { accessTokenHash?: string } }) => {
    const userEntry = Object.entries(tokensByRawToken).find(([token]) => hashToken(token) === where.accessTokenHash);
    if (!userEntry) {
      return null;
    }
    const [, userId] = userEntry;
    return {
      id: `session-${userId}`,
      userId,
      accessTokenExpiresAt: new Date("2999-06-15T08:15:00.000Z"),
      refreshTokenExpiresAt: new Date("2999-07-15T08:00:00.000Z"),
      revokedAt: null,
      user: {
        id: userId,
        email: `${userId}@example.com`,
        displayName: userId,
        status: "ACTIVE",
        disabledAt: null,
        createdAt: new Date("2026-06-01T12:00:00.000Z"),
        updatedAt: new Date("2026-06-01T12:00:00.000Z")
      }
    };
  });
}

export function bearer(token: string) {
  return { authorization: `Bearer ${token}` };
}

/**
 * A `CreditBalance` with both pools filled in. `availableCredits` is what the
 * user can spend in total, so pass it and let the pools default to purchased
 * unless a test is specifically about the allowance.
 */
export function creditBalance(overrides: Partial<CreditBalance> = {}): CreditBalance {
  const available = overrides.availableCredits ?? 1000;
  return {
    availableCredits: available,
    purchasedCredits: available,
    planCredits: 0,
    planCreditsPerPeriod: 0,
    planPeriodEnd: null,
    planPeriodKey: null,
    reservedCredits: 0,
    lifetimeCreditsGranted: available,
    lifetimeCreditsSpent: 0,
    ...overrides
  };
}

export function projectRecord(overrides: Record<string, unknown> = {}) {
  return {
    id: "project-1",
    userId: "user-a",
    title: "Owned Book",
    subtitle: null,
    authorName: null,
    coverTagline: null,
    prompt: "Write a useful guide with enough detail to pass validation.",
    category: "BUSINESS",
    subcategory: "Lead Magnet Ebook",
    targetPages: 12,
    complexity: 5,
    temperature: 0.7,
    language: "en",
    mediaSettings: {
      fullIllustrations: true,
      illustrationCadence: "template-driven",
      includeCover: true,
      coverTemplate: "business",
      finalReview: true,
      toneProfile: "neutral",
      mobile: {
        bookType: "lead_magnet",
        lengthPreset: "short",
        qualityPreset: "balanced",
        imagesEnabled: true
      }
    },
    status: "DRAFT",
    contentRevision: 0,
    templateId: null,
    currentPlanId: null,
    currentPlan: null,
    chapters: [],
    pages: [],
    research: [],
    _count: { pages: 0, images: 0, jobs: 0 },
    createdAt: new Date("2026-06-01T12:00:00.000Z"),
    updatedAt: new Date("2026-06-01T12:00:00.000Z"),
    ...overrides
  };
}

export function approvedPlanRecord(overrides: Record<string, unknown> = {}) {
  return {
    id: "plan-1",
    projectId: "project-1",
    version: 1,
    status: "APPROVED",
    planningPackage: {
      title: "The Race Between Rabbit and Turtle",
      premise: "Rabbit and Turtle learn that steady effort matters.",
      audience: "Young readers",
      writingComplexity: 3,
      voiceGuide: ["Warm", "Simple"],
      antiAiRules: ["No meta commentary"],
      questions: [],
      chapters: [
        {
          index: 1,
          title: "The Race",
          summary: "Rabbit and Turtle begin their race.",
          targetPages: 2,
          keyBeats: ["Rabbit runs fast.", "Turtle keeps going."]
        }
      ],
      characters: [
        {
          name: "Rabbit",
          role: "Racer",
          description: "A fast and overconfident rabbit.",
          traits: ["quick"],
          visualRules: ["small rabbit"]
        },
        {
          name: "Turtle",
          role: "Racer",
          description: "A steady turtle.",
          traits: ["patient"],
          visualRules: ["green turtle"]
        }
      ],
      locations: [],
      continuityRules: [],
      researchQueries: [],
      researchNotes: [],
      illustrationPlan: {
        cadence: "template-driven",
        globalStyle: "Warm children's storybook art",
        characterReferencePrompts: [],
        pageRules: []
      }
    },
    inputSnapshot: {},
    messages: [],
    createdAt: new Date("2026-06-15T10:00:00.000Z"),
    updatedAt: new Date("2026-06-15T10:00:00.000Z"),
    approvedAt: new Date("2026-06-15T10:05:00.000Z"),
    ...overrides
  };
}

/** An applied page edit — the kind that snapshots pages and can be reviewed. */
export function appliedEditOperationRecord(overrides: Record<string, unknown> = {}) {
  return {
    id: "operation-applied",
    projectId: "project-1",
    userMessageId: "chat-user-1",
    assistantMessageId: "chat-assistant-1",
    generationJobId: null,
    ledgerEntryId: null,
    kind: "LOCAL_PATCH",
    status: "APPLIED",
    requestId: "edit-request-1",
    automaticRetryCount: 0,
    automaticRetryLimit: 2,
    nextRetryAt: null,
    lastRetryAt: null,
    lastRetryReason: null,
    retryRequestId: null,
    request: 'On page 1, replace "night" with "day".',
    classifier: {},
    affectedPageIndexes: [1],
    creditsCharged: 35,
    error: null,
    generationJob: null,
    createdAt: new Date("2026-06-15T13:10:00.000Z"),
    updatedAt: new Date("2026-06-15T13:11:00.000Z"),
    appliedAt: new Date("2026-06-15T13:11:00.000Z"),
    ...overrides
  };
}

export function failedPlanRevisionOperationRecord(overrides: Record<string, unknown> = {}) {
  return {
    id: "operation-failed-revision",
    projectId: "project-1",
    userMessageId: "chat-user-1",
    assistantMessageId: "chat-assistant-1",
    generationJobId: "job-failed-revision",
    ledgerEntryId: "ledger-PLAN_REVISION",
    ledgerEntry: { id: "ledger-PLAN_REVISION", status: "REFUNDED", entryType: "REFUND" },
    kind: "PLAN_REVISION",
    status: "FAILED",
    requestId: "revision-original-request",
    automaticRetryCount: 0,
    automaticRetryLimit: 2,
    nextRetryAt: null,
    lastRetryAt: null,
    lastRetryReason: null,
    retryRequestId: null,
    request: "Make it brighter.",
    classifier: {},
    affectedPageIndexes: [],
    creditsCharged: 40,
    error: "AI plan revision failed. No revised plan was created.",
    generationJob: {
      id: "job-failed-revision",
      status: "FAILED",
      payload: {
        planId: "plan-1",
        message: "Make it brighter.",
        editOperationId: "operation-failed-revision",
        billingLedgerEntryId: "ledger-PLAN_REVISION"
      },
      startedAt: new Date("2026-06-15T13:00:00.000Z"),
      updatedAt: new Date("2026-06-15T13:01:00.000Z")
    },
    generationAttempts: [
      {
        id: "attempt-failed-revision",
        commandKey: "mobile:edit-operation:operation-failed-revision",
        status: "FAILED",
        operation: "PLAN_REVISION",
        quotedCredits: 40,
        refundPending: false,
        retryOfAttemptId: null,
        createdAt: new Date("2026-06-15T13:00:00.000Z")
      }
    ],
    createdAt: new Date("2026-06-15T13:00:00.000Z"),
    updatedAt: new Date("2026-06-15T13:01:00.000Z"),
    appliedAt: null,
    ...overrides
  };
}

export function matchesProjectChatWhere(message: Record<string, any>, where: Record<string, any>): boolean {
  if (where.projectId !== undefined && message.projectId !== where.projectId) {
    return false;
  }
  if (where.id !== undefined && message.id !== where.id) {
    return false;
  }
  if (where.role !== undefined && message.role !== where.role) {
    return false;
  }
  if (where.requestId !== undefined && message.requestId !== where.requestId) {
    return false;
  }
  if (where.operationId !== undefined && message.operationId !== where.operationId) {
    return false;
  }
  if (where.isActiveChild !== undefined && message.isActiveChild !== where.isActiveChild) {
    return false;
  }
  if (Object.prototype.hasOwnProperty.call(where, "parentId") && (message.parentId ?? null) !== where.parentId) {
    return false;
  }
  return true;
}

export function generatedPages() {
  return [
    {
      id: "page-1",
      index: 1,
      title: "Rabbit Starts Fast",
      markdown: "Rabbit runs ahead at the start of the race.",
      summary: "Rabbit starts the race quickly.",
      imagePrompt: null,
      status: "COMPLETED"
    },
    {
      id: "page-2",
      index: 2,
      title: "Rabbit Learns",
      markdown: "Rabbit sees Turtle finish and learns to be kind.",
      summary: "Rabbit learns from Turtle.",
      imagePrompt: null,
      status: "COMPLETED"
    }
  ];
}

export function editablePages() {
  return generatedPages().map((page) => ({
    ...page,
    projectId: "project-1",
    revision: 1
  }));
}

export function creationPayload(
  overrides: {
    brief?: Partial<Record<string, unknown>>;
    selectedPresets?: Partial<Record<string, unknown>>;
  } = {}
) {
  return {
    brief: {
      intent: "collect_leads",
      topic: "Pricing guide",
      audience: "solo consultants",
      readerProblem: "They are unsure how to package the offer.",
      desiredOutcome: "price a starter offer",
      tone: "practical and direct",
      mustInclude: "Include a checklist and examples.",
      distributionUse: "email opt-in",
      sourceNotes: "",
      ...overrides.brief
    },
    selectedPresets: {
      bookType: "lead_magnet",
      lengthPreset: "short",
      qualityPreset: "balanced",
      imagesEnabled: true,
      ...overrides.selectedPresets
    }
  };
}

export function creationDraftRecord(overrides: Record<string, unknown> = {}) {
  return {
    id: "draft-1",
    userId: "user-a",
    payload: creationPayload(),
    advisorSnapshot: null,
    createdProjectId: null,
    status: "ACTIVE",
    createdAt: new Date("2026-06-15T12:00:00.000Z"),
    updatedAt: new Date("2026-06-15T12:00:00.000Z"),
    ...overrides
  };
}

export function jobRecord(overrides: Partial<QueuedGenerationJobRecord> = {}): QueuedGenerationJobRecord {
  return {
    id: "job-1",
    projectId: "project-1",
    type: "PLAN_BOOK" as const,
    status: "QUEUED" as const,
    progress: 0,
    message: "Queued",
    error: null,
    bullJobId: "bull-1",
    payload: {},
    steps: null,
    startedAt: null,
    finishedAt: null,
    createdAt: new Date("2026-06-15T12:00:00.000Z"),
    updatedAt: new Date("2026-06-15T12:00:00.000Z"),
    ...overrides
  } as QueuedGenerationJobRecord;
}

export function statusRecord(overrides: Record<string, any> = {}) {
  const base = {
    project: {
      id: "project-1",
      title: "Owned Book",
      status: "DRAFT",
      targetPages: 12,
      mediaSettings: { fullIllustrations: true, includeCover: true },
      currentPlan: null,
      updatedAt: new Date("2026-06-15T12:00:00.000Z"),
      jobs: []
    },
    quality: {
      state: "pending" as const,
      score: null,
      issues: [],
      affectedPageIndexes: []
    },
    progress: {
      pages: { complete: 0, target: 12 },
      images: 0,
      research: 0,
      failedJobs: 0,
      resumableFailedJobs: 0,
      openImageJobs: 0,
      hasCompileJob: false,
      pipeline: [
        { key: "plan", label: "Plan", status: "pending" },
        { key: "pages", label: "Pages", status: "pending", detail: "0/12 pages" },
        { key: "images", label: "Images", status: "pending", detail: "0 images" },
        { key: "export", label: "Export", status: "pending" }
      ],
      tokens: {},
      cost: null,
      quality: { reviewedPages: 0, repairedPages: 0, blockedPages: 0 }
    }
  };
  return {
    ...base,
    ...overrides,
    project: { ...base.project, ...overrides.project },
    progress: { ...base.progress, ...overrides.progress }
  };
}

export function writeProjectFile(storageDir: string | null, projectId: string, filename: string, content: string) {
  if (!storageDir) {
    throw new Error("Storage dir was not initialized");
  }
  const projectDir = join(storageDir, projectId);
  mkdirSync(projectDir, { recursive: true });
  writeFileSync(join(projectDir, filename), content);
}

export async function buildMobileApp(options: Record<string, unknown> = {}): Promise<FastifyInstance> {
  const app = Fastify();
  const { mobileProjectRoutes } = await import("../../mobileProjects.js");
  await app.register(mobileProjectRoutes, options);
  return app;
}

export async function buildOperatorApp(): Promise<FastifyInstance> {
  const app = Fastify();
  const { projectRoutes } = await import("../../routes/projects.js");
  await app.register(projectRoutes);
  return app;
}
