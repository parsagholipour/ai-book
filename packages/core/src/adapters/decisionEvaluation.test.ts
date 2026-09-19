import { describe, expect, it, vi } from "vitest";
import { FakeDecisionAdapter } from "./decisions.js";
import { assertDecisionEvaluationRequest, evaluationEscalationReason, type DecisionEvaluationRequest, type DecisionEvaluationResult } from "./decisionEvaluation.js";
import { FallbackDecisionAdapter } from "./decisionRouting.js";
import { JEV_SELECTION } from "./generationTextModelRouting.js";
import { JevDecisionAdapter } from "./jevDecision.js";
import { LlmDecisionAdapter } from "./llmDecision.js";
import { FakeTextModelAdapter } from "./fake.js";
import { ProviderHttpError } from "./retry.js";

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
const fallback = { provider: "deepseek", model: "deepseek-v4-flash" } as const;

describe("typed decisions", () => {
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
  it("separates low probability from malformed output and accepts LLM choices without probabilities", () => {
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
  it("uses one typed LLM call with schema validation for the entire batch", async () => {
    const text = new FakeTextModelAdapter();
    const generate = vi.spyOn(text, "generateJson").mockImplementation(async (options) => ({ data: options.schema.parse({ answers: answer().answers }), text: "", provider: "test", model: "test" }));
    const result = await new LlmDecisionAdapter(text).evaluate(request);
    expect(result.answers.third).toEqual({ type: "score", score: 0.9 });
    expect(generate).toHaveBeenCalledTimes(1);
  });
});

describe("typed routing", () => {
  it("accounts for two physical network attempts and one fallback, never one call per question", async () => {
    const events = vi.fn(async () => {});
    const primary = vi.fn().mockRejectedValue(new ProviderHttpError("busy", { status: 503 }));
    const llm = vi.fn(async () => answer());
    const route = new FallbackDecisionAdapter({ primary: JEV_SELECTION, fallback, gateWinningProbability: true,
      createAdapter: (selection) => ({ choose: new FakeDecisionAdapter().choose, evaluate: selection.provider === JEV_SELECTION.provider ? primary : llm }),
      onEvaluationAttempt: events, retry: { attempts: 2, delayMs: 0 }
    });
    await route.evaluate(request);
    expect(primary).toHaveBeenCalledTimes(2);
    expect(llm).toHaveBeenCalledTimes(1);
    expect(events).toHaveBeenCalledTimes(3);
  });
  it("screens escalate to their caller without a generic LLM and retain answers", async () => {
    const result = answer(); result.answers.second = { type: "boolean", probability: 0.6 };
    const create = vi.fn(() => ({ choose: new FakeDecisionAdapter().choose, evaluate: async () => result }));
    const route = new FallbackDecisionAdapter({ primary: JEV_SELECTION, fallback, gateWinningProbability: true, createAdapter: create });
    await expect(route.evaluate({ ...request, escalationPolicy: "caller" })).rejects.toMatchObject({ reason: "low_probability", result });
    expect(create).toHaveBeenCalledTimes(1);
  });
  it("cancellation after a paid result escapes with one accounted attempt and no fallback", async () => {
    const controller = new AbortController();
    const events = vi.fn(async () => { throw new Error("logging unavailable"); });
    const create = vi.fn(() => ({ choose: new FakeDecisionAdapter().choose, evaluate: async () => { controller.abort(); return answer(); } }));
    const route = new FallbackDecisionAdapter({ primary: JEV_SELECTION, fallback, gateWinningProbability: true, createAdapter: create, onEvaluationAttempt: events });
    await expect(route.evaluate({ ...request, signal: controller.signal })).rejects.toMatchObject({ name: "AbortError" });
    expect(create).toHaveBeenCalledTimes(1); expect(events).toHaveBeenCalledTimes(1);
  });
  it("logging failure cannot buy a fallback or discard a successful batch", async () => {
    const create = vi.fn(() => new FakeDecisionAdapter());
    const route = new FallbackDecisionAdapter({ primary: JEV_SELECTION, fallback, gateWinningProbability: true, createAdapter: create, onEvaluationAttempt: async () => { throw new Error("offline"); } });
    expect((await route.evaluate(request)).answers).toBeDefined();
    expect(create).toHaveBeenCalledTimes(1);
  });
});
