import type { Usage } from "./types.js";
import { assertDecisionRequest } from "./decisions.js";
import { DECISION_MIN_WINNING_PROBABILITY, decisionEscalationReason, type DecisionEscalationReason } from "./decisionRouting.js";

/** Stable question IDs share one evidence context and one physical evaluation. */
export type DecisionQuestion = { id: string; instructions: string } & (
  | { type: "choice"; options: readonly { id: string; description: string }[] }
  | { type: "boolean" }
  | { type: "score"; levels: readonly string[] }
);
export type DecisionAnswer =
  | { type: "choice"; selectedOption: string; probabilities?: Record<string, number> | undefined }
  | { type: "boolean"; probability: number }
  | { type: "score"; score: number; probabilities?: Record<string, number> | undefined };
export type DecisionEvaluationRequest = {
  context: string;
  questions: readonly DecisionQuestion[];
  purpose: string;
  escalationPolicy?: "caller" | undefined;
  signal?: AbortSignal | undefined;
  /** Evidence was prepared by the authorized text source wrapper for this review. */
  sourceContextPrepared?: boolean | undefined;
};
export type DecisionEvaluationResult = {
  answers: Record<string, DecisionAnswer>;
  provider: string;
  model: string;
  usage?: Usage | undefined;
};
export class InvalidDecisionEvaluationError extends Error {
  constructor(message: string, readonly result: DecisionEvaluationResult) {
    super(message);
    this.name = "InvalidDecisionEvaluationError";
  }
}
export class DecisionEvaluationEscalationError extends Error {
  constructor(readonly reason: DecisionEscalationReason, readonly result?: DecisionEvaluationResult) {
    super(`Evaluation requires caller review: ${reason}`);
    this.name = "DecisionEvaluationEscalationError";
  }
}
export function assertDecisionEvaluationRequest(request: DecisionEvaluationRequest): void {
  request.signal?.throwIfAborted();
  const ids = request.questions.map((q) => q.id);
  if (!ids.length || ids.some((id) => !/^[a-z][a-z0-9_]*$/.test(id)) || new Set(ids).size !== ids.length) {
    throw new Error("Evaluation requires unique, stable question IDs.");
  }
  for (const question of request.questions) {
    if (!question.instructions.trim()) throw new Error("Question instructions are required.");
    if (question.type === "choice") assertDecisionRequest({ ...request, ...question });
    else if (question.type === "score") {
      if (question.levels.length < 2 || question.levels.some((level) => !level.trim())) throw new Error("Score questions require at least two described levels.");
    } else if (question.type !== "boolean") throw new Error("Unknown question type.");
  }
}
const probability = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;

/** Check every ID, type, value and supplied distribution, including LLM answers. */
export function evaluationEscalationReason(request: DecisionEvaluationRequest, result: DecisionEvaluationResult, gate: boolean): DecisionEscalationReason | undefined {
  if (!result.answers || Array.isArray(result.answers) || typeof result.answers !== "object" ||
      Object.keys(result.answers).length !== request.questions.length) return "invalid_choice";
  let uncertainty: DecisionEscalationReason | undefined;
  for (const question of request.questions) {
    const answer = Object.hasOwn(result.answers, question.id) ? result.answers[question.id] : undefined;
    if (!answer || answer.type !== question.type) return "invalid_choice";
    if (question.type === "boolean" && answer.type === "boolean") {
      if (!probability(answer.probability)) return "invalid_probabilities";
      if (gate && Math.max(answer.probability, 1 - answer.probability) < DECISION_MIN_WINNING_PROBABILITY) uncertainty = "low_probability";
      continue;
    }
    if (question.type === "score" && answer.type === "score") {
      if (!Number.isFinite(answer.score) || answer.score < 0 || answer.score > question.levels.length - 1) return "invalid_choice";
      const distribution = answer.probabilities;
      if (gate && !distribution) return "invalid_probabilities";
      if (distribution) {
        const ids = question.levels.map((_, index) => String(index));
        if (Object.keys(distribution).length !== ids.length || ids.some((id) => !Object.hasOwn(distribution, id) || !probability(distribution[id]))) return "invalid_probabilities";
        const sum = Object.values(distribution).reduce((total, value) => total + value, 0);
        const mean = ids.reduce((total, id) => total + Number(id) * distribution[id]!, 0);
        if (Math.abs(sum - 1) > 0.001 || Math.abs(mean - answer.score) > 0.001) return "invalid_probabilities";
        if (gate && Math.max(...Object.values(distribution)) < DECISION_MIN_WINNING_PROBABILITY) uncertainty = "low_probability";
      }
      continue;
    }
    const options = question.type === "choice" ? question.options : [];
    if (answer.type !== "choice") return "invalid_choice";
    const selectedOption = answer.selectedOption;
    const reason = decisionEscalationReason({ ...request, instructions: question.instructions, options },
      { ...result, selectedOption, probabilities: answer.probabilities }, gate || answer.probabilities !== undefined);
    if (reason && reason !== "low_probability") return reason;
    if (gate && reason) uncertainty = reason;
  }
  return uncertainty;
}
export function validateDecisionEvaluation(request: DecisionEvaluationRequest, result: DecisionEvaluationResult): DecisionEvaluationResult {
  const reason = evaluationEscalationReason(request, result, false);
  if (reason) throw new InvalidDecisionEvaluationError(reason, result);
  return result;
}
