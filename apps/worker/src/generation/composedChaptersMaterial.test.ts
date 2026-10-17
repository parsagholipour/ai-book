import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  build: vi.fn(), plan: vi.fn(), find: vi.fn(), update: vi.fn(), sources: vi.fn(),
  config: { MOCK_AI: false }
}));
vi.mock("@book-maker/core", async (original) => ({ ...await original<object>(), buildChapterDossier: mocks.build, planEpisodes: mocks.plan }));
vi.mock("@book-maker/db", () => ({ prisma: { planVersion: { findUnique: mocks.find, updateMany: mocks.update, update: mocks.update }, researchSource: { createMany: mocks.sources } } }));
vi.mock("../runtime/config.js", () => ({ config: mocks.config }));
vi.mock("../runtime/jobLifecycle.js", () => ({ advanceJobStep: vi.fn() }));

import { FakeTextModelAdapter, makeFallbackPlan, chapterEpisodeSchema, dossierExcerptSchema, QUALITY_FEATURE_DEFAULTS, type CreateProjectInput } from "@book-maker/core";
import { prepareBookMaterial, startBookMaterial } from "./composedChaptersMaterial.js";

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

describe("lead notes", () => {
  // H3b (2026-10-16): the lead search's answer is the chapter's research note, and chapter-research is owed
  // only by a chapter with no planned leads.
  const second = { ...chapter, index: chapter.index + 1, title: "A chapter the planner gave no leads" };
  const plan = { ...base, chapters: [chapter, second], researchQueries: ["An open question no chapter restates"], episodes: { chapters: [{ index: chapter.index, episodes: [episode] }, { index: second.index, episodes: [] }] } };
  const answer = (query: string) => ({ query, summary: `What the documents say about ${query}, at https://example.org/x.`, sources: [{ title: "example.org", url: `https://example.org/${encodeURIComponent(query)}`, summary: "A cited passage." }] });

  beforeEach(() => {
    mocks.find.mockResolvedValue({ planningPackage: plan });
    mocks.build.mockImplementation(async (built: { episodes: Array<{ searchQueries: string[] }>; searchSources?: (query: string) => Promise<unknown> }) => {
      for (const entry of built.episodes) await built.searchSources?.(entry.searchQueries[0]!);
      return { documents: [], excerpts: [excerpt] };
    });
  });

  it("keeps each lead's answer as its chapter's note, written with the dossier, and owes research only where no lead answered", async () => {
    const order: string[] = [];
    const leadResearch = vi.fn(async (query: string) => answer(query));
    const onResearchScope = vi.fn(() => { order.push("scope"); });
    mocks.build.mockImplementationOnce(async (built: { episodes: Array<{ searchQueries: string[] }>; searchSources?: (query: string) => Promise<unknown> }) => {
      order.push("dossier");
      for (const entry of built.episodes) await built.searchSources?.(entry.searchQueries[0]!);
      return { documents: [], excerpts: [excerpt] };
    });
    await prepareBookMaterial({ ...options, plan, leadResearch, onResearchScope });
    expect(order[0]).toBe("scope");
    expect(onResearchScope).toHaveBeenCalledOnce();
    expect(onResearchScope).toHaveBeenCalledWith({ chapterIndexes: [second.index], researchQueries: plan.researchQueries });
    expect(searchSources).not.toHaveBeenCalled();
    expect(leadResearch).toHaveBeenCalledWith("RSA original paper");
    const rows = mocks.sources.mock.calls[0]![0].data as Array<{ query: string; title: string; url: string | null; summary: string }>;
    const brief = rows.find((row) => row.title === "Research brief" && row.query.startsWith(`${chapter.title}: `))!;
    expect(brief).toMatchObject({ url: null, summary: "RSA: What the documents say about RSA original paper, at" });
    expect(rows.some((row) => row.url === "https://example.org/RSA%20original%20paper" && row.query === brief.query)).toBe(true);
  });

  it("leaves the whole expansion owing without a lead search, or when nothing is persisted", async () => {
    const onResearchScope = vi.fn();
    await prepareBookMaterial({ ...options, plan, onResearchScope });
    await prepareBookMaterial({ ...options, plan, persist: false, leadResearch: async (query) => answer(query), onResearchScope });
    expect(onResearchScope.mock.calls).toEqual([[undefined], [undefined]]);
    // Neither run has a row to write: no lead notes, and the dossier fetched no document.
    expect(mocks.sources).not.toHaveBeenCalled();
  });

  it("keeps a truncated answer's sources and drops its text", async () => {
    await prepareBookMaterial({ ...options, plan, leadResearch: async (query) => ({ ...answer(query), truncated: true }), onResearchScope: vi.fn() });
    const rows = mocks.sources.mock.calls[0]![0].data as Array<{ title: string; url: string | null }>;
    expect(rows.some((row) => row.title === "Research brief")).toBe(false);
    expect(rows.filter((row) => row.url?.startsWith("https://example.org/"))).not.toHaveLength(0);
  });

  it("scopes nothing on a resume whose dossier is stored: its lead notes were written with it", async () => {
    const onResearchScope = vi.fn();
    const leadResearch = vi.fn(async (query: string) => answer(query));
    const stored = { ...plan, dossier: { excerpts: [excerpt, { ...excerpt, id: "x2", chapterIndex: second.index }], documents: [], researchedChapters: [chapter.index, second.index] } };
    await prepareBookMaterial({ ...options, plan: stored, leadResearch, onResearchScope });
    expect(leadResearch).not.toHaveBeenCalled();
    expect(onResearchScope).toHaveBeenCalledWith(undefined);
  });
});

