export type ProviderCostLog = {
  provider?: string | null;
  model?: string | null;
  purpose?: string | null;
  promptTokens?: number | null;
  outputTokens?: number | null;
  cacheHitTokens?: number | null;
  costHint?: number | null;
  metadata?: unknown;
};

export type ImageCostSource = {
  provider?: string | null;
  metadata?: unknown;
};

export type ProjectCostSummary = {
  textUsd: number;
  imageUsd: number;
  totalUsd: number;
  unpricedTextCalls: number;
  unpricedImages: number;
};

type TextRate = {
  inputPerMillion: number;
  outputPerMillion: number;
  cacheHitPerMillion?: number;
};

type TieredTextRate = {
  thresholdPromptTokens: number;
  belowOrEqual: TextRate;
  above: TextRate;
};

const TOKENS_PER_MILLION = 1_000_000;
const COST_PRECISION = 1_000_000;
const DEFAULT_IMAGE_SIZE_TIER = "1k";

const GEMINI_TEXT_RATES = new Map<string, TextRate | TieredTextRate>([
  [
    "gemini-3.5-flash",
    {
      inputPerMillion: 1.5,
      outputPerMillion: 9,
      cacheHitPerMillion: 0.15
    }
  ],
  [
    "gemini-3-flash-preview",
    {
      inputPerMillion: 0.5,
      outputPerMillion: 3,
      cacheHitPerMillion: 0.05
    }
  ],
  [
    "gemini-3.1-flash-lite",
    {
      inputPerMillion: 0.25,
      outputPerMillion: 1.5,
      cacheHitPerMillion: 0.025
    }
  ],
  [
    "gemini-3.1-pro-preview",
    {
      thresholdPromptTokens: 200_000,
      belowOrEqual: {
        inputPerMillion: 2,
        outputPerMillion: 12,
        cacheHitPerMillion: 0.2
      },
      above: {
        inputPerMillion: 4,
        outputPerMillion: 18,
        cacheHitPerMillion: 0.4
      }
    }
  ],
  [
    "gemini-2.5-pro",
    {
      thresholdPromptTokens: 200_000,
      belowOrEqual: {
        inputPerMillion: 1.25,
        outputPerMillion: 10,
        cacheHitPerMillion: 0.125
      },
      above: {
        inputPerMillion: 2.5,
        outputPerMillion: 15,
        cacheHitPerMillion: 0.25
      }
    }
  ],
  [
    "gemini-2.5-flash",
    {
      inputPerMillion: 0.3,
      outputPerMillion: 2.5,
      cacheHitPerMillion: 0.03
    }
  ],
  [
    "gemini-2.5-flash-lite",
    {
      inputPerMillion: 0.1,
      outputPerMillion: 0.4,
      cacheHitPerMillion: 0.01
    }
  ]
]);

