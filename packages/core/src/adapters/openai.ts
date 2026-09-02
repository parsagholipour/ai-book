import { createHash } from "node:crypto";
import OpenAI from "openai";
import type { TextModelThinkingEffort } from "../schemas/book.js";
import { parseJsonObject, parseSchemaWithContext, throwWithProviderUsage } from "./json.js";
import { OPENAI_GPT_5_6_SOL_MODEL } from "./openaiModels.js";
import {
  openAiRequestOptions,
  parseOpenAiToolArguments,
  serializeOpenAiToolArguments,
  toolParametersJsonSchema
} from "./openaiToolCalling.js";
import { isCancellationError, ProviderHttpError } from "./retry.js";
import type {
  ChatMessage,
  GenerateJsonOptions,
  GenerateTextOptions,
  GenerateWithToolsOptions,
  JsonResult,
  TextModelAdapter,
  TextResult,
  ToolCall,
  ToolCallsResult,
  ToolDefinition,
  Usage
} from "./types.js";

const PROVIDER_ID = "openai";
const PROVIDER_LABEL = "OpenAI";
const MAX_REMEMBERED_TOOL_CALLS = 256;
const JSON_SYSTEM_MESSAGE: ChatMessage = {
  role: "system",
  content: "Return only valid JSON. Do not wrap the JSON in Markdown. Do not include commentary outside the JSON object."
};

export type OpenAITextAdapterOptions = {
  apiKey: string | undefined;
  model?: string | undefined;
  thinkingEnabled?: boolean | undefined;
  thinkingEffort?: TextModelThinkingEffort | undefined;
};

type ResponseRecord = {
  model?: string;
  output_text?: string;
  output?: unknown[];
  usage?: unknown;
  status?: string;
  error?: unknown;
  incomplete_details?: unknown;
};

type RememberedToolTurn = {
  output: unknown[];
};

/** OpenAI GPT text generation through Responses, including reasoning-capable tool loops. */
export class OpenAITextAdapter implements TextModelAdapter {
  private readonly client: OpenAI;
  private readonly model: string;
  private readonly thinkingEffort: TextModelThinkingEffort | undefined;
  private readonly toolTurns = new Map<string, RememberedToolTurn>();

  constructor(options: OpenAITextAdapterOptions) {
    if (!options.apiKey) {
      throw new Error("OPENAI_API_KEY is required for OpenAI text generation.");
    }
    this.client = new OpenAI({ apiKey: options.apiKey });
    this.model = options.model ?? OPENAI_GPT_5_6_SOL_MODEL;
    this.thinkingEffort = options.thinkingEffort ?? enabledEffort(options.thinkingEnabled);
  }

  async generateText(options: GenerateTextOptions): Promise<TextResult> {
    const input = responseInput(options.messages, this.toolTurns);
    if (options.onOutputTextChunk) {
      const streamed = await this.collectStream(options, input);
      return this.textResult(streamed.text, streamed.usage, streamed.model);
    }
    const response = await this.createResponse(options, input);
    return this.textResult(
      response.output_text ?? responseText(response),
      usageFromOpenAIResponse(response.usage),
      response.model
    );
  }

  async generateJson<T>(options: GenerateJsonOptions<T>): Promise<JsonResult<T>> {
    const input = responseInput([JSON_SYSTEM_MESSAGE, ...options.messages], this.toolTurns);
    if (options.onOutputTextChunk) {
      const streamed = await this.collectStream(options, input, jsonTextFormat());
      return this.parseJsonResult(options, streamed.text || "{}", streamed.usage, streamed.model);
    }
    const response = await this.createResponse(options, input, { text: jsonTextFormat() });
    const text = (response.output_text ?? responseText(response)) || "{}";
    return this.parseJsonResult(options, text, usageFromOpenAIResponse(response.usage), response.model);
  }

