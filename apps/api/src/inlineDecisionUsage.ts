import { calculateTextGenerationCost, type DecisionAttempt, type Usage } from "@book-maker/core";
import { prisma, type Prisma } from "@book-maker/db";
import { randomUUID } from "node:crypto";

/**
 * The API's cost row for one physical decision attempt — the twin of the
 * worker's `recordDecisionAttempt` (`apps/worker/src/providers/loggedDecisions.ts`),
 * which this app cannot import.
 *
 * A decision route calls `onAttempt` once per physical call: the Jev attempt,
 * each of its network retries, and the fallback model it escalates to. Every
 * one of them writes a row here, a failed one included, because a failed
 * attempt the provider billed is still spend the Costs tab has to see.
 *
 * The rules are `inlineProviderUsage.ts`'s, which are the worker's:
 *
 * - `generationJobId: null` and `metadata.operation: "inline"`, which is how
 *   the Operations tab recognises inline spend (`UNBILLED_INLINE`).
 * - `costHint` is priced only from token counts the provider reported. A
 *   decision has no text to estimate from, so an attempt that reported nothing
 *   writes null tokens and a null `costHint` — a non-null `costHint` *is* a
 *   settled, priced call to every admin reader (`apps/api/src/admin/CLAUDE.md`).
 * - Recording never fails the request. A logging error is written to the
 *   console and swallowed; `FallbackDecisionAdapter` swallows it too.
 */
export async function recordInlineDecisionAttempt(
  attempt: DecisionAttempt,
  /** `userId` is whose spend the attempt was, as in `InlineUsageContext`. */
  context: { projectId: string | null; userId: string | null }
): Promise<void> {
  try {
    const reported = attempt.result ?? usageCarriedByError(attempt.error);
    const identity = reported ?? attempt.selection;
    const usage = reported?.usage;
    const promptTokens = finiteTokenCount(usage?.promptTokens);
    const outputTokens = finiteTokenCount(usage?.outputTokens);
    const cacheHitTokens = finiteTokenCount(usage?.cacheHitTokens);
    const cacheWriteTokens = finiteTokenCount(usage?.cacheWriteTokens);
    const provisional = promptTokens === null || outputTokens === null;
    const costHint = provisional
      ? null
      : calculateTextGenerationCost({
          provider: identity.provider,
          model: identity.model,
          promptTokens,
          outputTokens,
          cacheHitTokens,
          cacheWriteTokens
        });
    const metadata = {
      operation: "inline",
      textOperation: "decision.choose",
      callId: randomUUID(),
      liveStatus: "settled",
      provisional,
      promptTokensEstimated: false,
      outputTokensEstimated: false,
      decision: {
        role: attempt.role,
        ...(attempt.result ? { selectedOption: attempt.result.selectedOption } : {}),
        ...(attempt.result?.probabilities ? { probabilities: attempt.result.probabilities } : {}),
        ...(attempt.escalationReason ? { escalationReason: attempt.escalationReason } : {})
      },
      ...(attempt.error ? { outcome: { error: errorSummary(attempt.error) } } : { outcome: "success" })
    } satisfies Prisma.InputJsonValue;
    await prisma.providerCallLog.create({
      data: {
        projectId: context.projectId,
        generationJobId: null,
        userId: context.userId,
        provider: identity.provider,
        model: identity.model,
        purpose: attempt.request.purpose,
        promptTokens,
        outputTokens,
        cacheHitTokens,
        cacheWriteTokens,
        costHint,
        durationMs: attempt.durationMs,
        metadata
      }
    });
  } catch (error) {
    console.error("Failed to record inline decision attempt", error);
  }
}

/** `throwWithProviderUsage` hangs a billed call's identity and usage on the error it rethrows. */
function usageCarriedByError(error: unknown): { provider: string; model: string; usage: Usage } | null {
  if (!error || typeof error !== "object") {
    return null;
  }
  const candidate = error as { provider?: unknown; model?: unknown; usage?: unknown };
  if (typeof candidate.provider !== "string" || typeof candidate.model !== "string") {
    return null;
  }
  if (!candidate.usage || typeof candidate.usage !== "object" || Array.isArray(candidate.usage)) {
    return null;
  }
  return { provider: candidate.provider, model: candidate.model, usage: candidate.usage as Usage };
}

function finiteTokenCount(value: number | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.round(value) : null;
}

function errorSummary(error: unknown): { name: string; message: string; status?: number } {
  if (error instanceof Error) {
    const status = (error as { status?: unknown }).status;
    return {
      name: error.name,
      message: error.message.slice(0, 500),
      ...(typeof status === "number" ? { status } : {})
    };
  }
  return { name: "Error", message: String(error).slice(0, 500) };
}
