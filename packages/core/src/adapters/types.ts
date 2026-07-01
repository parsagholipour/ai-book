import type { ZodType } from "zod";

export type ChatMessage = {
  role: "system" | "user" | "assistant";
  content: string;
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

export interface TextModelAdapter {
  generateText(options: GenerateTextOptions): Promise<TextResult>;
  generateJson<T>(options: GenerateJsonOptions<T>): Promise<JsonResult<T>>;
  streamText(options: GenerateTextOptions): AsyncGenerator<string>;
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
