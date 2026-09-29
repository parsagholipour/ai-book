import { readFileSync } from "node:fs";
import { inputWithSelectedPageCount, shortKidsStoryPageLayout } from "@book-maker/core";
import type { GenerateJsonOptions, PictureBookReviewCheckpoint, TextModelAdapter } from "@book-maker/core";
import { beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ review: vi.fn(), stop: vi.fn(), row: { payload: {} as Record<string, unknown> }, writes: vi.fn() }));
vi.mock("@book-maker/db", () => {
  const tx = { generationJob: { findUnique: async () => structuredClone(mocks.row), update: mocks.writes } };
  return { prisma: { ...tx, $transaction: (run: (value: typeof tx) => Promise<unknown>) => run(tx) } };
});
vi.mock("../runtime/jobLifecycle.js", () => ({ assertJobNotStopped: mocks.stop }));
vi.mock("@book-maker/core", async (original) => ({ ...await original<object>(), reviewPictureBookManuscript: mocks.review }));
import { prepareShortPictureBookReview, usesShortPictureBookReview } from "./shortPictureBook.js";
import { readPictureBookDeliverySnapshot, readPictureBookReviewSnapshot } from "./shortPictureBookReviewCache.js";
const pages = Array.from({ length: 30 }, (_, i) => ({ index: i + 1, title: `Page ${i + 1}`, markdown: `Rabbit carries lantern ${i + 1} into the village.`, summary: "A lantern." }));
const input = { category: "KIDS", prompt: "Rabbit and Wise Turtle find lanterns.", targetPages: 30,
  mediaSettings: { finalReview: true, fullIllustrations: true, generationStrategy: "auto" } };
const plan = { title: "Lanterns", chapters: [] };
const options = () => ({ projectId: "p", generationJobId: "g", input, plan, pages, chapterBriefs: [], quality: { enabled: () => true }, textModel: {} }) as unknown as Parameters<typeof prepareShortPictureBookReview>[0];
const eligible = () => ({ input, plan, pages, strategy: { shouldIllustratePage: () => true } }) as unknown as Parameters<typeof usesShortPictureBookReview>[0];
beforeEach(() => {
  vi.clearAllMocks(); mocks.row.payload = { unrelated: true };
  mocks.writes.mockImplementation(async ({ data }: { data: { payload: Record<string, unknown> } }) => { mocks.row.payload = structuredClone(data.payload); });
  mocks.review.mockImplementation(async (request: Parameters<typeof import("@book-maker/core").reviewPictureBookManuscript>[0]) => request.pages.map((page) => ({ pageIndex: page.index, draftMarkdown: page.markdown,
    report: { approved: true, score: 95, issues: [], requiredRevisions: [], notes: "" }, storyExtract: request.checks.storyExtractAudit ? { storyDelta: {}, contradictions: [] } : null,
    styleAudit: { styleOk: true, styleIssues: [] }, completedChecks: request.checks })));
});

it("bounds the new workflow to complete auto-selected short children's manuscripts", () => {
  expect(usesShortPictureBookReview(eligible())).toBe(true);
  for (const mutation of [
    { input: { ...input, category: "FICTION" } }, { input: { ...input, targetPages: 80 } },
    { input: { ...input, mediaSettings: { ...input.mediaSettings, generationStrategy: "draft-then-polish" } } },
    { input: { ...input, mediaSettings: { ...input.mediaSettings, finalReview: false } } },
    { input: { ...input, prompt: "Teach scientific facts." } }, { pages: pages.slice(1) },
    { strategy: { researchDepth: 12, shouldIllustratePage: () => true } },
    { input: { ...input, mediaSettings: { ...input.mediaSettings, mobile: { import: { source: "manuscript" } } } } }
  ]) expect(usesShortPictureBookReview({ ...eligible(), ...mutation } as never)).toBe(false);
});

it("keeps all 44 pages of a forty-page request in review and separate story-page export", async () => {
  const extended = inputWithSelectedPageCount({ ...eligible().input, targetPages: 40 }, 44);
  const manuscript = Array.from({ length: 44 }, (_, i) => ({ ...pages[i % pages.length]!, index: i + 1 }));
  expect(usesShortPictureBookReview({ ...eligible(), input: extended, pages: manuscript })).toBe(true);
  expect(shortKidsStoryPageLayout(extended, manuscript)).toBe("separate");
  expect((await prepareShortPictureBookReview({ ...options(), input: extended, pages: manuscript }))?.size).toBe(44);
});

