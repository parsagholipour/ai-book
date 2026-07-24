import Fastify, { type FastifyInstance } from "fastify";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  InsufficientCreditsError,
  ensureProjectExportEntitlementOrSpend,
  getCreditBalance,
  grantProjectEntitlement,
  hasActiveProjectEntitlement,
  listActiveUserEntitlements,
  recordVerifiedGooglePlayPurchase,
  reserveCredits
} from "@book-maker/db/billing";
import { hashToken } from "./mobileAuth.js";
import { buildProjectStatus } from "./projectStatus.js";
import { dispatchGenerationJob, enqueueGenerationJob, isBullJobActive, requeueGenerationJob } from "./queue.js";

type QueuedGenerationJobRecord = Awaited<ReturnType<typeof enqueueGenerationJob>>;

const mockPrisma = vi.hoisted(() => ({
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
}));

const mockBilling = vi.hoisted(() => {
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
});

const MockPrismaKnownRequestError = vi.hoisted(
  () =>
    class MockPrismaKnownRequestError extends Error {
      readonly code: string;

      constructor(message: string, options: { code: string }) {
        super(message);
        this.code = options.code;
      }
    }
);

vi.mock("@book-maker/db", () => ({
  ensureSeedTemplates: vi.fn(),
  PLAN_REVISION_AUTOMATIC_RETRY_LIMIT: 2,
  canClaimPlanRevisionRetry: vi.fn(() => ({ eligible: true, staleActive: false, reason: null })),
  planRevisionRetryDelayMs: vi.fn(() => 30_000),
  retryRequestKey: vi.fn((id: string, attempt: number) => `plan-revision-retry:${id}:${attempt}`),
  Prisma: { JsonNull: null, PrismaClientKnownRequestError: MockPrismaKnownRequestError },
  prisma: mockPrisma
}));

vi.mock("@book-maker/db/billing", () => mockBilling);

vi.mock("./queue.js", () => ({
  dispatchGenerationJob: vi.fn(),
  enqueueGenerationJob: vi.fn(),
  isBullJobActive: vi.fn(),
  requeueGenerationJob: vi.fn(),
  stopProjectGenerationJobs: vi.fn(),
  closeQueue: vi.fn()
}));

vi.mock("./projectStatus.js", () => ({
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
}));

const originalEnv = { ...process.env };
let tempBookStorageDir: string | null = null;
let tempImageStorageDir: string | null = null;
let tempVoiceStorageDir: string | null = null;
let mockProjectChatMessages: any[] = [];
let mockPlanVersions: any[] = [];
let mockBookEditOperations: any[] = [];
let mockPages: any[] = [];
let mockPageEditSnapshots: any[] = [];

