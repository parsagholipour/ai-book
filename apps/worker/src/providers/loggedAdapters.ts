import { withProjectSources } from "./sourceContext.js";
import { createLoggedDecisions } from "./loggedDecisions.js";
import { randomUUID } from "node:crypto";
import {
  AlibabaImageAdapter,
  calculateImageGenerationCost,
  estimateSpeechCostUsd,
  FallbackImageAdapter,
  imageAdapterCapabilities,
  GeminiImageAdapter,
  isPremiumProject,
  modelTierForInput,
  premiumCoverImageSelection,
  resolveImageFallbackSelection,
  RoutingTextModelAdapter,
  bindTextModelCall,
  createLiveGenerationTextModel,
  resolveImageModelSelection,
  resolveTextModelSelection,
  withRecoverableNetworkRetry,
  withTextAttemptBudget,
  isRecoverableNetworkError,
  type CreateProjectInput,
  type GenerateJsonOptions,
  type GenerateTextOptions,
  type GenerateWithToolsOptions,
  type ImageAdapter,
  type ImageAdapterCapabilities,
  type ImageModelSelection,
  type ImageRequest,
  type ProviderSet,
  type ResearchAdapter,
  type ResearchQuery,
  type SpeechAdapter,
  type SpeechRequest,
  type TextFallbackEvent,
  type TextModelAdapter
} from "@book-maker/core";
import { config } from "../runtime/config.js";
import { isStopRequestedError } from "../runtime/jobTypes.js";
import { assertJobNotStopped, hasStoppedGenerationJob } from "../runtime/jobLifecycle.js";
import { serializeError } from "../runtime/serialization.js";
import {
  attachProviderLogContext,
  createRunLogger,
  logImageResult,
  logTextRequest,
  providerRetryOptions,
  type LoggedImageAttempt,
  type RunLogger
} from "./runLogging.js";
import {
  beginLiveTextUsage,
  boundedProviderCallMetadata,
  durationBetweenTimestamps,
  estimateTokenCountFromText,
  estimateTokenCountFromTextLength,
  maybeUpdateLiveTextOutput,
  optionalProviderCallMetadata,
  recordProviderAudioCost,
  recordProviderImageCost,
  recordProviderQuotaRefusal,
  recordProviderUsage,
  withLiveOutputTracking
} from "./usageAccounting.js";
import type { WorkerRuntimeJob } from "../runtime/jobPayloads.js";
import { CopyrightSafeRetryImageAdapter } from "./copyrightSafeImageRetry.js";
import { loadLiveGenerationTextRouting } from "./generationTextRouting.js";
import { TextFallbackCallAccounting } from "./textFallbackAccounting.js";
import { LoggingEmbeddingAdapter } from "./loggedEmbeddingAdapter.js";
import { withContentSafetyRule } from "./contentSafetyRule.js";

/**
 * Logging decorators around the provider adapters from `@book-maker/core`.
 *
 * `createLoggedProviders` is the single entry point: it wraps a job's provider
 * set so every call is written to the run log, costed, and checked for a user
 * stop request; every text call carries the operator's content rule
 * (`contentSafetyRule.ts`). Image calls additionally get a cross-provider fallback.
 */

type LoggedTextModel = {
  provider: string;
  model: string;
};

export function createLoggedProviders(
  job: WorkerRuntimeJob,
  providers: ProviderSet,
  input?: CreateProjectInput | undefined,
  options?: { imageSelection?: ImageModelSelection | undefined }
): ProviderSet {
  const logger = createRunLogger(job);
  const { generationJobId, projectId } = job.data;
  const textModel = loggedTextModel(input);
  const liveTextModel = liveGenerationTextModel(providers.text, input, logger);
  const embedding = new LoggingEmbeddingAdapter(providers.embedding, logger, generationJobId, projectId);
  const text = withProjectSources(new LoggingTextModelAdapter(liveTextModel, logger, generationJobId, projectId, textModel), input, projectId, embedding);
  return {
    text,
    decisions: createLoggedDecisions(job, input, embedding),
    research: new LoggingResearchAdapter(providers.research, logger, generationJobId, projectId),
    // Outside the provider fallback, so only a request both providers refused
    // reaches the rewrite.
    image: new CopyrightSafeRetryImageAdapter({
      image: createLoggedImageAdapter(providers.image, logger, generationJobId, input, options?.imageSelection),
      text,
      logger
    }),
    embedding,
    speech: new LoggingSpeechAdapter(providers.speech, logger, generationJobId, projectId)
  };
}