it("bases grouped text review on the complete manuscript independently of illustration slots", () => {
  const options = eligible();
  options.input = { ...options.input, mediaSettings: { ...options.input.mediaSettings, fullIllustrations: false, coverArtSource: "none" } };
  options.strategy = { ...options.strategy, shouldIllustratePage: () => false };
  expect(usesShortPictureBookReview(options)).toBe(true);
  for (const changed of [pages.slice(1), [...pages].reverse(), pages.map((page) => ({ ...page, markdown: " " })),
    pages.map((page) => ({ ...page, markdown: "x".repeat(1601) })),
    pages.map((page) => ({ ...page, markdown: "word ".repeat(201) }))]) {
    expect(usesShortPictureBookReview({ ...options, pages: changed })).toBe(false);
  }
});

it("keeps all thirty text pages eligible when only ten pages have illustrations", () => {
  const baseline = eligible();
  const options: typeof baseline = { ...baseline, strategy: { ...baseline.strategy, shouldIllustratePage: (_input, _plan, index) => index % 3 === 0 } };
  expect(usesShortPictureBookReview(options)).toBe(true);
  expect(usesShortPictureBookReview({ ...options, pages: pages.filter((page) => page.index % 3 === 0) })).toBe(false);
  expect(usesShortPictureBookReview({ ...options, pages: pages.map((page) => page.index === 2 ? { ...page, markdown: "" } : page) })).toBe(false);
});

it("reuses the complete durable review on a same-snapshot retry", async () => {
  expect((await prepareShortPictureBookReview(options()))?.size).toBe(30);
  expect((await prepareShortPictureBookReview(options()))?.size).toBe(30);
  expect(mocks.review).toHaveBeenCalledTimes(1);
  expect(mocks.row.payload.unrelated).toBe(true);
});

it("invalidates review reuse when any neighboring prose or enabled gate changes", async () => {
  await prepareShortPictureBookReview(options());
  const changed = options(); changed.pages = pages.map((page) => page.index === 12 ? { ...page, markdown: "Wise Turtle now carries the final lantern." } : page);
  await prepareShortPictureBookReview(changed);
  await prepareShortPictureBookReview({ ...changed, quality: { enabled: (feature) => feature !== "storyExtractAudit" } });
  expect(mocks.review).toHaveBeenCalledTimes(3);
});

it("never treats a missing cached page as approval", async () => {
  await prepareShortPictureBookReview(options());
  const cache = mocks.row.payload.pictureBookReview as { reviews: unknown[] };
  cache.reviews.pop();
  await prepareShortPictureBookReview(options());
  expect(mocks.review).toHaveBeenCalledTimes(2);
});

it("invalidates a cached missing enabled assessment rather than filling in a pass", async () => {
  await prepareShortPictureBookReview(options());
  const cache = mocks.row.payload.pictureBookReview as { reviews: Array<{ styleAudit: object }> };
  cache.reviews[0]!.styleAudit = {};
  await prepareShortPictureBookReview(options());
  expect(mocks.review).toHaveBeenCalledTimes(2);
});

it("propagates unexpected implementation errors, cancellation and checkpoint failure", async () => {
  mocks.review.mockRejectedValueOnce(Object.assign(new Error("OpenAI response was incomplete: max_output_tokens."), { name: "OpenAIResponseError" }));
  await expect(prepareShortPictureBookReview(options())).rejects.toMatchObject({ name: "OpenAIResponseError" });
  expect(mocks.writes).not.toHaveBeenCalled();
  mocks.stop.mockRejectedValueOnce(Object.assign(new Error("stopped"), { name: "StopRequestedError" }));
  await expect(prepareShortPictureBookReview(options())).rejects.toMatchObject({ name: "StopRequestedError" });
  mocks.writes.mockRejectedValueOnce(new Error("database unavailable"));
  await expect(prepareShortPictureBookReview(options())).rejects.toThrow("database unavailable");
});


const captured = JSON.parse(readFileSync(new URL("../../../../packages/core/src/generation/testing/balancedGroupReview.json", import.meta.url), "utf8"));
it("keeps a clean grouped verdict unverified when independent continuity fails, including redelivery", async () => {
  const core = await vi.importActual<typeof import("@book-maker/core")>("@book-maker/core");
  mocks.review.mockImplementation(core.reviewPictureBookManuscript);
  const model = new core.FakeTextModelAdapter();
  const calls: string[] = [];
  model.generateJson = async request => {
    calls.push(request.purpose!);
    if (request.purpose === "review-picture-book-continuity") throw new Error("Continuity unavailable");
    return { data: request.schema.parse({ findings: [], pages: pages.map(page => ({ pageIndex: page.index, score: 96 })) }),
      text: "", provider: "fixture", model: "fixture" };
  };
  const request = { ...options(), textModel: model, quality: { ...options().quality, enabled: (feature: string) => feature === "pageModelReview" } };
  const result = await prepareShortPictureBookReview(request);
  expect([...result.values()].every(review => review.reviewUnavailable && !review.report.approved)).toBe(true);
  expect(await prepareShortPictureBookReview(request)).toEqual(result);
  expect(calls).toEqual(["review-page", "review-picture-book-continuity"]);
});

