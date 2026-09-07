import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@book-maker/db", async () => (await import("./testing/mobileApiMocks.js")).dbModuleMock());
vi.mock("@book-maker/db/billing", async () => (await import("./testing/mobileApiMocks.js")).billingModuleMock());
vi.mock("../queue.js", async () => (await import("./testing/mobileApiMocks.js")).queueModuleMock());
vi.mock("../projectStatus.js", async () => (await import("./testing/mobileApiMocks.js")).projectStatusModuleMock());
const { generateJson } = vi.hoisted(() => ({ generateJson: vi.fn() }));
vi.mock("../generationTextModelRouting.js", () => ({
  createLiveFastJudgmentsTextModel: () => ({ generateJson })
}));

import { adviseMobileBook, mobileCreationDraftPayloadSchema } from "../mobileCreation.js";
import { deterministicPageCountRecommendations } from "./projectRecords.js";
import { mobilePageCountRecommendationAiSchema } from "./schemas.js";
import {
  bearer, buildMobileApp, creationDraftRecord, creationPayload,
  mockAccessTokens, mockPrisma, resetMobileHarness, teardownMobileHarness
} from "./testing/mobileApiHarness.js";

const recommendations = [
  { targetPages: 8, label: "Concise", description: "A pricing checklist for consultants who need a quick decision.", isRecommended: true },
  { targetPages: 18, label: "Balanced", description: "Worked examples of starter offers alongside the checklist.", isRecommended: false },
  { targetPages: 32, label: "Expanded", description: "Multiple pricing scenarios and exercises for testing each offer.", isRecommended: false }
];

async function preflight(payload: unknown = creationPayload(), options: Record<string, unknown> = {}) {
  mockAccessTokens({ "token-a": "user-a" });
  mockPrisma.mobileCreationDraft.findFirst.mockResolvedValue(creationDraftRecord({ id: "session", payload }));
  const app = await buildMobileApp({ advisorEnrichment: false, creationEnrichment: false, ...options });
  try {
    const response = await app.inject({
      method: "POST", url: "/api/mobile/creation-sessions/session/preflight",
      headers: bearer("token-a"), payload: {}
    });
    expect(response.statusCode).toBe(200);
    expect(mockPrisma.project.create).not.toHaveBeenCalled();
    return response.json();
  } finally {
    await app.close();
  }
}

