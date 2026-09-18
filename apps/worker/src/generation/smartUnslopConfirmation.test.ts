import { describe, expect, it, vi } from "vitest";
import {
  createProjectSchema, makeFallbackPlan, FakeTextModelAdapter, FallbackDecisionAdapter, JEV_SELECTION,
  hasSmartUnslopCandidates, smartUnslopResolved,
  type BookGenerationStrategy, type DecisionRequest, type DecisionResult, type DecisionAttempt,
  type ReviewPageOptions
} from "@book-maker/core";
import { pageReviewPassesFor, reviewPageWithQualityGates } from "./pageQualityGateReview.js";

const technicalPage = [
  "The basin is not a tank. It is a settling chamber.",
  "Chlorine is not an ordinary additive. It is a timed disinfectant.",
  "The reservoir is not spare storage. It is a buffer for peak demand.",
  '> The quoted manual says: “At its core, this serves as a testament to calibration.”',
  "These distinctions apply only at the specified flow rate."
].join("\n\n");
const defectivePage = "Here's the thing: treatment takes several steps. At its core, filtration removes particles. The result serves as a testament to careful plant operation.";
const input = createProjectSchema.parse({ prompt: "Explain water treatment precisely", category: "EDUCATION", language: "en", targetPages: 8 });
const plan = { ...makeFallbackPlan(input), voiceGuide: ["Preserve literal engineering distinctions."] };
const approved = {
  approved: true, score: 94, issues: [], requiredRevisions: [], notes: "Reviewed normally.",
  groundedOk: true, unsupportedClaims: [],
  checks: { placeholderFree: true, promptLeakFree: true, titleClean: true, repetitionOk: true, progressionOk: true, styleNatural: true }
};
function page(markdown = technicalPage): ReviewPageOptions {
  return {
    input, plan, pageIndex: 2,
    draft: { title: "Treatment", markdown, summary: "Engineering distinctions.", continuityNotes: [] },
    previousPages: [], continuityNotes: [], textModel: new FakeTextModelAdapter()
  };
}
function answer(selectedOption = "legitimate_use", probability = 0.9): DecisionResult {
  const probabilities = { legitimate_use: 0.05, contextual_defect: 0.05, needs_review: 0.05 };
  for (const id of Object.keys(probabilities) as (keyof typeof probabilities)[]) {
    probabilities[id] = id === selectedOption ? probability : (1 - probability) / 2;
  }
  return { ...JEV_SELECTION, selectedOption, probabilities, usage: { promptTokens: 500, outputTokens: 0 } };
}
function setup(result = answer()) {
  const choose = vi.fn<(request: DecisionRequest) => Promise<DecisionResult>>().mockResolvedValue(result);
  const decisions = { resolve: vi.fn(async () => ({ choose })), recordOutcome: vi.fn(async () => {}) };
  const reviewPageDraft = vi.fn(async () => approved);
  const options = {
    strategy: { reviewPageDraft } as unknown as BookGenerationStrategy,
    quality: { enabled: (feature: string) => ["smartUnslop", "pageModelReview"].includes(feature) },
    reviewOptions: page(), decisions
  };
  return { choose, decisions, reviewPageDraft, options };
}

