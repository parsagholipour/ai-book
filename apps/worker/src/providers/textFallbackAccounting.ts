import {
  withTextFallbackEventObserver,
  type GenerateTextOptions,
  type TextProviderRequest,
  type Usage,
  type TextFallbackEvent
} from "@book-maker/core";
import type { RunLogger } from "./runLogging.js";
import {
  beginLiveTextUsage,
  durationBetweenTimestamps,
  markLiveTextUsageFailed,
  optionalProviderCallMetadata,
  providerUsageFromError,
  recordProviderUsage
} from "./usageAccounting.js";

type LiveTextUsage = { id: string; promptTokens: number } | null;

type TextFallbackCallContext = {
  projectId: string | undefined;
  generationJobId: string | undefined;
  purpose: string;
  operation: string;
  callId: string;
  primary: { provider: string; model: string };
  requestOptions: GenerateTextOptions;
  startedAt: string;
  logger: RunLogger;
};

/** Keeps each provider attempt on its own live/cost row during one fallback-capable call. */
export class TextFallbackCallAccounting {
  private attemptFailureFinalized = false;
  private attemptStartedAt: string;
  private readonly estimatedPromptTokens: number | undefined;
  private requestIndex = 0;
  providerRequest: (TextProviderRequest & { requestIndex: number }) | undefined;
  providerUsage: Usage | undefined;

  constructor(
    private liveUsage: LiveTextUsage,
    private readonly context: TextFallbackCallContext
  ) {
    this.attemptStartedAt = context.startedAt;
    this.estimatedPromptTokens = liveUsage?.promptTokens;
  }

  observe<T extends GenerateTextOptions>(options: T): T {
    return withTextFallbackEventObserver({
      ...options,
      onProviderRequest: async (request: TextProviderRequest) => {
        this.providerRequest = { ...request, requestIndex: ++this.requestIndex };
        this.providerUsage = undefined;
        try {
          await this.context.logger.append(`${this.context.operation}.provider_request`, {
            callId: this.context.callId,
            purpose: this.context.purpose,
            ...this.providerRequest
          });
        } catch { /* Diagnostic I/O cannot fail generation. */ }
        try { await options.onProviderRequest?.(request); }
        catch { /* Preserve the same best-effort contract for an upstream observer. */ }
      },
      onProviderUsage: async (usage: Usage) => {
        this.providerUsage = usage;
        try {
          await this.context.logger.append(`${this.context.operation}.provider_usage`, {
            callId: this.context.callId, providerRequest: this.providerRequest, usage
          });
        } catch { /* Diagnostic I/O cannot fail generation. */ }
        try { await options.onProviderUsage?.(usage); }
        catch { /* An upstream diagnostic callback is also best-effort. */ }
      }
    }, (event) => this.handleEvent(event));
  }

  get liveUsageId(): string | undefined {
    return this.liveUsage?.id;
  }

  get promptTokens(): number | undefined {
    return this.liveUsage?.promptTokens ?? this.estimatedPromptTokens;
  }

  /** Only the current physical request may supply missing result usage. */
  usageForResult(result: { provider: string; model: string; usage?: Usage }): Usage | undefined {
    const request = this.providerRequest ?? this.context.primary;
    if (request.provider !== result.provider || request.model !== result.model) return result.usage;
    if (!this.providerUsage) return result.usage;
    const merged = { ...this.providerUsage };
    for (const key of ["promptTokens", "outputTokens", "cacheHitTokens", "cacheWriteTokens", "reasoningTokens"] as const) {
      const value = result.usage?.[key];
      if (value !== undefined) merged[key] = value;
    }
    return merged;
  }

  get startedAt(): string {
    return this.attemptStartedAt;
  }

  async run<T>(operation: () => Promise<T>): Promise<T> {
    if (this.attemptFailureFinalized) {
      const startedAt = new Date().toISOString();
      this.attemptStartedAt = startedAt;
      this.providerRequest = undefined;
      this.providerUsage = undefined;
      this.liveUsage = await beginLiveTextUsage({
        projectId: this.context.projectId,
        generationJobId: this.context.generationJobId,
        provider: this.context.primary.provider,
        model: this.context.primary.model,
        purpose: this.context.purpose,
        operation: this.context.operation,
        callId: this.context.callId,
        startedAt,
        options: this.context.requestOptions
      });
      this.attemptFailureFinalized = false;
    }
    try {
      return await operation();
    } catch (error) {
      // Network retries re-enter this method under the same call ID. Settle
      // this attempt now, before the next dispatch replaces its usage.
      await this.finalizeUnhandledFailure(error, new Date().toISOString());
      this.attemptFailureFinalized = true;
      throw error;
    }
  }

  /** Settles the active attempt unless the fallback event already settled it. */
  async finalizeUnhandledFailure(
    error: unknown,
    finishedAt: string
  ): Promise<void> {
    if (this.attemptFailureFinalized) {
      return;
    }
    await this.finalizeFailure(error, finishedAt);
  }

  private async handleEvent(event: TextFallbackEvent): Promise<void> {
    const eventAt = new Date().toISOString();
    if (event.event === "fallback.start") {
      await this.finalizeFailure(event.primary.error, eventAt);
      this.providerRequest = undefined;
      this.providerUsage = undefined;
      this.attemptStartedAt = eventAt;
      this.liveUsage = await beginLiveTextUsage({
        projectId: this.context.projectId,
        generationJobId: this.context.generationJobId,
        provider: event.fallback.provider,
        model: event.fallback.model,
        purpose: this.context.purpose,
        operation: this.context.operation,
        callId: this.context.callId,
        startedAt: eventAt,
        options: this.context.requestOptions
      });
      return;
    }
    if (event.event === "fallback.error") {
      await this.finalizeFailure(event.fallback.error, eventAt);
      this.attemptFailureFinalized = true;
    }
  }

  private async finalizeFailure(error: unknown, finishedAt: string): Promise<void> {
    const providerUsage = providerUsageFromError(error) ?? (
      this.providerRequest && this.providerUsage
        ? { ...this.providerRequest, usage: this.providerUsage }
        : undefined
    );
    const durationMs = durationBetweenTimestamps(this.attemptStartedAt, finishedAt);
    if (providerUsage) {
      await recordProviderUsage({
        projectId: this.context.projectId,
        generationJobId: this.context.generationJobId,
        provider: providerUsage.provider,
        model: providerUsage.model,
        purpose: this.context.purpose,
        operation: this.context.operation,
        callId: this.context.callId,
        durationMs,
        usage: providerUsage.usage,
        liveUsageId: this.liveUsageId,
        fallbackPromptTokens: this.promptTokens,
        ...optionalProviderCallMetadata(this.context.requestOptions.providerCallMetadata),
        providerCallError: error
      });
      return;
    }
    await markLiveTextUsageFailed(this.liveUsageId, {
      durationMs,
      error,
      ...optionalProviderCallMetadata(this.context.requestOptions.providerCallMetadata)
    });
  }
}