describe("page-count preflight", () => {
  beforeEach(() => {
    resetMobileHarness();
    generateJson.mockResolvedValue({ data: { recommendations } });
  });
  afterEach(() => {
    vi.useRealTimers();
    teardownMobileHarness();
  });

  it("sends the structured brief, selected preferences, source notes, and only the active conversation", async () => {
    const payload = {
      ...creationPayload({ selectedPresets: { bookTypeChoice: "practical_guide", lengthPreset: "expanded" } }),
      payloadVersion: 3,
      rawIdea: "A pricing guide",
      sourceNotes: "Source detail. ".repeat(100) + "Include the final pricing case.",
      optionalDetails: { mustInclude: "A rate calculator", tone: "direct" },
      conversationSummary: "Earlier we chose independent consultants.",
      messages: [
        { id: "root", parentId: null, role: "user", content: "Explain pricing for consultants." },
        { id: "old", parentId: "root", isActiveChild: false, role: "user", content: "Discarded branch" },
        { id: "current", parentId: "root", isActiveChild: true, role: "user", content: "Compare fixed fees and hourly rates." }
      ]
    };
    const body = await preflight(payload);
    expect(body.recommendations).toEqual(recommendations);
    expect(generateJson).toHaveBeenCalledOnce();
    const request = generateJson.mock.calls[0]![0];
    const context = JSON.parse(request.messages[1].content);
    expect(context).toMatchObject({
      brief: payload.brief, selectedBookType: "practical_guide", lengthPreference: "expanded",
      sourceNotes: payload.sourceNotes, optionalDetails: payload.optionalDetails,
      conversationSummary: payload.conversationSummary,
      chat: [
        { role: "user", content: "Explain pricing for consultants." },
        { role: "user", content: "Compare fixed fees and hourly rates." }
      ]
    });
    expect(request.messages[0].content).toContain("do not default to the middle");
    expect(request.messages[0].content).toContain("latest user requests in the active chat take priority");
    expect(context).not.toHaveProperty("fallback");
  });

  it.each([0, 1, 2])("accepts option %i as the single best fit and orders by count", async (index) => {
    const choices = recommendations.map((item, i) => ({ ...item, isRecommended: i === index }));
    generateJson.mockResolvedValue({ data: { recommendations: [...choices].reverse() } });
    const body = await preflight();
    expect(body.recommendations).toEqual(choices);
  });

  const invalidSets = [
    recommendations.map((item) => ({ ...item, isRecommended: false })),
    recommendations.map((item) => ({ ...item, isRecommended: true })),
    recommendations.map(({ isRecommended: _flag, ...item }) => item),
    [recommendations[0], recommendations[0], recommendations[2]],
    recommendations.slice(0, 2),
    [...recommendations, { ...recommendations[2], targetPages: 40 }],
    ...[0, 601, 2.5, "8", null].map((targetPages) => [{ ...recommendations[0], targetPages }, ...recommendations.slice(1)]),
    [{ ...recommendations[0], description: "" }, ...recommendations.slice(1)]
  ];
  it.each(invalidSets.map((items, index) => ({ items, index })))("falls back on invalid result $index", async ({ items }) => {
    expect(mobilePageCountRecommendationAiSchema.safeParse({ recommendations: items }).success).toBe(false);
    generateJson.mockResolvedValue({ data: { recommendations: items } });
    const body = await preflight();
    const payload = mobileCreationDraftPayloadSchema.parse(creationPayload());
    const advisor = await adviseMobileBook(payload);
    expect(body.recommendations).toEqual(deterministicPageCountRecommendations(payload, advisor));
    expect(mobilePageCountRecommendationAiSchema.safeParse({ recommendations: body.recommendations }).success).toBe(true);
  });

  it("keeps the default 2.5-second timeout and returns deterministic options", async () => {
    const started = new Promise<void>((resolve) => {
      generateJson.mockImplementation(() => {
        resolve();
        return new Promise(() => {});
      });
    });
    // Start real route setup before switching to fake time so Fastify can boot.
    const app = await buildMobileApp({ advisorEnrichment: false, creationEnrichment: false });
    mockAccessTokens({ "token-a": "user-a" });
    mockPrisma.mobileCreationDraft.findFirst.mockResolvedValue(creationDraftRecord());
    await app.ready();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    let settled = false;
    const response = app.inject({ method: "POST", url: "/api/mobile/creation-sessions/draft-1/preflight", headers: bearer("token-a"), payload: {} })
      .then((value) => { settled = true; return value; });
    await started;
    await vi.advanceTimersByTimeAsync(2499);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    const result = await response;
    expect(result.statusCode).toBe(200);
    const payload = mobileCreationDraftPayloadSchema.parse(creationPayload());
    const advisor = await adviseMobileBook(payload);
    expect(result.json().recommendations).toEqual(deterministicPageCountRecommendations(payload, advisor));
    await app.close();
  });

  it.each([
    { rawIdea: "Write a 37 page guide", source: "chat", pages: 37, presets: {} },
    { rawIdea: "یک کتاب ۳ صفحه ای بساز", source: "chat", pages: 3, presets: {} },
    { rawIdea: "Write a 37 page guide", source: "settings", pages: 55, presets: { pageCountMode: "custom", targetPages: 55 } }
  ])("skips generation for explicit $source pages: $pages", async ({ rawIdea, source, pages, presets }) => {
    const body = await preflight({ ...creationPayload({ selectedPresets: presets }), rawIdea });
    expect(body).toMatchObject({ requiresPageCount: false, detectedPageCount: { targetPages: pages, source }, recommendations: [] });
    expect(generateJson).not.toHaveBeenCalled();
  });

  it("uses distinct adult and children's story fallbacks and respects length preference", async () => {
    const results = [];
    for (const bookTypeChoice of ["children_story", "adult_story"]) {
      for (const lengthPreset of ["short", "standard", "expanded"]) {
        const payload = mobileCreationDraftPayloadSchema.parse(creationPayload({ brief: { mustInclude: "" }, selectedPresets: { bookType: "short_story", bookTypeChoice, lengthPreset } }));
        const advisor = await adviseMobileBook(payload);
        const choices = deterministicPageCountRecommendations(payload, advisor);
        expect(mobilePageCountRecommendationAiSchema.safeParse({ recommendations: choices }).success).toBe(true);
        expect(choices.findIndex((item) => item.isRecommended)).toBe(["short", "standard", "expanded"].indexOf(lengthPreset));
        results.push(choices.map((item) => item.targetPages));
      }
    }
    expect(results[0]).toEqual([4, 8, 12]);
    expect(results[3]).toEqual([12, 24, 48]);
  });

  it("gives detail and examples room even when generation times out and the saved preference is short", async () => {
    generateJson.mockImplementation(() => new Promise(() => {}));
    const body = await preflight({
      ...creationPayload(),
      payloadVersion: 3,
      rawIdea: "A pricing guide for consultants",
      messages: [
        { role: "user", content: "A pricing guide for consultants" },
        { role: "assistant", content: "We can make a compact guide." },
        { role: "user", content: "Make it more detailed and add examples." }
      ]
    }, { pageCountRecommendationTimeoutMs: 1 });
    const recommended = body.recommendations.find((item: { isRecommended: boolean }) => item.isRecommended);
    expect(recommended.targetPages).toBeGreaterThan(8);
    expect(recommended.description).toMatch(/detail|examples/);
  });

  it("does not shrink an expanded preference when the user asks for examples", async () => {
    generateJson.mockRejectedValue(new Error("unavailable"));
    const body = await preflight({
      ...creationPayload({ selectedPresets: { lengthPreset: "expanded" } }),
      messages: [{ role: "user", content: "Add examples" }]
    });
    expect(body.recommendations[2].isRecommended).toBe(true);
  });

  it("honors a later concise request even when source notes are long", async () => {
    generateJson.mockResolvedValue({ data: { recommendations: [] } });
    const body = await preflight({
      ...creationPayload(),
      sourceNotes: "Detailed reference. ".repeat(100),
      messages: [
        { role: "user", content: "Make it detailed with examples" },
        { role: "user", content: "Actually, keep it concise" }
      ]
    });
    expect(body.recommendations[0].isRecommended).toBe(true);
    expect(body.recommendations[0].description).toContain("keep the book concise");
  });

  it.each(["lead_magnet", "workbook", "short_story"])("keeps Auto fallback neutral despite the legacy %s field", async (bookType) => {
    generateJson.mockRejectedValue(new Error("unavailable"));
    const body = await preflight({
      payloadVersion: 3,
      rawIdea: "I have a proposal for a book and want to explore it.",
      messages: [{ role: "user", content: "I have a proposal for a book and want to explore it." }],
      selectedPresets: {
        bookType, bookTypeChoice: "auto", lengthPreset: "short", qualityPreset: "balanced"
      }
    });
    expect(JSON.stringify(body.recommendations)).not.toMatch(/adult|story|workbook|checklist|lessons/);
    expect(body.recommendations.map((item: { targetPages: number }) => item.targetPages)).toEqual([8, 12, 24]);
    const context = JSON.parse(generateJson.mock.calls[0]![0].messages[1].content);
    expect(context.selectedBookType).toBe("auto");
    expect(context.detectedLane).toBe("auto");
  });

  it("allows source scope to favor expanded coverage even with a short preference", async () => {
    const payload = mobileCreationDraftPayloadSchema.parse({ ...creationPayload({ brief: { mustInclude: "" } }), sourceNotes: "Detailed reference. ".repeat(100) });
    const advisor = await adviseMobileBook(payload);
    const choices = deterministicPageCountRecommendations(payload, advisor);
    expect(choices[2]?.isRecommended).toBe(true);
    expect(choices[2]?.description).toContain("source material");
  });
});