const ALIBABA_TEXT_RATES = new Map<string, TextRate | TieredTextRate>([
  [
    "qwen3.5-plus",
    {
      thresholdPromptTokens: 256_000,
      belowOrEqual: {
        inputPerMillion: 0.4,
        outputPerMillion: 2.4
      },
      above: {
        inputPerMillion: 0.5,
        outputPerMillion: 3
      }
    }
  ],
  [
    "qwen3.5-plus-2026-02-15",
    {
      thresholdPromptTokens: 256_000,
      belowOrEqual: {
        inputPerMillion: 0.4,
        outputPerMillion: 2.4
      },
      above: {
        inputPerMillion: 0.5,
        outputPerMillion: 3
      }
    }
  ],
  [
    "qwen-plus",
    {
      thresholdPromptTokens: 256_000,
      belowOrEqual: {
        inputPerMillion: 0.4,
        outputPerMillion: 1.2
      },
      above: {
        inputPerMillion: 1.2,
        outputPerMillion: 3.6
      }
    }
  ],
  [
    "qwen-plus-latest",
    {
      thresholdPromptTokens: 256_000,
      belowOrEqual: {
        inputPerMillion: 0.4,
        outputPerMillion: 1.2
      },
      above: {
        inputPerMillion: 1.2,
        outputPerMillion: 3.6
      }
    }
  ],
  [
    "qwen-plus-2025-12-01",
    {
      thresholdPromptTokens: 256_000,
      belowOrEqual: {
        inputPerMillion: 0.4,
        outputPerMillion: 1.2
      },
      above: {
        inputPerMillion: 1.2,
        outputPerMillion: 3.6
      }
    }
  ],
  [
    "qwen-plus-2025-09-11",
    {
      thresholdPromptTokens: 256_000,
      belowOrEqual: {
        inputPerMillion: 0.4,
        outputPerMillion: 1.2
      },
      above: {
        inputPerMillion: 1.2,
        outputPerMillion: 3.6
      }
    }
  ],
  [
    "qwen-plus-2025-07-28",
    {
      thresholdPromptTokens: 256_000,
      belowOrEqual: {
        inputPerMillion: 0.4,
        outputPerMillion: 1.2
      },
      above: {
        inputPerMillion: 1.2,
        outputPerMillion: 3.6
      }
    }
  ],
  [
    "qwen-plus-2025-07-14",
    {
      inputPerMillion: 0.4,
      outputPerMillion: 1.2
    }
  ],
  [
    "qwen-plus-2025-04-28",
    {
      inputPerMillion: 0.4,
      outputPerMillion: 1.2
    }
  ],
  [
    "qwen-plus-2025-01-25",
    {
      inputPerMillion: 0.4,
      outputPerMillion: 1.2
    }
  ],
  [
    "qwen3.5-flash",
    {
      inputPerMillion: 0.1,
      outputPerMillion: 0.4
    }
  ],
  [
    "qwen3.5-flash-2026-02-23",
    {
      inputPerMillion: 0.1,
      outputPerMillion: 0.4
    }
  ],
  [
    "qwen-flash",
    {
      thresholdPromptTokens: 256_000,
      belowOrEqual: {
        inputPerMillion: 0.05,
        outputPerMillion: 0.4
      },
      above: {
        inputPerMillion: 0.25,
        outputPerMillion: 2
      }
    }
  ],
  [
    "qwen-flash-2025-07-28",
    {
      thresholdPromptTokens: 256_000,
      belowOrEqual: {
        inputPerMillion: 0.05,
        outputPerMillion: 0.4
      },
      above: {
        inputPerMillion: 0.25,
        outputPerMillion: 2
      }
    }
  ]
]);

const DEEPSEEK_V4_FLASH_RATE: TextRate = {
  inputPerMillion: 0.14,
  outputPerMillion: 0.28,
  cacheHitPerMillion: 0.0028
};

const DEEPSEEK_V4_PRO_RATE: TextRate = {
  inputPerMillion: 0.435,
  outputPerMillion: 0.87,
  cacheHitPerMillion: 0.003625
};

const GEMINI_IMAGE_COSTS_USD = new Map<string, number>([
  ["gemini-2.5-flash-image", 0.039],
  ["imagen-4.0-fast-generate-001", 0.02],
  ["gemini-3.1-flash-image:0.5k", 0.045],
  ["gemini-3.1-flash-image:1k", 0.067],
  ["gemini-3.1-flash-image:2k", 0.101],
  ["gemini-3.1-flash-image:4k", 0.151],
  ["gemini-3-pro-image:1k", 0.134],
  ["gemini-3-pro-image:2k", 0.134],
  ["gemini-3-pro-image:4k", 0.24]
]);

const ALIBABA_IMAGE_COSTS_USD = new Map<string, number>([
  ["qwen-image-2.0-pro", 0.075],
  ["qwen-image-2.0-pro-2026-03-03", 0.075],
  ["qwen-image-2.0", 0.035],
  ["qwen-image-2.0-2026-03-03", 0.035],
  ["qwen-image-max", 0.075],
  ["qwen-image-max-2025-12-30", 0.075],
  ["qwen-image-plus", 0.03],
  ["qwen-image-plus-2026-01-09", 0.03],
  ["qwen-image", 0.035]
]);

