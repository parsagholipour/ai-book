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
