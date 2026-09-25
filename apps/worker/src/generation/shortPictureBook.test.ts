import { readFileSync } from "node:fs";
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

it("fails closed after group failure and propagates cancellation or checkpoint failure", async () => {
  mocks.review.mockRejectedValueOnce(Object.assign(new Error("OpenAI response was incomplete: max_output_tokens."), { name: "OpenAIResponseError" }));
  await expect(prepareShortPictureBookReview(options())).rejects.toMatchObject({ name: "OpenAIResponseError" });
  expect(mocks.writes).not.toHaveBeenCalled();
  mocks.stop.mockRejectedValueOnce(Object.assign(new Error("stopped"), { name: "StopRequestedError" }));
  await expect(prepareShortPictureBookReview(options())).rejects.toMatchObject({ name: "StopRequestedError" });
  mocks.writes.mockRejectedValueOnce(new Error("database unavailable"));
  await expect(prepareShortPictureBookReview(options())).rejects.toThrow("database unavailable");
});


const captured = JSON.parse(readFileSync(new URL("../../../../packages/core/src/generation/testing/balancedGroupReview.json", import.meta.url), "utf8"));
async function realReviewOptions(answers: unknown[]) {
  const core = await vi.importActual<typeof import("@book-maker/core")>("@book-maker/core");
  mocks.review.mockImplementation(core.reviewPictureBookManuscript);
  let count = 0;
  const generateJson = vi.fn(async <T>(request: GenerateJsonOptions<T>) => {
    core.consumeTextAttempt(request);
    const response = answers[Math.min(count++, answers.length - 1)];
    return { data: request.schema.parse(response) };
  });
  return { generateJson, request: { ...options(), input: { ...options().input, prompt: captured.brief, language: "en" }, pages: captured.pages,
    quality: { ...options().quality, enabled: (feature: string) => feature === "pageModelReview" }, textModel: { generateJson } as unknown as TextModelAdapter } };
}

it("persists 29 accepted captured rows and an exhausted page18 without enabling a wholesale fallback on resume", async () => {
  const { request, generateJson } = await realReviewOptions([captured.response, { pages: [captured.response.pages[17]] }]);
  await expect(prepareShortPictureBookReview(request)).rejects.toMatchObject({ name: "PictureBookReviewIncompleteError", checkpoint: { unresolvedPageIndexes: [18] } });
  const checkpoint = mocks.row.payload.pictureBookReview as PictureBookReviewCheckpoint;
  expect(checkpoint.reviews).toHaveLength(29);
  expect(checkpoint).toMatchObject({ roundsStarted: 2, attemptsUsed: 2, unresolvedPageIndexes: [18] });
  expect(mocks.row.payload.unrelated).toBe(true);
  await expect(prepareShortPictureBookReview(request)).rejects.toMatchObject({ name: "PictureBookReviewIncompleteError" });
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
  expect(target.pages).toEqual(captured.pages);
});

it("does not reuse an allowance after a crash during a reserved provider call", async () => {
  const { request, generateJson } = await realReviewOptions([captured.response]);
  generateJson.mockRejectedValueOnce(Object.assign(new Error("Stopped during provider request"), { name: "AbortError" }));
  await expect(prepareShortPictureBookReview(request)).rejects.toMatchObject({ name: "AbortError" });
  expect(mocks.row.payload.pictureBookReview).toMatchObject({ roundsStarted: 1, attemptsUsed: 5, reviews: [] });
  await expect(prepareShortPictureBookReview(request)).rejects.toMatchObject({ name: "PictureBookReviewIncompleteError" });
  expect(generateJson).toHaveBeenCalledTimes(1);
});