export function calculateTextGenerationCost(log: ProviderCostLog): number | null {
  const hintedCost = finiteCost(log.costHint);
  if (hintedCost !== null) {
    return roundCost(hintedCost);
  }

  const provider = normalizeProvider(log.provider);
  const model = normalizeModel(log.model);
  const rate = resolveTextRate(provider, model, finiteTokenCount(log.promptTokens));
  if (!rate) {
    return null;
  }

  const promptTokens = finiteTokenCount(log.promptTokens) ?? 0;
  const outputTokens = finiteTokenCount(log.outputTokens) ?? 0;
  const cacheHitTokens = Math.min(finiteTokenCount(log.cacheHitTokens) ?? 0, promptTokens);
  const cacheMissTokens = Math.max(0, promptTokens - cacheHitTokens);
  const cost =
    (cacheMissTokens / TOKENS_PER_MILLION) * rate.inputPerMillion +
    (cacheHitTokens / TOKENS_PER_MILLION) * (rate.cacheHitPerMillion ?? rate.inputPerMillion) +
    (outputTokens / TOKENS_PER_MILLION) * rate.outputPerMillion;

  return roundCost(cost);
}

export function calculateImageGenerationCost(input: {
  provider?: string | null;
  model?: string | null;
  metadata?: unknown;
}): number | null {
  const hintedCost = metadataNumber(input.metadata, "costUsd");
  if (hintedCost !== null) {
    return roundCost(hintedCost);
  }

  const provider = normalizeProvider(input.provider);
  const model = normalizeModel(input.model ?? metadataString(input.metadata, "model") ?? metadataString(input.metadata, "sourceImageModel"));
  if (!provider || !model) {
    return null;
  }

  if (provider === "alibaba" || provider === "qwen") {
    return ALIBABA_IMAGE_COSTS_USD.get(model) ?? null;
  }

  if (provider !== "gemini" && provider !== "google") {
    return null;
  }

  if (model === "gemini-2.5-flash-image" || model.startsWith("gemini-2.5-flash-image-")) {
    return GEMINI_IMAGE_COSTS_USD.get("gemini-2.5-flash-image") ?? null;
  }

  if (model === "imagen-4.0-fast-generate-001") {
    return GEMINI_IMAGE_COSTS_USD.get("imagen-4.0-fast-generate-001") ?? null;
  }

  if (model === "gemini-3.1-flash-image" || model.startsWith("gemini-3.1-flash-image-")) {
    const tier = imageSizeTier(input.metadata);
    return GEMINI_IMAGE_COSTS_USD.get(`gemini-3.1-flash-image:${tier}`) ?? null;
  }

  if (model === "gemini-3-pro-image" || model.startsWith("gemini-3-pro-image-")) {
    const tier = imageSizeTier(input.metadata);
    return GEMINI_IMAGE_COSTS_USD.get(`gemini-3-pro-image:${tier}`) ?? GEMINI_IMAGE_COSTS_USD.get("gemini-3-pro-image:1k") ?? null;
  }

  return null;
}

export function calculateProjectCostSummary(
  providerLogs: ProviderCostLog[],
  images: ImageCostSource[] = []
): ProjectCostSummary {
  let textUsd = 0;
  let imageUsd = 0;
  let unpricedTextCalls = 0;
  let unpricedImages = 0;
  const imageLogs = providerLogs.filter(isImageProviderLog);

  for (const log of providerLogs) {
    if (isImageProviderLog(log)) {
      continue;
    }
    if (!isTextProviderLog(log)) {
      continue;
    }

    const cost = calculateTextGenerationCost(log);
    if (cost === null) {
      unpricedTextCalls += 1;
    } else {
      textUsd += cost;
    }
  }

  if (imageLogs.length > 0 && imageLogs.length >= images.length) {
    for (const log of imageLogs) {
      const cost = finiteCost(log.costHint) ?? calculateImageGenerationCost(log);
      if (cost === null) {
        unpricedImages += 1;
      } else {
        imageUsd += cost;
      }
    }
  } else {
    for (const image of images) {
      const cost = calculateImageGenerationCost(image);
      if (cost === null) {
        unpricedImages += 1;
      } else {
        imageUsd += cost;
      }
    }
  }

  textUsd = roundCost(textUsd);
  imageUsd = roundCost(imageUsd);

  return {
    textUsd,
    imageUsd,
    totalUsd: roundCost(textUsd + imageUsd),
    unpricedTextCalls,
    unpricedImages
  };
}

