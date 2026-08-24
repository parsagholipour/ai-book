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
import {
  parseJsonObject,
  parseSchemaWithContext,
  throwWithProviderUsage
} from "./json.js";
import {
  generateWithToolsViaOpenAi,
  openAiRequestOptions,
  toOpenAiChatMessages
} from "./openaiToolCalling.js";

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
export class OpenAICompatibleTextAdapter implements TextModelAdapter {
  private readonly client: OpenAI;
  private readonly model: string;

  constructor(options: OpenAICompatibleAdapterOptions) {
    if (!options.baseURL) {
      throw new Error("LOCAL_TEXT_BASE_URL is required for the openai-compatible text provider.");
    }
    if (!options.model) {
      throw new Error("LOCAL_TEXT_MODEL is required for the openai-compatible text provider.");
    }
    this.model = options.model;
    this.client = new OpenAI({
      apiKey: options.apiKey?.trim() || "local",
      baseURL: options.baseURL
    });
  }

  async generateText(options: GenerateTextOptions): Promise<TextResult> {
    if (options.onOutputTextChunk) {
      return this.generateTextStreaming(options);
    }

    const response = await this.client.chat.completions.create({
      model: this.model,
      messages: toOpenAiChatMessages(options.messages),
      temperature: options.temperature ?? null,
      ...maxTokensParam(options.maxTokens)
    }, openAiRequestOptions(options));

    const text = response.choices[0]?.message?.content ?? "";
    const usage = usageFromOpenAiCompatible(response.usage);
    return {
      text,
      model: this.model,
      provider: PROVIDER_ID,
      ...(usage ? { usage } : {})
    };
  }

  async generateWithTools(options: GenerateWithToolsOptions): Promise<ToolCallsResult> {
    return generateWithToolsViaOpenAi({
      client: this.client,
      model: this.model,
      provider: PROVIDER_ID,
      options,
      usageFromResponse: usageFromOpenAiCompatible
    });
  }

  async generateJson<T>(options: GenerateJsonOptions<T>): Promise<JsonResult<T>> {
    if (options.onOutputTextChunk) {
      return this.generateJsonStreaming(options);
    }

    const response = await this.client.chat.completions.create({
      model: this.model,
      messages: toOpenAiChatMessages([
        {
          role: "system",
          content:
            "Return only valid JSON. Do not wrap the JSON in Markdown. Do not include commentary outside the JSON object."
        },
        ...options.messages
      ]),
      temperature: options.temperature ?? null,
      ...maxTokensParam(options.maxTokens),
      response_format: { type: "json_object" }
    }, openAiRequestOptions(options));

    const text = response.choices[0]?.message?.content ?? "{}";
    const usage = usageFromOpenAiCompatible(response.usage);
    return this.parseJsonResult(options, text, usage);
  }

  private async generateTextStreaming(options: GenerateTextOptions): Promise<TextResult> {
    const stream: any = await this.client.chat.completions.create({
      model: this.model,
      // Through the same conversion the non-streaming paths use: a raw tool
      // message carries internal `toolCallId`/`toolName` keys instead of the
      // wire's `tool_call_id`, and strict servers 400 the streaming call that
      // succeeds unstreamed.
      messages: toOpenAiChatMessages(options.messages),
      temperature: options.temperature ?? null,
      ...maxTokensParam(options.maxTokens),
      stream: true,
      stream_options: { include_usage: true }
    } as never, openAiRequestOptions(options));

    let text = "";
    let usage: Usage | undefined;
    for await (const chunk of stream) {
      const content = chunk.choices[0]?.delta?.content;
      if (content) {
        text += content;
        await options.onOutputTextChunk?.(content);
      }
      usage = usageFromOpenAiCompatible(chunk.usage) ?? usage;
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
      temperature: options.temperature ?? null,
      ...maxTokensParam(options.maxTokens),
      response_format: { type: "json_object" },
      stream: true,
      stream_options: { include_usage: true }
    } as never, openAiRequestOptions(options));

    let text = "";
    let usage: Usage | undefined;
    for await (const chunk of stream) {
      const content = chunk.choices[0]?.delta?.content;
      if (content) {
        text += content;
        await options.onOutputTextChunk?.(content);
      }
      usage = usageFromOpenAiCompatible(chunk.usage) ?? usage;
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
    const stream = await this.client.chat.completions.create({
      model: this.model,
      messages: toOpenAiChatMessages(options.messages),
      temperature: options.temperature ?? null,
      ...maxTokensParam(options.maxTokens),
      stream: true
    }, openAiRequestOptions(options));

    for await (const chunk of stream) {
      const content = chunk.choices[0]?.delta?.content;
      if (content) {
        yield content;
      }
    }
  }
}

function maxTokensParam(maxTokens: number | undefined): { max_tokens?: number } {
  return maxTokens === undefined ? {} : { max_tokens: maxTokens };
}

function usageFromOpenAiCompatible(usage: { prompt_tokens?: number; completion_tokens?: number } | null | undefined): Usage | undefined {
  if (!usage) {
    return undefined;
  }
  return {
    promptTokens: usage.prompt_tokens,
    outputTokens: usage.completion_tokens
  };
}
