import { describe, expect, it } from "vitest";
import { inputForPlanVersion } from "./projectInput.js";

describe("worker project input resolution", () => {
  it("prefers the plan input snapshot so generation keeps the saved text model", () => {
    const input = inputForPlanVersion(projectSource(), {
      prompt: "A saved planning prompt with enough detail to parse correctly.",
      category: "STORY",
      targetPages: 12,
      complexity: 6,
      temperature: 0.5,
      language: "en",
      mediaSettings: {
        fullIllustrations: false,
        illustrationCadence: "template-driven",
        includeCover: false,
        coverTemplate: "auto",
        finalReview: true,
        lessCensored: false,
        generationStrategy: "draft-then-polish",
        textModel: {
          provider: "gemini",
          model: "gemini-3.5-flash"
        },
        toneProfile: "neutral"
      }
    });

    expect(input.prompt).toContain("saved planning prompt");
    expect(input.mediaSettings.generationStrategy).toBe("draft-then-polish");
    expect(input.mediaSettings.textModel).toEqual({ provider: "gemini", model: "gemini-3.5-flash" });
  });

  it("falls back to the project row when a legacy plan has no valid snapshot", () => {
    const input = inputForPlanVersion(projectSource(), null);

    expect(input.prompt).toContain("project row prompt");
    expect(input.mediaSettings.textModel).toEqual({ provider: "deepseek", model: "deepseek-project" });
  });
});

function projectSource() {
  return {
    title: "Saved Model Test",
    subtitle: null,
    authorName: null,
    coverTagline: null,
    prompt: "A project row prompt with enough detail to parse correctly.",
    category: "STORY",
    subcategory: null,
    targetPages: 10,
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
      generationStrategy: "chaptered-sequential",
      textModel: {
        provider: "deepseek",
        model: "deepseek-project"
      },
      toneProfile: "neutral"
    }
  };
}