export function createLoggedSpeechAdapter(job: WorkerRuntimeJob, speech: SpeechAdapter): SpeechAdapter {
  const logger = createRunLogger(job);
  return new LoggingSpeechAdapter(
    speech,
    logger,
    job.data.generationJobId,
    job.data.projectId
  );
}

/**
 * Premium-tier covers render once per book, so they use the strongest image
 * model. Explicit operator image selections are respected as-is.
 */
export function coverImageSelectionForInput(input: CreateProjectInput): ImageModelSelection | undefined {
  if (config.MOCK_AI || input.mediaSettings.imageModel || !isPremiumProject(input)) {
    return undefined;
  }
  return premiumCoverImageSelection();
}

function loggedTextModel(input?: CreateProjectInput | undefined): LoggedTextModel {
  if (config.MOCK_AI) {
    return { provider: "fake", model: "fake-model" };
  }
  const selection = resolveTextModelSelection(config, input);
  return { provider: selection.provider, model: selection.model };
}

/** Makes the Quality tab authoritative for every project writer/judgment call. */
export function liveGenerationTextModel(
  delegate: TextModelAdapter,
  input: CreateProjectInput | undefined,
  logger: RunLogger
): TextModelAdapter {
  if (config.MOCK_AI || !input) {
    return delegate;
  }
  return createLiveGenerationTextModel(config, {
    tier: modelTierForInput(input),
    loadRouting: loadLiveGenerationTextRouting(logger),
    onFallbackEvent: textRoutingRunLog(logger)
  });
}

/**
 * Writes a text pair's routing events as `text.routing.<event>`. The event's own
 * `event` field stays out of the payload, as the image path's does: spread into
 * the entry it overwrote the prefixed name, so the run log said `fallback.start`.
 */
export function textRoutingRunLog(logger: RunLogger): (event: TextFallbackEvent) => Promise<void> {
  return async ({ event, ...payload }) => {
    await logger.append(`text.routing.${event}`, payload);
  };
}

function createLoggedImageAdapter(
  primaryAdapter: ImageAdapter,
  logger: RunLogger,
  generationJobId: string | undefined,
  input?: CreateProjectInput | undefined,
  selectionOverride?: ImageModelSelection | undefined
): ImageAdapter {
  if (!input || config.MOCK_AI) {
    return new LoggingImageAdapter(primaryAdapter, logger, generationJobId);
  }

  const primary = selectionOverride ?? resolveImageModelSelection(config, input);
  const fallback = imageFallbackSelection(primary, input);
  return new FallbackImageAdapter({
    primary: {
      provider: primary.provider,
      model: primary.model,
      adapter: new LoggingImageAdapter(primaryAdapter, logger, generationJobId, {
        role: "primary",
        provider: primary.provider,
        model: primary.model
      })
    },
    fallback: {
      provider: fallback.provider,
      model: fallback.model,
      adapter: () =>
        new LoggingImageAdapter(createImageAdapterForSelection(fallback), logger, generationJobId, {
          role: "fallback",
          provider: fallback.provider,
          model: fallback.model
        })
    },
    onEvent: async (fallbackEvent) => {
      const { event, ...payload } = fallbackEvent;
      await logger.append(`image.generate.${event}`, payload);
    },
    shouldFallback: (error) => !isStopRequestedError(error)
  });
}

/** The rule lives in core so the production check can read which providers it names. */
export function imageFallbackSelection(primary: ImageModelSelection, input?: CreateProjectInput | undefined): ImageModelSelection {
  return resolveImageFallbackSelection(config, primary, Boolean(input && isPremiumProject(input)));
}

