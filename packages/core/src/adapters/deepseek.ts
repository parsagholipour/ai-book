import OpenAI from "openai";
import type {
  GenerateJsonOptions,
  GenerateTextOptions,
  JsonResult,
  TextModelAdapter,
  TextResult
} from "./types.js";
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
};

export class DeepSeekAdapter implements TextModelAdapter {
  private readonly client: OpenAI;
  private readonly model: string;
  private readonly thinkingEnabled: boolean;

  constructor(options: DeepSeekAdapterOptions) {
    if (!options.apiKey) {
      throw new Error("DEEPSEEK_API_KEY is required when MOCK_AI=false.");
    }

    this.model = options.model ?? "deepseek-v4-pro";
    this.thinkingEnabled = options.thinkingEnabled ?? false;
    this.client = new OpenAI({
      apiKey: options.apiKey,
      baseURL: options.baseURL ?? "https://api.deepseek.com"
    });
  }

  async generateText(options: GenerateTextOptions): Promise<TextResult> {
    const response = await this.client.chat.completions.create({
      model: this.model,
      messages: options.messages,
      temperature: options.temperature,
      max_tokens: options.maxTokens,
      thinking: deepSeekThinkingConfig(this.thinkingEnabled)
    } as never);

    const text = response.choices[0]?.message?.content ?? "";
    return {
      text,
      model: this.model,
      provider: "deepseek",
      usage: {
        promptTokens: response.usage?.prompt_tokens,
        outputTokens: response.usage?.completion_tokens,
        cacheHitTokens: (response.usage as { prompt_cache_hit_tokens?: number } | undefined)?.prompt_cache_hit_tokens
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
      thinking: deepSeekThinkingConfig(this.thinkingEnabled)
    } as never);

    const text = response.choices[0]?.message?.content ?? "{}";
    const usage = {
      promptTokens: response.usage?.prompt_tokens,
      outputTokens: response.usage?.completion_tokens,
      cacheHitTokens: (response.usage as { prompt_cache_hit_tokens?: number } | undefined)?.prompt_cache_hit_tokens
    };
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
        usage
      };
    }
    try {
      const parsed = parseSchemaWithContext(options.schema, parsedObject, options.purpose, text);
      return {
        data: parsed,
        text,
        model: this.model,
        provider: "deepseek",
        usage
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
      thinking: deepSeekThinkingConfig(this.thinkingEnabled)
    } as never);

    for await (const chunk of stream) {
      const content = chunk.choices[0]?.delta?.content;
      if (content) {
        yield content;
      }
    }
  }
}

function deepSeekThinkingConfig(enabled: boolean): { type: "enabled" | "disabled" } {
  return { type: enabled ? "enabled" : "disabled" };
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
