import { describe, expect, it, vi } from "vitest";
import { FakeTextModelAdapter } from "../adapters/fake.js";
import type { DecisionRequest, DecisionResult } from "../adapters/decisions.js";
import { FallbackDecisionAdapter } from "../adapters/decisionRouting.js";
import { JEV_SELECTION } from "../adapters/generationTextModelRouting.js";
import { auditPageStyle, styleAuditedScoreBeats, withStyleAudit } from "./styleAuditor.js";

const context = {
  pageIndex: 12,
  markdown: "The storm took the roof off.",
  voiceGuide: ["Warm and plain."],
  antiAiRules: ["Avoid generic chapter summaries."],
  styleExcerpts: ["Opening voice.", "Second page voice."]
};
const diagnostic = { styleOk: false, styleIssues: ["Replace the lecture-style conclusion with a concrete action."] };
function verdict(selectedOption = "clean", probabilities = {
  clean: selectedOption === "clean" ? 0.9 : 0.05,
  defect: selectedOption === "defect" ? 0.9 : 0.05,
  insufficient_context: selectedOption === "insufficient_context" ? 0.9 : 0.05
}): DecisionResult {
  return { ...JEV_SELECTION, selectedOption, probabilities };
}
function fixture(result = verdict()) {
  const textModel = new FakeTextModelAdapter();
  const generateJson = vi.spyOn(textModel, "generateJson").mockResolvedValue({ data: diagnostic, text: "", provider: "fake", model: "fake" });
  const choose = vi.fn(async (_request: DecisionRequest) => result);
  const decisions = { resolve: vi.fn(async () => ({ choose })), recordOutcome: vi.fn(async () => {}) };
  return { textModel, generateJson, choose, decisions, options: { ...context, textModel, decisions } };
}

