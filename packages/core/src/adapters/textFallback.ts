import { serializeFallbackError } from "./imageFallback.js";
import type { TextModelSelection } from "../schemas/book.js";
import type { GenerateJsonOptions, GenerateTextOptions, JsonResult, TextModelAdapter, TextResult } from "./types.js";

export type TextFallbackProvider = {
  provider: string;
  model: string;
};

export type TextFallbackOperation = "generateText" | "generateJson" | "streamText";

type TextFallbackEventBase = {
  operation: TextFallbackOperation;
  purpose?: string | undefined;
  primary: TextFallbackProvider & { error: Record<string, unknown> };
  fallback: TextFallbackProvider;
};

export type TextFallbackEvent =
  | (TextFallbackEventBase & { event: "fallback.start"; attempt: 1; maxAttempts: 1 })
  | (TextFallbackEventBase & { event: "fallback.success"; attempt: 1; maxAttempts: 1; result: TextFallbackProvider })
  | (TextFallbackEventBase & {
      event: "fallback.error";
      attempt: 1;
      maxAttempts: 1;
      fallback: TextFallbackProvider & { error: Record<string, unknown> };
    });

export type FallbackTextModelAdapterOptions = {
  primary: { selection: TextModelSelection; adapter: TextModelAdapter };
  fallback: { selection: TextModelSelection; adapter: TextModelAdapter | (() => TextModelAdapter) };
  onEvent?: (event: TextFallbackEvent) => void | Promise<void>;
  shouldFallback?: (error: unknown) => boolean;
};

export class TextGenerationFallbackError extends Error {
  readonly operation: TextFallbackOperation;
  readonly primary: TextFallbackProvider & { error: Record<string, unknown> };
  readonly fallback: TextFallbackProvider & { error: Record<string, unknown> };

  constructor(options: {
    operation: TextFallbackOperation;
    primary: TextFallbackProvider & { error: Record<string, unknown> };
    fallback: TextFallbackProvider & { error: Record<string, unknown> };
  }) {
    super(
      `Text ${options.operation} failed for primary ${options.primary.provider}/${options.primary.model} and fallback ${options.fallback.provider}/${options.fallback.model}.`
    );
    this.name = "TextGenerationFallbackError";
    this.operation = options.operation;
    this.primary = options.primary;
    this.fallback = options.fallback;
  }
}

/** One bounded fallback attempt after the caller/provider retry policy is exhausted. */
export class FallbackTextModelAdapter implements TextModelAdapter {
  private fallbackAdapter: TextModelAdapter | undefined;

  constructor(private readonly options: FallbackTextModelAdapterOptions) {}

  async generateText(options: GenerateTextOptions): Promise<TextResult> {
    try {
      return await this.options.primary.adapter.generateText(options);
    } catch (error) {
      return this.runFallback("generateText", options.purpose, error, (adapter) => adapter.generateText(options));
    }
  }

  async generateJson<T>(options: GenerateJsonOptions<T>): Promise<JsonResult<T>> {
    try {
      return await this.options.primary.adapter.generateJson(options);
    } catch (error) {
      return this.runFallback("generateJson", options.purpose, error, (adapter) => adapter.generateJson(options));
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
      if (yieldedChunks) {
        throw error;
      }
      const context = await this.beginFallback("streamText", options.purpose, error);
      try {
        yield* context.adapter.streamText(options);
        await this.emitSuccess(context, "streamText", options.purpose);
      } catch (fallbackError) {
        await this.failFallback(context, "streamText", options.purpose, fallbackError);
      }
    }
  }

  private async runFallback<T>(
    operation: TextFallbackOperation,
    purpose: string | undefined,
    error: unknown,
    run: (adapter: TextModelAdapter) => Promise<T>
  ): Promise<T> {
    const context = await this.beginFallback(operation, purpose, error);
    try {
      const result = await run(context.adapter);
      await this.emitSuccess(context, operation, purpose, providerFromResult(result) ?? context.fallback);
      return result;
    } catch (fallbackError) {
      return this.failFallback(context, operation, purpose, fallbackError);
    }
  }

  private async beginFallback(operation: TextFallbackOperation, purpose: string | undefined, error: unknown) {
    if (this.options.shouldFallback && !this.options.shouldFallback(error)) {
      throw error;
    }
    const primary = {
      provider: this.options.primary.selection.provider,
      model: this.options.primary.selection.model,
      error: serializeFallbackError(error)
    };
    const fallback = {
      provider: this.options.fallback.selection.provider,
      model: this.options.fallback.selection.model
    };
    await this.options.onEvent?.({
      event: "fallback.start",
      operation,
      purpose,
      primary,
      fallback,
      attempt: 1,
      maxAttempts: 1
    });
    try {
      return { primary, fallback, adapter: this.resolveFallbackAdapter() };
    } catch (fallbackError) {
      return this.failFallback({ primary, fallback }, operation, purpose, fallbackError);
    }
  }

  private async emitSuccess(
    context: { primary: TextFallbackProvider & { error: Record<string, unknown> }; fallback: TextFallbackProvider },
    operation: TextFallbackOperation,
    purpose: string | undefined,
    result: TextFallbackProvider = context.fallback
  ) {
    await this.options.onEvent?.({
      event: "fallback.success",
      operation,
      purpose,
      primary: context.primary,
      fallback: context.fallback,
      result,
      attempt: 1,
      maxAttempts: 1
    });
  }

  private async failFallback(
    context: { primary: TextFallbackProvider & { error: Record<string, unknown> }; fallback: TextFallbackProvider },
    operation: TextFallbackOperation,
    purpose: string | undefined,
    error: unknown
  ): Promise<never> {
    const fallback = { ...context.fallback, error: serializeFallbackError(error) };
    await this.options.onEvent?.({
      event: "fallback.error",
      operation,
      purpose,
      primary: context.primary,
      fallback,
      attempt: 1,
      maxAttempts: 1
    });
    throw new TextGenerationFallbackError({ operation, primary: context.primary, fallback });
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

function providerFromResult(value: unknown): TextFallbackProvider | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const result = value as { provider?: unknown; model?: unknown };
  return typeof result.provider === "string" && typeof result.model === "string"
    ? { provider: result.provider, model: result.model }
    : undefined;
}
