import type { DecisionModelAdapter, DecisionRequest, DecisionResult } from "../adapters/decisions.js";

/**
 * The choose-or-JSON-retry fork shared by finite selections. Each caller
 * owns its request, its mapping from the choice, and its generateJson fallback.
 */
export async function decideFromCandidates<T>(options: {
  decisionModel?: DecisionModelAdapter | undefined;
  request: DecisionRequest;
  fromDecision: (result: DecisionResult) => T | Promise<T>;
  fallback: () => Promise<T>;
}): Promise<T> {
  if (options.decisionModel) {
    return options.fromDecision(await options.decisionModel.choose(options.request));
  }
  return options.fallback();
}
