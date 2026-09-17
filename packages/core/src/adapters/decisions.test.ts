import { describe, expect, it, vi } from "vitest";
import { calculateTextGenerationCost, calculateProjectCostSummary } from "../costs.js";
import { type DecisionRequest, type DecisionResult } from "./decisions.js";
import { JevDecisionAdapter } from "./jevDecision.js";
import { JEV_SELECTION } from "./generationTextModelRouting.js";
import { ProviderHttpError } from "./retry.js";

const request: DecisionRequest = { purpose: "test-choice", context: "Full source and candidate context", instructions: "Choose the stronger option", options: [{ id: "a", description: "A" }, { id: "b", description: "B" }] };
const answer = (probability = 0.8): DecisionResult => ({ ...JEV_SELECTION, selectedOption: "a", probabilities: { a: probability, b: 1 - probability }, usage: { promptTokens: 1000, outputTokens: 0 } });

describe("Jev Gateway adapter", () => {
  const gatewayFetch = (body: unknown) => vi.fn<typeof fetch>(async () => Response.json(body));
  const response = (choice = "a", probabilities: unknown = { a: 0.8, b: 0.2 }) => ({ answers: { choice: { type: "choice", choice, probabilities } }, usage: { inputTokens: 1000, outputTokens: 0 } });

  it("sends an evaluation with the explicit key, context, named options and cancellation", async () => {
    const fetch = gatewayFetch(response());
    const signal = new AbortController().signal;
    const result = await new JevDecisionAdapter("test-gateway-key", fetch).choose({ ...request, signal });
    expect(result).toEqual({ ...answer(), probabilities: { a: 0.8, b: 0.2 } });
    expect(result).not.toHaveProperty("explanation");
    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = fetch.mock.calls[0]!;
    expect(String(url)).toContain("/evaluation-model");
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer test-gateway-key");
    expect(JSON.parse(String(init?.body))).toMatchObject({ state: request.context, questions: { choice: { type: "choice", instructions: request.instructions, criteria: { a: "A", b: "B" } } } });
    expect(init?.signal).toBe(signal);
  });
  it.each([["unknown", { a: 0.8, b: 0.2 }], ["a", { a: 0.7, b: 0.7 }], ["a", { a: "bad", b: 0.2 }]])("retains paid usage for invalid output %s", async (choice, probabilities) => {
    await expect(new JevDecisionAdapter("key", gatewayFetch(response(String(choice), probabilities))).choose(request)).rejects.toMatchObject({ result: { usage: { promptTokens: 1000, outputTokens: 0 } } });
  });
  it("does not invoke the network without credentials or after cancellation", async () => {
    const fetch = gatewayFetch(response());
    await expect(new JevDecisionAdapter(undefined, fetch).choose(request)).rejects.toThrow("VERCEL_AI_GATEWAY_API_KEY");
    await expect(new JevDecisionAdapter("key", fetch).choose({ ...request, signal: AbortSignal.abort() })).rejects.toMatchObject({ name: "AbortError" });
    expect(fetch).not.toHaveBeenCalled();
  });
  it("disables hidden SDK retries", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => Response.json({ error: "Service unavailable" }, { status: 503 }));
    const error = await new JevDecisionAdapter("key", fetch).choose(request).catch((thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(ProviderHttpError);
    expect(error).toMatchObject({ status: 503 });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});

it("prices Jev input only without changing credit prices", () => {
  expect(calculateTextGenerationCost({ ...JEV_SELECTION, promptTokens: 1_000_000, outputTokens: 1_000_000 })).toBe(0.042);
});
it("includes decisions in project totals and keeps unknown usage unpriced", () => {
  expect(calculateProjectCostSummary([
    { ...JEV_SELECTION, promptTokens: 1000, outputTokens: 0, costHint: 0.000042, metadata: { operation: "decision.choose", liveStatus: "settled" } },
    { ...JEV_SELECTION, promptTokens: 0, outputTokens: 0, costHint: null, metadata: { operation: "decision.choose", liveStatus: "failed" } }
  ], [])).toMatchObject({ textUsd: 0.000042, totalUsd: 0.000042, unpricedTextCalls: 1 });
});
