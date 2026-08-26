import {
  withTextFallbackEventObserver,
  type GenerateTextOptions,
  type TextFallbackEvent
} from "@book-maker/core";
import {
  beginLiveTextUsage,
  durationBetweenTimestamps,
  markLiveTextUsageFailed,
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
};

/** Keeps each provider attempt on its own live/cost row during one fallback-capable call. */
export class TextFallbackCallAccounting {
  private fallbackFailureFinalized = false;
  private attemptStartedAt: string;
  private readonly estimatedPromptTokens: number | undefined;

  constructor(
    private liveUsage: LiveTextUsage,
    private readonly context: TextFallbackCallContext
  ) {
    this.attemptStartedAt = context.startedAt;
    this.estimatedPromptTokens = liveUsage?.promptTokens;
  }

  observe<T extends GenerateTextOptions>(options: T): T {
    return withTextFallbackEventObserver(options, (event) => this.handleEvent(event));
  }

  get liveUsageId(): string | undefined {
    return this.liveUsage?.id;
  }

  get promptTokens(): number | undefined {
    return this.liveUsage?.promptTokens ?? this.estimatedPromptTokens;
  }

  get startedAt(): string {
    return this.attemptStartedAt;
  }

  async run<T>(operation: () => Promise<T>): Promise<T> {
    if (this.fallbackFailureFinalized) {
      const startedAt = new Date().toISOString();
      this.attemptStartedAt = startedAt;
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
      this.fallbackFailureFinalized = false;
    }
    return operation();
  }

  /** Settles the active attempt unless the fallback event already settled it. */
  async finalizeUnhandledFailure(
    error: unknown,
    finishedAt: string,
    captureProviderUsage: boolean
  ): Promise<void> {
    if (this.fallbackFailureFinalized) {
      return;
    }
    if (captureProviderUsage) {
      await this.finalizeFailure(error, finishedAt);
      return;
    }
    await markLiveTextUsageFailed(this.liveUsageId, {
      durationMs: durationBetweenTimestamps(this.attemptStartedAt, finishedAt),
      error
    });
  }

  private async handleEvent(event: TextFallbackEvent): Promise<void> {
    const eventAt = new Date().toISOString();
    if (event.event === "fallback.start") {
      await this.finalizeFailure(event.primary.error, eventAt);
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
      this.fallbackFailureFinalized = true;
    }
  }

  private async finalizeFailure(error: unknown, finishedAt: string): Promise<void> {
    const providerUsage = providerUsageFromError(error);
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
        fallbackPromptTokens: this.promptTokens
      });
      return;
    }
    await markLiveTextUsageFailed(this.liveUsageId, { durationMs, error });
  }
}
