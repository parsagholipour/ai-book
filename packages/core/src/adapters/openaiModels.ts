import type { TextModelSelection, TextModelThinkingEffort } from "../schemas/book.js";

export const OPENAI_GPT_5_6_SOL_MODEL = "gpt-5.6-sol";
export const OPENAI_GPT_5_6_TERRA_MODEL = "gpt-5.6-terra";
export const OPENAI_GPT_5_6_LUNA_MODEL = "gpt-5.6-luna";
export const OPENAI_GPT_5_NANO_MODEL = "gpt-5-nano";

export type OpenAITextModelOption = TextModelSelection & {
  label: string;
  thinking: true;
  thinkingEfforts: OpenAIThinkingEffortOption[];
};

export type OpenAIThinkingEffortOption = {
  value: TextModelThinkingEffort;
  label: string;
  default?: boolean;
};

const GPT_5_6_THINKING_EFFORTS: OpenAIThinkingEffortOption[] = [
  { value: "none", label: "Off" },
  { value: "low", label: "Low" },
  { value: "medium", label: "Medium", default: true },
  { value: "high", label: "High" },
  { value: "xhigh", label: "Extra high" },
  { value: "max", label: "Max" }
];

const GPT_5_NANO_THINKING_EFFORTS: OpenAIThinkingEffortOption[] = [
  { value: "minimal", label: "Minimal" },
  { value: "low", label: "Low" },
  { value: "medium", label: "Medium", default: true },
  { value: "high", label: "High" }
];

const OPENAI_TEXT_MODEL_OPTIONS: OpenAITextModelOption[] = [
  {
    provider: "openai",
    model: OPENAI_GPT_5_6_SOL_MODEL,
    label: "GPT-5.6 Sol",
    thinking: true,
    thinkingEfforts: GPT_5_6_THINKING_EFFORTS
  },
  {
    provider: "openai",
    model: OPENAI_GPT_5_6_TERRA_MODEL,
    label: "GPT-5.6 Terra",
    thinking: true,
    thinkingEfforts: GPT_5_6_THINKING_EFFORTS
  },
  {
    provider: "openai",
    model: OPENAI_GPT_5_6_LUNA_MODEL,
    label: "GPT-5.6 Luna",
    thinking: true,
    thinkingEfforts: GPT_5_6_THINKING_EFFORTS
  },
  {
    provider: "openai",
    model: OPENAI_GPT_5_NANO_MODEL,
    label: "GPT-5 nano",
    thinking: true,
    thinkingEfforts: GPT_5_NANO_THINKING_EFFORTS
  }
];

export function openAITextModelOptions(): OpenAITextModelOption[] {
  return OPENAI_TEXT_MODEL_OPTIONS.map((option) => ({
    ...option,
    thinkingEfforts: option.thinkingEfforts.map((effort) => ({ ...effort }))
  }));
}
