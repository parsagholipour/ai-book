import OpenAI from "openai";
import type { GenerateTextOptions, Usage } from "./types.js";
import { OpenAIChatCompletionsTextAdapter } from "./openAiChatCompletionsText.js";
import { toOpenAiChatMessages } from "./openaiToolCalling.js";
import {
  AdapterJsonParseError as DeepSeekJsonParseError,
  AdapterJsonValidationError as DeepSeekJsonValidationError,
  parseJsonObject as parseAdapterJsonObject
} from "./json.js";

export { DeepSeekJsonParseError, DeepSeekJsonValidationError };

export type DeepSeekAdapterOptions = {
  apiKey: string | undefined;
  baseURL?: string | undefined;
  model?: string | undefined;
  fastModel?: string | undefined;
  thinkingEnabled?: boolean | undefined;
  thinkingEffort?: ThinkingEffort | undefined;
};

type ThinkingEffort = "none" | "minimal" | "low" | "medium" | "high" | "max";
type DeepSeekReasoningEffort = "high" | "max";

export class DeepSeekAdapter extends OpenAIChatCompletionsTextAdapter {
  constructor(options: DeepSeekAdapterOptions) {
    if (!options.apiKey) {
      throw new Error("DEEPSEEK_API_KEY is required when MOCK_AI=false.");
    }

    const model = options.model ?? "deepseek-v4-pro";
    const thinkingEnabled = options.thinkingEnabled ?? thinkingEffortEnabled(options.thinkingEffort);
    const thinkingEffort = deepSeekReasoningEffort(options.thinkingEffort, thinkingEnabled);
    super({
      client: new OpenAI({
        apiKey: options.apiKey,
        baseURL: options.baseURL ?? "https://api.deepseek.com"
      }),
      model,
      provider: "deepseek",
      providerLabel: "DeepSeek",
      requestParameters: standardRequestParameters,
      reasoningParameters: () => deepSeekThinkingConfig(thinkingEnabled, thinkingEffort),
      convertMessages: toOpenAiChatMessages,
      usageFromResponse: usageFromDeepSeek,
      includeUsageInTextStream: true
    });
  }
}

function standardRequestParameters(options: GenerateTextOptions): Record<string, unknown> {
  return {
    temperature: options.temperature,
    max_tokens: options.maxTokens
  };
}

function deepSeekThinkingConfig(
  enabled: boolean,
  effort: DeepSeekReasoningEffort | undefined
): { thinking: { type: "enabled" | "disabled" }; reasoning_effort?: DeepSeekReasoningEffort } {
  return {
    thinking: { type: enabled ? "enabled" : "disabled" },
    ...(enabled && effort ? { reasoning_effort: effort } : {})
  };
}

function thinkingEffortEnabled(effort: ThinkingEffort | undefined): boolean {
  return effort !== undefined && effort !== "none";
}

function deepSeekReasoningEffort(
  effort: ThinkingEffort | undefined,
  enabled: boolean
): DeepSeekReasoningEffort | undefined {
  if (!enabled) {
    return undefined;
  }
  if (effort === "max") {
    return "max";
  }
  return "high";
}

function usageFromDeepSeek(usage: unknown): Usage | undefined {
  if (!usage || typeof usage !== "object") {
    return undefined;
  }
  const record = usage as {
    prompt_tokens?: number;
    completion_tokens?: number;
    prompt_cache_hit_tokens?: number;
  };
  return {
    promptTokens: record.prompt_tokens,
    outputTokens: record.completion_tokens,
    cacheHitTokens: record.prompt_cache_hit_tokens
  };
}

export function parseJsonObject(text: string): unknown {
  return parseAdapterJsonObject(text, "DeepSeek");
}
