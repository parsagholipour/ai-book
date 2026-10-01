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

  it("never draws more interiors for an app book than its quote bills, spread across the story", () => {
    const appBook = (category: string, targetPages: number, bookType?: string, cadence = "template-driven") => {
      const input = project(cadence, category, targetPages);
      (input.mediaSettings as Record<string, unknown>).mobile = bookType ? { bookType } : {};
      return input;
    };
    // A 12-page children's story: KIDS illustrates every page, the app quotes 4.
    const story = appBook("KIDS", 12, "short_story");
    const pages = Array.from({ length: 12 }, (_, i) => i + 1).filter((index) => pageGetsInteriorIllustration(story, index));
    expect(pages).toEqual([1, 4, 7, 10]);
    expect(interiorIllustrationSlotCount(story)).toBe(estimateInteriorImageCount(story));
    // Never a page the quote did not cover.
    expect(pageGetsInteriorIllustration(story, 13)).toBe(false);
    // A 24-page lead magnet's cadence picks seven pages; it is billed four.
    expect(interiorIllustrationSlotCount(appBook("BUSINESS", 24, "lead_magnet"))).toBe(4);
    for (const category of ["KIDS", "STORY", "BUSINESS", "EDUCATION", "SCIENCE", "CUSTOM"]) {
      for (const bookType of [undefined, "custom", "short_story", "lead_magnet", "workbook"]) {
        for (const cadence of ["template-driven", "every-page", "every-third-page"]) {
          for (const targetPages of [4, 8, 12, 24, 40, 60]) {
            const input = appBook(category, targetPages, bookType, cadence);
            expect(interiorIllustrationSlotCount(input)).toBe(estimateInteriorImageCount(input));
          }
        }
      }
    }
  });

  it("bills and draws an Auto book at the cap the app quotes, whatever category its lane chose", () => {
    // Auto books are filed under their resolved lane's category now; the app
    // quotes Auto as `custom`, ceil(pages / 8), and so must the charge.
    const auto = (category: string, targetPages: number) => {
      const input = project("template-driven", category, targetPages);
      (input.mediaSettings as Record<string, unknown>).mobile = { bookType: "custom" };
      return input;
    };
    expect(estimateInteriorImageCount(auto("BUSINESS", 24))).toBe(3);
    expect(estimateInteriorImageCount(auto("EDUCATION", 24))).toBe(3);
    expect(estimateInteriorImageCount(auto("KIDS", 12))).toBe(2);
    expect(estimateInteriorImageCount(auto("CUSTOM", 5))).toBe(1);
    expect(interiorIllustrationSlotCount(auto("EDUCATION", 24))).toBe(3);
  });

  it("leaves an operator book, which no quote covers, every slot its cadence picks", () => {
    const operator = project("template-driven", "KIDS", 12);
    expect(interiorIllustrationSlotCount(operator)).toBe(12);
    expect(pageGetsInteriorIllustration(operator, 13)).toBe(true);
  });
});

