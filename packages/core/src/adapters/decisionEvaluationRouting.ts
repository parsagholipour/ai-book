import type { DecisionModelAdapter } from "./decisions.js";
import { assertDecisionEvaluationRequest, DecisionEvaluationEscalationError, evaluationEscalationReason, InvalidDecisionEvaluationError, validateDecisionEvaluation, type DecisionEvaluationRequest, type DecisionEvaluationResult } from "./decisionEvaluation.js";
import type { DecisionEscalationReason } from "./decisionRouting.js";
import type { DecisionModelSelection } from "./generationTextModelRouting.js";
import { isCancellationError, isRecoverableNetworkError, withRecoverableNetworkRetry, type RecoverableRetryOptions } from "./retry.js";

export type DecisionEvaluationAttempt = {
  request: DecisionEvaluationRequest;
  selection: DecisionModelSelection;
  role: "primary" | "fallback";
  durationMs: number;
  result?: DecisionEvaluationResult | undefined;
  error?: unknown;
  escalationReason?: DecisionEscalationReason | undefined;
};
export type EvaluationRoutingOptions = {
  primary: DecisionModelSelection;
  fallback: DecisionModelSelection;
  createAdapter: (selection: DecisionModelSelection) => DecisionModelAdapter;
  gateWinningProbability: boolean;
  onEvaluationAttempt?: ((attempt: DecisionEvaluationAttempt) => Promise<void>) | undefined;
  retry?: RecoverableRetryOptions | undefined;
};

/** Exactly one fallback stage; every network attempt has its own accounting event. */
export async function evaluateWithFallback(options: EvaluationRoutingOptions, request: DecisionEvaluationRequest): Promise<DecisionEvaluationResult> {
  assertDecisionEvaluationRequest(request);
  const run = (role: "primary" | "fallback", escalationReason?: DecisionEscalationReason) => withRecoverableNetworkRetry(async () => {
    request.signal?.throwIfAborted();
    const started = Date.now();
    let result: DecisionEvaluationResult | undefined;
    let error: unknown;
    try {
      const adapter = options.createAdapter(options[role]);
      if (!adapter.evaluate) throw new Error("Adapter does not support typed evaluations.");
      result = await adapter.evaluate(request);
      request.signal?.throwIfAborted();
      return validateDecisionEvaluation(request, result);
    } catch (caught) {
      error = caught;
      if (caught instanceof InvalidDecisionEvaluationError) result = caught.result;
      throw caught;
    } finally {
      const reason = role === "fallback" ? escalationReason : result
        ? evaluationEscalationReason(request, result, options.gateWinningProbability)
        : error && !isCancellationError(error) ? "provider_failure" : undefined;
      try { await options.onEvaluationAttempt?.({ request, selection: options[role], role, durationMs: Date.now() - started, result, error, escalationReason: reason }); }
      catch { /* Diagnostics cannot cause another physical call. */ }
    }
  }, { ...options.retry, shouldRetry: (error) => !request.signal?.aborted && !isCancellationError(error) && !(error instanceof InvalidDecisionEvaluationError) &&
    (options.retry?.shouldRetry ?? isRecoverableNetworkError)(error) });

  let reason: DecisionEscalationReason;
  let result: DecisionEvaluationResult | undefined;
  try {
    result = await run("primary");
    const escalation = evaluationEscalationReason(request, result, options.gateWinningProbability);
    if (!escalation) return result;
    reason = escalation;
  } catch (error) {
    request.signal?.throwIfAborted();
    if (isCancellationError(error)) throw error;
    if (error instanceof InvalidDecisionEvaluationError) result = error.result;
    reason = result ? evaluationEscalationReason(request, result, options.gateWinningProbability) ?? "provider_failure" : "provider_failure";
  }
  if (request.escalationPolicy === "caller") throw new DecisionEvaluationEscalationError(reason, result);
  return run("fallback", reason);
}
