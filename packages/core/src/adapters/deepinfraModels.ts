import type { TextModelSelection, TextModelThinkingEffort } from "../schemas/book.js";

export const DEFAULT_DEEPINFRA_BASE_URL = "https://api.deepinfra.com/v1/openai";
export const DEFAULT_DEEPINFRA_MODEL = "deepseek-ai/DeepSeek-V4-Pro";
export const DEFAULT_DEEPINFRA_FAST_MODEL = "deepseek-ai/DeepSeek-V4-Flash";
export const DEEPINFRA_MISTRAL_SMALL_MODEL = "mistralai/Mistral-Small-3.2-24B-Instruct-2506";
const DEEPINFRA_LEGACY_MISTRAL_SMALL_ALIASES = new Set(["mistral-small-latest"]);

export type DeepInfraTextModelOption = TextModelSelection & {
  label: string;
  preview?: boolean;
  thinking?: boolean;
  thinkingEfforts?: DeepInfraThinkingEffortOption[];
};

export type DeepInfraThinkingEffortOption = {
  value: TextModelThinkingEffort;
  label: string;
  default?: boolean;
};

const DEEPINFRA_THINKING_EFFORTS: DeepInfraThinkingEffortOption[] = [
  { value: "none", label: "Off", default: true },
  { value: "low", label: "Low" },
  { value: "medium", label: "Medium" },
  { value: "high", label: "High" }
];

export function deepInfraTextModelOptions(configuredModel: string): DeepInfraTextModelOption[] {
  const normalizedConfiguredModel = normalizeDeepInfraTextModel(configuredModel);
  const options: DeepInfraTextModelOption[] = [
    deepInfraTextModelOption(normalizedConfiguredModel)
  ];
  if (normalizedConfiguredModel !== DEEPINFRA_MISTRAL_SMALL_MODEL) {
    options.push(deepInfraTextModelOption(DEEPINFRA_MISTRAL_SMALL_MODEL));
  }
  return options;
}

export function normalizeDeepInfraTextModel(model: string): string {
  const normalized = model.trim();
  return DEEPINFRA_LEGACY_MISTRAL_SMALL_ALIASES.has(normalized) ? DEEPINFRA_MISTRAL_SMALL_MODEL : normalized;
}

function deepInfraTextModelOption(model: string): DeepInfraTextModelOption {
  if (model === DEEPINFRA_MISTRAL_SMALL_MODEL) {
    return {
      provider: "deepinfra",
      model,
      label: `DeepInfra Mistral Small 3.2 (${model})`
    };
  }
  return {
    provider: "deepinfra",
    model,
    label: `DeepInfra DeepSeek (${model})`,
    thinking: true,
    thinkingEfforts: DEEPINFRA_THINKING_EFFORTS
  };
}
