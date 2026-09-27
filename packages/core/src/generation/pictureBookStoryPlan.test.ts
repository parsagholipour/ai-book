import { expect, it, vi } from "vitest";
import { z } from "zod";
import { FakeTextModelAdapter } from "../adapters/fake.js";
import { bookPlanSchema, createProjectSchema } from "../schemas/book.js";
import { createPlanningPackage } from "./planner.js";
import { generateWholeBookPageMap } from "./pagesPageMap.js";
import { compactPictureBookPlanForBriefs } from "./compactPictureBookPlanning.js";
import { scriptedDevelopmentModel } from "./testing/bookDevelopmentFixtures.js";
import { makeFallbackPlan } from "../prompting/templates.js";
import { bookPlanModelOutputSchemaWithFallback } from "../schemas/plan.js";

const input = createProjectSchema.parse({ prompt: "A quiet garden story in six named chapters of five pages each.",
  category: "KIDS", targetPages: 30, mediaSettings: { finalReview: true, fullIllustrations: false } });
const research = { search: vi.fn() };

it("authors a persisted complete story before a separate allocation call, without another planning pass", async () => {
  const model = new FakeTextModelAdapter(input);
  const calls = vi.spyOn(model, "generateJson");
  const plan = await createPlanningPackage({ input, textModel: model, research });
  expect(calls).toHaveBeenCalledTimes(1);
  const wireSchema = JSON.stringify(z.toJSONSchema(calls.mock.calls[0]![0].schema, { unrepresentable: "any" }));
  expect(wireSchema).toContain('"storyTreatment"');
  expect(wireSchema).not.toContain('"chapters"');
  expect(plan.chapters).toHaveLength(1);
  expect(plan.chapters[0]!.keyBeats).toEqual([]);
  const resumed = bookPlanSchema.parse(JSON.parse(JSON.stringify(plan)));
  expect(resumed.storyTreatment).toBe(plan.storyTreatment);
  const briefs = await generateWholeBookPageMap({ input, plan: resumed, textModel: model });
  expect(calls).toHaveBeenCalledTimes(2);
  const payload = JSON.parse(calls.mock.calls[1]![0].messages[1]!.content);
  expect(payload.storyTreatment).toBe(plan.storyTreatment);
  expect(payload).not.toHaveProperty("storyOutline");
  expect(payload).not.toHaveProperty("chapters");
  expect(payload.userPrompt).toBe(input.prompt);
  const allocated = compactPictureBookPlanForBriefs(input, resumed, briefs);
  expect(bookPlanSchema.parse(allocated).storyTreatment).toBe(plan.storyTreatment);
  expect(briefs.flatMap(brief => brief.pages)).toHaveLength(30);
});

it("requires an authored story instead of restoring a fallback outline when it is omitted", async () => {
  const { model } = scriptedDevelopmentModel(Array.from({ length: 4 }, () => makeFallbackPlan(input)));
  await expect(createPlanningPackage({ input, textModel: model, research })).rejects.toThrow();
});

it("continues to load legacy plans without a treatment", () => {
  expect(bookPlanSchema.parse(makeFallbackPlan(input)).storyTreatment).toBeUndefined();
});

it("does not request a story treatment from other initial planning workflows", () => {
  const schema = bookPlanModelOutputSchemaWithFallback(makeFallbackPlan(input));
  expect(JSON.stringify(z.toJSONSchema(schema, { unrepresentable: "any" }))).not.toContain('"storyTreatment"');
});
