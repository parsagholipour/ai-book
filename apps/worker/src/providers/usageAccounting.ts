import type { GenerateTextOptions, ProviderCallMetadata, ScriptTokenWeights, Usage } from "@book-maker/core";
import { PAGE_QA_TRIGGER_REASONS, calculateTextGenerationCost, estimateTokensByScript } from "@book-maker/core";
import { Prisma, prisma } from "@book-maker/db";
import { jsonInputValue, jsonPayloadToRecord, serializeError } from "../runtime/serialization.js";

/**
 * Provider cost and token accounting.
 *
 * Text calls open a "live" ProviderCallLog row as soon as streaming starts so
 * the UI can show spend in flight, then settle it with real usage when the
 * call finishes (or fails).
 *
 * Every number in here is either a count the provider reported or an estimate,
 * and the two are never mixed into a price: the moment either half of a call's
 * tokens comes from {@link estimateTokenCountFromText}, `provisional` is set and
 * `costHint` is written `null`. That is the invariant the whole admin
 * directory reads by (`apps/api/src/admin/CLAUDE.md`) — a non-null `costHint`
 * *is* a settled, priced call — so an estimate can never move a dollar figure,
 * a margin, or a credit charge. It can only move the token counts an operator
 * sees, which is why it still has to be roughly right.
 */

export async function recordProviderUsage(options: {
  projectId: string | undefined;
  generationJobId: string | undefined;
  provider: string;
  model: string;
  purpose: string;
  operation: string;
  callId: string;
  durationMs: number | null;
  usage: Usage | undefined;
  liveUsageId?: string | undefined;
  fallbackPromptTokens?: number | null | undefined;
  fallbackOutputTokens?: number | null | undefined;
  providerCallMetadata?: ProviderCallMetadata | undefined;
}) {
  const exactPromptTokens = finiteTokenCount(options.usage?.promptTokens);
  const exactOutputTokens = finiteTokenCount(options.usage?.outputTokens);
  const cacheHitTokens = finiteTokenCount(options.usage?.cacheHitTokens);
  const cacheWriteTokens = finiteTokenCount(options.usage?.cacheWriteTokens);
  const reasoningTokens = finiteTokenCount(options.usage?.reasoningTokens);
  const promptTokens = exactPromptTokens ?? finiteTokenCount(options.fallbackPromptTokens ?? undefined);
  const outputTokens = exactOutputTokens ?? finiteTokenCount(options.fallbackOutputTokens ?? undefined);
  if (
    promptTokens === null &&
    outputTokens === null &&
    cacheHitTokens === null &&
    cacheWriteTokens === null &&
    reasoningTokens === null
  ) {
    if (options.liveUsageId) {
      await markLiveTextUsageFailed(options.liveUsageId, { durationMs: options.durationMs });
    }
    return;
  }
  const promptTokensEstimated = exactPromptTokens === null && promptTokens !== null;
  const outputTokensEstimated = exactOutputTokens === null && outputTokens !== null;
  const provisional = promptTokensEstimated || outputTokensEstimated;
  // reasoningTokens are already inside outputTokens for billing — do not add them again.
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
    operation: options.operation,
    callId: options.callId,
    liveStatus: "settled",
    provisional,
    promptTokensEstimated,
    outputTokensEstimated,
    ...boundedProviderCallMetadata(options.providerCallMetadata),
    ...(reasoningTokens !== null ? { reasoningTokens } : {})
  } satisfies Prisma.InputJsonValue;

  try {
    const data = {
      projectId: options.projectId ?? null,
      generationJobId: options.generationJobId ?? null,
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
    };
    if (options.liveUsageId) {
      await prisma.providerCallLog.update({
        where: { id: options.liveUsageId },
        data
      });
    } else {
      await prisma.providerCallLog.create({ data });
    }
  } catch (error) {
    console.error("Failed to record provider token usage", error);
  }
}

export async function recordProviderUsageFromError(options: {
  projectId: string | undefined;
  generationJobId: string | undefined;
  purpose: string;
  operation: string;
  callId: string;
  durationMs: number | null;
  error: unknown;
  liveUsageId?: string | undefined;
  fallbackPromptTokens?: number | null | undefined;
  providerCallMetadata?: ProviderCallMetadata | undefined;
}) {
  const providerUsage = providerUsageFromError(options.error);
  if (!providerUsage) {
    return;
  }
  await recordProviderUsage({
    projectId: options.projectId,
    generationJobId: options.generationJobId,
    provider: providerUsage.provider,
    model: providerUsage.model,
    purpose: options.purpose,
    operation: options.operation,
    callId: options.callId,
    durationMs: options.durationMs,
    usage: providerUsage.usage,
    liveUsageId: options.liveUsageId,
    fallbackPromptTokens: options.fallbackPromptTokens,
    providerCallMetadata: options.providerCallMetadata
  });
}