describe("mobile project routes", () => {
  beforeEach(() => {
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
    vi.mocked(enqueueGenerationJob).mockResolvedValue(jobRecord());
    vi.mocked(dispatchGenerationJob).mockResolvedValue(jobRecord());
    vi.mocked(isBullJobActive).mockResolvedValue(false);
    vi.mocked(requeueGenerationJob).mockResolvedValue(jobRecord({ id: "job-resumed", status: "QUEUED" }));
    vi.mocked(buildProjectStatus).mockResolvedValue(statusRecord());
    mockPrisma.generationJob.count.mockResolvedValue(0);
    mockPrisma.generationJob.findUnique.mockResolvedValue(null);
    mockPrisma.mobileCreationDraft.findUnique.mockResolvedValue({ revision: 3 });
    mockPrisma.mobileCreationDraft.update.mockResolvedValue(creationDraftRecord({ revision: 2 }));
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
    mockProjectChatMessages = [];
    mockPlanVersions = [];
    mockBookEditOperations = [];
    mockPrisma.projectChatMessage.create.mockImplementation(async ({ data }: { data: Record<string, any> }) => {
      const record = {
        id: `chat-${mockProjectChatMessages.length + 1}`,
        projectId: data.projectId,
        requestId: data.requestId ?? null,
        parentId: data.parentId ?? null,
        role: data.role,
        content: data.content,
        operationId: data.operationId ?? null,
        metadata: data.metadata ?? {},
        isActiveChild: data.isActiveChild ?? true,
        createdAt: new Date(`2026-06-15T12:${String(mockProjectChatMessages.length).padStart(2, "0")}:00.000Z`)
      };
      mockProjectChatMessages.push(record);
      return record;
    });
    mockPrisma.projectChatMessage.findFirst.mockImplementation(async ({ where }: { where: Record<string, any> }) => {
      return mockProjectChatMessages.find((message) => matchesProjectChatWhere(message, where)) ?? null;
    });
    mockPrisma.projectChatMessage.findUnique.mockImplementation(
      async ({ where }: { where: { projectId_requestId?: { projectId: string; requestId: string } } }) => {
        const key = where.projectId_requestId;
        return key
          ? mockProjectChatMessages.find(
              (message) => message.projectId === key.projectId && message.requestId === key.requestId
            ) ?? null
          : null;
      }
    );
    mockPrisma.projectChatMessage.findMany.mockImplementation(async ({ where, orderBy, take }: { where: Record<string, any>; orderBy?: { createdAt: "asc" | "desc" }; take?: number }) => {
      const rows = mockProjectChatMessages.filter((message) => matchesProjectChatWhere(message, where));
      const sorted = [...rows].sort((a, b) =>
        orderBy?.createdAt === "desc"
          ? b.createdAt.getTime() - a.createdAt.getTime() || b.id.localeCompare(a.id)
          : a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id)
      );
      return typeof take === "number" ? sorted.slice(0, take) : sorted;
    });
    mockPrisma.projectChatMessage.update.mockImplementation(async ({ where, data }: { where: { id: string }; data: Record<string, any> }) => {
      const message = mockProjectChatMessages.find((candidate) => candidate.id === where.id);
      if (!message) {
        throw new Error(`Chat message not found: ${where.id}`);
      }
      Object.assign(message, data);
      return message;
    });
    mockPages = [];
    mockPageEditSnapshots = [];
    mockPrisma.page.findMany.mockImplementation(async ({ where }: { where: Record<string, any> }) => {
      const matchesContainsClause = (page: Record<string, any>, clause: Record<string, any>) =>
        Object.entries(clause).every(([field, condition]) =>
          typeof (condition as { contains?: string })?.contains === "string"
            ? String(page[field] ?? "")
                .toLowerCase()
                .includes((condition as { contains: string }).contains.toLowerCase())
            : true
        );
      return mockPages
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
      const page = mockPages.find((candidate) => candidate.id === where.id);
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
      const record = { id: `snapshot-${mockPageEditSnapshots.length + 1}`, ...data };
      mockPageEditSnapshots.push(record);
      return record;
    });
    mockPrisma.projectChatMessage.updateMany.mockImplementation(async ({ where, data }: { where: Record<string, any>; data: Record<string, any> }) => {
      let count = 0;
      for (const message of mockProjectChatMessages) {
        if (!matchesProjectChatWhere(message, where)) {
          continue;
        }
        Object.assign(message, data);
        count += 1;
      }
      return { count };
    });
    mockPrisma.planVersion.findMany.mockImplementation(async ({ where, orderBy, take }: { where: { projectId: string }; orderBy?: { version: "asc" | "desc" }; take?: number }) => {
      const rows = mockPlanVersions.filter((planVersion) => planVersion.projectId === where.projectId);
      const sorted = [...rows].sort((a, b) =>
        orderBy?.version === "desc" ? b.version - a.version : a.version - b.version
      );
      return typeof take === "number" ? sorted.slice(0, take) : sorted;
    });
    mockPrisma.bookEditOperation.create.mockImplementation(async ({ data }: { data: Record<string, any> }) => {
      const record = {
        id: `operation-${mockBookEditOperations.length + 1}`,
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
        createdAt: new Date(`2026-06-15T13:${String(mockBookEditOperations.length).padStart(2, "0")}:00.000Z`),
        updatedAt: new Date(`2026-06-15T13:${String(mockBookEditOperations.length).padStart(2, "0")}:00.000Z`),
        appliedAt: null
      };
      mockBookEditOperations.push(record);
      return record;
    });
    mockPrisma.bookEditOperation.update.mockImplementation(async ({ where, data, include }: { where: { id: string }; data: Record<string, any>; include?: unknown }) => {
      const record = mockBookEditOperations.find((operation) => operation.id === where.id);
      if (!record) {
        throw new Error(`Operation not found: ${where.id}`);
      }
      Object.assign(record, data, { updatedAt: new Date("2026-06-15T13:59:00.000Z") });
      if (data.generationJobId) {
        record.generationJob = { id: data.generationJobId, status: "QUEUED" };
      }
      return include ? record : { ...record, generationJob: undefined };
    });
    mockPrisma.bookEditOperation.findMany.mockImplementation(async ({ where, orderBy, take }: { where: { projectId: string }; orderBy?: { createdAt: "asc" | "desc" }; take?: number }) => {
      const rows = mockBookEditOperations.filter((operation) => operation.projectId === where.projectId);
      const sorted = [...rows].sort((a, b) =>
        orderBy?.createdAt === "asc"
          ? a.createdAt.getTime() - b.createdAt.getTime()
          : b.createdAt.getTime() - a.createdAt.getTime()
      );
      return typeof take === "number" ? sorted.slice(0, take) : sorted;
    });
    mockPrisma.bookEditOperation.findUnique.mockImplementation(async ({ where }: { where: { id?: string } }) =>
      mockBookEditOperations.find((operation) => operation.id === where.id) ?? null
    );
    mockPrisma.bookEditOperation.updateMany.mockImplementation(async ({ where, data }: { where: Record<string, any>; data: Record<string, any> }) => {
      const record = mockBookEditOperations.find((operation) => operation.id === where.id);
      if (!record || (where.status !== undefined && record.status !== where.status)) return { count: 0 };
      const { automaticRetryCount, ...rest } = data;
      Object.assign(record, rest);
      if (typeof automaticRetryCount === "number") record.automaticRetryCount = automaticRetryCount;
      if (automaticRetryCount?.increment) record.automaticRetryCount += automaticRetryCount.increment;
      return { count: 1 };
    });
    mockPrisma.bookEditOperation.findFirst.mockImplementation(async ({ where }: { where: Record<string, any> }) =>
      mockBookEditOperations.find(
        (operation) =>
          (where.projectId === undefined || operation.projectId === where.projectId) &&
          (typeof where.id !== "string" || operation.id === where.id) &&
          (where.id?.not === undefined || operation.id !== where.id.not) &&
          (where.userMessageId === undefined || operation.userMessageId === where.userMessageId) &&
          (where.kind === undefined || operation.kind === where.kind) &&
          (typeof where.status !== "string" || operation.status === where.status) &&
          (where.status?.in === undefined || where.status.in.includes(operation.status))
      ) ?? null
    );
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
    tempBookStorageDir = mkdtempSync(join(tmpdir(), "book-maker-mobile-books-"));
    tempImageStorageDir = mkdtempSync(join(tmpdir(), "book-maker-mobile-images-"));
    tempVoiceStorageDir = mkdtempSync(join(tmpdir(), "book-maker-mobile-voice-"));
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
      BOOK_STORAGE_DIR: tempBookStorageDir,
      IMAGE_STORAGE_DIR: tempImageStorageDir,
      VOICE_STORAGE_DIR: tempVoiceStorageDir
    };
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    if (tempBookStorageDir) {
      rmSync(tempBookStorageDir, { recursive: true, force: true });
      tempBookStorageDir = null;
    }
    if (tempImageStorageDir) {
      rmSync(tempImageStorageDir, { recursive: true, force: true });
      tempImageStorageDir = null;
    }
    if (tempVoiceStorageDir) {
      rmSync(tempVoiceStorageDir, { recursive: true, force: true });
      tempVoiceStorageDir = null;
    }
  });

  it("requires mobile bearer auth for mobile project endpoints", async () => {
    const app = await buildMobileApp();

    const response = await app.inject({ method: "GET", url: "/api/mobile/projects" });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({
      error: {
        code: "AUTH_REQUIRED",
        message: "Sign in to continue."
      }
    });
    await app.close();
  });

  it("loads and saves user-owned mobile creation drafts", async () => {
    mockAccessTokens({ "token-a": "user-a" });
    mockPrisma.mobileCreationDraft.findFirst
      .mockResolvedValueOnce(
        creationDraftRecord({
          payload: creationPayload({
            brief: { topic: "Pricing guide", audience: "solo consultants", desiredOutcome: "price a starter offer" }
          })
        })
      )
      .mockResolvedValue(creationDraftRecord({ id: "draft-created" }));
    mockPrisma.mobileCreationDraft.create.mockImplementation(async ({ data }: { data: Record<string, unknown> }) =>
      creationDraftRecord({ id: "draft-created", payload: data.payload })
    );
    mockPrisma.mobileCreationDraft.update.mockImplementation(async ({ data }: { data: Record<string, unknown> }) =>
      creationDraftRecord({ id: "draft-created", payload: data.payload })
    );
    const app = await buildMobileApp();

    const active = await app.inject({
      method: "GET",
      url: "/api/mobile/creation-drafts/active",
      headers: bearer("token-a")
    });
    const rejected = await app.inject({
      method: "POST",
      url: "/api/mobile/creation-drafts",
      headers: bearer("token-a"),
      payload: {
        ...creationPayload(),
        internalProvider: "do-not-accept"
      }
    });
    const created = await app.inject({
      method: "POST",
      url: "/api/mobile/creation-drafts",
      headers: bearer("token-a"),
      payload: creationPayload({ brief: { topic: "Workshop checklist" } })
    });
    const patched = await app.inject({
      method: "PATCH",
      url: "/api/mobile/creation-drafts/draft-created",
      headers: bearer("token-a"),
      payload: creationPayload({ brief: { topic: "Workshop checklist", audience: "online teachers" } })
    });

    expect(active.statusCode).toBe(200);
    expect(active.json().draft).toMatchObject({
      id: "draft-1",
      status: "ACTIVE",
      payload: { brief: expect.objectContaining({ topic: "Pricing guide", audience: "solo consultants" }) }
    });
    expect(mockPrisma.mobileCreationDraft.findFirst).toHaveBeenCalledWith({
      where: { userId: "user-a", status: "ACTIVE" },
      orderBy: { updatedAt: "desc" }
    });
    expect(rejected.statusCode).toBe(400);
    expect(mockPrisma.mobileCreationDraft.create).toHaveBeenCalledOnce();
    expect(created.statusCode).toBe(201);
    expect(created.json().draft.id).toBe("draft-created");
    expect(patched.statusCode).toBe(200);
    expect(mockPrisma.mobileCreationDraft.update).toHaveBeenCalledWith({
      where: { id: "draft-created" },
      data: { payload: expect.objectContaining({ brief: expect.objectContaining({ audience: "online teachers" }) }) }
    });
    expect(JSON.stringify({ active: active.json(), created: created.json(), patched: patched.json() })).not.toMatch(
      /provider|model|generationStrategy|billing/
    );
    await app.close();
  });

  it("returns deterministic mobile book advisor fallback without spending credits", async () => {
    mockAccessTokens({ "token-a": "user-a" });
    const app = await buildMobileApp({
      advisorEnrichment: async () => new Promise<never>(() => undefined),
      advisorTimeoutMs: 1
    });
    const advisorPayload = creationPayload({
      brief: {
        intent: "teach_practice",
        topic: "workshop planning",
        audience: "online teachers",
        desiredOutcome: "launch a clear first workshop"
      }
    });
    delete (advisorPayload as Partial<typeof advisorPayload>).selectedPresets;

    const response = await app.inject({
      method: "POST",
      url: "/api/mobile/book-advisor",
      headers: bearer("token-a"),
      payload: advisorPayload
    });
    const body = response.json();

    expect(response.statusCode).toBe(200);
    expect(body.advisor).toMatchObject({
      recommendation: {
        bookType: "workbook",
        lengthPreset: "standard",
        qualityPreset: "balanced",
        imagesEnabled: true
      },
      briefScore: expect.any(Number),
      bookShapePreview: expect.arrayContaining([expect.stringContaining("lessons")])
    });
    expect(vi.mocked(reserveCredits)).not.toHaveBeenCalled();
    expect(JSON.stringify(body)).not.toMatch(/provider|model|temperature|credits|billing/);
    await app.close();
  });

  it("keeps a minimal raw idea as Auto for planning", async () => {
    mockAccessTokens({ "token-a": "user-a" });
    const app = await buildMobileApp({ advisorEnrichment: false });

    const response = await app.inject({
      method: "POST",
      url: "/api/mobile/book-advisor",
      headers: bearer("token-a"),
      payload: {
        payloadVersion: 2,
        rawIdea: "Bedtime story for 5 year olds"
      }
    });
    const body = response.json();

    expect(response.statusCode).toBe(200);
    expect(body.advisor).toMatchObject({
      detectedLane: "auto",
      recommendation: {
        bookType: "lead_magnet",
        bookTypeChoice: "auto",
        lengthPreset: "short",
        qualityPreset: "balanced",
        imagesEnabled: true
      },
      recipe: expect.objectContaining({
        lane: "auto",
        audience: "5 year olds",
        tone: expect.stringContaining("fitted")
      }),
      followUpSuggestions: expect.arrayContaining([expect.stringContaining("who it is for")]),
      bookShapePreview: expect.arrayContaining([expect.stringContaining("Planner chooses")])
    });
    expect(vi.mocked(reserveCredits)).not.toHaveBeenCalled();
    expect(JSON.stringify(body)).not.toMatch(/provider|model|temperature|credits|billing/);
    await app.close();
  });

  it("builds Auto creation sessions as neutral projects for planner-time shape selection", async () => {
    mockAccessTokens({ "token-a": "user-a" });
    const payload = {
      payloadVersion: 3,
      rawIdea: "Make a 4 page book of rabbit and turtle race",
      messages: [
        { role: "assistant", content: "Hi!" },
        { role: "user", content: "Make a 4 page book of rabbit and turtle race" }
      ],
      selectedPresets: {
        bookType: "lead_magnet",
        bookTypeChoice: "auto",
        lengthPreset: "short",
        qualityPreset: "balanced",
        imagesEnabled: true
      }
    };
    mockPrisma.mobileCreationDraft.findFirst.mockResolvedValueOnce(creationDraftRecord({ id: "session-draft", payload }));
    mockPrisma.template.findFirst.mockResolvedValue({ id: "template-general" });
    mockPrisma.project.create.mockImplementation(async ({ data }: { data: Record<string, any> }) =>
      projectRecord({
        id: "project-from-session",
        title: data.title,
        prompt: data.prompt,
        category: data.category,
        subcategory: data.subcategory ?? null,
        targetPages: data.targetPages,
        mediaSettings: data.mediaSettings,
        currentPlan: null,
        pages: [],
        _count: { pages: 0, images: 0, jobs: 0 }
      })
    );
    mockPrisma.mobileCreationDraft.update.mockImplementation(async ({ data }: { data: Record<string, unknown> }) =>
      creationDraftRecord({ id: "session-draft", payload, ...data })
    );
    mockPrisma.project.update.mockResolvedValue({});
    vi.mocked(enqueueGenerationJob).mockResolvedValueOnce(jobRecord({ id: "job-plan" }));
    const app = await buildMobileApp({ advisorEnrichment: false, creationEnrichment: false });

    const response = await app.inject({
      method: "POST",
      url: "/api/mobile/creation-sessions/session-draft/build",
      headers: bearer("token-a"),
      payload: {}
    });
    const createCall = mockPrisma.project.create.mock.calls.at(0)?.[0] as { data: Record<string, any> };
    const queuedCall = vi.mocked(enqueueGenerationJob).mock.calls.at(0)?.[0] as { payload: Record<string, any> };
    const inputSnapshot = queuedCall.payload.inputSnapshot as Record<string, any>;

    expect(response.statusCode).toBe(201);
    expect(createCall.data).toMatchObject({
      category: "CUSTOM",
      subcategory: "Auto",
      targetPages: 4,
      mediaSettings: expect.objectContaining({
        coverTemplate: "auto",
        mobile: expect.objectContaining({
          bookType: "custom",
          bookTypeChoice: "auto",
          lengthPreset: "custom",
          pageCountMode: "custom",
          targetPages: 4,
          pageCountSource: "chat",
          messages: expect.arrayContaining([expect.objectContaining({ content: "Make a 4 page book of rabbit and turtle race" })])
        })
      })
    });
    expect(createCall.data.prompt).toContain("Book type choice: Auto - decide during planning");
    expect(createCall.data.prompt).toContain("User: Make a 4 page book of rabbit and turtle race");
    expect(inputSnapshot).toMatchObject({
      category: "CUSTOM",
      targetPages: 4,
      mediaSettings: expect.objectContaining({
        mobile: expect.objectContaining({ bookTypeChoice: "auto", targetPages: 4, pageCountSource: "chat" })
      })
    });
    await app.close();
  });

  it("returns page-count preflight recommendations without creating a project when pages are unresolved", async () => {
    mockAccessTokens({ "token-a": "user-a" });
    const payload = {
      payloadVersion: 3,
      rawIdea: "Make a story about a rabbit and turtle race",
      messages: [
        { role: "assistant", content: "Hi!" },
        { role: "user", content: "Make a story about a rabbit and turtle race" }
      ],
      selectedPresets: {
        bookType: "lead_magnet",
        bookTypeChoice: "auto",
        lengthPreset: "short",
        qualityPreset: "balanced",
        imagesEnabled: true
      }
    };
    mockPrisma.mobileCreationDraft.findFirst.mockResolvedValueOnce(creationDraftRecord({ id: "session-draft", payload }));
    const app = await buildMobileApp({ advisorEnrichment: false, creationEnrichment: false });

    const response = await app.inject({
      method: "POST",
      url: "/api/mobile/creation-sessions/session-draft/preflight",
      headers: bearer("token-a"),
      payload: {}
    });
    const body = response.json();

    expect(response.statusCode).toBe(200);
    expect(body).toMatchObject({
      requiresPageCount: true,
      detectedPageCount: null,
      recommendations: expect.arrayContaining([expect.objectContaining({ targetPages: expect.any(Number) })])
    });
    expect(mockPrisma.project.create).not.toHaveBeenCalled();
    expect(JSON.stringify(body)).not.toMatch(/provider|model|temperature|billing|tokens/);
    await app.close();
  });

  it("lets custom page settings override an explicit chat page count", async () => {
    mockAccessTokens({ "token-a": "user-a" });
    const payload = {
      payloadVersion: 3,
      rawIdea: "Make a 4 page book of rabbit and turtle race",
      messages: [
        { role: "assistant", content: "Hi!" },
        { role: "user", content: "Make a 4 page book of rabbit and turtle race" }
      ],
      selectedPresets: {
        bookType: "lead_magnet",
        bookTypeChoice: "auto",
        lengthPreset: "short",
        qualityPreset: "balanced",
        imagesEnabled: true
      }
    };
    mockPrisma.mobileCreationDraft.findFirst.mockResolvedValueOnce(creationDraftRecord({ id: "session-draft", payload }));
    mockPrisma.template.findFirst.mockResolvedValue({ id: "template-general" });
    mockPrisma.project.create.mockImplementation(async ({ data }: { data: Record<string, any> }) =>
      projectRecord({
        id: "project-from-session",
        title: data.title,
        prompt: data.prompt,
        category: data.category,
        subcategory: data.subcategory ?? null,
        targetPages: data.targetPages,
        mediaSettings: data.mediaSettings,
        currentPlan: null,
        pages: [],
        _count: { pages: 0, images: 0, jobs: 0 }
      })
    );
    mockPrisma.mobileCreationDraft.update.mockImplementation(async ({ data }: { data: Record<string, unknown> }) =>
      creationDraftRecord({ id: "session-draft", payload, ...data })
    );
    mockPrisma.project.update.mockResolvedValue({});
    vi.mocked(enqueueGenerationJob).mockResolvedValueOnce(jobRecord({ id: "job-plan" }));
    const app = await buildMobileApp({ advisorEnrichment: false, creationEnrichment: false });

    const response = await app.inject({
      method: "POST",
      url: "/api/mobile/creation-sessions/session-draft/build",
      headers: bearer("token-a"),
      payload: {
        presets: {
          bookType: "lead_magnet",
          bookTypeChoice: "auto",
          lengthPreset: "short",
          qualityPreset: "balanced",
          imagesEnabled: true,
          pageCountMode: "custom",
          targetPages: 10,
          pageCountSource: "settings"
        }
      }
    });
    const createCall = mockPrisma.project.create.mock.calls.at(0)?.[0] as { data: Record<string, any> };

    expect(response.statusCode).toBe(201);
    expect(createCall.data).toMatchObject({
      targetPages: 10,
      mediaSettings: expect.objectContaining({
        mobile: expect.objectContaining({ lengthPreset: "custom", targetPages: 10, pageCountSource: "settings" })
      })
    });
    await app.close();
  });

  it("finalizes a creation draft into a project and queues first plan generation", async () => {
    mockAccessTokens({ "token-a": "user-a" });
    const payload = creationPayload({
      brief: {
        intent: "teach_practice",
        topic: "Client onboarding",
        audience: "consulting clients",
        desiredOutcome: "complete a first-week checklist",
        sourceNotes: "SECRET SOURCE NOTES from a private webinar transcript"
      },
      selectedPresets: {
        bookType: "workbook",
        lengthPreset: "standard",
        qualityPreset: "balanced",
        imagesEnabled: true
      }
    });
    mockPrisma.mobileCreationDraft.findFirst.mockResolvedValueOnce(creationDraftRecord({ id: "draft-1", payload }));
    mockPrisma.template.findFirst.mockResolvedValue({ id: "template-workbook" });
    mockPrisma.project.create.mockImplementation(async ({ data }: { data: Record<string, any> }) =>
      projectRecord({
        id: "project-from-draft",
        title: data.title,
        authorName: data.authorName ?? null,
        prompt: data.prompt,
        category: data.category,
        subcategory: data.subcategory ?? null,
        targetPages: data.targetPages,
        mediaSettings: data.mediaSettings,
        currentPlan: null,
        pages: [],
        _count: { pages: 0, images: 0, jobs: 0 }
      })
    );
    mockPrisma.mobileCreationDraft.update.mockImplementation(async ({ data }: { data: Record<string, unknown> }) =>
      creationDraftRecord({ id: "draft-1", payload, ...data })
    );
    mockPrisma.project.update.mockResolvedValue({});
    vi.mocked(enqueueGenerationJob).mockResolvedValueOnce(jobRecord({ id: "job-plan" }));
    const app = await buildMobileApp({ advisorEnrichment: false });

    const response = await app.inject({
      method: "POST",
      url: "/api/mobile/creation-drafts/draft-1/create-project",
      headers: bearer("token-a"),
      payload: {}
    });
    const createCall = mockPrisma.project.create.mock.calls.at(0)?.[0] as { data: Record<string, any> };
    const queuedCall = vi.mocked(enqueueGenerationJob).mock.calls.at(0)?.[0] as { payload: Record<string, any> };

    expect(response.statusCode).toBe(201);
    expect(response.json()).toMatchObject({
      project: { id: "project-from-draft", bookType: "workbook" },
      operation: { projectId: "project-from-draft", status: "planning_queued", job: { id: "job-plan" } }
    });
    expect(createCall.data.prompt).toContain("Use the pasted source notes stored in the mobile creation metadata");
    expect(createCall.data.prompt).not.toContain("SECRET SOURCE NOTES");
    expect(createCall.data.mediaSettings.mobile).toMatchObject({
      bookType: "workbook",
      brief: expect.objectContaining({
        topic: "Client onboarding",
        sourceNotes: "SECRET SOURCE NOTES from a private webinar transcript"
      }),
      advisor: expect.objectContaining({
        recommendation: expect.objectContaining({ bookType: "workbook" })
      })
    });
    expect(queuedCall).toMatchObject({
      projectId: "project-from-draft",
      type: "PLAN_BOOK",
      payload: {
        inputSnapshot: expect.objectContaining({
          mediaSettings: expect.objectContaining({
            mobile: expect.objectContaining({
              brief: expect.objectContaining({ sourceNotes: expect.stringContaining("SECRET SOURCE NOTES") })
            })
          })
        })
      }
    });
    expect(mockPrisma.mobileCreationDraft.update).toHaveBeenLastCalledWith({
      where: { id: "draft-1" },
      data: expect.objectContaining({ status: "ACTIVE", createdProjectId: "project-from-draft" })
    });
    expect(JSON.stringify(response.json().project)).not.toMatch(/SECRET SOURCE NOTES|provider|model|mediaSettings|temperature/);
    await app.close();
  });

  it("creates another output from a completed mobile creation chat", async () => {
    mockAccessTokens({ "token-a": "user-a" });
    const payload = {
      payloadVersion: 3,
      rawIdea: "Workbook for new coaches",
      messages: [
        { role: "assistant", content: "Hi!" },
        { role: "user", content: "Workbook for new coaches" }
      ],
      selectedPresets: {
        bookType: "workbook",
        lengthPreset: "short",
        qualityPreset: "balanced",
        imagesEnabled: true
      }
    };
    mockPrisma.mobileCreationDraft.findFirst.mockResolvedValueOnce(
      creationDraftRecord({
        id: "draft-complete",
        status: "COMPLETED",
        createdProjectId: "project-old",
        payload,
        outputs: [
          {
            id: "output-old",
            draftId: "draft-complete",
            projectId: "project-old",
            title: "Old output",
            sequence: 1,
            createdAt: new Date("2026-06-15T10:00:00.000Z"),
            updatedAt: new Date("2026-06-15T10:00:00.000Z"),
            project: { title: "Old output", updatedAt: new Date("2026-06-15T10:00:00.000Z") }
          }
        ]
      })
    );
    mockPrisma.template.findFirst.mockResolvedValue({ id: "template-workbook" });
    mockPrisma.project.create.mockImplementation(async ({ data }: { data: Record<string, any> }) =>
      projectRecord({
        id: "project-new",
        title: data.title,
        prompt: data.prompt,
        category: data.category,
        subcategory: data.subcategory ?? null,
        targetPages: data.targetPages,
        mediaSettings: data.mediaSettings,
        currentPlan: null,
        pages: [],
        _count: { pages: 0, images: 0, jobs: 0 }
      })
    );
    mockPrisma.project.update.mockResolvedValue({});
    mockPrisma.mobileCreationDraft.update.mockImplementation(async ({ data }: { data: Record<string, unknown> }) =>
      creationDraftRecord({ id: "draft-complete", payload, ...data })
    );
    vi.mocked(enqueueGenerationJob).mockResolvedValueOnce(jobRecord({ id: "job-plan", projectId: "project-new" }));
    const app = await buildMobileApp();

    const response = await app.inject({
      method: "POST",
      url: "/api/mobile/creation-drafts/draft-complete/create-project",
      headers: bearer("token-a"),
      payload: {}
    });

    expect(response.statusCode).toBe(201);
    expect(response.json()).toMatchObject({
      project: { id: "project-new" },
      output: { projectId: "project-new", sequence: 2 },
      operation: { projectId: "project-new", status: "planning_queued" }
    });
    expect(mockPrisma.mobileCreationOutput.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          draftId: "draft-complete",
          projectId: "project-new",
          sequence: 2
        })
      })
    );
    expect(mockPrisma.mobileCreationDraft.update).toHaveBeenLastCalledWith({
      where: { id: "draft-complete" },
      data: expect.objectContaining({ status: "ACTIVE", createdProjectId: "project-new" })
    });
    await app.close();
  });

  it("starts a creation session with a deterministic greeting turn", async () => {
    mockAccessTokens({ "token-a": "user-a" });
    mockPrisma.mobileCreationDraft.create.mockImplementation(async ({ data }: { data: Record<string, unknown> }) =>
      creationDraftRecord({ id: "session-draft", status: "ACTIVE", payload: data.payload })
    );
    const app = await buildMobileApp({ creationEnrichment: false });

    const response = await app.inject({
      method: "POST",
      url: "/api/mobile/creation-sessions",
      headers: bearer("token-a"),
      payload: {}
    });
    const body = response.json();

    expect(response.statusCode).toBe(201);
    expect(body.session).toMatchObject({ draftId: "session-draft", status: "ACTIVE" });
    expect(body.session.messages).toHaveLength(1);
    expect(body.session.messages[0].role).toBe("assistant");
    expect(body.turn.assistantMessage).toContain("Tell me about the book");
    expect(body.turn.readiness.canBuild).toBe(false);
    expect(vi.mocked(reserveCredits)).not.toHaveBeenCalled();
    expect(JSON.stringify(body)).not.toMatch(/provider|model|temperature|credits|billing/);
    await app.close();
  });

  it("starts a creation session with the first user message already persisted", async () => {
    mockAccessTokens({ "token-a": "user-a" });
    mockPrisma.mobileCreationDraft.create.mockImplementation(async ({ data }: { data: Record<string, unknown> }) =>
      creationDraftRecord({ id: "session-draft", status: "ACTIVE", payload: data.payload })
    );
    const app = await buildMobileApp({ creationEnrichment: false });

    const response = await app.inject({
      method: "POST",
      url: "/api/mobile/creation-sessions",
      headers: bearer("token-a"),
      payload: { message: "Bedtime story for 5 year olds" }
    });
    const body = response.json();
    const createCall = mockPrisma.mobileCreationDraft.create.mock.calls.at(0)?.[0] as {
      data: { payload: Record<string, any> };
    };

    expect(response.statusCode).toBe(201);
    expect(body.session.draftId).toBe("session-draft");
    expect(body.turn.detectedLane).toBe("auto");
    expect(body.turn.readiness.canBuild).toBe(true);
    expect(body.session.messages.map((message: { role: string }) => message.role)).toEqual([
      "assistant",
      "user",
      "assistant"
    ]);
    expect(createCall.data.payload.rawIdea).toBe("Bedtime story for 5 year olds");
    expect(createCall.data.payload.messages.map((message: { role: string }) => message.role)).toEqual([
      "assistant",
      "user",
      "assistant"
    ]);
    expect(typeof createCall.data.payload.lastMessageAt).toBe("string");
    await app.close();
  });

  it("resumes an active session and runs a turn once the user has replied", async () => {
    mockAccessTokens({ "token-a": "user-a" });
    mockPrisma.mobileCreationDraft.findFirst.mockResolvedValueOnce(
      creationDraftRecord({
        id: "session-draft",
        payload: {
          payloadVersion: 3,
          rawIdea: "Bedtime story for 5 year olds",
          messages: [
            { role: "assistant", content: "Hi! Tell me about your book." },
            { role: "user", content: "Bedtime story for 5 year olds" }
          ]
        }
      })
    );
    const app = await buildMobileApp({ creationEnrichment: false });

    const response = await app.inject({
      method: "GET",
      url: "/api/mobile/creation-sessions/active",
      headers: bearer("token-a")
    });
    const body = response.json();

    expect(response.statusCode).toBe(200);
    expect(body.session.draftId).toBe("session-draft");
    expect(body.turn.detectedLane).toBe("auto");
    expect(body.turn.readiness.canBuild).toBe(true);
    await app.close();
  });

  it("returns a greeting when no active creation session exists", async () => {
    mockAccessTokens({ "token-a": "user-a" });
    mockPrisma.mobileCreationDraft.findFirst.mockResolvedValueOnce(null);
    const app = await buildMobileApp({ creationEnrichment: false });

    const response = await app.inject({
      method: "GET",
      url: "/api/mobile/creation-sessions/active",
      headers: bearer("token-a")
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().session).toBeNull();
    expect(response.json().turn.assistantMessage).toContain("Tell me about the book");
    await app.close();
  });

  it("lists creation sessions with output summaries and legacy output fallback", async () => {
    mockAccessTokens({ "token-a": "user-a" });
    mockPrisma.mobileCreationDraft.findMany.mockResolvedValueOnce([
      creationDraftRecord({
        id: "draft-with-output",
        createdProjectId: "project-new",
        payload: {
          payloadVersion: 3,
          rawIdea: "Workbook for new coaches",
          messages: [{ role: "user", content: "Workbook for new coaches" }]
        },
        outputs: [
          {
            id: "output-new",
            draftId: "draft-with-output",
            projectId: "project-new",
            title: "Coach Workbook",
            sequence: 1,
            createdAt: new Date("2026-06-15T12:00:00.000Z"),
            updatedAt: new Date("2026-06-15T12:00:00.000Z"),
            project: { title: "Coach Workbook", updatedAt: new Date("2026-06-15T12:30:00.000Z") }
          }
        ]
      }),
      creationDraftRecord({
        id: "draft-legacy",
        status: "COMPLETED",
        createdProjectId: "project-legacy",
        payload: {
          payloadVersion: 3,
          rawIdea: "Legacy story",
          messages: [{ role: "user", content: "Legacy story" }]
        }
      })
    ]);
    const app = await buildMobileApp({ creationEnrichment: false });

    const response = await app.inject({
      method: "GET",
      url: "/api/mobile/creation-sessions",
      headers: bearer("token-a")
    });
    const sessions = response.json().sessions;

    expect(response.statusCode).toBe(200);
    expect(sessions[0]).toMatchObject({
      draftId: "draft-with-output",
      activeProjectId: "project-new",
      outputs: [{ id: "output-new", projectId: "project-new", title: "Coach Workbook", sequence: 1 }]
    });
    expect(sessions[1]).toMatchObject({
      draftId: "draft-legacy",
      activeProjectId: "project-legacy",
      outputs: [{ projectId: "project-legacy", title: "Legacy story", sequence: 1 }]
    });
    expect(sessions[1].outputs[0].id).toContain("legacy:");
    await app.close();
  });

  it("orders creation sessions by last conversation activity, not row updatedAt", async () => {
    mockAccessTokens({ "token-a": "user-a" });
    mockPrisma.mobileCreationDraft.findMany.mockResolvedValueOnce([
      // Built/exported chat: the row was touched after the newer chat was
      // created, but its last message is older.
      creationDraftRecord({
        id: "draft-built",
        updatedAt: new Date("2026-06-15T14:00:00.000Z"),
        payload: {
          payloadVersion: 3,
          lastMessageAt: "2026-06-15T10:00:00.000Z",
          messages: [{ role: "user", content: "Livro em portugues" }]
        }
      }),
      creationDraftRecord({
        id: "draft-new",
        updatedAt: new Date("2026-06-15T12:00:00.000Z"),
        payload: {
          payloadVersion: 3,
          lastMessageAt: "2026-06-15T12:00:00.000Z",
          messages: [{ role: "user", content: "Outro livro" }]
        }
      }),
      // Drafts from before lastMessageAt existed fall back to updatedAt.
      creationDraftRecord({
        id: "draft-legacy",
        updatedAt: new Date("2026-06-15T11:00:00.000Z"),
        payload: {
          payloadVersion: 3,
          messages: [{ role: "user", content: "Old idea" }]
        }
      })
    ]);
    const app = await buildMobileApp({ creationEnrichment: false });

    const response = await app.inject({
      method: "GET",
      url: "/api/mobile/creation-sessions",
      headers: bearer("token-a")
    });
    const sessions = response.json().sessions;

    expect(response.statusCode).toBe(200);
    expect(sessions.map((session: { draftId: string }) => session.draftId)).toEqual([
      "draft-new",
      "draft-legacy",
      "draft-built"
    ]);
    expect(sessions[0].lastMessageAt).toBe("2026-06-15T12:00:00.000Z");
    expect(sessions[1].lastMessageAt).toBe("2026-06-15T11:00:00.000Z");
    await app.close();
  });

  it("uses the search-capable timeout budget for continuation messages", async () => {
    mockAccessTokens({ "token-a": "user-a" });
    mockPrisma.mobileCreationDraft.findFirst.mockResolvedValueOnce(
      creationDraftRecord({
        id: "session-draft",
        payload: {
          payloadVersion: 3,
          rawIdea: "A scientific book about a recent discovery",
          messages: [
            { role: "assistant", content: "Hi!" },
            { role: "user", content: "A scientific book about a recent discovery" }
          ]
        }
      })
    );
    mockPrisma.mobileCreationDraft.update.mockImplementation(async ({ data }: { data: Record<string, unknown> }) =>
      creationDraftRecord({ id: "session-draft", payload: data.payload, lastTurn: data.lastTurn })
    );
    const app = await buildMobileApp({
      creationEnrichment: async () => ({
        assistantMessage: "I found a current, grounded topic.",
        question: null
      })
    });
    const timeoutSpy = vi.spyOn(globalThis, "setTimeout");

    try {
      const response = await app.inject({
        method: "POST",
        url: "/api/mobile/creation-sessions/session-draft/messages",
        headers: bearer("token-a"),
        payload: { message: "Find the latest on the internet" }
      });

      expect(response.statusCode).toBe(200);
      expect(response.json().turn.assistantMessage).toContain("grounded topic");
      expect(timeoutSpy.mock.calls.some((call) => call[1] === 85_000)).toBe(true);
    } finally {
      timeoutSpy.mockRestore();
      await app.close();
    }
  });

  it("persists and serializes grounded research on a creation answer", async () => {
    mockAccessTokens({ "token-a": "user-a" });
    mockPrisma.mobileCreationDraft.findFirst.mockResolvedValueOnce(
      creationDraftRecord({
        id: "session-draft",
        payload: {
          payloadVersion: 3,
          rawIdea: "A scientific book about a recent discovery",
          messages: [
            { role: "assistant", content: "Hi!" },
            { role: "user", content: "A scientific book about a recent discovery" },
            { role: "assistant", content: "Which discovery?" }
          ]
        }
      })
    );
    mockPrisma.mobileCreationDraft.update.mockImplementation(async ({ data }: { data: Record<string, unknown> }) =>
      creationDraftRecord({ id: "session-draft", payload: data.payload, lastTurn: data.lastTurn })
    );
    const research = {
      query: "recent scientific discovery",
      summary: "A grounded discovery summary.",
      sources: [
        {
          title: "NASA Science",
          url: "https://science.nasa.gov/example",
          summary: "NASA's source-backed explanation."
        }
      ]
    };
    let enrichCalls = 0;
    const app = await buildMobileApp({
      creationEnrichment: async () => {
        enrichCalls += 1;
        return {
          assistantMessage: "A recent NASA-reported discovery is a strong topic.",
          question: null,
          research
        };
      }
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/mobile/creation-sessions/session-draft/messages",
      headers: bearer("token-a"),
      payload: { message: "Find it on the internet and tell me", requestId: "search-request-0001" }
    });
    const body = response.json();
    const updateCall = mockPrisma.mobileCreationDraft.update.mock.calls.at(0)?.[0] as {
      data: { payload: { messages: Array<Record<string, any>> } };
    };

    expect(response.statusCode).toBe(200);
    expect(enrichCalls).toBe(1);
    expect(body.turn.research).toEqual(research);
    expect(body.session.messages.at(-1).research).toEqual(research);
    expect(updateCall!.data.payload.messages.at(-1)!.research).toEqual(research);
    expect(JSON.stringify(body.session)).not.toContain("turnUi");
    await app.close();
  });

  it("replays a searched request id without running enrichment again", async () => {
    mockAccessTokens({ "token-a": "user-a" });
    const research = {
      query: "recent scientific discovery",
      summary: "A grounded discovery summary.",
      sources: [{ title: "NASA", summary: "Grounded evidence." }]
    };
    const payload = {
      payloadVersion: 3,
      rawIdea: "A recent discovery",
      messages: [
        { id: "m0", parentId: null, isActiveChild: true, role: "assistant", content: "Hi!" },
        {
          id: "m1",
          parentId: "m0",
          isActiveChild: true,
          role: "user",
          content: "Find it online",
          requestId: "search-request-0002"
        },
        {
          id: "m2",
          parentId: "m1",
          isActiveChild: true,
          role: "assistant",
          content: "I found a grounded topic.",
          research
        }
      ]
    };
    mockPrisma.mobileCreationDraft.findFirst.mockResolvedValueOnce(
      creationDraftRecord({ id: "session-draft", payload })
    );
    let enrichCalls = 0;
    const app = await buildMobileApp({
      creationEnrichment: async () => {
        enrichCalls += 1;
        return {};
      }
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/mobile/creation-sessions/session-draft/messages",
      headers: bearer("token-a"),
      payload: { message: "Find it online", requestId: "search-request-0002" }
    });

    expect(response.statusCode).toBe(200);
    expect(enrichCalls).toBe(0);
    expect(response.json().session.messages.at(-1).research).toEqual(research);
    expect(mockPrisma.mobileCreationDraft.update).not.toHaveBeenCalled();
    await app.close();
  });

  it("appends a conversation message and persists the updated transcript", async () => {
    mockAccessTokens({ "token-a": "user-a" });
    mockPrisma.mobileCreationDraft.findFirst.mockResolvedValueOnce(
      creationDraftRecord({
        id: "session-draft",
        payload: { payloadVersion: 3, messages: [{ role: "assistant", content: "Hi! Tell me about your book." }] }
      })
    );
    mockPrisma.mobileCreationDraft.update.mockImplementation(async ({ data }: { data: Record<string, unknown> }) =>
      creationDraftRecord({ id: "session-draft", payload: data.payload })
    );
    const app = await buildMobileApp({ creationEnrichment: false });

    const response = await app.inject({
      method: "POST",
      url: "/api/mobile/creation-sessions/session-draft/messages",
      headers: bearer("token-a"),
      payload: { message: "Bedtime story for 5 year olds" }
    });
    const body = response.json();
    const updateCall = mockPrisma.mobileCreationDraft.update.mock.calls.at(0)?.[0] as {
      data: { payload: Record<string, any> };
    };

    expect(response.statusCode).toBe(200);
    expect(body.turn.detectedLane).toBe("auto");
    expect(body.turn.readiness.canBuild).toBe(true);
    expect(body.session.messages.map((message: { role: string }) => message.role)).toEqual([
      "assistant",
      "user",
      "assistant"
    ]);
    expect(updateCall.data.payload.payloadVersion).toBe(3);
    expect(updateCall.data.payload.messages.at(-1).role).toBe("assistant");
    expect(updateCall.data.payload.messages.at(-1).turnUi).toEqual({
      question: body.turn.question,
      quickReplies: body.turn.quickReplies
    });
    expect(JSON.stringify(body.session)).not.toContain("turnUi");
    expect(typeof updateCall.data.payload.lastMessageAt).toBe("string");
    expect(JSON.stringify(body)).not.toMatch(/provider|model|temperature|credits|billing/);
    await app.close();
  });

  it("appends messages to a completed creation session so another output can be shaped", async () => {
    mockAccessTokens({ "token-a": "user-a" });
    mockPrisma.mobileCreationDraft.findFirst.mockResolvedValueOnce(
      creationDraftRecord({
        id: "session-draft",
        status: "COMPLETED",
        payload: {
          payloadVersion: 3,
          messages: [
            { role: "assistant", content: "Hi! Tell me about your book." },
            { role: "user", content: "Bedtime story" }
          ]
        }
      })
    );
    mockPrisma.mobileCreationDraft.update.mockImplementation(async ({ data }: { data: Record<string, unknown> }) =>
      creationDraftRecord({ id: "session-draft", payload: data.payload, status: data.status })
    );
    const app = await buildMobileApp({ creationEnrichment: false });

    const response = await app.inject({
      method: "POST",
      url: "/api/mobile/creation-sessions/session-draft/messages",
      headers: bearer("token-a"),
      payload: { message: "Add a dragon" }
    });
    const updateCall = mockPrisma.mobileCreationDraft.update.mock.calls.at(0)?.[0] as {
      data: { payload: Record<string, any>; status: string };
    };

    expect(response.statusCode).toBe(200);
    expect(response.json().session.status).toBe("ACTIVE");
    expect(updateCall.data.status).toBe("ACTIVE");
    expect(updateCall.data.payload.messages.map((message: { role: string }) => message.role)).toEqual([
      "assistant",
      "user",
      "user",
      "assistant"
    ]);
    await app.close();
  });

  it("returns 404 for messages to an unknown creation session", async () => {
    mockAccessTokens({ "token-a": "user-a" });
    mockPrisma.mobileCreationDraft.findFirst.mockResolvedValueOnce(null);
    const app = await buildMobileApp({ creationEnrichment: false });

    const response = await app.inject({
      method: "POST",
      url: "/api/mobile/creation-sessions/missing/messages",
      headers: bearer("token-a"),
      payload: { message: "Hello" }
    });

    expect(response.statusCode).toBe(404);
    expect(response.json().error.code).toBe("SESSION_NOT_FOUND");
    await app.close();
  });

  it("branches the creation chat when editing a previous user message", async () => {
    mockAccessTokens({ "token-a": "user-a" });
    // Legacy flat transcript without ids: the server must mint stable ids
    // ("legacy-<index>") that the client can reference in editMessageId.
    mockPrisma.mobileCreationDraft.findFirst.mockResolvedValueOnce(
      creationDraftRecord({
        id: "session-draft",
        payload: {
          payloadVersion: 3,
          messages: [
            { role: "assistant", content: "Hi! Tell me about your book." },
            { role: "user", content: "Bedtime story for 5 year olds" },
            { role: "assistant", content: "Lovely! Any favourite animals?" }
          ]
        }
      })
    );
    mockPrisma.mobileCreationDraft.update.mockImplementation(async ({ data }: { data: Record<string, unknown> }) =>
      creationDraftRecord({ id: "session-draft", payload: data.payload })
    );
    const app = await buildMobileApp({ creationEnrichment: false });

    const response = await app.inject({
      method: "POST",
      url: "/api/mobile/creation-sessions/session-draft/messages",
      headers: bearer("token-a"),
      payload: { message: "Space adventure for teens", editMessageId: "legacy-1" }
    });
    const body = response.json();
    const updateCall = mockPrisma.mobileCreationDraft.update.mock.calls.at(0)?.[0] as {
      data: { payload: { messages: Array<Record<string, unknown>> } };
    };

    expect(response.statusCode).toBe(200);
    // The visible thread follows the new branch: greeting, edited message, fresh reply.
    expect(body.session.messages.map((message: { role: string }) => message.role)).toEqual([
      "assistant",
      "user",
      "assistant"
    ]);
    const editedSlot = body.session.messages[1];
    expect(editedSlot.content).toBe("Space adventure for teens");
    expect(editedSlot.branch).toMatchObject({ index: 2, total: 2, canGoPrevious: true, canGoNext: false });
    // The abandoned branch stays stored: original user turn is deactivated, not deleted.
    const stored = updateCall.data.payload.messages;
    const original = stored.find((message) => message.id === "legacy-1");
    expect(original).toMatchObject({ content: "Bedtime story for 5 year olds", isActiveChild: false });
    expect(stored.filter((message) => message.role === "user")).toHaveLength(2);
    expect(JSON.stringify(body.session)).not.toContain("isActiveChild");
    await app.close();
  });

  it("rejects edits that target an unknown or non-user message", async () => {
    mockAccessTokens({ "token-a": "user-a" });
    const draft = creationDraftRecord({
      id: "session-draft",
      payload: {
        payloadVersion: 3,
        messages: [
          { role: "assistant", content: "Hi!" },
          { role: "user", content: "Bedtime story" }
        ]
      }
    });
    mockPrisma.mobileCreationDraft.findFirst.mockResolvedValue(draft);
    const app = await buildMobileApp({ creationEnrichment: false });

    const unknown = await app.inject({
      method: "POST",
      url: "/api/mobile/creation-sessions/session-draft/messages",
      headers: bearer("token-a"),
      payload: { message: "Edited", editMessageId: "missing" }
    });
    const assistant = await app.inject({
      method: "POST",
      url: "/api/mobile/creation-sessions/session-draft/messages",
      headers: bearer("token-a"),
      payload: { message: "Edited", editMessageId: "legacy-0" }
    });

    expect(unknown.statusCode).toBe(404);
    expect(unknown.json().error.code).toBe("MESSAGE_NOT_FOUND");
    expect(assistant.statusCode).toBe(404);
    expect(assistant.json().error.code).toBe("MESSAGE_NOT_FOUND");
    await app.close();
  });

  it("switches between creation chat sibling branches", async () => {
    mockAccessTokens({ "token-a": "user-a" });
    // A stored tree with a fork under the greeting: the edited branch is active.
    mockPrisma.mobileCreationDraft.findFirst.mockResolvedValueOnce(
      creationDraftRecord({
        id: "session-draft",
        payload: {
          payloadVersion: 3,
          messages: [
            { id: "m0", parentId: null, isActiveChild: true, role: "assistant", content: "Hi!" },
            { id: "m1", parentId: "m0", isActiveChild: false, role: "user", content: "Bedtime story" },
            { id: "m2", parentId: "m1", isActiveChild: true, role: "assistant", content: "Reply about bedtime" },
            { id: "m3", parentId: "m0", isActiveChild: true, role: "user", content: "Space adventure" },
            { id: "m4", parentId: "m3", isActiveChild: true, role: "assistant", content: "Reply about space" }
          ]
        }
      })
    );
    mockPrisma.mobileCreationDraft.update.mockImplementation(async ({ data }: { data: Record<string, unknown> }) =>
      creationDraftRecord({ id: "session-draft", payload: data.payload })
    );
    const app = await buildMobileApp({ creationEnrichment: false });

    const response = await app.inject({
      method: "POST",
      url: "/api/mobile/creation-sessions/session-draft/branches",
      headers: bearer("token-a"),
      payload: { messageId: "m3", direction: "previous" }
    });
    const body = response.json();
    const updateCall = mockPrisma.mobileCreationDraft.update.mock.calls.at(0)?.[0] as {
      data: { payload: { messages: Array<Record<string, unknown>>; rawIdea: string } };
    };

    expect(response.statusCode).toBe(200);
    expect(body.session.messages.map((message: { id: string }) => message.id)).toEqual(["m0", "m1", "m2"]);
    expect(body.session.messages[1].branch).toMatchObject({
      index: 1,
      total: 2,
      canGoPrevious: false,
      canGoNext: true
    });
    // No fresh assistant text is generated for a switch.
    expect(body.turn.assistantMessage).toBe("");
    // The draft state now reflects the re-activated branch.
    expect(updateCall.data.payload.rawIdea).toContain("Bedtime story");
    const storedById = new Map(updateCall.data.payload.messages.map((message) => [message.id, message]));
    expect(storedById.get("m1")).toMatchObject({ isActiveChild: true });
    expect(storedById.get("m3")).toMatchObject({ isActiveChild: false });
    await app.close();
  });

  it("restores branch-specific grounded research when switching creation chat branches", async () => {
    mockAccessTokens({ "token-a": "user-a" });
    const bedtimeResearch = {
      query: "bedtime science",
      summary: "Grounded bedtime evidence.",
      sources: [{ title: "Sleep Foundation", summary: "A bedtime source." }]
    };
    const spaceResearch = {
      query: "space science",
      summary: "Grounded space evidence.",
      sources: [{ title: "NASA", summary: "A space source." }]
    };
    mockPrisma.mobileCreationDraft.findFirst.mockResolvedValueOnce(
      creationDraftRecord({
        id: "session-draft",
        payload: {
          payloadVersion: 3,
          messages: [
            { id: "m0", parentId: null, isActiveChild: true, role: "assistant", content: "Hi!" },
            { id: "m1", parentId: "m0", isActiveChild: false, role: "user", content: "Bedtime science" },
            {
              id: "m2",
              parentId: "m1",
              isActiveChild: true,
              role: "assistant",
              content: "Bedtime answer",
              research: bedtimeResearch
            },
            { id: "m3", parentId: "m0", isActiveChild: true, role: "user", content: "Space science" },
            {
              id: "m4",
              parentId: "m3",
              isActiveChild: true,
              role: "assistant",
              content: "Space answer",
              research: spaceResearch
            }
          ]
        }
      })
    );
    mockPrisma.mobileCreationDraft.update.mockImplementation(async ({ data }: { data: Record<string, unknown> }) =>
      creationDraftRecord({ id: "session-draft", payload: data.payload, lastTurn: data.lastTurn })
    );
    const app = await buildMobileApp({ creationEnrichment: false });

    const response = await app.inject({
      method: "POST",
      url: "/api/mobile/creation-sessions/session-draft/branches",
      headers: bearer("token-a"),
      payload: { messageId: "m3", direction: "previous" }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().session.messages.at(-1).research).toEqual(bedtimeResearch);
    expect(JSON.stringify(response.json().session)).not.toContain("space science");
    await app.close();
  });

  it("restores the localized question when switching creation chat branches", async () => {
    mockAccessTokens({ "token-a": "user-a" });
    mockPrisma.mobileCreationDraft.findFirst.mockResolvedValueOnce(
      creationDraftRecord({
        id: "session-draft",
        payload: {
          payloadVersion: 3,
          language: "pt",
          messages: [
            { id: "m0", parentId: null, isActiveChild: true, role: "assistant", content: "Olá!" },
            { id: "m1", parentId: "m0", isActiveChild: false, role: "user", content: "Uma história de romance" },
            {
              id: "m2",
              parentId: "m1",
              isActiveChild: true,
              role: "assistant",
              content: "Para quem você imagina essa história?",
              turnUi: {
                question: {
                  prompt: "Para quem é este livro?",
                  options: ["Jovens adultos", "Leitores de romance", "Público geral"],
                  allowCustom: true
                },
                quickReplies: []
              }
            },
            { id: "m3", parentId: "m0", isActiveChild: true, role: "user", content: "Uma história de suspense" },
            { id: "m4", parentId: "m3", isActiveChild: true, role: "assistant", content: "Que tipo de suspense?" }
          ]
        }
      })
    );
    mockPrisma.mobileCreationDraft.update.mockImplementation(async ({ data }: { data: Record<string, unknown> }) =>
      creationDraftRecord({ id: "session-draft", payload: data.payload, lastTurn: data.lastTurn })
    );
    const app = await buildMobileApp({ creationEnrichment: false });

    const response = await app.inject({
      method: "POST",
      url: "/api/mobile/creation-sessions/session-draft/branches",
      headers: bearer("token-a"),
      payload: { messageId: "m3", direction: "previous" }
    });
    const body = response.json();

    expect(response.statusCode).toBe(200);
    expect(body.turn.assistantMessage).toBe("");
    expect(body.turn.language).toBe("pt");
    expect(body.turn.question).toEqual({
      prompt: "Para quem é este livro?",
      options: ["Jovens adultos", "Leitores de romance", "Público geral"],
      allowCustom: true
    });
    expect(body.turn.quickReplies).toEqual([]);
    await app.close();
  });

  it("returns 404 when switching to an unknown creation chat branch", async () => {
    mockAccessTokens({ "token-a": "user-a" });
    mockPrisma.mobileCreationDraft.findFirst.mockResolvedValueOnce(
      creationDraftRecord({
        id: "session-draft",
        payload: {
          payloadVersion: 3,
          messages: [{ role: "assistant", content: "Hi!" }]
        }
      })
    );
    const app = await buildMobileApp({ creationEnrichment: false });

    const response = await app.inject({
      method: "POST",
      url: "/api/mobile/creation-sessions/session-draft/branches",
      headers: bearer("token-a"),
      payload: { messageId: "missing", direction: "previous" }
    });

    expect(response.statusCode).toBe(404);
    expect(response.json().error.code).toBe("MESSAGE_NOT_FOUND");
    await app.close();
  });

  it("exposes stable ids and parent links for legacy transcripts", async () => {
    mockAccessTokens({ "token-a": "user-a" });
    mockPrisma.mobileCreationDraft.findFirst.mockResolvedValue(
      creationDraftRecord({
        id: "session-draft",
        payload: {
          payloadVersion: 3,
          messages: [
            { role: "assistant", content: "Hi!" },
            { role: "user", content: "Bedtime story" }
          ]
        }
      })
    );
    const app = await buildMobileApp({ creationEnrichment: false });

    const response = await app.inject({
      method: "GET",
      url: "/api/mobile/creation-sessions/session-draft",
      headers: bearer("token-a")
    });
    const messages = response.json().session.messages;

    expect(response.statusCode).toBe(200);
    expect(messages).toEqual([
      expect.objectContaining({ id: "legacy-0", parentId: null, branch: null }),
      expect.objectContaining({ id: "legacy-1", parentId: "legacy-0", branch: null })
    ]);
    await app.close();
  });

  it("builds a project from a session and applies advanced overrides", async () => {
    mockAccessTokens({ "token-a": "user-a" });
    const payload = {
      payloadVersion: 3,
      rawIdea: "Workbook for new coaches",
      messages: [
        { role: "assistant", content: "Hi!" },
        { role: "user", content: "Workbook for new coaches" }
      ],
      selectedPresets: {
        bookType: "lead_magnet",
        lengthPreset: "short",
        qualityPreset: "balanced",
        imagesEnabled: true
      }
    };
    mockPrisma.mobileCreationDraft.findFirst.mockResolvedValueOnce(creationDraftRecord({ id: "session-draft", payload }));
    mockPrisma.template.findFirst.mockResolvedValue({ id: "template-workbook" });
    mockPrisma.project.create.mockImplementation(async ({ data }: { data: Record<string, any> }) =>
      projectRecord({
        id: "project-from-session",
        title: data.title,
        prompt: data.prompt,
        language: data.language,
        category: data.category,
        subcategory: data.subcategory ?? null,
        targetPages: data.targetPages,
        mediaSettings: data.mediaSettings,
        currentPlan: null,
        pages: [],
        _count: { pages: 0, images: 0, jobs: 0 }
      })
    );
    mockPrisma.mobileCreationDraft.update.mockImplementation(async ({ data }: { data: Record<string, unknown> }) =>
      creationDraftRecord({ id: "session-draft", payload, ...data })
    );
    mockPrisma.project.update.mockResolvedValue({});
    vi.mocked(enqueueGenerationJob).mockResolvedValueOnce(jobRecord({ id: "job-plan" }));
    const app = await buildMobileApp({ advisorEnrichment: false, creationEnrichment: false });

    const response = await app.inject({
      method: "POST",
      url: "/api/mobile/creation-sessions/session-draft/build",
      headers: bearer("token-a"),
      payload: {
        presets: {
          bookType: "workbook",
          lengthPreset: "standard",
          qualityPreset: "balanced",
          imagesEnabled: true,
          pageCountMode: "custom",
          targetPages: 28,
          pageCountSource: "settings"
        },
        language: "es"
      }
    });
    const createCall = mockPrisma.project.create.mock.calls.at(0)?.[0] as { data: Record<string, any> };

    expect(response.statusCode).toBe(201);
    expect(response.json()).toMatchObject({
      project: { id: "project-from-session", bookType: "workbook" },
      operation: { projectId: "project-from-session", status: "planning_queued", job: { id: "job-plan" } }
    });
    expect(createCall.data.language).toBe("es");
    expect(createCall.data.mediaSettings.mobile.bookType).toBe("workbook");
    await app.close();
  });

  it("defers untitled session project titles to the planner", async () => {
    mockAccessTokens({ "token-a": "user-a" });
    const payload = {
      payloadVersion: 3,
      rawIdea: "I want to create a similar story to the Rabit and Turtle race",
      messages: [
        { role: "assistant", content: "Hi!" },
        { role: "user", content: "I want to create a similar story to the Rabit and Turtle race" }
      ],
      selectedPresets: {
        bookType: "short_story",
        lengthPreset: "short",
        qualityPreset: "balanced",
        imagesEnabled: true,
        pageCountMode: "custom",
        targetPages: 8,
        pageCountSource: "settings"
      }
    };
    mockPrisma.mobileCreationDraft.findFirst.mockResolvedValueOnce(creationDraftRecord({ id: "session-draft", payload }));
    mockPrisma.template.findFirst.mockResolvedValue({ id: "template-story" });
    mockPrisma.project.create.mockImplementation(async ({ data }: { data: Record<string, any> }) =>
      projectRecord({
        id: "project-from-session",
        title: data.title,
        prompt: data.prompt,
        category: data.category,
        subcategory: data.subcategory ?? null,
        targetPages: data.targetPages,
        mediaSettings: data.mediaSettings,
        currentPlan: null,
        pages: [],
        _count: { pages: 0, images: 0, jobs: 0 }
      })
    );
    mockPrisma.mobileCreationDraft.update.mockImplementation(async ({ data }: { data: Record<string, unknown> }) =>
      creationDraftRecord({ id: "session-draft", payload, ...data })
    );
    mockPrisma.project.update.mockResolvedValue({});
    vi.mocked(enqueueGenerationJob).mockResolvedValueOnce(jobRecord({ id: "job-plan" }));
    const app = await buildMobileApp({ advisorEnrichment: false, creationEnrichment: false });

    const response = await app.inject({
      method: "POST",
      url: "/api/mobile/creation-sessions/session-draft/build",
      headers: bearer("token-a"),
      payload: {}
    });
    const createCall = mockPrisma.project.create.mock.calls.at(0)?.[0] as { data: Record<string, any> };
    const queuedCall = vi.mocked(enqueueGenerationJob).mock.calls.at(0)?.[0] as { payload: Record<string, any> };
    const inputSnapshot = queuedCall.payload.inputSnapshot as Record<string, any>;

    expect(response.statusCode).toBe(201);
    expect(response.json().project.title).toBe("Untitled Book");
    expect(createCall.data.title).toBe("Untitled Book");
    expect(createCall.data.mediaSettings.mobile.titleSource).toBe("planner_pending");
    expect(inputSnapshot).not.toHaveProperty("title");
    expect(inputSnapshot.mediaSettings.mobile.titleSource).toBe("planner_pending");
    await app.close();
  });

  it("keeps explicit mobile titles in the project row and planner snapshot", async () => {
    mockAccessTokens({ "token-a": "user-a" });
    const payload = {
      payloadVersion: 3,
      rawIdea: "Story about a careful race.",
      optionalDetails: { title: "The Meadow Finish" },
      messages: [
        { role: "assistant", content: "Hi!" },
        { role: "user", content: "Story about a careful race." }
      ],
      selectedPresets: {
        bookType: "short_story",
        lengthPreset: "short",
        qualityPreset: "balanced",
        imagesEnabled: true,
        pageCountMode: "custom",
        targetPages: 8,
        pageCountSource: "settings"
      }
    };
    mockPrisma.mobileCreationDraft.findFirst.mockResolvedValueOnce(creationDraftRecord({ id: "session-draft", payload }));
    mockPrisma.template.findFirst.mockResolvedValue({ id: "template-story" });
    mockPrisma.project.create.mockImplementation(async ({ data }: { data: Record<string, any> }) =>
      projectRecord({
        id: "project-from-session",
        title: data.title,
        prompt: data.prompt,
        category: data.category,
        subcategory: data.subcategory ?? null,
        targetPages: data.targetPages,
        mediaSettings: data.mediaSettings,
        currentPlan: null,
        pages: [],
        _count: { pages: 0, images: 0, jobs: 0 }
      })
    );
    mockPrisma.mobileCreationDraft.update.mockImplementation(async ({ data }: { data: Record<string, unknown> }) =>
      creationDraftRecord({ id: "session-draft", payload, ...data })
    );
    mockPrisma.project.update.mockResolvedValue({});
    vi.mocked(enqueueGenerationJob).mockResolvedValueOnce(jobRecord({ id: "job-plan" }));
    const app = await buildMobileApp({ advisorEnrichment: false, creationEnrichment: false });

    const response = await app.inject({
      method: "POST",
      url: "/api/mobile/creation-sessions/session-draft/build",
      headers: bearer("token-a"),
      payload: {}
    });
    const createCall = mockPrisma.project.create.mock.calls.at(0)?.[0] as { data: Record<string, any> };
    const queuedCall = vi.mocked(enqueueGenerationJob).mock.calls.at(0)?.[0] as { payload: Record<string, any> };
    const inputSnapshot = queuedCall.payload.inputSnapshot as Record<string, any>;

    expect(response.statusCode).toBe(201);
    expect(createCall.data.title).toBe("The Meadow Finish");
    expect(createCall.data.mediaSettings.mobile.titleSource).toBeUndefined();
    expect(inputSnapshot.title).toBe("The Meadow Finish");
    await app.close();
  });

  it("maps product presets into backend settings while returning a mobile-safe creation DTO", async () => {
    mockAccessTokens({ "token-a": "user-a" });
    mockPrisma.template.findFirst.mockResolvedValue({ id: "template-business" });
    mockPrisma.project.create.mockImplementation(async ({ data }: { data: Record<string, unknown> }) =>
      projectRecord({
        id: "project-1",
        title: data.title,
        authorName: data.authorName ?? null,
        prompt: data.prompt,
        category: data.category,
        subcategory: data.subcategory ?? null,
        targetPages: data.targetPages,
        mediaSettings: data.mediaSettings,
        currentPlan: null,
        pages: [],
        _count: { pages: 0, images: 0, jobs: 0 }
      })
    );
    const app = await buildMobileApp();

    const response = await app.inject({
      method: "POST",
      url: "/api/mobile/projects",
      headers: bearer("token-a"),
      payload: {
        bookType: "lead_magnet",
        title: "Pricing Guide",
        authorName: "Nora",
        prompt: "Create a practical pricing guide for solo consultants.",
        lengthPreset: "standard",
        qualityPreset: "premium",
        imagesEnabled: true,
        language: "en"
      }
    });
    const body = response.json();
    const createCall = mockPrisma.project.create.mock.calls.at(0)?.[0] as { data: Record<string, any> };

    expect(response.statusCode).toBe(201);
    expect(createCall.data).toMatchObject({
      userId: "user-a",
      title: "Pricing Guide",
      category: "BUSINESS",
      subcategory: "Lead Magnet Ebook",
      targetPages: 18,
      complexity: 6,
      temperature: 0.55,
      mediaSettings: expect.objectContaining({
        fullIllustrations: true,
        includeCover: true,
        finalReview: true,
        draftCandidates: 2,
        generationStrategy: "auto",
        mobile: expect.objectContaining({
          bookType: "lead_magnet",
          bookTypeChoice: "lead_magnet",
          lengthPreset: "standard",
          qualityPreset: "premium",
          imagesEnabled: true,
          pageCountMode: "auto",
          pageCountSource: "legacy",
          targetPages: 18
        })
      })
    });
    expect(Object.keys(body.project).sort()).toMatchInlineSnapshot(`
      [
        "authorName",
        "bookType",
        "coverImage",
        "createdAt",
        "currentAction",
        "exports",
        "hasPlan",
        "id",
        "imageCount",
        "imagesEnabled",
        "language",
        "lengthPreset",
        "pageCount",
        "pages",
        "plan",
        "progressPercent",
        "prompt",
        "promptPreview",
        "quality",
        "qualityPreset",
        "status",
        "statusLabel",
        "subtitle",
        "targetPages",
        "title",
        "updatedAt",
      ]
    `);
    expect(JSON.stringify(body.project)).not.toMatch(/provider|model|temperature|generationStrategy|mediaSettings|complexity/);
    await app.close();
  });

  it("keeps fast, balanced, and premium preset mappings server-side", async () => {
    const { buildMobileCreateProjectInput } = await import("./mobileProjects.js");

    const fast = buildMobileCreateProjectInput({
      bookType: "short_story",
      prompt: "Write a short story about a lighthouse keeper who hears impossible music.",
      qualityPreset: "fast",
      lengthPreset: "short",
      imagesEnabled: false
    });
    const balanced = buildMobileCreateProjectInput({
      bookType: "workbook",
      prompt: "Create a study workbook for adults learning practical Spanish conversation.",
      qualityPreset: "balanced",
      lengthPreset: "standard",
      imagesEnabled: true
    });
    const premium = buildMobileCreateProjectInput({
      bookType: "lead_magnet",
      prompt: "Create a polished lead magnet about packaging consulting offers.",
      qualityPreset: "premium",
      lengthPreset: "expanded",
      imagesEnabled: true
    });

    expect(fast).toMatchObject({
      category: "STORY",
      targetPages: 8,
      complexity: 4,
      temperature: 0.65,
      mediaSettings: expect.objectContaining({
        finalReview: false,
        includeCover: false,
        fullIllustrations: false,
        generationStrategy: "auto",
        parallelPageGeneration: true,
        draftCandidates: 1,
        modelTier: "fast"
      })
    });
    expect(balanced).toMatchObject({
      category: "EDUCATION",
      targetPages: 28,
      complexity: 5,
      temperature: 0.65,
      mediaSettings: expect.objectContaining({ finalReview: true, draftCandidates: 1, modelTier: "balanced" })
    });
    expect(premium).toMatchObject({
      category: "BUSINESS",
      targetPages: 24,
      complexity: 6,
      temperature: 0.55,
      mediaSettings: expect.objectContaining({
        finalReview: true,
        draftCandidates: 2,
        parallelPageGeneration: false,
        modelTier: "premium"
      })
    });
    // Mobile inputs carry a tier name, never a concrete provider/model selection.
    expect(JSON.stringify({ fast, balanced, premium })).not.toMatch(/provider|textModel|imageModel/);
  });

  it("lists and reads only the signed-in user's mobile project DTOs", async () => {
    mockAccessTokens({ "token-a": "user-a", "token-b": "user-b" });
    mockPrisma.project.findMany.mockResolvedValueOnce([projectRecord({ id: "project-a", title: "Owned Mobile Book" })]);
    mockPrisma.project.findFirst.mockResolvedValueOnce(null);
    const app = await buildMobileApp();

    const list = await app.inject({
      method: "GET",
      url: "/api/mobile/projects",
      headers: bearer("token-a")
    });
    const crossUserDetail = await app.inject({
      method: "GET",
      url: "/api/mobile/projects/project-b",
      headers: bearer("token-a")
    });

    expect(list.statusCode).toBe(200);
    expect(list.json().projects).toEqual([expect.objectContaining({ id: "project-a", title: "Owned Mobile Book" })]);
    expect(mockPrisma.project.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { userId: "user-a" } }));
    expect(crossUserDetail.statusCode).toBe(404);
    expect(mockPrisma.project.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "project-b", userId: "user-a" } })
    );
    expect(JSON.stringify(list.json())).not.toMatch(/temperature|generationStrategy|provider|model|mediaSettings|cost|tokens/);
    await app.close();
  });

  it("returns generated page previews and mobile-safe image references on project detail", async () => {
    mockAccessTokens({ "token-a": "user-a" });
    mockPrisma.project.findFirst.mockResolvedValueOnce(
      projectRecord({
        id: "project-a",
        title: "Preview Book",
        status: "GENERATING",
        pages: [
          {
            id: "page-1",
            projectId: "project-a",
            index: 1,
            title: "Set the promise",
            markdown:
              "## Set the promise\n\nA strong promise names the reader, the outcome, and the moment they can see progress.",
            summary: "Define the result the reader should get.",
            status: "COMPLETED",
            images: [
              {
                id: "image-page",
                projectId: "project-a",
                pageId: "page-1",
                type: "DIAGRAM",
                path: "http://localhost:4001/assets/images/project-a/page-1.png",
                metadata: { mimeType: "image/png", model: "hidden" }
              }
            ]
          }
        ],
        images: [
          {
            id: "image-cover",
            projectId: "project-a",
            pageId: null,
            type: "COVER",
            path: "http://localhost:4001/assets/images/project-a/cover.png",
            metadata: { mimeType: "image/png", provider: "hidden" }
          }
        ],
        _count: { pages: 1, images: 2, jobs: 1 }
      })
    );
    const app = await buildMobileApp();

    const response = await app.inject({
      method: "GET",
      url: "/api/mobile/projects/project-a",
      headers: bearer("token-a")
    });
    const project = response.json().project;

    expect(response.statusCode).toBe(200);
    expect(project.pages[0]).toMatchObject({
      title: "Set the promise",
      previewText: expect.stringContaining("A strong promise names the reader"),
      image: {
        id: "image-page",
        url: "/api/mobile/projects/project-a/assets/image-page",
        contentType: "image/png"
      }
    });
    expect(project.coverImage).toMatchObject({
      id: "image-cover",
      role: "cover",
      url: "/api/mobile/projects/project-a/assets/image-cover"
    });
    expect(JSON.stringify(project)).not.toMatch(/temperature|generationStrategy|mediaSettings|cost|tokens/);
    await app.close();
  });

  it("returns a readable mobile status DTO without queue-centric internals", async () => {
    mockAccessTokens({ "token-a": "user-a" });
    mockPrisma.project.findFirst.mockResolvedValue({ id: "project-1" });
    vi.mocked(buildProjectStatus).mockResolvedValue(
      statusRecord({
        project: {
          id: "project-1",
          title: "Progress Book",
          status: "GENERATING",
          updatedAt: new Date("2026-06-15T12:30:00.000Z"),
          jobs: [
            { id: "job-failed", type: "GENERATE_PAGE", status: "FAILED", error: "Page draft timed out." },
            { id: "job-active", type: "GENERATE_PAGE", status: "ACTIVE", error: null }
          ]
        },
        progress: {
          pages: { complete: 3, target: 10 },
          images: 1,
          resumableFailedJobs: 1,
          pipeline: [
            { key: "plan", label: "Plan", status: "done" },
            { key: "pages", label: "Pages", status: "active", detail: "3/10 pages" },
            { key: "images", label: "Images", status: "pending", detail: "1 images" },
            { key: "export", label: "Export", status: "pending" }
          ]
        },
        quality: {
          state: "review_recommended",
          score: 88,
          issues: [
            {
              code: "CHAPTER_TRANSITION",
              severity: "warning",
              source: "model",
              message: "The handoff is abrupt.",
              guidance: "Review pages 3 and 4.",
              affectedPageIndexes: [3, 4]
            }
          ],
          affectedPageIndexes: [3, 4]
        }
      })
    );
    const app = await buildMobileApp();

    const response = await app.inject({
      method: "GET",
      url: "/api/mobile/projects/project-1/status",
      headers: bearer("token-a")
    });
    const body = response.json();

    expect(response.statusCode).toBe(200);
    expect(body.status).toMatchObject({
      projectId: "project-1",
      status: "generating",
      statusLabel: "Generating your book",
      progressPercent: 38,
      currentAction: "Writing your book pages.",
      retryAvailable: true,
      pageProgress: { completed: 3, target: 10 },
      imageCount: 1
    });
    expect(body.status.quality).toMatchObject({
      state: "review_recommended",
      score: 88,
      affectedPageIndexes: [3, 4]
    });
    expect(body.status.failureMessage).toContain("while writing a page");
    expect(body.status.failureMessage).not.toContain("GENERATE_PAGE");
    expect(JSON.stringify(body.status)).not.toMatch(/jobs|queue|tokens|cost|provider/);
    await app.close();
  });

  it("exposes real planning milestones without queue internals", async () => {
    mockAccessTokens({ "token-a": "user-a" });
    mockPrisma.project.findFirst.mockResolvedValue({ id: "project-1" });
    vi.mocked(buildProjectStatus).mockResolvedValue(
      statusRecord({
        project: {
          status: "PLANNING",
          jobs: [
            {
              id: "job-plan",
              type: "PLAN_BOOK",
              status: "ACTIVE",
              progress: 55,
              error: null,
              steps: [
                { key: "research", label: "Research", status: "done" },
                { key: "plan", label: "Create plan", status: "active" },
                { key: "save", label: "Save plan", status: "pending" }
              ]
            }
          ]
        },
        progress: {
          pipeline: [
            { key: "plan", label: "Plan", status: "active", detail: "Planning in progress" },
            { key: "pages", label: "Pages", status: "pending", detail: "0/12 pages" },
            { key: "images", label: "Images", status: "pending", detail: "0 images" },
            { key: "export", label: "Export", status: "pending" }
          ]
        }
      })
    );
    const app = await buildMobileApp();

    const response = await app.inject({
      method: "GET",
      url: "/api/mobile/projects/project-1/status",
      headers: bearer("token-a")
    });
    const status = response.json().status;

    expect(response.statusCode).toBe(200);
    expect(status.currentAction).toBe("Shaping the chapters and flow");
    expect(status.planningProgress).toEqual({
      percent: 55,
      steps: [
        { key: "understand", label: "Understanding your idea", status: "done" },
        { key: "shape", label: "Shaping the chapters and flow", status: "active" },
        { key: "finalize", label: "Finalizing your plan", status: "pending" }
      ]
    });
    expect(JSON.stringify(status)).not.toMatch(/job-plan|PLAN_BOOK|queue|Research|Create plan|Save plan/);
    await app.close();
  });

  it("uses live generated output to advance planning within milestone guardrails", async () => {
    mockAccessTokens({ "token-a": "user-a" });
    mockPrisma.project.findFirst.mockResolvedValue({ id: "project-1" });
    const planningStatus = (outputTokens: number) =>
      statusRecord({
        project: {
          status: "PLANNING",
          targetPages: 24,
          jobs: [
            {
              id: "job-plan",
              type: "PLAN_BOOK",
              status: "ACTIVE",
              progress: 45,
              error: null,
              tokens: { outputTokens },
              steps: [
                { key: "research", label: "Research", status: "done" },
                { key: "plan", label: "Create plan", status: "active" },
                { key: "save", label: "Save plan", status: "pending" }
              ]
            }
          ]
        },
        progress: {
          pipeline: [
            { key: "plan", label: "Plan", status: "active", detail: "Planning in progress" },
            { key: "pages", label: "Pages", status: "pending", detail: "0/24 pages" },
            { key: "images", label: "Images", status: "pending", detail: "0 images" },
            { key: "export", label: "Export", status: "pending" }
          ]
        }
      });
    vi.mocked(buildProjectStatus)
      .mockResolvedValueOnce(planningStatus(200))
      .mockResolvedValueOnce(planningStatus(1_200))
      .mockResolvedValueOnce(planningStatus(100_000));
    const app = await buildMobileApp();

    const percentages: number[] = [];
    for (let index = 0; index < 3; index += 1) {
      const response = await app.inject({
        method: "GET",
        url: "/api/mobile/projects/project-1/status",
        headers: bearer("token-a")
      });
      expect(response.statusCode).toBe(200);
      percentages.push(response.json().status.planningProgress.percent);
      expect(JSON.stringify(response.json().status)).not.toMatch(/tokens|provider|model|cost|queue/i);
    }

    expect(percentages[0]).toBeGreaterThan(45);
    expect(percentages[1]).toBeGreaterThan(percentages[0]!);
    expect(percentages[2]).toBeGreaterThanOrEqual(percentages[1]!);
    expect(percentages[2]).toBeLessThan(100);
    await app.close();
  });

  it("preserves milestone progress when no live output tokens are available", async () => {
    mockAccessTokens({ "token-a": "user-a" });
    mockPrisma.project.findFirst.mockResolvedValue({ id: "project-1" });
    vi.mocked(buildProjectStatus).mockResolvedValue(
      statusRecord({
        project: {
          status: "PLANNING",
          targetPages: 24,
          jobs: [
            {
              id: "job-plan",
              type: "PLAN_BOOK",
              status: "ACTIVE",
              progress: 45,
              error: null,
              tokens: { outputTokens: 0 },
              steps: [
                { key: "research", label: "Research", status: "done" },
                { key: "plan", label: "Create plan", status: "active" },
                { key: "save", label: "Save plan", status: "pending" }
              ]
            }
          ]
        },
        progress: {
          pipeline: [
            { key: "plan", label: "Plan", status: "active", detail: "Planning in progress" },
            { key: "pages", label: "Pages", status: "pending", detail: "0/24 pages" },
            { key: "images", label: "Images", status: "pending", detail: "0 images" },
            { key: "export", label: "Export", status: "pending" }
          ]
        }
      })
    );
    const app = await buildMobileApp();

    const response = await app.inject({
      method: "GET",
      url: "/api/mobile/projects/project-1/status",
      headers: bearer("token-a")
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().status.planningProgress.percent).toBe(45);
    await app.close();
  });

  it("uses a smaller adaptive output target for live plan revisions", async () => {
    mockAccessTokens({ "token-a": "user-a" });
    mockPrisma.project.findFirst.mockResolvedValue({ id: "project-1" });
    vi.mocked(buildProjectStatus).mockResolvedValue(
      statusRecord({
        project: {
          status: "PLANNING",
          targetPages: 24,
          jobs: [
            {
              id: "job-revision",
              type: "REVISE_PLAN",
              status: "ACTIVE",
              progress: 35,
              error: null,
              tokens: { outputTokens: 450 },
              steps: [
                { key: "revise", label: "Revise plan", status: "active" },
                { key: "save", label: "Save revision", status: "pending" }
              ]
            }
          ]
        },
        progress: {
          pipeline: [
            { key: "plan", label: "Plan", status: "active", detail: "Planning in progress" },
            { key: "pages", label: "Pages", status: "pending", detail: "0/24 pages" },
            { key: "images", label: "Images", status: "pending", detail: "0 images" },
            { key: "export", label: "Export", status: "pending" }
          ]
        }
      })
    );
    const app = await buildMobileApp();

    const response = await app.inject({
      method: "GET",
      url: "/api/mobile/projects/project-1/status",
      headers: bearer("token-a")
    });
    const status = response.json().status;

    expect(response.statusCode).toBe(200);
    expect(status.currentAction).toBe("Improving your plan");
    expect(status.planningProgress.percent).toBeGreaterThan(35);
    expect(status.planningProgress.percent).toBeLessThan(90);
    expect(JSON.stringify(status)).not.toMatch(/tokens|provider|model|cost|queue/i);
    await app.close();
  });

  it("keeps completed planning milestones for the plan-ready handoff", async () => {
    mockAccessTokens({ "token-a": "user-a" });
    mockPrisma.project.findFirst.mockResolvedValue({ id: "project-1" });
    vi.mocked(buildProjectStatus).mockResolvedValue(
      statusRecord({
        project: {
          status: "PLAN_READY",
          jobs: [
            {
              id: "job-plan",
              type: "PLAN_BOOK",
              status: "COMPLETED",
              progress: 100,
              error: null,
              steps: [
                { key: "research", label: "Research", status: "done" },
                { key: "plan", label: "Create plan", status: "done" },
                { key: "save", label: "Save plan", status: "done" }
              ]
            }
          ]
        },
        progress: {
          pipeline: [
            { key: "plan", label: "Plan", status: "done", detail: "Plan ready" },
            { key: "pages", label: "Pages", status: "pending", detail: "0/12 pages" },
            { key: "images", label: "Images", status: "pending", detail: "0 images" },
            { key: "export", label: "Export", status: "pending" }
          ]
        }
      })
    );
    const app = await buildMobileApp();

    const response = await app.inject({
      method: "GET",
      url: "/api/mobile/projects/project-1/status",
      headers: bearer("token-a")
    });
    const status = response.json().status;

    expect(response.statusCode).toBe(200);
    expect(status.currentAction).toBe("Ready for review.");
    expect(status.planningProgress).toEqual({
      percent: 100,
      steps: [
        { key: "understand", label: "Understanding your idea", status: "done" },
        { key: "shape", label: "Shaping the chapters and flow", status: "done" },
        { key: "finalize", label: "Finalizing your plan", status: "done" }
      ]
    });
    await app.close();
  });

  it("uses revision copy and a safe queued planning fallback", async () => {
    mockAccessTokens({ "token-a": "user-a" });
    mockPrisma.project.findFirst.mockResolvedValue({ id: "project-1" });
    vi.mocked(buildProjectStatus).mockResolvedValue(
      statusRecord({
        project: {
          status: "PLANNING",
          jobs: [
            {
              id: "job-revision",
              type: "REVISE_PLAN",
              status: "QUEUED",
              progress: 0,
              error: null,
              steps: []
            }
          ]
        },
        progress: {
          pipeline: [
            { key: "plan", label: "Plan", status: "active", detail: "Planning in progress" },
            { key: "pages", label: "Pages", status: "pending", detail: "0/12 pages" },
            { key: "images", label: "Images", status: "pending", detail: "0 images" },
            { key: "export", label: "Export", status: "pending" }
          ]
        }
      })
    );
    const app = await buildMobileApp();

    const response = await app.inject({
      method: "GET",
      url: "/api/mobile/projects/project-1/status",
      headers: bearer("token-a")
    });
    const status = response.json().status;

    expect(response.statusCode).toBe(200);
    expect(status.currentAction).toBe("Improving your plan");
    expect(status.planningProgress).toEqual({
      percent: 0,
      steps: [
        { key: "understand", label: "Understanding your changes", status: "done" },
        { key: "shape", label: "Improving your plan", status: "active" },
        { key: "finalize", label: "Saving your revision", status: "pending" }
      ]
    });
    expect(JSON.stringify(status)).not.toMatch(/job-revision|REVISE_PLAN|queue/);
    await app.close();
  });

  it("exposes mobile credit balance and active entitlements without provider internals", async () => {
    mockAccessTokens({ "token-a": "user-a" });
    vi.mocked(getCreditBalance).mockResolvedValue({
      availableCredits: 850,
      reservedCredits: 150,
      lifetimeCreditsGranted: 1000,
      lifetimeCreditsSpent: 150
    });
    vi.mocked(listActiveUserEntitlements).mockResolvedValue([
      {
        id: "entitlement-export",
        userId: "user-a",
        projectId: "project-1",
        type: "EXPORT_UNLOCK",
        status: "ACTIVE",
        source: "credits",
        creditsCost: 150,
        startsAt: new Date("2026-06-15T12:00:00.000Z"),
        expiresAt: null
      }
    ]);
    const app = await buildMobileApp();

    const response = await app.inject({
      method: "GET",
      url: "/api/mobile/billing",
      headers: bearer("token-a")
    });
    const body = response.json();

    expect(response.statusCode).toBe(200);
    expect(body.billing.credits).toEqual({
      available: 850,
      reserved: 150,
      lifetimeGranted: 1000,
      lifetimeSpent: 150
    });
    expect(body.billing.entitlements).toEqual([
      expect.objectContaining({
        type: "EXPORT_UNLOCK",
        projectId: "project-1",
        creditsCost: 150
      })
    ]);
    expect(body.billing.products.map((product: { sku: string }) => product.sku)).toContain("tomeza.one_book_export");
    expect(JSON.stringify(body.billing)).not.toMatch(/provider|model|temperature|generationStrategy/);
    await app.close();
  });

  it("verifies Google Play purchase tokens before granting mobile credits", async () => {
    mockAccessTokens({ "token-a": "user-a" });
    mockPrisma.productCatalog.findUnique.mockResolvedValueOnce({
      sku: "tomeza.credit_pack_1",
      productType: "CREDIT_PACK",
      active: true
    });
    vi.mocked(recordVerifiedGooglePlayPurchase).mockResolvedValueOnce({
      purchaseRecordId: "purchase-credit-pack",
      status: "GRANTED",
      creditsGranted: 1000,
      ledgerEntryId: "ledger-credit-pack",
      subscriptionStatus: null,
      entitlementType: null
    });
    vi.mocked(getCreditBalance).mockResolvedValueOnce({
      availableCredits: 1100,
      reservedCredits: 0,
      lifetimeCreditsGranted: 1100,
      lifetimeCreditsSpent: 0
    });
    const verifier = {
      verifyPurchase: vi.fn(async () => ({
        productSku: "tomeza.credit_pack_1",
        purchaseToken: "google-token-1",
        kind: "one_time" as const,
        grantable: true,
        providerStatus: "PURCHASED",
        externalPurchaseId: "GPA.1111-2222-3333-44444",
        purchasedAt: new Date("2026-06-15T12:00:00.000Z"),
        quantity: 1,
        metadata: { mockedGoogle: true }
      }))
    };
    const app = await buildMobileApp({ googlePlayVerifier: verifier });

    const response = await app.inject({
      method: "POST",
      url: "/api/mobile/billing/google-play/verify",
      headers: bearer("token-a"),
      payload: {
        productId: "tomeza.credit_pack_1",
        purchaseToken: "google-token-1",
        transactionId: "GPA.1111-2222-3333-44444",
        purchaseStatus: "purchased",
        projectId: "project-1"
      }
    });
    const body = response.json();

    expect(response.statusCode).toBe(200);
    expect(verifier.verifyPurchase).toHaveBeenCalledWith({
      packageName: "",
      productId: "tomeza.credit_pack_1",
      productType: "CREDIT_PACK",
      purchaseToken: "google-token-1"
    });
    expect(vi.mocked(recordVerifiedGooglePlayPurchase)).toHaveBeenCalledWith({
      userId: "user-a",
      verification: expect.objectContaining({
        productSku: "tomeza.credit_pack_1",
        purchaseToken: "google-token-1",
        grantable: true,
        metadata: expect.objectContaining({
          clientTransactionId: "GPA.1111-2222-3333-44444",
          clientPurchaseStatus: "purchased",
          projectId: "project-1"
        })
      })
    });
    expect(body.purchase).toEqual({
      id: "purchase-credit-pack",
      status: "granted",
      creditsGranted: 1000,
      subscriptionStatus: null,
      entitlementType: null
    });
    expect(body.billing.credits.available).toBe(1100);
    expect(JSON.stringify(body)).not.toMatch(/provider|model|temperature|generationStrategy|purchaseToken/);
    await app.close();
  });

  it("uses debug Google Play verification for local credit purchases", async () => {
    process.env.NODE_ENV = "development";
    delete process.env.MOCK_GOOGLE_PLAY_BILLING;
    mockAccessTokens({ "token-a": "user-a" });
    mockPrisma.productCatalog.findUnique.mockResolvedValueOnce({
      sku: "tomeza.credit_pack_2",
      productType: "CREDIT_PACK",
      active: true
    });
    vi.mocked(recordVerifiedGooglePlayPurchase).mockResolvedValueOnce({
      purchaseRecordId: "purchase-debug-credit-pack",
      status: "GRANTED",
      creditsGranted: 2000,
      ledgerEntryId: "ledger-debug-credit-pack",
      subscriptionStatus: null,
      entitlementType: null
    });
    vi.mocked(getCreditBalance).mockResolvedValueOnce({
      availableCredits: 2100,
      reservedCredits: 0,
      lifetimeCreditsGranted: 2100,
      lifetimeCreditsSpent: 0
    });
    const app = await buildMobileApp();

    const response = await app.inject({
      method: "POST",
      url: "/api/mobile/billing/google-play/verify",
      headers: bearer("token-a"),
      payload: {
        productId: "tomeza.credit_pack_2",
        purchaseToken: "debug-token-1",
        transactionId: "debug-order-1",
        purchaseStatus: "purchased"
      }
    });
    const body = response.json();

    expect(response.statusCode).toBe(200);
    expect(vi.mocked(recordVerifiedGooglePlayPurchase)).toHaveBeenCalledWith({
      userId: "user-a",
      verification: expect.objectContaining({
        productSku: "tomeza.credit_pack_2",
        purchaseToken: "debug-token-1",
        kind: "one_time",
        grantable: true,
        providerStatus: "MOCK_PURCHASED",
        metadata: expect.objectContaining({
          mockGooglePlayBilling: true,
          clientTransactionId: "debug-order-1",
          clientPurchaseStatus: "purchased"
        })
      })
    });
    expect(body.purchase).toEqual({
      id: "purchase-debug-credit-pack",
      status: "granted",
      creditsGranted: 2000,
      subscriptionStatus: null,
      entitlementType: null
    });
    expect(body.billing.credits.available).toBe(2100);
    await app.close();
  });

  it("does not grant pending Google Play purchases", async () => {
    mockAccessTokens({ "token-a": "user-a" });
    mockPrisma.productCatalog.findUnique.mockResolvedValueOnce({
      sku: "tomeza.one_book_export",
      productType: "ONE_TIME_UNLOCK",
      active: true
    });
    vi.mocked(recordVerifiedGooglePlayPurchase).mockResolvedValueOnce({
      purchaseRecordId: "purchase-pending",
      status: "PENDING",
      creditsGranted: 0,
      ledgerEntryId: null,
      subscriptionStatus: null,
      entitlementType: null
    });
    const verifier = {
      verifyPurchase: vi.fn(async () => ({
        productSku: "tomeza.one_book_export",
        purchaseToken: "pending-token",
        kind: "one_time" as const,
        grantable: false,
        providerStatus: "PENDING",
        quantity: 1
      }))
    };
    const app = await buildMobileApp({ googlePlayVerifier: verifier });

    const response = await app.inject({
      method: "POST",
      url: "/api/mobile/billing/google-play/verify",
      headers: bearer("token-a"),
      payload: {
        productId: "tomeza.one_book_export",
        purchaseToken: "pending-token",
        purchaseStatus: "purchased"
      }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().purchase).toMatchObject({
      status: "pending",
      creditsGranted: 0
    });
    expect(vi.mocked(recordVerifiedGooglePlayPurchase)).toHaveBeenCalledWith({
      userId: "user-a",
      verification: expect.objectContaining({ grantable: false, providerStatus: "PENDING" })
    });
    await app.close();
  });

  it("queues mobile-safe plan creation, revision, and approval responses", async () => {
    mockAccessTokens({ "token-a": "user-a" });
    mockPrisma.project.findFirst.mockResolvedValueOnce(projectRecord({ id: "project-1" }));
    mockPrisma.project.update.mockResolvedValue({});
    vi.mocked(enqueueGenerationJob).mockResolvedValueOnce(jobRecord({ id: "job-plan" }));
    mockPrisma.planVersion.findFirst
      .mockResolvedValueOnce({ id: "plan-1", projectId: "project-1", status: "DRAFT" })
      .mockResolvedValueOnce({ id: "plan-1", projectId: "project-1", status: "DRAFT", project: projectRecord({ id: "project-1" }) });
    mockPrisma.planVersion.updateMany.mockResolvedValue({ count: 1 });
    mockPrisma.planVersion.update.mockResolvedValue({});
    vi.mocked(enqueueGenerationJob)
      .mockResolvedValueOnce(jobRecord({ id: "job-revise" }))
      .mockResolvedValueOnce(jobRecord({ id: "job-generate" }));
    const app = await buildMobileApp();

    const plan = await app.inject({
      method: "POST",
      url: "/api/mobile/projects/project-1/plan",
      headers: bearer("token-a"),
      payload: {}
    });
    const revise = await app.inject({
      method: "POST",
      url: "/api/mobile/plans/plan-1/revise",
      headers: bearer("token-a"),
      payload: { message: "Make the examples warmer and more practical." }
    });
    const approve = await app.inject({
      method: "POST",
      url: "/api/mobile/plans/plan-1/approve",
      headers: bearer("token-a")
    });

    expect(plan.statusCode).toBe(202);
    expect(plan.json()).toMatchObject({
      projectId: "project-1",
      planId: null,
      status: "planning_queued",
      job: { id: "job-plan", status: "queued" }
    });
    expect(revise.statusCode).toBe(202);
    expect(revise.json()).toMatchObject({
      projectId: "project-1",
      planId: "plan-1",
      status: "revision_queued",
      job: { id: "job-revise", status: "queued" }
    });
    expect(approve.statusCode).toBe(202);
    expect(approve.json()).toMatchObject({
      projectId: "project-1",
      planId: "plan-1",
      status: "generation_queued",
      job: { id: "job-generate", status: "queued" }
    });
    expect(vi.mocked(enqueueGenerationJob).mock.calls.map((call) => call[0])).toEqual([
      expect.objectContaining({ projectId: "project-1", type: "PLAN_BOOK" }),
      expect.objectContaining({
        projectId: "project-1",
        type: "REVISE_PLAN",
        payload: expect.objectContaining({
          planId: "plan-1",
          message: "Make the examples warmer and more practical.",
          billingLedgerEntryId: "ledger-PLAN_REVISION",
          editOperationId: "operation-1"
        })
      }),
      expect.objectContaining({
        projectId: "project-1",
        type: "GENERATE_BOOK",
        payload: expect.objectContaining({ planId: "plan-1", billingLedgerEntryId: "ledger-FULL_BOOK_GENERATION" })
      })
    ]);
    expect(vi.mocked(reserveCredits)).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "user-a",
        projectId: "project-1",
        operation: "PLAN_REVISION",
        amountCredits: expect.any(Number)
      })
    );
    expect(vi.mocked(reserveCredits)).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "user-a",
        projectId: "project-1",
        operation: "FULL_BOOK_GENERATION",
        amountCredits: expect.any(Number)
      })
    );
    expect(vi.mocked(grantProjectEntitlement)).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "user-a",
        projectId: "project-1",
        type: "EXPORT_UNLOCK",
        relatedLedgerEntryId: "ledger-FULL_BOOK_GENERATION"
      })
    );
    expect(JSON.stringify({ plan: plan.json(), revise: revise.json(), approve: approve.json() })).not.toMatch(
      /strategy|provider|model|temperature/
    );
    await app.close();
  });

  it("retries recoverable mobile generation failures without returning queue internals", async () => {
    mockAccessTokens({ "token-a": "user-a" });
    mockPrisma.project.findFirst.mockResolvedValueOnce(
      projectRecord({
        id: "project-1",
        currentPlanId: "plan-1",
        currentPlan: { id: "plan-1", createdAt: new Date("2026-06-15T12:00:00.000Z") }
      })
    );
    mockPrisma.generationJob.findMany.mockResolvedValueOnce([
      jobRecord({
        id: "job-failed-page",
        projectId: "project-1",
        type: "GENERATE_PAGE",
        status: "FAILED",
        payload: { pageId: "page-1", planId: "plan-1" },
        createdAt: new Date("2026-06-15T12:10:00.000Z")
      })
    ]);
    mockPrisma.page.findMany.mockResolvedValueOnce([{ id: "page-1" }]);
    mockPrisma.project.update.mockResolvedValueOnce({});
    vi.mocked(requeueGenerationJob).mockResolvedValueOnce(jobRecord({ id: "job-failed-page", status: "QUEUED" }));
    const app = await buildMobileApp();

    const response = await app.inject({
      method: "POST",
      url: "/api/mobile/projects/project-1/resume",
      headers: bearer("token-a")
    });
    const body = response.json();

    expect(response.statusCode).toBe(202);
    expect(body).toEqual({
      projectId: "project-1",
      status: "recovery_started",
      currentAction: "Picking up your book generation.",
      resumedActions: 1,
      skippedActions: 0,
      stoppingActions: 0
    });
    expect(mockPrisma.project.update).toHaveBeenCalledWith({
      where: { id: "project-1" },
      data: { status: "GENERATING" }
    });
    expect(vi.mocked(requeueGenerationJob)).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "job-failed-page",
        projectId: "project-1",
        type: "GENERATE_PAGE",
        payload: { pageId: "page-1", planId: "plan-1" }
      })
    );
    expect(JSON.stringify(body)).not.toMatch(/jobs|queue|provider|model|temperature/);
    await app.close();
  });

  it("rejects mobile plan approval when credits are insufficient", async () => {
    mockAccessTokens({ "token-a": "user-a" });
    mockPrisma.planVersion.findFirst.mockResolvedValueOnce({
      id: "plan-1",
      projectId: "project-1",
      status: "DRAFT",
      project: projectRecord({ id: "project-1" })
    });
    vi.mocked(reserveCredits).mockRejectedValueOnce(
      new InsufficientCreditsError({ requiredCredits: 980, availableCredits: 100, reservedCredits: 0 })
    );
    const app = await buildMobileApp();

    const response = await app.inject({
      method: "POST",
      url: "/api/mobile/plans/plan-1/approve",
      headers: bearer("token-a")
    });

    expect(response.statusCode).toBe(402);
    expect(response.json()).toEqual({
      error: {
        code: "INSUFFICIENT_CREDITS",
        message: "You need more credits for this action.",
        requiredCredits: 980,
        availableCredits: 100,
        reservedCredits: 0
      }
    });
    expect(enqueueGenerationJob).not.toHaveBeenCalled();
    await app.close();
  });

  it("answers plan-stage project chat questions without queuing a revision", async () => {
    mockAccessTokens({ "token-a": "user-a" });
    mockPrisma.project.findFirst.mockResolvedValue(
      projectRecord({
        id: "project-1",
        status: "PLAN_READY",
        currentPlanId: "plan-1",
        currentPlan: approvedPlanRecord({ status: "DRAFT", approvedAt: null }),
        pages: []
      })
    );
    const app = await buildMobileApp();

    const response = await app.inject({
      method: "POST",
      url: "/api/mobile/projects/project-1/chat/messages",
      headers: bearer("token-a"),
      payload: { message: "What is this plan about?" }
    });
    const body = response.json();

    expect(response.statusCode).toBe(200);
    expect(body.operation).toBeNull();
    expect(body.messages).toEqual([
      expect.objectContaining({ role: "user", content: "What is this plan about?" }),
      expect.objectContaining({ role: "assistant", content: expect.stringContaining("Rabbit and Turtle") })
    ]);
    expect(body.reply.content).not.toMatch(/book text edits are available after/i);
    expect(vi.mocked(enqueueGenerationJob)).not.toHaveBeenCalled();
    await app.close();
  });

  it("returns the newest chat window and paginates earlier active messages chronologically", async () => {
    mockAccessTokens({ "token-a": "user-a" });
    mockPrisma.project.findFirst.mockResolvedValue({ id: "project-1" });
    for (let index = 1; index <= 6; index += 1) {
      mockProjectChatMessages.push({
        id: `chat-${index}`,
        projectId: "project-1",
        parentId: index === 1 ? null : `chat-${index - 1}`,
        role: index % 2 === 0 ? "ASSISTANT" : "USER",
        content: `Message ${index}`,
        operationId: null,
        metadata: index === 6 ? { intent: { kind: "answer", reasoning: "private" }, provider: "hidden" } : {},
        isActiveChild: true,
        createdAt: new Date(`2026-06-15T12:0${index}:00.000Z`)
      });
    }
    const app = await buildMobileApp();

    const newest = await app.inject({
      method: "GET",
      url: "/api/mobile/projects/project-1/chat?limit=2",
      headers: bearer("token-a")
    });
    expect(newest.statusCode).toBe(200);
    expect(newest.json()).toMatchObject({
      hasMore: true,
      nextCursor: "chat-5",
      messages: [{ id: "chat-5" }, { id: "chat-6" }]
    });
    expect(JSON.stringify(newest.json().messages)).not.toMatch(/reasoning|provider|hidden|private/);

    const earlier = await app.inject({
      method: "GET",
      url: "/api/mobile/projects/project-1/chat?limit=2&beforeMessageId=chat-5",
      headers: bearer("token-a")
    });
    expect(earlier.json()).toMatchObject({
      hasMore: true,
      nextCursor: "chat-3",
      messages: [{ id: "chat-3" }, { id: "chat-4" }]
    });
    await app.close();
  });

  it("replays a project-chat request ID without duplicating the turn", async () => {
    mockAccessTokens({ "token-a": "user-a" });
    mockPrisma.project.findFirst.mockResolvedValue(
      projectRecord({ id: "project-1", status: "PLAN_READY", currentPlan: approvedPlanRecord() })
    );
    mockProjectChatMessages.push(
      {
        id: "chat-user-existing",
        projectId: "project-1",
        requestId: "request-123",
        parentId: null,
        role: "USER",
        content: "What changed?",
        operationId: null,
        metadata: {},
        isActiveChild: true,
        createdAt: new Date("2026-06-15T12:00:00.000Z")
      },
      {
        id: "chat-assistant-existing",
        projectId: "project-1",
        requestId: null,
        parentId: "chat-user-existing",
        role: "ASSISTANT",
        content: "The title changed.",
        operationId: null,
        metadata: {},
        isActiveChild: true,
        createdAt: new Date("2026-06-15T12:01:00.000Z")
      }
    );
    const app = await buildMobileApp();

    const response = await app.inject({
      method: "POST",
      url: "/api/mobile/projects/project-1/chat/messages",
      headers: bearer("token-a"),
      payload: { message: "What changed?", requestId: "request-123" }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().reply).toMatchObject({ id: "chat-assistant-existing", content: "The title changed." });
    expect(mockPrisma.projectChatMessage.create).not.toHaveBeenCalled();
    expect(mockProjectChatMessages).toHaveLength(2);
    await app.close();
  });

  it("branches project chat history when editing a previous user message", async () => {
    mockAccessTokens({ "token-a": "user-a" });
    mockProjectChatMessages.push(
      {
        id: "chat-old-user",
        projectId: "project-1",
        parentId: null,
        role: "USER",
        content: "What is this plan about?",
        operationId: null,
        metadata: {},
        isActiveChild: true,
        createdAt: new Date("2026-06-15T11:00:00.000Z")
      },
      {
        id: "chat-old-assistant",
        projectId: "project-1",
        parentId: "chat-old-user",
        role: "ASSISTANT",
        content: "This plan is about a rabbit race.",
        operationId: null,
        metadata: {},
        isActiveChild: true,
        createdAt: new Date("2026-06-15T11:01:00.000Z")
      },
      {
        id: "chat-old-follow-up",
        projectId: "project-1",
        parentId: "chat-old-assistant",
        role: "USER",
        content: "Make it warmer.",
        operationId: null,
        metadata: {},
        isActiveChild: true,
        createdAt: new Date("2026-06-15T11:02:00.000Z")
      },
      {
        id: "chat-old-follow-up-reply",
        projectId: "project-1",
        parentId: "chat-old-follow-up",
        role: "ASSISTANT",
        content: "I’ll revise the plan now.",
        operationId: null,
        metadata: {},
        isActiveChild: true,
        createdAt: new Date("2026-06-15T11:03:00.000Z")
      }
    );
    mockPrisma.project.findFirst.mockResolvedValue(
      projectRecord({
        id: "project-1",
        status: "PLAN_READY",
        currentPlanId: "plan-1",
        currentPlan: approvedPlanRecord({ status: "DRAFT", approvedAt: null }),
        pages: []
      })
    );
    const app = await buildMobileApp();

    const response = await app.inject({
      method: "POST",
      url: "/api/mobile/projects/project-1/chat/messages",
      headers: bearer("token-a"),
      payload: { editMessageId: "chat-old-user", message: "What is this plan really about?" }
    });
    const body = response.json();

    expect(response.statusCode).toBe(200);
    expect(body.operation).toBeNull();
    expect(body.messages).toHaveLength(2);
    expect(body.messages[0]).toMatchObject({
      id: "chat-5",
      parentId: null,
      role: "user",
      content: "What is this plan really about?",
      branch: { index: 2, total: 2, canGoPrevious: true, canGoNext: false }
    });
    expect(body.messages[1]).toMatchObject({
      parentId: "chat-5",
      role: "assistant"
    });
    expect(body.messages.map((message: any) => message.id)).not.toContain("chat-old-follow-up");
    expect(mockProjectChatMessages.find((message) => message.id === "chat-old-user")?.isActiveChild).toBe(false);
    await app.close();
  });

  it("switches between project chat sibling branches", async () => {
    mockAccessTokens({ "token-a": "user-a" });
    mockProjectChatMessages.push(
      {
        id: "chat-old-user",
        projectId: "project-1",
        parentId: null,
        role: "USER",
        content: "What is this plan about?",
        operationId: null,
        metadata: {},
        isActiveChild: false,
        createdAt: new Date("2026-06-15T11:00:00.000Z")
      },
      {
        id: "chat-old-assistant",
        projectId: "project-1",
        parentId: "chat-old-user",
        role: "ASSISTANT",
        content: "This plan is about a rabbit race.",
        operationId: null,
        metadata: {},
        isActiveChild: true,
        createdAt: new Date("2026-06-15T11:01:00.000Z")
      },
      {
        id: "chat-new-user",
        projectId: "project-1",
        parentId: null,
        role: "USER",
        content: "What is this plan really about?",
        operationId: null,
        metadata: { editedFromMessageId: "chat-old-user" },
        isActiveChild: true,
        createdAt: new Date("2026-06-15T11:02:00.000Z")
      },
      {
        id: "chat-new-assistant",
        projectId: "project-1",
        parentId: "chat-new-user",
        role: "ASSISTANT",
        content: "This plan is about a warmer rabbit race.",
        operationId: null,
        metadata: {},
        isActiveChild: true,
        createdAt: new Date("2026-06-15T11:03:00.000Z")
      }
    );
    mockPrisma.project.findFirst.mockResolvedValue(projectRecord({ id: "project-1" }));
    const app = await buildMobileApp();

    const response = await app.inject({
      method: "POST",
      url: "/api/mobile/projects/project-1/chat/branches",
      headers: bearer("token-a"),
      payload: { messageId: "chat-new-user", direction: "previous" }
    });
    const body = response.json();

    expect(response.statusCode).toBe(200);
    expect(body.messages.map((message: any) => message.id)).toEqual(["chat-old-user", "chat-old-assistant"]);
    expect(body.messages[0].branch).toMatchObject({ index: 1, total: 2, canGoPrevious: false, canGoNext: true });
    expect(mockProjectChatMessages.find((message) => message.id === "chat-old-user")?.isActiveChild).toBe(true);
    expect(mockProjectChatMessages.find((message) => message.id === "chat-new-user")?.isActiveChild).toBe(false);
    await app.close();
  });

  it("queues soft plan-stage project chat change requests as plan revisions", async () => {
    mockAccessTokens({ "token-a": "user-a" });
    mockPrisma.project.findFirst.mockResolvedValue(
      projectRecord({
        id: "project-1",
        status: "PLAN_READY",
        currentPlanId: "plan-1",
        currentPlan: approvedPlanRecord({ status: "DRAFT", approvedAt: null }),
        pages: []
      })
    );
    vi.mocked(enqueueGenerationJob).mockResolvedValueOnce(jobRecord({ id: "job-soft-plan-revise", type: "REVISE_PLAN" }));
    const app = await buildMobileApp();

    const response = await app.inject({
      method: "POST",
      url: "/api/mobile/projects/project-1/chat/messages",
      headers: bearer("token-a"),
      payload: { message: "I want the audience to be parents." }
    });
    const body = response.json();

    expect(response.statusCode).toBe(200);
    expect(body.operation).toMatchObject({ kind: "plan_revision" });
    expect(vi.mocked(enqueueGenerationJob)).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: "project-1",
        type: "REVISE_PLAN",
        payload: expect.objectContaining({
          planId: "plan-1",
          message: "I want the audience to be parents."
        })
      })
    );
    await app.close();
  });

  it("queues negative media plan preferences as plan revisions", async () => {
    mockAccessTokens({ "token-a": "user-a" });
    mockPrisma.project.findFirst.mockResolvedValue(
      projectRecord({
        id: "project-1",
        status: "PLAN_READY",
        currentPlanId: "plan-1",
        currentPlan: approvedPlanRecord({ status: "DRAFT", approvedAt: null }),
        pages: []
      })
    );
    vi.mocked(enqueueGenerationJob).mockResolvedValueOnce(jobRecord({ id: "job-media-plan-revise", type: "REVISE_PLAN" }));
    const app = await buildMobileApp();

    const response = await app.inject({
      method: "POST",
      url: "/api/mobile/projects/project-1/chat/messages",
      headers: bearer("token-a"),
      payload: { message: "I don't want images or covers" }
    });
    const body = response.json();

    expect(response.statusCode).toBe(200);
    expect(body.operation).toMatchObject({ kind: "plan_revision" });
    expect(vi.mocked(enqueueGenerationJob)).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: "project-1",
        type: "REVISE_PLAN",
        payload: expect.objectContaining({
          planId: "plan-1",
          message: "I don't want images or covers"
        })
      })
    );
    await app.close();
  });

  it("treats saved current plans as plan-chat even when project status is not PLAN_READY", async () => {
    mockAccessTokens({ "token-a": "user-a" });
    mockPrisma.project.findFirst.mockResolvedValue(
      projectRecord({
        id: "project-1",
        status: "PLANNING",
        currentPlanId: "plan-1",
        currentPlan: approvedPlanRecord({ status: "DRAFT", approvedAt: null }),
        pages: []
      })
    );
    const app = await buildMobileApp();

    const response = await app.inject({
      method: "POST",
      url: "/api/mobile/projects/project-1/chat/messages",
      headers: bearer("token-a"),
      payload: { message: "What is this plan about?" }
    });
    const body = response.json();

    expect(response.statusCode).toBe(200);
    expect(body.operation).toBeNull();
    expect(body.reply.content).not.toMatch(/book text edits are available after/i);
    expect(body.reply.content).toContain("Rabbit and Turtle");
    expect(vi.mocked(enqueueGenerationJob)).not.toHaveBeenCalled();
    await app.close();
  });

  it("keeps non-plan in-progress project chat edits on the generated-book fallback path", async () => {
    mockAccessTokens({ "token-a": "user-a" });
    mockPrisma.project.findFirst.mockResolvedValue(
      projectRecord({
        id: "project-1",
        status: "GENERATING",
        currentPlanId: null,
        currentPlan: null,
        pages: []
      })
    );
    const app = await buildMobileApp();

    const response = await app.inject({
      method: "POST",
      url: "/api/mobile/projects/project-1/chat/messages",
      headers: bearer("token-a"),
      payload: { message: "Make the book warmer." }
    });
    const body = response.json();

    expect(response.statusCode).toBe(200);
    expect(body.operation).toBeNull();
    expect(body.reply.content).toContain("after the current book work is finished");
    expect(vi.mocked(enqueueGenerationJob)).not.toHaveBeenCalled();
    await app.close();
  });

  it("proposes a completed-book whole-book style edit and queues it after confirmation", async () => {
    mockAccessTokens({ "token-a": "user-a" });
    const pages = generatedPages();
    mockPrisma.project.findFirst.mockResolvedValue(
      projectRecord({
        id: "project-1",
        status: "COMPLETE",
        currentPlanId: "plan-1",
        currentPlan: approvedPlanRecord(),
        pages
      })
    );
    vi.mocked(enqueueGenerationJob).mockResolvedValueOnce(jobRecord({ id: "job-edit", type: "APPLY_BOOK_EDIT" }));
    const app = await buildMobileApp();

    const proposal = await app.inject({
      method: "POST",
      url: "/api/mobile/projects/project-1/chat/messages",
      headers: bearer("token-a"),
      payload: { message: "Make the whole book warmer and simpler." }
    });
    const proposalBody = proposal.json();

    expect(proposal.statusCode).toBe(200);
    expect(proposalBody.operation).toBeNull();
    expect(proposalBody.reply.content).toContain("whole book");
    expect(proposalBody.reply.content).toMatch(/Tap Apply|apply it/i);
    expect(proposalBody.reply.metadata).toMatchObject({
      charged: false,
      pendingEdit: { clarification: "confirm" },
      editProposal: {
        kind: "page_rewrite",
        affectedPageIndexes: [1, 2]
      }
    });
    expect(typeof proposalBody.reply.metadata.editProposal.id).toBe("string");
    expect(vi.mocked(enqueueGenerationJob)).not.toHaveBeenCalled();

    const confirm = await app.inject({
      method: "POST",
      url: "/api/mobile/projects/project-1/chat/proposals/apply",
      headers: bearer("token-a"),
      payload: { proposalId: proposalBody.reply.metadata.editProposal.id }
    });
    const body = confirm.json();

    expect(confirm.statusCode).toBe(200);
    expect(body.operation).toMatchObject({
      kind: "page_rewrite",
      affectedPageIndexes: [1, 2]
    });
    expect(vi.mocked(enqueueGenerationJob)).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: "project-1",
        type: "APPLY_BOOK_EDIT",
        payload: expect.objectContaining({
          affectedPageIndexes: [1, 2],
          intentKind: "page_rewrite"
        })
      })
    );
    await app.close();
  });

  it("cancels a priced edit proposal without charging", async () => {
    mockAccessTokens({ "token-a": "user-a" });
    mockPrisma.project.findFirst.mockResolvedValue(
      projectRecord({
        id: "project-1",
        status: "COMPLETE",
        currentPlanId: "plan-1",
        currentPlan: approvedPlanRecord(),
        pages: generatedPages()
      })
    );
    const app = await buildMobileApp();

    const proposal = await app.inject({
      method: "POST",
      url: "/api/mobile/projects/project-1/chat/messages",
      headers: bearer("token-a"),
      payload: { message: "Make the whole book warmer and simpler." }
    });
    expect(proposal.statusCode).toBe(200);
    expect(proposal.json().reply.metadata.editProposal.kind).toBe("page_rewrite");
    const proposalId = proposal.json().reply.metadata.editProposal.id as string;

    const cancel = await app.inject({
      method: "POST",
      url: "/api/mobile/projects/project-1/chat/proposals/cancel",
      headers: bearer("token-a"),
      payload: { proposalId }
    });
    const body = cancel.json();

    expect(cancel.statusCode).toBe(200);
    expect(body.operation).toBeNull();
    expect(body.reply.content).toContain("dropped that request");
    expect(body.reply.metadata).toMatchObject({ pendingEditCancelled: true, charged: false });
    expect(vi.mocked(enqueueGenerationJob)).not.toHaveBeenCalled();
    expect(vi.mocked(reserveCredits)).not.toHaveBeenCalled();
    await app.close();
  });

  it("finds quoted edit targets with a database text search instead of loaded page bodies", async () => {
    mockAccessTokens({ "token-a": "user-a" });
    const pages = generatedPages();
    mockPrisma.project.findFirst.mockResolvedValue(
      projectRecord({
        id: "project-1",
        status: "COMPLETE",
        currentPlanId: "plan-1",
        currentPlan: approvedPlanRecord(),
        pages
      })
    );
    // The quoted phrase lives only in page 2's markdown, which chat no longer
    // loads up front — the match must come from the contains query.
    mockPages = pages.map((page) => ({ ...page, projectId: "project-1", revision: 1 }));
    const app = await buildMobileApp();

    const response = await app.inject({
      method: "POST",
      url: "/api/mobile/projects/project-1/chat/messages",
      headers: bearer("token-a"),
      payload: { message: 'Replace "learns to be kind" with "learns to be patient".' }
    });
    const body = response.json();

    expect(response.statusCode).toBe(200);
    expect(body.operation).toBeNull();
    expect(body.reply.metadata).toMatchObject({
      editProposal: {
        kind: "local_patch",
        affectedPageIndexes: [2]
      }
    });
    expect(mockPrisma.page.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          projectId: "project-1",
          OR: expect.arrayContaining([{ markdown: { contains: "learns to be kind", mode: "insensitive" } }])
        })
      })
    );
    await app.close();
  });

  it("proposes a completed-book structural character change as a book replan", async () => {
    mockAccessTokens({ "token-a": "user-a" });
    mockPrisma.project.findFirst.mockResolvedValue(
      projectRecord({
        id: "project-1",
        status: "COMPLETE",
        currentPlanId: "plan-1",
        currentPlan: approvedPlanRecord(),
        pages: generatedPages()
      })
    );
    mockPrisma.mobileCreationOutput.findFirst.mockResolvedValueOnce({
      id: "output-source",
      draftId: "draft-1",
      projectId: "project-1",
      title: "Owned Book",
      sequence: 1,
      createdAt: new Date("2026-06-15T12:00:00.000Z"),
      updatedAt: new Date("2026-06-15T12:00:00.000Z"),
      draft: creationDraftRecord({
        id: "draft-1",
        createdProjectId: "project-1",
        outputs: [
          {
            id: "output-source",
            draftId: "draft-1",
            projectId: "project-1",
            title: "Owned Book",
            sequence: 1,
            createdAt: new Date("2026-06-15T12:00:00.000Z"),
            updatedAt: new Date("2026-06-15T12:00:00.000Z"),
            project: { title: "Owned Book", updatedAt: new Date("2026-06-15T12:00:00.000Z") }
          }
        ]
      })
    });
    vi.mocked(enqueueGenerationJob).mockResolvedValueOnce(
      jobRecord({ id: "job-replan", projectId: "project-copy", type: "REPLAN_BOOK" })
    );
    const app = await buildMobileApp();

    const proposal = await app.inject({
      method: "POST",
      url: "/api/mobile/projects/project-1/chat/messages",
      headers: bearer("token-a"),
      payload: { message: "Change the character of rabbit with a fly." }
    });
    const proposalBody = proposal.json();

    expect(proposal.statusCode).toBe(200);
    expect(proposalBody.operation).toBeNull();
    expect(proposalBody.reply.metadata).toMatchObject({
      editProposal: { kind: "book_replan" },
      pendingEdit: { clarification: "confirm" }
    });
    expect(proposalBody.reply.content).toContain("new copy");
    expect(vi.mocked(enqueueGenerationJob)).not.toHaveBeenCalled();

    const confirm = await app.inject({
      method: "POST",
      url: "/api/mobile/projects/project-1/chat/messages",
      headers: bearer("token-a"),
      payload: { message: "apply it" }
    });
    const body = confirm.json();

    expect(confirm.statusCode).toBe(200);
    expect(body.operation).toMatchObject({
      kind: "book_replan",
      affectedPageIndexes: []
    });
    expect(vi.mocked(enqueueGenerationJob)).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: "project-copy",
        type: "REPLAN_BOOK",
        payload: expect.objectContaining({
          sourceProjectId: "project-1",
          sourcePlanId: "plan-1",
          affectedPageIndexes: [],
          intentKind: "book_replan"
        })
      })
    );
    expect(mockPrisma.project.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          userId: "user-a",
          title: "Owned Book (Revised)",
          status: "EDITING",
          mediaSettings: expect.objectContaining({
            mobile: expect.objectContaining({
              revisionOfProjectId: "project-1",
              revisionOperationId: "operation-1",
              revisionSource: "project_chat_book_replan"
            })
          })
        })
      })
    );
    expect(mockPrisma.mobileCreationOutput.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          draftId: "draft-1",
          projectId: "project-copy",
          sequence: 2
        })
      })
    );
    expect(mockPrisma.mobileCreationDraft.update).toHaveBeenCalledWith({
      where: { id: "draft-1" },
      data: { createdProjectId: "project-copy", status: "ACTIVE" }
    });
    expect(mockPrisma.project.update).not.toHaveBeenCalledWith({
      where: { id: "project-1" },
      data: { status: "EDITING" }
    });
    expect(body.reply.content).toContain("new copy");
    expect(body.reply.content).toContain("stays unchanged");
    await app.close();
  });

  it("proposes a completed-book English language version as a new copy", async () => {
    mockAccessTokens({ "token-a": "user-a" });
    mockPrisma.project.findFirst.mockResolvedValue(
      projectRecord({
        id: "project-1",
        title: "Encontros em Lisboa",
        language: "pt",
        status: "COMPLETE",
        currentPlanId: "plan-1",
        currentPlan: approvedPlanRecord(),
        pages: generatedPages()
      })
    );
    vi.mocked(enqueueGenerationJob).mockResolvedValueOnce(
      jobRecord({ id: "job-replan", projectId: "project-copy", type: "REPLAN_BOOK" })
    );
    const app = await buildMobileApp();

    const proposal = await app.inject({
      method: "POST",
      url: "/api/mobile/projects/project-1/chat/messages",
      headers: bearer("token-a"),
      payload: { message: "Now generate the English version" }
    });
    const proposalBody = proposal.json();

    expect(proposal.statusCode).toBe(200);
    expect(proposalBody.operation).toBeNull();
    expect(proposalBody.reply.metadata).toMatchObject({
      editProposal: {
        kind: "book_replan",
        targetLanguage: "en"
      },
      pendingEdit: { clarification: "confirm" }
    });
    expect(proposalBody.reply.content).toContain("English");
    expect(vi.mocked(enqueueGenerationJob)).not.toHaveBeenCalled();

    const confirm = await app.inject({
      method: "POST",
      url: "/api/mobile/projects/project-1/chat/messages",
      headers: bearer("token-a"),
      payload: { message: "yes" }
    });
    const body = confirm.json();

    expect(confirm.statusCode).toBe(200);
    expect(body.operation).toMatchObject({
      kind: "book_replan",
      affectedPageIndexes: []
    });
    expect(mockPrisma.bookEditOperation.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          classifier: expect.objectContaining({
            kind: "book_replan",
            targetLanguage: "en"
          })
        })
      })
    );
    expect(mockPrisma.project.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          title: "Encontros em Lisboa (Revised)",
          language: "en",
          status: "EDITING",
          mediaSettings: expect.objectContaining({
            mobile: expect.objectContaining({
              revisionOfProjectId: "project-1",
              revisionTargetLanguage: "en"
            })
          })
        })
      })
    );
    expect(vi.mocked(enqueueGenerationJob)).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: "project-copy",
        type: "REPLAN_BOOK",
        payload: expect.objectContaining({
          sourceProjectId: "project-1",
          sourcePlanId: "plan-1",
          targetLanguage: "en",
          intentKind: "book_replan"
        })
      })
    );
    expect(mockPrisma.project.update).not.toHaveBeenCalledWith({
      where: { id: "project-1" },
      data: { status: "EDITING" }
    });
    expect(body.reply.content).toContain("English copy");
    await app.close();
  });

  it("revises an approved plan from project chat when no generation job is active", async () => {
    mockAccessTokens({ "token-a": "user-a" });
    mockPrisma.project.findFirst.mockResolvedValue(
      projectRecord({
        id: "project-1",
        status: "GENERATING",
        currentPlanId: "plan-1",
        currentPlan: approvedPlanRecord(),
        pages: []
      })
    );
    vi.mocked(enqueueGenerationJob).mockResolvedValueOnce(jobRecord({ id: "job-chat-revise", type: "REVISE_PLAN" }));
    const app = await buildMobileApp();

    const response = await app.inject({
      method: "POST",
      url: "/api/mobile/projects/project-1/chat/messages",
      headers: bearer("token-a"),
      payload: { message: "Change rabbit into a fly before writing starts." }
    });
    const body = response.json();

    expect(response.statusCode).toBe(200);
    expect(body.operation).toMatchObject({ kind: "plan_revision" });
    expect(vi.mocked(enqueueGenerationJob)).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: "project-1",
        type: "REVISE_PLAN",
        payload: expect.objectContaining({
          planId: "plan-1",
          message: "Change rabbit into a fly before writing starts."
        })
      })
    );
    expect(mockPrisma.project.update).toHaveBeenCalledWith({
      where: { id: "project-1" },
      data: { status: "PLANNING" }
    });
    expect(body.reply.content).toContain("reopen it for review");
    await app.close();
  });

  it("retries one failed plan revision idempotently without charging again", async () => {
    mockAccessTokens({ "token-a": "user-a" });
    const failed = failedPlanRevisionOperationRecord({
      automaticRetryCount: 0,
      automaticRetryLimit: 2,
      nextRetryAt: null,
      retryRequestId: null,
      ledgerEntry: { id: "ledger-PLAN_REVISION", status: "SETTLED", entryType: "SPEND" },
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
      }
    });
    mockBookEditOperations.push(failed);
    mockPrisma.project.findFirst.mockResolvedValue({ id: "project-1", currentPlanId: "plan-1" });
    vi.mocked(enqueueGenerationJob).mockResolvedValueOnce(jobRecord({ id: "job-retry-1", type: "REVISE_PLAN" }));
    const app = await buildMobileApp();

    const response = await app.inject({
      method: "POST",
      url: "/api/mobile/projects/project-1/operations/operation-failed-revision/retry",
      headers: bearer("token-a"),
      payload: { requestId: "retry-request-0001" }
    });

    expect(response.statusCode).toBe(202);
    expect(response.json().operation).toMatchObject({ id: "operation-failed-revision", status: "queued" });
    expect(enqueueGenerationJob).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "REVISE_PLAN",
        dedupeKey: "plan-revision-retry:operation-failed-revision:1",
        dispatch: false,
        payload: expect.objectContaining({
          billingLedgerEntryId: "ledger-PLAN_REVISION",
          retryOfGenerationJobId: "job-failed-revision",
          retryNumber: 1
        })
      })
    );
    expect(dispatchGenerationJob).toHaveBeenCalledWith("job-retry-1");
    expect(reserveCredits).not.toHaveBeenCalled();
    await app.close();
  });

  it("queues a second recovery when the first recovery fails and the command ID changes", async () => {
    mockAccessTokens({ "token-a": "user-a" });
    const failed = failedPlanRevisionOperationRecord();
    mockBookEditOperations.push(failed);
    mockPrisma.project.findFirst.mockResolvedValue({ id: "project-1", currentPlanId: "plan-1" });
    vi.mocked(enqueueGenerationJob)
      .mockResolvedValueOnce(jobRecord({ id: "job-retry-1", type: "REVISE_PLAN" }))
      .mockResolvedValueOnce(jobRecord({ id: "job-retry-2", type: "REVISE_PLAN" }));
    const app = await buildMobileApp();

    const first = await app.inject({
      method: "POST",
      url: "/api/mobile/projects/project-1/operations/operation-failed-revision/retry",
      headers: bearer("token-a"),
      payload: { requestId: "retry-command-1" }
    });
    expect(first.statusCode).toBe(202);

    Object.assign(failed, {
      status: "FAILED",
      generationJobId: "job-retry-1",
      generationJob: {
        id: "job-retry-1",
        status: "FAILED",
        payload: {
          planId: "plan-1",
          message: "Make it brighter.",
          editOperationId: failed.id,
          billingLedgerEntryId: failed.ledgerEntryId
        },
        startedAt: new Date("2026-06-15T13:02:00.000Z"),
        updatedAt: new Date("2026-06-15T13:03:00.000Z")
      },
      error: "The first recovery also failed."
    });

    const second = await app.inject({
      method: "POST",
      url: "/api/mobile/projects/project-1/operations/operation-failed-revision/retry",
      headers: bearer("token-a"),
      payload: { requestId: "retry-command-2" }
    });

    expect(second.statusCode).toBe(202);
    expect(second.json().operation).toMatchObject({ status: "queued" });
    expect(enqueueGenerationJob).toHaveBeenLastCalledWith(
      expect.objectContaining({
        dedupeKey: "plan-revision-retry:operation-failed-revision:2",
        payload: expect.objectContaining({ retryNumber: 2, retryOfGenerationJobId: "job-retry-1" })
      })
    );
    expect(dispatchGenerationJob).toHaveBeenLastCalledWith("job-retry-2");
    await app.close();
  });

  it("returns a retry conflict while another edit operation is open", async () => {
    mockAccessTokens({ "token-a": "user-a" });
    const failed = failedPlanRevisionOperationRecord();
    const competing = failedPlanRevisionOperationRecord({
      id: "operation-active-edit",
      generationJobId: "job-active-edit",
      status: "QUEUED",
      kind: "LOCAL_PATCH",
      requestId: null
    });
    mockBookEditOperations.push(failed, competing);
    mockPrisma.project.findFirst.mockResolvedValue({ id: "project-1", currentPlanId: "plan-1" });
    const app = await buildMobileApp();

    const response = await app.inject({
      method: "POST",
      url: "/api/mobile/projects/project-1/operations/operation-failed-revision/retry",
      headers: bearer("token-a"),
      payload: { requestId: "retry-while-busy" }
    });

    expect(response.statusCode).toBe(409);
    expect(response.json().error).toMatchObject({ code: "RETRY_NOT_AVAILABLE" });
    expect(enqueueGenerationJob).not.toHaveBeenCalled();
    await app.close();
  });

  it("converts a partial-unique retry race into a conflict instead of a server error", async () => {
    mockAccessTokens({ "token-a": "user-a" });
    const failed = failedPlanRevisionOperationRecord();
    const competing = failedPlanRevisionOperationRecord({
      id: "operation-race-winner",
      generationJobId: "job-race-winner",
      status: "ACTIVE",
      kind: "LOCAL_PATCH",
      requestId: null
    });
    mockBookEditOperations.push(failed, competing);
    let openOperationChecks = 0;
    mockPrisma.bookEditOperation.findFirst.mockImplementation(async ({ where }: { where: Record<string, any> }) => {
      if (typeof where.id === "string") return where.id === failed.id ? failed : null;
      if (where.status?.in) {
        openOperationChecks += 1;
        return openOperationChecks === 1 ? null : competing;
      }
      return null;
    });
    mockPrisma.project.findFirst.mockResolvedValue({ id: "project-1", currentPlanId: "plan-1" });
    mockPrisma.$transaction.mockRejectedValueOnce(
      new MockPrismaKnownRequestError("open operation conflict", { code: "P2002" })
    );
    const app = await buildMobileApp();

    const response = await app.inject({
      method: "POST",
      url: "/api/mobile/projects/project-1/operations/operation-failed-revision/retry",
      headers: bearer("token-a"),
      payload: { requestId: "retry-race" }
    });

    expect(response.statusCode).toBe(409);
    expect(response.json().error).toMatchObject({ code: "RETRY_NOT_AVAILABLE" });
    expect(openOperationChecks).toBe(2);
    await app.close();
  });

  it("continues automatic retry reconciliation after one operation throws", async () => {
    const first = failedPlanRevisionOperationRecord({ id: "operation-retry-error", projectId: "project-error" });
    const second = failedPlanRevisionOperationRecord({ id: "operation-retry-ok", projectId: "project-ok" });
    mockBookEditOperations.push(first, second);
    mockPrisma.bookEditOperation.findMany.mockResolvedValueOnce([
      { id: first.id, automaticRetryCount: 0, project: { userId: "user-a" } },
      { id: second.id, automaticRetryCount: 0, project: { userId: "user-a" } }
    ]);
    mockPrisma.project.findFirst.mockResolvedValue({ currentPlanId: "plan-1" });
    mockPrisma.$transaction.mockRejectedValueOnce(new Error("temporary database failure"));
    vi.mocked(enqueueGenerationJob).mockResolvedValueOnce(
      jobRecord({ id: "job-reconciled", projectId: "project-ok", type: "REVISE_PLAN" })
    );
    const log = { info: vi.fn(), warn: vi.fn() };
    const { reconcileRetryablePlanRevisionOperations } = await import("./mobileProjects.js");

    const queued = await reconcileRetryablePlanRevisionOperations({ log });

    expect(queued).toBe(1);
    expect(dispatchGenerationJob).toHaveBeenCalledWith("job-reconciled");
    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        warning: "retry_reconciliation_failed",
        operationId: "operation-retry-error"
      }),
      "Plan revision retry reconciliation skipped one operation"
    );
  });

  it("keeps the legacy operation retry alias available", async () => {
    mockAccessTokens({ "token-a": "user-a" });
    mockBookEditOperations.push(failedPlanRevisionOperationRecord());
    mockPrisma.project.findFirst.mockResolvedValue({ id: "project-1", currentPlanId: "plan-1" });
    vi.mocked(enqueueGenerationJob).mockResolvedValueOnce(jobRecord({ id: "job-retry-alias", type: "REVISE_PLAN" }));
    const app = await buildMobileApp();

    const response = await app.inject({
      method: "POST",
      url: "/api/mobile/book-edit-operations/operation-failed-revision/retry",
      headers: bearer("token-a"),
      payload: { requestId: "retry-request-alias" }
    });

    expect(response.statusCode).toBe(202);
    expect(response.json().operation.id).toBe("operation-failed-revision");
    await app.close();
  });

  it("retries an unbilled web plan revision without requiring a ledger", async () => {
    mockAccessTokens({ "token-a": "user-a" });
    mockBookEditOperations.push(
      failedPlanRevisionOperationRecord({
        ledgerEntryId: null,
        ledgerEntry: null,
        creditsCharged: 0,
        classifier: { kind: "plan_revision", source: "web" },
        generationJob: {
          id: "job-web-revision",
          status: "FAILED",
          payload: { planId: "plan-1", message: "Clarify the ending.", editOperationId: "operation-failed-revision" },
          startedAt: new Date("2026-06-15T13:00:00.000Z"),
          updatedAt: new Date("2026-06-15T13:01:00.000Z")
        }
      })
    );
    mockPrisma.project.findFirst.mockResolvedValue({ id: "project-1", currentPlanId: "plan-1" });
    vi.mocked(enqueueGenerationJob).mockResolvedValueOnce(jobRecord({ id: "job-web-retry", type: "REVISE_PLAN" }));
    const app = await buildMobileApp();

    const response = await app.inject({
      method: "POST",
      url: "/api/mobile/projects/project-1/operations/operation-failed-revision/retry",
      headers: bearer("token-a"),
      payload: { requestId: "retry-web-request" }
    });

    expect(response.statusCode).toBe(202);
    expect(enqueueGenerationJob).toHaveBeenCalledWith(
      expect.objectContaining({
        dispatch: false,
        payload: expect.not.objectContaining({ billingLedgerEntryId: expect.any(String) })
      })
    );
    expect(reserveCredits).not.toHaveBeenCalled();
    await app.close();
  });

  it("restores a failed operation when durable retry job creation fails", async () => {
    mockAccessTokens({ "token-a": "user-a" });
    const failed = failedPlanRevisionOperationRecord({ retryRequestId: null, automaticRetryCount: 0 });
    mockBookEditOperations.push(failed);
    mockPrisma.project.findFirst.mockResolvedValue({ id: "project-1", currentPlanId: "plan-1" });
    vi.mocked(enqueueGenerationJob).mockRejectedValueOnce(new Error("database unavailable"));
    const app = await buildMobileApp();

    const response = await app.inject({
      method: "POST",
      url: "/api/mobile/projects/project-1/operations/operation-failed-revision/retry",
      headers: bearer("token-a"),
      payload: { requestId: "retry-rollback-id" }
    });

    expect(response.statusCode).toBe(500);
    expect(failed).toMatchObject({ status: "FAILED", automaticRetryCount: 0, retryRequestId: null });
    await app.close();
  });

  it("serializes failed plan revision operations with error details", async () => {
    mockAccessTokens({ "token-a": "user-a" });
    mockPrisma.project.findFirst.mockResolvedValueOnce(projectRecord({ id: "project-1" }));
    mockBookEditOperations.push(failedPlanRevisionOperationRecord());
    const app = await buildMobileApp();

    const response = await app.inject({
      method: "GET",
      url: "/api/mobile/projects/project-1/chat",
      headers: bearer("token-a")
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().operations).toEqual([
      expect.objectContaining({
        id: "operation-failed-revision",
        kind: "plan_revision",
        status: "failed",
        currentAction: "Plan revision failed.",
        error: "AI plan revision failed. No revised plan was created.",
        job: expect.objectContaining({
          id: "job-failed-revision",
          status: "failed"
        })
      })
    ]);
    await app.close();
  });

  it("serializes retry metadata needed by the mobile recovery UX", async () => {
    mockAccessTokens({ "token-a": "user-a" });
    mockPrisma.project.findFirst.mockResolvedValueOnce(projectRecord({ id: "project-1" }));
    mockBookEditOperations.push(
      failedPlanRevisionOperationRecord({
        requestId: "revision-stable-1",
        automaticRetryCount: 0,
        automaticRetryLimit: 2,
        nextRetryAt: new Date("2026-06-15T13:05:00.000Z")
      })
    );
    const app = await buildMobileApp();

    const response = await app.inject({
      method: "GET",
      url: "/api/mobile/projects/project-1/chat",
      headers: bearer("token-a")
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().operations[0]).toMatchObject({
      retryAvailable: true,
      nextRetryAt: "2026-06-15T13:05:00.000Z",
      retryState: "scheduled",
      retryMessage: "Retrying this plan revision automatically.",
      submittedText: "Make it brighter.",
      requestId: "revision-stable-1"
    });
    await app.close();
  });

  it("hides recovered failed plan revisions from project chat history", async () => {
    mockAccessTokens({ "token-a": "user-a" });
    mockPrisma.project.findFirst.mockResolvedValueOnce(projectRecord({ id: "project-1" }));
    mockBookEditOperations.push(failedPlanRevisionOperationRecord());
    const basePlan = approvedPlanRecord().planningPackage as Record<string, unknown>;
    mockPlanVersions.push(
      approvedPlanRecord({
        id: "plan-recovered",
        version: 2,
        status: "DRAFT",
        approvedAt: null,
        planningPackage: { ...basePlan, title: "Recovered revised plan" },
        createdAt: new Date("2026-06-15T13:05:00.000Z"),
        updatedAt: new Date("2026-06-15T13:05:00.000Z")
      })
    );
    const app = await buildMobileApp();

    const response = await app.inject({
      method: "GET",
      url: "/api/mobile/projects/project-1/chat",
      headers: bearer("token-a")
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().operations).toEqual([]);
    expect(response.json().plans).toEqual([
      expect.objectContaining({
        id: "plan-recovered",
        title: "Recovered revised plan"
      })
    ]);
    await app.close();
  });

  it("serializes plan snapshots in project chat history", async () => {
    mockAccessTokens({ "token-a": "user-a" });
    mockPrisma.project.findFirst.mockResolvedValueOnce(projectRecord({ id: "project-1" }));
    const basePlan = approvedPlanRecord().planningPackage as Record<string, unknown>;
    mockPlanVersions.push(
      approvedPlanRecord({
        id: "plan-original",
        version: 1,
        status: "SUPERSEDED",
        approvedAt: null,
        planningPackage: { ...basePlan, title: "Original plan" },
        createdAt: new Date("2026-06-15T10:00:00.000Z"),
        updatedAt: new Date("2026-06-15T10:30:00.000Z")
      }),
      approvedPlanRecord({
        id: "plan-revised",
        version: 2,
        status: "DRAFT",
        approvedAt: null,
        planningPackage: { ...basePlan, title: "Revised plan" },
        createdAt: new Date("2026-06-15T11:00:00.000Z"),
        updatedAt: new Date("2026-06-15T11:00:00.000Z")
      })
    );
    const app = await buildMobileApp();

    const response = await app.inject({
      method: "GET",
      url: "/api/mobile/projects/project-1/chat",
      headers: bearer("token-a")
    });
    const body = response.json();

    expect(response.statusCode).toBe(200);
    expect(body.plans).toEqual([
      expect.objectContaining({
        id: "plan-original",
        version: 1,
        status: "superseded",
        title: "Original plan"
      }),
      expect.objectContaining({
        id: "plan-revised",
        version: 2,
        status: "draft",
        title: "Revised plan"
      })
    ]);
    await app.close();
  });

  it("queues project chat edits as a pending request while generation is active", async () => {
    mockAccessTokens({ "token-a": "user-a" });
    mockPrisma.project.findFirst.mockResolvedValue(
      projectRecord({
        id: "project-1",
        status: "GENERATING",
        currentPlanId: "plan-1",
        currentPlan: approvedPlanRecord(),
        pages: []
      })
    );
    mockPrisma.generationJob.count.mockResolvedValueOnce(1);
    const app = await buildMobileApp();

    const response = await app.inject({
      method: "POST",
      url: "/api/mobile/projects/project-1/chat/messages",
      headers: bearer("token-a"),
      payload: { message: "Make the whole book warmer." }
    });
    const body = response.json();

    expect(response.statusCode).toBe(200);
    expect(body.operation).toBeNull();
    expect(body.reply.content).toContain("saved that request");
    expect(body.reply.metadata).toMatchObject({
      blockedByActiveJob: true,
      pendingEdit: { request: "Make the whole book warmer.", clarification: "busy" }
    });
    expect(vi.mocked(enqueueGenerationJob)).not.toHaveBeenCalled();
    await app.close();
  });

  it("returns the busy reply without charging when a concurrent edit wins the open-operation slot", async () => {
    mockAccessTokens({ "token-a": "user-a" });
    mockPrisma.project.findFirst.mockResolvedValue(
      projectRecord({
        id: "project-1",
        status: "COMPLETE",
        currentPlanId: "plan-1",
        currentPlan: approvedPlanRecord(),
        pages: generatedPages()
      })
    );
    const app = await buildMobileApp();

    const proposal = await app.inject({
      method: "POST",
      url: "/api/mobile/projects/project-1/chat/messages",
      headers: bearer("token-a"),
      payload: { message: "Make the whole book warmer and simpler." }
    });
    expect(proposal.statusCode).toBe(200);
    expect(proposal.json().operation).toBeNull();

    // The one-open-edit-per-project partial unique index (migration 000026)
    // rejects the second concurrent create even though hasOpenProjectWork saw
    // no open work when this confirmation started.
    mockPrisma.bookEditOperation.create.mockRejectedValueOnce(
      new MockPrismaKnownRequestError("Unique constraint failed", { code: "P2002" })
    );

    const response = await app.inject({
      method: "POST",
      url: "/api/mobile/projects/project-1/chat/messages",
      headers: bearer("token-a"),
      payload: { message: "apply it" }
    });
    const body = response.json();

    expect(response.statusCode).toBe(200);
    expect(body.operation).toBeNull();
    expect(body.reply.content).toContain("saved that request");
    expect(body.reply.metadata).toMatchObject({
      blockedByActiveJob: true,
      pendingEdit: { request: "Make the whole book warmer and simpler.", clarification: "busy" }
    });
    expect(vi.mocked(reserveCredits)).not.toHaveBeenCalled();
    expect(vi.mocked(enqueueGenerationJob)).not.toHaveBeenCalled();
    await app.close();
  });

  it("uses a whole-book follow-up to resolve the previous pending edit scope", async () => {
    mockAccessTokens({ "token-a": "user-a" });
    mockProjectChatMessages.push(
      {
        id: "chat-old-user",
        projectId: "project-1",
        role: "USER",
        content: "Replace rabbit with fly",
        operationId: null,
        metadata: {},
        createdAt: new Date("2026-06-15T11:00:00.000Z")
      },
      {
        id: "chat-old-assistant",
        projectId: "project-1",
        role: "ASSISTANT",
        content: "Should I change a specific page, matching phrase, or the whole book?",
        operationId: null,
        metadata: {
          pendingEdit: { request: "Replace rabbit with fly", clarification: "scope" }
        },
        createdAt: new Date("2026-06-15T11:01:00.000Z")
      }
    );
    mockPrisma.project.findFirst.mockResolvedValue(
      projectRecord({
        id: "project-1",
        status: "COMPLETE",
        currentPlanId: "plan-1",
        currentPlan: approvedPlanRecord(),
        pages: generatedPages()
      })
    );
    vi.mocked(enqueueGenerationJob).mockResolvedValueOnce(jobRecord({ id: "job-follow-up", type: "APPLY_BOOK_EDIT" }));
    const app = await buildMobileApp();

    const proposal = await app.inject({
      method: "POST",
      url: "/api/mobile/projects/project-1/chat/messages",
      headers: bearer("token-a"),
      payload: { message: "whole book" }
    });
    const proposalBody = proposal.json();

    expect(proposal.statusCode).toBe(200);
    expect(proposalBody.operation).toBeNull();
    expect(proposalBody.reply.metadata).toMatchObject({
      editProposal: {
        kind: "local_patch",
        affectedPageIndexes: [1, 2]
      },
      pendingEdit: { clarification: "confirm" }
    });
    expect(proposalBody.reply.content).not.toContain("I can help with questions");
    expect(vi.mocked(enqueueGenerationJob)).not.toHaveBeenCalled();

    const confirm = await app.inject({
      method: "POST",
      url: "/api/mobile/projects/project-1/chat/messages",
      headers: bearer("token-a"),
      payload: { message: "apply it" }
    });
    const body = confirm.json();

    expect(confirm.statusCode).toBe(200);
    expect(body.operation).toMatchObject({
      kind: "local_patch",
      affectedPageIndexes: [1, 2]
    });
    expect(vi.mocked(enqueueGenerationJob)).toHaveBeenCalledWith(
      expect.objectContaining({
          type: "APPLY_BOOK_EDIT",
          payload: expect.objectContaining({
          request: "Replace rabbit with fly throughout the whole book.",
          exactReplacement: { from: "rabbit", to: "fly" },
          affectedPageIndexes: [1, 2]
        })
      })
    );
    await app.close();
  });

  it("recovers a whole-book follow-up from legacy scope questions without pending metadata", async () => {
    mockAccessTokens({ "token-a": "user-a" });
    mockProjectChatMessages.push(
      {
        id: "chat-old-user",
        projectId: "project-1",
        role: "USER",
        content: "Replace rabbit with fly",
        operationId: null,
        metadata: {},
        createdAt: new Date("2026-06-15T11:00:00.000Z")
      },
      {
        id: "chat-old-assistant",
        projectId: "project-1",
        role: "ASSISTANT",
        content: "Which page or exact phrase should I change?",
        operationId: null,
        metadata: {
          intent: {
            kind: "clarify",
            assistantMessage: "Which page or exact phrase should I change?",
            affectedPageIndexes: []
          },
          charged: false
        },
        createdAt: new Date("2026-06-15T11:01:00.000Z")
      },
      {
        id: "chat-stranded-user",
        projectId: "project-1",
        role: "USER",
        content: "whole book",
        operationId: null,
        metadata: {},
        createdAt: new Date("2026-06-15T11:02:00.000Z")
      },
      {
        id: "chat-stranded-assistant",
        projectId: "project-1",
        role: "ASSISTANT",
        content: "I can help with questions about the book or make edits if you tell me what to change.",
        operationId: null,
        metadata: {
          intent: { kind: "answer", reasoning: "No edit intent was detected.", affectedPageIndexes: [] },
          charged: false
        },
        createdAt: new Date("2026-06-15T11:03:00.000Z")
      }
    );
    mockPrisma.project.findFirst.mockResolvedValue(
      projectRecord({
        id: "project-1",
        status: "COMPLETE",
        currentPlanId: "plan-1",
        currentPlan: approvedPlanRecord(),
        pages: generatedPages()
      })
    );
    vi.mocked(enqueueGenerationJob).mockResolvedValueOnce(jobRecord({ id: "job-legacy-follow-up", type: "APPLY_BOOK_EDIT" }));
    const app = await buildMobileApp();

    const proposal = await app.inject({
      method: "POST",
      url: "/api/mobile/projects/project-1/chat/messages",
      headers: bearer("token-a"),
      payload: { message: "I said whole book" }
    });
    const proposalBody = proposal.json();

    expect(proposal.statusCode).toBe(200);
    expect(proposalBody.operation).toBeNull();
    expect(proposalBody.reply.metadata).toMatchObject({
      editProposal: {
        kind: "local_patch",
        affectedPageIndexes: [1, 2]
      },
      pendingEdit: { clarification: "confirm" }
    });
    expect(proposalBody.reply.content).not.toContain("I can help with questions");
    expect(vi.mocked(enqueueGenerationJob)).not.toHaveBeenCalled();

    const confirm = await app.inject({
      method: "POST",
      url: "/api/mobile/projects/project-1/chat/messages",
      headers: bearer("token-a"),
      payload: { message: "apply it" }
    });
    const body = confirm.json();

    expect(confirm.statusCode).toBe(200);
    expect(body.operation).toMatchObject({
      kind: "local_patch",
      affectedPageIndexes: [1, 2]
    });
    expect(vi.mocked(enqueueGenerationJob)).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "APPLY_BOOK_EDIT",
        payload: expect.objectContaining({
          request: "Replace rabbit with fly throughout the whole book.",
          exactReplacement: { from: "rabbit", to: "fly" },
          affectedPageIndexes: [1, 2]
        })
      })
    );
    await app.close();
  });

  it("uses a stranded whole-book scope when the user confirms the old edit", async () => {
    mockAccessTokens({ "token-a": "user-a" });
    mockProjectChatMessages.push(
      {
        id: "chat-old-user",
        projectId: "project-1",
        role: "USER",
        content: "Replace rabbit with fly",
        operationId: null,
        metadata: {},
        createdAt: new Date("2026-06-15T11:00:00.000Z")
      },
      {
        id: "chat-old-assistant",
        projectId: "project-1",
        role: "ASSISTANT",
        content: "Which page or exact phrase should I change?",
        operationId: null,
        metadata: {
          intent: {
            kind: "clarify",
            assistantMessage: "Which page or exact phrase should I change?",
            affectedPageIndexes: []
          },
          charged: false
        },
        createdAt: new Date("2026-06-15T11:01:00.000Z")
      },
      {
        id: "chat-stranded-user",
        projectId: "project-1",
        role: "USER",
        content: "whole book",
        operationId: null,
        metadata: {},
        createdAt: new Date("2026-06-15T11:02:00.000Z")
      },
      {
        id: "chat-stranded-assistant",
        projectId: "project-1",
        role: "ASSISTANT",
        content: "I can help with questions about the book or make edits if you tell me what to change.",
        operationId: null,
        metadata: {
          intent: { kind: "answer", reasoning: "No edit intent was detected.", affectedPageIndexes: [] },
          charged: false
        },
        createdAt: new Date("2026-06-15T11:03:00.000Z")
      }
    );
    mockPrisma.project.findFirst.mockResolvedValue(
      projectRecord({
        id: "project-1",
        status: "COMPLETE",
        currentPlanId: "plan-1",
        currentPlan: approvedPlanRecord(),
        pages: generatedPages()
      })
    );
    vi.mocked(enqueueGenerationJob).mockResolvedValueOnce(jobRecord({ id: "job-legacy-ok", type: "APPLY_BOOK_EDIT" }));
    const app = await buildMobileApp();

    const proposal = await app.inject({
      method: "POST",
      url: "/api/mobile/projects/project-1/chat/messages",
      headers: bearer("token-a"),
      payload: { message: "ok" }
    });
    const proposalBody = proposal.json();

    expect(proposal.statusCode).toBe(200);
    expect(proposalBody.operation).toBeNull();
    expect(proposalBody.reply.metadata).toMatchObject({
      editProposal: {
        kind: "local_patch",
        affectedPageIndexes: [1, 2]
      },
      pendingEdit: { clarification: "confirm" }
    });
    expect(proposalBody.messages.at(-2).metadata.resolvedPendingEdit).toMatchObject({
      request: "Replace rabbit with fly",
      scope: "all_pages",
      scopeMessage: "ok"
    });

    const confirm = await app.inject({
      method: "POST",
      url: "/api/mobile/projects/project-1/chat/messages",
      headers: bearer("token-a"),
      payload: { message: "apply it" }
    });
    const body = confirm.json();

    expect(confirm.statusCode).toBe(200);
    expect(body.operation).toMatchObject({
      kind: "local_patch",
      affectedPageIndexes: [1, 2]
    });
    expect(vi.mocked(enqueueGenerationJob)).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "APPLY_BOOK_EDIT",
        payload: expect.objectContaining({
          request: "Replace rabbit with fly throughout the whole book.",
          exactReplacement: { from: "rabbit", to: "fly" },
          affectedPageIndexes: [1, 2]
        })
      })
    );
    await app.close();
  });

  it("recovers stranded edit context for frustrated follow-ups instead of generic help", async () => {
    mockAccessTokens({ "token-a": "user-a" });
    mockProjectChatMessages.push(
      {
        id: "chat-old-user",
        projectId: "project-1",
        role: "USER",
        content: "Replace rabbit with fly",
        operationId: null,
        metadata: {},
        createdAt: new Date("2026-06-15T11:00:00.000Z")
      },
      {
        id: "chat-old-assistant",
        projectId: "project-1",
        role: "ASSISTANT",
        content: "Which page or exact phrase should I change?",
        operationId: null,
        metadata: {},
        createdAt: new Date("2026-06-15T11:01:00.000Z")
      },
      {
        id: "chat-stranded-user",
        projectId: "project-1",
        role: "USER",
        content: "whole book",
        operationId: null,
        metadata: {},
        createdAt: new Date("2026-06-15T11:02:00.000Z")
      },
      {
        id: "chat-stranded-assistant",
        projectId: "project-1",
        role: "ASSISTANT",
        content: "I can help with questions about the book or make edits if you tell me what to change.",
        operationId: null,
        metadata: {},
        createdAt: new Date("2026-06-15T11:03:00.000Z")
      }
    );
    mockPrisma.project.findFirst.mockResolvedValue(
      projectRecord({
        id: "project-1",
        status: "COMPLETE",
        currentPlanId: "plan-1",
        currentPlan: approvedPlanRecord(),
        pages: generatedPages()
      })
    );
    const app = await buildMobileApp();

    const response = await app.inject({
      method: "POST",
      url: "/api/mobile/projects/project-1/chat/messages",
      headers: bearer("token-a"),
      payload: { message: "wow" }
    });
    const body = response.json();

    expect(response.statusCode).toBe(200);
    expect(body.operation).toBeNull();
    expect(body.reply.content).toContain("I still have your earlier edit");
    expect(body.reply.content).toContain("whole book");
    expect(body.reply.content).not.toContain("I can help with questions");
    expect(vi.mocked(enqueueGenerationJob)).not.toHaveBeenCalled();
    await app.close();
  });

  it("rate limits repeated mobile generation actions", async () => {
    mockAccessTokens({ "token-a": "user-a" });
    mockPrisma.project.findFirst.mockResolvedValueOnce(projectRecord({ id: "project-1" }));
    mockPrisma.project.update.mockResolvedValue({});
    vi.mocked(enqueueGenerationJob).mockResolvedValueOnce(jobRecord({ id: "job-plan" }));
    const app = await buildMobileApp({ generationRateLimit: { maxAttempts: 1, windowMs: 60_000 } });

    const first = await app.inject({
      method: "POST",
      url: "/api/mobile/projects/project-1/plan",
      headers: bearer("token-a"),
      payload: {}
    });
    const second = await app.inject({
      method: "POST",
      url: "/api/mobile/projects/project-1/plan",
      headers: bearer("token-a"),
      payload: {}
    });

    expect(first.statusCode).toBe(202);
    expect(second.statusCode).toBe(429);
    expect(second.json().error.code).toBe("RATE_LIMITED");
    expect(vi.mocked(enqueueGenerationJob)).toHaveBeenCalledOnce();
    await app.close();
  });

  it("does not rate limit mobile project reads after a plan generation action", async () => {
    mockAccessTokens({ "token-a": "user-a" });
    mockPrisma.project.findFirst.mockImplementation(async ({ where }: { where: { id?: string; userId?: string } }) =>
      where.id === "project-1" && where.userId === "user-a" ? projectRecord({ id: "project-1", status: "PLANNING" }) : null
    );
    mockPrisma.project.update.mockResolvedValue({});
    vi.mocked(enqueueGenerationJob).mockResolvedValueOnce(jobRecord({ id: "job-plan" }));
    const app = await buildMobileApp({ generationRateLimit: { maxAttempts: 1, windowMs: 60_000 } });

    const plan = await app.inject({
      method: "POST",
      url: "/api/mobile/projects/project-1/plan",
      headers: bearer("token-a"),
      payload: {}
    });
    const detail = await app.inject({
      method: "GET",
      url: "/api/mobile/projects/project-1",
      headers: bearer("token-a")
    });
    const status = await app.inject({
      method: "GET",
      url: "/api/mobile/projects/project-1/status",
      headers: bearer("token-a")
    });
    const repeatedPlan = await app.inject({
      method: "POST",
      url: "/api/mobile/projects/project-1/plan",
      headers: bearer("token-a"),
      payload: {}
    });

    expect(plan.statusCode).toBe(202);
    expect(detail.statusCode).toBe(200);
    expect(detail.json().project).toMatchObject({ id: "project-1", status: "planning" });
    expect(status.statusCode).toBe(200);
    expect(status.json().status.projectId).toBe("project-1");
    expect(repeatedPlan.statusCode).toBe(429);
    await app.close();
  });

  it("authorizes mobile PDF and EPUB downloads by project owner", async () => {
    mockAccessTokens({ "token-a": "user-a", "token-b": "user-b" });
    writeProjectFile(tempBookStorageDir, "project-a", "book.pdf", "%PDF-mobile-owned");
    writeProjectFile(tempBookStorageDir, "project-a", "book.epub", "epub-mobile-owned");
    mockPrisma.project.findFirst.mockImplementation(async ({ where }: { where: { id?: string; userId?: string } }) =>
      where.id === "project-a" && where.userId === "user-a"
        ? { id: "project-a", title: "Owned Mobile Book", language: "en", currentPlanId: null, mediaSettings: {} }
        : null
    );
    const app = await buildMobileApp();

    const ownPdf = await app.inject({
      method: "GET",
      url: "/api/mobile/projects/project-a/export/pdf",
      headers: bearer("token-a")
    });
    const otherPdf = await app.inject({
      method: "GET",
      url: "/api/mobile/projects/project-a/export/pdf",
      headers: bearer("token-b")
    });
    const ownEpub = await app.inject({
      method: "GET",
      url: "/api/mobile/projects/project-a/export/epub",
      headers: bearer("token-a")
    });
    const otherEpub = await app.inject({
      method: "GET",
      url: "/api/mobile/projects/project-a/export/epub",
      headers: bearer("token-b")
    });

    expect(ownPdf.statusCode).toBe(200);
    expect(ownPdf.body).toBe("%PDF-mobile-owned");
    expect(otherPdf.statusCode).toBe(404);
    expect(otherPdf.json().error.code).toBe("PROJECT_NOT_FOUND");
    expect(ownEpub.statusCode).toBe(200);
    expect(ownEpub.body).toBe("epub-mobile-owned");
    expect(otherEpub.statusCode).toBe(404);
    expect(otherEpub.json().error.code).toBe("PROJECT_NOT_FOUND");
    expect(vi.mocked(ensureProjectExportEntitlementOrSpend)).toHaveBeenCalledWith({
      userId: "user-a",
      projectId: "project-a",
      idempotencyKey: "mobile:project:project-a:export-unlock"
    });
    await app.close();
  });

  it("blocks mobile export downloads when export unlock credits are insufficient", async () => {
    mockAccessTokens({ "token-a": "user-a" });
    writeProjectFile(tempBookStorageDir, "project-a", "book.pdf", "%PDF-mobile-owned");
    mockPrisma.project.findFirst.mockResolvedValue({
      id: "project-a",
      title: "Owned Mobile Book",
      status: "COMPLETE",
      language: "en",
      currentPlanId: "plan-1",
      mediaSettings: {}
    });
    vi.mocked(ensureProjectExportEntitlementOrSpend).mockRejectedValueOnce(
      new InsufficientCreditsError({ requiredCredits: 150, availableCredits: 25, reservedCredits: 0 })
    );
    const app = await buildMobileApp();

    const response = await app.inject({
      method: "GET",
      url: "/api/mobile/projects/project-a/export/pdf",
      headers: bearer("token-a")
    });

    expect(response.statusCode).toBe(402);
    expect(response.json().error).toMatchObject({
      code: "INSUFFICIENT_CREDITS",
      requiredCredits: 150,
      availableCredits: 25
    });
    await app.close();
  });

  it("keeps operator project creation advanced controls available on /api/projects", async () => {
    mockPrisma.template.findFirst.mockResolvedValue({ id: "template-story" });
    mockPrisma.project.create.mockImplementation(async ({ data }: { data: Record<string, unknown> }) =>
      projectRecord({
        id: "operator-project",
        title: data.title,
        prompt: data.prompt,
        category: data.category,
        targetPages: data.targetPages,
        mediaSettings: data.mediaSettings
      })
    );
    const app = await buildOperatorApp();

    const response = await app.inject({
      method: "POST",
      url: "/api/projects",
      payload: {
        title: "Operator Model Test",
        prompt: "A practical operator-created book with enough detail to pass validation.",
        category: "STORY",
        targetPages: 12,
        complexity: 7,
        temperature: 0.4,
        language: "es",
        mediaSettings: {
          fullIllustrations: true,
          illustrationCadence: "template-driven",
          includeCover: true,
          coverTemplate: "auto",
          finalReview: true,
          generationStrategy: "chaptered-sequential",
          textModel: { provider: "gemini", model: "gemini-3.5-flash" },
          toneProfile: "neutral"
        }
      }
    });

    expect(response.statusCode).toBe(201);
    expect(mockPrisma.project.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          userId: "local-admin",
          temperature: 0.4,
          mediaSettings: expect.objectContaining({
            generationStrategy: "chaptered-sequential",
            textModel: { provider: "gemini", model: "gemini-3.5-flash" }
          })
        })
      })
    );
    await app.close();
  });

  it("returns full page markdown for the owner's editable book", async () => {
    mockAccessTokens({ "token-a": "user-a" });
    mockPrisma.project.findFirst.mockResolvedValue(
      projectRecord({
        id: "project-1",
        status: "COMPLETE",
        pages: editablePages().map(({ projectId, summary, ...page }) => page)
      })
    );
    const app = await buildMobileApp();

    const response = await app.inject({
      method: "GET",
      url: "/api/mobile/projects/project-1/book",
      headers: bearer("token-a")
    });
    const body = response.json();

    expect(response.statusCode).toBe(200);
    expect(body.book.projectId).toBe("project-1");
    expect(body.book.pages).toEqual([
      expect.objectContaining({
        id: "page-1",
        index: 1,
        markdown: "Rabbit runs ahead at the start of the race.",
        revision: 1
      }),
      expect.objectContaining({ id: "page-2", index: 2, revision: 1 })
    ]);
    await app.close();
  });

  it("refuses editable book content before generation completes", async () => {
    mockAccessTokens({ "token-a": "user-a" });
    mockPrisma.project.findFirst.mockResolvedValue(
      projectRecord({ id: "project-1", status: "GENERATING", pages: [] })
    );
    const app = await buildMobileApp();

    const response = await app.inject({
      method: "GET",
      url: "/api/mobile/projects/project-1/book",
      headers: bearer("token-a")
    });

    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe("BOOK_NOT_READY");
    await app.close();
  });

  it("saves a manual edit, snapshots pages, refreshes exports, and posts a saved-export message", async () => {
    mockAccessTokens({ "token-a": "user-a" });
    mockPrisma.project.findFirst.mockResolvedValue(
      projectRecord({ id: "project-1", status: "COMPLETE", currentPlanId: "plan-1" })
    );
    mockPages = editablePages();
    writeProjectFile(tempBookStorageDir, "project-1", "book.pdf", "%PDF-stale");
    vi.mocked(enqueueGenerationJob).mockResolvedValueOnce(jobRecord({ id: "job-compile", type: "COMPILE_EXPORT" }));
    const app = await buildMobileApp();

    const response = await app.inject({
      method: "POST",
      url: "/api/mobile/projects/project-1/manual-edits",
      headers: bearer("token-a"),
      payload: {
        pages: [
          {
            id: "page-1",
            title: "Rabbit Starts Fast",
            markdown: "Rabbit sprints ahead while Turtle takes one steady step.",
            baseRevision: 1
          }
        ]
      }
    });
    const body = response.json();

    expect(response.statusCode).toBe(200);
    expect(body.operation).toMatchObject({
      kind: "manual_edit",
      status: "applied",
      creditsCharged: 0,
      affectedPageIndexes: [1]
    });
    expect(body.savedExportMessage.role).toBe("assistant");
    expect(body.savedExportMessage.metadata.manualEdit).toMatchObject({
      pageIndexes: [1],
      editCount: 1
    });
    expect(mockPages.find((page) => page.id === "page-1")).toMatchObject({
      markdown: "Rabbit sprints ahead while Turtle takes one steady step.",
      revision: 2
    });
    expect(mockPageEditSnapshots).toEqual([
      expect.objectContaining({
        pageId: "page-1",
        markdownBefore: "Rabbit runs ahead at the start of the race.",
        markdownAfter: "Rabbit sprints ahead while Turtle takes one steady step.",
        revisionBefore: 1,
        revisionAfter: 2
      })
    ]);
    expect(existsSync(join(tempBookStorageDir!, "project-1", "book.pdf"))).toBe(false);
    expect(vi.mocked(enqueueGenerationJob)).toHaveBeenCalledWith(expect.objectContaining({
      projectId: "project-1",
      type: "COMPILE_EXPORT",
      payload: expect.objectContaining({ planId: "plan-1", skipFinalReview: true })
    }));
    expect(mockPrisma.project.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: "project-1" },
      data: expect.objectContaining({ status: "EDITING" })
    }));
    expect(mockPrisma.project.update).not.toHaveBeenCalledWith({
      where: { id: "project-1" },
      data: { status: "COMPLETE" }
    });
    await app.close();
  });

  it("restores COMPLETE when the manual edit recompile cannot be queued", async () => {
    mockAccessTokens({ "token-a": "user-a" });
    mockPrisma.project.findFirst.mockResolvedValue(
      projectRecord({ id: "project-1", status: "COMPLETE", currentPlanId: "plan-1" })
    );
    mockPages = editablePages();
    mockPrisma.project.update.mockResolvedValue(projectRecord({ id: "project-1" }));
    vi.mocked(enqueueGenerationJob).mockRejectedValueOnce(new Error("queue offline"));
    const app = await buildMobileApp();

    const response = await app.inject({
      method: "POST",
      url: "/api/mobile/projects/project-1/manual-edits",
      headers: bearer("token-a"),
      payload: {
        pages: [
          { id: "page-1", title: "Rabbit Starts Fast", markdown: "New words entirely.", baseRevision: 1 }
        ]
      }
    });

    expect(response.statusCode).toBe(200);
    expect(mockPrisma.project.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: "project-1" },
      data: expect.objectContaining({ status: "EDITING" })
    }));
    expect(mockPrisma.project.update).toHaveBeenCalledWith({
      where: { id: "project-1" },
      data: { status: "COMPLETE" }
    });
    await app.close();
  });

  it("updates the saved export message in place when the user edits it again", async () => {
    mockAccessTokens({ "token-a": "user-a" });
    mockPrisma.project.findFirst.mockResolvedValue(
      projectRecord({ id: "project-1", status: "COMPLETE", currentPlanId: "plan-1" })
    );
    mockPages = editablePages();
    mockProjectChatMessages.push({
      id: "chat-saved-export",
      projectId: "project-1",
      parentId: null,
      role: "ASSISTANT",
      content: "You edited page 1 yourself in Edit Mode. The exports are refreshing with your changes.",
      operationId: "operation-old",
      metadata: {
        charged: false,
        manualEdit: { operationId: "operation-old", pageIndexes: [1], editCount: 1 }
      },
      isActiveChild: true,
      createdAt: new Date("2026-06-15T11:00:00.000Z")
    });
    const app = await buildMobileApp();

    const response = await app.inject({
      method: "POST",
      url: "/api/mobile/projects/project-1/manual-edits",
      headers: bearer("token-a"),
      payload: {
        savedExportMessageId: "chat-saved-export",
        pages: [
          { id: "page-2", title: "Rabbit Learns", markdown: "Rabbit cheers as Turtle crosses the line.", baseRevision: 1 }
        ]
      }
    });
    const body = response.json();

    expect(response.statusCode).toBe(200);
    expect(body.savedExportMessage.id).toBe("chat-saved-export");
    expect(body.savedExportMessage.metadata.manualEdit).toMatchObject({
      pageIndexes: [1, 2],
      editCount: 2
    });
    const savedExportMessages = mockProjectChatMessages.filter((message) => message.metadata?.manualEdit);
    expect(savedExportMessages).toHaveLength(1);
    await app.close();
  });

  it("rejects manual edits when the book changed since the editor loaded", async () => {
    mockAccessTokens({ "token-a": "user-a" });
    mockPrisma.project.findFirst.mockResolvedValue(
      projectRecord({ id: "project-1", status: "COMPLETE", currentPlanId: "plan-1" })
    );
    mockPages = editablePages().map((page) => ({ ...page, revision: 3 }));
    const app = await buildMobileApp();

    const response = await app.inject({
      method: "POST",
      url: "/api/mobile/projects/project-1/manual-edits",
      headers: bearer("token-a"),
      payload: {
        pages: [{ id: "page-1", title: "Rabbit Starts Fast", markdown: "New words.", baseRevision: 1 }]
      }
    });

    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe("EDIT_CONFLICT");
    expect(mockPrisma.page.update).not.toHaveBeenCalled();
    await app.close();
  });

  it("blocks manual edits while other project work is running", async () => {
    mockAccessTokens({ "token-a": "user-a" });
    mockPrisma.project.findFirst.mockResolvedValue(
      projectRecord({ id: "project-1", status: "COMPLETE", currentPlanId: "plan-1" })
    );
    mockPrisma.generationJob.count.mockResolvedValueOnce(1);
    const app = await buildMobileApp();

    const response = await app.inject({
      method: "POST",
      url: "/api/mobile/projects/project-1/manual-edits",
      headers: bearer("token-a"),
      payload: {
        pages: [{ id: "page-1", title: "Rabbit Starts Fast", markdown: "New words.", baseRevision: 1 }]
      }
    });

    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe("PROJECT_BUSY");
    await app.close();
  });

  it("rejects manual edit saves that change nothing", async () => {
    mockAccessTokens({ "token-a": "user-a" });
    mockPrisma.project.findFirst.mockResolvedValue(
      projectRecord({ id: "project-1", status: "COMPLETE", currentPlanId: "plan-1" })
    );
    mockPages = editablePages();
    const app = await buildMobileApp();

    const response = await app.inject({
      method: "POST",
      url: "/api/mobile/projects/project-1/manual-edits",
      headers: bearer("token-a"),
      payload: {
        pages: [
          {
            id: "page-1",
            title: "Rabbit Starts Fast",
            markdown: "Rabbit runs ahead at the start of the race.",
            baseRevision: 1
          }
        ]
      }
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe("NO_CHANGES");
    await app.close();
  });
});

