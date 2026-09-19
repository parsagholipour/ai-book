import type { DecisionModelRoute, DecisionOutcome, DecisionRequest, DecisionResult } from "../adapters/decisions.js";
import { DecisionEscalationError, decisionEscalationReason } from "../adapters/decisionRouting.js";
import { isCancellationError } from "../adapters/retry.js";

/** Shared screen transport; each gate owns its context, rubric and pass choice. */
export async function passesDecisionScreen(options: {
  decisions?: DecisionModelRoute | undefined;
  request: DecisionRequest;
  version: string;
  pageIndex?: number | undefined;
  passChoice: string;
  avoided: "rewriteAvoided" | "auditAvoided" | "verificationAvoided";
}): Promise<boolean> {
  const { decisions, avoided } = options;
  const request = { ...options.request, escalationPolicy: "caller" as const };
  const { signal } = request;
  signal?.throwIfAborted();
  const outcome: DecisionOutcome = {
    purpose: request.purpose, version: options.version, pageIndex: options.pageIndex,
    rewriteAvoided: false, [avoided]: false
  };
  let routeResolved = false;
  try {
    const model = await decisions?.resolve();
    routeResolved = true;
    signal?.throwIfAborted();
    if (!model) {
      outcome.escalationReason = "routing_unavailable";
      return false;
    }
    const result = await model.choose(request);
    signal?.throwIfAborted();
    recordResult(outcome, result);
    // Injected adapters must meet the same contract: a label alone is not a pass.
    const escalation = decisionEscalationReason(request, result, true);
    const reason = escalation ?? (result.selectedOption !== options.passChoice ? result.selectedOption : undefined);
    if (reason) outcome.escalationReason = reason;
    outcome[avoided] = !escalation && result.selectedOption === options.passChoice;
    return outcome[avoided];
  } catch (error) {
    if (signal?.aborted || isCancellationError(error)) {
      outcome.escalationReason = "cancelled";
      outcome[avoided] = false;
    }
    signal?.throwIfAborted();
    if (isCancellationError(error)) throw error;
    outcome.escalationReason = error instanceof DecisionEscalationError
      ? error.reason : routeResolved ? "provider_failure" : "routing_unavailable";
    if (error instanceof DecisionEscalationError && error.result) recordResult(outcome, error.result);
    return false;
  } finally {
    await recordScreenOutcome(decisions, outcome);
    signal?.throwIfAborted();
  }
}

async function recordScreenOutcome(decisions: DecisionModelRoute | undefined, outcome: DecisionOutcome): Promise<void> {
  try { await decisions?.recordOutcome?.(outcome); }
  catch (error) {
    if (isCancellationError(error)) throw error;
    /* Diagnostics never alter the verdict or buy another paid call. */
  }
}

function recordResult(outcome: DecisionOutcome, result: DecisionResult): void {
  outcome.selectedOption = result.selectedOption;
  outcome.probabilities = result.probabilities;
}