  async generateWithTools(options: GenerateWithToolsOptions): Promise<ToolCallsResult> {
    const response = await this.createResponse(
      options,
      responseInput(options.messages, this.toolTurns),
      {
        tools: responseTools(options.tools),
        tool_choice: options.toolChoice ?? "auto"
      }
    );
    const toolCalls = toolCallsFromResponse(response);
    this.rememberToolTurn(response, toolCalls);
    if (toolCalls.length === 0) {
      this.forgetTranscriptToolCalls(options.messages);
    }
    return {
      ...this.textResult(
        response.output_text ?? responseText(response),
        usageFromOpenAIResponse(response.usage),
        response.model
      ),
      toolCalls
    };
  }

  async *streamText(options: GenerateTextOptions): AsyncGenerator<string> {
    yield* this.responseStream(options, responseInput(options.messages, this.toolTurns));
  }

  private async createResponse(
    options: GenerateTextOptions,
    input: unknown[],
    extra: Record<string, unknown> = {}
  ): Promise<ResponseRecord> {
    try {
      const response = await (this.client.responses.create(
        this.request(options, input, extra) as never,
        openAiRequestOptions(options)
      ) as unknown as Promise<ResponseRecord>);
      assertResponseSucceeded(response, this.model);
      return response;
    } catch (error) {
      rethrowOpenAiHttpError(error);
    }
  }

  private async collectStream(
    options: GenerateTextOptions,
    input: unknown[],
    text?: Record<string, unknown>
  ): Promise<{ text: string; usage: Usage | undefined; model: string | undefined }> {
    let textOutput = "";
    const stream = this.responseStream(options, input, text ? { text } : {});
    let completed: ResponseRecord;
    while (true) {
      const next = await stream.next();
      if (next.done) {
        completed = next.value;
        break;
      }
      textOutput += next.value;
      await options.onOutputTextChunk?.(next.value);
    }

    return {
      text: textOutput || completed.output_text || responseText(completed),
      usage: usageFromOpenAIResponse(completed.usage),
      model: completed.model
    };
  }

  private async *responseStream(
    options: GenerateTextOptions,
    input: unknown[],
    extra: Record<string, unknown> = {}
  ): AsyncGenerator<string, ResponseRecord> {
    try {
      const stream = await this.client.responses.create(
        this.request(options, input, { stream: true, ...extra }) as never,
        openAiRequestOptions(options)
      );
      let completed: ResponseRecord | undefined;
      for await (const event of stream as unknown as AsyncIterable<Record<string, unknown>>) {
        if (event.type === "response.output_text.delta" && typeof event.delta === "string") {
          yield event.delta;
        }
        const terminal = completedResponseFromEvent(event, this.model);
        if (terminal) {
          completed = terminal;
        }
      }
      if (!completed) {
        throwOpenAIResponseError("OpenAI response stream ended without a completion event.", {
          model: this.model
        });
      }
      return completed;
    } catch (error) {
      rethrowOpenAiHttpError(error);
    }
  }

  private request(
    options: GenerateTextOptions,
    input: unknown[],
    extra: Record<string, unknown>
  ): Record<string, unknown> {
    // Encrypted reasoning is only needed for tool-loop replay when thinking is
    // on. Requesting it at effort "none" can still bill reasoning tokens.
    // Undefined effort keeps include — the model may think by default.
    return {
      model: this.model,
      input,
      store: false,
      // Every prose call of a book shares a long system prefix; without a
      // routing key consecutive calls landed on different cache shards and
      // 0 of 48 calls hit (composed-22). The key is the prefix's own digest,
      // so it needs no plumbing and differs between books.
      prompt_cache_key: promptCacheKey(input),
      ...(this.thinkingEffort !== "none" ? { include: ["reasoning.encrypted_content"] } : {}),
      ...(this.thinkingEffort ? { reasoning: { effort: this.thinkingEffort } } : {}),
      ...(options.temperature !== undefined && this.thinkingEffort === "none"
        ? { temperature: options.temperature }
        : {}),
      ...(options.maxTokens !== undefined ? { max_output_tokens: options.maxTokens } : {}),
      ...extra
    };
  }

  private rememberToolTurn(response: ResponseRecord, toolCalls: ToolCall[]): void {
    if (toolCalls.length === 0 || !Array.isArray(response.output)) {
      return;
    }
    const turn: RememberedToolTurn = { output: response.output };
    for (const call of toolCalls) {
      this.toolTurns.set(call.id, turn);
    }
    while (this.toolTurns.size > MAX_REMEMBERED_TOOL_CALLS) {
      const oldest = this.toolTurns.keys().next().value as string | undefined;
      if (!oldest) break;
      this.toolTurns.delete(oldest);
    }
  }

