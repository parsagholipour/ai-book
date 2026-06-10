import { describe, expect, it } from "vitest";
import { loadConfig } from "../config.js";
import { createProjectSchema } from "../schemas/book.js";
import { AlibabaImageAdapter, AlibabaTextAdapter } from "./alibaba.js";
import { DeepInfraAdapter } from "./deepinfra.js";
import { DeepSeekAdapter } from "./deepseek.js";
import { FakeTextModelAdapter } from "./fake.js";
import { GeminiTextAdapter } from "./gemini.js";
import {
  createLanguageDetectionTextModel,
  createProviders,
  imageModelOptions,
  resolveImageModelSelection,
  resolveTextModelSelection,
  textModelOptions
} from "./factory.js";

describe("text model provider selection", () => {
  it("defaults to the configured DeepSeek model", () => {
    const config = testConfig({ DEEPSEEK_MODEL: "deepseek-live" });

    expect(resolveTextModelSelection(config)).toEqual({ provider: "deepseek", model: "deepseek-live" });
    expect(textModelOptions(config)[0]).toMatchObject({
      provider: "deepseek",
      model: "deepseek-live",
      label: "DeepSeek (deepseek-live)"
    });
  });

  it("uses the selected text provider adapter", () => {
    const config = testConfig({});
    const deepseekInput = projectInput({ provider: "deepseek", model: "deepseek-writer" });
    const deepInfraInput = projectInput({ provider: "deepinfra", model: "deepseek-ai/DeepSeek-V4-Pro" });
    const geminiInput = projectInput({ provider: "gemini", model: "gemini-3.5-flash" });
    const alibabaInput = projectInput({ provider: "alibaba", model: "qwen-plus" });

    expect(resolveTextModelSelection(config, deepseekInput)).toEqual({
      provider: "deepseek",
      model: "deepseek-writer"
    });
    expect(createProviders(config, deepseekInput).text).toBeInstanceOf(DeepSeekAdapter);
    expect(createProviders(config, deepInfraInput).text).toBeInstanceOf(DeepInfraAdapter);
    expect(createProviders(config, geminiInput).text).toBeInstanceOf(GeminiTextAdapter);
    expect(createProviders(config, alibabaInput).text).toBeInstanceOf(AlibabaTextAdapter);
  });

  it("keeps mock mode on fake text even when Gemini is selected", () => {
    const providers = createProviders(testConfig({ MOCK_AI: "true" }), projectInput({ provider: "gemini", model: "gemini-3.5-flash" }));

    expect(providers.text).toBeInstanceOf(FakeTextModelAdapter);
  });

  it("uses the lightest available text adapter for language detection", () => {
    expect(createLanguageDetectionTextModel(testConfig({}))).toBeInstanceOf(DeepSeekAdapter);
    expect(createLanguageDetectionTextModel(testConfig({ DEEPSEEK_API_KEY: "" }))).toBeInstanceOf(DeepInfraAdapter);
    expect(
      createLanguageDetectionTextModel(testConfig({ DEEPSEEK_API_KEY: "", DEEPINFRA_API_KEY: "" }))
    ).toBeInstanceOf(GeminiTextAdapter);
    expect(
      createLanguageDetectionTextModel(testConfig({ DEEPSEEK_API_KEY: "", DEEPINFRA_API_KEY: "", GEMINI_API_KEY: "", ALIBABA_API_KEY: "alibaba-key" }))
    ).toBeInstanceOf(AlibabaTextAdapter);
    expect(createLanguageDetectionTextModel(testConfig({ MOCK_AI: "true" }))).toBeInstanceOf(FakeTextModelAdapter);
  });

  it("exposes DeepInfra normal and thinking options only when configured", () => {
    const configuredOptions = textModelOptions(testConfig({ DEEPINFRA_MODEL: "deepseek-ai/DeepSeek-V4-Pro" }));
    const deepInfraOptions = configuredOptions.filter((option) => option.provider === "deepinfra");
    const unconfiguredOptions = textModelOptions(testConfig({ DEEPINFRA_API_KEY: "" }));

    expect(deepInfraOptions).toEqual([
      expect.objectContaining({
        provider: "deepinfra",
        model: "deepseek-ai/DeepSeek-V4-Pro",
        label: "DeepInfra DeepSeek (deepseek-ai/DeepSeek-V4-Pro)"
      }),
      expect.objectContaining({
        provider: "deepinfra",
        model: "deepseek-ai/DeepSeek-V4-Pro",
        thinking: true,
        thinkingEnabled: true
      })
    ]);
    expect(deepInfraOptions[0]).not.toEqual(deepInfraOptions[1]);
    expect(unconfiguredOptions.some((option) => option.provider === "deepinfra")).toBe(false);
  });

  it("marks reasoning-capable text models as thinking options", () => {
    const options = textModelOptions(testConfig({ DEEPSEEK_MODEL: "deepseek-v4-pro" }));

    expect(options).toContainEqual(expect.objectContaining({ provider: "deepseek", model: "deepseek-v4-pro" }));
    expect(options.find((option) => option.provider === "deepseek" && option.model === "deepseek-v4-pro")).not.toHaveProperty(
      "thinking"
    );
    expect(options).toContainEqual(
      expect.objectContaining({
        provider: "deepseek",
        model: "deepseek-v4-pro",
        thinking: true,
        thinkingEnabled: true
      })
    );
    expect(options).toContainEqual(
      expect.objectContaining({ provider: "alibaba", model: "qwen3.5-plus", thinking: true })
    );
    expect(options).toContainEqual(
      expect.objectContaining({ provider: "gemini", model: "gemini-2.5-flash", thinking: true })
    );
    expect(options).toContainEqual(
      expect.objectContaining({
        provider: "gemini",
        model: "gemini-2.5-flash",
        label: "Gemini 2.5 Flash (No Thinking)",
        thinkingBudget: 0
      })
    );
    expect(options.find((option) => option.provider === "gemini" && option.model === "gemini-2.5-flash-lite")).not.toHaveProperty(
      "thinking"
    );
  });

  it("uses selected image model and exposes configured image options", () => {
    const config = testConfig({ GEMINI_IMAGE_MODEL: "gemini-3-pro-image-preview" });
    const input = projectInput(
      { provider: "gemini", model: "gemini-3.5-flash" },
      { provider: "gemini", model: "models/imagen-4.0-fast-generate-preview-06-06" }
    );
    const alibabaInput = projectInput(
      { provider: "alibaba", model: "qwen-plus" },
      { provider: "alibaba", model: "qwen-image-2.0" }
    );

    expect(resolveImageModelSelection(config)).toEqual({ provider: "gemini", model: "gemini-3-pro-image-preview" });
    expect(resolveImageModelSelection(config, input)).toEqual({
      provider: "gemini",
      model: "imagen-4.0-fast-generate-001"
    });
    expect(imageModelOptions(config)[0]).toMatchObject({
      provider: "gemini",
      model: "gemini-3-pro-image-preview",
      supportsReferenceImages: true
    });
    expect(imageModelOptions(config)).toContainEqual(
      expect.objectContaining({
        provider: "alibaba",
        model: "qwen-image-2.0",
        label: "Qwen Image 2.0",
        supportsReferenceImages: true
      })
    );
    expect(createProviders(config, alibabaInput).image).toBeInstanceOf(AlibabaImageAdapter);
  });
});

function testConfig(overrides: NodeJS.ProcessEnv) {
  return loadConfig({
    DEEPSEEK_API_KEY: "deepseek-key",
    DEEPINFRA_API_KEY: "deepinfra-key",
    GEMINI_API_KEY: "gemini-key",
    ALIBABA_API_KEY: "alibaba-key",
    MOCK_AI: "false",
    ...overrides
  });
}

function projectInput(
  textModel: { provider: "deepseek" | "deepinfra" | "gemini" | "alibaba"; model: string },
  imageModel?: { provider: "gemini" | "alibaba"; model: string }
) {
  return createProjectSchema.parse({
    prompt: "A practical book about choosing the right generation model for long-form writing.",
    mediaSettings: {
      fullIllustrations: true,
      illustrationCadence: "template-driven",
      includeCover: true,
      coverTemplate: "auto",
      finalReview: true,
      lessCensored: false,
      generationStrategy: "chaptered-sequential",
      textModel,
      ...(imageModel ? { imageModel } : {}),
      toneProfile: "neutral"
    }
  });
}