export async function beginLiveTextUsage(options: {
  projectId: string | undefined;
  generationJobId: string | undefined;
  provider: string;
  model: string;
  purpose: string;
  operation: string;
  callId: string;
  startedAt: string;
  options: GenerateTextOptions;
}): Promise<{ id: string; promptTokens: number } | null> {
  const promptTokens = estimateTextRequestTokens(options.options);
  try {
    const log = await prisma.providerCallLog.create({
      data: {
        projectId: options.projectId ?? null,
        generationJobId: options.generationJobId ?? null,
        provider: options.provider,
        model: options.model,
        purpose: options.purpose,
        promptTokens,
        outputTokens: 0,
        cacheHitTokens: null,
        cacheWriteTokens: null,
        costHint: null,
        durationMs: null,
        metadata: {
          operation: options.operation,
          callId: options.callId,
          liveStatus: "in_progress",
          provisional: true,
          promptTokensEstimated: true,
          outputTokensEstimated: true,
          startedAt: options.startedAt,
          maxTokens: options.options.maxTokens ?? null,
          ...boundedProviderCallMetadata(options.options.providerCallMetadata)
        } satisfies Prisma.InputJsonValue
      },
      select: { id: true }
    });
    return { id: log.id, promptTokens };
  } catch (error) {
    console.error("Failed to start live provider token usage", error);
    return null;
  }
}

const PAGE_QA_TRIGGER_REASON_SET = new Set<string>(PAGE_QA_TRIGGER_REASONS);

/** Runtime allow-listing keeps this metadata machine-only even across untyped callers. */
function boundedProviderCallMetadata(value: ProviderCallMetadata | undefined): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  const raw = value as unknown as Record<string, unknown>;
  const qaTriggerReasons = Array.isArray(raw.qaTriggerReasons)
    ? [...new Set(raw.qaTriggerReasons.filter(
        (reason): reason is string => typeof reason === "string" && PAGE_QA_TRIGGER_REASON_SET.has(reason)
      ))]
    : [];
  const qaCandidateNumber = positiveInteger(raw.qaCandidateNumber);
  const qaRewriteNumber = positiveInteger(raw.qaRewriteNumber, true);
  if (qaTriggerReasons.length === 0 || qaCandidateNumber === null || qaRewriteNumber === null) {
    return {};
  }
  return { qaTriggerReasons, qaCandidateNumber, qaRewriteNumber };
}

function positiveInteger(value: unknown, allowZero = false): number | null {
  if (!Number.isInteger(value) || typeof value !== "number") {
    return null;
  }
  return value >= (allowZero ? 0 : 1) ? value : null;
}

export async function maybeUpdateLiveTextOutput(options: {
  liveUsageId: string | undefined;
  outputTokens: number;
  lastUpdateAt: number;
}): Promise<number> {
  if (!options.liveUsageId) {
    return options.lastUpdateAt;
  }
  const now = Date.now();
  if (now - options.lastUpdateAt < 1000) {
    return options.lastUpdateAt;
  }
  await updateLiveTextOutput(options.liveUsageId, options.outputTokens);
  return now;
}

export async function updateLiveTextOutput(liveUsageId: string, outputTokens: number) {
  try {
    await prisma.providerCallLog.update({
      where: { id: liveUsageId },
      data: { outputTokens }
    });
  } catch (error) {
    console.error("Failed to update live provider output tokens", error);
  }
}

export async function settleLiveTextUsageEstimate(
  liveUsageId: string | undefined,
  options: { durationMs: number | null; outputTokens: number }
) {
  if (!liveUsageId) {
    return;
  }
  try {
    const current = await prisma.providerCallLog.findUnique({
      where: { id: liveUsageId },
      select: { metadata: true }
    });
    await prisma.providerCallLog.update({
      where: { id: liveUsageId },
      data: {
        outputTokens: options.outputTokens,
        durationMs: options.durationMs,
        costHint: null,
        metadata: jsonInputValue({
          ...jsonPayloadToRecord(current?.metadata),
          liveStatus: "settled",
          provisional: true,
          outputTokensEstimated: true
        })
      }
    });
  } catch (error) {
    console.error("Failed to settle live provider token estimate", error);
  }
}