  private forgetTranscriptToolCalls(messages: ChatMessage[]): void {
    for (const message of messages) {
      for (const call of message.toolCalls ?? []) {
        this.toolTurns.delete(call.id);
      }
    }
  }

  private textResult(text: string, usage: Usage | undefined, responseModel?: string): TextResult {
    return {
      text,
      model: responseModel || this.model,
      provider: PROVIDER_ID,
      ...(usage ? { usage } : {})
    };
  }

  private parseJsonResult<T>(
    options: GenerateJsonOptions<T>,
    text: string,
    usage: Usage | undefined,
    responseModel?: string
  ): JsonResult<T> {
    let parsedObject: unknown;
    try {
      parsedObject = parseJsonObject(text, PROVIDER_LABEL);
    } catch (error) {
      throwWithProviderUsage(error, { provider: PROVIDER_ID, model: responseModel || this.model, usage });
    }
    try {
      return {
        ...this.textResult(text, usage, responseModel),
        data: parseSchemaWithContext(PROVIDER_LABEL, options.schema, parsedObject, options.purpose, text)
      };
    } catch (error) {
      throwWithProviderUsage(error, { provider: PROVIDER_ID, model: responseModel || this.model, usage });
    }
  }
}

function enabledEffort(enabled: boolean | undefined): TextModelThinkingEffort | undefined {
  if (enabled === false) return "none";
  if (enabled === true) return "medium";
  return undefined;
}

function responseInput(
  messages: ChatMessage[],
  remembered: ReadonlyMap<string, RememberedToolTurn> = new Map()
): unknown[] {
  const input: unknown[] = [];
  const replayed = new Set<RememberedToolTurn>();
  for (const message of messages) {
    if (message.role === "tool") {
      input.push({ type: "function_call_output", call_id: message.toolCallId ?? "", output: message.content });
      continue;
    }
    if (message.role === "assistant" && message.toolCalls?.length) {
      const allowedCallIds = new Set(message.toolCalls.map((call) => call.id));
      const turn = message.toolCalls.map((call) => remembered.get(call.id)).find(Boolean);
      if (turn && !replayed.has(turn)) {
        input.push(...turn.output.filter((item) => responseItemBelongsToTranscript(item, allowedCallIds)));
        replayed.add(turn);
      } else if (!turn) {
        if (message.content) input.push({ role: "assistant", content: message.content });
        input.push(...message.toolCalls.map(responseFunctionCall));
      }
      continue;
    }
    input.push({ role: message.role, content: message.content });
  }
  return input;
}

function responseItemBelongsToTranscript(item: unknown, allowedCallIds: ReadonlySet<string>): boolean {
  if (!isRecord(item) || item.type !== "function_call") {
    return true;
  }
  return typeof item.call_id === "string" && allowedCallIds.has(item.call_id);
}

function responseFunctionCall(call: ToolCall): Record<string, unknown> {
  return {
    type: "function_call",
    call_id: call.id,
    name: call.name,
    arguments: serializeOpenAiToolArguments(call.arguments)
  };
}

function responseTools(tools: ToolDefinition[]): Record<string, unknown>[] {
  return tools.map((tool) => ({
    type: "function",
    name: tool.name,
    description: tool.description,
    parameters: toolParametersJsonSchema(tool),
    strict: false
  }));
}

function toolCallsFromResponse(response: ResponseRecord): ToolCall[] {
  const calls: ToolCall[] = [];
  for (const [index, item] of (response.output ?? []).entries()) {
    if (!isRecord(item) || item.type !== "function_call" || typeof item.name !== "string" || !item.name) {
      continue;
    }
    calls.push({
      id: typeof item.call_id === "string" && item.call_id ? item.call_id : `call_${index}`,
      name: item.name,
      arguments: parseOpenAiToolArguments(item.arguments)
    });
  }
  return calls;
}

