import { GoogleGenAI, ThinkingLevel } from "@google/genai";
import { readFile } from "node:fs/promises";
import { extname } from "node:path";
import { z } from "zod";
import { parseJsonObject, parseSchemaWithContext, throwWithProviderUsage } from "./json.js";
import type {
  ChatMessage,
  EmbeddingAdapter,
  GenerateJsonOptions,
  GenerateTextOptions,
  GenerateWithToolsOptions,
  ImageAdapter,
  ImageRequest,
  ImageResult,
  JsonResult,
  ResearchAdapter,
  ResearchQuery,
  ResearchResult,
  TextModelAdapter,
  TextResult,
  ToolCall,
  ToolCallsResult,
  ToolDefinition,
  Usage
} from "./types.js";
import { geminiImageReferenceLimit, isGeminiNativeImageModel, normalizeGeminiImageModel } from "./geminiModels.js";
import { missingImagenImageError } from "./geminiImagenRefusal.js";
import { missingNativeImageError } from "./geminiNativeImageRefusal.js";
import { resolveGroundingRedirects } from "./groundingRedirect.js";
import type { TextModelThinkingEffort } from "../schemas/book.js";

export type GeminiAdapterOptions = {
  apiKey: string | undefined;
  textModel?: string | undefined;
  thinkingBudget?: number | undefined;
  thinkingEnabled?: boolean | undefined;
  thinkingEffort?: TextModelThinkingEffort | undefined;
  imageModel?: string | undefined;
  embeddingModel?: string | undefined;
};

export class GeminiTextAdapter implements TextModelAdapter {
  private readonly ai: any;
  private readonly model: string;
  private readonly thinkingBudget: number | undefined;
  private readonly thinkingEnabled: boolean | undefined;
  private readonly thinkingEffort: TextModelThinkingEffort | undefined;

  constructor(options: GeminiAdapterOptions) {
    if (!options.apiKey) {
      throw new Error("GEMINI_API_KEY is required for Gemini text generation.");
    }
    this.ai = new GoogleGenAI({ apiKey: options.apiKey });
    this.model = options.textModel ?? "gemini-2.5-flash";
    this.thinkingBudget = options.thinkingBudget;
    this.thinkingEnabled = options.thinkingEnabled;
    this.thinkingEffort = options.thinkingEffort;
  }

