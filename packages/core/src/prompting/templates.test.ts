import { describe, expect, it } from "vitest";
import { BOOK_CATEGORIES } from "../categories.js";
import { getTemplateForInput, makeFallbackPlan, templateDefinitions } from "./templates.js";
import type { CreateProjectInput } from "../schemas/book.js";

describe("general book template", () => {
  it("has a seed template for every top-level book category", () => {
    const templateCategories = templateDefinitions.map((template) => template.category).sort();

    expect(templateCategories).toEqual([...BOOK_CATEGORIES].sort());
  });

  it("uses source-aware fallback plans for fact-heavy categories", () => {
    const plan = makeFallbackPlan({
      ...generalInput(),
      category: "HEALTH",
      subcategory: "Medicine & patient education"
    });

    expect(plan.audience).toMatch(/evidence-aware wellness/i);
    expect(plan.researchQueries).toEqual([plan.premise]);
  });

  it("uses a neutral template for General instead of Story defaults", () => {
    const input = generalInput();
    const template = getTemplateForInput(input);
    const plan = makeFallbackPlan(input);

    expect(template.category).toBe("CUSTOM");
    expect(template.slug).toBe("general-book");
    expect(plan.audience).toBe("Readers implied by the user's prompt");
    expect(plan.voiceGuide.join(" ")).not.toMatch(/character-led stories/i);
    expect(plan.chapters[0]?.title).toBe("Chapter 1: Opening");
    expect(plan.researchQueries).toEqual([]);
  });

  it("does not let a General subcategory force research", () => {
    const plan = makeFallbackPlan({
      ...generalInput(),
      subcategory: "Social / Society & culture"
    });

    expect(plan.researchQueries).toEqual([]);
  });

  it("reflects the selected Kids age range in fallback audiences and voice guidance", () => {
    const youngerPlan = makeFallbackPlan(kidsInput("2-4"));
    const defaultPlan = makeFallbackPlan(kidsInput(undefined));

    expect(youngerPlan.audience).toBe("children ages 2-4 and read-aloud adults");
    expect(youngerPlan.voiceGuide.join(" ")).toMatch(/8-35 words per page/i);
    expect(defaultPlan.audience).toBe("children ages 4-6 and read-aloud adults");
    expect(defaultPlan.voiceGuide.join(" ")).toMatch(/20-65 words per page/i);
  });
});

function generalInput(): CreateProjectInput {
  return {
    prompt: "A reflective book about neighborhood rituals and shared public spaces.",
    category: "CUSTOM",
    targetPages: 48,
    complexity: 5,
    temperature: 0.7,
    language: "en",
    mediaSettings: {
      fullIllustrations: true,
      illustrationCadence: "template-driven",
      includeCover: true,
      coverTemplate: "auto",
      finalReview: true,
      lessCensored: false,
      toneProfile: "neutral" as const
    }
  };
}

function kidsInput(ageRange: "2-4" | "4-6" | "6-8" | undefined): CreateProjectInput {
  return {
    ...generalInput(),
    prompt: "A simple picture book about a turtle and a rabbit learning to race kindly.",
    category: "KIDS",
    targetPages: 12,
    complexity: 3,
    mediaSettings: {
      ...generalInput().mediaSettings,
      ...(ageRange ? { audienceAgeRange: ageRange } : {})
    }
  };
}
