import OpenAI from "openai";
import type { TextModelThinkingEffort } from "../schemas/book.js";
import {
  OpenAIChatCompletionsTextAdapter,
  openAiChatCompletionsRequestParameters,
  usageFromOpenAiChatCompletions
} from "./openAiChatCompletionsText.js";
import { toOpenAiChatMessages } from "./openaiToolCalling.js";
import { DEFAULT_OPENROUTER_BASE_URL, OPENROUTER_GLM_53_FLASH_MODEL } from "./openrouterModels.js";

const PROVIDER_LABEL = "OpenRouter";
const PROVIDER_ID = "openrouter";

export type OpenRouterAdapterOptions = {
  apiKey: string | undefined;
  baseURL?: string | undefined;
  model?: string | undefined;
  thinkingEnabled?: boolean | undefined;
  thinkingEffort?: TextModelThinkingEffort | undefined;
};

type OpenRouterReasoningEffort = "low" | "high" | "max";

export class OpenRouterAdapter extends OpenAIChatCompletionsTextAdapter {
  constructor(options: OpenRouterAdapterOptions) {
    if (!options.apiKey) {
      throw new Error("OPENROUTER_API_KEY is required for OpenRouter text generation.");
    }

    const model = options.model ?? OPENROUTER_GLM_53_FLASH_MODEL;
    const thinkingEffort = openRouterReasoningEffort(options.thinkingEffort, options.thinkingEnabled);
    super({
      client: new OpenAI({
        apiKey: options.apiKey,
        baseURL: options.baseURL ?? DEFAULT_OPENROUTER_BASE_URL
      }),
      model,
      provider: PROVIDER_ID,
      providerLabel: PROVIDER_LABEL,
      requestParameters: openAiChatCompletionsRequestParameters,
      reasoningParameters: () => openRouterReasoningConfig(thinkingEffort),
      convertMessages: toOpenAiChatMessages,
      usageFromResponse: usageFromOpenAiChatCompletions,
      includeUsageInTextStream: true
    });
  }
}

function openRouterReasoningConfig(effort: OpenRouterReasoningEffort) {
  return {
    reasoning: { enabled: true, effort },
    reasoning_effort: effort
  };
}

/**
 * GLM-5.3-Flash cannot disable reasoning. Unsupported catalog efforts collapse
 * onto the nearest supported level rather than sending `none`, which OpenRouter
 * rejects for this model.
 */
function openRouterReasoningEffort(
  effort: TextModelThinkingEffort | undefined,
  enabled: boolean | undefined
): OpenRouterReasoningEffort {
  if (enabled === false || effort === "none") {
    return "low";
  }
  if (effort === "max" || effort === "xhigh") {
    return "max";
  }
  if (effort === "low" || effort === "minimal") {
    return "low";
  }
  return "high";
}
