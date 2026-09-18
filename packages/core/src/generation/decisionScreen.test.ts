import { describe, expect, it, vi } from "vitest";
import type { DecisionRequest, DecisionResult } from "../adapters/decisions.js";
import { DecisionEscalationError } from "../adapters/decisionRouting.js";
import { passesDecisionScreen } from "./decisionScreen.js";

const PASS = "keep";
const OPTIONS = [
  { id: "keep", description: "The dummy pass." },
  { id: "send", description: "A dummy fail." },
  { id: "hold", description: "A dummy deferral." }
];

function dummyRequest(signal?: AbortSignal): DecisionRequest {
  return {
    purpose: "screen-dummy",
    context: "A dummy page to judge.",
    instructions: "Choose keep, send, or hold.",
    options: OPTIONS,
    ...(signal ? { signal } : {})
  };
}

function verdict(selectedOption: string, probabilities = {
  keep: selectedOption === "keep" ? 0.9 : 0.05,
  send: selectedOption === "send" ? 0.9 : 0.05,
  hold: selectedOption === "hold" ? 0.9 : 0.05
}): DecisionResult {
  return { provider: "fake", model: "fake", selectedOption, probabilities };
}

function fixture(result = verdict(PASS)) {
  const choose = vi.fn(async (_request: DecisionRequest) => result);
  const decisions = { resolve: vi.fn(async () => ({ choose })), recordOutcome: vi.fn(async () => {}) };
  return {
    choose,
    decisions,
    result,
    options: {
      decisions,
      request: dummyRequest(),
      version: "decision-screen-test-v1",
      passChoice: PASS,
      avoided: "rewriteAvoided" as const
    }
  };
}

describe("decision screen", () => {
  it("stamps a request with no escalationPolicy as caller before choose", async () => {
    const test = fixture();
    expect(test.options.request).not.toHaveProperty("escalationPolicy");
    await passesDecisionScreen(test.options);
    expect(test.choose.mock.calls[0]![0].escalationPolicy).toBe("caller");
  });

  it.each([
    ["keep", true],
    ["send", false],
    ["hold", false]
  ])("sets avoided only when %s is the dummy passChoice and there is no escalation", async (choice, passed) => {
    const test = fixture(verdict(choice));
    expect(await passesDecisionScreen(test.options)).toBe(passed);
    const outcome = test.decisions.recordOutcome.mock.calls[0]![0];
    expect(outcome.rewriteAvoided).toBe(passed);
    if (passed) expect(outcome).not.toHaveProperty("escalationReason");
    else expect(outcome.escalationReason).toBe(choice);
  });

  it.each([
    ["keep", true],
    ["send", false]
  ])("records rewriteAvoided false beside auditAvoided when %s", async (choice, passed) => {
    const test = fixture(verdict(choice));
    expect(await passesDecisionScreen({ ...test.options, avoided: "auditAvoided" })).toBe(passed);
    expect(test.decisions.recordOutcome).toHaveBeenCalledWith(expect.objectContaining({
      rewriteAvoided: false, auditAvoided: passed
    }));
  });

  it.each(["choose", "after choose"])("records a cancelled outcome then rethrows when cancelled at %s", async (stage) => {
    const test = fixture();
    const cancelled = new DOMException("Cancelled", "AbortError");
    if (stage === "choose") {
      test.choose.mockRejectedValue(cancelled);
      await expect(passesDecisionScreen(test.options)).rejects.toBe(cancelled);
    } else {
      const controller = new AbortController();
      test.choose.mockImplementation(async () => {
        controller.abort();
        return test.result;
      });
      await expect(passesDecisionScreen({
        ...test.options, request: dummyRequest(controller.signal)
      })).rejects.toMatchObject({ name: "AbortError" });
    }
    expect(test.decisions.recordOutcome).toHaveBeenCalledWith(expect.objectContaining({
      escalationReason: "cancelled", rewriteAvoided: false
    }));
  });

  it("returns false for DecisionEscalationError even when recordOutcome later fails", async () => {
    const test = fixture();
    test.choose.mockRejectedValue(new DecisionEscalationError("low_probability", test.result));
    test.decisions.recordOutcome.mockRejectedValue(new Error("Log unavailable"));
    expect(await passesDecisionScreen(test.options)).toBe(false);
    expect(test.decisions.recordOutcome).toHaveBeenCalledWith(expect.objectContaining({
      selectedOption: test.result.selectedOption,
      probabilities: test.result.probabilities,
      escalationReason: "low_probability"
    }));
  });
});
