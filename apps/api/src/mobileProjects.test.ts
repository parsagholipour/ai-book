import Fastify, { type FastifyInstance } from "fastify";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
import { enqueueGenerationJob, isBullJobActive, requeueGenerationJob } from "./queue.js";

type QueuedGenerationJobRecord = Awaited<ReturnType<typeof enqueueGenerationJob>>;

const mockPrisma = vi.hoisted(() => ({
  $transaction: vi.fn(),
  user: { upsert: vi.fn() },
  mobileSession: { findUnique: vi.fn() },
  mobileCreationDraft: { findFirst: vi.fn(), findMany: vi.fn(), create: vi.fn(), update: vi.fn() },
  mobileCreationOutput: { create: vi.fn(), findFirst: vi.fn() },
  template: { findFirst: vi.fn(), findMany: vi.fn() },
  productCatalog: { findUnique: vi.fn() },
  project: { findUnique: vi.fn(), findFirst: vi.fn(), findMany: vi.fn(), create: vi.fn(), update: vi.fn() },
  page: { findMany: vi.fn() },
  planVersion: { findFirst: vi.fn(), findMany: vi.fn(), updateMany: vi.fn(), update: vi.fn() },
  projectChatMessage: { create: vi.fn(), findFirst: vi.fn(), findMany: vi.fn(), updateMany: vi.fn() },
  bookEditOperation: { create: vi.fn(), update: vi.fn(), findMany: vi.fn() },
  generationJob: { count: vi.fn(), findMany: vi.fn(), create: vi.fn(), update: vi.fn() },
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

vi.mock("@book-maker/db", () => ({
  ensureSeedTemplates: vi.fn(),
  Prisma: { JsonNull: null },
  prisma: mockPrisma
}));

vi.mock("@book-maker/db/billing", () => mockBilling);

vi.mock("./queue.js", () => ({
  enqueueGenerationJob: vi.fn(),
  isBullJobActive: vi.fn(),
  requeueGenerationJob: vi.fn(),
  stopProjectGenerationJobs: vi.fn(),
  closeQueue: vi.fn()
}));

vi.mock("./projectStatus.js", () => ({
  buildProjectStatus: vi.fn(),
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
    vi.mocked(isBullJobActive).mockResolvedValue(false);
    vi.mocked(requeueGenerationJob).mockResolvedValue(jobRecord({ id: "job-resumed", status: "QUEUED" }));
    vi.mocked(buildProjectStatus).mockResolvedValue(statusRecord());
    mockPrisma.generationJob.count.mockResolvedValue(0);
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
    mockPrisma.projectChatMessage.findMany.mockImplementation(async ({ where, orderBy, take }: { where: Record<string, any>; orderBy?: { createdAt: "asc" | "desc" }; take?: number }) => {
      const rows = mockProjectChatMessages.filter((message) => matchesProjectChatWhere(message, where));
      const sorted = [...rows].sort((a, b) =>
        orderBy?.createdAt === "desc"
          ? b.createdAt.getTime() - a.createdAt.getTime() || b.id.localeCompare(a.id)
          : a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id)
      );
      return typeof take === "number" ? sorted.slice(0, take) : sorted;
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
    mockPrisma.mobileCreationOutput.create.mockImplementation(async ({ data, include }: { data: Record<string, any>; include?: unknown }) => ({
      id: `output-${data.projectId}`,
      draftId: data.draftId,
      projectId: data.projectId,
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
      OPENAI_API_KEY: "",
      GEMINI_API_KEY: "",
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
        draftCandidates: 1
      })
    });
    expect(balanced).toMatchObject({
      category: "EDUCATION",
      targetPages: 28,
      complexity: 5,
      temperature: 0.65,
      mediaSettings: expect.objectContaining({ finalReview: true, draftCandidates: 1 })
    });
    expect(premium).toMatchObject({
      category: "BUSINESS",
      targetPages: 24,
      complexity: 6,
      temperature: 0.55,
      mediaSettings: expect.objectContaining({ finalReview: true, draftCandidates: 2, parallelPageGeneration: false })
    });
    expect(JSON.stringify({ fast, balanced, premium })).not.toMatch(/provider|model/);
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
    expect(body.status.failureMessage).toContain("while writing a page");
    expect(body.status.failureMessage).not.toContain("GENERATE_PAGE");
    expect(JSON.stringify(body.status)).not.toMatch(/jobs|queue|tokens|cost|provider|model/);
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
      {
        projectId: "project-1",
        type: "REVISE_PLAN",
        payload: {
          planId: "plan-1",
          message: "Make the examples warmer and more practical.",
          billingLedgerEntryId: "ledger-PLAN_REVISION"
        }
      },
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
      expect.objectContaining({ role: "assistant", content: expect.stringContaining("current plan") })
    ]);
    expect(body.reply.content).not.toMatch(/book text edits are available after/i);
    expect(vi.mocked(enqueueGenerationJob)).not.toHaveBeenCalled();
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
    expect(body.reply.content).toContain("current plan");
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

  it("queues a completed-book whole-book style edit across all generated pages", async () => {
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

    const response = await app.inject({
      method: "POST",
      url: "/api/mobile/projects/project-1/chat/messages",
      headers: bearer("token-a"),
      payload: { message: "Make the whole book warmer and simpler." }
    });
    const body = response.json();

    expect(response.statusCode).toBe(200);
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
    expect(body.reply.content).toContain("the whole book");
    await app.close();
  });

  it("queues a completed-book structural character change as a book replan", async () => {
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

    const response = await app.inject({
      method: "POST",
      url: "/api/mobile/projects/project-1/chat/messages",
      headers: bearer("token-a"),
      payload: { message: "Change the character of rabbit with a fly." }
    });
    const body = response.json();

    expect(response.statusCode).toBe(200);
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

  it("queues a completed-book English language version as a new copy", async () => {
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

    const response = await app.inject({
      method: "POST",
      url: "/api/mobile/projects/project-1/chat/messages",
      headers: bearer("token-a"),
      payload: { message: "Now generate the English version" }
    });
    const body = response.json();

    expect(response.statusCode).toBe(200);
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

    const response = await app.inject({
      method: "POST",
      url: "/api/mobile/projects/project-1/chat/messages",
      headers: bearer("token-a"),
      payload: { message: "whole book" }
    });
    const body = response.json();

    expect(response.statusCode).toBe(200);
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
    expect(body.reply.content).not.toContain("I can help with questions");
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

    const response = await app.inject({
      method: "POST",
      url: "/api/mobile/projects/project-1/chat/messages",
      headers: bearer("token-a"),
      payload: { message: "I said whole book" }
    });
    const body = response.json();

    expect(response.statusCode).toBe(200);
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
    expect(body.reply.content).not.toContain("I can help with questions");
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

    const response = await app.inject({
      method: "POST",
      url: "/api/mobile/projects/project-1/chat/messages",
      headers: bearer("token-a"),
      payload: { message: "ok" }
    });
    const body = response.json();

    expect(response.statusCode).toBe(200);
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
    expect(body.messages.at(-2).metadata.resolvedPendingEdit).toMatchObject({
      request: "Replace rabbit with fly",
      scope: "all_pages",
      scopeMessage: "ok"
    });
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
    kind: "PLAN_REVISION",
    status: "FAILED",
    request: "Make it brighter.",
    classifier: {},
    affectedPageIndexes: [],
    creditsCharged: 40,
    error: "AI plan revision failed. No revised plan was created.",
    generationJob: { id: "job-failed-revision", status: "FAILED" },
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
