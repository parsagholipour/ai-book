import { describe, expect, it } from "vitest";
import type { BookPlan, Project } from "../../api.js";
import {
  CUSTOM_SUBCATEGORY_VALUE,
  draftFromSavedInputs,
  initialDraft,
  projectInputFromDraft
} from "./draft.js";

describe("project draft helpers", () => {
  it("builds project input with custom subcategories and kid-specific settings", () => {
    const input = projectInputFromDraft({
      ...initialDraft,
      category: "KIDS",
      subcategory: CUSTOM_SUBCATEGORY_VALUE,
      customSubcategory: "Moon etiquette"
    });

    expect(input.subcategory).toBe("Moon etiquette");
    expect(input.mediaSettings.audienceAgeRange).toBe("4-6");
    expect(input.mediaSettings).not.toHaveProperty("textModel");
  });

  it("hydrates saved inputs while normalizing custom fields and kid-safe settings", () => {
    const draft = draftFromSavedInputs({
      id: "project-1",
      title: "Fallback title",
      prompt: "Fallback prompt",
      category: "BUSINESS",
      subcategory: "Fallback",
      targetPages: 32,
      complexity: 5,
      temperature: 0.7,
      status: "PLAN_READY",
      currentPlan: {
        id: "plan-1",
        version: 1,
        status: "DRAFT",
        planningPackage: {} as BookPlan,
        messages: [],
        inputSnapshot: {
          title: "Saved title",
          prompt: "Saved prompt",
          category: "KIDS",
          subcategory: "Tiny lunar mystery",
          targetPages: 999,
          complexity: 22,
          temperature: 5,
          mediaSettings: {
            audienceAgeRange: "6-8",
            toneProfile: "scholarly"
          }
        }
      }
    } as Project);

    expect(draft.title).toBe("Saved title");
    expect(draft.category).toBe("KIDS");
    expect(draft.subcategory).toBe(CUSTOM_SUBCATEGORY_VALUE);
    expect(draft.customSubcategory).toBe("Tiny lunar mystery");
    expect(draft.targetPages).toBe(600);
    expect(draft.complexity).toBe(10);
    expect(draft.temperature).toBe(2);
    expect(draft.audienceAgeRange).toBe("6-8");
    expect(draft.toneProfile).toBe("scholarly");
  });
});
