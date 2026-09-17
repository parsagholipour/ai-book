import type { AppConfig } from "../config.js";
import { createTextModelAdapter } from "./factory.js";
import { FakeDecisionAdapter, InvalidDecisionError, assertDecisionRequest, validateDecisionChoice, type DecisionModelAdapter, type DecisionModelRoute, type DecisionRequest, type DecisionResult } from "./decisions.js";
import { isJevSelection, JEV_SELECTION, type DecisionModelSelection, type GenerationTextModelRouting } from "./generationTextModelRouting.js";
import { JevDecisionAdapter } from "./jevDecision.js";
import { LlmDecisionAdapter } from "./llmDecision.js";
import { isCancellationError, isRecoverableNetworkError, withRecoverableNetworkRetry, type RecoverableRetryOptions } from "./retry.js";

/** Initial escalation policy, not a calibrated accuracy/confidence guarantee. */
export const DECISION_MIN_WINNING_PROBABILITY = 0.70;
export type DecisionEscalationReason = "invalid_choice" | "invalid_probabilities" | "low_probability" | "provider_failure";

export function decisionEscalationReason(request: DecisionRequest, result: DecisionResult, gateWinningProbability: boolean): DecisionEscalationReason | undefined {
  if (!request.options.some((option) => option.id === result.selectedOption)) return "invalid_choice";
  if (!gateWinningProbability) return undefined;
  const distribution = result.probabilities;
  const ids = request.options.map((option) => option.id);
  if (!distribution || Object.keys(distribution).length !== ids.length || ids.some((id) =>
    !Object.hasOwn(distribution, id) || !Number.isFinite(distribution[id]) || distribution[id]! < 0 || distribution[id]! > 1
  )) return "invalid_probabilities";
  const values = Object.values(distribution);
  const winner = distribution[result.selectedOption]!;
  if (Math.abs(values.reduce((sum, value) => sum + value, 0) - 1) > 0.001 || values.some((value) => value > winner)) return "invalid_probabilities";
  return winner < DECISION_MIN_WINNING_PROBABILITY ? "low_probability" : undefined;
}

export type DecisionAttempt = {
  request: DecisionRequest;
  selection: DecisionModelSelection;
  role: "primary" | "fallback";
  durationMs: number;
  result?: DecisionResult | undefined;
  error?: unknown;
  escalationReason?: DecisionEscalationReason | undefined;
};

export type DecisionRoutingOptions = {
  loadRouting: () => Promise<GenerationTextModelRouting>;
  createAdapter?: (selection: DecisionModelSelection) => DecisionModelAdapter;
  onAttempt?: (attempt: DecisionAttempt) => Promise<void>;
  retry?: RecoverableRetryOptions;
};

export function createDecisionModelAdapter(config: AppConfig, selection: DecisionModelSelection): DecisionModelAdapter {
  if (config.MOCK_AI) return new FakeDecisionAdapter();
  return isJevSelection(selection)
    ? new JevDecisionAdapter(config.VERCEL_AI_GATEWAY_API_KEY)
    : new LlmDecisionAdapter(createTextModelAdapter(config, selection, { maxRetries: 0 }));
}

/** Each resolve pins both selections; no reread in retries, fallback, or reversed chapter comparisons. */
export function createDecisionModelRoute(config: AppConfig, options: DecisionRoutingOptions): DecisionModelRoute {
  return {
    async resolve() {
      const routing = await options.loadRouting();
      if (!isJevSelection(routing.fastDecisions)) return undefined;
      return new FallbackDecisionAdapter({
        primary: { ...routing.fastDecisions },
        fallback: { ...(routing.fastDecisionsFallback ?? routing.fastJudgments) },
        createAdapter: options.createAdapter ?? ((selection) => createDecisionModelAdapter(config, selection)),
        ...(options.onAttempt ? { onAttempt: options.onAttempt } : {}),
        ...(options.retry ? { retry: options.retry } : {}),
        gateWinningProbability: !config.MOCK_AI && isJevSelection(routing.fastDecisions)
      });
    }
  };
}

export class FallbackDecisionAdapter implements DecisionModelAdapter {
  constructor(private readonly options: {
    primary: DecisionModelSelection;
    fallback: Exclude<DecisionModelSelection, typeof JEV_SELECTION>;
    gateWinningProbability: boolean;
    createAdapter: (selection: DecisionModelSelection) => DecisionModelAdapter;
    onAttempt?: (attempt: DecisionAttempt) => Promise<void>;
    retry?: RecoverableRetryOptions;
  }) {}

  async choose(request: DecisionRequest): Promise<DecisionResult> {
    assertDecisionRequest(request);
    let escalation: DecisionEscalationReason | undefined;
    try {
      const result = await this.run(request, "primary");
      escalation = decisionEscalationReason(request, result, this.options.gateWinningProbability);
      if (!escalation) return result;
    } catch (error) {
      request.signal?.throwIfAborted();
      if (isCancellationError(error)) throw error;
      escalation = error instanceof InvalidDecisionError
        ? decisionEscalationReason(request, error.result, this.options.gateWinningProbability) ?? "provider_failure"
        : "provider_failure";
    }
    // Exactly one fallback stage, with its own bounded physical network attempts.
    return this.run(request, "fallback", escalation);
  }

  private run(request: DecisionRequest, role: "primary" | "fallback", escalationReason?: DecisionEscalationReason): Promise<DecisionResult> {
    const selection = this.options[role];
    return withRecoverableNetworkRetry(async () => {
      request.signal?.throwIfAborted();
      const started = Date.now();
      let result: DecisionResult | undefined;
      let error: unknown;
      try {
        result = await this.options.createAdapter(selection).choose(request);
        request.signal?.throwIfAborted();
        return validateDecisionChoice(request, result);
      } catch (caught) {
        error = caught;
        if (caught instanceof InvalidDecisionError) result = caught.result;
        throw caught;
      } finally {
        const reason = role === "fallback" ? escalationReason : result
          ? decisionEscalationReason(request, result, this.options.gateWinningProbability)
          : error && !isCancellationError(error) ? "provider_failure" : undefined;
        // A diagnostic write must never cause another paid call.
        try {
          await this.options.onAttempt?.({
            request, selection, role, durationMs: Date.now() - started,
            ...(result ? { result } : {}),
            ...(error ? { error } : {}),
            ...(reason ? { escalationReason: reason } : {})
          });
        } catch { /* Observability must not retry or discard a completed choice. */ }
      }
    }, {
      ...this.options.retry,
      shouldRetry: (error) => !request.signal?.aborted && !isCancellationError(error) && !(error instanceof InvalidDecisionError) &&
        (this.options.retry?.shouldRetry ?? isRecoverableNetworkError)(error)
    });
  }
}
