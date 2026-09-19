import { randomUUID } from "node:crypto";
import { createDecisionModelRoute, type DecisionAttempt, type DecisionEvaluationAttempt, type DecisionEvaluationRequest, type DecisionRequest, type DecisionModelRoute, type CreateProjectInput, type EmbeddingAdapter } from "@book-maker/core";
import { config } from "../runtime/config.js";
import { assertJobNotStopped, hasStoppedGenerationJob } from "../runtime/jobLifecycle.js";
import { serializeError } from "../runtime/serialization.js";
import type { WorkerRuntimeJob } from "../runtime/jobPayloads.js";
import { loadLiveGenerationTextRouting } from "./generationTextRouting.js";
import { withProjectDecisionSources } from "./sourceContext.js";
import { beginLiveTextUsage, providerUsageFromError, recordProviderUsage } from "./usageAccounting.js";
import { createRunLogger } from "./runLogging.js";

/** Decision attempts already own retries; never wrap them in the text logger. */
export function createLoggedDecisions(job: WorkerRuntimeJob, input?: CreateProjectInput, embedding?: EmbeddingAdapter): DecisionModelRoute {
  const logger = createRunLogger(job);
  const { projectId, generationJobId } = job.data;
  const onAttempt = async (attempt: DecisionAttempt | DecisionEvaluationAttempt) => {
      const callId = randomUUID();
      try {
        const { signal: _signal, ...request } = attempt.request;
        await logger.append("decision.choose.attempt", {
          callId,
          request,
          selection: attempt.selection,
          role: attempt.role,
          durationMs: attempt.durationMs,
          ...(attempt.result ? { result: attempt.result } : {}),
          ...(attempt.escalationReason ? { escalationReason: attempt.escalationReason } : {}),
          ...(attempt.error ? { error: serializeError(attempt.error) } : {})
        });
      } catch { /* A diagnostic write must not skip costing. */ }
      try {
        await recordDecisionAttempt(attempt, { callId, projectId, generationJobId });
      } catch { /* Costing must not retry or discard a completed choice. */ }
    };
  const route = withProjectDecisionSources(createDecisionModelRoute(config, {
    loadRouting: loadLiveGenerationTextRouting(logger),
    onAttempt, onEvaluationAttempt: onAttempt
  }), input, projectId, embedding);
  return {
    async recordOutcome(outcome) {
      try { await logger.append("decision.gate.outcome", { ...outcome }); }
      catch { /* A diagnostic write cannot change generation. */ }
    },
    async resolve() {
      await assertJobNotStopped(generationJobId);
      const adapter = await route.resolve();
      if (!adapter) return undefined;
      const invoke = async <T extends DecisionRequest | DecisionEvaluationRequest, R>(request: T, call: (request: T) => Promise<R>): Promise<R> => {
        await assertJobNotStopped(generationJobId);
        const controller = new AbortController();
        const abort = () => controller.abort(request.signal?.reason);
        if (request.signal?.aborted) abort();
        request.signal?.addEventListener("abort", abort, { once: true });
        const poll = generationJobId ? setInterval(() => {
          void hasStoppedGenerationJob(generationJobId).then((stopped) => { if (stopped) controller.abort(); }).catch(() => {});
        }, 2500) : undefined;
        try {
          return await call({ ...request, signal: controller.signal });
        } finally {
          if (poll) clearInterval(poll);
          request.signal?.removeEventListener("abort", abort);
          await assertJobNotStopped(generationJobId);
        }
      };
      return {
        choose: (request) => invoke(request, (value) => adapter.choose(value)),
        ...(adapter.evaluate ? { evaluate: (request: DecisionEvaluationRequest) => invoke(request, (value) => adapter.evaluate!(value)) } : {})
      };
    }
  };
}

export async function recordDecisionAttempt(attempt: DecisionAttempt | DecisionEvaluationAttempt, ids: { callId: string; projectId: string | undefined; generationJobId: string | undefined }) {
  const result = attempt.result ?? providerUsageFromError(attempt.error);
  const identity = result ?? attempt.selection;
  // Open then settle one row even when an unsuccessful provider reports no usage.
  const live = await beginLiveTextUsage({
    ...ids, ...identity, purpose: attempt.request.purpose, operation: "decision.choose",
    startedAt: new Date(Date.now() - attempt.durationMs).toISOString(),
    options: { messages: [] }
  });
  await recordProviderUsage({
    ...ids, provider: identity.provider, model: identity.model,
    purpose: attempt.request.purpose, operation: "decision.choose", durationMs: attempt.durationMs,
    usage: result?.usage, liveUsageId: live?.id,
    ...(attempt.error ? { providerCallError: attempt.error } : {}),
    decisionMetadata: {
      role: attempt.role,
      ...(attempt.result && "selectedOption" in attempt.result ? { selectedOption: attempt.result.selectedOption } : {}),
      ...(attempt.result && "answers" in attempt.result ? { answers: attempt.result.answers } : {}),
      ...(attempt.result && "probabilities" in attempt.result && attempt.result.probabilities ? { probabilities: attempt.result.probabilities } : {}),
      ...(attempt.escalationReason ? { escalationReason: attempt.escalationReason } : {})
    }
  });
}