async function realReviewOptions(answers: unknown[]) {
  const core = await vi.importActual<typeof import("@book-maker/core")>("@book-maker/core");
  // Isolate durable grouped-review recovery; continuity delivery is covered separately.
  mocks.review.mockImplementation(request => core.reviewPictureBookManuscript({ ...request, continuityReview: false }));
  let count = 0;
  const generateJson = vi.fn(async <T>(request: GenerateJsonOptions<T>) => {
    core.consumeTextAttempt(request);
    const response = answers[Math.min(count++, answers.length - 1)];
    return { data: request.schema.parse(response) };
  });
  return { generateJson, request: { ...options(), input: { ...options().input, prompt: captured.brief, language: "en" }, pages: captured.pages,
    quality: { ...options().quality, enabled: (feature: string): boolean => feature === "pageModelReview" }, textModel: { generateJson } as unknown as TextModelAdapter } };
}

it("persists 29 accepted captured rows and an exhausted page18 without enabling a wholesale fallback on resume", async () => {
  const { request, generateJson } = await realReviewOptions([captured.response, { pages: [captured.response.pages[17]] }]);
  const delivery = await prepareShortPictureBookReview(request);
  expect(delivery.size).toBe(30);
  expect(delivery.get(18)).toMatchObject({ reviewUnavailable: true, report: { approved: false } });
  const checkpoint = mocks.row.payload.pictureBookReview as PictureBookReviewCheckpoint;
  expect(checkpoint.reviews).toHaveLength(29);
  expect(checkpoint).toMatchObject({ roundsStarted: 2, attemptsUsed: 2, unresolvedPageIndexes: [18] });
  expect(mocks.row.payload.unrelated).toBe(true);
  expect((await prepareShortPictureBookReview(request)).get(18)).toEqual(delivery.get(18));
  expect(generateJson).toHaveBeenCalledTimes(2);
});

it("resumes one targeted request from a settled partial checkpoint and reuses its complete result", async () => {
  const { request, generateJson } = await realReviewOptions([captured.response, { pages: [{ pageIndex: 18, score: 96, findings: [], storyExtract: null, styleAudit: null }] }]);
  const save = mocks.writes.getMockImplementation()!;
  mocks.writes.mockImplementation(async (value) => {
    await save(value);
    const checkpoint = mocks.row.payload.pictureBookReview as PictureBookReviewCheckpoint;
    if (checkpoint.attemptsUsed === 1 && checkpoint.roundsStarted === 1) throw new Error("Process exits after checkpoint commit");
  });
  await expect(prepareShortPictureBookReview(request)).rejects.toThrow("Process exits");
  mocks.writes.mockImplementation(save);
  expect((await prepareShortPictureBookReview(request)).size).toBe(30);
  expect((await prepareShortPictureBookReview(request)).size).toBe(30);
  expect(generateJson).toHaveBeenCalledTimes(2);
  const target = JSON.parse(generateJson.mock.calls[1]![0].messages.find((message) => message.role === "user")!.content);
  expect(target.reviewPageIndexes).toEqual([18]);
  expect(target.pages).toEqual(request.pages.map(({ index, title, markdown }: { index: number; title: string; markdown: string }) => ({ index, title, markdown })));
});

it("does not reuse an allowance after a crash during a reserved provider call", async () => {
  const { request, generateJson } = await realReviewOptions([captured.response]);
  generateJson.mockRejectedValueOnce(Object.assign(new Error("Stopped during provider request"), { name: "AbortError" }));
  await expect(prepareShortPictureBookReview(request)).rejects.toMatchObject({ name: "AbortError" });
  expect(mocks.row.payload.pictureBookReview).toMatchObject({ roundsStarted: 1, attemptsUsed: 5, reviews: [] });
  const delivered = await prepareShortPictureBookReview(request);
  expect(delivered.size).toBe(30);
  expect([...delivered.values()].every(review => review.reviewUnavailable && !review.report.approved)).toBe(true);
  expect(generateJson).toHaveBeenCalledTimes(1);
});

const quick = JSON.parse(readFileSync(new URL("../../../../packages/core/src/generation/testing/quickGroupReview.json", import.meta.url), "utf8"));
const quickCorrection = { pages: [], corrections: [{ id: "20:0:0", supportsSameClaim: true,
  quote: "Six lanterns glowed in order, from the gate to the reeds." }] };
