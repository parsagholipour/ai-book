import { serializeFallbackError } from "./imageFallback.js";
import type { TextModelSelection } from "../schemas/book.js";
import type { GenerateJsonOptions, GenerateTextOptions, JsonResult, TextModelAdapter, TextResult } from "./types.js";

export type TextFallbackProvider = {
  provider: string;
  model: string;
};

export type TextFallbackEvent = {
  event: "fallback.start";
  operation: "generateText" | "generateJson" | "streamText";
  purpose?: string | undefined;
  primary: TextFallbackProvider & { error: Record<string, unknown> };
  fallback: TextFallbackProvider;
};

export type FallbackTextModelAdapterOptions = {
  primary: { selection: TextModelSelection; adapter: TextModelAdapter };
  fallback: { selection: TextModelSelection; adapter: TextModelAdapter | (() => TextModelAdapter) };
  onEvent?: (event: TextFallbackEvent) => void | Promise<void>;
  shouldFallback?: (error: unknown) => boolean;
};

/**
 * Falls back to a secondary text model when the primary fails persistently
 * (after the caller's own retry policy is exhausted). Mirrors
 * FallbackImageAdapter; if the fallback also fails, the fallback error is
 * thrown. Results report the fallback's own provider/model, so cost
 * accounting stays accurate.
 */
export class FallbackTextModelAdapter implements TextModelAdapter {
  private fallbackAdapter: TextModelAdapter | undefined;

  constructor(private readonly options: FallbackTextModelAdapterOptions) {}

  async generateText(options: GenerateTextOptions): Promise<TextResult> {
    try {
      return await this.options.primary.adapter.generateText(options);
    } catch (error) {
      const fallback = await this.beginFallback("generateText", options.purpose, error);
      return fallback.generateText(options);
    }
  }

  async generateJson<T>(options: GenerateJsonOptions<T>): Promise<JsonResult<T>> {
    try {
      return await this.options.primary.adapter.generateJson(options);
    } catch (error) {
      const fallback = await this.beginFallback("generateJson", options.purpose, error);
      return fallback.generateJson(options);
    }
  }

  async *streamText(options: GenerateTextOptions): AsyncGenerator<string> {
    let yieldedChunks = false;
    try {
      for await (const chunk of this.options.primary.adapter.streamText(options)) {
        yieldedChunks = true;
        yield chunk;
      }
      return;
    } catch (error) {
      // Falling back mid-stream would duplicate already-yielded output.
      if (yieldedChunks) {
        throw error;
      }
      const fallback = await this.beginFallback("streamText", options.purpose, error);
      yield* fallback.streamText(options);
    }
  }

  private async beginFallback(
    operation: TextFallbackEvent["operation"],
    purpose: string | undefined,
    error: unknown
  ): Promise<TextModelAdapter> {
    if (this.options.shouldFallback && !this.options.shouldFallback(error)) {
      throw error;
    }
    await this.options.onEvent?.({
      event: "fallback.start",
      operation,
      purpose,
      primary: {
        provider: this.options.primary.selection.provider,
        model: this.options.primary.selection.model,
        error: serializeFallbackError(error)
      },
      fallback: {
        provider: this.options.fallback.selection.provider,
        model: this.options.fallback.selection.model
      }
    });
    return this.resolveFallbackAdapter();
  }

  private resolveFallbackAdapter(): TextModelAdapter {
    if (this.fallbackAdapter) {
      return this.fallbackAdapter;
    }
    const adapter =
      typeof this.options.fallback.adapter === "function" ? this.options.fallback.adapter() : this.options.fallback.adapter;
    this.fallbackAdapter = adapter;
    return adapter;
  }
}
