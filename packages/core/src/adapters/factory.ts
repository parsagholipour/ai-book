import type { AppConfig } from "../config.js";
import { alibabaImageModelOptions, alibabaTextModelOptions } from "./alibabaModels.js";
import { deepInfraTextModelOptions, normalizeDeepInfraTextModel } from "./deepinfraModels.js";
import { geminiImageModelOptions } from "./geminiModels.js";
import { AlibabaImageAdapter, AlibabaTextAdapter } from "./alibaba.js";
import { DeepInfraAdapter } from "./deepinfra.js";
import { DeepSeekAdapter } from "./deepseek.js";
import { OpenAITextAdapter } from "./openai.js";
import { OpenAICompatibleTextAdapter } from "./openaiCompatible.js";
import { openAITextModelOptions } from "./openaiModels.js";
import { FakeEmbeddingAdapter, FakeImageAdapter, FakeResearchAdapter, FakeSpeechAdapter, FakeTextModelAdapter } from "./fake.js";
import { GeminiEmbeddingAdapter, GeminiImageAdapter, GeminiResearchAdapter, GeminiTextAdapter } from "./gemini.js";
import { GeminiSpeechAdapter } from "./geminiSpeech.js";
import { OpenAISpeechAdapter } from "./openaiSpeech.js";
import type {
  EmbeddingAdapter,
  GenerateJsonOptions,
  GenerateTextOptions,
  GenerateWithToolsOptions,
  ImageAdapter,
  ResearchAdapter,
  SpeechAdapter,
  TextModelAdapter
} from "./types.js";
import {
  MECHANICAL_TEXT_PURPOSES,
  modelTierImageSelection,
  modelTierForInput,
  planThinkingBudgetForTier,
  ULTRA_PAGE_MAP_THINKING_BUDGET
} from "./modelTiers.js";
import { RoutingTextModelAdapter } from "./textRouting.js";
import {
  compiledGenerationTextModelRouting,
  generationTextModelOptionKey,
  routingSelection,
  textModelSelectionKey,
  type GenerationTextModelOption,
  type GenerationTextModelRole,
  type GenerationTextModelRouting
} from "./generationTextModelRouting.js";
import type {
  CreateProjectInput,
  ImageModelSelection,
  ModelTier,
  TextModelSelection,
  TextModelThinkingEffort
} from "../schemas/book.js";

export type ProviderSet = {
  text: TextModelAdapter;
  research: ResearchAdapter;
  image: ImageAdapter;
  embedding: EmbeddingAdapter;
  speech: SpeechAdapter;
};

export type SpeechProviderId = "gemini_tts" | "openai_tts";
export type SpeechModelSelection = { provider: SpeechProviderId; model: string };

export type TextModelOption = TextModelSelection & {
  label: string;
  preview?: boolean;
  thinking?: boolean;
  thinkingEfforts?: TextModelThinkingEffortOption[];
};

export type TextModelThinkingEffortOption = {
  value: TextModelThinkingEffort;
  label: string;
  default?: boolean;
};

export type ImageModelProviderOption = ImageModelSelection & {
  label: string;
  costUsd?: number;
  supportsReferenceImages: boolean;
  description?: string;
};
export type ImageModelOption = ImageModelProviderOption;

const GEMINI_FLASH_THINKING_LEVEL_EFFORTS: TextModelThinkingEffortOption[] = [
  { value: "minimal", label: "Minimal" },
  { value: "low", label: "Low" },
  { value: "medium", label: "Medium", default: true },
  { value: "high", label: "High" }
];

