import { describe, expect, it } from "vitest";
import { estimateInteriorImageCount } from "../billing.js";
import { makeFallbackPlan } from "../prompting/templates.js";
import { bookPlanSchema, createProjectSchema } from "../schemas/book.js";
import { interiorIllustrationSlotCount, pageGetsInteriorIllustration } from "./illustrationSlots.js";
import { bookGenerationStrategies } from "./strategies/index.js";

function project(cadence: string, category = "KIDS", targetPages = 30) {
  return createProjectSchema.parse({
    prompt: "Rabbit and Turtle help their neighbors find the picnic.",
    category,
    targetPages,
    complexity: 3,
    temperature: 0.7,
    mediaSettings: { fullIllustrations: true, illustrationCadence: cadence }
  });
}

describe("explicit illustration slots", () => {
  it("preserves every-third-page in project and saved plan schemas", () => {
    const input = project("every-third-page");
    expect(input.mediaSettings.illustrationCadence).toBe("every-third-page");
    expect(bookPlanSchema.parse(makeFallbackPlan(input)).illustrationPlan.cadence).toBe("every-third-page");
    expect(project("Every Third Page").mediaSettings.illustrationCadence).toBe("every-third-page");
  });

  it("routes all strategies to exactly pages 3,6,...30, regardless of category defaults", () => {
    const expected = [3, 6, 9, 12, 15, 18, 21, 24, 27, 30];
    for (const category of ["KIDS", "STORY", "EDUCATION"]) {
      const input = project("every-third-page", category);
      const plan = makeFallbackPlan(input);
      for (const strategy of bookGenerationStrategies) {
        expect(Array.from({ length: 30 }, (_, i) => i + 1)
          .filter((index) => strategy.shouldIllustratePage(input, plan, index))).toEqual(expected);
      }
      expect(interiorIllustrationSlotCount(input)).toBe(10);
    }
  });

  it.each([[2, 0], [5, 1], [29, 9], [30, 10], [31, 10]])(
    "counts only complete third-page slots for %i pages",
    (pages, count) => expect(interiorIllustrationSlotCount(project("every-third-page"), pages)).toBe(count)
  );

  it("retains the image master switch, manual, every-page and default Kids behavior", () => {
    for (const cadence of ["every-third-page", "every-page", "template-driven", "manual"]) {
      const input = project(cadence);
      input.mediaSettings.fullIllustrations = false;
      expect(interiorIllustrationSlotCount(input)).toBe(0);
      expect(pageGetsInteriorIllustration(input, 3)).toBe(false);
    }
    expect(interiorIllustrationSlotCount(project("manual"))).toBe(0);
    expect(interiorIllustrationSlotCount(project("every-page"))).toBe(30);
    expect(interiorIllustrationSlotCount(project("template-driven"))).toBe(30);
  });

  it("bills actual sparse slots while retaining the existing launch cap", () => {
    const workbook = project("every-third-page", "EDUCATION", 8);
    workbook.subcategory = "Workbook or Study Guide";
    expect(interiorIllustrationSlotCount(workbook)).toBe(2);
    expect(estimateInteriorImageCount(workbook)).toBe(2);
    const kids = project("every-third-page");
    expect(interiorIllustrationSlotCount(kids)).toBe(10);
    expect(estimateInteriorImageCount(kids)).toBe(4);
  });
});
