import { describe, expect, it } from "vitest";
import { modelProviderLabel, modelSelectionLabel } from "./projectDisplay.js";

describe("project display helpers", () => {
  it("labels DeepInfra text model selections", () => {
    expect(modelProviderLabel("deepinfra")).toBe("DeepInfra");
    expect(
      modelSelectionLabel({
        provider: "deepinfra",
        model: "deepseek-ai/DeepSeek-V4-Pro",
        thinkingEnabled: true
      })
    ).toBe("DeepInfra deepseek-ai/DeepSeek-V4-Pro (Thinking)");
  });
});
