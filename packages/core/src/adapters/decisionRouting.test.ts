import { describe, expect, it, vi } from "vitest";
import { loadConfig } from "../config.js";
import { FakeDecisionAdapter, type DecisionRequest, type DecisionResult } from "./decisions.js";
import { createDecisionModelRoute, decisionEscalationReason, FallbackDecisionAdapter, type DecisionAttempt } from "./decisionRouting.js";
import { compiledGenerationTextModelRouting, JEV_SELECTION, resolveGenerationTextModelRouting } from "./generationTextModelRouting.js";
import { ProviderHttpError } from "./retry.js";

const request: DecisionRequest = { purpose: "test-choice", context: "Full source and candidate context", instructions: "Choose the stronger option", options: [{ id: "a", description: "A" }, { id: "b", description: "B" }] };
const llm = { provider: "deepseek", model: "deepseek-v4-flash" } as const;
const answer = (probability = 0.8): DecisionResult => ({ ...JEV_SELECTION, selectedOption: "a", probabilities: { a: probability, b: 1 - probability }, usage: { promptTokens: 1000, outputTokens: 0 } });

describe("decision escalation policy", () => {
  it.each([0.70, 0.9, 1])("accepts winning probability %s", (probability) => {
    expect(decisionEscalationReason(request, answer(probability), true)).toBeUndefined();
  });
  it("escalates below the boundary without rounding up", () => {
    expect(decisionEscalationReason(request, answer(0.699999), true)).toBe("low_probability");
  });
  it.each([undefined, {}, { a: 0.8 }, { a: 0.8, b: 0.2, c: 0 }, { a: NaN, b: 0.2 }, { a: Infinity, b: 0 }, { a: 1.1, b: -0.1 }, { a: 0.7, b: 0.7 }, { a: 0.2, b: 0.8 }])("rejects an invalid distribution %j", (probabilities) => {
    expect(decisionEscalationReason(request, { ...answer(), probabilities }, true)).toBe("invalid_probabilities");
  });
  it("rejects invented option IDs and does not require probabilities from an LLM", () => {
    expect(decisionEscalationReason(request, { ...answer(), selectedOption: "c" }, true)).toBe("invalid_choice");
    expect(decisionEscalationReason(request, { ...answer(), probabilities: undefined }, false)).toBeUndefined();
  });
});

