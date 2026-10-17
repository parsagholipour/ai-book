import { describe, expect, it, vi } from "vitest";
import { FakeTextModelAdapter } from "../adapters/fake.js";
import type { GenerateJsonOptions } from "../adapters/types.js";
import { makeFallbackPlan } from "../prompting/templates.js";
import { createProjectSchema, type BookPlan, type CreateProjectInput } from "../schemas/book.js";
import { compactPictureBookPlanMessages, usesCompactPictureBookPlanning } from "./compactPictureBookPlanning.js";
import { createPlanningPackage, revisePlanningPackage } from "./planner.js";
import { REAL_PEOPLE_KEEP_THEIR_NAMES_RULE } from "./realPeople.js";

function planningModel(plan: BookPlan) {
  const textModel = new FakeTextModelAdapter();
  const generate = vi.spyOn(textModel, "generateJson").mockImplementation(async <T>(options: GenerateJsonOptions<T>) => ({
    data: options.schema.parse(plan), text: JSON.stringify(plan), model: "fixture", provider: "fake"
  }));
  return { textModel, generate };
}

const research = { search: vi.fn(async () => ({ query: "", summary: "", sources: [] })) };

function storyInput(modelTier: "fast" | "balanced"): CreateProjectInput {
  return createProjectSchema.parse({
    prompt: "10 page book about Neymar and a poor girl, she's a waitress, enemies to lovers",
    category: "STORY", targetPages: 10, mediaSettings: { modelTier }
  });
}

// "A 10 page book about Neymar and a poor girl" was planned as a romance with
// "Rafael Vale", under four rules forbidding Neymar's name (2026-10-17).
describe("a real person the reader names", () => {
  it.each(["balanced", "fast"] as const)("keeps their name in the %s initial plan", async (modelTier) => {
    const input = storyInput(modelTier);
    const { textModel, generate } = planningModel(makeFallbackPlan(input));

    await createPlanningPackage({ input, textModel, research });

    expect(generate.mock.calls[0]![0].messages[0]!.content).toContain(REAL_PEOPLE_KEEP_THEIR_NAMES_RULE);
  });

  it("keeps their name through a plan revision", async () => {
    const input = storyInput("balanced");
    const currentPlan = makeFallbackPlan(input);
    const { textModel, generate } = planningModel(currentPlan);

    await revisePlanningPackage({ input, currentPlan, textModel, userMessage: "Make it funnier" });

    expect(generate.mock.calls[0]![0].messages[0]!.content).toContain(REAL_PEOPLE_KEEP_THEIR_NAMES_RULE);
  });

  it("keeps their name in a children's picture book plan", () => {
    const input = createProjectSchema.parse({
      prompt: "A bedtime story about Messi teaching a shy boy to play football",
      category: "KIDS", targetPages: 10, mediaSettings: { modelTier: "balanced" }
    });

    expect(usesCompactPictureBookPlanning(input)).toBe(true);
    for (const storyFirst of [false, true]) {
      expect(compactPictureBookPlanMessages(input, storyFirst)[0]!.content).toContain(REAL_PEOPLE_KEEP_THEIR_NAMES_RULE);
    }
  });
});
