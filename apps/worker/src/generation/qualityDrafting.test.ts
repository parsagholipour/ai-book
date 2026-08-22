import { beforeEach, describe, expect, it, vi } from "vitest";
import { bestOfCandidateTemperatures } from "@book-maker/core";
import type { BookPlan, CreateProjectInput, PageDraft, PolishPageOptions, ProviderSet } from "@book-maker/core";

const mocks = vi.hoisted(() => ({
  generateBestOfPageDrafts: vi.fn(),
  loadQualityContext: vi.fn(),
  applyPlanThinkingBoost: vi.fn()
}));

vi.mock("@book-maker/db", () => ({ prisma: {}, Prisma: {} }));
vi.mock("./qualitySettings.js", () => ({
  loadQualityContext: mocks.loadQualityContext,
  applyPlanThinkingBoost: mocks.applyPlanThinkingBoost
}));
vi.mock("@book-maker/core", async () => {
  const actual = await vi.importActual<typeof import("@book-maker/core")>("@book-maker/core");
  return {
    ...actual,
    generateBestOfPageDrafts: mocks.generateBestOfPageDrafts
  };
});

import { polishPageWithQualityGates } from "./qualityDrafting.js";

const inputWithCandidates = (draftCandidates: number, modelTier?: "fast" | "balanced" | "premium" | "ultra"): CreateProjectInput => ({
  prompt: "A story about Jack.",
  category: "STORY",
  targetPages: 8,
  complexity: 5,
  temperature: 0.8,
  language: "en",
  mediaSettings: {
    fullIllustrations: false,
    illustrationCadence: "template-driven",
    includeCover: true,
    coverTemplate: "auto",
    finalReview: true,
    draftCandidates,
    toneProfile: "neutral" as const,
    ...(modelTier ? { modelTier } : {})
  }
});

const draft: PageDraft = {
  title: "The Door Opens",
  markdown: "Jack stepped through.",
  summary: "Jack enters.",
  continuityNotes: []
};

const stubPlan = { title: "Test", premise: "A tale.", chapters: [] } as unknown as BookPlan;

function polishOptions(input: CreateProjectInput, pageIndex = 1): PolishPageOptions {
  return {
    input,
    plan: stubPlan,
    pageIndex,
    draft,
    previousPages: [],
    nextPages: [],
    continuityNotes: [],
    researchNotes: [],
    textModel: {} as PolishPageOptions["textModel"]
  };
}

