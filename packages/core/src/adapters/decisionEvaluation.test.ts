import { describe, expect, it, vi } from "vitest";
import { assertDecisionEvaluationRequest, evaluationEscalationReason, type DecisionEvaluationRequest, type DecisionEvaluationResult } from "./decisionEvaluation.js";
import { JEV_SELECTION } from "./generationTextModelRouting.js";
import { JevDecisionAdapter } from "./jevDecision.js";

const request: DecisionEvaluationRequest = { context: "Shared evidence", purpose: "test-batch", questions: [
  { id: "first", type: "choice", instructions: "Judge first", options: [{ id: "clean", description: "Clean" }, { id: "defect", description: "Defect" }] },
  { id: "second", type: "boolean", instructions: "Is it supported?" },
  { id: "third", type: "score", instructions: "Choose the level", levels: ["absent", "present"] }
] };
const answer = (): DecisionEvaluationResult => ({ ...JEV_SELECTION, usage: { promptTokens: 300, outputTokens: 0 }, answers: {
  first: { type: "choice", selectedOption: "clean", probabilities: { clean: 0.8, defect: 0.2 } },
  second: { type: "boolean", probability: 0.9 },
  third: { type: "score", score: 0.9, probabilities: { "0": 0.1, "1": 0.9 } }
} });

describe("the Jev wire shape", () => {
  it("sends all types over one shared Gateway state in one physical request", async () => {
    const body = { answers: { ...answer().answers, first: { type: "choice", choice: "clean", probabilities: { clean: 0.8, defect: 0.2 } } }, usage: { inputTokens: 300, outputTokens: 0 } };
    const fetch = vi.fn<typeof globalThis.fetch>(async () => Response.json(body));
    const result = await new JevDecisionAdapter("key", fetch).evaluate(request);
    expect(evaluationEscalationReason(request, result, true)).toBeUndefined();
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(fetch.mock.calls[0]![1]?.body))).toMatchObject({ state: "Shared evidence", questions: { first: { type: "choice" }, second: { type: "boolean" }, third: { type: "score", criteria: ["absent", "present"] } } });
  });
  it.each([
    (r: DecisionEvaluationResult) => { delete r.answers.third; },
    (r: DecisionEvaluationResult) => { r.answers.extra = { type: "boolean", probability: 1 }; },
    (r: DecisionEvaluationResult) => { r.answers.second = { type: "boolean", probability: NaN }; },
    (r: DecisionEvaluationResult) => { r.answers.second = { type: "score", score: 1 }; },
    (r: DecisionEvaluationResult) => { r.answers.third = { type: "score", score: 2 }; },
    (r: DecisionEvaluationResult) => { r.answers.third = { type: "score", score: 0.5, probabilities: { "0": 0.1, "1": 0.9 } }; },
    (r: DecisionEvaluationResult) => { r.answers.first = { type: "choice", selectedOption: "invented" }; },
    (r: DecisionEvaluationResult) => { r.answers.third = { type: "score", score: 1, probabilities: { "0": 0.8, "1": 0.2 } }; }
  ])("validates every answer, including non-first answers", (mutate) => {
    const result = answer(); mutate(result);
    expect(evaluationEscalationReason(request, result, true)).toBeDefined();
    expect(evaluationEscalationReason(request, result, false)).toBeDefined();
  });
  it("separates low probability from malformed output and accepts choices without probabilities when ungated", () => {
    const result = answer(); result.answers.second = { type: "boolean", probability: 0.69 };
    expect(evaluationEscalationReason(request, result, true)).toBe("low_probability");
    expect(evaluationEscalationReason(request, result, false)).toBeUndefined();
    result.answers.first = { type: "choice", selectedOption: "clean" };
    expect(evaluationEscalationReason(request, result, false)).toBeUndefined();
    expect(evaluationEscalationReason(request, result, true)).toBe("invalid_probabilities");
  });
  it("rejects duplicate question IDs before any provider call", () => {
    expect(() => assertDecisionEvaluationRequest({ ...request, questions: [request.questions[0]!, request.questions[0]!] })).toThrow("question IDs");
  });
  it("preserves usage if SDK validation fails on any answer", async () => {
    await expect(new JevDecisionAdapter("key", async () => Response.json({ answers: { first: { type: "choice", choice: "clean", probabilities: { clean: 1, defect: 0 } } }, usage: { inputTokens: 444 } })).evaluate(request))
      .rejects.toMatchObject({ result: { usage: { promptTokens: 444 } } });
  });
});
