import type { TextModelSelection, TextModelThinkingEffort } from "../schemas/book.js";

export const DEFAULT_OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";
export const OPENROUTER_GLM_53_FLASH_MODEL = "z-ai/glm-5.3-flash";

export type OpenRouterTextModelOption = TextModelSelection & {
  label: string;
  thinking: true;
  thinkingEfforts: OpenRouterThinkingEffortOption[];
};

export type OpenRouterThinkingEffortOption = {
  value: TextModelThinkingEffort;
  label: string;
  default?: boolean;
};

/**
 * GLM-5.3-Flash reasoning is mandatory: OpenRouter rejects `effort: "none"`,
 * and only `low` / `high` / `max` are supported.
 */
const GLM_53_FLASH_THINKING_EFFORTS: OpenRouterThinkingEffortOption[] = [
  { value: "low", label: "Low" },
  { value: "high", label: "High", default: true },
  { value: "max", label: "Max" }
];

const OPENROUTER_TEXT_MODEL_OPTIONS: OpenRouterTextModelOption[] = [
  {
    provider: "openrouter",
    model: OPENROUTER_GLM_53_FLASH_MODEL,
    label: "GLM 5.3 Flash (OpenRouter)",
    thinking: true,
    thinkingEfforts: GLM_53_FLASH_THINKING_EFFORTS
  }
];

export function openRouterTextModelOptions(): OpenRouterTextModelOption[] {
  return OPENROUTER_TEXT_MODEL_OPTIONS.map((option) => ({
    ...option,
    thinkingEfforts: option.thinkingEfforts.map((effort) => ({ ...effort }))
  }));
}
