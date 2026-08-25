import type { TextModelSelection } from "../schemas/book.js";

export const DEFAULT_ALIBABA_TEXT_MODEL = "qwen-plus";
export const DEFAULT_ALIBABA_IMAGE_MODEL = "qwen-image-2.0";
export const DEFAULT_ALIBABA_API_HOST = "https://dashscope-intl.aliyuncs.com/compatible-mode/v1";
export const QWEN_IMAGE_MAX_REFERENCE_IMAGES = 3;

export type AlibabaTextModelOption = TextModelSelection & {
  label: string;
  preview?: boolean;
  thinking?: boolean;
};

export type AlibabaImageModelOption = {
  provider: "alibaba";
  model: string;
  label: string;
  costUsd?: number;
  supportsReferenceImages: boolean;
  description?: string;
};

const BASE_ALIBABA_TEXT_MODEL_OPTIONS: AlibabaTextModelOption[] = [
  {
    provider: "alibaba",
    model: DEFAULT_ALIBABA_TEXT_MODEL,
    label: "Qwen Plus"
  },
  {
    provider: "alibaba",
    model: "qwen3.5-plus",
    label: "Qwen 3.5 Plus",
    thinking: true
  },
  {
    provider: "alibaba",
    model: "qwen3.8-max",
    label: "Qwen 3.8 Max",
    thinking: true
  },
  {
    provider: "alibaba",
    model: "qwen3-max",
    label: "Qwen 3 Max",
    thinking: true
  },
  {
    provider: "alibaba",
    model: "qwen3.5-flash",
    label: "Qwen 3.5 Flash",
    thinking: true
  },
  {
    provider: "alibaba",
    model: "qwen-flash",
    label: "Qwen Flash"
  }
];

const BASE_ALIBABA_IMAGE_MODEL_OPTIONS: AlibabaImageModelOption[] = [
  {
    provider: "alibaba",
    model: "qwen-image-2.0-pro",
    label: "Qwen Image 2.0 Pro",
    costUsd: 0.075,
    supportsReferenceImages: supportsQwenImageReferenceImages("qwen-image-2.0-pro"),
    description: "Higher quality Qwen image generation and editing model."
  },
  {
    provider: "alibaba",
    model: DEFAULT_ALIBABA_IMAGE_MODEL,
    label: "Qwen Image 2.0",
    costUsd: 0.035,
    supportsReferenceImages: supportsQwenImageReferenceImages(DEFAULT_ALIBABA_IMAGE_MODEL),
    description: "Balanced Qwen image generation and editing model."
  },
  {
    provider: "alibaba",
    model: "qwen-image-max",
    label: "Qwen Image Max",
    costUsd: 0.075,
    supportsReferenceImages: false,
    description: "Text-to-image model with stronger realism and text rendering."
  },
  {
    provider: "alibaba",
    model: "qwen-image-plus",
    label: "Qwen Image Plus",
    costUsd: 0.03,
    supportsReferenceImages: false,
    description: "Cost-effective Qwen text-to-image option."
  },
  {
    provider: "alibaba",
    model: "qwen-image",
    label: "Qwen Image",
    costUsd: 0.035,
    supportsReferenceImages: false,
    description: "Original Qwen text-to-image model."
  }
];

export function normalizeAlibabaModel(model: string | undefined, fallback = DEFAULT_ALIBABA_TEXT_MODEL): string {
  const normalized = model?.trim().replace(/^models\//, "");
  return normalized || fallback;
}

export function alibabaTextModelOptions(configuredModel?: string): AlibabaTextModelOption[] {
  const options = [...BASE_ALIBABA_TEXT_MODEL_OPTIONS];
  const normalized = normalizeAlibabaModel(configuredModel, DEFAULT_ALIBABA_TEXT_MODEL);
  if (!options.some((option) => option.model === normalized)) {
    options.unshift({
      provider: "alibaba",
      model: normalized,
      label: `Configured Qwen model (${normalized})`,
      ...(isQwenThinkingTextModel(normalized) ? { thinking: true } : {})
    });
  }
  return options;
}

function isQwenThinkingTextModel(model: string): boolean {
  return /^qwen3(?:[.-]|$)/i.test(model.trim());
}

export function alibabaImageModelOptions(configuredModel?: string): AlibabaImageModelOption[] {
  const options = [...BASE_ALIBABA_IMAGE_MODEL_OPTIONS];
  const normalized = normalizeAlibabaModel(configuredModel, DEFAULT_ALIBABA_IMAGE_MODEL);
  if (!options.some((option) => option.model === normalized)) {
    options.unshift({
      provider: "alibaba",
      model: normalized,
      label: `Configured Qwen image model (${normalized})`,
      supportsReferenceImages: supportsQwenImageReferenceImages(normalized)
    });
  }
  return options;
}

export function supportsQwenImageReferenceImages(model: string): boolean {
  return /^qwen-image-2\.0(?:-pro)?(?:-|$)/i.test(normalizeAlibabaModel(model, ""));
}

export function qwenImageReferenceLimit(model: string): number {
  return supportsQwenImageReferenceImages(model) ? QWEN_IMAGE_MAX_REFERENCE_IMAGES : 0;
}
