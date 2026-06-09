import { readFile } from "node:fs/promises";
import { extname } from "node:path";
import OpenAI from "openai";
import type {
  GenerateJsonOptions,
  GenerateTextOptions,
  ImageAdapter,
  ImageRequest,
  ImageResult,
  JsonResult,
  TextModelAdapter,
  TextResult
} from "./types.js";
import {
  AdapterJsonParseError as AlibabaJsonParseError,
  AdapterJsonValidationError as AlibabaJsonValidationError,
  parseJsonObject as parseAdapterJsonObject,
  parseSchemaWithContext as parseAdapterSchemaWithContext,
  throwWithProviderUsage
} from "./json.js";
import {
  DEFAULT_ALIBABA_API_HOST,
  DEFAULT_ALIBABA_IMAGE_MODEL,
  DEFAULT_ALIBABA_TEXT_MODEL,
  normalizeAlibabaModel,
  qwenImageReferenceLimit,
  supportsQwenImageReferenceImages
} from "./alibabaModels.js";

export { AlibabaJsonParseError, AlibabaJsonValidationError };

export type AlibabaAdapterOptions = {
  apiKey: string | undefined;
  apiHost?: string | undefined;
  textModel?: string | undefined;
  imageModel?: string | undefined;
};

type QwenImageContentPart = { image: string } | { text: string };

export class AlibabaTextAdapter implements TextModelAdapter {
  private readonly client: OpenAI;
  private readonly model: string;

  constructor(options: AlibabaAdapterOptions) {
    if (!options.apiKey) {
      throw new Error("ALIBABA_API_KEY is required for Qwen text generation.");
    }

    this.model = normalizeAlibabaModel(options.textModel, DEFAULT_ALIBABA_TEXT_MODEL);
    this.client = new OpenAI({
      apiKey: options.apiKey,
      baseURL: alibabaCompatibleBaseURL(options.apiHost)
    });
  }

  async generateText(options: GenerateTextOptions): Promise<TextResult> {
    const response = await this.client.chat.completions.create({
      model: this.model,
      messages: options.messages,
      temperature: options.temperature,
      max_tokens: options.maxTokens
    } as never);

    return {
      text: response.choices[0]?.message?.content ?? "",
      model: this.model,
      provider: "alibaba",
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
      temperature: options.temperature,
      max_tokens: options.maxTokens,
      response_format: { type: "json_object" }
    } as never);

    const text = response.choices[0]?.message?.content ?? "{}";
    const usage = {
      promptTokens: response.usage?.prompt_tokens,
      outputTokens: response.usage?.completion_tokens
    };
    let parsedObject: unknown;
    try {
      parsedObject = parseJsonObject(text);
    } catch (error) {
      throwWithProviderUsage(error, { provider: "alibaba", model: this.model, usage });
    }
    if (options.purpose === "generate-chapter-brief") {
      return {
        data: parsedObject as T,
        text,
        model: this.model,
        provider: "alibaba",
        usage
      };
    }
    try {
      return {
        data: parseSchemaWithContext(options.schema, parsedObject, options.purpose, text),
        text,
        model: this.model,
        provider: "alibaba",
        usage
      };
    } catch (error) {
      throwWithProviderUsage(error, { provider: "alibaba", model: this.model, usage });
    }
  }

  async *streamText(options: GenerateTextOptions): AsyncGenerator<string> {
    const stream: any = await this.client.chat.completions.create({
      model: this.model,
      messages: options.messages,
      temperature: options.temperature,
      max_tokens: options.maxTokens,
      stream: true,
      stream_options: { include_usage: true }
    } as never);

    for await (const chunk of stream) {
      const content = chunk.choices[0]?.delta?.content;
      if (content) {
        yield content;
      }
    }
  }
}

export class AlibabaImageAdapter implements ImageAdapter {
  private readonly apiKey: string;
  private readonly apiBaseURL: string;
  private readonly model: string;

  constructor(options: AlibabaAdapterOptions) {
    if (!options.apiKey) {
      throw new Error("ALIBABA_API_KEY is required for Qwen image generation.");
    }
    this.apiKey = options.apiKey;
    this.apiBaseURL = alibabaApiBaseURL(options.apiHost);
    this.model = normalizeAlibabaModel(options.imageModel, DEFAULT_ALIBABA_IMAGE_MODEL);
  }

  capabilities() {
    const maxReferenceImages = qwenImageReferenceLimit(this.model);
    return {
      supportsReferenceImages: maxReferenceImages > 0,
      maxReferenceImages
    };
  }

