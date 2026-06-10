import { describe, expect, it } from "vitest";
import type { Project } from "../../api.js";
import { modelProviderLabel, modelSelectionLabel, projectTextModelLabel } from "./projectDisplay.js";

describe("project display helpers", () => {
  it("labels DeepInfra text model selections", () => {
    expect(modelProviderLabel("deepinfra")).toBe("DeepInfra");
    expect(
      modelSelectionLabel({
        provider: "deepinfra",
        model: "deepseek-ai/DeepSeek-V4-Pro",
        thinkingEnabled: true,
        thinkingEffort: "medium"
      })
    ).toBe("DeepInfra deepseek-ai/DeepSeek-V4-Pro (Medium Effort)");
  });

  it("labels Gemini effort-aware text model selections", () => {
    const option = {
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

    expect(
      modelSelectionLabel({
        provider: "gemini",
        model: "gemini-3.5-flash",
        thinkingEffort: "minimal"
      })
    ).toBe("Gemini gemini-3.5-flash (Minimal Effort)");
    expect(
      projectTextModelLabel(
        {
          mediaSettings: {
            textModel: {
              provider: "gemini",
              model: "gemini-3.5-flash",
              thinkingEffort: "minimal"
            }
          }
        } as Project,
        [option]
      )
    ).toBe("Gemini 3.5 Flash (Minimal Effort)");
  });
});