export function createImageAdapterForSelection(selection: ImageModelSelection): ImageAdapter {
  if (selection.provider === "alibaba") {
    return new AlibabaImageAdapter({
      apiKey: config.ALIBABA_API_KEY,
      apiHost: config.ALIBABA_API_HOST,
      imageModel: selection.model
    });
  }
  return new GeminiImageAdapter({
    apiKey: config.GEMINI_API_KEY,
    imageModel: selection.model
  });
}

/** How often an in-flight provider call re-checks the job's stop flag. */
const STOP_ABORT_POLL_MS = 2_500;

export class LoggingTextModelAdapter implements TextModelAdapter {
  constructor(
    private readonly delegate: TextModelAdapter,
    private readonly logger: RunLogger,
    private readonly generationJobId: string | undefined,
    private readonly projectId: string | undefined,
    private readonly textModel: LoggedTextModel
  ) {}

  setPurposeOverridesEnabled(enabled: boolean): void {
    const inner = this.delegate as { setPurposeOverridesEnabled?: (value: boolean) => void };
    if (typeof inner.setPurposeOverridesEnabled === "function") {
      inner.setPurposeOverridesEnabled(enabled);
    }
  }

  async bindForCall(purpose: string | undefined) {
    const bound = await this.boundDelegate(purpose);
    return {
      adapter: new LoggingTextModelAdapter(
        bound.adapter,
        this.logger,
        this.generationJobId,
        this.projectId,
        bound.textModel
      ),
      ...(bound.selection ? { selection: bound.selection } : {})
    };
  }

  private textModelForPurpose(purpose: string | undefined): LoggedTextModel {
    if (this.delegate instanceof RoutingTextModelAdapter) {
      const selection = this.delegate.selectionForPurpose(purpose);
      return { provider: selection.provider, model: selection.model };
    }
    return this.textModel;
  }

  private async boundDelegate(purpose: string | undefined) {
    const bound = await bindTextModelCall(this.delegate, purpose);
    const selected = bound.selection;
    return {
      adapter: bound.adapter,
      ...(selected ? { selection: selected } : {}),
      textModel: selected
        ? { provider: selected.provider, model: selected.model }
        : this.textModelForPurpose(purpose)
    };
  }

  private fallbackAccounting(
    liveUsage: Awaited<ReturnType<typeof beginLiveTextUsage>>,
    options: GenerateTextOptions,
    primary: LoggedTextModel,
    operation: string,
    callId: string,
    startedAt: string
  ): TextFallbackCallAccounting {
    return new TextFallbackCallAccounting(liveUsage, {
      projectId: options.projectId ?? this.projectId,
      generationJobId: this.generationJobId,
      purpose: options.purpose ?? operation,
      operation,
      callId,
      primary,
      requestOptions: options,
      logger: this.logger,
      startedAt
    });
  }

  /**
   * Runs the delegate call with an abort signal wired to the job's stop flag,
   * polled every few seconds. Without it a stop was only observed *between*
   * provider calls, so a 64k-token whole-book draft ran to completion — and
   * was billed — after the user pressed stop. One controller covers every
   * retry attempt: a stop is permanent, so an aborted retry failing fast is
   * the point, and the catch paths' `assertJobNotStopped` converts the abort
   * error into the StopRequestedError the lifecycle expects.
   */
  private async withStopAbort<TOptions extends GenerateTextOptions, TResult>(
    options: TOptions,
    run: (options: TOptions) => Promise<TResult>
  ): Promise<TResult> {
    if (!this.generationJobId) {
      return run(options);
    }
    const generationJobId = this.generationJobId;
    const controller = new AbortController();
    const upstream = options.signal;
    const onUpstreamAbort = () => controller.abort();
    if (upstream?.aborted) {
      controller.abort();
    }
    upstream?.addEventListener("abort", onUpstreamAbort);
    const poll = setInterval(() => {
      void hasStoppedGenerationJob(generationJobId)
        .then((stopped) => {
          if (stopped) {
            controller.abort();
          }
        })
        .catch(() => {});
    }, STOP_ABORT_POLL_MS);
    try {
      return await run({ ...options, signal: controller.signal });
    } finally {
      clearInterval(poll);
      upstream?.removeEventListener("abort", onUpstreamAbort);
    }
  }

