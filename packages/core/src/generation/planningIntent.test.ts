import { describe, expect, it, vi } from "vitest";
import { FakeTextModelAdapter } from "../adapters/fake.js";
import type { GenerateJsonOptions } from "../adapters/types.js";
import { makeFallbackPlan } from "../prompting/templates.js";
import { createProjectSchema, type ModelTier } from "../schemas/book.js";
import { createPlanningPackage } from "./planner.js";

const researchSource = { title: "Source supplied to planning", url: "https://example.org/record", summary: "A documented event." };

async function capturePlanRequest(bookTypeChoice: string, modelTier: ModelTier = "balanced") {
  // Auto was resolved to a guide by the creation assistant, despite the
  // reader asking for an assessment. BUSINESS is the stored routing category.
  const input = createProjectSchema.parse({
    prompt: "A historical book assessing a former president's personality and performance in government.",
    category: "BUSINESS",
    targetPages: 120,
    mediaSettings: {
      modelTier,
      fullIllustrations: false,
      mobile: { bookTypeChoice, detectedLane: "practical_guide", recipe: { lane: "practical_guide" } }
    }
  });
  const textModel = new FakeTextModelAdapter();
  const generate = vi.spyOn(textModel, "generateJson").mockImplementation(async <T>(options: GenerateJsonOptions<T>) => ({
    data: options.schema.parse(makeFallbackPlan(input)),
    text: "{}",
    model: "fixture",
    provider: "fake"
  }));
  await createPlanningPackage({
    input,
    textModel,
    research: { search: async ({ query }) => ({ query, summary: "", sources: [researchSource] }) }
  });
  return generate.mock.calls[0]![0];
}

describe("planning follows the reader's subject and chosen form", () => {
  it.each(["balanced", "premium", "ultra"] as const)("keeps evidence but omits inferred templates and fallback outlines for Auto on %s", async (tier) => {
    const request = await capturePlanRequest("auto", tier);
    const payload = JSON.parse(request.messages.find((message) => message.role === "user")!.content);
    expect(payload.userInput.mediaSettings.mobile.bookTypeChoice).toBe("auto");
    expect(payload).not.toHaveProperty("template");
    expect(payload).not.toHaveProperty("fallbackOutline");
    expect(payload.researchContext[0].sources).toEqual([researchSource]);
  });

  it("retains the template context when the reader explicitly chose a practical guide", async () => {
    const request = await capturePlanRequest("practical_guide");
    const payload = JSON.parse(request.messages.find((message) => message.role === "user")!.content);
    expect(payload.template.slug).toBe("business-career");
  });

  it("keeps the chapter budget without imposing case-study and document chapters on every long book", async () => {
    const request = await capturePlanRequest("auto");
    const system = request.messages[0]!.content;
    expect(system).toContain("exactly 120");
    expect(system).toContain("from five to eight pages");
    expect(system).not.toContain("at least one long chapter that narrates a single case");
    expect(system).not.toContain("one short chapter that reads a single document");
    expect(system).not.toContain("no run of chapters of the same length");
    expect(system).not.toContain("At most one chapter synthesizes or concludes");
  });
});