describe("Jev style audit screen", () => {
  it("skips diagnosis only for a clear clean verdict and logs the avoided audit", async () => {
    const test = fixture();
    expect(await auditPageStyle(test.options)).toEqual({ styleOk: true, styleIssues: [] });
    expect(test.generateJson).not.toHaveBeenCalled();
    expect(test.decisions.recordOutcome).toHaveBeenCalledWith(expect.objectContaining({
      purpose: "screen-page-style", version: "style-audit-screen-v1", pageIndex: 12,
      selectedOption: "clean", probabilities: verdict().probabilities, auditAvoided: true
    }));
  });

  it.each(["defect", "insufficient_context"])("sends %s to diagnosis for actionable findings", async (choice) => {
    const test = fixture(verdict(choice));
    expect(await auditPageStyle(test.options)).toEqual(diagnostic);
    expect(test.generateJson).toHaveBeenCalledOnce();
    expect(test.decisions.recordOutcome).toHaveBeenCalledWith(expect.objectContaining({ escalationReason: choice, auditAvoided: false }));
  });

  it.each(["clean", "defect"])("protects explicitly requested style changes in the %s path with identical full context", async (choice) => {
    const test = fixture(verdict(choice));
    const markdown = `${"Complete prose. ".repeat(3000)}The final sentence.`;
    const userRequest = "Make page 12 more dramatic and formal.";
    await auditPageStyle({ ...test.options, markdown, userRequest: ` ${userRequest} ` });
    const request = test.choose.mock.calls[0]![0];
    expect(request.escalationPolicy).toBe("caller");
    expect(request.instructions).toContain("INTENDED");
    expect(request.instructions).toContain("Report only drift the request did not ask for.");
    expect(request.instructions).toContain("antiAiRules");
    expect(JSON.parse(request.context)).toEqual(expect.objectContaining({ ...context, markdown, userRequest }));
    if (choice === "defect") {
      const messages = test.generateJson.mock.calls[0]![0].messages;
      expect(messages[0]!.content).toContain("INTENDED");
      expect(JSON.parse(messages[1]!.content)).toEqual(JSON.parse(request.context));
    }
  });

  it.each([
    ["low_probability", verdict("clean", { clean: 0.6, defect: 0.2, insufficient_context: 0.2 })],
    ["invalid_probabilities", { ...verdict(), probabilities: undefined }],
    ["invalid_probabilities", verdict("clean", { clean: 0.9, defect: 0.9, insufficient_context: 0.1 })],
    ["invalid_choice", verdict("unknown")]
  ])("escalates %s without accepting a clean label alone", async (reason, result) => {
    const test = fixture(result as DecisionResult);
    expect(await auditPageStyle(test.options)).toEqual(diagnostic);
    expect(test.decisions.recordOutcome).toHaveBeenCalledWith(expect.objectContaining({ escalationReason: reason, auditAvoided: false }));
  });

  it.each(["disabled", "unavailable", "failed", "provider"])("preserves diagnosis when routing is %s", async (failure) => {
    const test = fixture();
    const decisions = failure === "disabled" ? undefined : {
      ...test.decisions,
      resolve: async () => {
        if (failure === "failed") throw new Error("Settings unavailable");
        if (failure === "unavailable") return undefined;
        return { choose: async () => { throw new Error("Provider unavailable"); } };
      }
    };
    expect(await auditPageStyle({ ...test.options, decisions })).toEqual(diagnostic);
    expect(test.generateJson).toHaveBeenCalledOnce();
    if (decisions) expect(test.decisions.recordOutcome).toHaveBeenCalledWith(expect.objectContaining({
      escalationReason: failure === "provider" ? "provider_failure" : "routing_unavailable", auditAvoided: false
    }));
  });

  it("uses the existing diagnostic call directly after Jev uncertainty, with no generic LLM choice", async () => {
    const test = fixture(verdict("clean", { clean: 0.6, defect: 0.2, insufficient_context: 0.2 }));
    const fallbackChoose = vi.fn();
    const adapter = new FallbackDecisionAdapter({
      primary: JEV_SELECTION, fallback: { provider: "openai", model: "fallback" }, gateWinningProbability: true,
      createAdapter: (selection) => selection.provider === JEV_SELECTION.provider ? { choose: test.choose } : { choose: fallbackChoose }
    });
    await auditPageStyle({ ...test.options, decisions: { ...test.decisions, resolve: async () => adapter } });
    expect(test.choose).toHaveBeenCalledOnce();
    expect(fallbackChoose).not.toHaveBeenCalled();
    expect(test.generateJson).toHaveBeenCalledOnce();
  });

  it("preserves score provenance and never overrides another failed gate", async () => {
    const test = fixture();
    const report = { score: 80, approved: false, issues: ["Unsupported claim"], requiredRevisions: ["Support the claim"], checks: { styleNatural: true } };
    const screened = withStyleAudit(report, await auditPageStyle(test.options));
    expect(screened).toEqual({ ...report, stylePenalty: 0 });
    const drifted = withStyleAudit({ ...report, score: 90 }, diagnostic);
    expect(styleAuditedScoreBeats(screened, drifted)).toBe(true);
    expect(styleAuditedScoreBeats({ score: 81 }, screened)).toBe(true);
    expect(styleAuditedScoreBeats(drifted, { score: 81 })).toBe(true);
  });

  it.each(["resolve", "choose", "log"])("propagates cancellation during %s without diagnosis", async (stage) => {
    const test = fixture();
    const stop = Object.assign(new Error("Stopped"), { name: "StopRequestedError" });
    if (stage === "resolve") test.decisions.resolve.mockRejectedValue(stop);
    if (stage === "choose") test.choose.mockRejectedValue(stop);
    if (stage === "log") test.decisions.recordOutcome.mockRejectedValue(stop);
    await expect(auditPageStyle(test.options)).rejects.toBe(stop);
    expect(test.generateJson).not.toHaveBeenCalled();
  });

  it.each(["before", "during"])("honors AbortSignal %s the decision", async (stage) => {
    const test = fixture();
    const controller = new AbortController();
    if (stage === "before") controller.abort();
    else test.choose.mockImplementation(async () => { controller.abort(); return verdict(); });
    await expect(auditPageStyle({ ...test.options, signal: controller.signal })).rejects.toMatchObject({ name: "AbortError" });
    expect(test.generateJson).not.toHaveBeenCalled();
    if (stage === "before") expect(test.decisions.resolve).not.toHaveBeenCalled();
  });

  it("does not turn failed outcome logging into another paid call", async () => {
    const test = fixture();
    test.decisions.recordOutcome.mockRejectedValue(new Error("Log unavailable"));
    expect(await auditPageStyle(test.options)).toEqual({ styleOk: true, styleIssues: [] });
    expect(test.choose).toHaveBeenCalledOnce();
    expect(test.generateJson).not.toHaveBeenCalled();
  });
});
