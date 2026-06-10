import type { TextModelSelection } from "../schemas/book.js";

export const DEFAULT_DEEPINFRA_BASE_URL = "https://api.deepinfra.com/v1/openai";
export const DEFAULT_DEEPINFRA_MODEL = "deepseek-ai/DeepSeek-V4-Pro";
export const DEFAULT_DEEPINFRA_FAST_MODEL = "deepseek-ai/DeepSeek-V4-Flash";

export type DeepInfraTextModelOption = TextModelSelection & {
  label: string;
  preview?: boolean;
  thinking?: boolean;
};

export function deepInfraTextModelOptions(configuredModel: string): DeepInfraTextModelOption[] {
  return [
    {
      provider: "deepinfra",
      model: configuredModel,
      label: `DeepInfra DeepSeek (${configuredModel})`
    },
    {
      provider: "deepinfra",
      model: configuredModel,
      label: `DeepInfra DeepSeek (${configuredModel})`,
      thinking: true,
      thinkingEnabled: true
    }
  ];
}
