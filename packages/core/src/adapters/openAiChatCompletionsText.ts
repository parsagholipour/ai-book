import type OpenAI from "openai";
import type {
  ChatMessage,
  GenerateJsonOptions,
  GenerateTextOptions,
  GenerateWithToolsOptions,
  JsonResult,
  TextModelAdapter,
  TextResult,
  ToolCallsResult,
  Usage
} from "./types.js";
import { parseJsonObject, parseSchemaWithContext, throwWithProviderUsage } from "./json.js";
import {
  openAiRequestOptions,
  toolCallsFromOpenAiMessage,
  toOpenAiTools
} from "./openaiToolCalling.js";

const JSON_SYSTEM_MESSAGE: ChatMessage = {
  role: "system",
  content: "Return only valid JSON. Do not wrap the JSON in Markdown. Do not include commentary outside the JSON object."
};

type OpenAiChatMessage = OpenAI.Chat.Completions.ChatCompletionMessageParam;
type OpenAiCompletion = OpenAI.Chat.Completions.ChatCompletion;
type OpenAiCompletionChunk = OpenAI.Chat.Completions.ChatCompletionChunk;

export type OpenAIChatCompletionsRequestKind =
  | "text"
  | "text-callback-stream"
  | "json"
  | "json-callback-stream"
  | "text-stream"
  | "tools";

export type OpenAIChatCompletionsTextConfig = {
  client: OpenAI;
  model: string;
  provider: string;
  providerLabel: string;
  requestParameters: (
    options: GenerateTextOptions,
    requestKind: OpenAIChatCompletionsRequestKind
  ) => Record<string, unknown>;
  reasoningParameters: (
    options: GenerateTextOptions,
    requestKind: OpenAIChatCompletionsRequestKind
  ) => Record<string, unknown>;
  convertMessages: (messages: ChatMessage[]) => OpenAiChatMessage[];
  usageFromResponse: (usage: unknown) => Usage | undefined;
  includeUsageInTextStream: boolean;
};

/**
 * Shared implementation for text adapters that speak OpenAI's chat-completions
 * wire protocol. Provider subclasses select policy once; every request path
 * then gets the same abort handling, message conversion, usage collection and
 * result/error metadata.
 */
export abstract class OpenAIChatCompletionsTextAdapter implements TextModelAdapter {
  private readonly client: OpenAI;
  private readonly model: string;
  private readonly provider: string;
  private readonly providerLabel: string;
  private readonly requestParameters: OpenAIChatCompletionsTextConfig["requestParameters"];
  private readonly reasoningParameters: OpenAIChatCompletionsTextConfig["reasoningParameters"];
  private readonly convertMessages: OpenAIChatCompletionsTextConfig["convertMessages"];
  private readonly usageFromResponse: OpenAIChatCompletionsTextConfig["usageFromResponse"];
  private readonly includeUsageInTextStream: boolean;

  protected constructor(config: OpenAIChatCompletionsTextConfig) {
    this.client = config.client;
    this.model = config.model;
    this.provider = config.provider;
    this.providerLabel = config.providerLabel;
    this.requestParameters = config.requestParameters;
    this.reasoningParameters = config.reasoningParameters;
    this.convertMessages = config.convertMessages;
    this.usageFromResponse = config.usageFromResponse;
    this.includeUsageInTextStream = config.includeUsageInTextStream;
  }

  async generateText(options: GenerateTextOptions): Promise<TextResult> {
    if (options.onOutputTextChunk) {
      return this.generateTextStreaming(options);
    }

    const response = await this.createCompletion(options, "text", options.messages);
    return this.textResult(response.choices[0]?.message?.content ?? "", this.usageFromResponse(response.usage));
  }

  async generateJson<T>(options: GenerateJsonOptions<T>): Promise<JsonResult<T>> {
    if (options.onOutputTextChunk) {
      return this.generateJsonStreaming(options);
    }

    const response = await this.createCompletion(options, "json", this.jsonMessages(options.messages), {
      response_format: { type: "json_object" }
    });
    const text = response.choices[0]?.message?.content ?? "{}";
    return this.parseJsonResult(options, text, this.usageFromResponse(response.usage));
  }

  async generateWithTools(options: GenerateWithToolsOptions): Promise<ToolCallsResult> {
    const response = await this.createCompletion(options, "tools", options.messages, {
      tools: toOpenAiTools(options.tools),
      tool_choice: options.toolChoice ?? "auto"
    });
    const message = response.choices[0]?.message;
    const usage = this.usageFromResponse(response.usage);
    return {
      ...this.textResult(message?.content ?? "", usage),
      toolCalls: toolCallsFromOpenAiMessage(message)
    };
  }

  async *streamText(options: GenerateTextOptions): AsyncGenerator<string> {
    const stream = await this.createStream(
      options,
      "text-stream",
      options.messages,
      {},
      this.includeUsageInTextStream
    );
    for await (const chunk of stream) {
      const content = chunk.choices[0]?.delta?.content;
      if (content) {
        yield content;
      }
    }
  }

