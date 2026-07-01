import { describe, expect, it } from "vitest";
import type { BookPlan, Project } from "../../api.js";
import {
  CUSTOM_SUBCATEGORY_VALUE,
  DEFAULT_TEXT_MODEL_OPTIONS,
  draftFromSavedInputs,
  initialDraft,
  projectInputFromDraft,
  resolveTextModelOption,
  textModelKey,
  textModelLabel,
  textModelSelectionFromKey,
  textModelSelectionFromOption,
  textModelSelectionFromValue,
  textModelSelectionWithEffort,
  textModelThinkingEffortValue
} from "./draft.js";

describe("project draft helpers", () => {
  it("builds project input with custom subcategories and kid-specific settings", () => {
    const input = projectInputFromDraft(
      {
        ...initialDraft,
        category: "KIDS",
        subcategory: CUSTOM_SUBCATEGORY_VALUE,
        customSubcategory: "Moon etiquette"
      },
      DEFAULT_TEXT_MODEL_OPTIONS
    );

    expect(input.subcategory).toBe("Moon etiquette");
    expect(input.mediaSettings.audienceAgeRange).toBe("4-6");
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

  it("falls back to the first available text model option", () => {
    expect(resolveTextModelOption([], { provider: "gemini", model: "unknown" })).toEqual(DEFAULT_TEXT_MODEL_OPTIONS[0]);
  });

  it("round-trips effort-aware DeepInfra text model selections", () => {
    const effortOption = {
      provider: "deepinfra" as const,
      model: "deepseek-ai/DeepSeek-V4-Pro",
      label: "DeepInfra DeepSeek (deepseek-ai/DeepSeek-V4-Pro)",
      thinking: true,
      thinkingEfforts: [
        { value: "none" as const, label: "Off", default: true },
        { value: "low" as const, label: "Low" },
        { value: "medium" as const, label: "Medium" },
        { value: "high" as const, label: "High" }
      ]
    };
    const mediumSelection = textModelSelectionWithEffort(effortOption, "medium");

    expect(textModelSelectionFromValue({ ...effortOption, thinkingEnabled: true })).toEqual({
      provider: "deepinfra",
      model: "deepseek-ai/DeepSeek-V4-Pro",
      thinkingEnabled: true
    });
    expect(textModelSelectionFromOption(effortOption, mediumSelection)).toEqual({
      provider: "deepinfra",
      model: "deepseek-ai/DeepSeek-V4-Pro",
      thinkingEnabled: true,
      thinkingEffort: "medium"
    });
    expect(textModelSelectionFromKey(textModelKey(effortOption), [effortOption])).toEqual({
      provider: "deepinfra",
      model: "deepseek-ai/DeepSeek-V4-Pro",
      thinkingEnabled: false,
      thinkingEffort: "none"
    });
    expect(textModelThinkingEffortValue({ ...effortOption, thinkingEnabled: true }, effortOption)).toBe("high");
    expect(textModelLabel(effortOption)).toBe("DeepInfra DeepSeek (deepseek-ai/DeepSeek-V4-Pro)");
  });

  it("round-trips effort-aware Gemini 3.5 Flash selections", () => {
    const effortOption = {
      provider: "gemini" as const,
      model: "gemini-3.5-flash",
      label: "Gemini 3.5 Flash",
      thinking: true,
      thinkingEfforts: [
        { value: "minimal" as const, label: "Minimal" },
        { value: "low" as const, label: "Low" },
        { value: "medium" as const, label: "Medium", default: true },
        { value: "high" as const, label: "High" }
      ]
    };
    const minimalSelection = textModelSelectionWithEffort(effortOption, "minimal");

    expect(textModelSelectionFromValue({ ...effortOption, thinkingEffort: "minimal" })).toEqual({
      provider: "gemini",
      model: "gemini-3.5-flash",
      thinkingEffort: "minimal"
    });
    expect(textModelSelectionFromOption(effortOption)).toEqual({
      provider: "gemini",
      model: "gemini-3.5-flash",
      thinkingEnabled: true,
      thinkingEffort: "medium"
    });
    expect(textModelSelectionFromOption(effortOption, minimalSelection)).toEqual({
      provider: "gemini",
      model: "gemini-3.5-flash",
      thinkingEnabled: true,
      thinkingEffort: "minimal"
    });
    expect(textModelLabel(effortOption)).toBe("Gemini 3.5 Flash");
  });
});
