import { beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  build: vi.fn(), plan: vi.fn(), find: vi.fn(), update: vi.fn(), sources: vi.fn(),
  config: { MOCK_AI: false }
}));
vi.mock("@book-maker/core", async (original) => ({ ...await original<object>(), buildChapterDossier: mocks.build, planEpisodes: mocks.plan }));
vi.mock("@book-maker/db", () => ({ prisma: { planVersion: { findUnique: mocks.find, updateMany: mocks.update, update: mocks.update }, researchSource: { createMany: mocks.sources } } }));
vi.mock("../runtime/config.js", () => ({ config: mocks.config }));
vi.mock("../runtime/jobLifecycle.js", () => ({ advanceJobStep: vi.fn() }));

import { FakeTextModelAdapter, makeFallbackPlan, chapterEpisodeSchema, dossierExcerptSchema, QUALITY_FEATURE_DEFAULTS, type CreateProjectInput } from "@book-maker/core";
import { prepareBookMaterial } from "./composedChaptersMaterial.js";

const input = { prompt: "Explain public-key cryptography", category: "SCIENCE", targetPages: 20, complexity: 5, temperature: 0.4, language: "en", mediaSettings: { fullIllustrations: false, illustrationCadence: "manual", includeCover: false, coverTemplate: "auto", finalReview: true, toneProfile: "neutral" } } as CreateProjectInput;
const base = makeFallbackPlan(input);
const chapter = base.chapters[0]!;
const episode = chapterEpisodeSchema.parse({ title: "RSA", searchQueries: ["RSA original paper", "RSA MIT public key"] });
const episodes = { chapters: [{ index: chapter.index, episodes: [episode] }] };
const excerpt = dossierExcerptSchema.parse({ id: "x1", chapterIndex: chapter.index, episodeTitle: "RSA", documentTitle: "RSA paper", documentUrl: "https://example.org/rsa", text: "An original passage supporting modular exponentiation.", provenanceVerified: true });
const searchSources = vi.fn(async () => []);
const quality = { tier: "balanced", settings: QUALITY_FEATURE_DEFAULTS, pageReviewPromptMode: "normal", enabled: () => false } as Parameters<typeof prepareBookMaterial>[0]["quality"];
const options = { projectId: "p", planId: "v", input, plan: { ...base, chapters: [chapter], episodes }, stance: { thesis: "Public keys enable private communication.", positions: [], refusals: [], voiceSample: "" }, textModel: new FakeTextModelAdapter(input), quality, searchSources };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.config.MOCK_AI = false;
  mocks.find.mockResolvedValue({ planningPackage: options.plan });
  mocks.update.mockResolvedValue({ count: 1 });
  mocks.plan.mockResolvedValue({ episodes });
  mocks.build.mockResolvedValue({ documents: [], excerpts: [excerpt] });
});

it.each(["fast", "balanced", "premium", "ultra"] as const)("gathers factual passages in %s through the existing search provider with experiment gates off", async (tier) => {
  const result = await prepareBookMaterial({ ...options, quality: { ...quality, tier } });
  expect(mocks.build).toHaveBeenCalledWith(expect.objectContaining({ searchSources, evidence: true }));
  expect(result.dossier?.excerpts[0]?.text).toBe(excerpt.text);
});

it("replaces a legacy empty dossier rather than treating its valid JSON as sufficient evidence", async () => {
  const plan = { ...options.plan, dossier: { excerpts: [], documents: [] } };
  mocks.find.mockResolvedValue({ planningPackage: plan });
  const result = await prepareBookMaterial({ ...options, plan });
  expect(mocks.build).toHaveBeenCalled();
  expect(result.dossier?.excerpts).toHaveLength(1);
  expect(mocks.update).toHaveBeenCalled();
});

it("bounds an empty retrieval, records the gap and does not repeat it on every resume", async () => {
  mocks.build.mockResolvedValue({ documents: [], excerpts: [] });
  const result = await prepareBookMaterial(options);
  expect(mocks.build).toHaveBeenCalledTimes(2);
  expect(result.dossier?.researchGaps).toEqual([expect.objectContaining({ chapterIndex: chapter.index })]);
  mocks.build.mockClear();
  await prepareBookMaterial({ ...options, plan: { ...options.plan, dossier: result.dossier! } });
  expect(mocks.build).not.toHaveBeenCalled();
});
