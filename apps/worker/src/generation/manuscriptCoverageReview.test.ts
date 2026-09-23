import { beforeEach, expect, it, vi } from "vitest";
import type { ManuscriptCoverage } from "@book-maker/core";
const mocks = vi.hoisted(() => ({ findFirst: vi.fn(), review: vi.fn() }));
vi.mock("@book-maker/db", () => ({ prisma: { generationJob: { findFirst: mocks.findFirst } } }));
vi.mock("@book-maker/core", async () => ({ ...await vi.importActual<typeof import("@book-maker/core")>("@book-maker/core"), reviewManuscriptCoverage: mocks.review }));
import { manuscriptCoverageFingerprint, manuscriptCoverageForCompile } from "./manuscriptCoverageReview.js";


const pages = [{ index: 1, markdown: "Factoring recovers prime factors from a composite number." }];
const review: ManuscriptCoverage = { status: "reviewed", requirements: [{ id: "promise-1", source: "promise", text: "Explain factoring.", quote: "Explain factoring.", kind: "content", status: "fulfilled", reason: "The passage explains the operation.", evidence: [{ pageIndex: 1, quote: pages[0]!.markdown }] }] };
const options = { projectId: "project-1", brief: "Explain factoring.", promises: ["Explain factoring."], pages, textModel: { streamText: async function* () { throw new Error("Unexpected provider call"); }, generateWithTools: async () => { throw new Error("Unexpected provider call"); }, generateText: async () => { throw new Error("Unexpected provider call"); }, generateJson: async () => { throw new Error("Unexpected provider call"); } }, allowModelReview: true };
const fingerprint = manuscriptCoverageFingerprint(options.brief, options.promises, pages);
beforeEach(() => {
  vi.clearAllMocks();
  mocks.findFirst.mockResolvedValue(null);
  mocks.review.mockResolvedValue({ ...review, issues: [] });
});

it("reuses a completed review only for the identical brief and manuscript", async () => {
  mocks.findFirst.mockResolvedValue({ qualityReport: { briefCoverage: { fingerprint, review } } });
  const result = await manuscriptCoverageForCompile(options);
  expect(result.issues).toEqual([]);
  expect(mocks.review).not.toHaveBeenCalled();
  expect(mocks.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ projectId: "project-1", qualityReport: { path: ["briefCoverage", "fingerprint"], equals: fingerprint } }) }));
});

it.each([
  { brief: "Include a comparison table." },
  { promises: ["Explain factoring.", "Explain discrete logarithms."] },
  { pages: [{ index: 1, markdown: "The explanation was removed." }] },
  { pages: [{ index: 2, markdown: pages[0]!.markdown }] }
])("rejects evidence after any requirement, page text or page index changes", async (change) => {
  mocks.findFirst.mockResolvedValue({ qualityReport: { briefCoverage: { fingerprint, review } } });
  await manuscriptCoverageForCompile({ ...options, ...change });
  expect(mocks.review).toHaveBeenCalledOnce();
});

it("never spends a model call on an edit or detached recompile with missing or stale coverage", async () => {
  mocks.findFirst.mockResolvedValue({ qualityReport: { briefCoverage: { fingerprint, review } } });
  const result = await manuscriptCoverageForCompile({ ...options, pages: [{ index: 1, markdown: "Changed." }], allowModelReview: false });
  expect(mocks.review).not.toHaveBeenCalled();
  expect(result.issues[0]?.code).toBe("BRIEF_COVERAGE_UNVERIFIED");
  expect(result.issues.some((issue) => issue.code === "UNPAID_PROMISE")).toBe(false);
});

it("does not cache provider failure as a successful review", async () => {
  mocks.findFirst.mockResolvedValue({ qualityReport: { briefCoverage: { fingerprint, review: { status: "unavailable", requirements: [] } } } });
  await manuscriptCoverageForCompile(options);
  expect(mocks.review).toHaveBeenCalledOnce();
});

it("reconstructs a cached missing-deliverable warning from the evidence record", async () => {
  mocks.findFirst.mockResolvedValue({ qualityReport: { briefCoverage: { fingerprint, review: { ...review, requirements: review.requirements.map((item) => ({ ...item, source: "brief", status: "missing", evidence: [] })) } } } });
  const result = await manuscriptCoverageForCompile({ ...options, allowModelReview: false });
  expect(result.issues[0]?.code).toBe("MISSING_BRIEF_REQUIREMENT");
  expect(mocks.review).not.toHaveBeenCalled();
});

it("invalidates coverage after a split, merge, rename or boundary move with identical prose", async () => {
  const chapters = [{ index: 1, title: "Problems", startPageIndex: 1, endPageIndex: 1 }];
  const original = manuscriptCoverageFingerprint(options.brief, options.promises, pages, chapters);
  for (const changed of [[], [{ ...chapters[0]!, title: "Solutions" }], [{ ...chapters[0]!, endPageIndex: 2 }],
    [...chapters, { index: 2, title: "Practice", startPageIndex: 2, endPageIndex: 2 }]]) {
    vi.clearAllMocks();
    mocks.findFirst.mockResolvedValue({ qualityReport: { briefCoverage: { fingerprint: original, review } } });
    await manuscriptCoverageForCompile({ ...options, chapters: changed });
    expect(mocks.review).toHaveBeenCalledWith(expect.objectContaining({ chapters: changed }));
  }
});