describe("pinned decision routing", () => {
  const config = loadConfig({
    DEEPSEEK_API_KEY: "deepseek-key",
    DEEPINFRA_API_KEY: "deepinfra-key",
    GEMINI_API_KEY: "gemini-key",
    ALIBABA_API_KEY: "alibaba-key",
    MOCK_AI: "false"
  });
  const compiled = compiledGenerationTextModelRouting(config, []);
  it("preserves old routes and a saved Jev selection without credentials", async () => {
    expect(resolveGenerationTextModelRouting({}, compiled).fastDecisions).toBeNull();
    const stored = { models: { fastDecisions: JEV_SELECTION, fastJudgments: llm } };
    expect(resolveGenerationTextModelRouting(stored, compiled)).toMatchObject({ fastDecisions: JEV_SELECTION, fastDecisionsFallback: llm });
    const createAdapter = vi.fn(() => new FakeDecisionAdapter());
    const route = createDecisionModelRoute(config, { loadRouting: async () => compiled, createAdapter });
    expect(await route.resolve()).toBeUndefined();
    expect(createAdapter).not.toHaveBeenCalled();
  });
  it("keeps a leftover catalog primary on the original judgment calls", async () => {
    const createAdapter = vi.fn(() => new FakeDecisionAdapter());
    const route = createDecisionModelRoute(config, {
      loadRouting: async () => ({ ...compiled, fastDecisions: llm }),
      createAdapter
    });
    expect(await route.resolve()).toBeUndefined();
    expect(createAdapter).not.toHaveBeenCalled();
  });
  it("keeps a settings read failure visible", async () => {
    await expect(createDecisionModelRoute(config, { loadRouting: async () => { throw new Error("database unavailable"); } }).resolve()).rejects.toThrow("database unavailable");
  });
  it("pins both selections across retries and escalation, accounting for each physical call once", async () => {
    const events: DecisionAttempt[] = [];
    const primary = vi.fn().mockRejectedValueOnce(new ProviderHttpError("Unavailable", { status: 503 })).mockResolvedValueOnce(answer(0.6));
    const fallback = vi.fn().mockResolvedValue({ ...llm, selectedOption: "b", usage: { promptTokens: 900, outputTokens: 10 } });
    const loadRouting = vi.fn().mockResolvedValueOnce({ ...compiled, fastDecisions: JEV_SELECTION, fastDecisionsFallback: llm }).mockResolvedValue({ ...compiled, fastDecisions: null });
    const route = createDecisionModelRoute(config, { loadRouting, retry: { delayMs: 0 }, createAdapter: (selection) => ({ choose: selection.provider === JEV_SELECTION.provider ? primary : fallback }), onAttempt: async (event) => { events.push(event); } });
    const bound = await route.resolve();
    expect((await bound!.choose(request)).selectedOption).toBe("b");
    expect(loadRouting).toHaveBeenCalledTimes(1);
    expect(events.map((event) => [event.role, event.escalationReason])).toEqual([["primary", "provider_failure"], ["primary", "low_probability"], ["fallback", "low_probability"]]);
    expect(primary).toHaveBeenCalledTimes(2);
    expect(fallback).toHaveBeenCalledExactlyOnceWith(request);
    expect(events[1]?.result?.usage?.promptTokens).toBe(1000);
  });
  it.each(["missing key", "context limit", "provider outage"])("falls back on %s", async (message) => {
    const fallback = vi.fn().mockResolvedValue({ ...llm, selectedOption: "b" });
    const route = new FallbackDecisionAdapter({ primary: JEV_SELECTION, fallback: llm, gateWinningProbability: true, createAdapter: (selection) => ({ choose: selection.provider === JEV_SELECTION.provider ? async () => { throw new Error(message); } : fallback }), retry: { attempts: 1 } });
    expect((await route.choose(request)).selectedOption).toBe("b");
    expect(fallback).toHaveBeenCalledTimes(1);
  });
  it("propagates cancellation from either stage and stops before a fallback", async () => {
    for (const stage of ["primary", "fallback"]) {
      const calls: string[] = [];
      const route = new FallbackDecisionAdapter({ primary: JEV_SELECTION, fallback: llm, gateWinningProbability: true, createAdapter: (selection) => ({ async choose() {
        const role = selection.provider === JEV_SELECTION.provider ? "primary" : "fallback";
        calls.push(role);
        if (role === stage) throw new DOMException("Cancelled", "AbortError");
        return answer(0.6);
      } }), retry: { delayMs: 0 } });
      await expect(route.choose(request)).rejects.toMatchObject({ name: "AbortError" });
      expect(calls).toEqual(stage === "primary" ? ["primary"] : ["primary", "fallback"]);
    }
  });
  it("runs Jev selections in mock mode without credentials or any network", async () => {
    const route = createDecisionModelRoute({ ...config, MOCK_AI: true, VERCEL_AI_GATEWAY_API_KEY: undefined }, { loadRouting: async () => ({ ...compiled, fastDecisions: JEV_SELECTION }) });
    expect(await (await route.resolve())!.choose(request)).toMatchObject({ provider: "fake", selectedOption: "a" });
  });
  it("omits absent attempt keys on a successful primary that does not escalate", async () => {
    const events: DecisionAttempt[] = [];
    const route = new FallbackDecisionAdapter({
      primary: JEV_SELECTION, fallback: llm, gateWinningProbability: true,
      createAdapter: () => ({ choose: async () => answer() }),
      onAttempt: async (event) => { events.push(event); }
    });
    expect(await route.choose(request)).toEqual(answer());
    expect(events).toHaveLength(1);
    expect(events[0]).toEqual(expect.objectContaining({ request, selection: JEV_SELECTION, role: "primary", result: answer() }));
    expect(events[0]).toHaveProperty("durationMs");
    expect(events[0]).not.toHaveProperty("error");
    expect(events[0]).not.toHaveProperty("escalationReason");
  });
  it("records a provider-failure primary with error and escalation, omitting result", async () => {
    const events: DecisionAttempt[] = [];
    const failure = new Error("provider outage");
    const route = new FallbackDecisionAdapter({
      primary: JEV_SELECTION, fallback: llm, gateWinningProbability: true,
      createAdapter: (selection) => ({ choose: selection.provider === JEV_SELECTION.provider ? async () => { throw failure; } : async () => ({ ...llm, selectedOption: "b" }) }),
      retry: { attempts: 1 },
      onAttempt: async (event) => { events.push(event); }
    });
    expect((await route.choose(request)).selectedOption).toBe("b");
    expect(events[0]).toEqual(expect.objectContaining({ role: "primary", error: failure, escalationReason: "provider_failure" }));
    expect(events[0]).not.toHaveProperty("result");
    expect(events[1]).toEqual(expect.objectContaining({ role: "fallback", result: { ...llm, selectedOption: "b" }, escalationReason: "provider_failure" }));
    expect(events[1]).not.toHaveProperty("error");
  });
  it("never buys a fallback because a diagnostic callback throws synchronously", async () => {
    const choose = vi.fn(async () => answer());
    const route = new FallbackDecisionAdapter({ primary: JEV_SELECTION, fallback: llm, gateWinningProbability: true, createAdapter: () => ({ choose }), onAttempt: () => { throw new Error("log unavailable"); } });
    expect(await route.choose(request)).toEqual(answer());
    expect(choose).toHaveBeenCalledTimes(1);
  });
});
