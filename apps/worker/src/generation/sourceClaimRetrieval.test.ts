import { beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ retrieve: vi.fn() }));
vi.mock("./sourceDossier.js", async (original) => ({ ...await original<object>(), retrieveChapterSources: mocks.retrieve }));
vi.mock("../runtime/config.js", () => ({ config: {} }));
import { createProjectSchema, makeFallbackPlan, FakeTextModelAdapter, dossierExcerptSchema, type SourceClaim, type SourceClaimReview } from "@book-maker/core";
import { cachedClaimSourceFetch, claimSearchGroups, recoverSourceClaimEvidence } from "./sourceClaimRetrieval.js";

const input = createProjectSchema.parse({ prompt: "Explain cryptography", category: "SCIENCE", targetPages: 20 });
const claims: SourceClaim[] = Array.from({ length: 8 }, (_, i) => ({ id: `c${i}`, quote: `External assertion ${i}.`, searchQuery: `Record ${i}`, status: "insufficient_evidence", reason: "No passage.", support: [] }));
const review = (remaining: SourceClaim[]): SourceClaimReview => ({ claims: remaining, issues: remaining.map((c) => `“${c.quote}”: ${c.reason}`), dropped: [],
  coverage: { status: "reviewed", checked: remaining.length, supported: 0, unsupported: remaining.length, contradicted: 0 } });
function options() {
  return { projectId: "p", input, chapter: makeFallbackPlan(input).chapters[0]!, textModel: new FakeTextModelAdapter(input),
    initial: review(claims), excerpts: [], searchSources: vi.fn(async () => []), persistSources: vi.fn(async () => {}),
    review: vi.fn(async () => review(claims)), trace: vi.fn(async () => {}) };
}
beforeEach(() => {
  vi.clearAllMocks();
  mocks.retrieve.mockImplementation(async (request) => {
    for (const episode of request.episodes) await request.searchSources(episode.searchQueries[0]);
    return { documents: [], excerpts: [] };
  });
});

it("searches beyond the first two claims, bounded to six distinct groups across two rounds", async () => {
  const base = options();
  const result = await recoverSourceClaimEvidence(base);
  expect(base.searchSources.mock.calls.flat()).toEqual(["Record 0", "Record 1", "Record 2", "Record 3", "Record 4", "Record 5"]);
  expect(result.attempted.size).toBe(6);
  expect(mocks.retrieve).toHaveBeenCalledTimes(2);
  expect(base.trace).toHaveBeenLastCalledWith("claim_retrieval_finished", expect.objectContaining({ unsearchedGroupsRemain: true }));
});

it("prioritizes shared source groups and avoids repeating already searched groups", () => {
  const grouped = [...claims, { ...claims[0]!, id: "last", sourceGroup: "Shared Paper" }, { ...claims[1]!, id: "last2", sourceGroup: "shared paper" }];
  expect(claimSearchGroups(grouped, new Set())[0]).toMatchObject({ key: "shared paper", members: expect.any(Array), query: "Record 0; Record 1" });
  expect(claimSearchGroups(grouped, new Set(["shared paper"])).some((g) => g.key === "shared paper")).toBe(false);
});

it("continues to different unresolved groups after retrieving one passage", async () => {
  const base = options();
  let round = 0;
  mocks.retrieve.mockImplementation(async (request) => {
    for (const episode of request.episodes) await request.searchSources(episode.searchQueries[0]);
    round += 1;
    return { documents: [], excerpts: [dossierExcerptSchema.parse({ id: `source-${round}`, chapterIndex: 1,
      documentUrl: `https://example.org/${round}`, documentTitle: "Record", text: `A retrieved original passage ${round}.`, provenanceVerified: true })] };
  });
  const result = await recoverSourceClaimEvidence(base);
  expect(base.review).toHaveBeenCalledTimes(2);
  expect(result.excerpts).toHaveLength(2);
  expect(result.supplement?.excerpts).toHaveLength(2);
  expect(base.persistSources).toHaveBeenCalledTimes(2);
  expect(base.searchSources).toHaveBeenCalledTimes(6);
});

it("does not mark unstarted searches as attempted or spin on unchanged groups", async () => {
  mocks.retrieve.mockResolvedValue({ documents: [], excerpts: [] });
  const result = await recoverSourceClaimEvidence(options());
  expect(result.attempted.size).toBe(0);
  expect(mocks.retrieve).toHaveBeenCalledOnce();
});

it("fetches a successful document once and allows retrying failed fetches", async () => {
  const fetch = vi.fn().mockResolvedValueOnce({ status: 503, text: "" }).mockResolvedValue({ status: 200, text: "Original record" });
  const cached = cachedClaimSourceFetch(fetch);
  await cached("https://example.org/paper");
  await cached("https://example.org/paper");
  await cached("https://example.org/paper");
  expect(fetch).toHaveBeenCalledTimes(2);
});

it("stops retrieval when the supplied passages resolve every claim", async () => {
  const base = options();
  base.review.mockResolvedValue({ ...review([]), coverage: { status: "reviewed", checked: 8, supported: 8, unsupported: 0, contradicted: 0 } });
  mocks.retrieve.mockImplementation(async (request) => {
    for (const episode of request.episodes) await request.searchSources(episode.searchQueries[0]);
    return { documents: [], excerpts: [dossierExcerptSchema.parse({ id: "record", chapterIndex: 1,
      documentUrl: "https://example.org/record", documentTitle: "Record", text: "An original supporting passage.", provenanceVerified: true })] };
  });
  await recoverSourceClaimEvidence(base);
  expect(mocks.retrieve).toHaveBeenCalledOnce();
});

it("honors the shared deadline between retrieval rounds", async () => {
  const clock = vi.spyOn(Date, "now").mockReturnValue(1000);
  try {
    mocks.retrieve.mockImplementation(async (request) => {
      await request.searchSources(request.episodes[0].searchQueries[0]);
      clock.mockReturnValue(121001);
      return { documents: [], excerpts: [] };
    });
    const base = options();
    await recoverSourceClaimEvidence(base);
    expect(mocks.retrieve).toHaveBeenCalledOnce();
    expect(base.trace).toHaveBeenLastCalledWith("claim_retrieval_finished", expect.objectContaining({ deadlineReached: true }));
  } finally { clock.mockRestore(); }
});

it("does not give a failed search or a later rewritten assertion authority for deletion", async () => {
  const base = options();
  base.searchSources.mockRejectedValue(new Error("research offline"));
  mocks.retrieve.mockImplementation(async (request) => {
    try { await request.searchSources(request.episodes[0].searchQueries[0]); } catch { /* production discovery degrades too */ }
    return { documents: [], excerpts: [] };
  });
  const result = await recoverSourceClaimEvidence(base);
  expect(result.attempted.size).toBeGreaterThan(0);
  expect(result.searchedClaims.size).toBe(0);
  base.searchSources.mockResolvedValue([]);
  const successful = await recoverSourceClaimEvidence(base);
  expect(successful.searchedClaims.has(claims[0]!.quote)).toBe(true);
  expect(successful.searchedClaims.has(`${claims[0]!.quote} A new asserted detail.`)).toBe(false);
});
