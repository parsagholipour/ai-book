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
  reserveCredits
} from "@book-maker/db/billing";
import { hashToken } from "./mobileAuth.js";
import { buildProjectStatus } from "./projectStatus.js";
import { enqueueGenerationJob } from "./queue.js";

type QueuedGenerationJobRecord = Awaited<ReturnType<typeof enqueueGenerationJob>>;

const mockPrisma = vi.hoisted(() => ({
  $transaction: vi.fn(),
  user: { upsert: vi.fn() },
  mobileSession: { findUnique: vi.fn() },
  template: { findFirst: vi.fn(), findMany: vi.fn() },
  project: { findUnique: vi.fn(), findFirst: vi.fn(), findMany: vi.fn(), create: vi.fn(), update: vi.fn() },
  planVersion: { findFirst: vi.fn(), updateMany: vi.fn(), update: vi.fn() },
  generationJob: { count: vi.fn(), findMany: vi.fn(), create: vi.fn(), update: vi.fn() },
  providerCallLog: { aggregate: vi.fn(), findMany: vi.fn(), groupBy: vi.fn() },
  imageAsset: { findMany: vi.fn() },
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
    ensureProjectExportEntitlementOrSpend: vi.fn()
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
    vi.mocked(enqueueGenerationJob).mockResolvedValue(jobRecord());
    vi.mocked(buildProjectStatus).mockResolvedValue(statusRecord());
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
        mobile: {
          bookType: "lead_magnet",
          lengthPreset: "standard",
          qualityPreset: "premium",
          imagesEnabled: true
        }
      })
    });
    expect(Object.keys(body.project).sort()).toMatchInlineSnapshot(`
      [
        "authorName",
        "bookType",
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
        payload: { planId: "plan-1", message: "Make the examples warmer and more practical." }
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
          lessCensored: false,
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
      lessCensored: false,
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
    pages: [],
    _count: { pages: 0, images: 0, jobs: 0 },
    createdAt: new Date("2026-06-01T12:00:00.000Z"),
    updatedAt: new Date("2026-06-01T12:00:00.000Z"),
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

async function buildMobileApp(): Promise<FastifyInstance> {
  const app = Fastify();
  const { mobileProjectRoutes } = await import("./mobileProjects.js");
  await app.register(mobileProjectRoutes);
  return app;
}

async function buildOperatorApp(): Promise<FastifyInstance> {
  const app = Fastify();
  const { projectRoutes } = await import("./routes/projects.js");
  await app.register(projectRoutes);
  return app;
}