describe("Jev confirmation of Smart Unslop candidates", () => {
  it("accepts clear legitimate matches but still runs ordinary review with the full protected context", async () => {
    const test = setup();
    const report = await reviewPageWithQualityGates({ ...test.options, userRequest: "Keep intentional repetition and make the distinctions emphatic." });
    expect(report).toMatchObject(approved);
    expect(smartUnslopResolved(report)).toBe(true);
    expect(hasSmartUnslopCandidates(report)).toBe(false);
    expect(test.reviewPageDraft).toHaveBeenCalledTimes(1);
    const request = test.choose.mock.calls[0]![0];
    const context = JSON.parse(request.context);
    expect(context.fullPage).toEqual(test.options.reviewOptions.draft);
    expect(context.book).toMatchObject({ category: "EDUCATION", language: "en", voiceGuide: plan.voiceGuide });
    expect(context.explicitReaderEditRequest).toContain("Keep intentional repetition");
    expect(context.flaggedSpans).toHaveLength(3);
    for (const span of context.flaggedSpans) {
      expect(context.scannedProse.slice(span.start, span.end)).toBe(span.text);
    }
    expect(request.instructions).toContain("quotations");
    expect(request.instructions).toContain("technical language");
    expect(request.instructions).toContain("essential qualifications");
    expect(test.decisions.recordOutcome).toHaveBeenCalledWith(expect.objectContaining({
      version: "smart-unslop-confirmation-v1", selectedOption: "legitimate_use", rewriteAvoided: true
    }));
  });

  it.each(["contextual_defect", "needs_review"])("retains the conditional rewrite for %s", async (choice) => {
    const test = setup(answer(choice));
    const report = await reviewPageWithQualityGates({ ...test.options, reviewOptions: page(defectivePage) });
    expect(hasSmartUnslopCandidates(report)).toBe(true);
    expect(report.approved).toBe(false);
    expect(report.requiredRevisions.join(" ")).toContain("return the page exactly unchanged");
    expect(test.reviewPageDraft).not.toHaveBeenCalled();
    expect(test.decisions.recordOutcome).toHaveBeenCalledWith(expect.objectContaining({ selectedOption: choice, escalationReason: choice, rewriteAvoided: false }));
  });

  it.each([
    [answer("legitimate_use", 0.6), "low_probability"],
    [{ ...answer(), probabilities: undefined }, "invalid_probabilities"],
    [{ ...answer(), probabilities: { legitimate_use: 0.9, contextual_defect: 0.9, needs_review: 0.9 } }, "invalid_probabilities"],
    [{ ...answer(), selectedOption: "invented" }, "invalid_choice"]
  ] as const)("preserves conditional rewriting for an unusable decision (%s)", async (result, reason) => {
    const test = setup(result);
    expect(hasSmartUnslopCandidates(await reviewPageWithQualityGates(test.options))).toBe(true);
    expect(test.reviewPageDraft).not.toHaveBeenCalled();
    expect(test.decisions.recordOutcome).toHaveBeenCalledWith(expect.objectContaining({ escalationReason: reason, rewriteAvoided: false }));
  });

  it.each(["provider", "routing"])("preserves conditional rewriting on a %s failure", async (failure) => {
    const test = setup();
    (failure === "provider" ? test.choose : test.decisions.resolve).mockRejectedValue(new Error("Unavailable"));
    expect(hasSmartUnslopCandidates(await reviewPageWithQualityGates(test.options))).toBe(true);
    expect(test.reviewPageDraft).not.toHaveBeenCalled();
    expect(test.decisions.recordOutcome).toHaveBeenCalledWith(expect.objectContaining({ rewriteAvoided: false }));
  });

  it("retains the old behavior when no decision route is available", async () => {
    const test = setup();
    const recordOutcome = test.decisions.recordOutcome;
    const report = await reviewPageWithQualityGates({ ...test.options, decisions: { resolve: async () => undefined, recordOutcome } });
    expect(hasSmartUnslopCandidates(report)).toBe(true);
    expect(recordOutcome).toHaveBeenCalledWith(expect.objectContaining({ escalationReason: "routing_unavailable", rewriteAvoided: false }));
  });

  it("escalates to the existing rewrite without a second finite LLM choice, accounting for every bounded attempt", async () => {
    const test = setup();
    const events: DecisionAttempt[] = [];
    const primary = vi.fn().mockRejectedValue(new Error("Network temporarily unavailable"));
    const fallback = vi.fn().mockResolvedValue(answer());
    const adapter = new FallbackDecisionAdapter({
      primary: JEV_SELECTION, fallback: { provider: "deepseek", model: "deepseek-v4-flash" }, gateWinningProbability: true,
      createAdapter: (selection) => ({ choose: selection.provider === JEV_SELECTION.provider ? primary : fallback }),
      retry: { attempts: 2, delayMs: 0, shouldRetry: () => true },
      onAttempt: async (attempt) => { events.push(attempt); }
    });
    const report = await reviewPageWithQualityGates({ ...test.options, decisions: { resolve: async () => adapter } });
    expect(hasSmartUnslopCandidates(report)).toBe(true);
    expect(primary).toHaveBeenCalledTimes(2);
    expect(fallback).not.toHaveBeenCalled();
    expect(events.map((event) => [event.role, event.escalationReason])).toEqual([
      ["primary", "provider_failure"], ["primary", "provider_failure"]
    ]);
  });

  it("does not let logging failures change a decision or trigger more provider calls", async () => {
    const test = setup();
    test.decisions.recordOutcome.mockRejectedValue(new Error("Log unavailable"));
    expect((await reviewPageWithQualityGates(test.options)).approved).toBe(true);
    expect(test.choose).toHaveBeenCalledTimes(1);
    expect(test.reviewPageDraft).toHaveBeenCalledTimes(1);
  });

  it("propagates a cancelled recordOutcome instead of treating it as a legitimate skip", async () => {
    const test = setup();
    test.decisions.recordOutcome.mockRejectedValue(new DOMException("Cancelled", "AbortError"));
    await expect(reviewPageWithQualityGates(test.options)).rejects.toMatchObject({ name: "AbortError" });
    expect(test.choose).toHaveBeenCalledTimes(1);
    expect(test.reviewPageDraft).not.toHaveBeenCalled();
    expect(test.decisions.recordOutcome).toHaveBeenCalledWith(expect.objectContaining({
      selectedOption: "legitimate_use", rewriteAvoided: true
    }));
  });

  it("retains simultaneous local integrity failures after dismissing legitimate matches", async () => {
    const test = setup();
    const report = await reviewPageWithQualityGates({
      ...test.options, allowModelReview: false,
      quality: { enabled: () => true },
      reviewOptions: page(`${technicalPage}\n\nThis is a placeholder page.`)
    });
    expect(report.approved).toBe(false);
    expect(report.checks.placeholderFree).toBe(false);
    expect(hasSmartUnslopCandidates(report)).toBe(false);
    expect(smartUnslopResolved(report)).toBe(true);
  });

  it("retains mandatory opening failures with local QA and model review off", async () => {
    const test = setup();
    const report = await reviewPageWithQualityGates({
      ...test.options, quality: { enabled: (feature) => feature === "smartUnslop" },
      reviewOptions: { ...page(`Welcome to this book about water.\n\n${technicalPage}`), pageIndex: 1 }
    });
    expect(report.approved).toBe(false);
    expect(report.issues.join(" ")).toContain("First page opens");
    expect(hasSmartUnslopCandidates(report)).toBe(false);
  });

  it.each(["before", "routing", "provider", "returned"])("propagates cancellation at %s without ordinary review or rewrite escalation", async (stage) => {
    const test = setup();
    const controller = new AbortController();
    const cancelled = new DOMException("Cancelled", "AbortError");
    if (stage === "before") controller.abort(cancelled);
    if (stage === "routing") test.decisions.resolve.mockRejectedValue(cancelled);
    if (stage === "provider") test.choose.mockRejectedValue(Object.assign(new Error("Stopped"), { name: "StopRequestedError" }));
    if (stage === "returned") test.choose.mockImplementation(async () => { controller.abort(cancelled); return answer(); });
    await expect(reviewPageWithQualityGates({ ...test.options, signal: controller.signal })).rejects.toMatchObject({
      name: stage === "provider" ? "StopRequestedError" : "AbortError"
    });
    expect(test.reviewPageDraft).not.toHaveBeenCalled();
    if (stage === "before") expect(test.decisions.resolve).not.toHaveBeenCalled();
  });

  it.each(["disabled", "spent", "no_cluster"])("makes no decision call when %s", async (state) => {
    const test = setup();
    const options = {
      ...test.options,
      ...(state === "disabled" ? { quality: { enabled: (feature: string) => feature === "pageModelReview" } } : {}),
      ...(state === "spent" ? { allowSmartUnslop: false } : {}),
      ...(state === "no_cluster" ? { reviewOptions: page("The operator closed the valve.") } : {})
    };
    expect((await reviewPageWithQualityGates(options)).approved).toBe(true);
    expect(test.decisions.resolve).not.toHaveBeenCalled();
    expect(pageReviewPassesFor(options).modelEnabled).toBe(true);
  });
});
