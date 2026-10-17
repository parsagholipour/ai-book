import { serializeFallbackError } from "./imageFallback.js";
import { isCancellationError, isTextPrimaryRetryError } from "./retry.js";
import { ProviderStallDeadlineError, type TextStallReading } from "./textStallDeadline.js";
import {
  assertTextAttemptAvailable,
  TextAttemptBudgetExhaustedError,
  type TextAttemptBudget
} from "./textAttemptBudget.js";
import { estimateTokensByScript, type ScriptTokenWeights } from "../textTokens.js";
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
  | (TextFallbackEventBase & {
      /** The primary failed in transport and gets one fresh request; `fallback` is where it would have gone. */
      event: "fallback.primary_retry";
      attempt: 1;
      maxAttempts: 1;
      /** The pause before the fresh request. */
      delayMs: number;
      /** The failure's name, with its code or status: `ProviderStreamInterruptedError(PROVIDER_STREAM_INTERRUPTED)`. */
      errorClass: string;
      /**
       * Output the failed request had produced, which the fresh one starts over
       * from: the provider's own count when the error carried one, else
       * estimated from the streamed text, else `null` (nothing was observable).
       */
      partialOutputTokens: number | null;
      partialOutputEstimated: boolean;
    })
  | (TextFallbackEventBase & {
      /**
       * The primary's request was ended by its stall deadline
       * (`ProviderStallDeadlineError`, `textStallDeadline.ts`); `stall` is what
       * the stream looked like then. The next event says what followed: a fresh
       * request (`fallback.primary_retry`) or the hop (`fallback.start`).
       */
      event: "stall_deadline";
      attempt: 1;
      maxAttempts: 1;
      stall: TextStallReading;
    })
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
  /**
   * Which primary failures earn one fresh primary request before the hop.
   * Defaults to {@link isTextPrimaryRetryError}; `false` hops at once.
   */
  retryPrimary?: ((error: unknown) => boolean) | false;
  /** The pause before that request; 1–3 s of jitter unless a test says otherwise. */
  primaryRetryDelayMs?: () => number;
};

/**
 * The logical calls that have spent their same-model retry, by attempt budget —
 * see `FallbackTextModelAdapter.retryPrimaryAfter`. Module-wide because the
 * routing layer caches one adapter per route and a budget may cross routes.
 */
const PRIMARY_RETRY_SPENT = new WeakSet<TextAttemptBudget>();
const PRIMARY_RETRY_MIN_DELAY_MS = 1_000;
const PRIMARY_RETRY_JITTER_MS = 2_000;
/** The worker's cost-estimate weights (`usageAccounting.ts`). Diagnostics only; nothing prices this. */
const PARTIAL_OUTPUT_TOKEN_WEIGHTS = { latinCharsPerToken: 4, denseCharsPerToken: 1 } satisfies ScriptTokenWeights;

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

/**
 * A transport failure gets one fresh request on the primary, then one bounded
 * fallback attempt; callers may apply their retry policy around the pair.
 */
export class FallbackTextModelAdapter implements TextModelAdapter {
  private fallbackAdapter: TextModelAdapter | undefined;

  constructor(private readonly options: FallbackTextModelAdapterOptions) {}

  async generateText(options: GenerateTextOptions): Promise<TextResult> {
    try {
      return await this.runPrimary("generateText", options, (attempt) =>
        this.options.primary.adapter.generateText(attempt)
      );
    } catch (error) {
      return this.runFallback("generateText", options, error, (adapter) => adapter.generateText(options));
    }
  }

  async generateJson<T>(options: GenerateJsonOptions<T>): Promise<JsonResult<T>> {
    try {
      return await this.runPrimary("generateJson", options, (attempt) =>
        this.options.primary.adapter.generateJson(attempt)
      );
    } catch (error) {
      return this.runFallback("generateJson", options, error, (adapter) => adapter.generateJson(options));
    }
  }

  async generateWithTools(options: GenerateWithToolsOptions): Promise<ToolCallsResult> {
    try {
      return await this.runPrimary("generateWithTools", options, (attempt) =>
        this.options.primary.adapter.generateWithTools(attempt)
      );
    } catch (error) {
      return this.runFallback("generateWithTools", options, error, (adapter) =>
        adapter.generateWithTools(options)
      );
    }
  }

  async *streamText(options: GenerateTextOptions): AsyncGenerator<string> {
    let yieldedChunks = false;
    let attempt = meterPrimaryAttempt(options);
    let mayRetryPrimary = true;
    for (;;) {
      try {
        for await (const chunk of this.options.primary.adapter.streamText(attempt.options)) {
          yieldedChunks = true;
          yield chunk;
        }
        return;
      } catch (error) {
        await this.noteStall("streamText", options, error);
        // The caller already holds the chunks, so neither a fresh request nor
        // another provider can take over without repeating them.
        if (yieldedChunks) {
          throw error;
        }
        if (mayRetryPrimary && (await this.retryPrimaryAfter("streamText", options, error, attempt.streamed()))) {
          mayRetryPrimary = false;
          attempt = { options: retryOptionsAfter(options, error), streamed: () => undefined };
          continue;
        }
        const context = await this.beginFallback("streamText", options, error);
        try {
          yield* context.adapter.streamText(options);
          await this.emitSuccess(context, "streamText", options);
        } catch (fallbackError) {
          await this.failFallback(context, "streamText", options, fallbackError);
        }
        return;
      }
    }
  }