function mockAccessTokens(tokensByRawToken: Record<string, string>) {
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

function bearer(token: string) {
  return { authorization: `Bearer ${token}` };
}

function projectRecord(overrides: Record<string, unknown> = {}) {
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
    templateId: null,
    currentPlanId: null,
    currentPlan: null,
    chapters: [],
    pages: [],
    _count: { pages: 0, images: 0, jobs: 0 },
    createdAt: new Date("2026-06-01T12:00:00.000Z"),
    updatedAt: new Date("2026-06-01T12:00:00.000Z"),
    ...overrides
  };
}

function approvedPlanRecord(overrides: Record<string, unknown> = {}) {
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

function failedPlanRevisionOperationRecord(overrides: Record<string, unknown> = {}) {
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
    createdAt: new Date("2026-06-15T13:00:00.000Z"),
    updatedAt: new Date("2026-06-15T13:01:00.000Z"),
    appliedAt: null,
    ...overrides
  };
}

function matchesProjectChatWhere(message: Record<string, any>, where: Record<string, any>): boolean {
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
  if (where.isActiveChild !== undefined && message.isActiveChild !== where.isActiveChild) {
    return false;
  }
  if (Object.prototype.hasOwnProperty.call(where, "parentId") && (message.parentId ?? null) !== where.parentId) {
    return false;
  }
  return true;
}