  /** Owns the shared observer, retry, stop, and failure-settlement lifecycle. */
  private async runFallbackCall<TOptions extends GenerateTextOptions, TResult>(parameters: {
    liveUsage: Awaited<ReturnType<typeof beginLiveTextUsage>>;
    options: TOptions;
    primary: LoggedTextModel;
    operation: string;
    callId: string;
    startedAt: string;
    prepareOptions?: ((accounting: TextFallbackCallAccounting) => TOptions) | undefined;
    run: (options: TOptions) => Promise<TResult>;
    onSuccess: (result: TResult, accounting: TextFallbackCallAccounting) => Promise<TResult>;
  }): Promise<TResult> {
    const accounting = this.fallbackAccounting(
      parameters.liveUsage,
      parameters.options,
      parameters.primary,
      parameters.operation,
      parameters.callId,
      parameters.startedAt
    );
    const callOptions = withTextAttemptBudget(parameters.prepareOptions?.(accounting) ?? parameters.options);
    const observedOptions = accounting.observe(callOptions);
    try {
      await assertJobNotStopped(this.generationJobId);
      const result = await this.withStopAbort(observedOptions, (abortableOptions) => {
        const retryOptions = providerRetryOptions(this.logger, this.generationJobId, parameters.operation,
          parameters.options.purpose, abortableOptions.signal);
        return withRecoverableNetworkRetry(
          () => accounting.run(() => parameters.run(abortableOptions)),
          { ...retryOptions, shouldRetry: (error) =>
            abortableOptions.textAttemptBudget!.used < abortableOptions.textAttemptBudget!.limit &&
            (retryOptions.shouldRetry ?? isRecoverableNetworkError)(error) }
        );
      });
      const settled = await parameters.onSuccess(result, accounting);
      await assertJobNotStopped(this.generationJobId);
      return settled;
    } catch (error) {
      return this.failFallbackCall(
        accounting,
        parameters.operation,
        parameters.callId,
        error
      );
    }
  }

  private async failFallbackCall(
    accounting: TextFallbackCallAccounting,
    operation: string,
    callId: string,
    error: unknown
  ): Promise<never> {
    const errorAt = await this.logger.append(`${operation}.error`, {
      callId, providerRequest: accounting.providerRequest, error: serializeError(error)
    });
    await accounting.finalizeUnhandledFailure(error, errorAt);
    await assertJobNotStopped(this.generationJobId);
    throw error;
  }

  async generateText(requested: GenerateTextOptions) {
    const options = await withContentSafetyRule(requested);
    const bound = await this.boundDelegate(options.purpose);
    const callId = randomUUID();
    const textModel = bound.textModel;
    const requestAt = await this.logger.append("text.generateText.request", {
      callId,
      model: textModel,
      request: logTextRequest(options, boundedProviderCallMetadata(options.providerCallMetadata, "pending"))
    });
    const liveUsage = await beginLiveTextUsage({
      projectId: options.projectId ?? this.projectId,
      generationJobId: this.generationJobId,
      provider: textModel.provider,
      model: textModel.model,
      purpose: options.purpose ?? "text.generateText",
      operation: "text.generateText",
      callId,
      startedAt: requestAt,
      options
    });
    let responseCharacterCount = 0;
    let lastLiveOutputUpdateAt = 0;
    return this.runFallbackCall({
      liveUsage,
      options,
      primary: textModel,
      operation: "text.generateText",
      callId,
      startedAt: requestAt,
      prepareOptions: (accounting) =>
        withLiveOutputTracking(options, async (chunk) => {
          responseCharacterCount += chunk.length;
          lastLiveOutputUpdateAt = await maybeUpdateLiveTextOutput({
            liveUsageId: accounting.liveUsageId,
            outputTokens: estimateTokenCountFromTextLength(responseCharacterCount),
            lastUpdateAt: lastLiveOutputUpdateAt
          });
      }),
      run: (callOptions) => bound.adapter.generateText(callOptions),
      onSuccess: async (result, accounting) => {
        const responseAt = await this.logger.append("text.generateText.response", { callId, providerRequest: accounting.providerRequest, result });
        await recordProviderUsage({
          projectId: options.projectId ?? this.projectId,
          generationJobId: this.generationJobId,
          provider: result.provider,
          model: result.model,
          purpose: options.purpose ?? "text.generateText",
          operation: "text.generateText",
          callId,
          durationMs: durationBetweenTimestamps(accounting.startedAt, responseAt),
          usage: accounting.usageForResult(result),
          usageUnavailableReason: result.usageUnavailableReason,
          liveUsageId: accounting.liveUsageId,
          fallbackPromptTokens: accounting.promptTokens,
          fallbackOutputTokens: Math.max(
            estimateTokenCountFromText(result.text),
            estimateTokenCountFromTextLength(responseCharacterCount)
          ),
          ...optionalProviderCallMetadata(options.providerCallMetadata)
        });
        return result;
      }
    });
  }

