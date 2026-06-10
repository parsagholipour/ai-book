import OpenAI from "openai";
import type {
  GenerateJsonOptions,
  GenerateTextOptions,
  JsonResult,
  TextModelAdapter,
  TextResult
} from "./types.js";
import {
  parseJsonObject,
  parseSchemaWithContext,
  throwWithProviderUsage
} from "./json.js";
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
};

export class DeepInfraAdapter implements TextModelAdapter {
  private readonly client: OpenAI;
  private readonly model: string;
  private readonly thinkingEnabled: boolean;

  constructor(options: DeepInfraAdapterOptions) {
    if (!options.apiKey) {
      throw new Error("DEEPINFRA_API_KEY is required for DeepInfra text generation.");
    }

    this.model = options.model ?? DEFAULT_DEEPINFRA_MODEL;
    this.thinkingEnabled = options.thinkingEnabled ?? false;
    this.client = new OpenAI({
      apiKey: options.apiKey,
      baseURL: options.baseURL ?? DEFAULT_DEEPINFRA_BASE_URL
    });
  }

  async generateText(options: GenerateTextOptions): Promise<TextResult> {
    const response = await this.client.chat.completions.create({
      model: this.model,
      messages: options.messages,
      temperature: options.temperature,
      max_tokens: options.maxTokens,
      ...deepInfraReasoningConfig(this.thinkingEnabled)
    } as never);

    const text = response.choices[0]?.message?.content ?? "";
    return {
      text,
      model: this.model,
      provider: PROVIDER_ID,
      usage: {
        promptTokens: response.usage?.prompt_tokens,
        outputTokens: response.usage?.completion_tokens,
        cacheHitTokens: deepInfraCacheHitTokens(response.usage)
      }
    };
  }

  async generateJson<T>(options: GenerateJsonOptions<T>): Promise<JsonResult<T>> {
    const response = await this.client.chat.completions.create({
      model: this.model,
      messages: [
        {
          role: "system",
          content:
            "Return only valid JSON. Do not wrap the JSON in Markdown. Do not include commentary outside the JSON object."
        },
        ...options.messages
      ],
      temperature: options.temperature,
      max_tokens: options.maxTokens,
      response_format: { type: "json_object" },
      ...deepInfraReasoningConfig(this.thinkingEnabled)
    } as never);

    const text = response.choices[0]?.message?.content ?? "{}";
    const usage = {
      promptTokens: response.usage?.prompt_tokens,
      outputTokens: response.usage?.completion_tokens,
      cacheHitTokens: deepInfraCacheHitTokens(response.usage)
    };
    let parsedObject: unknown;
    try {
      parsedObject = parseJsonObject(text, PROVIDER_LABEL);
    } catch (error) {
      throwWithProviderUsage(error, { provider: PROVIDER_ID, model: this.model, usage });
    }
    if (options.purpose === "generate-chapter-brief") {
      return {
        data: parsedObject as T,
        text,
        model: this.model,
        provider: PROVIDER_ID,
        usage
      };
    }
    try {
      return {
        data: parseSchemaWithContext(PROVIDER_LABEL, options.schema, parsedObject, options.purpose, text),
        text,
        model: this.model,
        provider: PROVIDER_ID,
        usage
      };
    } catch (error) {
      throwWithProviderUsage(error, { provider: PROVIDER_ID, model: this.model, usage });
    }
  }

  async *streamText(options: GenerateTextOptions): AsyncGenerator<string> {
    const stream: any = await this.client.chat.completions.create({
      model: this.model,
      messages: options.messages,
      temperature: options.temperature,
      max_tokens: options.maxTokens,
      stream: true,
      stream_options: { include_usage: true },
      ...deepInfraReasoningConfig(this.thinkingEnabled)
    } as never);

    for await (const chunk of stream) {
      const content = chunk.choices[0]?.delta?.content;
      if (content) {
        yield content;
      }
    }
  }
}

function deepInfraReasoningConfig(enabled: boolean) {
  return enabled
    ? { reasoning: { enabled: true, effort: "high" }, reasoning_effort: "high" }
    : { reasoning: { enabled: false }, reasoning_effort: "none" };
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
