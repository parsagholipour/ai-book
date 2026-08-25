import OpenAI from "openai";
import type {
  GenerateTextOptions,
  Usage
} from "./types.js";
import { OpenAIChatCompletionsTextAdapter } from "./openAiChatCompletionsText.js";
import { toOpenAiChatMessages } from "./openaiToolCalling.js";
import {
  DEFAULT_DEEPINFRA_BASE_URL,
  DEFAULT_DEEPINFRA_MODEL
} from "./deepinfraModels.js";

const PROVIDER_LABEL = "DeepInfra";
const PROVIDER_ID = "deepinfra";

export type DeepInfraAdapterOptions = {
  apiKey: string | undefined;
  baseURL?: string | undefined;
  model?: string | undefined;
  thinkingEnabled?: boolean | undefined;
  thinkingEffort?: ThinkingEffort | undefined;
};

type ThinkingEffort = "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
type DeepInfraReasoningEffort = "low" | "medium" | "high";

export class DeepInfraAdapter extends OpenAIChatCompletionsTextAdapter {
  constructor(options: DeepInfraAdapterOptions) {
    if (!options.apiKey) {
      throw new Error("DEEPINFRA_API_KEY is required for DeepInfra text generation.");
    }

    const model = options.model ?? DEFAULT_DEEPINFRA_MODEL;
    const thinkingEnabled = options.thinkingEnabled ?? thinkingEffortEnabled(options.thinkingEffort);
    const thinkingEffort = deepInfraReasoningEffort(options.thinkingEffort, thinkingEnabled);
    super({
      client: new OpenAI({
        apiKey: options.apiKey,
        baseURL: options.baseURL ?? DEFAULT_DEEPINFRA_BASE_URL
      }),
      model,
      provider: PROVIDER_ID,
      providerLabel: PROVIDER_LABEL,
      requestParameters: standardRequestParameters,
      reasoningParameters: () => deepInfraReasoningConfig(thinkingEnabled, thinkingEffort),
      convertMessages: toOpenAiChatMessages,
      usageFromResponse: usageFromDeepInfra,
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

function deepInfraReasoningConfig(enabled: boolean, effort: DeepInfraReasoningEffort | undefined) {
  const selectedEffort = effort ?? "high";
  return enabled
    ? { reasoning: { enabled: true, effort: selectedEffort }, reasoning_effort: selectedEffort }
    : { reasoning: { enabled: false }, reasoning_effort: "none" };
}

function thinkingEffortEnabled(effort: ThinkingEffort | undefined): boolean {
  return effort !== undefined && effort !== "none";
}

function deepInfraReasoningEffort(
  effort: ThinkingEffort | undefined,
  enabled: boolean
): DeepInfraReasoningEffort | undefined {
  if (!enabled) {
    return undefined;
  }
  if (effort === "low" || effort === "medium" || effort === "high") {
    return effort;
  }
  return "high";
}

function usageFromDeepInfra(usage: unknown): Usage | undefined {
  if (!usage || typeof usage !== "object") {
    return undefined;
  }
  const record = usage as { prompt_tokens?: number; completion_tokens?: number };
  return {
    promptTokens: record.prompt_tokens,
    outputTokens: record.completion_tokens,
    cacheHitTokens: deepInfraCacheHitTokens(usage)
  };
}

function deepInfraCacheHitTokens(usage: unknown): number | undefined {
  if (!usage || typeof usage !== "object") {
    return undefined;
  }
  const record = usage as {
    prompt_cache_hit_tokens?: unknown;
    prompt_tokens_details?: { cached_tokens?: unknown };
  };
  if (typeof record.prompt_cache_hit_tokens === "number") {
    return record.prompt_cache_hit_tokens;
  }
  return typeof record.prompt_tokens_details?.cached_tokens === "number"
    ? record.prompt_tokens_details.cached_tokens
    : undefined;
}
