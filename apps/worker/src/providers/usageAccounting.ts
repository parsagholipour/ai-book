import type { GenerateTextOptions, Usage } from "@book-maker/core";
import { calculateTextGenerationCost } from "@book-maker/core";
import { Prisma, prisma } from "@book-maker/db";
import { jsonInputValue, jsonPayloadToRecord, serializeError } from "../runtime/serialization.js";

/**
 * Provider cost and token accounting.
 *
 * Text calls open a "live" ProviderCallLog row as soon as streaming starts so
 * the UI can show spend in flight, then settle it with real usage when the
 * call finishes (or fails).
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
}) {
  const exactPromptTokens = finiteTokenCount(options.usage?.promptTokens);
  const exactOutputTokens = finiteTokenCount(options.usage?.outputTokens);
  const cacheHitTokens = finiteTokenCount(options.usage?.cacheHitTokens);
  const cacheWriteTokens = finiteTokenCount(options.usage?.cacheWriteTokens);
  const promptTokens = exactPromptTokens ?? finiteTokenCount(options.fallbackPromptTokens ?? undefined);
  const outputTokens = exactOutputTokens ?? finiteTokenCount(options.fallbackOutputTokens ?? undefined);
  if (promptTokens === null && outputTokens === null && cacheHitTokens === null && cacheWriteTokens === null) {
    if (options.liveUsageId) {
      await markLiveTextUsageFailed(options.liveUsageId, { durationMs: options.durationMs });
    }
    return;
  }
  const promptTokensEstimated = exactPromptTokens === null && promptTokens !== null;
  const outputTokensEstimated = exactOutputTokens === null && outputTokens !== null;
  const provisional = promptTokensEstimated || outputTokensEstimated;
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
    outputTokensEstimated
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
    fallbackPromptTokens: options.fallbackPromptTokens
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
          maxTokens: options.options.maxTokens ?? null
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
    "cacheWriteTokens" in value
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

export function estimateTextRequestTokens(options: GenerateTextOptions): number {
  const messageText = options.messages.map((message) => `${message.role}\n${message.content}`).join("\n\n");
  return estimateTokenCountFromText(messageText) + options.messages.length * 4 + 12;
}

export function estimateTokenCountFromText(text: string): number {
  return estimateTokenCountFromTextLength(text.length);
}

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
