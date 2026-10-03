import { FakeTextModelAdapter, createProjectSchema, makeFallbackPlan } from "@book-maker/core";
import { beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ chapter: vi.fn() }));
vi.mock("./compileExportChapterReview.js", () => ({ runBoundedChapterQualityReview: mocks.chapter }));
vi.mock("../generation/bookHelpers.js", () => ({ toFinalQaPage: (page: unknown) => page }));
import { reviewFinalizationManuscript } from "./compileFinalizationReview.js";
const options = { input: {}, plan: {}, pages: [], textModel: {}, projectId: "p", researchNotes: [], skipLocalChecks: true,
  strategy: { researchDepth: 0, runFinalBookQa: vi.fn() } } as unknown as Parameters<typeof reviewFinalizationManuscript>[0];
beforeEach(() => { vi.resetAllMocks(); });

it("retains a measured chapter defect when whole-book review fails", async () => {
  mocks.chapter.mockResolvedValue([{ code: "CHAPTER_TRANSITION", source: "model", severity: "warning", message: "Missing lantern handoff", affectedPageIndexes: [6, 7], guidance: "Review the handoff" }]);
  vi.mocked(options.strategy.runFinalBookQa).mockRejectedValue(new Error("max_output_tokens"));
  const result = await reviewFinalizationManuscript(options);
  expect(result.issues.map((issue) => issue.code)).toEqual(["CHAPTER_TRANSITION", "FINAL_REVIEW_UNAVAILABLE"]);
  expect(result.finalQa.approved).toBe(false);
});

it("retains the book verdict when chapter review fails and propagates cancellation", async () => {
  mocks.chapter.mockRejectedValue(new Error("transport closed"));
  const verdict = { approved: false, score: 80, issues: ["Page 3 repeats page 2"], requiredFixes: [], notes: "" };
  vi.mocked(options.strategy.runFinalBookQa).mockResolvedValue(verdict);
  expect((await reviewFinalizationManuscript(options)).finalQa).toEqual(verdict);
  mocks.chapter.mockRejectedValue(Object.assign(new Error("stopped"), { name: "StopRequestedError" }));
  await expect(reviewFinalizationManuscript(options)).rejects.toMatchObject({ name: "StopRequestedError" });
});


it("reports a failed Quick Draft screen honestly and propagates cancellation", async () => {
  const input = createProjectSchema.parse({ prompt: "A story about home.", category: "STORY", targetPages: 6,
    mediaSettings: { modelTier: "fast" } });
  const textModel = new FakeTextModelAdapter();
  const generate = vi.spyOn(textModel, "generateJson").mockRejectedValue(new Error("provider unavailable"));
  const quickOptions = { ...options, input, plan: makeFallbackPlan(input), textModel };
  const result = await reviewFinalizationManuscript(quickOptions);
  expect(result.issues.map((issue) => issue.code)).toEqual(["FINAL_REVIEW_UNAVAILABLE"]);
  expect(result.finalQa.approved).toBe(false);
  expect(generate).toHaveBeenCalledTimes(1);
  expect(mocks.chapter).not.toHaveBeenCalled();
  expect(options.strategy.runFinalBookQa).not.toHaveBeenCalled();
  generate.mockRejectedValue(Object.assign(new Error("stopped"), { name: "StopRequestedError" }));
  await expect(reviewFinalizationManuscript(quickOptions)).rejects.toMatchObject({ name: "StopRequestedError" });
});