async function quickReviewOptions(answers: unknown[]) {
  const setup = await realReviewOptions(answers);
  setup.request.input.prompt = quick.brief;
  setup.request.pages = quick.pages;
  setup.request.quality.enabled = feature => feature === "pageModelReview" || feature === "storyExtractAudit";
  return setup;
}

it("resumes citation correction from the durable original finding instead of asking for a new page verdict", async () => {
  const { request, generateJson } = await quickReviewOptions([quick.response, quickCorrection]);
  const save = mocks.writes.getMockImplementation()!;
  mocks.writes.mockImplementation(async value => {
    await save(value);
    const checkpoint = mocks.row.payload.pictureBookReview as PictureBookReviewCheckpoint;
    if (checkpoint.attemptsUsed === 1 && checkpoint.roundsStarted === 1) throw new Error("Exit after citation checkpoint");
  });
  await expect(prepareShortPictureBookReview(request)).rejects.toThrow("Exit after citation checkpoint");
  expect(mocks.row.payload.pictureBookReview).toMatchObject({ citationRows: [{ pageIndex: 20, findings: quick.response.pages[19].findings }],
    unresolvedPageIndexes: [20], roundsStarted: 1, attemptsUsed: 1 });
  mocks.writes.mockImplementation(save);
  const reviews = await prepareShortPictureBookReview(request);
  expect(reviews.get(20)?.report).toMatchObject({ approved: false, score: 78, requiredRevisions: [quick.response.pages[19].findings[0].guidance] });
  expect((await prepareShortPictureBookReview(request)).get(20)?.report.approved).toBe(false);
  expect(generateJson).toHaveBeenCalledTimes(2);
  expect(mocks.row.payload.pictureBookReview).toMatchObject({ citationRows: [], unresolvedPageIndexes: [], roundsStarted: 2, attemptsUsed: 2 });
  expect(mocks.row.payload.unrelated).toBe(true);
});

it("retains the unresolved finding after a refused citation correction and spends nothing on redelivery", async () => {
  const { request, generateJson } = await quickReviewOptions([quick.response,
    { pages: [], corrections: [{ id: "20:0:0", supportsSameClaim: false, quote: null }] }]);
  const delivery = await prepareShortPictureBookReview(request);
  expect(delivery.get(20)).toMatchObject({ reviewUnavailable: true, unverifiedFindings: quick.response.pages[19].findings,
    report: { approved: false, issues: [], requiredRevisions: [] } });
  expect(mocks.row.payload.pictureBookReview).toMatchObject({ citationRows: [{ pageIndex: 20, findings: quick.response.pages[19].findings }],
    validationIssues: [{ pageIndex: 20, message: expect.stringContaining("remains unverified") }], unresolvedPageIndexes: [20], roundsStarted: 2, attemptsUsed: 2 });
  expect((await prepareShortPictureBookReview(request)).get(20)).toEqual(delivery.get(20));
  expect(generateJson).toHaveBeenCalledTimes(2);
});

it("keeps the original citation finding when a worker stops during its reserved recovery call", async () => {
  const { request, generateJson } = await quickReviewOptions([quick.response]);
  generateJson.mockImplementationOnce(async options => ({ data: options.schema.parse(quick.response) }))
    .mockRejectedValueOnce(Object.assign(new Error("Stopped during correction"), { name: "AbortError" }));
  await expect(prepareShortPictureBookReview(request)).rejects.toMatchObject({ name: "AbortError" });
  expect(mocks.row.payload.pictureBookReview).toMatchObject({ citationRows: [{ pageIndex: 20 }], roundsStarted: 2, attemptsUsed: 5 });
  expect((await prepareShortPictureBookReview(request)).get(20)).toMatchObject({ reviewUnavailable: true,
    unverifiedFindings: quick.response.pages[19].findings, report: { approved: false } });
  expect(generateJson).toHaveBeenCalledTimes(2);
});