export async function markLiveTextUsageFailed(
  liveUsageId: string | undefined,
  options: { durationMs: number | null; error?: unknown } = { durationMs: null }
) {
  if (!liveUsageId) {
    return;
  }
  try {
    const current = await prisma.providerCallLog.findUnique({
      where: { id: liveUsageId },
      select: { metadata: true }
    });
    await prisma.providerCallLog.update({
      where: { id: liveUsageId },
      data: {
        durationMs: options.durationMs,
        costHint: null,
        metadata: jsonInputValue({
          ...jsonPayloadToRecord(current?.metadata),
          liveStatus: "failed",
          provisional: true,
          ...(options.error ? { error: serializeError(options.error) } : {})
        })
      }
    });
  } catch (error) {
    console.error("Failed to fail live provider token usage", error);
  }
}

export function providerUsageFromError(error: unknown): { provider: string; model: string; usage: Usage } | null {
  if (!error || typeof error !== "object") {
    return null;
  }
  const candidate = error as { provider?: unknown; model?: unknown; usage?: unknown };
  if (typeof candidate.provider !== "string" || typeof candidate.model !== "string" || !isUsage(candidate.usage)) {
    return null;
  }
  return {
    provider: candidate.provider,
    model: candidate.model,
    usage: candidate.usage
  };
}

export function isUsage(value: unknown): value is Usage {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  return (
    "promptTokens" in value ||
    "outputTokens" in value ||
    "cacheHitTokens" in value ||
    "cacheWriteTokens" in value ||
    "reasoningTokens" in value
  );
}

export async function recordProviderImageCost(options: {
  projectId: string | undefined;
  generationJobId: string | undefined;
  provider: string;
  model: string;
  operation: string;
  callId: string;
  costHint: number | null;
  durationMs: number | null;
  metadata: Record<string, unknown>;
}) {
  if (options.costHint === null) {
    return;
  }

  try {
    await prisma.providerCallLog.create({
      data: {
        projectId: options.projectId ?? null,
        generationJobId: options.generationJobId ?? null,
        provider: options.provider,
        model: options.model,
        purpose: options.operation,
        promptTokens: null,
        outputTokens: null,
        cacheHitTokens: null,
        cacheWriteTokens: null,
        costHint: options.costHint,
        durationMs: options.durationMs,
        metadata: jsonInputValue({
          operation: options.operation,
          callId: options.callId,
          ...options.metadata
        })
      }
    });
  } catch (error) {
    console.error("Failed to record provider image cost", error);
  }
}

/**
 * Narration spend, priced by seconds of audio produced rather than by tokens.
 *
 * Like the image path, a null `costHint` writes nothing at all: a row with a
 * cost is a settled, priced call, and that invariant is what lets provider spend
 * be read as `SUM("costHint")` without replaying any rate card.
 */
export async function recordProviderAudioCost(options: {
  projectId: string | undefined;
  generationJobId: string | undefined;
  provider: string;
  model: string;
  operation: string;
  callId: string;
  costHint: number | null;
  durationMs: number | null;
  audioMs: number;
  metadata?: Record<string, unknown> | undefined;
}) {
  if (options.costHint === null) {
    return;
  }

  try {
    await prisma.providerCallLog.create({
      data: {
        projectId: options.projectId ?? null,
        generationJobId: options.generationJobId ?? null,
        provider: options.provider,
        model: options.model,
        purpose: options.operation,
        promptTokens: null,
        outputTokens: null,
        cacheHitTokens: null,
        cacheWriteTokens: null,
        costHint: options.costHint,
        durationMs: options.durationMs,
        metadata: jsonInputValue({
          operation: options.operation,
          callId: options.callId,
          audioMs: Math.round(options.audioMs),
          ...options.metadata
        })
      }
    });
  } catch (error) {
    console.error("Failed to record provider audio cost", error);
  }
}