const GEMINI_MAIN_TEXT_MODEL_OPTIONS: TextModelOption[] = [
  {
    provider: "gemini",
    model: "gemini-3.7-flash",
    label: "Gemini 3.7 Flash",
    thinking: true,
    thinkingEfforts: GEMINI_FLASH_THINKING_LEVEL_EFFORTS
  },
  {
    provider: "gemini",
    model: "gemini-3.5-flash",
    label: "Gemini 3.5 Flash",
    thinking: true,
    thinkingEfforts: GEMINI_FLASH_THINKING_LEVEL_EFFORTS
  },
  {
    provider: "gemini",
    model: "gemini-3.1-pro-preview",
    label: "Gemini 3.1 Pro Preview",
    preview: true,
    ...geminiThinkingFlag("gemini-3.1-pro-preview")
  },
  {
    provider: "gemini",
    model: "gemini-3-flash-preview",
    label: "Gemini 3 Flash Preview",
    preview: true,
    ...geminiThinkingFlag("gemini-3-flash-preview")
  },
  { provider: "gemini", model: "gemini-3.1-flash-lite", label: "Gemini 3.1 Flash-Lite" },
  { provider: "gemini", model: "gemini-2.5-pro", label: "Gemini 2.5 Pro", ...geminiThinkingFlag("gemini-2.5-pro") },
  {
    provider: "gemini",
    model: "gemini-2.5-flash",
    label: "Gemini 2.5 Flash",
    ...geminiThinkingFlag("gemini-2.5-flash")
  },
  {
    provider: "gemini",
    model: "gemini-2.5-flash",
    label: "Gemini 2.5 Flash (No Thinking)",
    thinkingBudget: 0
  },
  { provider: "gemini", model: "gemini-2.5-flash-lite", label: "Gemini 2.5 Flash-Lite" }
];

const DEEPSEEK_THINKING_EFFORTS: TextModelThinkingEffortOption[] = [
  { value: "none", label: "Off", default: true },
  { value: "high", label: "High" },
  { value: "max", label: "Max" }
];

function geminiThinkingFlag(model: string): Pick<TextModelOption, "thinking"> {
  return isGeminiThinkingTextModel(model) ? { thinking: true } : {};
}

function isGeminiThinkingTextModel(model: string): boolean {
  const normalized = model.trim().toLowerCase();
  if (normalized.includes("flash-lite")) {
    return false;
  }
  return (
    normalized.startsWith("gemini-3") ||
    normalized.startsWith("gemini-2.5-pro") ||
    normalized.startsWith("gemini-2.5-flash")
  );
}

export function textModelOptions(config: AppConfig): TextModelOption[] {
  return [
    ...deepSeekModelOptions(config),
    ...deepInfraModelOptions(config),
    ...alibabaTextModelOptions(config.ALIBABA_TEXT_MODEL),
    ...openAITextModelOptions(),
    ...GEMINI_MAIN_TEXT_MODEL_OPTIONS,
    ...localTextModelOptions(config)
  ];
}

/** Configured-only catalog used by the live generation routing controls. */
export function generationTextModelOptions(config: AppConfig): GenerationTextModelOption[] {
  const base = textModelOptions(config)
    .filter((option) => textProviderConfigured(config, option.provider))
    .map((option) => generationCatalogOption(option));
  if (config.DEEPINFRA_API_KEY) {
    const fast: GenerationTextModelOption = {
      provider: "deepinfra",
      model: config.DEEPINFRA_FAST_MODEL,
      label: `DeepInfra Fast (${config.DEEPINFRA_FAST_MODEL})`,
      thinking: true,
      thinkingEfforts: [
        { value: "none", label: "Off", default: true },
        { value: "low", label: "Low" },
        { value: "medium", label: "Medium" },
        { value: "high", label: "High" }
      ]
    };
    if (!base.some((option) => generationTextModelOptionKey(option) === generationTextModelOptionKey(fast))) {
      const firstNonDeepSeek = base.findIndex((option) => option.provider !== "deepseek");
      base.splice(firstNonDeepSeek < 0 ? base.length : firstNonDeepSeek, 0, fast);
    }
  }
  return base;
}

function generationCatalogOption(option: TextModelOption): GenerationTextModelOption {
  // The Premium/Ultra writer budget was fixed before model routing became
  // editable. Keep it catalog-owned so switching away and back cannot lose it.
  if (option.provider === "gemini" && option.model === "gemini-2.5-pro") {
    return { ...option, thinkingBudget: 2048 };
  }
  // 0 disables thinking; keep it catalog-owned so switching away and back
  // cannot lose it. Compiled defaults spell this leaf with 0.
  if (option.provider === "gemini" && option.model === "gemini-2.5-flash-lite") {
    return { ...option, thinkingBudget: 0 };
  }
  // A fixed "thinking on" flag distinguishes catalog variants sharing one
  // provider/model identity (Gemini Flash versus Flash No Thinking). Discrete
  // effort models express the same choice through their default effort.
  if (option.thinking && !option.thinkingEfforts?.length && option.thinkingBudget === undefined) {
    return { ...option, thinkingEnabled: true };
  }
  return { ...option };
}

