import { serializeFallbackError } from "./imageFallback.js";
import type { TextModelSelection } from "../schemas/book.js";
import type {
  GenerateJsonOptions,
  GenerateTextOptions,
  GenerateWithToolsOptions,
  JsonResult,
  TextModelAdapter,
  TextResult,
  ToolCallsResult
} from "./types.js";

export type TextFallbackProvider = {
  provider: string;
  model: string;
};

export type TextFallbackOperation = "generateText" | "generateJson" | "streamText" | "generateWithTools";

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

export type TextFallbackEventObserver = (event: TextFallbackEvent) => void | Promise<void>;

const TEXT_FALLBACK_EVENT_OBSERVER = Symbol("textFallbackEventObserver");

type TextFallbackObservedOptions = GenerateTextOptions & {
  [TEXT_FALLBACK_EVENT_OBSERVER]?: TextFallbackEventObserver | undefined;
};

/** Adds call-scoped fallback telemetry without mutating a cached adapter. */
export function withTextFallbackEventObserver<T extends GenerateTextOptions>(
  options: T,
  observer: TextFallbackEventObserver
): T {
  return Object.assign({}, options, { [TEXT_FALLBACK_EVENT_OBSERVER]: observer });
}

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

/** One bounded fallback attempt; callers may apply their retry policy around the primary/fallback pair. */
export class FallbackTextModelAdapter implements TextModelAdapter {
  private fallbackAdapter: TextModelAdapter | undefined;

  constructor(private readonly options: FallbackTextModelAdapterOptions) {}

  async generateText(options: GenerateTextOptions): Promise<TextResult> {
    try {
      return await this.options.primary.adapter.generateText(options);
    } catch (error) {
      return this.runFallback("generateText", options, error, (adapter) => adapter.generateText(options));
    }
  }

  async generateJson<T>(options: GenerateJsonOptions<T>): Promise<JsonResult<T>> {
    try {
      return await this.options.primary.adapter.generateJson(options);
    } catch (error) {
      return this.runFallback("generateJson", options, error, (adapter) => adapter.generateJson(options));
    }
  }

  async generateWithTools(options: GenerateWithToolsOptions): Promise<ToolCallsResult> {
    try {
      return await this.options.primary.adapter.generateWithTools(options);
    } catch (error) {
      return this.runFallback("generateWithTools", options, error, (adapter) =>
        adapter.generateWithTools(options)
      );
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
      const context = await this.beginFallback("streamText", options, error);
      try {
        yield* context.adapter.streamText(options);
        await this.emitSuccess(context, "streamText", options);
      } catch (fallbackError) {
        await this.failFallback(context, "streamText", options, fallbackError);
      }
    }
  }

  private async runFallback<T>(
    operation: TextFallbackOperation,
    options: GenerateTextOptions,
    error: unknown,
    run: (adapter: TextModelAdapter) => Promise<T>
  ): Promise<T> {
    const context = await this.beginFallback(operation, options, error);
    try {
      const result = await run(context.adapter);
      await this.emitSuccess(context, operation, options, providerFromResult(result) ?? context.fallback);
      return result;
    } catch (fallbackError) {
      return this.failFallback(context, operation, options, fallbackError);
    }
  }

  private async beginFallback(operation: TextFallbackOperation, options: GenerateTextOptions, error: unknown) {
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
    await this.emit(options, {
      event: "fallback.start",
      operation,
      purpose: options.purpose,
      primary,
      fallback,
      attempt: 1,
      maxAttempts: 1
    });
    try {
      return { primary, fallback, adapter: this.resolveFallbackAdapter() };
    } catch (fallbackError) {
      return this.failFallback({ primary, fallback }, operation, options, fallbackError);
    }
  }

  private async emitSuccess(
    context: { primary: TextFallbackProvider & { error: Record<string, unknown> }; fallback: TextFallbackProvider },
    operation: TextFallbackOperation,
    options: GenerateTextOptions,
    result: TextFallbackProvider = context.fallback
  ) {
    await this.emit(options, {
      event: "fallback.success",
      operation,
      purpose: options.purpose,
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
    options: GenerateTextOptions,
    error: unknown
  ): Promise<never> {
    const fallback = { ...context.fallback, error: serializeFallbackError(error) };
    await this.emit(options, {
      event: "fallback.error",
      operation,
      purpose: options.purpose,
      primary: context.primary,
      fallback,
      attempt: 1,
      maxAttempts: 1
    });
    throw new TextGenerationFallbackError({ operation, primary: context.primary, fallback });
  }

  private async emit(options: GenerateTextOptions, event: TextFallbackEvent): Promise<void> {
    await this.options.onEvent?.(event);
    await (options as TextFallbackObservedOptions)[TEXT_FALLBACK_EVENT_OBSERVER]?.(event);
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
