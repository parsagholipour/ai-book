import { FakeTextModelAdapter, createProjectSchema, makeFallbackPlan } from "@book-maker/core";
import { expect, it, vi } from "vitest";
import { reviewFinalizationManuscript } from "./compileFinalizationReview.js";

const pages = [1, 2].map((index) => ({ id: `p${index}`, index, title: `Page ${index}`, markdown: `Mara counts ${index} lanterns.`,
  summary: "", status: "COMPLETED", revision: 1, images: [] }));

it.each(["fast", "balanced", "premium"] as const)("runs the one defect screen and nothing else on %s", async (modelTier) => {
  const input = createProjectSchema.parse({ prompt: "A story about home.", category: "STORY", targetPages: 2, mediaSettings: { modelTier } });
  const textModel = new FakeTextModelAdapter();
  const generate = vi.spyOn(textModel, "generateJson").mockResolvedValue({ data: { findings: [] } } as never);
  const result = await reviewFinalizationManuscript({ input, plan: makeFallbackPlan(input), pages: pages as never, textModel });
  expect(generate).toHaveBeenCalledTimes(1);
  expect(generate.mock.calls[0]![0]).toMatchObject({ purpose: "final-book-qa" });
  expect(result).toMatchObject({ issues: [], finalQa: { approved: true, score: 100 } });
});

it("reports a failed screen honestly and propagates cancellation", async () => {
  const input = createProjectSchema.parse({ prompt: "A story about home.", category: "STORY", targetPages: 6,
    mediaSettings: { modelTier: "fast" } });
  const textModel = new FakeTextModelAdapter();
  const generate = vi.spyOn(textModel, "generateJson").mockRejectedValue(new Error("provider unavailable"));
  const options = { input, plan: makeFallbackPlan(input), pages: pages as never, textModel };
  const result = await reviewFinalizationManuscript(options);
  expect(result.issues.map((issue) => issue.code)).toEqual(["FINAL_REVIEW_UNAVAILABLE"]);
  expect(result.finalQa.approved).toBe(false);
  expect(generate).toHaveBeenCalledTimes(1);
  generate.mockRejectedValue(Object.assign(new Error("stopped"), { name: "StopRequestedError" }));
  await expect(reviewFinalizationManuscript(options)).rejects.toMatchObject({ name: "StopRequestedError" });
});