export function finiteTokenCount(value: number | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function withLiveOutputTracking<T extends GenerateTextOptions>(options: T, onChunk: (chunk: string) => Promise<void>): T {
  return {
    ...options,
    async onOutputTextChunk(chunk: string) {
      await onChunk(chunk);
      await options.onOutputTextChunk?.(chunk);
    }
  };
}

/**
 * The prompt's estimated size, counted over the messages joined exactly as the
 * provider will see them.
 *
 * **Counted over the join, not summed per message**, and the copy that costs is
 * worth what it buys. Summing {@link estimateTokenCountFromText} per message is
 * a different number, not a cheaper route to this one: each class is rounded up
 * once per message instead of once per request, the `Math.max(1, …)` floor
 * applies per message, and the `\n\n` between messages stops being counted at
 * all. Three two-character messages come to 30 that way and 31 this way, and
 * forty come to 612 against 619 — every stored `promptTokens` would shift.
 * Measured, the join is ~0.23 ms of a ~1 ms call on the largest prompt this
 * worker builds (400 KB, `runBoundedChapterQualityReview`); the counting is the
 * rest, and `estimateTokensByScript` (`packages/core/src/textTokens.ts`) is
 * where that was made cheap.
 */
export function estimateTextRequestTokens(options: GenerateTextOptions): number {
  const messageText = options.messages.map((message) => `${message.role}\n${message.content}`).join("\n\n");
  return estimateTokenCountFromText(messageText) + options.messages.length * 4 + 12;
}

/**
 * What a piece of text was probably worth in tokens, for the calls where the
 * provider did not say.
 *
 * This used to be `chars / 4` — the English rule, applied to a product that
 * ships books in Persian, Arabic, Hebrew, Hindi, Thai, Chinese, Japanese and
 * Korean. Those scripts are two to three UTF-8 bytes per character, so the same
 * page of prose was reported at roughly a quarter of its real size: on every
 * screen that counts tokens, a Persian or Chinese book read as three to four
 * times lighter than an English one of the same length, and only ever in the
 * direction that understates it. `estimateTokensByScript` (`textTokens.ts`)
 * is the same counting `rewriteOutputTokenBudget` uses to size an echo; only
 * the weights below differ, because a fuse wants to be generous and a cost
 * estimate wants the middle.
 *
 * It stays an estimate. A real tokenizer is not four characters per token in
 * Latin either, and the dense classes vary by vocabulary — see `textTokens.ts`
 * for how wrong this can be and in which direction. `provisional` on the row is
 * what says so; nothing here is ever priced.
 */
export function estimateTokenCountFromText(text: string): number {
  if (!text) {
    return 0;
  }
  return Math.max(1, estimateTokensByScript(text, COST_ESTIMATE_TOKEN_WEIGHTS));
}

/**
 * Four Latin characters per token keeps every English number this function has
 * ever reported exactly where it was — typographic punctuation included, which
 * was not true until `textTokens.ts` stopped reading a character shared between
 * scripts as evidence of a dense one. While it did, an em dash, a curly quote
 * and an ellipsis each cost a token of their own, and a line of English
 * dialogue reported 17 tokens where the flat rule reported 13.
 *
 * A pictograph is the one English character this does not hold for, and that is
 * deliberate: an emoji really is several tokens, so `\p{Extended_Pictographic}`
 * — `©` and `™` with it — stays dense. One token per dense character is the
 * central value across the scripts above rather than a measurement of any one
 * of them.
 */
const COST_ESTIMATE_TOKEN_WEIGHTS = { latinCharsPerToken: 4, denseCharsPerToken: 1 } satisfies ScriptTokenWeights;

/**
 * The same estimate for a stream that has only been *counted*, not kept.
 *
 * Deliberately still flat: there is no text left to classify, so this is the
 * Latin reading and therefore a floor rather than a guess. `generateText` and
 * `generateJson` (`loggedAdapters.ts`) persist `Math.max` of this and
 * {@link estimateTokenCountFromText} over the whole reply, so the floor never
 * lowers a stored number — it covers the live in-flight display, and the case
 * where the accumulated stream ran longer than the text the adapter handed
 * back. The one place it *is* the whole answer is
 * {@link settleLiveTextUsageEstimate}, which only `streamText` reaches, and
 * nothing in this repo calls `streamText`.
 */
export function estimateTokenCountFromTextLength(length: number): number {
  if (!Number.isFinite(length) || length <= 0) {
    return 0;
  }
  return Math.max(1, Math.ceil(length / 4));
}

export function durationBetweenTimestamps(start: string, end: string): number | null {
  const startedAt = Date.parse(start);
  const finishedAt = Date.parse(end);
  if (!Number.isFinite(startedAt) || !Number.isFinite(finishedAt) || finishedAt < startedAt) {
    return null;
  }
  return Math.round(finishedAt - startedAt);
}
