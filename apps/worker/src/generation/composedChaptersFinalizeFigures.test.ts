import { beforeEach, expect, it, vi } from "vitest";
import { FakeEmbeddingAdapter, FakeImageAdapter, FakeResearchAdapter, FakeSpeechAdapter, FakeTextModelAdapter,
  composedChaptersStrategy, makeFallbackPlan, stripFigureFences, type CreateProjectInput } from "@book-maker/core";
import type { IndexedPageDraft } from "../runtime/jobTypes.js";
import type { StoredSourceClaimReview } from "./sourceClaimState.js";

const state = vi.hoisted(() => ({
  markdown: "", stored: undefined as StoredSourceClaimReview | undefined,
  published: undefined as IndexedPageDraft | undefined
}));
vi.mock("@book-maker/db", () => ({ prisma: {}, pageScope: vi.fn() }));
vi.mock("../runtime/jobLifecycle.js", () => ({ advanceJobStep: vi.fn(), updateJobProgress: vi.fn() }));
vi.mock("./composedChaptersState.js", () => ({
  loadComposedBookState: async () => ({
    chapters: [{ id: "chapter", index: 1, pageNotes: new Map([[1, []]]), sourceClaimsDigest: state.stored?.textDigest,
      sourceClaimsStatus: state.stored?.coverage.status }],
    pages: [{ index: 1, status: "PENDING", title: "Example", markdown: state.markdown, summary: "Example", imagePrompt: null }]
  }),
  recordChapterSourceClaims: async (_project: string, _index: number, review: StoredSourceClaimReview) => { state.stored = review; },
  recordChapterEvidenceResiduals: vi.fn()
}));
vi.mock("./composedClaimReview.js", async () => ({
  sourceClaimReviewApplies: () => true,
  ...(await import("./sourceClaimState.js"))
}));
vi.mock("./pagePublication.js", () => ({
  GeneratedPagePublicationClaimLostError: class extends Error {},
  loadGeneratedPagePublicationSnapshot: async () => ({ status: "PENDING" }),
  stageGeneratedPageAndBrief: async (options: { draft: IndexedPageDraft }) => {
    state.published = options.draft;
    return { id: "page" };
  },
  publishStagedGeneratedPage: vi.fn()
}));
vi.mock("./qualityEnrichment.js", () => ({ keeperStoryExtractForSave: async () => null, persistStoryExtract: async () => null }));
vi.mock("./qualitySettings.js", () => ({ loadQualityContext: async () => ({ enabled: () => false }) }));
vi.mock("./storyStateStore.js", () => ({ loadProjectStoryState: async () => null }));
vi.mock("./wholeBookPageReview.js", () => ({
  reviewWholeBookDraftPages: async (options: { pages: IndexedPageDraft[] }) => options.pages.map((draft) => ({
    draft, revision: 1, qualityReport: { approved: true }
  }))
}));

import { finalizePendingPages } from "./composedChaptersFinalize.js";
import { sourceClaimVerificationIssues } from "./composedEvidenceResiduals.js";
import { sourceClaimDigest } from "./sourceClaimState.js";

const title = "Diffie-Hellman values in the worked example";
const figure = `\`\`\`figure\n${JSON.stringify({ kind: "bar", title, categories: ["Alice", "Bob"],
  series: [{ name: "Public value", values: [8, 19] }], source: "Worked example", caption: "Both parties derive the same value." })}\n\`\`\``;
const input: CreateProjectInput = { prompt: "A cryptography primer.", category: "EDUCATION", targetPages: 1,
  complexity: 7, temperature: 0.8, language: "en", mediaSettings: { fullIllustrations: false,
    illustrationCadence: "template-driven", includeCover: false, coverTemplate: "auto", finalReview: true, toneProfile: "neutral" } };

beforeEach(() => {
  state.markdown = `A hypothetical example follows.\n\n${figure}`;
  state.stored = undefined;
  state.published = undefined;
});

function finalizeOptions(text: FakeTextModelAdapter) {
  const plan = { ...makeFallbackPlan(input), chapters: [{ index: 1, title: "Example", summary: "Example", targetPages: 1, keyBeats: [] }] };
  const providers = { text, research: new FakeResearchAdapter(), image: new FakeImageAdapter(),
    embedding: new FakeEmbeddingAdapter(), speech: new FakeSpeechAdapter() };
  return { projectId: "project", planId: "plan", input, plan, providers, strategy: composedChaptersStrategy };
}

it("checks the restored figure stand-in and keeps its final review valid when the page is published", async () => {
  const text = new FakeTextModelAdapter(input);
  const requests: string[] = [];
  vi.spyOn(text, "generateJson").mockImplementation(async (request) => {
    requests.push(JSON.stringify(request.messages));
    const data = request.schema.parse({ complete: true, claims: [] });
    return { data, text: JSON.stringify(data), provider: "fixture", model: "fixture" };
  });
  const options = finalizeOptions(text);
  await finalizePendingPages(options);
  const chapter = { productionBrief: { chapterIndex: 1, report: { sourceClaims: state.stored } } };
  expect(state.published?.markdown).toContain(figure);
  expect(sourceClaimVerificationIssues([{ index: 1, markdown: state.published!.markdown, chapter }])).toEqual([]);
  expect(requests).toHaveLength(1);
  expect(requests[0]).toContain(`[Figure: ${title}]`);
  expect(state.stored?.textDigest).toBe(sourceClaimDigest(stripFigureFences(state.published!.markdown).prose));
  // A restart still sees the same restored figure and reuses this verdict.
  state.markdown = state.published!.markdown;
  await finalizePendingPages(options);
  expect(requests).toHaveLength(1);

  // The projection still includes the title and all prose, including a caption
  // outside the figure's private JSON. No new text can inherit this verdict.
  for (const changed of [
    state.markdown.replace(title, "Diffie-Hellman was invented in 1986"),
    state.markdown.replace("hypothetical", "historical"),
    `${state.markdown}\n\n*Caption: These were the values used in the original 1976 paper.*`,
    `${state.markdown}\n\n[Figure: A second factual assertion]`
  ]) {
    expect(sourceClaimVerificationIssues([{ index: 1, markdown: changed, chapter }])).toEqual([
      expect.objectContaining({ code: "SOURCE_VERIFICATION_INCOMPLETE", affectedPageIndexes: [1] })
    ]);
  }
  state.markdown = state.markdown.replace(title, "Updated worked example");
  await finalizePendingPages(options);
  expect(requests).toHaveLength(2);
  expect(requests[1]).toContain("[Figure: Updated worked example]");
});

it("does not buy another inventory solely because local QA temporarily hides an already reviewed figure", async () => {
  state.stored = { textDigest: sourceClaimDigest(stripFigureFences(state.markdown).prose),
    claims: [], issues: [], dropped: [], coverage: { status: "reviewed", checked: 0, supported: 0, contradicted: 0, unsupported: 0 } };
  const text = new FakeTextModelAdapter(input);
  const inventory = vi.spyOn(text, "generateJson");
  await finalizePendingPages(finalizeOptions(text));
  expect(inventory).not.toHaveBeenCalled();
  expect(state.published?.markdown).toContain(figure);
});
