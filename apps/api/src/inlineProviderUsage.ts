import {
  bindTextModelCall,
  calculateTextGenerationCost,
  estimateTokensByScript,
  type BoundTextModelCall,
  type ChatMessage,
  type GenerateJsonOptions,
  type GenerateTextOptions,
  type GenerateWithToolsOptions,
  type TextModelAdapter,
  type TextResult,
  type Usage
} from "@book-maker/core";
import { prisma, type Prisma } from "@book-maker/db";
import { randomUUID } from "node:crypto";

/**
 * Provider cost rows for the few model calls the API makes itself.
 *
 * The worker's calls are costed by its logging adapter (`recordProviderUsage`
 * in `apps/worker/src/providers/usageAccounting.ts`); an inline API call went
 * through nothing, so its spend was invisible to the Costs tab. This is the
 * narrow half of that recorder: one `ProviderCallLog` row per *physical* call,
 * settled at once (no live row — these calls are seconds long), with the same
 * two rules the worker keeps:
 *
 * - `costHint` is priced only from token counts the provider reported. Once
 *   either half is an estimate the row is `provisional` and `costHint` is
 *   null, because a non-null `costHint` *is* a settled, priced call to every
 *   admin reader (`apps/api/src/admin/CLAUDE.md`).
 * - Recording never fails the request. A logging error is written to the
 *   console and swallowed.
 *
 * Rows carry `generationJobId: null`, which is exactly how the Operations tab
 * already recognises inline spend (`UNBILLED_INLINE`), and
 * `metadata.operation: "inline"` so they can be told apart from the worker's.
 *
 * Wrapping happens at `bindForCall`, the way `SourceAwareTextModel` does it:
 * `generateJsonWithRetry` binds once and then calls the *bound* adapter for
 * every attempt and repair, so a wrapper only around the outer methods would
 * see none of them.
 */

export type InlineUsageContext = {
  projectId: string | null;
};

/** Four Latin characters per token and one per dense one — the worker's estimate. */
const ESTIMATE_WEIGHTS = { latinCharsPerToken: 4, denseCharsPerToken: 1 } as const;

export function withInlineProviderUsage(textModel: TextModelAdapter, context: InlineUsageContext): TextModelAdapter {
  return new InlineUsageTextModel(textModel, context);
}

class InlineUsageTextModel implements TextModelAdapter {
  constructor(
    private readonly delegate: TextModelAdapter,
    private readonly context: InlineUsageContext
  ) {}

  async bindForCall(purpose: string | undefined): Promise<BoundTextModelCall> {
    const bound = await bindTextModelCall(this.delegate, purpose);
    return { ...bound, adapter: new RecordingTextModel(bound.adapter, this.context) };
  }

  async generateText(options: GenerateTextOptions) {
    return (await this.bindForCall(options.purpose)).adapter.generateText(options);
  }

  async generateJson<T>(options: GenerateJsonOptions<T>) {
    return (await this.bindForCall(options.purpose)).adapter.generateJson(options);
  }

  async generateWithTools(options: GenerateWithToolsOptions) {
    return (await this.bindForCall(options.purpose)).adapter.generateWithTools(options);
  }

  async *streamText(options: GenerateTextOptions) {
    // Nothing inline streams; a stream is passed through unrecorded rather
    // than priced from a guess.
    yield* this.delegate.streamText(options);
  }
}

/** The bound, concrete adapter for one logical call, recording each physical attempt. */
class RecordingTextModel implements TextModelAdapter {
  constructor(
    private readonly delegate: TextModelAdapter,
    private readonly context: InlineUsageContext
  ) {}

  generateText(options: GenerateTextOptions) {
    return this.recorded("text.generateText", options, () => this.delegate.generateText(options));
  }

  generateJson<T>(options: GenerateJsonOptions<T>) {
    return this.recorded("text.generateJson", options, () => this.delegate.generateJson(options));
  }

  generateWithTools(options: GenerateWithToolsOptions) {
    return this.recorded("text.generateWithTools", options, () => this.delegate.generateWithTools(options));
  }

  streamText(options: GenerateTextOptions) {
    return this.delegate.streamText(options);
  }

  private async recorded<R extends TextResult>(
    textOperation: string,
    options: GenerateTextOptions,
    run: () => Promise<R>
  ): Promise<R> {
    const startedAt = Date.now();
    const result = await run();
    await recordInlineProviderUsage({
      projectId: this.context.projectId,
      provider: result.provider,
      model: result.model,
      purpose: options.purpose ?? textOperation,
      textOperation,
      durationMs: Date.now() - startedAt,
      usage: result.usage,
      fallbackPromptTokens: estimateMessagesTokens(options.messages),
      fallbackOutputTokens: estimateTokens(result.text)
    });
    return result;
  }
}

function estimateTokens(text: string): number {
  return text ? Math.max(1, estimateTokensByScript(text, ESTIMATE_WEIGHTS)) : 0;
}

function estimateMessagesTokens(messages: readonly ChatMessage[]): number {
  return estimateTokens(messages.map((message) => message.content).join("\n"));
}

function finiteTokenCount(value: number | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.round(value) : null;
}

/** One settled row. Exported for its tests; callers go through {@link withInlineProviderUsage}. */
export async function recordInlineProviderUsage(options: {
  projectId: string | null;
  provider: string;
  model: string;
  purpose: string;
  textOperation: string;
  durationMs: number | null;
  usage: Usage | undefined;
  fallbackPromptTokens: number;
  fallbackOutputTokens: number;
}): Promise<void> {
  try {
    const exactPromptTokens = finiteTokenCount(options.usage?.promptTokens);
    const exactOutputTokens = finiteTokenCount(options.usage?.outputTokens);
    const cacheHitTokens = finiteTokenCount(options.usage?.cacheHitTokens);
    const cacheWriteTokens = finiteTokenCount(options.usage?.cacheWriteTokens);
    const reasoningTokens = finiteTokenCount(options.usage?.reasoningTokens);
    const promptTokens = exactPromptTokens ?? options.fallbackPromptTokens;
    const outputTokens = exactOutputTokens ?? options.fallbackOutputTokens;
    const promptTokensEstimated = exactPromptTokens === null;
    const outputTokensEstimated = exactOutputTokens === null;
    const provisional = promptTokensEstimated || outputTokensEstimated;
    // reasoningTokens are already inside outputTokens for billing — never added again.
    const costHint = provisional
      ? null
      : calculateTextGenerationCost({
          provider: options.provider,
          model: options.model,
          promptTokens,
          outputTokens,
          cacheHitTokens,
          cacheWriteTokens
        });
    const metadata = {
      operation: "inline",
      textOperation: options.textOperation,
      callId: randomUUID(),
      liveStatus: "settled",
      provisional,
      promptTokensEstimated,
      outputTokensEstimated,
      ...(reasoningTokens !== null ? { reasoningTokens } : {})
    } satisfies Prisma.InputJsonValue;
    await prisma.providerCallLog.create({
      data: {
        projectId: options.projectId,
        generationJobId: null,
        provider: options.provider,
        model: options.model,
        purpose: options.purpose,
        promptTokens,
        outputTokens,
        cacheHitTokens,
        cacheWriteTokens,
        costHint,
        durationMs: options.durationMs,
        metadata
      }
    });
  } catch (error) {
    console.error("Failed to record inline provider usage", error);
  }
}
