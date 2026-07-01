import type { AppConfig } from "../config.js";
import { alibabaImageModelOptions, alibabaTextModelOptions } from "./alibabaModels.js";
import { deepInfraTextModelOptions, normalizeDeepInfraTextModel } from "./deepinfraModels.js";
import { geminiImageModelOptions } from "./geminiModels.js";
import { AlibabaImageAdapter, AlibabaTextAdapter } from "./alibaba.js";
import { DeepInfraAdapter } from "./deepinfra.js";
import { DeepSeekAdapter } from "./deepseek.js";
import { OpenAICompatibleTextAdapter } from "./openaiCompatible.js";
import { FakeEmbeddingAdapter, FakeImageAdapter, FakeResearchAdapter, FakeTextModelAdapter } from "./fake.js";
import { GeminiEmbeddingAdapter, GeminiImageAdapter, GeminiResearchAdapter, GeminiTextAdapter } from "./gemini.js";
import type { EmbeddingAdapter, ImageAdapter, ResearchAdapter, TextModelAdapter } from "./types.js";
import type {
  CreateProjectInput,
  ImageModelSelection,
  TextModelSelection,
  TextModelThinkingEffort
} from "../schemas/book.js";

export type ProviderSet = {
  text: TextModelAdapter;
  research: ResearchAdapter;
  image: ImageAdapter;
  embedding: EmbeddingAdapter;
};

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

const GEMINI_35_FLASH_THINKING_EFFORTS: TextModelThinkingEffortOption[] = [
  { value: "minimal", label: "Minimal" },
  { value: "low", label: "Low" },
  { value: "medium", label: "Medium", default: true },
  { value: "high", label: "High" }
];

const GEMINI_MAIN_TEXT_MODEL_OPTIONS: TextModelOption[] = [
  {
    provider: "gemini",
    model: "gemini-3.5-flash",
    label: "Gemini 3.5 Flash",
    thinking: true,
    thinkingEfforts: GEMINI_35_FLASH_THINKING_EFFORTS
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
    ...GEMINI_MAIN_TEXT_MODEL_OPTIONS,
    ...localTextModelOptions(config)
  ];
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

export function resolveTextModelSelection(config: AppConfig, input?: CreateProjectInput): TextModelSelection {
  return input?.mediaSettings.textModel ?? { provider: "deepseek", model: config.DEEPSEEK_MODEL };
}

export function resolveImageModelSelection(config: AppConfig, input?: CreateProjectInput): ImageModelSelection {
  return input?.mediaSettings.imageModel ?? { provider: "gemini", model: config.GEMINI_IMAGE_MODEL };
}

export function createProviders(config: AppConfig, input?: CreateProjectInput): ProviderSet {
  if (config.MOCK_AI) {
    return {
      text: new FakeTextModelAdapter(input),
      research: new FakeResearchAdapter(),
      image: new FakeImageAdapter(),
      embedding: new FakeEmbeddingAdapter()
    };
  }

  const textModel = createTextModelAdapter(config, resolveTextModelSelection(config, input));
  return {
    text: textModel,
    research: new GeminiResearchAdapter({
      apiKey: config.GEMINI_API_KEY,
      textModel: config.GEMINI_TEXT_MODEL
    }),
    image: createImageModelAdapter(config, resolveImageModelSelection(config, input)),
    embedding: new GeminiEmbeddingAdapter({
      apiKey: config.GEMINI_API_KEY,
      embeddingModel: config.GEMINI_EMBEDDING_MODEL
    })
  };
}

export function createFastRoutingTextModel(config: AppConfig): TextModelAdapter {
  if (config.MOCK_AI) {
    return new FakeTextModelAdapter();
  }
  if (config.DEEPSEEK_API_KEY) {
    return new DeepSeekAdapter({
      apiKey: config.DEEPSEEK_API_KEY,
      baseURL: config.DEEPSEEK_BASE_URL,
      model: config.DEEPSEEK_FAST_MODEL,
      thinkingEnabled: false
    });
  }
  if (config.DEEPINFRA_API_KEY) {
    return new DeepInfraAdapter({
      apiKey: config.DEEPINFRA_API_KEY,
      baseURL: config.DEEPINFRA_BASE_URL,
      model: config.DEEPINFRA_FAST_MODEL,
      thinkingEnabled: false
    });
  }
  if (config.GEMINI_API_KEY) {
    return new GeminiTextAdapter({
      apiKey: config.GEMINI_API_KEY,
      textModel: "gemini-2.5-flash-lite",
      thinkingBudget: 0
    });
  }
  if (config.ALIBABA_API_KEY) {
    return new AlibabaTextAdapter({
      apiKey: config.ALIBABA_API_KEY,
      apiHost: config.ALIBABA_API_HOST,
      textModel: "qwen-flash"
    });
  }

  throw new Error("A text model API key is required for prompt language detection when MOCK_AI=false.");
}

export function createLanguageDetectionTextModel(config: AppConfig): TextModelAdapter {
  return createFastRoutingTextModel(config);
}

function createTextModelAdapter(config: AppConfig, selection: TextModelSelection): TextModelAdapter {
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