export function textProviderConfigured(config: AppConfig, provider: TextModelSelection["provider"]): boolean {
  if (provider === "deepseek") {
    return Boolean(config.DEEPSEEK_API_KEY?.trim());
  }
  if (provider === "deepinfra") {
    return Boolean(config.DEEPINFRA_API_KEY?.trim());
  }
  if (provider === "gemini") {
    return Boolean(config.GEMINI_API_KEY?.trim());
  }
  if (provider === "alibaba") {
    return Boolean(config.ALIBABA_API_KEY?.trim());
  }
  if (provider === "openai") {
    return Boolean(config.OPENAI_API_KEY?.trim());
  }
  return Boolean(config.LOCAL_TEXT_BASE_URL && config.LOCAL_TEXT_MODEL);
}

function deepSeekModelOptions(config: AppConfig): TextModelOption[] {
  const options: TextModelOption[] = [
    {
      provider: "deepseek",
      model: config.DEEPSEEK_MODEL,
      label: `DeepSeek (${config.DEEPSEEK_MODEL})`,
      thinking: true,
      thinkingEfforts: DEEPSEEK_THINKING_EFFORTS
    }
  ];
  if (config.DEEPSEEK_FAST_MODEL !== config.DEEPSEEK_MODEL) {
    options.push({
      provider: "deepseek",
      model: config.DEEPSEEK_FAST_MODEL,
      label: `DeepSeek Fast (${config.DEEPSEEK_FAST_MODEL})`,
      thinking: true,
      thinkingEfforts: DEEPSEEK_THINKING_EFFORTS
    });
  }
  return options;
}

function deepInfraModelOptions(config: AppConfig): TextModelOption[] {
  return config.DEEPINFRA_API_KEY ? deepInfraTextModelOptions(config.DEEPINFRA_MODEL) : [];
}

function localTextModelOptions(config: AppConfig): TextModelOption[] {
  if (!config.LOCAL_TEXT_BASE_URL || !config.LOCAL_TEXT_MODEL) {
    return [];
  }
  return [
    {
      provider: "openai-compatible",
      model: config.LOCAL_TEXT_MODEL,
      label: `Local (${config.LOCAL_TEXT_MODEL})`
    }
  ];
}

export function imageModelOptions(config: AppConfig): ImageModelProviderOption[] {
  return [
    ...geminiImageModelOptions(config.GEMINI_IMAGE_MODEL).map((option) => ({ provider: "gemini" as const, ...option })),
    ...alibabaImageModelOptions(config.ALIBABA_IMAGE_MODEL)
  ];
}

export type ResolvedTextModelSelections = {
  prose: TextModelSelection;
  mechanical: TextModelSelection;
  /** Set for project generation so live Quality-tab routing can bind by tier. */
  tier?: ModelTier;
};

export function resolveTextModelSelections(
  config: AppConfig,
  input?: CreateProjectInput
): ResolvedTextModelSelections {
  if (input) {
    // The worker replaces this delegate with the live revision router, but the
    // delegate must still be constructible. A stale project-level model (or a
    // removed credential for it) must not veto the operator-controlled route.
    const tier = modelTierForInput(input);
    const selected = compiledGenerationTextModelRouting(config, generationTextModelOptions(config))[tier];
    return { prose: selected.writer, mechanical: selected.judgment, tier };
  }
  const legacy: TextModelSelection = { provider: "deepseek", model: config.DEEPSEEK_MODEL };
  return { prose: legacy, mechanical: legacy };
}

export function resolveTextModelSelection(config: AppConfig, input?: CreateProjectInput): TextModelSelection {
  return resolveTextModelSelections(config, input).prose;
}

export function resolveImageModelSelection(config: AppConfig, input?: CreateProjectInput): ImageModelSelection {
  const explicit = input?.mediaSettings.imageModel;
  if (explicit) {
    return explicit;
  }
  const tier = input?.mediaSettings.modelTier;
  const tierSelection = tier ? modelTierImageSelection(tier) : undefined;
  return tierSelection ?? { provider: "gemini", model: config.GEMINI_IMAGE_MODEL };
}

