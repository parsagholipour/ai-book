import type { DecisionEvaluationRequest, DecisionEvaluationResult } from "./decisionEvaluation.js";
import type { Usage } from "./types.js";

/** A finite choice is a separate capability from producing prose. */
export type DecisionRequest = {
  context: string;
  instructions: string;
  options: readonly { id: string; description: string }[];
  purpose: string;
  /** Screens can escalate directly to their existing diagnostic/rewrite path. */
  escalationPolicy?: "caller" | undefined;
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
  evaluate?(request: DecisionEvaluationRequest): Promise<DecisionEvaluationResult>;
}

/** Resolve before a caller's terminal fallback; a settings outage is not a verdict. */
export interface DecisionModelRoute {
  resolve(): Promise<DecisionModelAdapter | undefined>;
  /** Best-effort logical outcome, separate from billed physical attempts. */
  recordOutcome?(outcome: DecisionOutcome): Promise<void>;
}

export type DecisionOutcome = {
  purpose: string;
  version: string;
  pageIndex?: number | undefined;
  selectedOption?: string | undefined;
  probabilities?: Record<string, number> | undefined;
  escalationReason?: string | undefined;
  rewriteAvoided: boolean;
  reviewAvoided?: boolean | undefined;
  wouldAvoidReview?: boolean | undefined;
  mode?: "off" | "shadow" | "pass" | undefined;
  answers?: DecisionEvaluationResult["answers"] | undefined;
  screenDurationMs?: number | undefined;
  totalDurationMs?: number | undefined;
  diagnosticApproved?: boolean | undefined;
  disagreement?: boolean | undefined;
  /** A style screen skipped the diagnostic audit, not the ordinary page review. */
  auditAvoided?: boolean | undefined;
};

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
  async evaluate(request: DecisionEvaluationRequest): Promise<DecisionEvaluationResult> {
    const { assertDecisionEvaluationRequest } = await import("./decisionEvaluation.js");
    assertDecisionEvaluationRequest(request);
    return { provider: "fake", model: "fake-decision", usage: { promptTokens: 0, outputTokens: 0 }, answers: Object.fromEntries(request.questions.map((question) => [question.id,
      question.type === "choice" ? { type: "choice" as const, selectedOption: question.options[0]!.id, probabilities: Object.fromEntries(question.options.map((option, index) => [option.id, index === 0 ? 1 : 0])) }
        : question.type === "boolean" ? { type: "boolean" as const, probability: 1 }
        : { type: "score" as const, score: 0, probabilities: Object.fromEntries(question.levels.map((_, index) => [String(index), index === 0 ? 1 : 0])) }
    ])) };
  }

  async choose(request: DecisionRequest): Promise<DecisionResult> {
    assertDecisionRequest(request);
    return { selectedOption: request.options[0]!.id, provider: "fake", model: "fake-decision", usage: { promptTokens: 0, outputTokens: 0 } };
  }
}