function responseText(response: ResponseRecord): string {
  return (response.output ?? [])
    .flatMap((item) => {
      if (!isRecord(item) || item.type !== "message" || !Array.isArray(item.content)) return [];
      return item.content
        .filter((part) => isRecord(part) && part.type === "output_text" && typeof part.text === "string")
        .map((part) => (part as { text: string }).text);
    })
    .join("\n")
    .trim();
}

export function promptCacheKey(input: unknown[]): string {
  const first = input[0];
  const content = isRecord(first) ? first.content : undefined;
  const text = typeof content === "string" ? content : JSON.stringify(content ?? "");
  return createHash("sha256").update(text.slice(0, 2500)).digest("hex").slice(0, 24);
}

function usageFromOpenAIResponse(usage: unknown): Usage | undefined {
  if (!isRecord(usage)) return undefined;
  const details = isRecord(usage.input_tokens_details) ? usage.input_tokens_details : undefined;
  const outputDetails = isRecord(usage.output_tokens_details) ? usage.output_tokens_details : undefined;
  return {
    promptTokens: numberValue(usage.input_tokens),
    outputTokens: numberValue(usage.output_tokens),
    cacheHitTokens: numberValue(details?.cached_tokens),
    cacheWriteTokens: numberValue(details?.cache_write_tokens),
    reasoningTokens: numberValue(outputDetails?.reasoning_tokens)
  };
}

function jsonTextFormat(): Record<string, unknown> {
  return { format: { type: "json_object" } };
}

function completedResponseFromEvent(
  event: Record<string, unknown>,
  fallbackModel: string
): ResponseRecord | undefined {
  if (event.type === "error") {
    throwOpenAIResponseError(
      `OpenAI response failed: ${typeof event.message === "string" ? event.message : "Unknown streaming error."}`,
      {
        model: fallbackModel,
        code: stringValue(event.code),
        param: stringValue(event.param)
      }
    );
  }
  if (
    event.type !== "response.completed" &&
    event.type !== "response.failed" &&
    event.type !== "response.incomplete"
  ) {
    return undefined;
  }
  if (!isRecord(event.response)) {
    throwOpenAIResponseError(`OpenAI ${String(event.type)} event did not include a response.`, {
      model: fallbackModel
    });
  }
  const response = event.response as ResponseRecord;
  const eventStatus =
    event.type === "response.completed"
      ? "completed"
      : event.type === "response.failed"
        ? "failed"
        : "incomplete";
  assertResponseSucceeded(response, fallbackModel, eventStatus);
  return response;
}

function assertResponseSucceeded(
  response: ResponseRecord,
  fallbackModel: string,
  eventStatus?: string
): void {
  const status = eventStatus ?? response.status;
  const responseError = isRecord(response.error) ? response.error : undefined;
  const model = response.model || fallbackModel;
  const usage = usageFromOpenAIResponse(response.usage);
  if (status === "failed" || responseError) {
    const message = stringValue(responseError?.message) ?? "The model failed while generating the response.";
    throwOpenAIResponseError(`OpenAI response failed: ${message}`, {
      model,
      usage,
      code: stringValue(responseError?.code)
    });
  }
  if (status === "incomplete") {
    const details = isRecord(response.incomplete_details) ? response.incomplete_details : undefined;
    const reason = stringValue(details?.reason);
    throwOpenAIResponseError(`OpenAI response was incomplete${reason ? `: ${reason}` : ""}.`, {
      model,
      usage
    });
  }
  if (status && status !== "completed") {
    throwOpenAIResponseError(`OpenAI response ended with status "${status}".`, { model, usage });
  }
}

function throwOpenAIResponseError(
  message: string,
  details: {
    model: string;
    usage?: Usage | undefined;
    code?: string | undefined;
    param?: string | undefined;
  }
): never {
  const error = new Error(message) as Error & {
    code?: string | undefined;
    param?: string | undefined;
    status?: number | undefined;
  };
  error.name = "OpenAIResponseError";
  if (details.code) {
    error.code = details.code;
    const status = httpStatusForOpenAIErrorCode(details.code);
    if (status !== undefined) error.status = status;
  }
  if (details.param) error.param = details.param;
  throwWithProviderUsage(error, {
    provider: PROVIDER_ID,
    model: details.model,
    usage: details.usage
  });
}