export function createResearchAdapter(config: AppConfig): ResearchAdapter {
  if (config.MOCK_AI) {
    return new FakeResearchAdapter();
  }
  return new GeminiResearchAdapter({
    apiKey: config.GEMINI_API_KEY,
    textModel: config.GEMINI_TEXT_MODEL
  });
}

export function createProviders(
  config: AppConfig,
  input?: CreateProjectInput
): ProviderSet {
  if (config.MOCK_AI) {
    return {
      text: new FakeTextModelAdapter(input),
      research: createResearchAdapter(config),
      image: new FakeImageAdapter(),
      embedding: new FakeEmbeddingAdapter(),
      speech: new FakeSpeechAdapter()
    };
  }

  const textModel = createRoutedTextModel(config, resolveTextModelSelections(config, input));
  return {
    text: textModel,
    research: createResearchAdapter(config),
    image: createImageModelAdapter(config, resolveImageModelSelection(config, input)),
    embedding: new GeminiEmbeddingAdapter({
      apiKey: config.GEMINI_API_KEY,
      embeddingModel: config.GEMINI_EMBEDDING_MODEL
    }),
    speech: createSpeechAdapter(config)
  };
}

export function createSpeechAdapter(
  config: AppConfig,
  selection: SpeechModelSelection = { provider: "gemini_tts", model: config.GEMINI_TTS_MODEL }
): SpeechAdapter {
  if (config.MOCK_AI) {
    return new FakeSpeechAdapter();
  }
  if (selection.provider === "openai_tts") {
    return new OpenAISpeechAdapter({
      apiKey: config.OPENAI_API_KEY,
      model: selection.model
    });
  }
  return new GeminiSpeechAdapter({
    apiKey: config.GEMINI_API_KEY,
    model: selection.model
  });
}

export function createRoutedTextModel(config: AppConfig, selections: ResolvedTextModelSelections): TextModelAdapter {
  const prose = createTextModelAdapter(config, selections.prose);
  const mechanical = sameTextSelection(selections.prose, selections.mechanical)
    ? prose
    : createTextModelAdapter(config, selections.mechanical);
  const purposeOverrides = purposeOverrideAdapters(config, selections);
  if (purposeOverrides.size === 0 && mechanical === prose) {
    return prose;
  }
  return new RoutingTextModelAdapter(
    { selection: selections.prose, adapter: prose },
    {
      selection: selections.mechanical,
      adapter: mechanical === prose ? prose : mechanical
    },
    purposeOverrides
  );
}

function purposeOverrideAdapters(
  config: AppConfig,
  selections: ResolvedTextModelSelections
): Map<string, { selection: TextModelSelection; adapter: TextModelAdapter }> {
  const overrides = new Map<string, { selection: TextModelSelection; adapter: TextModelAdapter }>();
  const tier = selections.tier;
  if (!tier) {
    return overrides;
  }
  const catalog = generationTextModelOptions(config);
  const planSelection = elevatedThinkingSelection(selections.prose, tier, "plan-book", catalog);
  if (!sameTextSelection(selections.prose, planSelection)) {
    overrides.set("plan-book", {
      selection: planSelection,
      adapter: createTextModelAdapter(config, planSelection)
    });
  }
  const mapSelection = elevatedThinkingSelection(selections.mechanical, tier, "generate-page-map", catalog);
  if (!sameTextSelection(selections.mechanical, mapSelection)) {
    overrides.set("generate-page-map", {
      selection: mapSelection,
      adapter: createTextModelAdapter(config, mapSelection)
    });
  }
  return overrides;
}