  async generateJson<T>(requested: GenerateJsonOptions<T>) {
    const options = await withContentSafetyRule(requested);
    const bound = await this.boundDelegate(options.purpose);
    const callId = randomUUID();
    const textModel = bound.textModel;
    const requestAt = await this.logger.append("text.generateJson.request", {
      callId,
      model: textModel,
      request: logTextRequest(options, boundedProviderCallMetadata(options.providerCallMetadata, "pending"))
    });
    const liveUsage = await beginLiveTextUsage({
      projectId: options.projectId ?? this.projectId,
      generationJobId: this.generationJobId,
      provider: textModel.provider,
      model: textModel.model,
      purpose: options.purpose ?? "text.generateJson",
      operation: "text.generateJson",
      callId,
      startedAt: requestAt,
      options
    });
    let responseCharacterCount = 0;
    let lastLiveOutputUpdateAt = 0;
    return this.runFallbackCall({
      liveUsage,
      options,
      primary: textModel,
      operation: "text.generateJson",
      callId,
      startedAt: requestAt,
      prepareOptions: (accounting) =>
        withLiveOutputTracking(options, async (chunk) => {
          responseCharacterCount += chunk.length;
          lastLiveOutputUpdateAt = await maybeUpdateLiveTextOutput({
            liveUsageId: accounting.liveUsageId,
            outputTokens: estimateTokenCountFromTextLength(responseCharacterCount),
            lastUpdateAt: lastLiveOutputUpdateAt
          });
      }),
      run: (callOptions) => bound.adapter.generateJson<T>(callOptions),
      onSuccess: async (result, accounting) => {
        const responseAt = await this.logger.append("text.generateJson.response", { callId, providerRequest: accounting.providerRequest, result });
        await recordProviderUsage({
          projectId: options.projectId ?? this.projectId,
          generationJobId: this.generationJobId,
          provider: result.provider,
          model: result.model,
          purpose: options.purpose ?? "text.generateJson",
          operation: "text.generateJson",
          callId,
          durationMs: durationBetweenTimestamps(accounting.startedAt, responseAt),
          usage: accounting.usageForResult(result),
          usageUnavailableReason: result.usageUnavailableReason,
          liveUsageId: accounting.liveUsageId,
          fallbackPromptTokens: accounting.promptTokens,
          fallbackOutputTokens: Math.max(
            estimateTokenCountFromText(result.text),
            estimateTokenCountFromTextLength(responseCharacterCount)
          ),
          ...optionalProviderCallMetadata(options.providerCallMetadata)
        });
        return result;
      }
    });
  }

