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
    const response = await this.client.chat.completions.create({
      model: this.model,
      messages: options.messages,
      temperature: options.temperature ?? null,
      max_tokens: options.maxTokens ?? null
    });

    const text = response.choices[0]?.message?.content ?? "";
    return {
      text,
      model: this.model,
      provider: PROVIDER_ID,
      usage: {
        promptTokens: response.usage?.prompt_tokens,
        outputTokens: response.usage?.completion_tokens
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
      temperature: options.temperature ?? null,
      max_tokens: options.maxTokens ?? null,
      response_format: { type: "json_object" }
    });

    const text = response.choices[0]?.message?.content ?? "{}";
    const usage = {
      promptTokens: response.usage?.prompt_tokens,
      outputTokens: response.usage?.completion_tokens
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
    const stream = await this.client.chat.completions.create({
      model: this.model,
      messages: options.messages,
      temperature: options.temperature ?? null,
      max_tokens: options.maxTokens ?? null,
      stream: true
    });

    for await (const chunk of stream) {
      const content = chunk.choices[0]?.delta?.content;
      if (content) {
        yield content;
      }
    }
  }
}
