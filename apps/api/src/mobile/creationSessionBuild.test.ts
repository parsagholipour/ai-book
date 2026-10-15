import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@book-maker/db", async () => (await import("./testing/mobileApiMocks.js")).dbModuleMock());
vi.mock("@book-maker/db/billing", async () => (await import("./testing/mobileApiMocks.js")).billingModuleMock());
vi.mock("../queue.js", async () => (await import("./testing/mobileApiMocks.js")).queueModuleMock());
vi.mock("../projectStatus.js", async () => (await import("./testing/mobileApiMocks.js")).projectStatusModuleMock());

import { enqueueGenerationJob } from "../queue.js";
import { InsufficientCreditsError, getBookPageLimit, reserveCredits } from "@book-maker/db/billing";
import { DEFAULT_CREDIT_COSTS, resetCreditPricing, setCreditPricing } from "@book-maker/core";
import { ULTRA_TIER_UNAVAILABLE_MESSAGE } from "./ultraTier.js";
import {
  bearer,
  buildMobileApp,
  creationDraftRecord,
  jobRecord,
  mockAccessTokens,
  mockPrisma,
  projectRecord,
  resetMobileHarness,
  teardownMobileHarness
} from "./testing/mobileApiHarness.js";

type PlanningTier = "fast" | "balanced" | "premium" | "ultra";

function buildPayloadAtTier(qualityPreset: PlanningTier) {
  return {
    payloadVersion: 3,
    rawIdea: "Workbook for new coaches",
    messages: [
      { role: "assistant", content: "Hi!" },
      { role: "user", content: "Workbook for new coaches" }
    ],
    selectedPresets: {
      bookType: "workbook",
      lengthPreset: "short",
      qualityPreset,
      imagesEnabled: true,
      pageCountMode: "custom",
      targetPages: 8,
      pageCountSource: "settings"
    }
  };
}