  private async generateTextStreaming(options: GenerateTextOptions): Promise<TextResult> {
    const streamed = await this.collectStream(options, "text-callback-stream", options.messages);
    return this.textResult(streamed.text, streamed.usage);
  }

  private async generateJsonStreaming<T>(options: GenerateJsonOptions<T>): Promise<JsonResult<T>> {
    const streamed = await this.collectStream(options, "json-callback-stream", this.jsonMessages(options.messages), {
      response_format: { type: "json_object" }
    });
    return this.parseJsonResult(options, streamed.text || "{}", streamed.usage);
  }

  private async collectStream(
    options: GenerateTextOptions,
    requestKind: OpenAIChatCompletionsRequestKind,
    messages: ChatMessage[],
    extraParameters: Record<string, unknown> = {}
  ): Promise<{ text: string; usage: Usage | undefined }> {
    const stream = await this.createStream(options, requestKind, messages, extraParameters, true);
    let text = "";
    let usage: Usage | undefined;
    for await (const chunk of stream) {
      const content = chunk.choices[0]?.delta?.content;
      if (content) {
        text += content;
        await options.onOutputTextChunk?.(content);
      }
      usage = this.usageFromResponse(chunk.usage) ?? usage;
    }
    return { text, usage };
  }

  private async createCompletion(
    options: GenerateTextOptions,
    requestKind: OpenAIChatCompletionsRequestKind,
    messages: ChatMessage[],
    extraParameters: Record<string, unknown> = {}
  ): Promise<OpenAiCompletion> {
    const response = await this.client.chat.completions.create(
      this.request(options, requestKind, messages, extraParameters) as never,
      openAiRequestOptions(options)
    );
    return response as OpenAiCompletion;
  }

  private async createStream(
    options: GenerateTextOptions,
    requestKind: OpenAIChatCompletionsRequestKind,
    messages: ChatMessage[],
    extraParameters: Record<string, unknown>,
    includeUsage: boolean
  ): Promise<AsyncIterable<OpenAiCompletionChunk>> {
    const stream = await this.client.chat.completions.create(
      this.request(options, requestKind, messages, {
        ...extraParameters,
        stream: true,
        ...(includeUsage ? { stream_options: { include_usage: true } } : {})
      }) as never,
      openAiRequestOptions(options)
    );
    return stream as unknown as AsyncIterable<OpenAiCompletionChunk>;
  }

  private request(
    options: GenerateTextOptions,
    requestKind: OpenAIChatCompletionsRequestKind,
    messages: ChatMessage[],
    extraParameters: Record<string, unknown>
  ): Record<string, unknown> {
    return {
      model: this.model,
      messages: this.convertMessages(messages),
      ...this.requestParameters(options, requestKind),
      ...extraParameters,
      ...this.reasoningParameters(options, requestKind)
    };
  }

  private jsonMessages(messages: ChatMessage[]): ChatMessage[] {
    return [JSON_SYSTEM_MESSAGE, ...messages];
  }

  private textResult(text: string, usage: Usage | undefined): TextResult {
    return {
      text,
      model: this.model,
      provider: this.provider,
      ...(usage ? { usage } : {})
    };
  }

  private parseJsonResult<T>(
    options: GenerateJsonOptions<T>,
    text: string,
    usage: Usage | undefined
  ): JsonResult<T> {
    let parsedObject: unknown;
    try {
      parsedObject = parseJsonObject(text, this.providerLabel);
    } catch (error) {
      throwWithProviderUsage(error, { provider: this.provider, model: this.model, usage });
    }

    try {
      return {
        ...this.textResult(text, usage),
        data: parseSchemaWithContext(this.providerLabel, options.schema, parsedObject, options.purpose, text)
      };
    } catch (error) {
      throwWithProviderUsage(error, { provider: this.provider, model: this.model, usage });
    }
  }
}

export function openAiChatCompletionsRequestParameters(
  options: GenerateTextOptions
): Record<string, unknown> {
  return {
    ...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
    ...(options.maxTokens !== undefined ? { max_tokens: options.maxTokens } : {})
  };
}

export function usageFromOpenAiChatCompletions(usage: unknown): Usage | undefined {
  if (!usage || typeof usage !== "object") {
    return undefined;
  }
  const record = usage as { prompt_tokens?: number; completion_tokens?: number };
  const cacheHitTokens = openAiChatCompletionsCacheHitTokens(usage);
  return {
    promptTokens: record.prompt_tokens,
    outputTokens: record.completion_tokens,
    ...(cacheHitTokens !== undefined ? { cacheHitTokens } : {})
  };
}

function openAiChatCompletionsCacheHitTokens(usage: unknown): number | undefined {
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
