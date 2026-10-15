import {
  applySearchGroundingAllowance,
  bindTextModelCall,
  calculateSearchGroundingFee,
  calculateTextGenerationCost,
  estimateTokensByScript,
  searchCallCostHint,
  searchGroundingClaim,
  searchGroundingMetadata,
  type BoundTextModelCall,
  type ChatMessage,
  type GenerateJsonOptions,
  type GenerateTextOptions,
  type GenerateWithToolsOptions,
  type ResearchAdapter,
  type ResearchQuery,
  type SearchGroundingAllowanceConfig,
  type SearchGroundingUsage,
  type TextModelAdapter,
  type TextResult,
  type Usage
} from "@book-maker/core";
import { prisma, type Prisma } from "@book-maker/db";
import { writeWithSearchGroundingClaim } from "@book-maker/db/searchGroundingAllowance";
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
  /**
   * The signed-in reader the call is made for, so a per-reader spend cap can
   * sum the log by `userId` alone (`@book-maker/db/providerSpend`). Required
   * rather than optional, so a new call site has to say whose spend it is;
   * null only for operator-console work, which is nobody's.
   */
  userId: string | null;
  /** The deployment's grounding allowance settings (`AppConfig`); Google's published numbers where absent. */
  searchGroundingAllowances?: SearchGroundingAllowanceConfig | undefined;
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
      userId: this.context.userId,
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

/**
 * The creation chat's `web_search` is the one grounded search the API runs
 * itself, and it used to write no row at all — neither its tokens nor the
 * grounding fee Google bills per prompt on top of them — while drawing on the
 * same daily free allowance as every search the worker makes. One row per
 * answered search, priced exactly as the worker's `LoggingResearchAdapter`
 * prices one: it claims its ordinal in the same allowance counter, inside the
 * transaction that writes its row, so the API and every worker share one count
 * (searchGroundingCost.ts). A search the caller stopped waiting for is still
 * recorded when it answers, because it was still paid for.
 */
export function withInlineResearchUsage(research: ResearchAdapter, context: InlineUsageContext): ResearchAdapter {
  return {
    async search(query: ResearchQuery) {
      const startedAt = Date.now();
      const result = await research.search(query);
      if (result.provider && result.model && result.usage) {
        await recordInlineProviderUsage({
          projectId: query.projectId ?? context.projectId,
          userId: context.userId,
          provider: result.provider,
          model: result.model,
          purpose: query.purpose ?? "research.search",
          textOperation: "research.search",
          durationMs: Date.now() - startedAt,
          usage: result.usage,
          fallbackPromptTokens: estimateTokens(query.query),
          fallbackOutputTokens: estimateTokens(result.summary),
          searchGrounding: result.grounding,
          searchGroundingAllowances: context.searchGroundingAllowances
        });
      }
      return result;
    }
  };
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
  userId: string | null;
  provider: string;
  model: string;
  purpose: string;
  textOperation: string;
  durationMs: number | null;
  usage: Usage | undefined;
  fallbackPromptTokens: number;
  fallbackOutputTokens: number;
  /** A grounded search's own report; its fee joins `costHint` (see {@link withInlineResearchUsage}). */
  searchGrounding?: SearchGroundingUsage | undefined;
  searchGroundingAllowances?: SearchGroundingAllowanceConfig | undefined;
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
    const tokenCost = provisional
      ? null
      : calculateTextGenerationCost({
          provider: options.provider,
          model: options.model,
          promptTokens,
          outputTokens,
          cacheHitTokens,
          cacheWriteTokens
        });
    const groundingFee = options.searchGrounding
      ? calculateSearchGroundingFee({ provider: options.provider, model: options.model, grounding: options.searchGrounding })
      : undefined;
    const groundingClaim = groundingFee
      ? searchGroundingClaim(groundingFee, { at: new Date(), allowances: options.searchGroundingAllowances })
      : null;
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
    await writeWithSearchGroundingClaim(prisma, groundingClaim, (client, countAfter) => {
      const fee = groundingFee && groundingClaim && countAfter !== null
        ? applySearchGroundingAllowance(groundingFee, groundingClaim, countAfter)
        : groundingFee;
      return client.providerCallLog.create({
        data: {
          projectId: options.projectId,
          generationJobId: null,
          userId: options.userId,
          provider: options.provider,
          model: options.model,
          purpose: options.purpose,
          promptTokens,
          outputTokens,
          cacheHitTokens,
          cacheWriteTokens,
          costHint: fee ? searchCallCostHint(tokenCost, fee) : tokenCost,
          durationMs: options.durationMs,
          metadata: options.searchGrounding && fee ? { ...metadata, ...searchGroundingMetadata(options.searchGrounding, fee) } : metadata
        }
      });
    });
  } catch (error) {
    console.error("Failed to record inline provider usage", error);
  }
}
