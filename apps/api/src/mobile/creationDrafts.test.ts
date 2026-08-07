import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@book-maker/db", async () => (await import("./testing/mobileApiMocks.js")).dbModuleMock());
vi.mock("@book-maker/db/billing", async () => (await import("./testing/mobileApiMocks.js")).billingModuleMock());
vi.mock("../queue.js", async () => (await import("./testing/mobileApiMocks.js")).queueModuleMock());
vi.mock("../projectStatus.js", async () => (await import("./testing/mobileApiMocks.js")).projectStatusModuleMock());

import { reserveCredits } from "@book-maker/db/billing";

import { enqueueGenerationJob } from "../queue.js";
import {
  bearer,
  buildMobileApp,
  creationDraftRecord,
  creationPayload,
  jobRecord,
  mockAccessTokens,
  mockPrisma,
  projectRecord,
  resetMobileHarness,
  teardownMobileHarness
} from "./testing/mobileApiHarness.js";

describe("mobile creation drafts and advisor", () => {
  beforeEach(resetMobileHarness);
  afterEach(teardownMobileHarness);

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

  it("preserves split image settings when a legacy draft client echoes the unchanged aggregate", async () => {
    mockAccessTokens({ "token-a": "user-a" });
    const storedPayload = creationPayload({
      selectedPresets: {
        imagesEnabled: true,
        coverEnabled: true,
        illustrationsEnabled: false
      }
    });
    mockPrisma.mobileCreationDraft.findFirst.mockResolvedValueOnce(
      creationDraftRecord({ id: "draft-cover-only", payload: storedPayload })
    );
    mockPrisma.mobileCreationDraft.update.mockImplementation(async ({ data }: { data: Record<string, unknown> }) =>
      creationDraftRecord({ id: "draft-cover-only", payload: data.payload })
    );
    const app = await buildMobileApp();

    const response = await app.inject({
      method: "PATCH",
      url: "/api/mobile/creation-drafts/draft-cover-only",
      headers: bearer("token-a"),
      payload: creationPayload({ selectedPresets: { imagesEnabled: true } })
    });
    const updateCall = mockPrisma.mobileCreationDraft.update.mock.calls.at(0)?.[0] as {
      data: { payload: Record<string, any> };
    };

    expect(response.statusCode).toBe(200);
    expect(updateCall.data.payload.selectedPresets).toMatchObject({
      imagesEnabled: true,
      coverEnabled: true,
      illustrationsEnabled: false
    });
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

  it("does not ask again for a length the user already stated in their own script", async () => {
    mockAccessTokens({ "token-a": "user-a" });
    const idea = "یک کتاب ۳ صفحه ای بساز از بهترین حکایت بوستان سعدی با توضیحات";
    const payload = {
      payloadVersion: 3,
      rawIdea: idea,
      language: "fa",
      messages: [
        { role: "assistant", content: "Hi!" },
        { role: "user", content: idea }
      ],
      selectedPresets: {
        bookType: "lead_magnet",
        bookTypeChoice: "auto",
        lengthPreset: "short",
        qualityPreset: "balanced",
        imagesEnabled: true,
        pageCountMode: "auto"
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

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      requiresPageCount: false,
      detectedPageCount: { targetPages: 3, source: "chat" }
    });
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

});