  /**
   * The primary's turn: one request, and for a transport failure one more.
   *
   * The retry is taken here rather than by the retry loop around this adapter.
   * The worker does wrap the pair in `withRecoverableNetworkRetry`
   * (`LoggingTextModelAdapter.runFallbackCall`, three passes under the
   * attempt budget), but that loop retries the *pair*: it only ever sees an
   * error after the hop has happened, so it cannot keep a call on its model.
   * Withholding the hop on the promise of a loop above would strand every
   * caller that has none — `streamText`, the API's chat and assists. This is
   * the one layer that sees a hop about to happen, and the one-per-call claim
   * in {@link retryPrimaryAfter} is what keeps the loop above from
   * multiplying it.
   */
  private async runPrimary<TOptions extends GenerateTextOptions, TResult>(
    operation: TextFallbackOperation,
    options: TOptions,
    call: (options: TOptions) => Promise<TResult>
  ): Promise<TResult> {
    const first = meterPrimaryAttempt(options);
    let retry = options;
    try {
      return await call(first.options);
    } catch (error) {
      await this.noteStall(operation, options, error);
      if (!(await this.retryPrimaryAfter(operation, options, error, first.streamed()))) {
        throw error;
      }
      retry = retryOptionsAfter(options, error);
    }
    try {
      return await call(retry);
    } catch (error) {
      await this.noteStall(operation, options, error);
      throw error;
    }
  }

  /**
   * A primary request its stall deadline ended is written down before whatever
   * follows it. The deadline's 504 is an ordinary transport failure to every
   * decision here — {@link retryPrimaryAfter} gives it the one fresh request,
   * then the hop — so this only says why that request ended.
   */
  private async noteStall(operation: TextFallbackOperation, options: GenerateTextOptions, error: unknown): Promise<void> {
    if (!(error instanceof ProviderStallDeadlineError)) return;
    await this.emit(options, {
      event: "stall_deadline",
      operation,
      purpose: options.purpose,
      primary: {
        provider: this.options.primary.selection.provider,
        model: this.options.primary.selection.model,
        error: serializeFallbackError(error)
      },
      fallback: {
        provider: this.options.fallback.selection.provider,
        model: this.options.fallback.selection.model
      },
      attempt: 1,
      maxAttempts: 1,
      // A copy: the same object also rides `primary.error`, and a run-log
      // serializer that marks repeated references would write it once.
      stall: structuredClone(error.stall)
    });
  }

  /**
   * Whether a failed primary request gets one fresh one, after its pause.
   *
   * Only where the call would otherwise hop: a failure `shouldFallback` keeps
   * on the primary already belongs to the caller's own retry policy (a
   * waitable 429's cooldown), and a stop is never retried.
   *
   * Once per logical call, not once per entry. The worker's loop re-enters
   * this adapter for one call, and a retry per entry would make every pass
   * primary, primary, fallback. The attempt budget (`withTextAttemptBudget`)
   * is the one object every layer of a logical call shares — network retries,
   * fallback, output widening, JSON repair — so the claim is kept against it,
   * and the next pass finds it spent and hops at once. A call with no budget
   * gets one per invocation.
   */
  private async retryPrimaryAfter(
    operation: TextFallbackOperation,
    options: GenerateTextOptions,
    error: unknown,
    streamed: string | undefined
  ): Promise<boolean> {
    const retryable = this.options.retryPrimary === false
      ? undefined
      : (this.options.retryPrimary ?? isTextPrimaryRetryError);
    if (!retryable || isCancellationError(error) || options.signal?.aborted) {
      return false;
    }
    if (this.options.shouldFallback && !this.options.shouldFallback(error)) {
      return false;
    }
    if (!retryable(error)) {
      return false;
    }
    const budget = options.textAttemptBudget;
    if (budget) {
      if (budget.used >= budget.limit || PRIMARY_RETRY_SPENT.has(budget)) {
        return false;
      }
      PRIMARY_RETRY_SPENT.add(budget);
    }
    const delayMs = Math.max(0, this.options.primaryRetryDelayMs?.() ?? primaryRetryJitterMs());
    await this.emit(options, {
      event: "fallback.primary_retry",
      operation,
      purpose: options.purpose,
      primary: {
        provider: this.options.primary.selection.provider,
        model: this.options.primary.selection.model,
        error: serializeFallbackError(error)
      },
      fallback: {
        provider: this.options.fallback.selection.provider,
        model: this.options.fallback.selection.model
      },
      attempt: 1,
      maxAttempts: 1,
      delayMs,
      errorClass: errorClassOf(error),
      ...partialOutputOf(error, streamed)
    });
    await pauseBeforePrimaryRetry(delayMs, options.signal);
    return true;
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
    // A stop is never a reason to hop, whatever `shouldFallback` was handed —
    // including one raised by the pause before a primary retry.
    if (isCancellationError(error)) {
      throw error;
    }
    if (this.options.shouldFallback && !this.options.shouldFallback(error)) {
      throw error;
    }
    assertTextAttemptAvailable(options);
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
    if (isCancellationError(error) || error instanceof TextAttemptBudgetExhaustedError) throw error;
    throw new TextGenerationFallbackError({ operation, primary: context.primary, fallback });
  }