describe("per-chapter readiness (harness redesign H4)", () => {
  const chapters = [1, 2, 3].map((index) => ({ ...chapter, index, title: `Chapter ${index}` }));
  const plan = { ...base, chapters, episodes: { chapters: chapters.map((entry) => ({ index: entry.index, episodes: [{ ...episode, title: `Case ${entry.index}` }] })) } };

  it("hands each chapter its own dossier the moment its retrieval settles, and stores the whole one once every chapter's has", async () => {
    mocks.find.mockResolvedValue({ planningPackage: plan });
    const gates = new Map<number, () => void>();
    mocks.build.mockImplementation(async (built: { chapter: { index: number } }) => {
      await new Promise<void>((resolve) => gates.set(built.chapter.index, resolve));
      return { documents: [], excerpts: [{ ...excerpt, id: `x${built.chapter.index}`, chapterIndex: built.chapter.index, text: `${excerpt.text} (${built.chapter.index})` }] };
    });
    const started = await startBookMaterial({ ...options, plan });
    await vi.waitFor(() => expect(gates.size).toBe(3));
    let whole = false;
    void started.whole.then(() => { whole = true; });
    gates.get(2)!();
    const second = await started.dossierFor(2);
    expect(second?.excerpts.filter((entry) => entry.chapterIndex === 2)).toHaveLength(1);
    expect(whole).toBe(false);
    expect(mocks.update).not.toHaveBeenCalled();
    gates.get(1)!();
    gates.get(3)!();
    const stored = await started.whole;
    // The view a chapter composed from is exactly the whole dossier's entries for that chapter.
    for (const index of [1, 2, 3]) {
      expect((await started.dossierFor(index))?.excerpts.filter((entry) => entry.chapterIndex === index))
        .toEqual(stored?.excerpts.filter((entry) => entry.chapterIndex === index));
    }
    expect(mocks.update).toHaveBeenCalledOnce();
    expect(started.pendingRows()).toEqual([]);
  });

  it("fails a chapter still waiting with the gathering that failed, never leaving it waiting", async () => {
    mocks.find.mockResolvedValue({ planningPackage: plan });
    mocks.build.mockImplementation(async (built: { chapter: { index: number } }) => {
      if (built.chapter.index === 1) throw new Error("Stopped by user");
      await new Promise(() => undefined);
      return { documents: [], excerpts: [] };
    });
    const started = await startBookMaterial({ ...options, plan, quality: { ...quality, enabled: () => false } });
    await expect(started.dossierFor(1)).rejects.toThrow("Stopped by user");
    await expect(started.whole).rejects.toThrow("Stopped by user");
  });
});