function httpStatusForOpenAIErrorCode(code: string): number | undefined {
  if (code === "rate_limit_exceeded") return 429;
  if (code === "server_error") return 500;
  if (code.startsWith("invalid_")) return 400;
  return undefined;
}

/**
 * ProviderHttpError, not a bare SDK Error: status and retry-after-ms have to
 * travel as fields or a TPM 429 matches no retry pattern and the text fallback
 * hops before the wait loop sees it. Incomplete OpenAIResponseError is not HTTP.
 */
function rethrowOpenAiHttpError(error: unknown): never {
  if (
    isCancellationError(error) ||
    error instanceof ProviderHttpError ||
    (error instanceof Error && error.name === "OpenAIResponseError")
  ) {
    throw error;
  }
  const status = httpStatusFromOpenAiSdkError(error);
  if (status === undefined) {
    throw error;
  }
  const retryAfterMs = retryAfterMsFromOpenAiSdkError(error);
  throw new ProviderHttpError(error instanceof Error ? error.message : String(error), {
    status,
    ...(retryAfterMs === undefined ? {} : { retryAfterMs })
  });
}

function httpStatusFromOpenAiSdkError(error: unknown): number | undefined {
  const code = openAiSdkErrorCode(error);
  if (code) {
    const mapped = httpStatusForOpenAIErrorCode(code);
    if (mapped !== undefined) return mapped;
  }
  for (const layer of openAiSdkErrorLayers(error)) {
    const status = parseHttpStatus(layer.status) ?? parseHttpStatus(layer.statusCode);
    if (status !== undefined) return status;
  }
  return undefined;
}

function openAiSdkErrorCode(error: unknown): string | undefined {
  if (!isRecord(error)) return undefined;
  return stringValue(error.code) ?? (isRecord(error.error) ? stringValue(error.error.code) : undefined);
}

function retryAfterMsFromOpenAiSdkError(error: unknown): number | undefined {
  const bags = headerBagsFromOpenAiSdkError(error);
  const fromMs = parsePositiveNumber(firstHeader(bags, "retry-after-ms"));
  if (fromMs !== undefined) return fromMs;
  return parseRetryAfterHeader(firstHeader(bags, "retry-after"));
}

function openAiSdkErrorLayers(error: unknown): Record<string, unknown>[] {
  if (!isRecord(error)) return [];
  const layers = [error];
  if (isRecord(error.error)) layers.push(error.error);
  if (isRecord(error.response)) layers.push(error.response);
  return layers;
}

function headerBagsFromOpenAiSdkError(error: unknown): unknown[] {
  const bags: unknown[] = [];
  for (const layer of openAiSdkErrorLayers(error)) {
    if (layer.headers !== undefined) bags.push(layer.headers);
  }
  return bags;
}

function firstHeader(bags: unknown[], name: string): unknown {
  for (const bag of bags) {
    const value = headerValue(bag, name);
    if (value !== undefined && value !== null && value !== "") return value;
  }
  return undefined;
}

function headerValue(headers: unknown, name: string): unknown {
  if (headers && typeof headers === "object" && typeof (headers as { get?: unknown }).get === "function") {
    return (headers as Headers).get(name);
  }
  if (!isRecord(headers)) return undefined;
  const lower = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === lower) return value;
  }
  return undefined;
}

function parseRetryAfterHeader(value: unknown): number | undefined {
  const seconds = parsePositiveNumber(value);
  if (seconds !== undefined) return Math.round(seconds * 1_000);
  if (typeof value !== "string") return undefined;
  const at = Date.parse(value);
  return Number.isFinite(at) && at > Date.now() ? at - Date.now() : undefined;
}

function parseHttpStatus(value: unknown): number | undefined {
  const parsed = parseFiniteNumber(value);
  return parsed !== undefined && parsed >= 400 ? parsed : undefined;
}

function parsePositiveNumber(value: unknown): number | undefined {
  const parsed = parseFiniteNumber(value);
  return parsed !== undefined && parsed > 0 ? parsed : undefined;
}

function parseFiniteNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