  async generateWithTools(requested: GenerateWithToolsOptions) {
    const options = await withContentSafetyRule(requested);
    const bound = await this.boundDelegate(options.purpose);
    const callId = randomUUID();
    const textModel = bound.textModel;
    const requestAt = await this.logger.append("text.generateWithTools.request", {
      callId,
      model: textModel,
      request: {
        ...logTextRequest(options, boundedProviderCallMetadata(options.providerCallMetadata, "pending")),
        tools: options.tools.map((tool) => tool.name)
      }
    });
    const liveUsage = await beginLiveTextUsage({
      projectId: options.projectId ?? this.projectId,
      generationJobId: this.generationJobId,
      provider: textModel.provider,
      model: textModel.model,
      purpose: options.purpose ?? "text.generateWithTools",
      operation: "text.generateWithTools",
      callId,
      startedAt: requestAt,
      options
    });
    return this.runFallbackCall({
      liveUsage,
      options,
      primary: textModel,
      operation: "text.generateWithTools",
      callId,
      startedAt: requestAt,
      run: (callOptions) => bound.adapter.generateWithTools(callOptions),
      onSuccess: async (result, accounting) => {
        const responseAt = await this.logger.append("text.generateWithTools.response", { callId, providerRequest: accounting.providerRequest, result });
        await recordProviderUsage({
          projectId: options.projectId ?? this.projectId,
          generationJobId: this.generationJobId,
          provider: result.provider,
          model: result.model,
          purpose: options.purpose ?? "text.generateWithTools",
          operation: "text.generateWithTools",
          callId,
          durationMs: durationBetweenTimestamps(accounting.startedAt, responseAt),
          usage: accounting.usageForResult(result),
          usageUnavailableReason: result.usageUnavailableReason,
          liveUsageId: accounting.liveUsageId,
          fallbackPromptTokens: accounting.promptTokens,
          fallbackOutputTokens: estimateTokenCountFromText(result.text),
          ...optionalProviderCallMetadata(options.providerCallMetadata)
        });
        return result;
      }
    });
  }

  async *streamText(requested: GenerateTextOptions) {
    const options = await withContentSafetyRule(requested);
    const bound = await this.boundDelegate(options.purpose);
    const callId = randomUUID();
    const textModel = bound.textModel;
    const requestAt = await this.logger.append("text.streamText.request", {
      callId,
      model: textModel,
      request: logTextRequest(options, boundedProviderCallMetadata(options.providerCallMetadata, "pending"))
    });
    const liveUsage = await beginLiveTextUsage({
      projectId: options.projectId ?? this.projectId,
      generationJobId: this.generationJobId,
      provider: textModel.provider,
      model: textModel.model,
      purpose: options.purpose ?? "text.streamText",
      operation: "text.streamText",
      callId,
      startedAt: requestAt,
      options
    });
    const fallbackAccounting = this.fallbackAccounting(
      liveUsage,
      options,
      textModel,
      "text.streamText",
      callId,
      requestAt
    );
    const observedOptions = fallbackAccounting.observe(withTextAttemptBudget(options));
    let chunkCount = 0;
    let characterCount = 0;
    let lastLiveOutputUpdateAt = 0;
    try {
      await assertJobNotStopped(this.generationJobId);
      for await (const chunk of bound.adapter.streamText(observedOptions)) {
        await assertJobNotStopped(this.generationJobId);
        chunkCount += 1;
        characterCount += chunk.length;
        lastLiveOutputUpdateAt = await maybeUpdateLiveTextOutput({
          liveUsageId: fallbackAccounting.liveUsageId,
          outputTokens: estimateTokenCountFromTextLength(characterCount),
          lastUpdateAt: lastLiveOutputUpdateAt
        });
        yield chunk;
      }
      const responseAt = await this.logger.append("text.streamText.response", {
        callId, providerRequest: fallbackAccounting.providerRequest,
        usage: fallbackAccounting.providerUsage, chunkCount, characterCount
      });
      await recordProviderUsage({
        projectId: options.projectId ?? this.projectId,
        generationJobId: this.generationJobId,
        provider: fallbackAccounting.providerRequest?.provider ?? textModel.provider,
        model: fallbackAccounting.providerRequest?.model ?? textModel.model,
        purpose: options.purpose ?? "text.streamText",
        operation: "text.streamText",
        callId,
        durationMs: durationBetweenTimestamps(fallbackAccounting.startedAt, responseAt),
        usage: fallbackAccounting.providerUsage,
        liveUsageId: fallbackAccounting.liveUsageId,
        fallbackPromptTokens: fallbackAccounting.promptTokens,
        fallbackOutputTokens: estimateTokenCountFromTextLength(characterCount),
        ...optionalProviderCallMetadata(options.providerCallMetadata)
      });
      await assertJobNotStopped(this.generationJobId);
    } catch (error) {
      await this.failFallbackCall(fallbackAccounting, "text.streamText", callId, error);
    }
  }
}

