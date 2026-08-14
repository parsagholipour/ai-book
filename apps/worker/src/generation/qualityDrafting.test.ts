import { beforeEach, describe, expect, it, vi } from "vitest";
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

const inputWithCandidates = (draftCandidates: number): CreateProjectInput => ({
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
    toneProfile: "neutral" as const
  }
});

const draft: PageDraft = {
  title: "The Door Opens",
  markdown: "Jack stepped through.",
  summary: "Jack enters.",
  continuityNotes: []
};

const stubPlan = { title: "Test", premise: "A tale.", chapters: [] } as unknown as BookPlan;

function polishOptions(input: CreateProjectInput): PolishPageOptions {
  return {
    input,
    plan: stubPlan,
    pageIndex: 1,
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
      polishOptions: polishOptions(input),
      providers: { text: {} } as ProviderSet,
      input
    });

    expect(polishPageDraft).toHaveBeenCalledOnce();
    expect(mocks.generateBestOfPageDrafts).not.toHaveBeenCalled();
  });

  it("best-ofs polish when bestOfPolish is on and draftCandidates is 2", async () => {
    const input = inputWithCandidates(2);
    mocks.loadQualityContext.mockResolvedValue({
      settings: {},
      tier: "ultra",
      enabled: (feature: string) => feature === "bestOfPolish"
    });

    await polishPageWithQualityGates({
      polishPageDraft,
      polishOptions: polishOptions(input),
      providers: { text: {} } as ProviderSet,
      input
    });

    expect(mocks.generateBestOfPageDrafts).toHaveBeenCalledWith(
      expect.objectContaining({ candidateCount: 2 })
    );
    expect(polishPageDraft).not.toHaveBeenCalled();
  });
});
