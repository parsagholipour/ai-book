import { GoogleGenAI } from "@google/genai";
import { readFile } from "node:fs/promises";
import { extname } from "node:path";
import { z } from "zod";
import { parseJsonObject, parseSchemaWithContext, throwWithProviderUsage } from "./json.js";
import type {
  ChatMessage,
  EmbeddingAdapter,
  GenerateJsonOptions,
  GenerateTextOptions,
  ImageAdapter,
  ImageRequest,
  ImageResult,
  JsonResult,
  ResearchAdapter,
  ResearchQuery,
  ResearchResult,
  TextModelAdapter,
  TextResult,
  Usage
} from "./types.js";
import { geminiImageReferenceLimit, isGeminiNativeImageModel, normalizeGeminiImageModel } from "./geminiModels.js";

export type GeminiAdapterOptions = {
  apiKey: string | undefined;
  textModel?: string | undefined;
  thinkingBudget?: number | undefined;
  imageModel?: string | undefined;
  embeddingModel?: string | undefined;
};

export class GeminiTextAdapter implements TextModelAdapter {
  private readonly ai: any;
  private readonly model: string;
  private readonly thinkingBudget: number | undefined;

  constructor(options: GeminiAdapterOptions) {
    if (!options.apiKey) {
      throw new Error("GEMINI_API_KEY is required for Gemini text generation.");
    }
    this.ai = new GoogleGenAI({ apiKey: options.apiKey });
    this.model = options.textModel ?? "gemini-2.5-flash";
    this.thinkingBudget = options.thinkingBudget;
  }

  async generateText(options: GenerateTextOptions): Promise<TextResult> {
    const prompt = geminiPromptFromMessages(options.messages);
    const response = await this.ai.models.generateContent({
      model: this.model,
      contents: prompt.contents,
      config: {
        ...prompt.config,
        ...geminiThinkingConfig(this.thinkingBudget),
        temperature: options.temperature,
        maxOutputTokens: options.maxTokens
      }
    });

    const usage = usageFromGeminiResponse(response);
    return {
      text: responseText(response),
      model: this.model,
      provider: "gemini",
      ...(usage ? { usage } : {})
    };
  }

  async generateJson<T>(options: GenerateJsonOptions<T>): Promise<JsonResult<T>> {
    const prompt = geminiPromptFromMessages(options.messages, [
      "Return only valid JSON. Do not wrap the JSON in Markdown. Do not include commentary outside the JSON object."
    ]);
    const response = await this.ai.models.generateContent({
      model: this.model,
      contents: prompt.contents,
      config: {
        ...prompt.config,
        ...geminiThinkingConfig(this.thinkingBudget),
        temperature: options.temperature,
        maxOutputTokens: options.maxTokens,
        responseMimeType: "application/json",
        responseJsonSchema: z.toJSONSchema(options.schema as never, { unrepresentable: "any" })
      }
    });

    const usage = usageFromGeminiResponse(response);
    const text = responseText(response) || "{}";
    let parsedObject: unknown;
    try {
      parsedObject = parseJsonObject(text, "Gemini");
    } catch (error) {
      throwWithProviderUsage(error, { provider: "gemini", model: this.model, usage });
    }
    if (options.purpose === "generate-chapter-brief") {
      return {
        data: parsedObject as T,
        text,
        model: this.model,
        provider: "gemini",
        ...(usage ? { usage } : {})
      };
    }
    try {
      return {
        data: parseSchemaWithContext("Gemini", options.schema, parsedObject, options.purpose, text),
        text,
        model: this.model,
        provider: "gemini",
        ...(usage ? { usage } : {})
      };
    } catch (error) {
      throwWithProviderUsage(error, { provider: "gemini", model: this.model, usage });
    }
  }

  async *streamText(options: GenerateTextOptions): AsyncGenerator<string> {
    const prompt = geminiPromptFromMessages(options.messages);
    const stream = await this.ai.models.generateContentStream({
      model: this.model,
      contents: prompt.contents,
      config: {
        ...prompt.config,
        ...geminiThinkingConfig(this.thinkingBudget),
        temperature: options.temperature,
        maxOutputTokens: options.maxTokens
      }
    });

    for await (const chunk of stream) {
      const text = responseText(chunk);
      if (text) {
        yield text;
      }
    }
  }
}

function geminiThinkingConfig(thinkingBudget: number | undefined) {
  return typeof thinkingBudget === "number" ? { thinkingConfig: { thinkingBudget } } : {};
}