export class LoggingResearchAdapter implements ResearchAdapter {
  constructor(
    private readonly delegate: ResearchAdapter,
    private readonly logger: RunLogger,
    private readonly generationJobId: string | undefined,
    private readonly projectId?: string
  ) {}

  async search(query: ResearchQuery) {
    const callId = randomUUID();
    const requestAt = await this.logger.append("research.search.request", { callId, query });
    try {
      await assertJobNotStopped(this.generationJobId);
      const result = await withRecoverableNetworkRetry(
        () => this.searchOnce(query, callId),
        providerRetryOptions(this.logger, this.generationJobId, "research.search", query.purpose)
      );
      const responseAt = await this.logger.append("research.search.response", { callId, result });
      if (result.provider && result.model && result.usage) {
        await recordProviderUsage({
          projectId: query.projectId ?? this.projectId,
          generationJobId: this.generationJobId,
          provider: result.provider,
          model: result.model,
          purpose: query.purpose ?? "research.search",
          operation: "research.search",
          callId,
          durationMs: durationBetweenTimestamps(requestAt, responseAt),
          usage: result.usage,
          searchGrounding: result.grounding,
          searchGroundingAllowances: config
        });
      }
      await assertJobNotStopped(this.generationJobId);
      return result;
    } catch (error) {
      await this.logger.append("research.search.error", { callId, error: serializeError(error) });
      await assertJobNotStopped(this.generationJobId);
      throw error;
    }
  }

  /**
   * One physical request. A failed one still writes its cost row: Google may
   * have grounded the prompt, and billed it, before the deadline or the error,
   * so the row is a failed call of unknown usage whose grounding is unknown —
   * no fee, no place claimed in the free allowance (apps/api/src/admin/CLAUDE.md).
   * A result names its own provider and model; for an error, the adapter's.
   */
  private async searchOnce(query: ResearchQuery, callId: string) {
    const startedAt = Date.now();
    try {
      return await this.delegate.search(query);
    } catch (error) {
      if (!isStopRequestedError(error)) {
        await recordProviderUsage({
          projectId: query.projectId ?? this.projectId,
          generationJobId: this.generationJobId,
          provider: this.delegate.identity?.provider ?? "unknown",
          model: this.delegate.identity?.model ?? "unknown",
          purpose: query.purpose ?? "research.search",
          operation: "research.search",
          callId,
          durationMs: Date.now() - startedAt,
          usage: undefined,
          usageUnavailableReason: "provider_error",
          providerCallError: error,
          searchGrounding: "unknown"
        });
      }
      throw error;
    }
  }
}

class LoggingImageAdapter implements ImageAdapter {
  constructor(
    private readonly delegate: ImageAdapter,
    private readonly logger: RunLogger,
    private readonly generationJobId: string | undefined,
    private readonly attempt?: LoggedImageAttempt | undefined
  ) {}

  capabilities(): ImageAdapterCapabilities {
    return imageAdapterCapabilities(this.delegate);
  }