  async generateImage(request: ImageRequest): Promise<ImageResult> {
    if (request.referenceImagePaths?.length && !supportsQwenImageReferenceImages(this.model)) {
      throw new Error(`Qwen image model ${this.model} cannot consume character reference images.`);
    }

    try {
      return await this.generateSynchronousImage(request);
    } catch (error) {
      if (!supportsAsyncQwenImage(this.model)) {
        throw error;
      }
      return this.generateAsyncImage(request);
    }
  }

  private async generateSynchronousImage(request: ImageRequest): Promise<ImageResult> {
    const content = await this.qwenMultimodalContent(request);
    const response = await this.postJson(`${this.apiBaseURL}/services/aigc/multimodal-generation/generation`, {
      model: this.model,
      input: {
        messages: [
          {
            role: "user",
            content
          }
        ]
      },
      parameters: {
        negative_prompt: qwenNegativePrompt(),
        prompt_extend: true,
        watermark: false,
        size: qwenImageSize(this.model, request.aspectRatio)
      }
    });

    return this.imageResultFromResponse(response);
  }

  private async qwenMultimodalContent(request: ImageRequest): Promise<QwenImageContentPart[]> {
    const referenceImagePaths = request.referenceImagePaths?.slice(0, qwenImageReferenceLimit(this.model)) ?? [];
    if (referenceImagePaths.length === 0) {
      return [{ text: request.prompt }];
    }

    const referenceParts = await Promise.all(
      referenceImagePaths.map(async (path) => ({
        image: await imageDataUrl(path)
      }))
    );
    return [...referenceParts, { text: request.prompt }];
  }

  private async generateAsyncImage(request: ImageRequest): Promise<ImageResult> {
    const createResponse = await this.postJson(
      `${this.apiBaseURL}/services/aigc/text2image/image-synthesis`,
      {
        model: this.model,
        input: {
          prompt: request.prompt
        },
        parameters: {
          negative_prompt: qwenNegativePrompt(),
          prompt_extend: true,
          watermark: false,
          n: 1,
          size: qwenImageSize(this.model, request.aspectRatio)
        }
      },
      { "X-DashScope-Async": "enable" }
    );
    const taskId = outputString(createResponse, "task_id");
    if (!taskId) {
      throw new Error("Qwen image generation did not return a task ID.");
    }

    const deadline = Date.now() + 120_000;
    while (Date.now() < deadline) {
      await sleep(5000);
      const taskResponse = await this.getJson(`${this.apiBaseURL}/tasks/${encodeURIComponent(taskId)}`);
      const status = outputString(taskResponse, "task_status");
      if (status === "SUCCEEDED") {
        return this.imageResultFromResponse(taskResponse);
      }
      if (status === "FAILED") {
        throw new Error(`Qwen image generation failed for task ${taskId}.`);
      }
    }

    throw new Error(`Timed out waiting for Qwen image generation task ${taskId}.`);
  }

  private imageResultFromResponse(response: unknown): ImageResult {
    const imageUrl = firstString(
      responseAt(response, ["output", "choices", 0, "message", "content", 0, "image"]),
      responseAt(response, ["output", "choices", 0, "message", "content", 0, "url"]),
      responseAt(response, ["output", "results", 0, "url"]),
      responseAt(response, ["output", "results", 0, "image"]),
      responseAt(response, ["data", 0, "url"])
    );
    const base64Image = firstString(
      responseAt(response, ["output", "choices", 0, "message", "content", 0, "image_base64"]),
      responseAt(response, ["output", "choices", 0, "message", "content", 0, "b64_json"]),
      responseAt(response, ["data", 0, "b64_json"])
    );
    const revisedPrompt = firstString(
      responseAt(response, ["output", "results", 0, "actual_prompt"]),
      responseAt(response, ["output", "choices", 0, "message", "content", 0, "actual_prompt"])
    );

    const result = {
      provider: "alibaba",
      model: this.model,
      mimeType: "image/png"
    };
    if (base64Image) {
      const output = { ...result, data: Buffer.from(base64Image, "base64") };
      return revisedPrompt ? { ...output, revisedPrompt } : output;
    }
    if (imageUrl) {
      const output = { ...result, url: imageUrl };
      return revisedPrompt ? { ...output, revisedPrompt } : output;
    }

    throw new Error(`Qwen image model ${this.model} did not return an image URL or bytes.`);
  }

  private async postJson(url: string, body: unknown, extraHeaders: Record<string, string> = {}): Promise<unknown> {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
        ...extraHeaders
      },
      body: JSON.stringify(body)
    });
    return parseAlibabaHttpResponse(response);
  }

  private async getJson(url: string): Promise<unknown> {
    const response = await fetch(url, {
      headers: {
        Authorization: `Bearer ${this.apiKey}`
      }
    });
    return parseAlibabaHttpResponse(response);
  }
}