describe("polishPageWithQualityGates", () => {
  const polishPageDraft = vi.fn(async () => draft);

  // The wiring, not the helper. `polishBestOfBaseTemperature` is pinned in
  // core's own suite; what only this seam can catch is the handler forgetting
  // to pass its answer through. Deleting the baseOptions override used to fail
  // nothing, and the symptom was invisible: every candidate polished at exactly
  // the ceiling, so the extra call and its judge bought sampling noise.
  it("lowers the best-of base so page 1's candidates land inside the polish ceiling", async () => {
    const input = inputWithCandidates(1, "balanced");
    mocks.loadQualityContext.mockResolvedValue({
      settings: {},
      tier: "balanced",
      enabled: () => false
    });

    await polishPageWithQualityGates({
      polishPageDraft,
      polishOptions: polishOptions(input, 1),
      providers: { text: {} } as ProviderSet,
      input
    });

    const call = mocks.generateBestOfPageDrafts.mock.calls[0]?.[0] as {
      candidateCount: number;
      baseOptions: PolishPageOptions;
    };
    expect(call.candidateCount).toBe(2);

    // Balanced's page 1 draws two candidates, staggered downward from the
    // temperature a candidate-free polish runs at. Read the ladder rather than
    // restating it: the top rung must be that temperature exactly — so no book
    // that skips best-of moves — and every rung must be distinct.
    const ladder = bestOfCandidateTemperatures(call.baseOptions.input.temperature, call.candidateCount);
    expect(Math.max(...ladder)).toBeCloseTo(0.65, 10);
    expect(new Set(ladder).size).toBe(call.candidateCount);
    expect(Math.min(...ladder)).toBeLessThan(0.65);
  });


  beforeEach(() => {
    vi.clearAllMocks();
    polishPageDraft.mockResolvedValue(draft);
    mocks.generateBestOfPageDrafts.mockResolvedValue(draft);
  });

  it("does not best-of polish when bestOfPolish is off, even if draftCandidates is 2", async () => {
    const input = inputWithCandidates(2);
    mocks.loadQualityContext.mockResolvedValue({
      settings: {},
      tier: "balanced",
      enabled: () => false
    });

    await polishPageWithQualityGates({
      polishPageDraft,
      // Page 2, not page 1: the first page best-ofs by tier on its own, and
      // this test is about the operator draftCandidates gate.
      polishOptions: polishOptions(input, 2),
      providers: { text: {} } as ProviderSet,
      input
    });

    expect(polishPageDraft).toHaveBeenCalledOnce();
    expect(mocks.generateBestOfPageDrafts).not.toHaveBeenCalled();
  });

  it("best-ofs the balanced tier's first page even when bestOfPolish is off", async () => {
    const input = inputWithCandidates(1);
    mocks.loadQualityContext.mockResolvedValue({
      settings: {},
      tier: "balanced",
      enabled: () => false
    });

    await polishPageWithQualityGates({
      polishPageDraft,
      polishOptions: polishOptions(input, 1),
      providers: { text: {} } as ProviderSet,
      input
    });

    expect(mocks.generateBestOfPageDrafts).toHaveBeenCalledWith(
      expect.objectContaining({ candidateCount: 2 })
    );
    expect(polishPageDraft).not.toHaveBeenCalled();
  });

  it("keeps the fast tier's first page at a single draft", async () => {
    const input = inputWithCandidates(1, "fast");
    mocks.loadQualityContext.mockResolvedValue({
      settings: {},
      tier: "fast",
      enabled: () => false
    });

    await polishPageWithQualityGates({
      polishPageDraft,
      polishOptions: polishOptions(input, 1),
      providers: { text: {} } as ProviderSet,
      input
    });

    expect(polishPageDraft).toHaveBeenCalledOnce();
    expect(mocks.generateBestOfPageDrafts).not.toHaveBeenCalled();
  });

  it("best-ofs polish when bestOfPolish is on and draftCandidates is 2", async () => {
    const input = inputWithCandidates(2, "ultra");
    mocks.loadQualityContext.mockResolvedValue({
      settings: {},
      tier: "ultra",
      enabled: (feature: string) => feature === "bestOfPolish"
    });

    await polishPageWithQualityGates({
      polishPageDraft,
      // Page 2, not page 1: the first page best-ofs by tier whatever the
      // operator set, so on page 1 this count would prove nothing.
      polishOptions: polishOptions(input, 2),
      providers: { text: {} } as ProviderSet,
      input
    });

    expect(mocks.generateBestOfPageDrafts).toHaveBeenCalledWith(
      expect.objectContaining({ candidateCount: 2 })
    );
    expect(polishPageDraft).not.toHaveBeenCalled();
  });

  it("lets draftCandidates outbid the tier gate on the first page", async () => {
    const input = inputWithCandidates(3);
    mocks.loadQualityContext.mockResolvedValue({
      settings: {},
      tier: "balanced",
      enabled: (feature: string) => feature === "bestOfPolish"
    });

    await polishPageWithQualityGates({
      polishPageDraft,
      polishOptions: polishOptions(input, 1),
      providers: { text: {} } as ProviderSet,
      input
    });

    // Both gates are live on page 1: `Math.max` of the operator's 3 and the
    // balanced tier's 2.
    expect(mocks.generateBestOfPageDrafts).toHaveBeenCalledWith(
      expect.objectContaining({ candidateCount: 3 })
    );
  });

  it("never multiplies the two gates on an ultra first page", async () => {
    const input = inputWithCandidates(2, "ultra");
    mocks.loadQualityContext.mockResolvedValue({
      settings: {},
      tier: "ultra",
      enabled: (feature: string) => feature === "bestOfPolish"
    });

    await polishPageWithQualityGates({
      polishPageDraft,
      polishOptions: polishOptions(input, 1),
      providers: { text: {} } as ProviderSet,
      input
    });

    // The tier's 3 wins over the operator's 2; the two are never 2 × 3.
    expect(mocks.generateBestOfPageDrafts).toHaveBeenCalledWith(
      expect.objectContaining({ candidateCount: 3 })
    );
  });
});
