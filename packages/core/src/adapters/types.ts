import type { ZodType } from "zod";

/** A tool invocation requested by the model during a generateWithTools call. */
export type ToolCall = {
  /** Provider-assigned id linking the call to its tool-result message. */
  id: string;
  name: string;
  /** Parsed JSON arguments. Handlers validate these against their schema. */
  arguments: unknown;
};

export type ChatMessage = {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  /** Set on assistant messages that requested tool calls. */
  toolCalls?: ToolCall[] | undefined;
  /** Set on tool messages; links the result to the originating call. */
  toolCallId?: string | undefined;
  /** Set on tool messages; some providers (Gemini) address results by name. */
  toolName?: string | undefined;
};

export type GenerateTextOptions = {
  messages: ChatMessage[];
  temperature?: number;
  maxTokens?: number;
  purpose?: string;
  projectId?: string;
  onOutputTextChunk?: (chunk: string) => void | Promise<void>;
};

export type GenerateJsonOptions<T> = GenerateTextOptions & {
  schema: ZodType<T>;
};

/** Schema of a tool exposed to the model; adapters convert it to JSON Schema. */
export type ToolDefinition<TArgs = unknown> = {
  name: string;
  description: string;
  parameters: ZodType<TArgs>;
};

export type ToolChoice = "auto" | "required";

export type GenerateWithToolsOptions = GenerateTextOptions & {
  tools: ToolDefinition[];
  /** "required" forces a tool call when the provider supports it; defaults to "auto". */
  toolChoice?: ToolChoice | undefined;
};

export type Usage = {
  promptTokens?: number | undefined;
  outputTokens?: number | undefined;
  cacheHitTokens?: number | undefined;
};

export type TextResult = {
  text: string;
  model: string;
  provider: string;
  usage?: Usage;
};

export type JsonResult<T> = TextResult & {
  data: T;
};

/**
 * One assistant turn from a tools-enabled call: the model either requested
 * tool calls (toolCalls non-empty, text usually empty) or answered with text.
 */
export type ToolCallsResult = TextResult & {
  toolCalls: ToolCall[];
};

export interface TextModelAdapter {
  generateText(options: GenerateTextOptions): Promise<TextResult>;
  generateJson<T>(options: GenerateJsonOptions<T>): Promise<JsonResult<T>>;
  streamText(options: GenerateTextOptions): AsyncGenerator<string>;
  generateWithTools(options: GenerateWithToolsOptions): Promise<ToolCallsResult>;
}

export type ResearchQuery = {
  query: string;
  projectId?: string | undefined;
  purpose?: string | undefined;
};

export type ResearchResult = {
  query: string;
  summary: string;
  sources: Array<{
    title: string;
    url?: string | undefined;
    summary: string;
    publishedAt?: string | undefined;
  }>;
};

export interface ResearchAdapter {
  search(query: ResearchQuery): Promise<ResearchResult>;
}

export type ImageRequest = {
  prompt: string;
  projectId?: string | undefined;
  pageId?: string | undefined;
  referenceImagePaths?: string[] | undefined;
  aspectRatio?: string | undefined;
};

export type ImageResult = {
  provider: string;
  model: string;
  mimeType: string;
  data?: Buffer | undefined;
  url?: string | undefined;
  revisedPrompt?: string | undefined;
  fallback?: ImageFallbackMetadata | undefined;
};

export type ImageFallbackAttempt = {
  provider: string;
  model: string;
  error?: Record<string, unknown> | undefined;
};

export type ImageFallbackMetadata = {
  used: true;
  primary: ImageFallbackAttempt & { error: Record<string, unknown> };
  fallback: ImageFallbackAttempt;
};

export type ImageAdapterCapabilities = {
  supportsReferenceImages: boolean;
  maxReferenceImages: number;
};

export interface ImageAdapter {
  capabilities?(): ImageAdapterCapabilities;
  generateImage(request: ImageRequest): Promise<ImageResult>;
}

export interface EmbeddingAdapter {
  embed(text: string): Promise<number[]>;
}

export type SpeechRequest = {
  text: string;
  voice: string;
  /** Human-readable language name, used as pronunciation guidance. */
  language?: string | undefined;
  /** Performance direction — how to read, never what to read. */
  stylePrompt?: string | undefined;
  projectId?: string | undefined;
};

export type SpeechResult = {
  provider: string;
  model: string;
  /** Raw PCM16 with its format, so consecutive results can be joined exactly. */
  pcm: Buffer;
  sampleRate: number;
  channels: number;
  durationMs: number;
};

export interface SpeechAdapter {
  synthesize(request: SpeechRequest): Promise<SpeechResult>;
}