  async generateImage(request: ImageRequest) {
    const callId = randomUUID();
    const requestAt = await this.logger.append("image.generate.request", {
      callId,
      request,
      ...this.attemptLog()
    });
    try {
      await assertJobNotStopped(this.generationJobId);
      const result = await withRecoverableNetworkRetry(
        () => this.delegate.generateImage(request),
        providerRetryOptions(this.logger, this.generationJobId, "image.generate")
      );
      const responseAt = await this.logger.append("image.generate.response", {
        callId,
        result: logImageResult(result),
        ...this.attemptLog()
      });
      await recordProviderImageCost({
        projectId: request.projectId,
        generationJobId: this.generationJobId,
        provider: result.provider,
        model: result.model,
        operation: "image.generate",
        callId,
        costHint: calculateImageGenerationCost({
          provider: result.provider,
          model: result.model
        }),
        durationMs: durationBetweenTimestamps(requestAt, responseAt),
        metadata: {
          aspectRatio: request.aspectRatio,
          referenceImageCount: request.referenceImagePaths?.length ?? 0,
          mimeType: result.mimeType,
          ...this.providerCostAttemptMetadata()
        }
      });
      await assertJobNotStopped(this.generationJobId);
      return result;
    } catch (error) {
      attachProviderLogContext(error, { callId, attempt: this.attempt });
      const errorAt = await this.logger.append("image.generate.error", {
        callId,
        error: serializeError(error),
        ...this.attemptLog()
      });
      // A failed render writes no row, except one an empty account refused: the quota alert reads it.
      if (this.attempt) await recordProviderQuotaRefusal({ projectId: request.projectId, generationJobId: this.generationJobId,
        provider: this.attempt.provider, model: this.attempt.model, operation: "image.generate", callId,
        durationMs: durationBetweenTimestamps(requestAt, errorAt), error });
      await assertJobNotStopped(this.generationJobId);
      throw error;
    }
  }

  private attemptLog(): { attempt?: LoggedImageAttempt } {
    return this.attempt ? { attempt: this.attempt } : {};
  }

  private providerCostAttemptMetadata(): Record<string, unknown> {
    return this.attempt ? { attempt: this.attempt } : {};
  }
}

/** Narration outlives a rate-limit window; see the call site below. */
const SPEECH_RETRY_ATTEMPTS = 5;

class LoggingSpeechAdapter implements SpeechAdapter {
  constructor(
    private readonly delegate: SpeechAdapter,
    private readonly logger: RunLogger,
    private readonly generationJobId: string | undefined,
    private readonly projectId: string | undefined
  ) {}

  async synthesize(request: SpeechRequest) {
    const callId = randomUUID();
    const startedAt = Date.now();
    await this.logger.append("tts.synthesize.request", {
      callId,
      voice: request.voice,
      narrator: request.narrator,
      textLength: request.text.length,
      textPreview: request.text.slice(0, 300)
    });
    try {
      await assertJobNotStopped(this.generationJobId);
      const result = await withRecoverableNetworkRetry(() => this.delegate.synthesize(request), {
        ...providerRetryOptions(this.logger, this.generationJobId, "tts.synthesize"),
        // A book is dozens of sequential calls against a per-minute quota, so
        // giving up early here costs the whole chapter rather than one page.
        attempts: SPEECH_RETRY_ATTEMPTS
      });
      const durationMs = Date.now() - startedAt;
      await this.logger.append("tts.synthesize.response", {
        callId,
        provider: result.provider,
        model: result.model,
        audioMs: Math.round(result.durationMs),
        bytes: result.pcm.length,
        durationMs,
        ...(result.stylePromptDropped ? { stylePromptDropped: true } : {})
      });
      await recordProviderAudioCost({
        projectId: this.projectId,
        generationJobId: this.generationJobId,
        provider: result.provider,
        model: result.model,
        operation: "tts.synthesize",
        callId,
        costHint: estimateSpeechCostUsd({ provider: result.provider, audioMs: result.durationMs }),
        durationMs,
        audioMs: result.durationMs,
        metadata: {
          narrator: request.narrator,
          providerVoice: request.voice,
          textLength: request.text.length
        }
      });
      await assertJobNotStopped(this.generationJobId);
      return result;
    } catch (error) {
      await this.logger.append("tts.synthesize.error", { callId, error: serializeError(error) });
      await assertJobNotStopped(this.generationJobId);
      throw error;
    }
  }
}