export function elevatedThinkingSelection(
  base: TextModelSelection,
  tier: ModelTier,
  purpose: string | undefined,
  options: readonly GenerationTextModelOption[]
): TextModelSelection {
  const isPlan = purpose === "plan-book";
  const isUltraMap = tier === "ultra" && purpose === "generate-page-map";
  if ((tier !== "premium" && tier !== "ultra") || (!isPlan && !isUltraMap)) {
    return base;
  }

  // Gemini 2.5 uses numeric budgets. Preserve the established boosts only for
  // a selection already using that capability; adding a budget to a discrete-
  // effort model makes the SDK send a parameter that model does not support.
  if (base.provider === "gemini" && typeof base.thinkingBudget === "number") {
    const thinkingBudget = isUltraMap
      ? ULTRA_PAGE_MAP_THINKING_BUDGET
      : planThinkingBudgetForTier(tier);
    return thinkingBudget === undefined || thinkingBudget === base.thinkingBudget
      ? base
      : { ...base, thinkingBudget };
  }

  const option = generationOptionForSelection(options, base);
  const efforts = option?.thinkingEfforts;
  if (!efforts?.length) {
    return base;
  }
  const baseEffort = base.thinkingEffort ?? efforts.find((effort) => effort.default)?.value;
  const target = tier === "ultra" ? "max" : "high";
  const elevated = elevatedSupportedEffort(efforts.map((effort) => effort.value), baseEffort, target);
  return elevated && elevated !== base.thinkingEffort ? { ...base, thinkingEffort: elevated } : base;
}

function generationOptionForSelection(
  options: readonly GenerationTextModelOption[],
  selection: TextModelSelection
): GenerationTextModelOption | undefined {
  const exactKey = generationTextModelOptionKey(selection);
  return options.find((option) => generationTextModelOptionKey(option) === exactKey) ??
    options.find((option) => option.provider === selection.provider && option.model === selection.model);
}

function elevatedSupportedEffort(
  supported: readonly TextModelThinkingEffort[],
  base: TextModelThinkingEffort | undefined,
  target: TextModelThinkingEffort
): TextModelThinkingEffort | undefined {
  const order: readonly TextModelThinkingEffort[] = ["none", "minimal", "low", "medium", "high", "xhigh", "max"];
  const baseRank = base ? order.indexOf(base) : 0;
  const targetRank = order.indexOf(target);
  const desiredRank = Math.max(baseRank, targetRank);
  let selected: TextModelThinkingEffort | undefined;
  for (const effort of supported) {
    const rank = order.indexOf(effort);
    if (rank <= desiredRank && (!selected || rank > order.indexOf(selected))) {
      selected = effort;
    }
  }
  if (selected && order.indexOf(selected) >= baseRank) {
    return selected;
  }
  return base;
}

function sameTextSelection(a: TextModelSelection, b: TextModelSelection): boolean {
  return (
    a.provider === b.provider &&
    a.model === b.model &&
    a.thinkingBudget === b.thinkingBudget &&
    a.thinkingEnabled === b.thinkingEnabled &&
    a.thinkingEffort === b.thinkingEffort
  );
}

export function createTextModelAdapter(config: AppConfig, selection: TextModelSelection): TextModelAdapter {
  if (selection.provider === "gemini") {
    return new GeminiTextAdapter({
      apiKey: config.GEMINI_API_KEY,
      textModel: selection.model,
      thinkingBudget: selection.thinkingBudget,
      thinkingEnabled: selection.thinkingEnabled,
      thinkingEffort: selection.thinkingEffort
    });
  }
  if (selection.provider === "alibaba") {
    return new AlibabaTextAdapter({
      apiKey: config.ALIBABA_API_KEY,
      apiHost: config.ALIBABA_API_HOST,
      textModel: selection.model
    });
  }
  if (selection.provider === "openai") {
    return new OpenAITextAdapter({
      apiKey: config.OPENAI_API_KEY,
      model: selection.model,
      thinkingEnabled: selection.thinkingEnabled,
      thinkingEffort: selection.thinkingEffort
    });
  }
  if (selection.provider === "openai-compatible") {
    return new OpenAICompatibleTextAdapter({
      baseURL: config.LOCAL_TEXT_BASE_URL,
      model: selection.model || config.LOCAL_TEXT_MODEL,
      apiKey: config.LOCAL_TEXT_API_KEY
    });
  }
  if (selection.provider === "deepinfra") {
    return new DeepInfraAdapter({
      apiKey: config.DEEPINFRA_API_KEY,
      baseURL: config.DEEPINFRA_BASE_URL,
      model: normalizeDeepInfraTextModel(selection.model),
      thinkingEnabled: selection.thinkingEnabled,
      thinkingEffort: selection.thinkingEffort
    });
  }

  return new DeepSeekAdapter({
    apiKey: config.DEEPSEEK_API_KEY,
    baseURL: config.DEEPSEEK_BASE_URL,
    model: selection.model,
    fastModel: config.DEEPSEEK_FAST_MODEL,
    thinkingEnabled: selection.thinkingEnabled,
    thinkingEffort: selection.thinkingEffort
  });
}