describe("mobile creation session project build", () => {
  beforeEach(resetMobileHarness);
  afterEach(() => {
    resetCreditPricing();
    teardownMobileHarness();
  });

  it.each([
    ["fast", 20, "planGenerationFast"],
    ["balanced", 40, "planGeneration"],
    ["premium", 80, "planGenerationPremium"],
    ["ultra", 120, "planGenerationUltra"]
  ] as const)("charges and stamps the %s plan quote when Build starts", async (tier, credits, pricingKey) => {
    // Ultra launches switched off; its rate is priced as an operator who turned it on.
    setCreditPricing({ ...DEFAULT_CREDIT_COSTS, ultraTierEnabled: 1 });
    mockAccessTokens({ "token-a": "user-a" });
    const payload = buildPayloadAtTier(tier);
    mockPrisma.mobileCreationDraft.findFirst.mockResolvedValueOnce(
      creationDraftRecord({ id: "session-draft", payload })
    );
    mockPrisma.template.findFirst.mockResolvedValue({ id: "template-workbook" });
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
    vi.mocked(enqueueGenerationJob).mockResolvedValueOnce(jobRecord({ id: `job-plan-${tier}` }));
    const app = await buildMobileApp({ advisorEnrichment: false, creationEnrichment: false });

    const response = await app.inject({
      method: "POST",
      url: "/api/mobile/creation-sessions/session-draft/build",
      headers: bearer("token-a"),
      payload: { requestId: `build-request-${tier}` }
    });

    expect(response.statusCode).toBe(201);
    expect(reserveCredits).toHaveBeenCalledWith(
      expect.objectContaining({
        operation: "PLAN_GENERATION",
        amountCredits: credits,
        metadata: expect.objectContaining({
          draftId: "session-draft",
          buildRequestId: `build-request-${tier}`,
          modelTier: tier,
          pricingKey
        })
      })
    );
    await app.close();
  });

  it("makes no project, output, or job when Build cannot reserve the plan price", async () => {
    setCreditPricing({ ...DEFAULT_CREDIT_COSTS, ultraTierEnabled: 1 });
    mockAccessTokens({ "token-a": "user-a" });
    const payload = buildPayloadAtTier("ultra");
    mockPrisma.mobileCreationDraft.findFirst.mockResolvedValueOnce(
      creationDraftRecord({ id: "session-draft", payload })
    );
    mockPrisma.template.findFirst.mockResolvedValue({ id: "template-workbook" });
    vi.mocked(reserveCredits).mockRejectedValueOnce(
      new InsufficientCreditsError({ requiredCredits: 120, availableCredits: 10, reservedCredits: 0 })
    );
    const app = await buildMobileApp({ advisorEnrichment: false, creationEnrichment: false });

    const response = await app.inject({
      method: "POST",
      url: "/api/mobile/creation-sessions/session-draft/build",
      headers: bearer("token-a"),
      payload: { requestId: "build-request-insufficient" }
    });

    expect(response.statusCode).toBe(402);
    expect(response.json().error).toMatchObject({
      code: "INSUFFICIENT_CREDITS",
      requiredCredits: 120,
      availableCredits: 10
    });
    expect(mockPrisma.project.create).not.toHaveBeenCalled();
    expect(mockPrisma.mobileCreationOutput.create).not.toHaveBeenCalled();
    expect(mockPrisma.mobileCreationDraft.update).not.toHaveBeenCalled();
    expect(enqueueGenerationJob).not.toHaveBeenCalled();
    await app.close();
  });

  it("refuses a free account's long book before planning is charged", async () => {
    mockAccessTokens({ "token-a": "user-a" });
    vi.mocked(getBookPageLimit).mockResolvedValue(30);
    const payload = buildPayloadAtTier("balanced");
    payload.selectedPresets.targetPages = 45;
    mockPrisma.mobileCreationDraft.findFirst.mockResolvedValueOnce(
      creationDraftRecord({ id: "session-draft", payload })
    );
    mockPrisma.template.findFirst.mockResolvedValue({ id: "template-workbook" });
    const app = await buildMobileApp({ advisorEnrichment: false, creationEnrichment: false });

    const response = await app.inject({
      method: "POST",
      url: "/api/mobile/creation-sessions/session-draft/build",
      headers: bearer("token-a"),
      payload: { requestId: "build-request-long" }
    });

    expect(response.statusCode).toBe(403);
    // The numbers survive the route's declared 403 schema: the app draws the
    // long-book offer from them.
    expect(response.json().error).toEqual({
      code: "PAGE_LIMIT_EXCEEDED",
      message: expect.stringContaining("30 pages"),
      pageLimit: { limit: 30, requestedPages: 45, maxPages: 200 }
    });
    expect(reserveCredits).not.toHaveBeenCalled();
    expect(mockPrisma.project.create).not.toHaveBeenCalled();
    expect(enqueueGenerationJob).not.toHaveBeenCalled();
    await app.close();
  });

  it("refuses any account a book past the 200-page ceiling, with a sentence and nothing to buy", async () => {
    mockAccessTokens({ "token-a": "user-a" });
    // A paid plan: no free-tier cap.
    vi.mocked(getBookPageLimit).mockResolvedValue(null);
    const payload = buildPayloadAtTier("balanced");
    payload.selectedPresets.targetPages = 250;
    mockPrisma.mobileCreationDraft.findFirst.mockResolvedValueOnce(
      creationDraftRecord({ id: "session-draft", payload })
    );
    mockPrisma.template.findFirst.mockResolvedValue({ id: "template-workbook" });
    const app = await buildMobileApp({ advisorEnrichment: false, creationEnrichment: false });

    const response = await app.inject({
      method: "POST",
      url: "/api/mobile/creation-sessions/session-draft/build",
      headers: bearer("token-a"),
      payload: { requestId: "build-request-too-long" }
    });

    expect(response.statusCode).toBe(403);
    expect(response.json().error).toEqual({
      code: "BOOK_LENGTH_UNAVAILABLE",
      message: "Books longer than 200 pages aren't available yet. Choose 200 pages or fewer.",
      pageLimit: { limit: 200, requestedPages: 250, maxPages: 200 }
    });
    expect(reserveCredits).not.toHaveBeenCalled();
    expect(mockPrisma.project.create).not.toHaveBeenCalled();
    await app.close();
  });

  it("does not create a draft project at Ultra while the operator has it off", async () => {
    mockAccessTokens({ "token-a": "user-a" });
    const app = await buildMobileApp();

    const response = await app.inject({
      method: "POST",
      url: "/api/mobile/projects",
      headers: bearer("token-a"),
      payload: {
        bookType: "lead_magnet",
        prompt: "Create a practical pricing guide for solo consultants.",
        lengthPreset: "standard",
        qualityPreset: "ultra",
        language: "en"
      }
    });

    expect(response.statusCode).toBe(422);
    expect(response.json().error.code).toBe("QUALITY_TIER_UNAVAILABLE");
    expect(mockPrisma.project.create).not.toHaveBeenCalled();
    await app.close();
  });

  it("refuses a new Ultra book while the operator has Ultra off, before the advisor or the charge", async () => {
    mockAccessTokens({ "token-a": "user-a" });
    const payload = buildPayloadAtTier("ultra");
    mockPrisma.mobileCreationDraft.findFirst.mockResolvedValue(creationDraftRecord({ id: "session-draft", payload }));
    mockPrisma.template.findFirst.mockResolvedValue({ id: "template-workbook" });
    const app = await buildMobileApp({ advisorEnrichment: false, creationEnrichment: false });

    for (const route of ["build", "preflight"]) {
      const response = await app.inject({
        method: "POST",
        url: `/api/mobile/creation-sessions/session-draft/${route}`,
        headers: bearer("token-a"),
        payload: { requestId: `build-request-ultra-${route}` }
      });
      expect(response.statusCode).toBe(422);
      expect(response.json()).toEqual({ error: { code: "QUALITY_TIER_UNAVAILABLE", message: ULTRA_TIER_UNAVAILABLE_MESSAGE } });
    }
    expect(reserveCredits).not.toHaveBeenCalled();
    expect(mockPrisma.project.create).not.toHaveBeenCalled();
    expect(enqueueGenerationJob).not.toHaveBeenCalled();
    await app.close();
  });

  it("builds a free account's book at exactly the page limit", async () => {
    mockAccessTokens({ "token-a": "user-a" });
    vi.mocked(getBookPageLimit).mockResolvedValue(30);
    const payload = buildPayloadAtTier("balanced");
    payload.selectedPresets.targetPages = 30;
    mockPrisma.mobileCreationDraft.findFirst.mockResolvedValueOnce(
      creationDraftRecord({ id: "session-draft", payload })
    );
    mockPrisma.template.findFirst.mockResolvedValue({ id: "template-workbook" });
    mockPrisma.project.create.mockImplementation(async ({ data }: { data: Record<string, any> }) =>
      projectRecord({ id: "project-from-session", targetPages: data.targetPages, mediaSettings: data.mediaSettings })
    );
    mockPrisma.mobileCreationDraft.update.mockImplementation(async ({ data }: { data: Record<string, unknown> }) =>
      creationDraftRecord({ id: "session-draft", payload, ...data })
    );
    vi.mocked(enqueueGenerationJob).mockResolvedValueOnce(jobRecord({ id: "job-plan-limit" }));
    const app = await buildMobileApp({ advisorEnrichment: false, creationEnrichment: false });

    const response = await app.inject({
      method: "POST",
      url: "/api/mobile/creation-sessions/session-draft/build",
      headers: bearer("token-a"),
      payload: { requestId: "build-request-at-limit" }
    });

    expect(response.statusCode).toBe(201);
    expect(mockPrisma.project.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ targetPages: 30 }) })
    );
    await app.close();
  });

  it("replays the same Build request without charging or creating twice", async () => {
    mockAccessTokens({ "token-a": "user-a" });
    const payload = buildPayloadAtTier("premium");
    const draft = creationDraftRecord({ id: "session-draft", payload });
    const project = projectRecord({ id: "project-from-session", mediaSettings: { modelTier: "premium" } });
    mockPrisma.mobileCreationDraft.findFirst.mockResolvedValue(draft);
    mockPrisma.template.findFirst.mockResolvedValue({ id: "template-workbook" });
    mockPrisma.project.create.mockResolvedValue(project);
    mockPrisma.project.findFirst.mockResolvedValue(project);
    mockPrisma.mobileCreationDraft.update.mockImplementation(async ({ data }: { data: Record<string, unknown> }) =>
      creationDraftRecord({ id: "session-draft", payload, ...data })
    );
    mockPrisma.mobileCreationOutput.findFirst.mockResolvedValue({
      id: "output-project-from-session",
      draftId: "session-draft",
      projectId: "project-from-session",
      requestId: "build-request-idempotent",
      title: project.title,
      sequence: 1,
      createdAt: new Date("2026-06-15T12:00:00.000Z"),
      updatedAt: new Date("2026-06-15T12:00:00.000Z"),
      project: { title: project.title, updatedAt: new Date("2026-06-15T12:00:00.000Z") }
    });
    vi.mocked(enqueueGenerationJob).mockResolvedValueOnce(jobRecord({ id: "job-plan" }));
    const app = await buildMobileApp({ advisorEnrichment: false, creationEnrichment: false });
    const request = {
      method: "POST" as const,
      url: "/api/mobile/creation-sessions/session-draft/build",
      headers: bearer("token-a"),
      payload: { requestId: "build-request-idempotent" }
    };

    const first = await app.inject(request);
    const replay = await app.inject(request);

    expect(first.statusCode).toBe(201);
    expect(replay.statusCode).toBe(201);
    expect(reserveCredits).toHaveBeenCalledTimes(1);
    expect(mockPrisma.project.create).toHaveBeenCalledTimes(1);
    expect(mockPrisma.mobileCreationOutput.create).toHaveBeenCalledTimes(1);
    expect(enqueueGenerationJob).toHaveBeenCalledTimes(1);
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

  it("prints a chat-captured byline on the project without repeating it as an instruction", async () => {
    mockAccessTokens({ "token-a": "user-a" });
    const payload = {
      payloadVersion: 3,
      rawIdea: "A fable about generosity",
      // What the chat's update_settings tool wrote via mergeCreationOptionalDetails.
      optionalDetails: { authorName: "Parsa Gh.", mustInclude: "", tone: "" },
      messages: [
        { role: "assistant", content: "Hi!" },
        { role: "user", content: "A fable about generosity, put my name Parsa Gh. on it" }
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

    expect(response.statusCode).toBe(201);
    // The structured field is what the cover (or coverless fallback title page) is typeset from.
    expect(createCall.data.authorName).toBe("Parsa Gh.");
    // "Must include: … Parsa Gh." is what once made the planner write the
    // byline into the premise, and a premise reaches every page call.
    expect(createCall.data.prompt).not.toMatch(/Must include:.*Parsa/);
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
        draftCandidates: 1,
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
        "bookShape",
        "bookType",
        "bookTypeChoice",
        "coverArtSource",
        "coverEnabled",
        "coverImage",
        "createdAt",
        "currentAction",
        "exports",
        "hasPlan",
        "id",
        "illustrationsEnabled",
        "imageCount",
        "imagesEnabled",
        "language",
        "lengthPreset",
        "manuscript",
        "pageCount",
        "pages",
        "plan",
        "progressPercent",
        "prompt",
        "promptPreview",
        "quality",
        "qualityPreset",
        "revisedFrom",
        "source",
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

  it("keeps fast, balanced, premium, and ultra preset mappings server-side", async () => {
    const { buildMobileCreateProjectInput } = await import("../mobileProjects.js");

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
    const ultra = buildMobileCreateProjectInput({
      bookType: "lead_magnet",
      prompt: "Create a polished lead magnet about packaging consulting offers with extra effort.",
      qualityPreset: "ultra",
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
    // Premium's value is the model tier; best-of drafting stays off because no
    // mobile length routes to the strategy that reads it — Ultra is the tier
    // that turns draftCandidates on for polish.
    expect(premium).toMatchObject({
      category: "BUSINESS",
      targetPages: 24,
      complexity: 6,
      temperature: 0.55,
      mediaSettings: expect.objectContaining({
        finalReview: true,
        draftCandidates: 1,
        modelTier: "premium"
      })
    });
    expect(ultra).toMatchObject({
      category: "BUSINESS",
      targetPages: 24,
      complexity: 7,
      temperature: 0.55,
      mediaSettings: expect.objectContaining({
        finalReview: true,
        draftCandidates: 2,
        modelTier: "ultra"
      })
    });
    expect((premium.mediaSettings as Record<string, unknown>).parallelPageGeneration).toBeUndefined();
    expect((ultra.mediaSettings as Record<string, unknown>).parallelPageGeneration).toBeUndefined();
    // Mobile inputs carry a tier name, never a concrete provider/model selection.
    expect(JSON.stringify({ fast, balanced, premium, ultra })).not.toMatch(/provider|textModel|imageModel/);
  });

  it("maps all four cover and in-book illustration combinations independently", async () => {
    const { buildMobileCreateProjectInput } = await import("../mobileProjects.js");
    const combinations = [
      { coverEnabled: true, illustrationsEnabled: true },
      { coverEnabled: true, illustrationsEnabled: false },
      { coverEnabled: false, illustrationsEnabled: true },
      { coverEnabled: false, illustrationsEnabled: false }
    ];

    for (const choice of combinations) {
      const input = buildMobileCreateProjectInput({
        bookType: "lead_magnet",
        prompt: "Create a practical guide to independent book image settings.",
        lengthPreset: "short",
        qualityPreset: "balanced",
        // Contradictory legacy input proves the exact fields have precedence.
        imagesEnabled: !choice.coverEnabled && !choice.illustrationsEnabled,
        ...choice
      });

      expect(input.mediaSettings).toMatchObject({
        includeCover: choice.coverEnabled,
        fullIllustrations: choice.illustrationsEnabled,
        illustrationCadence: choice.illustrationsEnabled ? "template-driven" : "manual",
        mobile: {
          coverEnabled: choice.coverEnabled,
          illustrationsEnabled: choice.illustrationsEnabled,
          imagesEnabled: choice.coverEnabled || choice.illustrationsEnabled
        }
      });
    }
  });

});