function generatedPages() {
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

function editablePages() {
  return generatedPages().map((page) => ({
    ...page,
    projectId: "project-1",
    revision: 1
  }));
}

function creationPayload(
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

function creationDraftRecord(overrides: Record<string, unknown> = {}) {
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

function jobRecord(overrides: Partial<QueuedGenerationJobRecord> = {}): QueuedGenerationJobRecord {
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

function statusRecord(overrides: Record<string, any> = {}) {
  const base = {
    project: {
      id: "project-1",
      title: "Owned Book",
      status: "DRAFT",
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

function writeProjectFile(storageDir: string | null, projectId: string, filename: string, content: string) {
  if (!storageDir) {
    throw new Error("Storage dir was not initialized");
  }
  const projectDir = join(storageDir, projectId);
  mkdirSync(projectDir, { recursive: true });
  writeFileSync(join(projectDir, filename), content);
}

async function buildMobileApp(options: Record<string, unknown> = {}): Promise<FastifyInstance> {
  const app = Fastify();
  const { mobileProjectRoutes } = await import("./mobileProjects.js");
  await app.register(mobileProjectRoutes, options);
  return app;
}

async function buildOperatorApp(): Promise<FastifyInstance> {
  const app = Fastify();
  const { projectRoutes } = await import("./routes/projects.js");
  await app.register(projectRoutes);
  return app;
}

describe("creation chat attachments API", () => {
  let tempAttachmentStorageDir: string | null = null;

  beforeEach(() => {
    vi.resetAllMocks();
    tempAttachmentStorageDir = mkdtempSync(join(tmpdir(), "book-maker-mobile-attachments-"));
    process.env = { ...originalEnv, ATTACHMENT_STORAGE_DIR: tempAttachmentStorageDir };
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    if (tempAttachmentStorageDir) {
      rmSync(tempAttachmentStorageDir, { recursive: true, force: true });
      tempAttachmentStorageDir = null;
    }
  });

  const readyAttachment = {
    id: "att_ready1",
    kind: "document" as const,
    name: "notes.txt",
    mimeType: "text/plain",
    sizeBytes: 64,
    summary: "Pricing notes for consultants.",
    content: "Anchor high and offer three tiers.",
    truncated: false,
    createdAt: "2026-07-06T00:00:00.000Z"
  };
  const sessionPayload = {
    payloadVersion: 3,
    rawIdea: "A pricing guide",
    messages: [
      { role: "assistant", content: "Hi!" },
      { role: "user", content: "A pricing guide" }
    ]
  };

  it("uploads a file, digests it, and persists it on the draft", async () => {
    mockAccessTokens({ "token-a": "user-a" });
    mockPrisma.mobileCreationDraft.findFirst.mockResolvedValueOnce(
      creationDraftRecord({ id: "session-draft", payload: sessionPayload })
    );
    mockPrisma.mobileCreationDraft.update.mockImplementation(async ({ data }: { data: Record<string, unknown> }) =>
      creationDraftRecord({ id: "session-draft", ...data })
    );
    const ingestion = vi.fn().mockResolvedValue(readyAttachment);
    const app = await buildMobileApp({ attachmentIngestion: ingestion });

    const response = await app.inject({
      method: "POST",
      url: "/api/mobile/creation-sessions/session-draft/attachments?filename=notes.txt&mimeType=text%2Fplain",
      headers: { ...bearer("token-a"), "content-type": "application/octet-stream" },
      payload: Buffer.from("Anchor high and offer three tiers.", "utf8")
    });

    expect(response.statusCode).toBe(201);
    expect(response.json()).toMatchObject({
      attachment: { id: "att_ready1", kind: "document", name: "notes.txt", pages: null }
    });
    // Digested text stays server-side.
    expect(JSON.stringify(response.json())).not.toContain("Anchor high");
    expect(ingestion).toHaveBeenCalledWith(
      expect.objectContaining({ name: "notes.txt", mimeType: "text/plain" })
    );
    const updateCall = mockPrisma.mobileCreationDraft.update.mock.calls.at(0)?.[0] as {
      data: { payload: { attachments: Array<Record<string, unknown>> } };
    };
    expect(updateCall.data.payload.attachments).toHaveLength(1);
    expect(updateCall.data.payload.attachments[0]).toMatchObject({ id: "att_ready1", content: "Anchor high and offer three tiers." });
    // Original bytes are kept server-side so the file follows the account across devices.
    const storedPath = join(tempAttachmentStorageDir!, "session-draft", "att_ready1");
    expect(readFileSync(storedPath, "utf8")).toBe("Anchor high and offer three tiers.");
    expect(response.json().attachment.url).toBe(
      "/api/mobile/creation-sessions/session-draft/attachments/att_ready1/file"
    );
    await app.close();
  });

  it("serves the stored original file and 404s once it is gone", async () => {
    mockAccessTokens({ "token-a": "user-a" });
    const payload = { ...sessionPayload, attachments: [readyAttachment] };
    mockPrisma.mobileCreationDraft.findFirst.mockResolvedValue(
      creationDraftRecord({ id: "session-draft", payload })
    );
    const fileDir = join(tempAttachmentStorageDir!, "session-draft");
    mkdirSync(fileDir, { recursive: true });
    writeFileSync(join(fileDir, "att_ready1"), "original bytes");
    const app = await buildMobileApp();

    const served = await app.inject({
      method: "GET",
      url: "/api/mobile/creation-sessions/session-draft/attachments/att_ready1/file",
      headers: bearer("token-a")
    });
    expect(served.statusCode).toBe(200);
    expect(served.headers["content-type"]).toContain("text/plain");
    expect(served.body).toBe("original bytes");

    rmSync(join(fileDir, "att_ready1"));
    const expired = await app.inject({
      method: "GET",
      url: "/api/mobile/creation-sessions/session-draft/attachments/att_ready1/file",
      headers: bearer("token-a")
    });
    expect(expired.statusCode).toBe(404);
    expect(expired.json()).toMatchObject({ error: { code: "ATTACHMENT_FILE_EXPIRED" } });
    await app.close();
  });

  it("returns friendly errors for unsupported files", async () => {
    mockAccessTokens({ "token-a": "user-a" });
    mockPrisma.mobileCreationDraft.findFirst.mockResolvedValueOnce(
      creationDraftRecord({ id: "session-draft", payload: sessionPayload })
    );
    const { CreationAttachmentError } = await import("@book-maker/core");
    const app = await buildMobileApp({
      attachmentIngestion: vi.fn().mockRejectedValue(
        new CreationAttachmentError("UNSUPPORTED_TYPE", "That file type isn't supported yet.")
      )
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/mobile/creation-sessions/session-draft/attachments?filename=song.mp3",
      headers: { ...bearer("token-a"), "content-type": "application/octet-stream" },
      payload: Buffer.from([1, 2, 3])
    });

    expect(response.statusCode).toBe(422);
    expect(response.json()).toMatchObject({ error: { code: "UNSUPPORTED_TYPE" } });
    await app.close();
  });

  it("binds uploaded attachments to a chat message and acknowledges them", async () => {
    mockAccessTokens({ "token-a": "user-a" });
    const payload = { ...sessionPayload, attachments: [readyAttachment] };
    mockPrisma.mobileCreationDraft.findFirst.mockResolvedValueOnce(
      creationDraftRecord({ id: "session-draft", payload })
    );
    mockPrisma.mobileCreationDraft.update.mockImplementation(async ({ data }: { data: Record<string, unknown> }) =>
      creationDraftRecord({ id: "session-draft", ...data })
    );
    const app = await buildMobileApp({ advisorEnrichment: false, creationEnrichment: false });

    const response = await app.inject({
      method: "POST",
      url: "/api/mobile/creation-sessions/session-draft/messages",
      headers: bearer("token-a"),
      payload: { message: "", attachmentIds: ["att_ready1"] }
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.turn.assistantMessage).toContain("notes.txt");
    expect(body.session.attachments).toHaveLength(1);
    const updateCall = mockPrisma.mobileCreationDraft.update.mock.calls.at(0)?.[0] as {
      data: { payload: { messages: Array<Record<string, unknown>>; attachments: Array<Record<string, unknown>> } };
    };
    const userMessages = updateCall.data.payload.messages.filter((message) => message.role === "user");
    expect(userMessages.at(-1)).toMatchObject({
      attachments: [{ id: "att_ready1", kind: "document", name: "notes.txt" }]
    });
    expect(updateCall.data.payload.attachments).toHaveLength(1);
    await app.close();
  });

  it("rejects messages that reference unknown attachments", async () => {
    mockAccessTokens({ "token-a": "user-a" });
    mockPrisma.mobileCreationDraft.findFirst.mockResolvedValueOnce(
      creationDraftRecord({ id: "session-draft", payload: sessionPayload })
    );
    const app = await buildMobileApp({ advisorEnrichment: false, creationEnrichment: false });

    const response = await app.inject({
      method: "POST",
      url: "/api/mobile/creation-sessions/session-draft/messages",
      headers: bearer("token-a"),
      payload: { message: "Use my file", attachmentIds: ["att_missing"] }
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ error: { code: "ATTACHMENT_NOT_FOUND" } });
    await app.close();
  });

  it("removes unsent attachments but protects ones already in the conversation", async () => {
    mockAccessTokens({ "token-a": "user-a", "token-b": "user-a" });
    const sentRef = { id: "att_ready1", kind: "document", name: "notes.txt" };
    const payloadWithSent = {
      ...sessionPayload,
      messages: [...sessionPayload.messages, { role: "user", content: "", attachments: [sentRef] }],
      attachments: [readyAttachment, { ...readyAttachment, id: "att_unsent", name: "draft.md" }]
    };
    mockPrisma.mobileCreationDraft.findFirst.mockResolvedValue(
      creationDraftRecord({ id: "session-draft", payload: payloadWithSent })
    );
    mockPrisma.mobileCreationDraft.update.mockImplementation(async ({ data }: { data: Record<string, unknown> }) =>
      creationDraftRecord({ id: "session-draft", ...data })
    );
    const fileDir = join(tempAttachmentStorageDir!, "session-draft");
    mkdirSync(fileDir, { recursive: true });
    writeFileSync(join(fileDir, "att_unsent"), "unsent bytes");
    writeFileSync(join(fileDir, "att_ready1"), "sent bytes");
    const app = await buildMobileApp();

    const removeUnsent = await app.inject({
      method: "DELETE",
      url: "/api/mobile/creation-sessions/session-draft/attachments/att_unsent",
      headers: bearer("token-a")
    });
    const removeSent = await app.inject({
      method: "DELETE",
      url: "/api/mobile/creation-sessions/session-draft/attachments/att_ready1",
      headers: bearer("token-a")
    });

    expect(removeUnsent.statusCode).toBe(200);
    expect(existsSync(join(fileDir, "att_unsent"))).toBe(false);
    expect(removeSent.statusCode).toBe(409);
    expect(removeSent.json()).toMatchObject({ error: { code: "ATTACHMENT_IN_USE" } });
    expect(existsSync(join(fileDir, "att_ready1"))).toBe(true);
    await app.close();
  });

  it("protects attachments referenced only by an inactive chat branch", async () => {
    mockAccessTokens({ "token-a": "user-a" });
    const sentRef = { id: "att_ready1", kind: "document", name: "notes.txt" };
    // The message carrying the attachment sits on an abandoned branch.
    const payloadWithFork = {
      ...sessionPayload,
      messages: [
        { id: "m0", parentId: null, isActiveChild: true, role: "assistant", content: "Hi!" },
        { id: "m1", parentId: "m0", isActiveChild: false, role: "user", content: "", attachments: [sentRef] },
        { id: "m2", parentId: "m0", isActiveChild: true, role: "user", content: "No file after all" }
      ],
      attachments: [readyAttachment]
    };
    mockPrisma.mobileCreationDraft.findFirst.mockResolvedValue(
      creationDraftRecord({ id: "session-draft", payload: payloadWithFork })
    );
    const app = await buildMobileApp();

    const response = await app.inject({
      method: "DELETE",
      url: "/api/mobile/creation-sessions/session-draft/attachments/att_ready1",
      headers: bearer("token-a")
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ error: { code: "ATTACHMENT_IN_USE" } });
    await app.close();
  });
});
