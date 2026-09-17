import type { Usage } from "./types.js";

/** A finite choice is a separate capability from producing prose. */
export type DecisionRequest = {
  context: string;
  instructions: string;
  options: readonly { id: string; description: string }[];
  purpose: string;
  signal?: AbortSignal | undefined;
};

export type DecisionResult = {
  selectedOption: string;
  provider: string;
  model: string;
  usage?: Usage | undefined;
  probabilities?: Record<string, number> | undefined;
  explanation?: string | undefined;
};

export interface DecisionModelAdapter {
  choose(request: DecisionRequest): Promise<DecisionResult>;
}

/** Resolve before a caller's terminal fallback; a settings outage is not a verdict. */
export interface DecisionModelRoute {
  resolve(): Promise<DecisionModelAdapter | undefined>;
}

export function assertDecisionRequest(request: DecisionRequest): void {
  request.signal?.throwIfAborted();
  const ids = request.options.map((option) => option.id);
  if (!ids.length || ids.some((id) => !id.trim()) || new Set(ids).size !== ids.length) {
    throw new Error("A decision requires unique, nonempty option IDs.");
  }
}

export function decisionMessages(request: DecisionRequest) {
  return [
    { role: "system" as const, content: request.instructions },
    { role: "user" as const, content: JSON.stringify({ context: request.context, options: request.options }) }
  ];
}

/** Retain billed usage even when a provider's answer fails validation. */
export class InvalidDecisionError extends Error {
  constructor(message: string, readonly result: DecisionResult) {
    super(message);
    this.name = "InvalidDecisionError";
  }
}

export function validateDecisionChoice(request: DecisionRequest, result: DecisionResult): DecisionResult {
  if (!request.options.some((option) => option.id === result.selectedOption)) {
    throw new InvalidDecisionError("Provider returned an unknown decision option.", result);
  }
  return result;
}

export class FakeDecisionAdapter implements DecisionModelAdapter {
  async choose(request: DecisionRequest): Promise<DecisionResult> {
    assertDecisionRequest(request);
    return { selectedOption: request.options[0]!.id, provider: "fake", model: "fake-decision", usage: { promptTokens: 0, outputTokens: 0 } };
  }
}
