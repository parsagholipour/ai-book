import OpenAI from "openai";
import type { GenerateTextOptions, Usage } from "./types.js";
import {
  OpenAIChatCompletionsTextAdapter,
  type OpenAIChatCompletionsRequestKind
} from "./openAiChatCompletionsText.js";
import { toOpenAiChatMessages } from "./openaiToolCalling.js";

const PROVIDER_LABEL = "OpenAICompatible";
const PROVIDER_ID = "openai-compatible";

export type OpenAICompatibleAdapterOptions = {
  /** Chat-completions base URL, e.g. http://localhost:11434/v1 (Ollama) or http://localhost:8000/v1 (vLLM). */
  baseURL: string | undefined;
  model: string | undefined;
  /** Most local servers ignore the key; a placeholder is sent when omitted. */
  apiKey?: string | undefined;
};

/**
 * Text adapter for any OpenAI-compatible chat-completions server (Ollama,
 * vLLM, LM Studio, llama.cpp server, ...). Lets the basic tier run on a normal
 * server at zero marginal cost while the pro tier stays on cloud providers.
 */
export class OpenAICompatibleTextAdapter extends OpenAIChatCompletionsTextAdapter {
  constructor(options: OpenAICompatibleAdapterOptions) {
    if (!options.baseURL) {
      throw new Error("LOCAL_TEXT_BASE_URL is required for the openai-compatible text provider.");
    }
    if (!options.model) {
      throw new Error("LOCAL_TEXT_MODEL is required for the openai-compatible text provider.");
    }
    super({
      client: new OpenAI({
        apiKey: options.apiKey?.trim() || "local",
        baseURL: options.baseURL
      }),
      model: options.model,
      provider: PROVIDER_ID,
      providerLabel: PROVIDER_LABEL,
      requestParameters: openAiCompatibleRequestParameters,
      reasoningParameters: noReasoningParameters,
      convertMessages: toOpenAiChatMessages,
      usageFromResponse: usageFromOpenAiCompatible,
      includeUsageInTextStream: false
    });
  }
}

function openAiCompatibleRequestParameters(
  options: GenerateTextOptions,
  requestKind: OpenAIChatCompletionsRequestKind
): Record<string, unknown> {
  if (requestKind === "tools") {
    return {
      temperature: options.temperature,
      max_tokens: options.maxTokens
    };
  }
  return {
    temperature: options.temperature ?? null,
    ...maxTokensParam(options.maxTokens)
  };
}

function noReasoningParameters(): Record<string, unknown> {
  return {};
}

function maxTokensParam(maxTokens: number | undefined): { max_tokens?: number } {
  return maxTokens === undefined ? {} : { max_tokens: maxTokens };
}

function usageFromOpenAiCompatible(usage: unknown): Usage | undefined {
  if (!usage || typeof usage !== "object") {
    return undefined;
  }
  const record = usage as { prompt_tokens?: number; completion_tokens?: number };
  return {
    promptTokens: record.prompt_tokens,
    outputTokens: record.completion_tokens
  };
}
