import { describe, expect, it, vi } from "vitest";
import { FakeTextModelAdapter } from "../adapters/fake.js";
import type { GenerateJsonOptions } from "../adapters/types.js";
import { makeFallbackPlan } from "../prompting/templates.js";
import { createProjectSchema, type BookPlan } from "../schemas/book.js";
import { createPlanningPackage, revisePlanningPackage } from "./planner.js";

function planningModel(plan: BookPlan) {
  const textModel = new FakeTextModelAdapter();
  const generate = vi.spyOn(textModel, "generateJson").mockImplementation(async <T>(options: GenerateJsonOptions<T>) => ({
    data: options.schema.parse(plan), text: JSON.stringify(plan), model: "fixture", provider: "fake"
  }));
  return { textModel, generate };
}

describe("Quick Draft planning", () => {
  it.each([10, 80, 200])("skips research and requests a complete compact plan for %i pages", async (targetPages) => {
    const input = createProjectSchema.parse({
      prompt: "Search the web for current scientific research and plan a guide to ocean life.",
      category: "SCIENCE", targetPages,
      mediaSettings: { modelTier: "fast", fullIllustrations: false }
    });
    const { textModel, generate } = planningModel(makeFallbackPlan(input));
    const research = { search: vi.fn(async () => ({ query: "", summary: "", sources: [] })) };

    const plan = await createPlanningPackage({ input, textModel, research });

    expect(research.search).not.toHaveBeenCalled();
    expect(generate).toHaveBeenCalledTimes(1);
    const request = generate.mock.calls[0]![0];
    const system = request.messages[0]!.content;
    expect(system).toContain("Quick Draft");
    expect(system).toContain("complete chapter outline");
    expect(system).toContain(`exactly ${targetPages}`);
    expect(system).toContain("No web research was performed");
    expect(system).not.toContain("180 to 260 words");
    expect(JSON.stringify(request.messages)).not.toContain("fallbackOutline");
    expect(JSON.parse(request.messages.find(message => message.role === "user")!.content).userInput).toEqual(input);
    const output = request.schema.parse({ ...makeFallbackPlan(input), authorStance: {
      thesis: "A thesis", positions: [], refusals: [], voiceSample: "An unnecessary sample."
    } });
    expect(output).not.toHaveProperty("authorStance");
    expect(plan.researchNotes).toEqual([]);
    expect(plan.chapters.reduce((sum, chapter) => sum + chapter.targetPages, 0)).toBe(targetPages);
  });

  it("uses the canonical tier even when the mobile quality echo disagrees", async () => {
    const input = createProjectSchema.parse({ prompt: "A historical guide to ancient Rome.", category: "HISTORY",
      mediaSettings: { modelTier: "fast", mobile: { qualityPreset: "premium" } } });
    const research = { search: vi.fn(async () => ({ query: "", summary: "", sources: [] })) };
    await createPlanningPackage({ input, textModel: new FakeTextModelAdapter(), research, forceFallback: true });
    expect(research.search).not.toHaveBeenCalled();
  });

  it.each(["balanced", "premium", "ultra"] as const)("preserves research and full planning on %s", async (modelTier) => {
    const input = createProjectSchema.parse({ prompt: "A current scientific guide to ocean life.", category: "SCIENCE",
      mediaSettings: { modelTier } });
    const research = { search: vi.fn(async () => ({ query: "ocean", summary: "", sources: [] })) };
    const { textModel, generate } = planningModel(makeFallbackPlan(input));
    await createPlanningPackage({ input, textModel, research });
    expect(research.search).toHaveBeenCalled();
    expect(generate.mock.calls[0]![0].messages[0]!.content).toContain("180 to 260 words");
  });

  it("keeps revisions compact while preserving existing sources and applying language instructions", async () => {
    const input = createProjectSchema.parse({ prompt: "A long adventure story about two sisters.", category: "STORY", targetPages: 120,
      mediaSettings: { modelTier: "fast" } });
    const currentPlan = { ...makeFallbackPlan(input), researchNotes: [{ query: "place", title: "Source", summary: "User supplied context." }] };
    const { textModel, generate } = planningModel(currentPlan);
    const plan = await revisePlanningPackage({ input, currentPlan, textModel, userMessage: "Write it in English", language: "en" });
    const system = generate.mock.calls[0]![0].messages[0]!.content;
    expect(system).toContain("Quick Draft");
    expect(system).not.toContain("180 to 260 words");
    expect(system).toContain("translate and re-emit ALL book-facing fields");
    expect(plan.researchNotes).toEqual(currentPlan.researchNotes);
  });
});
