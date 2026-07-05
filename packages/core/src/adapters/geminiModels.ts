export const DEFAULT_GEMINI_IMAGE_MODEL = "gemini-2.5-flash-image";
export const IMAGEN_4_FAST_IMAGE_MODEL = "imagen-4.0-fast-generate-001";

export type GeminiImageModelOption = {
  model: string;
  label: string;
  costUsd?: number;
  supportsReferenceImages: boolean;
  description?: string;
};

const BASE_GEMINI_IMAGE_MODEL_OPTIONS: GeminiImageModelOption[] = [
  {
    model: DEFAULT_GEMINI_IMAGE_MODEL,
    label: "Gemini 2.5 Flash Image",
    costUsd: 0.039,
    supportsReferenceImages: true,
    description: "Best for books with recurring characters."
  },
  {
    model: "gemini-3.1-flash-image",
    label: "Gemini 3.1 Flash Image",
    costUsd: 0.067,
    supportsReferenceImages: true,
    description: "Higher quality with stronger character consistency (premium tier default)."
  },
  {
    model: IMAGEN_4_FAST_IMAGE_MODEL,
    label: "Imagen 4 Fast",
    costUsd: 0.02,
    supportsReferenceImages: false,
    description: "Cheaper text-to-image option; character consistency may be weaker."
  }
];

const RETIRED_GEMINI_IMAGE_MODELS: Record<string, string> = {
  "imagen-4.0-generate-preview-06-06": "imagen-4.0-generate-001",
  "imagen-4.0-ultra-generate-preview-06-06": "imagen-4.0-ultra-generate-001",
  "imagen-4.0-fast-generate-preview-06-06": "imagen-4.0-fast-generate-001"
};

export function normalizeGeminiImageModel(model: string | undefined): string {
  const normalized = model?.trim().replace(/^models\//, "");
  if (!normalized) {
    return DEFAULT_GEMINI_IMAGE_MODEL;
  }
  return RETIRED_GEMINI_IMAGE_MODELS[normalized] ?? normalized;
}

export function geminiImageModelOptions(configuredModel?: string): GeminiImageModelOption[] {
  const options = [...BASE_GEMINI_IMAGE_MODEL_OPTIONS];
  const normalized = normalizeGeminiImageModel(configuredModel);
  if (!options.some((option) => option.model === normalized)) {
    options.unshift({
      model: normalized,
      label: `Configured image model (${normalized})`,
      supportsReferenceImages: isGeminiNativeImageModel(normalized)
    });
  }
  return options;
}

export function isGeminiNativeImageModel(model: string): boolean {
  const normalized = model.trim().replace(/^models\//, "");
  return normalized.startsWith("gemini-") && normalized.includes("-image");
}

export function geminiImageReferenceLimit(model: string): number {
  const normalized = model.trim().replace(/^models\//, "");
  if (!isGeminiNativeImageModel(normalized)) {
    return 0;
  }
  if (normalized.startsWith("gemini-3.1-flash-image")) {
    return 4;
  }
  if (normalized.startsWith("gemini-3-pro-image")) {
    return 5;
  }
  return 3;
}