function parseJsonObject(text: string): unknown {
  return parseAdapterJsonObject(text, "Alibaba Qwen");
}

function parseSchemaWithContext<T>(
  schema: GenerateJsonOptions<T>["schema"],
  value: unknown,
  purpose: string | undefined,
  rawText: string
): T {
  return parseAdapterSchemaWithContext("Alibaba Qwen", schema, value, purpose, rawText);
}

function alibabaCompatibleBaseURL(apiHost: string | undefined): string {
  return normalizeAlibabaURL(apiHost, "compatible-mode/v1");
}

function alibabaApiBaseURL(apiHost: string | undefined): string {
  return normalizeAlibabaURL(apiHost, "api/v1");
}

function normalizeAlibabaURL(apiHost: string | undefined, targetPath: "compatible-mode/v1" | "api/v1"): string {
  const trimmed = (apiHost ?? DEFAULT_ALIBABA_API_HOST).trim().replace(/\/+$/, "");
  const currentPath = targetPath === "compatible-mode/v1" ? "api/v1" : "compatible-mode/v1";
  if (trimmed.endsWith(`/${targetPath}`)) {
    return trimmed;
  }
  if (trimmed.includes(`/${currentPath}`)) {
    return trimmed.replace(new RegExp(`/${escapeRegex(currentPath)}(?:/.*)?$`), `/${targetPath}`);
  }
  if (trimmed.includes(`/${targetPath}/`)) {
    return trimmed.replace(new RegExp(`/${escapeRegex(targetPath)}/.*$`), `/${targetPath}`);
  }
  return `${trimmed}/${targetPath}`;
}

function qwenImageSize(model: string, aspectRatio: string | undefined): string {
  const ratio = aspectRatio ?? "4:3";
  if (model.startsWith("qwen-image-2.0")) {
    return (
      {
        "16:9": "2688*1536",
        "9:16": "1536*2688",
        "1:1": "2048*2048",
        "4:3": "2368*1728",
        "3:4": "1728*2368"
      }[ratio] ?? "2368*1728"
    );
  }

  return (
    {
      "16:9": "1664*928",
      "9:16": "928*1664",
      "1:1": "1328*1328",
      "4:3": "1472*1104",
      "3:4": "1104*1472"
    }[ratio] ?? "1472*1104"
  );
}

function qwenNegativePrompt(): string {
  return [
    "Low resolution",
    "low quality",
    "distorted anatomy",
    "malformed hands",
    "blurry text",
    "warped text",
    "watermark",
    "signature",
    "logo",
    "chaotic composition"
  ].join(", ");
}

async function imageDataUrl(path: string): Promise<string> {
  const mimeType = mimeTypeForImagePath(path);
  return `data:${mimeType};base64,${(await readFile(path)).toString("base64")}`;
}

function mimeTypeForImagePath(path: string): string {
  const fromExt: Record<string, string> = {
    ".bmp": "image/bmp",
    ".gif": "image/gif",
    ".jpeg": "image/jpeg",
    ".jpg": "image/jpeg",
    ".png": "image/png",
    ".tif": "image/tiff",
    ".tiff": "image/tiff",
    ".webp": "image/webp"
  };
  return fromExt[extname(path).toLowerCase()] ?? "image/png";
}

function supportsAsyncQwenImage(model: string): boolean {
  return model === "qwen-image" || model === "qwen-image-plus";
}

async function parseAlibabaHttpResponse(response: Response): Promise<unknown> {
  const text = await response.text();
  const data = text ? safeJsonParse(text) : {};
  if (!response.ok) {
    const message =
      firstString(responseAt(data, ["message"]), responseAt(data, ["error", "message"]), responseAt(data, ["output", "message"])) ??
      text.slice(0, 500) ??
      response.statusText;
    throw new Error(`Alibaba Qwen API request failed (${response.status}): ${message}`);
  }
  return data;
}

function safeJsonParse(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return {};
  }
}

function outputString(value: unknown, key: string): string | undefined {
  return firstString(responseAt(value, ["output", key]));
}

function responseAt(value: unknown, path: Array<string | number>): unknown {
  let current = value;
  for (const segment of path) {
    if (typeof segment === "number") {
      if (!Array.isArray(current)) {
        return undefined;
      }
      current = current[segment];
      continue;
    }
    if (!current || typeof current !== "object" || Array.isArray(current)) {
      return undefined;
    }
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return undefined;
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
