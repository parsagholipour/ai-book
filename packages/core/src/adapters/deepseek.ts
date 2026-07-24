import OpenAI from "openai";
import type {
  GenerateJsonOptions,
  GenerateTextOptions,
  GenerateWithToolsOptions,
  JsonResult,
  TextModelAdapter,
  TextResult,
  ToolCallsResult,
  Usage
} from "./types.js";
import { generateWithToolsViaOpenAi } from "./openaiToolCalling.js";
import {
  AdapterJsonParseError as DeepSeekJsonParseError,
  AdapterJsonValidationError as DeepSeekJsonValidationError,
  parseJsonObject as parseAdapterJsonObject,
  parseSchemaWithContext as parseAdapterSchemaWithContext,
  throwWithProviderUsage
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

export class DeepSeekAdapter implements TextModelAdapter {
  private readonly client: OpenAI;
  private readonly model: string;
  private readonly thinkingEnabled: boolean;
  private readonly thinkingEffort: DeepSeekReasoningEffort | undefined;

  constructor(options: DeepSeekAdapterOptions) {
    if (!options.apiKey) {
      throw new Error("DEEPSEEK_API_KEY is required when MOCK_AI=false.");
    }

    this.model = options.model ?? "deepseek-v4-pro";
    this.thinkingEnabled = options.thinkingEnabled ?? thinkingEffortEnabled(options.thinkingEffort);
    this.thinkingEffort = deepSeekReasoningEffort(options.thinkingEffort, this.thinkingEnabled);
    this.client = new OpenAI({
      apiKey: options.apiKey,
      baseURL: options.baseURL ?? "https://api.deepseek.com"
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
      ...deepSeekThinkingConfig(this.thinkingEnabled, this.thinkingEffort)
    } as never);

    const text = response.choices[0]?.message?.content ?? "";
    const usage = usageFromDeepSeek(response.usage);
    return {
      text,
      model: this.model,
      provider: "deepseek",
      ...(usage ? { usage } : {})
    };
  }

  async generateWithTools(options: GenerateWithToolsOptions): Promise<ToolCallsResult> {
    return generateWithToolsViaOpenAi({
      client: this.client,
      model: this.model,
      provider: "deepseek",
      options,
      extraParams: deepSeekThinkingConfig(this.thinkingEnabled, this.thinkingEffort),
      usageFromResponse: usageFromDeepSeek
    });
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
      ...deepSeekThinkingConfig(this.thinkingEnabled, this.thinkingEffort)
    } as never);

    const text = response.choices[0]?.message?.content ?? "{}";
    const usage = usageFromDeepSeek(response.usage);
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
      ...deepSeekThinkingConfig(this.thinkingEnabled, this.thinkingEffort)
    } as never);

    let text = "";
    let usage: Usage | undefined;
    for await (const chunk of stream) {
      const content = chunk.choices[0]?.delta?.content;
      if (content) {
        text += content;
        await options.onOutputTextChunk?.(content);
      }
      usage = usageFromDeepSeek(chunk.usage) ?? usage;
    }

    return {
      text,
      model: this.model,
      provider: "deepseek",
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
      ...deepSeekThinkingConfig(this.thinkingEnabled, this.thinkingEffort)
    } as never);

    let text = "";
    let usage: Usage | undefined;
    for await (const chunk of stream) {
      const content = chunk.choices[0]?.delta?.content;
      if (content) {
        text += content;
        await options.onOutputTextChunk?.(content);
      }
      usage = usageFromDeepSeek(chunk.usage) ?? usage;
    }

    return this.parseJsonResult(options, text || "{}", usage);
  }

  private parseJsonResult<T>(options: GenerateJsonOptions<T>, text: string, usage: Usage | undefined): JsonResult<T> {
    let parsedObject: unknown;
    try {
      parsedObject = parseJsonObject(text);
    } catch (error) {
      throwWithProviderUsage(error, { provider: "deepseek", model: this.model, usage });
    }
    if (options.purpose === "generate-chapter-brief") {
      return {
        data: parsedObject as T,
        text,
        model: this.model,
        provider: "deepseek",
        ...(usage ? { usage } : {})
      };
    }
    try {
      const parsed = parseSchemaWithContext(options.schema, parsedObject, options.purpose, text);
      return {
        data: parsed,
        text,
        model: this.model,
        provider: "deepseek",
        ...(usage ? { usage } : {})
      };
    } catch (error) {
      throwWithProviderUsage(error, { provider: "deepseek", model: this.model, usage });
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
      ...deepSeekThinkingConfig(this.thinkingEnabled, this.thinkingEffort)
    } as never);

    for await (const chunk of stream) {
      const content = chunk.choices[0]?.delta?.content;
      if (content) {
        yield content;
      }
    }
  }
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

function usageFromDeepSeek(usage: { prompt_tokens?: number; completion_tokens?: number; prompt_cache_hit_tokens?: number } | null | undefined): Usage | undefined {
  if (!usage) {
    return undefined;
  }
  return {
    promptTokens: usage.prompt_tokens,
    outputTokens: usage.completion_tokens,
    cacheHitTokens: usage.prompt_cache_hit_tokens
  };
}

export function parseJsonObject(text: string): unknown {
  return parseAdapterJsonObject(text, "DeepSeek");
}

function parseSchemaWithContext<T>(
  schema: GenerateJsonOptions<T>["schema"],
  value: unknown,
  purpose: string | undefined,
  rawText: string
): T {
  return parseAdapterSchemaWithContext("DeepSeek", schema, value, purpose, rawText);
}