export type LiveGenerationTextModelOptions = {
  loadRouting: () => Promise<GenerationTextModelRouting>;
  tier?: ModelTier | undefined;
  fastJudgments?: boolean | undefined;
  /** Test seam; production uses the provider/fallback construction above. */
  createAdapter?: ((selection: TextModelSelection, role: GenerationTextModelRole) => TextModelAdapter) | undefined;
};

export function createLiveGenerationTextModel(
  config: AppConfig,
  options: LiveGenerationTextModelOptions
): TextModelAdapter {
  return new LiveGenerationTextModelAdapter(config, options);
}

/**
 * Resolves routing at each logical call boundary and caches only the concrete
 * adapters it constructs. `bindForCall` is consumed by retry wrappers so their
 * attempts keep this exact selection even if a revision lands mid-call.
 */
export class LiveGenerationTextModelAdapter implements TextModelAdapter {
  private readonly adapters = new Map<string, TextModelAdapter>();
  private readonly catalog: GenerationTextModelOption[];
  private purposeOverridesEnabled = true;

  constructor(
    private readonly config: AppConfig,
    private readonly options: LiveGenerationTextModelOptions
  ) {
    this.catalog = generationTextModelOptions(config);
    if (!config.MOCK_AI && this.catalog.length === 0) {
      throw new Error("A text model API key is required when MOCK_AI=false.");
    }
  }

  setPurposeOverridesEnabled(enabled: boolean): void {
    this.purposeOverridesEnabled = enabled;
  }

  async bindForCall(purpose: string | undefined) {
    const routing = await this.options.loadRouting();
    const tier = this.options.tier ?? "fast";
    const role: GenerationTextModelRole = this.options.fastJudgments
      ? "judgment"
      : purpose && MECHANICAL_TEXT_PURPOSES.has(purpose)
        ? "judgment"
        : "writer";
    const base = this.options.fastJudgments
      ? routing.fastJudgments
      : routingSelection(routing, tier, role);
    const selection = this.purposeOverridesEnabled
      ? elevatedThinkingSelection(base, tier, purpose, this.catalog)
      : base;
    const key = `${tier}:${role}:${textModelSelectionKey(selection)}`;
    let adapter = this.adapters.get(key);
    if (!adapter) {
      adapter = this.createBoundAdapter(selection, role);
      this.adapters.set(key, adapter);
    }
    return { adapter, selection };
  }

  async generateText(options: GenerateTextOptions) {
    const bound = await this.bindForCall(options.purpose);
    return bound.adapter.generateText(options);
  }

  async generateJson<T>(options: GenerateJsonOptions<T>) {
    const bound = await this.bindForCall(options.purpose);
    return bound.adapter.generateJson(options);
  }

  async *streamText(options: GenerateTextOptions) {
    const bound = await this.bindForCall(options.purpose);
    yield* bound.adapter.streamText(options);
  }

  async generateWithTools(options: GenerateWithToolsOptions) {
    const bound = await this.bindForCall(options.purpose);
    return bound.adapter.generateWithTools(options);
  }

  private createBoundAdapter(
    selection: TextModelSelection,
    role: GenerationTextModelRole
  ): TextModelAdapter {
    if (this.options.createAdapter) {
      return this.options.createAdapter(selection, role);
    }
    if (this.config.MOCK_AI) {
      return new FakeTextModelAdapter();
    }
    return createTextModelAdapter(this.config, selection);
  }
}

function createImageModelAdapter(config: AppConfig, selection: ImageModelSelection): ImageAdapter {
  if (selection.provider === "alibaba") {
    return new AlibabaImageAdapter({
      apiKey: config.ALIBABA_API_KEY,
      apiHost: config.ALIBABA_API_HOST,
      imageModel: selection.model
    });
  }

  return new GeminiImageAdapter({
    apiKey: config.GEMINI_API_KEY,
    imageModel: selection.model
  });
}