it("resumes Premium's malformed response from the durable partial review without losing its grounded finding", async () => {
  const premium = JSON.parse(readFileSync(new URL("../../../../packages/core/src/generation/testing/premiumMalformedGroupReview.json", import.meta.url), "utf8"));
  const { request, generateJson } = await realReviewOptions([premium.response, { pages: [30].map(pageIndex => ({
    pageIndex, score: 100, findings: [], storyExtract: "no_changes", styleAudit: "clean"
  })), auxiliaryCorrections: [{ id: "page:29", storyExtract: "no_changes", styleAudit: "clean" }] }]);
  request.input.prompt = premium.brief; request.pages = premium.pages; request.quality.enabled = () => true;
  const save = mocks.writes.getMockImplementation()!;
  mocks.writes.mockImplementation(async value => {
    await save(value);
    const checkpoint = mocks.row.payload.pictureBookReview as PictureBookReviewCheckpoint;
    if (checkpoint.attemptsUsed === 1 && checkpoint.roundsStarted === 1) throw new Error("Exit after malformed review checkpoint");
  });
  await expect(prepareShortPictureBookReview(request)).rejects.toThrow("Exit after malformed review checkpoint");
  const initial = structuredClone(mocks.row.payload.pictureBookReview) as PictureBookReviewCheckpoint;
  expect(initial).toMatchObject({ editorialRows: [{ pageIndex: 29, score: 88, findings: premium.response.pages[28].findings }],
    unresolvedPageIndexes: [29, 30], roundsStarted: 1, attemptsUsed: 1 });
  expect(initial.reviews).toHaveLength(28);
  mocks.writes.mockImplementation(save);
  const reviews = await prepareShortPictureBookReview(request);
  expect(reviews.size).toBe(30);
  expect([...reviews.values()].slice(0, 28)).toEqual(initial.reviews);
  expect(reviews.get(29)).toMatchObject({ report: { approved: false, score: 88 }, findings: premium.response.pages[28].findings });
  expect((await prepareShortPictureBookReview(request)).get(29)?.report.approved).toBe(false);
  expect(generateJson).toHaveBeenCalledTimes(2);
  expect(mocks.row.payload.pictureBookReview).toMatchObject({ editorialRows: [], unresolvedPageIndexes: [], protocolIssues: [], roundsStarted: 2, attemptsUsed: 2 });
  expect(mocks.row.payload.unrelated).toBe(true);
});

it.each([false, true])("preserves malformed repair metadata across worker restart and cached delivery (corrected=%s)", async corrected => {
  const metadata = JSON.parse(readFileSync(new URL("../../../../packages/core/src/generation/testing/quickMalformedFindingMetadata.json", import.meta.url), "utf8"));
  const response = corrected ? { pages: [], metadataCorrections: [
    { id: "4:0", supportsSameFinding: true, repairPageIndexes: null, relatedEvidenceIndexes: [0, 1] },
    { id: "25:0", supportsSameFinding: true, repairPageIndexes: [25, 26, 27, 28, 29], relatedEvidenceIndexes: [1, 2, 3] }
  ] } : metadata.emptyRecovery;
  const { request, generateJson } = await realReviewOptions([metadata.response, response]);
  request.input.prompt = metadata.brief; request.pages = metadata.pages;
  request.quality.enabled = feature => feature === "pageModelReview" || feature === "storyExtractAudit";
  const save = mocks.writes.getMockImplementation()!;
  mocks.writes.mockImplementation(async value => {
    await save(value);
    const checkpoint = mocks.row.payload.pictureBookReview as PictureBookReviewCheckpoint;
    if (checkpoint.attemptsUsed === 1 && checkpoint.roundsStarted === 1) throw new Error("Exit after metadata checkpoint");
  });
  await expect(prepareShortPictureBookReview(request)).rejects.toThrow("Exit after metadata checkpoint");
  expect(mocks.row.payload.pictureBookReview).toMatchObject({ metadataRows: [{ pageIndex: 4 }, { pageIndex: 25 }],
    unresolvedPageIndexes: [4, 25], roundsStarted: 1, attemptsUsed: 1 });
  mocks.writes.mockImplementation(save);
  const reviews = await prepareShortPictureBookReview(request);
  expect(reviews.size).toBe(30);
  for (const finding of metadata.response.findings) {
    const page = reviews.get(finding.pageIndex)!;
    expect(page.report.approved).toBe(false);
    if (corrected) expect(page.findings?.[0]?.message).toBe(finding.message);
    else {
      expect(page).toMatchObject({ reviewUnavailable: true, report: { issues: [], requiredRevisions: [], scoreBasis: "screened_unscored" } });
      expect(page.report.notes).toContain(finding.message);
    }
  }
  expect(await prepareShortPictureBookReview(request)).toEqual(reviews);
  expect(generateJson).toHaveBeenCalledTimes(2);
  const context = { ...request, checks: metadata.enabledChecks };
  const snapshot = mocks.row.payload.pictureBookReview;
  expect(readPictureBookDeliverySnapshot(snapshot, context)).toEqual([...reviews.values()]);
  if (!corrected) expect(readPictureBookReviewSnapshot(snapshot, context)).toBeUndefined();
});
