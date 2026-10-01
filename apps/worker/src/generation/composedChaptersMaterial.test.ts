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

it("hands the settled episodes to the form plan before any source is gathered", async () => {
  const order: string[] = [];
  mocks.build.mockImplementation(async () => {
    order.push("dossier");
    return { documents: [], excerpts: [excerpt] };
  });
  await prepareBookMaterial({ ...options, onEpisodes: (planned) => order.push(`episodes ${planned?.chapters.length}`) });
  expect(order).toEqual(["episodes 1", "dossier"]);
});

it("gathers the evidence dossier with the claim review off, and lets creativeContract choose the contract", async () => {
  // Quick Draft without the dossier lost 6 of 6 blind readings (2026-09-30).
  const creative = { ...quality, tier: "fast", enabled: (feature: string) => feature === "creativeContract" } as typeof quality;
  const result = await prepareBookMaterial({ ...options, quality: creative });
  expect(mocks.build).toHaveBeenCalledWith(expect.objectContaining({ evidence: true }));
  expect(result.contract).toBe("creative");
  expect((await prepareBookMaterial(options)).contract).toBe("grounded");
});

it("gathers nothing for a book its stance says is not written from sources, on any tier and under materialFirst", async () => {
  // A novel, or a fable filed under a nonfiction category: no episodes, no dossier.
  const everyGate = { ...quality, enabled: () => true } as typeof quality;
  const novel = { ...options, plan: { ...base, chapters: [chapter] }, stance: { ...options.stance, research: "none" as const }, quality: everyGate };
  const result = await prepareBookMaterial(novel);
  expect(result).toEqual({ contract: "creative", episodes: undefined, dossier: undefined });
  expect(mocks.plan).not.toHaveBeenCalled();
  expect(mocks.build).not.toHaveBeenCalled();
});

it("gathers for a true story the stance says is written from sources, whatever its category", async () => {
  const story = { ...input, category: "STORY", prompt: "The true story of the Apollo 13 rescue" } as CreateProjectInput;
  const plan = { ...makeFallbackPlan(story), chapters: [chapter] };
  await prepareBookMaterial({ ...options, input: story, plan, stance: { ...options.stance, research: "sources" as const } });
  expect(mocks.plan).toHaveBeenCalledWith(expect.objectContaining({ evidenceRequired: true }));
  expect(mocks.build).toHaveBeenCalledWith(expect.objectContaining({ evidence: true }));
  // The same book with a stance that did not say falls back to its writing mode: a story gathers nothing.
  vi.clearAllMocks();
  await prepareBookMaterial({ ...options, input: story, plan });
  expect(mocks.plan).not.toHaveBeenCalled();
  expect(mocks.build).not.toHaveBeenCalled();
});

it("keeps composing from episodes an earlier run stored when a regenerated stance changes its mind", async () => {
  const result = await prepareBookMaterial({ ...options, stance: { ...options.stance, research: "none" as const } });
  expect(result.episodes).toEqual(episodes);
  expect(mocks.plan).not.toHaveBeenCalled();
  expect(mocks.build).not.toHaveBeenCalled();
});

it.each([[false, 3], [true, 6]] as const)("gathers chapters' sources %s-wide: at most %i at once", async (wide, most) => {
  const chapters = Array.from({ length: 8 }, (_, offset) => ({ ...chapter, index: offset + 1, title: `Chapter ${offset + 1}` }));
  const plan = { ...base, chapters, episodes: { chapters: chapters.map((entry) => ({ index: entry.index, episodes: [episode] })) } };
  mocks.find.mockResolvedValue({ planningPackage: plan });
  let inFlight = 0;
  let peak = 0;
  mocks.build.mockImplementation(async () => {
    inFlight += 1;
    peak = Math.max(peak, inFlight);
    await new Promise((resolve) => setTimeout(resolve, 3));
    inFlight -= 1;
    return { documents: [], excerpts: [excerpt] };
  });
  const gates = { ...quality, enabled: (feature: string) => wide && feature === "wideSourceGathering" } as typeof quality;
  await prepareBookMaterial({ ...options, plan, quality: gates });
  expect(peak).toBe(most);
});
