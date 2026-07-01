import { describe, expect, it } from "vitest";
import { inputForPlanVersion, inputWithMessageMediaPreferences } from "./projectInput.js";

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

  it("ignores project ownership metadata when resolving worker input", () => {
    const ownedProject = { ...projectSource(), userId: "user-1" };
    const input = inputForPlanVersion(ownedProject, null);

    expect(input.prompt).toContain("project row prompt");
    expect(input.mediaSettings.generationStrategy).toBe("chaptered-sequential");
  });

  it("turns negative image and cover revision messages into generation flags", () => {
    const input = inputForPlanVersion(
      {
        ...projectSource(),
        mediaSettings: {
          ...projectSource().mediaSettings,
          mobile: { imagesEnabled: true, bookType: "short_story" }
        }
      },
      null
    );

    const updated = inputWithMessageMediaPreferences(input, "I don't want images or covers");

    expect(updated.mediaSettings.fullIllustrations).toBe(false);
    expect(updated.mediaSettings.illustrationCadence).toBe("manual");
    expect(updated.mediaSettings.includeCover).toBe(false);
    expect(updated.mediaSettings.mobile).toMatchObject({ imagesEnabled: false, bookType: "short_story" });
  });

  it("can disable covers without disabling page illustrations", () => {
    const input = inputForPlanVersion(projectSource(), null);

    const updated = inputWithMessageMediaPreferences(input, "without covers");

    expect(updated.mediaSettings.fullIllustrations).toBe(true);
    expect(updated.mediaSettings.illustrationCadence).toBe("template-driven");
    expect(updated.mediaSettings.includeCover).toBe(false);
  });

  it("leaves media settings alone for unrelated plan revisions", () => {
    const input = inputForPlanVersion(projectSource(), null);

    expect(inputWithMessageMediaPreferences(input, "Make the audience parents.")).toBe(input);
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
      generationStrategy: "chaptered-sequential",
      textModel: {
        provider: "deepseek",
        model: "deepseek-project"
      },
      toneProfile: "neutral"
    }
  };
}
