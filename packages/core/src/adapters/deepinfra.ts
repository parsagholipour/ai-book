import OpenAI from "openai";
import type {
  GenerateJsonOptions,
  GenerateTextOptions,
  JsonResult,
  TextModelAdapter,
  TextResult,
  Usage
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
  thinkingEffort?: ThinkingEffort | undefined;
};

type ThinkingEffort = "none" | "minimal" | "low" | "medium" | "high" | "max";
type DeepInfraReasoningEffort = "low" | "medium" | "high";

export class DeepInfraAdapter implements TextModelAdapter {
  private readonly client: OpenAI;
  private readonly model: string;
  private readonly thinkingEnabled: boolean;
  private readonly thinkingEffort: DeepInfraReasoningEffort | undefined;

  constructor(options: DeepInfraAdapterOptions) {
    if (!options.apiKey) {
      throw new Error("DEEPINFRA_API_KEY is required for DeepInfra text generation.");
    }

    this.model = options.model ?? DEFAULT_DEEPINFRA_MODEL;
    this.thinkingEnabled = options.thinkingEnabled ?? thinkingEffortEnabled(options.thinkingEffort);
    this.thinkingEffort = deepInfraReasoningEffort(options.thinkingEffort, this.thinkingEnabled);
    this.client = new OpenAI({
      apiKey: options.apiKey,
      baseURL: options.baseURL ?? DEFAULT_DEEPINFRA_BASE_URL
    });
  }

  async generateText(options: GenerateTextOptions): Promise<TextResult> {
    if (options.onOutputTextChunk) {
      return this.generateTextStreaming(options);
    }

    const response = await this.client.chat.completions.create({
      model: this.model,
      messages: options.messages,
      temperature: options.temperature,
      max_tokens: options.maxTokens,
      ...deepInfraReasoningConfig(this.thinkingEnabled, this.thinkingEffort)
    } as never);

    const text = response.choices[0]?.message?.content ?? "";
    const usage = usageFromDeepInfra(response.usage);
    return {
      text,
      model: this.model,
      provider: PROVIDER_ID,
      ...(usage ? { usage } : {})
    };
  }

  async generateJson<T>(options: GenerateJsonOptions<T>): Promise<JsonResult<T>> {
    if (options.onOutputTextChunk) {
      return this.generateJsonStreaming(options);
    }

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
      ...deepInfraReasoningConfig(this.thinkingEnabled, this.thinkingEffort)
    } as never);

    const text = response.choices[0]?.message?.content ?? "{}";
    const usage = usageFromDeepInfra(response.usage);
    return this.parseJsonResult(options, text, usage);
  }

  private async generateTextStreaming(options: GenerateTextOptions): Promise<TextResult> {
    const stream: any = await this.client.chat.completions.create({
      model: this.model,
      messages: options.messages,
      temperature: options.temperature,
      max_tokens: options.maxTokens,
      stream: true,
      stream_options: { include_usage: true },
      ...deepInfraReasoningConfig(this.thinkingEnabled, this.thinkingEffort)
    } as never);

    let text = "";
    let usage: Usage | undefined;
    for await (const chunk of stream) {
      const content = chunk.choices[0]?.delta?.content;
      if (content) {
        text += content;
        await options.onOutputTextChunk?.(content);
      }
      usage = usageFromDeepInfra(chunk.usage) ?? usage;
    }

    return {
      text,
      model: this.model,
      provider: PROVIDER_ID,
      ...(usage ? { usage } : {})
    };
  }

  private async generateJsonStreaming<T>(options: GenerateJsonOptions<T>): Promise<JsonResult<T>> {
    const stream: any = await this.client.chat.completions.create({
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
      stream: true,
      stream_options: { include_usage: true },
      ...deepInfraReasoningConfig(this.thinkingEnabled, this.thinkingEffort)
    } as never);

    let text = "";
    let usage: Usage | undefined;
    for await (const chunk of stream) {
      const content = chunk.choices[0]?.delta?.content;
      if (content) {
        text += content;
        await options.onOutputTextChunk?.(content);
      }
      usage = usageFromDeepInfra(chunk.usage) ?? usage;
    }

    return this.parseJsonResult(options, text || "{}", usage);
  }

  private parseJsonResult<T>(options: GenerateJsonOptions<T>, text: string, usage: Usage | undefined): JsonResult<T> {
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
        ...(usage ? { usage } : {})
      };
    }
    try {
      return {
        data: parseSchemaWithContext(PROVIDER_LABEL, options.schema, parsedObject, options.purpose, text),
        text,
        model: this.model,
        provider: PROVIDER_ID,
        ...(usage ? { usage } : {})
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
      ...deepInfraReasoningConfig(this.thinkingEnabled, this.thinkingEffort)
    } as never);

    for await (const chunk of stream) {
      const content = chunk.choices[0]?.delta?.content;
      if (content) {
        yield content;
      }
    }
  }
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
