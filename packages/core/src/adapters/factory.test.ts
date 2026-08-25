import { describe, expect, it } from "vitest";
import { loadConfig } from "../config.js";
import { createProjectSchema } from "../schemas/book.js";
import { AlibabaImageAdapter, AlibabaTextAdapter } from "./alibaba.js";
import { DeepInfraAdapter } from "./deepinfra.js";
import { DeepSeekAdapter } from "./deepseek.js";
import { FakeTextModelAdapter } from "./fake.js";
import { GeminiTextAdapter } from "./gemini.js";
import { OpenAITextAdapter } from "./openai.js";
import {
  createLiveGenerationTextModel,
  createProviders,
  createRoutedTextModel,
  createTextModelAdapter,
  generationTextModelOptions,
  imageModelOptions,
  LiveGenerationTextModelAdapter,
  resolveImageModelSelection,
  resolveTextModelSelection,
  resolveTextModelSelections,
  textModelOptions
} from "./factory.js";
import { compiledGenerationTextModelRouting } from "./generationTextModelRouting.js";
import { RoutingTextModelAdapter } from "./textRouting.js";

describe("text model provider selection", () => {
  it("defaults to the configured DeepSeek model", () => {
    const config = testConfig({ DEEPSEEK_MODEL: "deepseek-live" });

    expect(resolveTextModelSelection(config)).toEqual({ provider: "deepseek", model: "deepseek-live" });
    expect(textModelOptions(config)[0]).toMatchObject({
      provider: "deepseek",
      model: "deepseek-live",
      label: "DeepSeek (deepseek-live)"
    });
    expect(
      textModelOptions(testConfig({ DEEPSEEK_MODEL: "deepseek-live", DEEPSEEK_FAST_MODEL: "deepseek-live" })).filter(
        (option) => option.provider === "deepseek"
      )
    ).toHaveLength(1);
  });

  it("constructs every selected text provider adapter", () => {
    const config = testConfig({});
    expect(createTextModelAdapter(config, { provider: "deepseek", model: "deepseek-writer" })).toBeInstanceOf(DeepSeekAdapter);
    expect(createTextModelAdapter(config, { provider: "deepinfra", model: "deepseek-ai/DeepSeek-V4-Pro" })).toBeInstanceOf(
      DeepInfraAdapter
    );
    expect(createTextModelAdapter(config, { provider: "gemini", model: "gemini-3.5-flash" })).toBeInstanceOf(
      GeminiTextAdapter
    );
    expect(createTextModelAdapter(config, { provider: "alibaba", model: "qwen-plus" })).toBeInstanceOf(
      AlibabaTextAdapter
    );
    expect(createTextModelAdapter(config, { provider: "openai", model: "gpt-5.6-sol" })).toBeInstanceOf(
      OpenAITextAdapter
    );
    expect((createTextModelAdapter(config, { provider: "deepinfra", model: "mistral-small-latest" }) as any).model).toBe(
      "mistralai/Mistral-Small-3.2-24B-Instruct-2506"
    );
  });

  it("keeps mock mode on fake text even when Gemini is selected", () => {
    const providers = createProviders(testConfig({ MOCK_AI: "true" }), projectInput({ provider: "gemini", model: "gemini-3.5-flash" }));

    expect(providers.text).toBeInstanceOf(FakeTextModelAdapter);
  });

  it("binds live fast judgments to the lightest available catalog adapter", async () => {
    expect(await boundFastJudgmentsAdapter({})).toBeInstanceOf(DeepSeekAdapter);
    expect(await boundFastJudgmentsAdapter({ DEEPSEEK_API_KEY: "" })).toBeInstanceOf(DeepInfraAdapter);
    expect(
      await boundFastJudgmentsAdapter({ DEEPSEEK_API_KEY: "", DEEPINFRA_API_KEY: "" })
    ).toBeInstanceOf(GeminiTextAdapter);
    expect(
      await boundFastJudgmentsAdapter({
        DEEPSEEK_API_KEY: "",
        DEEPINFRA_API_KEY: "",
        GEMINI_API_KEY: "",
        ALIBABA_API_KEY: "alibaba-key"
      })
    ).toBeInstanceOf(AlibabaTextAdapter);
    expect(await boundFastJudgmentsAdapter({ MOCK_AI: "true" })).toBeInstanceOf(FakeTextModelAdapter);
  });

  it("exposes DeepInfra effort options only when configured", () => {
    const configuredOptions = textModelOptions(testConfig({ DEEPINFRA_MODEL: "deepseek-ai/DeepSeek-V4-Pro" }));
    const deepInfraOptions = configuredOptions.filter((option) => option.provider === "deepinfra");
    const unconfiguredOptions = textModelOptions(testConfig({ DEEPINFRA_API_KEY: "" }));

    expect(deepInfraOptions).toEqual([
      expect.objectContaining({
        provider: "deepinfra",
        model: "deepseek-ai/DeepSeek-V4-Pro",
        label: "DeepInfra DeepSeek (deepseek-ai/DeepSeek-V4-Pro)",
        thinking: true,
        thinkingEfforts: [
          { value: "none", label: "Off", default: true },
          { value: "low", label: "Low" },
          { value: "medium", label: "Medium" },
          { value: "high", label: "High" }
        ]
      }),
      expect.objectContaining({
        provider: "deepinfra",
        model: "mistralai/Mistral-Small-3.2-24B-Instruct-2506",
        label: "DeepInfra Mistral Small 3.2 (mistralai/Mistral-Small-3.2-24B-Instruct-2506)"
      })
    ]);
    expect(deepInfraOptions[1]).not.toHaveProperty("thinking");
    expect(unconfiguredOptions.some((option) => option.provider === "deepinfra")).toBe(false);
    expect(
      textModelOptions(testConfig({ DEEPINFRA_MODEL: "mistral-small-latest" })).filter(
        (option) =>
          option.provider === "deepinfra" && option.model === "mistralai/Mistral-Small-3.2-24B-Instruct-2506"
      )
    ).toHaveLength(1);
  });

  it("marks reasoning-capable text models as thinking options", () => {
    const options = textModelOptions(testConfig({ DEEPSEEK_MODEL: "deepseek-v4-pro" }));
    const deepseekOptions = options.filter((option) => option.provider === "deepseek");
    const deepseekFast = deepseekOptions.find((option) => option.model === "deepseek-v4-flash");
    const gemini37Flash = options.find((option) => option.provider === "gemini" && option.model === "gemini-3.7-flash");
    const gemini35Flash = options.find((option) => option.provider === "gemini" && option.model === "gemini-3.5-flash");

    expect(deepseekOptions).toHaveLength(2);
    expect(deepseekOptions[0]).toMatchObject({
      provider: "deepseek",
      model: "deepseek-v4-pro",
      thinking: true,
      thinkingEfforts: [
        { value: "none", label: "Off", default: true },
        { value: "high", label: "High" },
        { value: "max", label: "Max" }
      ]
    });
    expect(deepseekFast).toMatchObject({
      provider: "deepseek",
      model: "deepseek-v4-flash",
      label: "DeepSeek Fast (deepseek-v4-flash)",
      thinking: true,
      thinkingEfforts: [
        { value: "none", label: "Off", default: true },
        { value: "high", label: "High" },
        { value: "max", label: "Max" }
      ]
    });
    expect(options).toContainEqual(
      expect.objectContaining({ provider: "alibaba", model: "qwen3.7-plus", thinking: true })
    );
    expect(options).toContainEqual(
      expect.objectContaining({ provider: "alibaba", model: "qwen3.5-plus", thinking: true })
    );
    expect(options).toContainEqual(
      expect.objectContaining({ provider: "alibaba", model: "qwen3.8-max", thinking: true })
    );
    expect(options.filter((option) => option.provider === "openai")).toEqual([
      expect.objectContaining({ provider: "openai", model: "gpt-5.6-sol", label: "GPT-5.6 Sol" }),
      expect.objectContaining({ provider: "openai", model: "gpt-5.6-terra", label: "GPT-5.6 Terra" }),
      expect.objectContaining({ provider: "openai", model: "gpt-5.6-luna", label: "GPT-5.6 Luna" })
    ]);
    expect(options.find((option) => option.provider === "openai")?.thinkingEfforts).toEqual([
      { value: "none", label: "Off" },
      { value: "low", label: "Low" },
      { value: "medium", label: "Medium", default: true },
      { value: "high", label: "High" },
      { value: "xhigh", label: "Extra high" },
      { value: "max", label: "Max" }
    ]);
    expect(generationTextModelOptions(testConfig({})).find((option) => option.model === "gpt-5.6-luna")?.costs).toEqual([
      expect.objectContaining({ inputPerMillion: 0.2, outputPerMillion: 1.2 }),
      expect.objectContaining({ inputPerMillion: 0.4, outputPerMillion: 1.8 })
    ]);
    const geminiFlashThinkingEfforts = [
      { value: "minimal", label: "Minimal" },
      { value: "low", label: "Low" },
      { value: "medium", label: "Medium", default: true },
      { value: "high", label: "High" }
    ];
    expect(gemini37Flash).toMatchObject({
      provider: "gemini",
      model: "gemini-3.7-flash",
      label: "Gemini 3.7 Flash",
      thinking: true,
      thinkingEfforts: geminiFlashThinkingEfforts
    });
    expect(gemini35Flash).toMatchObject({
      provider: "gemini",
      model: "gemini-3.5-flash",
      label: "Gemini 3.5 Flash",
      thinking: true,
      thinkingEfforts: geminiFlashThinkingEfforts
    });
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
    expect(
      generationTextModelOptions(testConfig({})).find(
        (option) => option.provider === "gemini" && option.model === "gemini-2.5-flash-lite"
      )
    ).toMatchObject({
      provider: "gemini",
      model: "gemini-2.5-flash-lite",
      thinkingBudget: 0
    });
  });

  it("maps quality tiers to prose/mechanical/image model selections", () => {
    const config = testConfig({});

    expect(resolveTextModelSelections(config, tierProjectInput("premium"))).toEqual({
      prose: { provider: "gemini", model: "gemini-2.5-pro", thinkingBudget: 2048 },
      mechanical: { provider: "gemini", model: "gemini-2.5-flash", thinkingBudget: 0 },
      tier: "premium"
    });
    expect(resolveTextModelSelections(config, tierProjectInput("ultra"))).toEqual({
      prose: { provider: "gemini", model: "gemini-2.5-pro", thinkingBudget: 2048 },
      mechanical: { provider: "gemini", model: "gemini-2.5-flash", thinkingBudget: 0 },
      tier: "ultra"
    });
    expect(resolveTextModelSelections(config, tierProjectInput("balanced"))).toEqual({
      prose: { provider: "deepseek", model: "deepseek-v4-pro" },
      mechanical: { provider: "deepseek", model: "deepseek-v4-flash", thinkingEnabled: false },
      tier: "balanced"
    });
    expect(resolveTextModelSelections(config, tierProjectInput("fast"))).toEqual({
      prose: { provider: "deepseek", model: "deepseek-v4-flash", thinkingEnabled: false },
      mechanical: { provider: "deepseek", model: "deepseek-v4-flash", thinkingEnabled: false },
      tier: "fast"
    });
    expect(resolveImageModelSelection(config, tierProjectInput("premium"))).toEqual({
      provider: "gemini",
      model: "gemini-3.1-flash-image"
    });
    expect(resolveImageModelSelection(config, tierProjectInput("ultra"))).toEqual({
      provider: "gemini",
      model: "gemini-3.1-flash-image"
    });
    expect(resolveImageModelSelection(config, tierProjectInput("balanced"))).toEqual({
      provider: "gemini",
      model: config.GEMINI_IMAGE_MODEL
    });
  });

  it("wraps tiered providers in a routing adapter only when models differ", () => {
    const config = testConfig({});

    expect(createProviders(config, tierProjectInput("premium")).text).toBeInstanceOf(RoutingTextModelAdapter);
    expect(createProviders(config, tierProjectInput("ultra")).text).toBeInstanceOf(RoutingTextModelAdapter);
    const ultra = createProviders(config, tierProjectInput("ultra")).text as RoutingTextModelAdapter;
    expect(ultra.selectionForPurpose("plan-book").thinkingBudget).toBe(8192);
    expect(ultra.selectionForPurpose("generate-page").thinkingBudget).toBe(2048);
    expect(ultra.selectionForPurpose("generate-page-map").thinkingBudget).toBe(1024);
    const premium = createProviders(config, tierProjectInput("premium")).text as RoutingTextModelAdapter;
    expect(premium.selectionForPurpose("plan-book").thinkingBudget).toBe(4096);
    expect(premium.selectionForPurpose("generate-page").thinkingBudget).toBe(2048);
    expect(createProviders(config, tierProjectInput("balanced")).text).toBeInstanceOf(RoutingTextModelAdapter);
    expect(createProviders(config, tierProjectInput("fast")).text).toBeInstanceOf(DeepSeekAdapter);
    expect(createProviders(config).text).toBeInstanceOf(DeepSeekAdapter);
  });

  it("ignores legacy project model pins when resolving the construction delegate", () => {
    const config = testConfig({ GEMINI_API_KEY: "" });
    const input = tierProjectInput("premium", { provider: "gemini", model: "gemini-retired" });

    expect(resolveTextModelSelections(config, input)).toEqual({
      prose: { provider: "deepseek", model: "deepseek-v4-pro" },
      mechanical: { provider: "deepseek", model: "deepseek-v4-flash", thinkingEnabled: false },
      tier: "premium"
    });
    expect(() => createRoutedTextModel(config, resolveTextModelSelections(config, input))).not.toThrow();
  });

  it("keeps legacy inputs without a tier on the single default model", () => {
    const config = testConfig({ DEEPSEEK_MODEL: "deepseek-live" });
    const legacy = resolveTextModelSelections(config);

    expect(legacy.prose).toEqual({ provider: "deepseek", model: "deepseek-live" });
    expect(legacy.mechanical).toEqual({ provider: "deepseek", model: "deepseek-live" });
    expect(legacy.tier).toBeUndefined();
  });

  it("keeps mock mode on fake adapters for tiered inputs", () => {
    const providers = createProviders(testConfig({ MOCK_AI: "true" }), tierProjectInput("premium"));

    expect(providers.text).toBeInstanceOf(FakeTextModelAdapter);
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

async function boundFastJudgmentsAdapter(overrides: NodeJS.ProcessEnv) {
  const config = testConfig(overrides);
  const live = createLiveGenerationTextModel(config, {
    fastJudgments: true,
    loadRouting: async () => compiledGenerationTextModelRouting(config, generationTextModelOptions(config))
  });
  if (!(live instanceof LiveGenerationTextModelAdapter)) {
    throw new Error("expected LiveGenerationTextModelAdapter");
  }
  return (await live.bindForCall(undefined)).adapter;
}

function testConfig(overrides: NodeJS.ProcessEnv) {
  return loadConfig({
    DEEPSEEK_API_KEY: "deepseek-key",
    DEEPINFRA_API_KEY: "deepinfra-key",
    GEMINI_API_KEY: "gemini-key",
    ALIBABA_API_KEY: "alibaba-key",
    OPENAI_API_KEY: "openai-key",
    MOCK_AI: "false",
    ...overrides
  });
}

function projectInput(
  textModel: { provider: "deepseek" | "deepinfra" | "gemini" | "alibaba" | "openai"; model: string },
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
      generationStrategy: "chaptered-sequential",
      textModel,
      ...(imageModel ? { imageModel } : {}),
      toneProfile: "neutral"
    }
  });
}

function tierProjectInput(
  modelTier: "fast" | "balanced" | "premium" | "ultra",
  textModel?: { provider: "deepseek" | "deepinfra" | "gemini" | "alibaba" | "openai"; model: string }
) {
  return createProjectSchema.parse({
    prompt: "A practical book about choosing the right generation model for long-form writing.",
    mediaSettings: {
      fullIllustrations: true,
      illustrationCadence: "template-driven",
      includeCover: true,
      coverTemplate: "auto",
      finalReview: true,
      toneProfile: "neutral",
      modelTier,
      ...(textModel ? { textModel } : {})
    }
  });
}
