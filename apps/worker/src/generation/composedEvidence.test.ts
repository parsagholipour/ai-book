import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ build: vi.fn(), retrieve: vi.fn(), episodes: vi.fn(), fetch: vi.fn() }));
vi.mock("@book-maker/core", async (original) => ({ ...await original<object>(), buildCaseEvidence: mocks.build, buildChapterDossier: mocks.retrieve, planEpisodes: mocks.episodes }));
vi.mock("./composedChaptersMaterial.js", () => ({ primarySourceFetch: mocks.fetch }));

import { FakeTextModelAdapter, makeFallbackPlan, caseEvidencePacketSchema, type CreateProjectInput } from "@book-maker/core";
import { prepareVerifiedCases } from "./composedEvidence.js";
const input = { prompt: "Legal evidence", category: "EDUCATION", targetPages: 12, complexity: 3, temperature: 0.4, language: "en", mediaSettings: { fullIllustrations: false, illustrationCadence: "manual", includeCover: false, coverTemplate: "auto", finalReview: true, toneProfile: "neutral" } } as CreateProjectInput;
const plan = { ...makeFallbackPlan(input), chapters: [{ index: 1, title: "Trial", summary: "The finding", keyBeats: ["Verdict"], targetPages: 12 }] };
const packet = caseEvidencePacketSchema.parse({
  id: "case-1-1", sourceChapterIndex: 1, reviewVersion: 1, episode: { title: "Test trial", document: "Test record" },
  claims: [{ id: "a", text: "First verdict", kind: "event", excerptIds: ["e"] }, { id: "b", text: "New trial", kind: "event", excerptIds: ["e"] }],
  sequence: ["a", "b"], disagreements: [], unknowns: ["Dialogue absent"],
  excerpts: [{ id: "e", chapterIndex: 1, episodeTitle: "Test trial", documentTitle: "Test record", documentUrl: "https://example.org/test", text: "A test record of the initial finding and later appeal." }]
});
const options = {
  input, plan, stance: { thesis: "Verdicts can change", positions: [], refusals: [], voiceSample: "The finding changed." },
  episodes: { chapters: [{ index: 1, episodes: [packet.episode] }] },
  dossier: { excerpts: packet.excerpts, documents: [] }, textModel: new FakeTextModelAdapter(input)
};
beforeEach(() => {
  vi.clearAllMocks();
  mocks.build.mockResolvedValue({ failure: "no retrieved support" });
  mocks.retrieve.mockResolvedValue({ excerpts: packet.excerpts, documents: [] });
  mocks.episodes.mockResolvedValue({ episodes: options.episodes });
});

describe("bounded evidence recovery", () => {
  it("keeps verified cases and removes unsupported candidates from writer material", async () => {
    mocks.build.mockResolvedValueOnce({ packet });
    const result = await prepareVerifiedCases({ ...options, episodes: { chapters: [{ index: 1, episodes: [packet.episode, { ...packet.episode, title: "Unsupported second case" }] }] } });
    expect(result.episodes.chapters[0]!.episodes).toEqual([packet.episode]);
    expect(result.dossier.evidencePackets).toEqual([packet]);
    expect(result.dossier.excludedCases).toEqual([{ chapterIndex: 1, title: "Unsupported second case", reason: "no retrieved support" }]);
    expect(mocks.retrieve).not.toHaveBeenCalled();
  });

  it("tries the next query before asking for a replacement case", async () => {
    mocks.build.mockResolvedValueOnce({ failure: "missing passage" }).mockResolvedValueOnce({ packet });
    const result = await prepareVerifiedCases(options);
    expect(result.dossier.evidencePackets).toHaveLength(1);
    expect(mocks.retrieve).toHaveBeenCalledWith(expect.objectContaining({ queryOffset: 1, evidence: true }));
    expect(mocks.episodes).not.toHaveBeenCalled();
  });

  it("passes failure reasons to a bounded replacement search and fails closed if it also lacks support", async () => {
    await expect(prepareVerifiedCases(options)).rejects.toThrow("insufficient for chapters 1");
    expect(mocks.retrieve).toHaveBeenCalledTimes(2);
    expect(mocks.episodes).toHaveBeenCalledOnce();
    expect(mocks.episodes).toHaveBeenCalledWith(expect.objectContaining({ feedback: expect.arrayContaining(["Test trial: no retrieved support"]) }));
    expect(mocks.build).toHaveBeenCalledTimes(3);
  });

  it("propagates a stopped run immediately", async () => {
    mocks.build.mockRejectedValueOnce(new Error("User requested stop"));
    await expect(prepareVerifiedCases(options)).rejects.toThrow("User requested stop");
    expect(mocks.retrieve).not.toHaveBeenCalled();
    expect(mocks.episodes).not.toHaveBeenCalled();
  });

  it("returns research gaps to the book planner instead of demanding one case for every old chapter", async () => {
    mocks.build.mockResolvedValueOnce({ packet });
    const original = { ...plan, chapters: [
      { ...plan.chapters[0]!, targetPages: 6 },
      { index: 2, title: "What the result means", summary: "Synthesize the trial", keyBeats: ["Limits of inference"], targetPages: 6 }
    ] };
    const result = await prepareVerifiedCases({ ...options, plan: original, coverage: "book" });
    expect(result.dossier.evidencePackets).toEqual([packet]);
    expect(result.dossier.researchGaps).toEqual([{ chapterIndex: 2, reason: expect.stringContaining("No verified case") }]);
    expect(result.episodes.chapters[1]!.episodes).toEqual([]);
  });
});