function resolveTextRate(provider: string | null, model: string | null, promptTokens: number | null): TextRate | null {
  if (!provider || !model) {
    return null;
  }

  if (provider === "deepseek") {
    if (
      model === "deepseek-v4-pro" ||
      model.startsWith("deepseek-v4-pro-")
    ) {
      return DEEPSEEK_V4_PRO_RATE;
    }
    if (
      model === "deepseek-v4-flash" ||
      model.startsWith("deepseek-v4-flash-") ||
      model === "deepseek-chat" ||
      model === "deepseek-reasoner"
    ) {
      return DEEPSEEK_V4_FLASH_RATE;
    }
    return null;
  }

  if (provider === "alibaba" || provider === "qwen") {
    return resolveRateForPromptTokens(ALIBABA_TEXT_RATES.get(model), promptTokens);
  }

  if (provider !== "gemini" && provider !== "google") {
    return null;
  }

  return resolveRateForPromptTokens(GEMINI_TEXT_RATES.get(model), promptTokens);
}

function resolveRateForPromptTokens(
  rate: TextRate | TieredTextRate | undefined,
  promptTokens: number | null
): TextRate | null {
  if (!rate) {
    return null;
  }

  if ("thresholdPromptTokens" in rate) {
    return (promptTokens ?? 0) > rate.thresholdPromptTokens ? rate.above : rate.belowOrEqual;
  }

  return rate;
}

function isTextProviderLog(log: ProviderCostLog): boolean {
  const operation = metadataString(log.metadata, "operation");
  if (operation?.startsWith("text.")) {
    return true;
  }
  if (operation && !operation.startsWith("text.")) {
    return false;
  }
  if (log.purpose?.startsWith("image.")) {
    return false;
  }
  return (
    finiteTokenCount(log.promptTokens) !== null ||
    finiteTokenCount(log.outputTokens) !== null ||
    finiteTokenCount(log.cacheHitTokens) !== null ||
    finiteCost(log.costHint) !== null
  );
}

function isImageProviderLog(log: ProviderCostLog): boolean {
  const operation = metadataString(log.metadata, "operation");
  return operation === "image.generate" || log.purpose === "image.generate";
}

function imageSizeTier(metadata: unknown): string {
  const explicit = metadataString(metadata, "sizeTier") ?? metadataString(metadata, "imageSizeTier");
  if (explicit === "0.5k" || explicit === "1k" || explicit === "2k" || explicit === "4k") {
    return explicit;
  }

  const width = metadataNumber(metadata, "width") ?? metadataNumber(metadata, "outputWidth");
  const height = metadataNumber(metadata, "height") ?? metadataNumber(metadata, "outputHeight");
  const maxDimension = Math.max(width ?? 0, height ?? 0);
  if (maxDimension > 2048) {
    return "4k";
  }
  if (maxDimension > 1024) {
    return "2k";
  }
  if (maxDimension > 0 && maxDimension <= 512) {
    return "0.5k";
  }

  return DEFAULT_IMAGE_SIZE_TIER;
}

function metadataString(metadata: unknown, key: string): string | null {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    return null;
  }
  const value = (metadata as Record<string, unknown>)[key];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function metadataNumber(metadata: unknown, key: string): number | null {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    return null;
  }
  const value = (metadata as Record<string, unknown>)[key];
  return finiteCost(value);
}

function normalizeProvider(provider: string | null | undefined): string | null {
  return typeof provider === "string" && provider.trim().length > 0 ? provider.trim().toLowerCase() : null;
}

function normalizeModel(model: string | null | undefined): string | null {
  if (typeof model !== "string") {
    return null;
  }
  const normalized = model.trim().toLowerCase().replace(/^models\//, "");
  return normalized.length > 0 ? normalized : null;
}

function finiteTokenCount(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.floor(value) : null;
}

function finiteCost(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

function roundCost(value: number): number {
  return Math.round(value * COST_PRECISION) / COST_PRECISION;
}