function geminiPromptFromMessages(messages: ChatMessage[], extraSystemLines: string[] = []) {
  const systemInstruction = [
    ...extraSystemLines,
    ...messages.filter((message) => message.role === "system").map((message) => message.content)
  ]
    .filter(Boolean)
    .join("\n\n");
  const contents = messages
    .filter((message) => message.role !== "system")
    .map((message) => ({
      role: message.role === "assistant" ? "model" : "user",
      parts: [{ text: message.content }]
    }));

  return {
    contents: contents.length > 0 ? contents : [{ role: "user", parts: [{ text: "Generate the requested response." }] }],
    config: systemInstruction ? { systemInstruction } : {}
  };
}

function responseText(response: any): string {
  if (typeof response.text === "string") {
    return response.text;
  }
  const parts = response.candidates?.[0]?.content?.parts ?? response.parts ?? [];
  return parts
    .map((part: any) => part.text)
    .filter(Boolean)
    .join("\n")
    .trim();
}

function usageFromGeminiResponse(response: any): Usage | undefined {
  const usage = response.usageMetadata;
  if (!usage) {
    return undefined;
  }
  return {
    promptTokens: usage.promptTokenCount,
    outputTokens: usage.candidatesTokenCount,
    cacheHitTokens: usage.cachedContentTokenCount
  };
}

export class GeminiResearchAdapter implements ResearchAdapter {
  private readonly ai: any;
  private readonly model: string;

  constructor(options: GeminiAdapterOptions) {
    if (!options.apiKey) {
      throw new Error("GEMINI_API_KEY is required for Gemini research.");
    }
    this.ai = new GoogleGenAI({ apiKey: options.apiKey });
    this.model = options.textModel ?? "gemini-2.5-flash";
  }

  async search(query: ResearchQuery): Promise<ResearchResult> {
    const response = await this.ai.models.generateContent({
      model: this.model,
      contents: [
        "Find concise, source-backed factual background for the topic below.",
        "Cite useful external sources.",
        "Separate verified facts from claims that are contested or unsupported.",
        "Do not invent or launder made-up studies, journals, institutes, experts, statistics, citations, or numeric findings.",
        "Do not mention this request, prompts, outlines, or the production process; answer only with factual notes about the topic.",
        "",
        `Topic: ${query.query}`
      ].join("\n"),
      config: {
        tools: [{ googleSearch: {} }],
        temperature: 0.1
      }
    });

    const text = sanitizeResearchText(response.text ?? "");
    const chunks = response.candidates?.[0]?.groundingMetadata?.groundingChunks ?? [];
    const sources = chunks
      .map((chunk: any) => chunk.web)
      .filter(Boolean)
      .map((web: any) => ({
        title: String(web.title ?? "Source"),
        url: web.uri ? String(web.uri) : undefined,
        summary: text.slice(0, 600)
      }));

    return {
      query: query.query,
      summary: text,
      sources: sources.length > 0 ? sources : [{ title: "Gemini grounded summary", summary: text }]
    };
  }
}

function sanitizeResearchText(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) {
    return "";
  }
  const hadPromptEcho = RESEARCH_PROMPT_ECHO_PATTERNS.some((pattern) => pattern.test(trimmed));
  const clean = trimmed
    .split(/\r?\n/)
    .map(stripResearchPromptEcho)
    .filter(Boolean)
    .join("\n")
    .trim();
  return clean || (hadPromptEcho ? "Source-backed research notes were gathered for this topic." : trimmed);
}

function stripResearchPromptEcho(line: string): string {
  return line
    .replace(/^\s*Research this for an AI book outline\.?\s*/i, "")
    .replace(/^\s*For an AI book outline[^.:\n]*(?:[.:\n]\s*)?/i, "")
    .replace(/^\s*Query:\s*/i, "")
    .trim();
}

const RESEARCH_PROMPT_ECHO_PATTERNS = [
  /^\s*Research this for an AI book outline/i,
  /^\s*For an AI book outline/i,
  /^\s*Query:/i
];

export class GeminiImageAdapter implements ImageAdapter {
  private readonly ai: any;
  private readonly model: string;

  constructor(options: GeminiAdapterOptions) {
    if (!options.apiKey) {
      throw new Error("GEMINI_API_KEY is required for Gemini image generation.");
    }
    this.ai = new GoogleGenAI({ apiKey: options.apiKey });
    this.model = normalizeGeminiImageModel(options.imageModel);
  }

