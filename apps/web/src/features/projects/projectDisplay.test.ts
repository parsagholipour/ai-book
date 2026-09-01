import { describe, expect, it } from "vitest";
import type { Project } from "../../api.js";
import { formatProjectAiModels, modelProviderLabel, modelSelectionLabel } from "./projectDisplay.js";

describe("project display helpers", () => {
  it("describes text generation as centrally routed instead of showing a stale project model", () => {
    expect(
      formatProjectAiModels(
        { mediaSettings: { fullIllustrations: false, coverArtSource: "design" } } as Project,
        []
      )
    ).toBe("Text Quality routing");
  });

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

  it("labels OpenRouter GLM text model selections", () => {
    expect(modelProviderLabel("openrouter")).toBe("OpenRouter");
    expect(
      modelSelectionLabel({
        provider: "openrouter",
        model: "z-ai/glm-5.3-flash",
        thinkingEffort: "high"
      })
    ).toBe("OpenRouter z-ai/glm-5.3-flash (High Effort)");
  });

  it("labels Gemini effort-aware text model selections", () => {
    expect(
      modelSelectionLabel({
        provider: "gemini",
        model: "gemini-3.5-flash",
        thinkingEffort: "minimal"
      })
    ).toBe("Gemini gemini-3.5-flash (Minimal Effort)");
  });
});
