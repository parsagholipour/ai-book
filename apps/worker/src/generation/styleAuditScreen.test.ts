import { describe, expect, it, vi } from "vitest";
import {
  createProjectSchema, makeFallbackPlan, FakeTextModelAdapter, JEV_SELECTION,
  localStyleInstructions, type DecisionRequest, type PageQualityReport
} from "@book-maker/core";

vi.mock("@book-maker/db", () => ({ prisma: {}, Prisma: {} }));
vi.mock("./qualitySettings.js", () => ({ loadQualityContext: vi.fn() }));
vi.mock("./storyStateStore.js", () => ({
  loadProjectStoryState: vi.fn(), rebuildStoryStateFromPages: vi.fn(), persistPageStoryDelta: vi.fn()
}));

import { enrichPageQualityReport, revisedDraftStyleAuditor } from "./qualityEnrichment.js";
import { StopRequestedError } from "../runtime/jobTypes.js";

const input = createProjectSchema.parse({ prompt: "A storm at sea", targetPages: 20 });
const plan = makeFallbackPlan(input);
const report: PageQualityReport = {
  approved: true, score: 90, issues: [], requiredRevisions: [], notes: "ok", groundedOk: true, unsupportedClaims: [],
  checks: { placeholderFree: true, promptLeakFree: true, titleClean: true, repetitionOk: true, progressionOk: true, styleNatural: true }
};
const draft = { title: "Storm", markdown: 'A wave struck.\n\n```figure\n{"kind":"bar"}\n```\n\nThe mast fell.', summary: "A storm", continuityNotes: [] };
function fixture(choice = "clean") {
  const textModel = new FakeTextModelAdapter();
  const generateJson = vi.spyOn(textModel, "generateJson").mockResolvedValue({
    text: "", provider: "fake", model: "fake",
    data: { styleOk: false, styleIssues: ["Restore the plain rhythm in the final paragraph."],
      evidence: [{ issue: "Restore the plain rhythm in the final paragraph.", quote: "The mast fell.", category: "voice" }] }
  });
  const choose = vi.fn(async (_request: DecisionRequest) => ({
    ...JEV_SELECTION, selectedOption: choice,
    probabilities: { clean: choice === "clean" ? 0.9 : 0.05, defect: choice === "defect" ? 0.9 : 0.05, insufficient_context: choice === "insufficient_context" ? 0.9 : 0.05 }
  }));
  const decisions = { resolve: vi.fn(async () => ({ choose })), recordOutcome: vi.fn(async () => {}) };
  const options = {
    projectId: "project", plan, textModel, decisions,
    styleExcerpts: ["Opening page, pinned.", "Second page, pinned."],
    quality: { enabled: (gate: string): boolean => gate === "styleAuditor" },
    userRequest: "Make page 12 more dramatic."
  };
  const enrich = (overrides: Partial<typeof options> = {}) => enrichPageQualityReport({
    ...options, ...overrides, input, pageIndex: 12, draft, report, previousPages: [], researchNotes: [],
    storyState: { promises: [], facts: [], entities: {}, unanswered: [] }
  });
  return { options, enrich, choose, decisions, generateJson };
}

describe("worker style screens", () => {
  it("screens initial and revised pages with the same pinned context and requested edit", async () => {
    const test = fixture();
    const enriched = await test.enrich();
    const revised = await revisedDraftStyleAuditor(test.options)!(12, draft, report);
    expect(enriched.report).toMatchObject({ approved: true, score: 90, stylePenalty: 0 });
    expect(revised).toMatchObject({ approved: true, score: 90, stylePenalty: 0 });
    expect(test.generateJson).not.toHaveBeenCalled();
    expect(test.choose).toHaveBeenCalledTimes(2);
    const initialContext = JSON.parse(test.choose.mock.calls[0]![0].context);
    expect(JSON.parse(test.choose.mock.calls[1]![0].context)).toEqual(initialContext);
    expect(initialContext).toEqual({
      pageIndex: 12, pageRole: "body", markdown: "A wave struck.\n\nThe mast fell.",
      voiceGuide: plan.voiceGuide, antiAiRules: localStyleInstructions(plan),
      styleExcerpts: test.options.styleExcerpts, userRequest: test.options.userRequest
    });
  });

  it.each(["clean", "defect", "insufficient_context", "provider_failure", "diagnostic_failure"])("retains two revision audit attempts for %s", async (choice) => {
    const test = fixture(choice === "diagnostic_failure" ? "defect" : choice);
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      if (choice === "provider_failure") test.choose.mockRejectedValue(new Error("Provider unavailable"));
      if (choice === "diagnostic_failure") test.generateJson.mockRejectedValue(new Error("Diagnostic unavailable"));
      const audit = revisedDraftStyleAuditor(test.options)!;
      const first = await audit(12, draft, report);
      await audit(12, draft, report);
      expect(await audit(12, draft, report)).toBe(report);
      expect(test.choose).toHaveBeenCalledTimes(2);
      expect(test.generateJson).toHaveBeenCalledTimes(choice === "clean" ? 0 : 2);
      if (choice === "clean") expect(first).toHaveProperty("stylePenalty", 0);
      else if (choice === "diagnostic_failure") {
        expect(first).toMatchObject({ approved: true, score: 90, requiredRevisions: [],
          qualityAdvisories: [{ check: "style", status: "unverified", message: expect.stringContaining("unavailable") }] });
        expect(first).not.toHaveProperty("stylePenalty");
      }
      else expect(first).toMatchObject({ approved: false, score: 90, stylePenalty: 15, requiredRevisions: ["Revise style: Restore the plain rhythm in the final paragraph."] });
      // A separate page still gets its own two attempts.
      await revisedDraftStyleAuditor(test.options)!(13, draft, report);
      expect(test.choose).toHaveBeenCalledTimes(3);
    } finally { warning.mockRestore(); }
  });

  it("never screens when the style gate is off or excerpts are absent", async () => {
    const test = fixture();
    for (const overrides of [{ quality: { enabled: () => false } }, { styleExcerpts: [] }]) {
      expect((await test.enrich(overrides)).report).not.toHaveProperty("stylePenalty");
      expect(revisedDraftStyleAuditor({ ...test.options, ...overrides })).toBeUndefined();
    }
    expect(test.decisions.resolve).not.toHaveBeenCalled();
    expect(test.generateJson).not.toHaveBeenCalled();
  });

  it.each([new StopRequestedError(), new DOMException("Cancelled", "AbortError")])("propagates %s through initial and revision enrichment", async (stop) => {
    const test = fixture();
    test.choose.mockRejectedValue(stop);
    await expect(test.enrich()).rejects.toBe(stop);
    await expect(revisedDraftStyleAuditor(test.options)!(12, draft, report)).rejects.toBe(stop);
    expect(test.generateJson).not.toHaveBeenCalled();
  });
});