  /**
   * Every event is a run-log line or a cost-ledger write about the call, so
   * none may decide it (see "A diagnostic write may not decide the render it
   * describes" in `adapters/CLAUDE.md`): a failed write is dropped, each
   * observer on its own, and only a cancellation travels. Unguarded, a throw
   * from `fallback.success` — emitted inside the try around the fallback —
   * discarded an answer the fallback had already given and reported both
   * providers failed.
   */
  private async emit(options: GenerateTextOptions, event: TextFallbackEvent): Promise<void> {
    const observers = [this.options.onEvent, (options as TextFallbackObservedOptions)[TEXT_FALLBACK_EVENT_OBSERVER]];
    for (const observer of observers) {
      try {
        await observer?.(event);
      } catch (error) {
        if (isCancellationError(error)) throw error;
      }
    }
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

/**
 * Keeps what the primary streams, so a retry can say what it threw away. Only
 * where the caller already observes the stream: adding an observer where there
 * was none could change how an adapter makes its request.
 */
/**
 * The fresh primary request after a stall goes out marked `afterStall`, so the
 * adapter spares it the pace rule and routes it to another machine. A slow
 * retry then finishes in the tier's own writer instead of hopping: on
 * 2026-10-17 a compose cut at 10 tokens a second was retried on the same
 * cache key, trickled at the same pace, was cut again, and DeepSeek wrote
 * that chapter of a novel. Any other failure retries exactly as it did.
 */
function retryOptionsAfter<T extends GenerateTextOptions>(options: T, error: unknown): T {
  return error instanceof ProviderStallDeadlineError ? { ...options, afterStall: true } : options;
}

function meterPrimaryAttempt<T extends GenerateTextOptions>(options: T): { options: T; streamed: () => string | undefined } {
  if (!options.onOutputTextChunk) {
    return { options, streamed: () => undefined };
  }
  const chunks: string[] = [];
  return {
    options: {
      ...options,
      onOutputTextChunk: (chunk: string) => {
        chunks.push(chunk);
        return options.onOutputTextChunk?.(chunk);
      }
    },
    streamed: () => chunks.join("")
  };
}

function partialOutputOf(
  error: unknown,
  streamed: string | undefined
): { partialOutputTokens: number | null; partialOutputEstimated: boolean } {
  const usage = isRecord(error) && isRecord(error.usage) ? error.usage : undefined;
  if (typeof usage?.outputTokens === "number" && Number.isFinite(usage.outputTokens)) {
    return { partialOutputTokens: usage.outputTokens, partialOutputEstimated: false };
  }
  if (streamed === undefined) {
    return { partialOutputTokens: null, partialOutputEstimated: false };
  }
  return { partialOutputTokens: estimateTokensByScript(streamed, PARTIAL_OUTPUT_TOKEN_WEIGHTS), partialOutputEstimated: true };
}

/** `name(code)` or `name(status)`, the first code or status down the `cause` chain. */
function errorClassOf(error: unknown): string {
  const name = error instanceof Error ? error.name : typeof error;
  let layer: unknown = error;
  for (let depth = 0; depth < 4 && isRecord(layer); depth += 1) {
    if (typeof layer.code === "string" && layer.code) return `${name}(${layer.code})`;
    if (typeof layer.status === "number") return `${name}(${layer.status})`;
    layer = layer.cause;
  }
  return name;
}

function primaryRetryJitterMs(): number {
  // Jitter, because one gateway event cuts many calls at once (two of the three
  // on 2026-10-15 fell within a second) and they should not all return together.
  return PRIMARY_RETRY_MIN_DELAY_MS + Math.round(Math.random() * PRIMARY_RETRY_JITTER_MS);
}

/** A stop during the pause ends it with the stop, so nothing after it runs. */
function pauseBeforePrimaryRetry(delayMs: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve, reject) => {
    const stop = () => {
      clearTimeout(timer);
      reject(signal?.reason ?? new DOMException("This operation was aborted", "AbortError"));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", stop);
      resolve();
    }, delayMs);
    if (signal?.aborted) {
      stop();
    } else {
      signal?.addEventListener("abort", stop, { once: true });
    }
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object";
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