  async generateImage(request: ImageRequest): Promise<ImageResult> {
    if (isGeminiNativeImageModel(this.model)) {
      return this.generateNativeImage(request);
    }
    if (request.referenceImagePaths?.length) {
      throw new Error(
        `Character reference images require a native Gemini image model. Configured image model "${this.model}" cannot consume image references.`
      );
    }
    return this.generateImagenImage(request);
  }

  capabilities() {
    return {
      supportsReferenceImages: isGeminiNativeImageModel(this.model),
      maxReferenceImages: geminiImageReferenceLimit(this.model)
    };
  }

  private imageConfig(request: ImageRequest): Record<string, unknown> {
    const imageConfig: Record<string, unknown> = {
      aspectRatio: request.aspectRatio ?? "4:3"
    };
    if (request.lessCensored) {
      imageConfig.safetyFilterLevel = "BLOCK_ONLY_HIGH";
    }
    return imageConfig;
  }

  private async generateNativeImage(request: ImageRequest): Promise<ImageResult> {
    const contents = await this.nativeImageContents(request);
    const response = await this.ai.models.generateContent({
      model: this.model,
      contents,
      config: {
        responseModalities: ["TEXT", "IMAGE"],
        imageConfig: this.imageConfig(request)
      }
    });

    const parts = response.candidates?.[0]?.content?.parts ?? response.parts ?? [];
    const imagePart = parts.find((part: any) => part.inlineData?.data);
    const imageBytes = imagePart?.inlineData?.data;
    if (!imageBytes) {
      throw new Error(`Gemini image model ${this.model} did not return image bytes.`);
    }

    const text = parts
      .map((part: any) => part.text)
      .filter(Boolean)
      .join("\n")
      .trim();
    const result = {
      provider: "gemini",
      model: this.model,
      mimeType: imagePart.inlineData.mimeType ?? "image/png",
      data: Buffer.from(imageBytes, "base64")
    };
    return text ? { ...result, revisedPrompt: text } : result;
  }

  private async generateImagenImage(request: ImageRequest): Promise<ImageResult> {
    const config: Record<string, unknown> = {
      numberOfImages: 1,
      aspectRatio: request.aspectRatio ?? "4:3"
    };
    if (request.lessCensored) {
      config.safetyFilterLevel = "BLOCK_ONLY_HIGH";
    }
    const response = await this.ai.models.generateImages({
      model: this.model,
      prompt: request.prompt,
      config
    });

    const image = response.generatedImages?.[0]?.image;
    const imageBytes = image?.imageBytes;
    if (!imageBytes) {
      throw new Error("Gemini did not return image bytes.");
    }

    return {
      provider: "gemini",
      model: this.model,
      mimeType: image.mimeType ?? "image/png",
      data: Buffer.from(imageBytes, "base64"),
      revisedPrompt: response.generatedImages?.[0]?.enhancedPrompt
    };
  }

  private async nativeImageContents(request: ImageRequest): Promise<unknown> {
    const referenceImagePaths = request.referenceImagePaths?.slice(0, geminiImageReferenceLimit(this.model)) ?? [];
    if (referenceImagePaths.length === 0) {
      return request.prompt;
    }

    const referenceParts = await Promise.all(
      referenceImagePaths.map(async (path) => ({
        inlineData: {
          data: (await readFile(path)).toString("base64"),
          mimeType: mimeTypeForImagePath(path)
        }
      }))
    );

    return [
      {
        role: "user",
        parts: [{ text: request.prompt }, ...referenceParts]
      }
    ];
  }
}

function mimeTypeForImagePath(path: string): string {
  const fromExt: Record<string, string> = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".webp": "image/webp",
    ".gif": "image/gif",
    ".svg": "image/svg+xml"
  };
  return fromExt[extname(path).toLowerCase()] ?? "image/png";
}

export class GeminiEmbeddingAdapter implements EmbeddingAdapter {
  private readonly ai: any;
  private readonly model: string;

  constructor(options: GeminiAdapterOptions) {
    if (!options.apiKey) {
      throw new Error("GEMINI_API_KEY is required for Gemini embeddings.");
    }
    this.ai = new GoogleGenAI({ apiKey: options.apiKey });
    this.model = options.embeddingModel ?? "gemini-embedding-001";
  }

  async embed(text: string): Promise<number[]> {
    const response = await this.ai.models.embedContent({
      model: this.model,
      contents: text,
      config: {
        outputDimensionality: 768
      }
    });
    const values = response.embeddings?.[0]?.values;
    if (!values) {
      throw new Error("Gemini did not return an embedding.");
    }
    return values;
  }
}
