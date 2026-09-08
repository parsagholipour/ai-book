import type { AppConfig } from "../config.js";
import { GeminiEmbeddingAdapter } from "../adapters/gemini.js";
import type { EmbeddingAdapter } from "../adapters/types.js";

export function createSourceEmbedding(config: AppConfig): EmbeddingAdapter | undefined {
  if (config.MOCK_AI || !config.GEMINI_API_KEY) return undefined;
  return new GeminiEmbeddingAdapter({ apiKey: config.GEMINI_API_KEY, embeddingModel: config.GEMINI_EMBEDDING_MODEL });
}