  async generateText(options: GenerateTextOptions): Promise<TextResult> {
    if (options.onOutputTextChunk) {
      return this.generateTextStreaming(options);
    }

    const prompt = geminiPromptFromMessages(options.messages);
    const response = await this.ai.models.generateContent({
      model: this.model,
      contents: prompt.contents,
      config: {
        ...prompt.config,
        ...geminiThinkingConfig(this.model, this.thinkingBudget, this.thinkingEnabled, this.thinkingEffort),
        ...(options.signal ? { abortSignal: options.signal } : {}),
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

  async generateWithTools(options: GenerateWithToolsOptions): Promise<ToolCallsResult> {
    const prompt = geminiPromptFromMessages(options.messages);
    const response = await this.ai.models.generateContent({
      model: this.model,
      contents: prompt.contents,
      config: {
        ...prompt.config,
        ...geminiThinkingConfig(this.model, this.thinkingBudget, this.thinkingEnabled, this.thinkingEffort),
        ...(options.signal ? { abortSignal: options.signal } : {}),
        temperature: options.temperature,
        maxOutputTokens: options.maxTokens,
        tools: [{ functionDeclarations: options.tools.map(geminiFunctionDeclaration) }],
        ...(options.toolChoice === "required"
          ? { toolConfig: { functionCallingConfig: { mode: "ANY" } } }
          : {})
      }
    });

    const usage = usageFromGeminiResponse(response);
    return {
      text: responseText(response),
      model: this.model,
      provider: "gemini",
      toolCalls: toolCallsFromGeminiResponse(response),
      ...(usage ? { usage } : {})
    };
  }

  async generateJson<T>(options: GenerateJsonOptions<T>): Promise<JsonResult<T>> {
    if (options.onOutputTextChunk) {
      return this.generateJsonStreaming(options);
    }

    const prompt = geminiPromptFromMessages(options.messages, [
      "Return only valid JSON. Do not wrap the JSON in Markdown. Do not include commentary outside the JSON object."
    ]);
    const response = await this.ai.models.generateContent({
      model: this.model,
      contents: prompt.contents,
      config: {
        ...prompt.config,
        ...geminiThinkingConfig(this.model, this.thinkingBudget, this.thinkingEnabled, this.thinkingEffort),
        ...(options.signal ? { abortSignal: options.signal } : {}),
        temperature: options.temperature,
        maxOutputTokens: options.maxTokens,
        responseMimeType: "application/json",
        responseJsonSchema: z.toJSONSchema(options.schema as never, { unrepresentable: "any" })
      }
    });

    const usage = usageFromGeminiResponse(response);
    const text = responseText(response) || "{}";
    return this.parseJsonResult(options, text, usage);
  }

  private async generateTextStreaming(options: GenerateTextOptions): Promise<TextResult> {
    const prompt = geminiPromptFromMessages(options.messages);
    const stream = await this.ai.models.generateContentStream({
      model: this.model,
      contents: prompt.contents,
      config: {
        ...prompt.config,
        ...geminiThinkingConfig(this.model, this.thinkingBudget, this.thinkingEnabled, this.thinkingEffort),
        ...(options.signal ? { abortSignal: options.signal } : {}),
        temperature: options.temperature,
        maxOutputTokens: options.maxTokens
      }
    });

    let text = "";
    let usage: Usage | undefined;
    for await (const chunk of stream) {
      const chunkText = responseText(chunk);
      if (chunkText) {
        text += chunkText;
        await options.onOutputTextChunk?.(chunkText);
      }
      usage = usageFromGeminiResponse(chunk) ?? usage;
    }

    return {
      text,
      model: this.model,
      provider: "gemini",
      ...(usage ? { usage } : {})
    };
  }

  private async generateJsonStreaming<T>(options: GenerateJsonOptions<T>): Promise<JsonResult<T>> {
    const prompt = geminiPromptFromMessages(options.messages, [
      "Return only valid JSON. Do not wrap the JSON in Markdown. Do not include commentary outside the JSON object."
    ]);
    const stream = await this.ai.models.generateContentStream({
      model: this.model,
      contents: prompt.contents,
      config: {
        ...prompt.config,
        ...geminiThinkingConfig(this.model, this.thinkingBudget, this.thinkingEnabled, this.thinkingEffort),
        ...(options.signal ? { abortSignal: options.signal } : {}),
        temperature: options.temperature,
        maxOutputTokens: options.maxTokens,
        responseMimeType: "application/json",
        responseJsonSchema: z.toJSONSchema(options.schema as never, { unrepresentable: "any" })
      }
    });

    let text = "";
    let usage: Usage | undefined;
    for await (const chunk of stream) {
      const chunkText = responseText(chunk);
      if (chunkText) {
        text += chunkText;
        await options.onOutputTextChunk?.(chunkText);
      }
      usage = usageFromGeminiResponse(chunk) ?? usage;
    }

    return this.parseJsonResult(options, text || "{}", usage);
  }

  private parseJsonResult<T>(options: GenerateJsonOptions<T>, text: string, usage: Usage | undefined): JsonResult<T> {
    let parsedObject: unknown;
    try {
      parsedObject = parseJsonObject(text, "Gemini");
    } catch (error) {
      throwWithProviderUsage(error, { provider: "gemini", model: this.model, usage });
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
        ...geminiThinkingConfig(this.model, this.thinkingBudget, this.thinkingEnabled, this.thinkingEffort),
        ...(options.signal ? { abortSignal: options.signal } : {}),
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

function geminiThinkingConfig(
  model: string,
  thinkingBudget: number | undefined,
  thinkingEnabled: boolean | undefined,
  thinkingEffort: TextModelThinkingEffort | undefined
) {
  if (typeof thinkingBudget === "number") {
    return { thinkingConfig: { thinkingBudget } };
  }
  const thinkingLevel = geminiThinkingLevel(model, thinkingEnabled, thinkingEffort);
  return thinkingLevel ? { thinkingConfig: { thinkingLevel } } : {};
}

function geminiThinkingLevel(
  model: string,
  thinkingEnabled: boolean | undefined,
  thinkingEffort: TextModelThinkingEffort | undefined
): ThinkingLevel | undefined {
  if (!usesGeminiThinkingLevel(model)) {
    return undefined;
  }
  if (thinkingEffort === "minimal" || thinkingEffort === "none") {
    return supportsGeminiMinimalThinkingLevel(model) ? ThinkingLevel.MINIMAL : ThinkingLevel.LOW;
  }
  if (thinkingEffort === "low") {
    return ThinkingLevel.LOW;
  }
  if (thinkingEffort === "medium") {
    return ThinkingLevel.MEDIUM;
  }
  if (thinkingEffort === "high" || thinkingEffort === "xhigh" || thinkingEffort === "max") {
    return ThinkingLevel.HIGH;
  }
  if (thinkingEnabled === false) {
    return supportsGeminiMinimalThinkingLevel(model) ? ThinkingLevel.MINIMAL : ThinkingLevel.LOW;
  }
  if (thinkingEnabled === true) {
    return ThinkingLevel.MEDIUM;
  }
  return undefined;
}

function usesGeminiThinkingLevel(model: string): boolean {
  const normalized = model.trim().replace(/^models\//, "").toLowerCase();
  return normalized.startsWith("gemini-3.5-flash") || normalized.startsWith("gemini-3.7-flash");
}

function supportsGeminiMinimalThinkingLevel(model: string): boolean {
  const normalized = model.trim().replace(/^models\//, "").toLowerCase();
  return normalized.startsWith("gemini-3.5-flash");
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
    .map((message) => geminiContentFromMessage(message));

  return {
    contents: contents.length > 0 ? contents : [{ role: "user", parts: [{ text: "Generate the requested response." }] }],
    config: systemInstruction ? { systemInstruction } : {}
  };
}

function geminiContentFromMessage(message: ChatMessage): { role: "user" | "model"; parts: unknown[] } {
  if (message.role === "tool") {
    return {
      role: "user",
      parts: [
        {
          functionResponse: {
            name: message.toolName ?? "tool",
            response: { result: message.content }
          }
        }
      ]
    };
  }
  if (message.role === "assistant" && message.toolCalls?.length) {
    return {
      role: "model",
      parts: [
        ...(message.content ? [{ text: message.content }] : []),
        ...message.toolCalls.map((call) => ({
          functionCall: { name: call.name, args: geminiFunctionCallArgs(call.arguments) }
        }))
      ]
    };
  }
  return {
    role: message.role === "assistant" ? "model" : "user",
    parts: [{ text: message.content }]
  };
}

function geminiFunctionCallArgs(args: unknown): Record<string, unknown> {
  return args && typeof args === "object" && !Array.isArray(args) ? (args as Record<string, unknown>) : {};
}

function geminiFunctionDeclaration(tool: ToolDefinition) {
  return {
    name: tool.name,
    description: tool.description,
    parametersJsonSchema: z.toJSONSchema(tool.parameters as never, { unrepresentable: "any" })
  };
}

function toolCallsFromGeminiResponse(response: any): ToolCall[] {
  const parts = response.candidates?.[0]?.content?.parts ?? response.parts ?? [];
  return parts
    .filter((part: any) => part?.functionCall?.name)
    .map((part: any, index: number) => ({
      id: typeof part.functionCall.id === "string" && part.functionCall.id ? part.functionCall.id : `call_${index}`,
      name: String(part.functionCall.name),
      arguments: part.functionCall.args ?? {}
    }));
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

/**
 * **Google bills thinking tokens as output, so they are counted as output here.**
 * `usageMetadata` reports `thoughtsTokenCount` *beside* `candidatesTokenCount`
 * rather than inside it, and premium/ultra prose runs with a 2048-token
 * thinking budget (ULTRA plan calls at 8192) — so reading only the candidates
 * count under-reported every reasoning call by up to ~$0.02. That number does
 * not surface as a missing token anywhere: `costHint` is what the admin
 * Operations and Costs tabs sum for the *actual* side of every margin
 * (`../costs.ts`), so a dropped thought silently flatters the margin on exactly
 * the tiers that cost the most to run. Page 1's best-of drafting
 * (`../generation/bestOf.ts`) tripled how many of those calls a premium book
 * makes, which is what made the gap worth closing.
 *
 * Absent on non-thinking models and on responses from before the field existed;
 * a response carrying neither count still reports `undefined` rather than 0,
 * because "not told" and "no tokens" price differently downstream.
 */
function usageFromGeminiResponse(response: any): Usage | undefined {
  const usage = response.usageMetadata;
  if (!usage) {
    return undefined;
  }
  return {
    promptTokens: usage.promptTokenCount,
    outputTokens: sumTokenCounts(usage.candidatesTokenCount, usage.thoughtsTokenCount),
    cacheHitTokens: usage.cachedContentTokenCount
  };
}

/**
 * Adds the token counts that arrived and stays `undefined` when none did. A
 * call truncated while still thinking reports thoughts with no candidates, so
 * no count may assume another one is there.
 */
function sumTokenCounts(...counts: unknown[]): number | undefined {
  const reported = counts.filter((count): count is number => typeof count === "number" && Number.isFinite(count));
  return reported.length === 0 ? undefined : reported.reduce((total, count) => total + count, 0);
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

    const rawText = response.text ?? "";
    const text = sanitizeResearchText(rawText);
    const grounding = response.candidates?.[0]?.groundingMetadata;
    const chunks = grounding?.groundingChunks ?? [];
    const excerptsByChunk = collectGroundingExcerpts(grounding?.groundingSupports ?? [], rawText);
    const grounded: ResearchResult["sources"] = chunks
      .map((chunk: any, index: number) => ({ web: chunk.web, index }))
      .filter((entry: { web: unknown; index: number }) => Boolean(entry.web))
      .map(({ web, index }: { web: any; index: number }) => {
        const excerpts = excerptsByChunk.get(index);
        const summary =
          excerpts && excerpts.length > 0 ? sanitizeResearchText(excerpts.join(" ")).slice(0, 600) : text.slice(0, 600);
        return {
          title: String(web.title ?? "Source"),
          url: web.uri ? String(web.uri) : undefined,
          summary: summary || text.slice(0, 600)
        };
      });
    // Grounding cites every page through an expiring Google redirect. Unwrap it
    // here, while it still resolves, so nothing downstream stores or shows one.
    const sources = await resolveGroundingRedirects(grounded);

    return {
      query: query.query,
      summary: text,
      sources: sources.length > 0 ? sources : [{ title: "Gemini grounded summary", summary: text }]
    };
  }
}

function collectGroundingExcerpts(supports: any[], rawText: string): Map<number, string[]> {
  const excerptsByChunk = new Map<number, string[]>();
  for (const support of supports) {
    const segmentText = groundingSegmentText(support, rawText);
    if (!segmentText) {
      continue;
    }
    for (const chunkIndex of support?.groundingChunkIndices ?? []) {
      if (typeof chunkIndex !== "number") {
        continue;
      }
      const excerpts = excerptsByChunk.get(chunkIndex) ?? [];
      if (excerpts.length < 4 && !excerpts.includes(segmentText)) {
        excerpts.push(segmentText);
      }
      excerptsByChunk.set(chunkIndex, excerpts);
    }
  }
  return excerptsByChunk;
}

function groundingSegmentText(support: any, rawText: string): string {
  const segment = support?.segment;
  if (!segment) {
    return "";
  }
  if (typeof segment.text === "string" && segment.text.trim()) {
    return segment.text.trim();
  }
  const start = typeof segment.startIndex === "number" ? segment.startIndex : 0;
  const end = typeof segment.endIndex === "number" ? segment.endIndex : 0;
  if (end > start && end <= rawText.length) {
    return rawText.slice(start, end).trim();
  }
  return "";
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
    return {
      aspectRatio: request.aspectRatio ?? "4:3"
    };
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

    const candidate = response.candidates?.[0];
    const parts = candidate?.content?.parts ?? response.parts ?? [];
    const imagePart = parts.find((part: any) => part.inlineData?.data);
    const imageBytes = imagePart?.inlineData?.data;
    if (!imageBytes) {
      throw missingNativeImageError(this.model, response, candidate, parts);
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
      aspectRatio: request.aspectRatio ?? "4:3",
      // Why a picture was filtered is opt-in on this endpoint. The SDK
      // documents `includeRaiReason` as "whether to include the Responsible AI
      // filter reason if the image is filtered out of the response", and
      // without it a filtered request answers with an ordinary 200, an empty
      // picture and nothing else — silence indistinguishable from a render
      // that fell over. Asking for the reason is what lets
      // `missingImagenImageError` tell a refusal from a blip at all, so it is
      // not optional for us. The Gemini API takes it: the SDK's mldev
      // converter passes it through, where the parameters that endpoint really
      // refuses (`seed`, `negativePrompt`, `enhancePrompt`, …) throw instead.
      includeRaiReason: true,
      // What the classifier *scored* is a second opt-in, and it is not a second
      // reason. `includeSafetyAttributes` makes the endpoint report the RAI
      // categories with the reading it gave each one, for the picture and for
      // the prompt — a standing table returned for a drawn picture as readily
      // as for a filtered one, naming `Porn` and "Violence" on every answer
      // whether or not anything tripped. The same converter passes it through
      // beside `includeRaiReason`. It is worth asking for: it is the only
      // machine vocabulary this endpoint has, and a run log is where anyone
      // would go to see what the filter was looking at. It is not worth
      // believing — folding it into the refusal's `reason` vetoed every Imagen
      // copyright block, at every threshold — so `geminiImagenRefusal.ts`
      // records the table as `diagnostics` and lets only a category the RAI
      // sentence itself names reach `reason`.
      //
      // **This flag is also the only thing that can arm the SDK's one
      // discard, and what keeps that harmless is a property of the endpoint
      // rather than of the SDK.** `models.generateImages` (1.52.0) walks the
      // predictions and, for any entry whose `safetyAttributes.contentType` is
      // `"Positive Prompt"`, lifts the attributes to top-level
      // `positivePromptSafetyAttributes` and **drops the entry** — its
      // `raiFilteredReason` with it. Nothing recovers that: the SDK rebuilds
      // its answer as `generatedImages` / `positivePromptSafetyAttributes` /
      // `sdkHttpResponse`, `SafetyAttributes` maps only `categories`, `scores`
      // and `contentType`, and `sdkHttpResponse` carries headers with no body.
      // A reason riding a stamped entry would therefore leave `generatedImages`
      // empty, `missingImagenImageError` with nothing that names a filter, and
      // every Imagen block back to the retryable `Error` this whole path
      // replaced. It cannot ride one: Imagen returns the prompt's attributes as
      // their *own* prediction, and "if an output image is filtered its safety
      // attributes aren't returned" — so the entry carrying the reason carries
      // no `safetyAttributes`, has no `contentType` to be stamped with, and is
      // never a candidate for the discard. That is a two-sided fact and both
      // sides are pinned through the real client in
      // `geminiImagenRefusal.test.ts`, because only a test that drives the SDK
      // sees an SDK bump move the line.
      includeSafetyAttributes: true
    };
    const response = await this.ai.models.generateImages({
      model: this.model,
      prompt: request.prompt,
      config
    });

    const image = response.generatedImages?.[0]?.image;
    const imageBytes = image?.imageBytes;
    if (!imageBytes) {
      throw missingImagenImageError(this.model, response);
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
