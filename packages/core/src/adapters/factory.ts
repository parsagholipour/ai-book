import type { AppConfig } from "../config.js";
import { alibabaImageModelOptions, alibabaTextModelOptions } from "./alibabaModels.js";
import { geminiImageModelOptions } from "./geminiModels.js";
import { AlibabaImageAdapter, AlibabaTextAdapter } from "./alibaba.js";
import { DeepSeekAdapter } from "./deepseek.js";
import { FakeEmbeddingAdapter, FakeImageAdapter, FakeResearchAdapter, FakeTextModelAdapter } from "./fake.js";
import { GeminiEmbeddingAdapter, GeminiImageAdapter, GeminiResearchAdapter, GeminiTextAdapter } from "./gemini.js";
import type { EmbeddingAdapter, ImageAdapter, ResearchAdapter, TextModelAdapter } from "./types.js";
import type { CreateProjectInput, ImageModelSelection, TextModelSelection } from "../schemas/book.js";

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
};

export type ImageModelProviderOption = ImageModelSelection & {
  label: string;
  costUsd?: number;
  supportsReferenceImages: boolean;
  description?: string;
};
export type ImageModelOption = ImageModelProviderOption;

const GEMINI_MAIN_TEXT_MODEL_OPTIONS: TextModelOption[] = [
  {
    provider: "gemini",
    model: "gemini-3.5-flash",
    label: "Gemini 3.5 Flash",
    ...geminiThinkingFlag("gemini-3.5-flash")
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
    {
      provider: "deepseek",
      model: config.DEEPSEEK_MODEL,
      label: `DeepSeek (${config.DEEPSEEK_MODEL})`
    },
    {
      provider: "deepseek",
      model: config.DEEPSEEK_MODEL,
      label: `DeepSeek (${config.DEEPSEEK_MODEL})`,
      thinking: true,
      thinkingEnabled: true
    },
    ...alibabaTextModelOptions(config.ALIBABA_TEXT_MODEL),
    ...GEMINI_MAIN_TEXT_MODEL_OPTIONS
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

export function createLanguageDetectionTextModel(config: AppConfig): TextModelAdapter {
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

function createTextModelAdapter(config: AppConfig, selection: TextModelSelection): TextModelAdapter {
  if (selection.provider === "gemini") {
    return new GeminiTextAdapter({
      apiKey: config.GEMINI_API_KEY,
      textModel: selection.model,
      thinkingBudget: selection.thinkingBudget
    });
  }
  if (selection.provider === "alibaba") {
    return new AlibabaTextAdapter({
      apiKey: config.ALIBABA_API_KEY,
      apiHost: config.ALIBABA_API_HOST,
      textModel: selection.model
    });
  }

  return new DeepSeekAdapter({
    apiKey: config.DEEPSEEK_API_KEY,
    baseURL: config.DEEPSEEK_BASE_URL,
    model: selection.model,
    fastModel: config.DEEPSEEK_FAST_MODEL,
    thinkingEnabled: selection.thinkingEnabled
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
