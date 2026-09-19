import { describe, expect, it, vi } from "vitest";
import { FakeDecisionAdapter } from "../adapters/decisions.js";
import type { DecisionEvaluationRequest, DecisionEvaluationResult } from "../adapters/decisionEvaluation.js";
import { pageQualityReportSchema } from "../schemas/book.js";
import { SourceAwareTextModel } from "../sources/generation.js";
import type { SourceService } from "../sources/types.js";
import { goodMarkdown, input, importedInput, plan, capturingReviewModel } from "./testing/pagesReviewFixtures.js";
import { reviewPageDraft, type ReviewPageOptions } from "./pagesReview.js";
import { PAGE_REVIEW_QUESTIONS, pageReviewDecisionMode } from "./pageReviewScreen.js";
import { styleAuditedScoreBeats, withStyleAudit } from "./styleAuditor.js";

const brief = { pageIndex: 1, chapterIndex: 1, purpose: "Commit to a choice.", beat: "Jack enters the chapel.", requiredContinuity: [], endingPressure: "Mara follows." };
const diagnostic = { approved: false, score: 61, issues: ["Restages the same encounter."], requiredRevisions: ["Move the confrontation outside the chapel."], notes: "Repeated beat." };
function fixture() {
  const capture = capturingReviewModel(diagnostic);
  const generate = vi.spyOn(capture.model, "generateJson");
  const evaluate = vi.fn((request: DecisionEvaluationRequest) => new FakeDecisionAdapter().evaluate(request));
  const recordOutcome = vi.fn(async (_outcome: import("../adapters/decisions.js").DecisionOutcome) => {});
  const decisions = { resolve: vi.fn(async () => ({ choose: new FakeDecisionAdapter().choose, evaluate })), recordOutcome };
  const options: ReviewPageOptions = {
    input, plan, pageIndex: 1, pageBrief: brief, chapterPageStart: 1, chapterPageEnd: 2,
    chapterBrief: { chapterIndex: 1, title: "The chapel", summary: "A choice", continuityFocus: [], pages: [brief, { ...brief, pageIndex: 2, purpose: "Answer for the warrant", beat: "Mara names the betrayal." }] },
    draft: { title: "Door", markdown: goodMarkdown(), summary: "A decision", continuityNotes: [] },
    previousPages: [], continuityNotes: [], textModel: capture.model, decisions, pageReviewDecisionMode: "pass"
  };
  return { options, evaluate, decisions, generate, capture };
}
const answers = (selectedOption = "clean", probability = 0.9): DecisionEvaluationResult => ({ provider: "test", model: "test", answers: Object.fromEntries(PAGE_REVIEW_QUESTIONS.map((q) => [q.id,
  { type: "choice", selectedOption, probabilities: { clean: selectedOption === "clean" ? probability : (1 - probability) / 2, defect: selectedOption === "defect" ? probability : (1 - probability) / 2, insufficient_context: selectedOption === "insufficient_context" ? probability : (1 - probability) / 2 } }
])) });

describe("model page review screening", () => {
  it("screens independent dimensions once and returns an explicitly unscored pass", async () => {
    const f = fixture(); const report = await reviewPageDraft(f.options);
    expect(f.evaluate).toHaveBeenCalledTimes(1); expect(f.generate).not.toHaveBeenCalled();
    expect(f.evaluate.mock.calls[0]![0]).toMatchObject({ escalationPolicy: "caller", questions: PAGE_REVIEW_QUESTIONS });
    expect(pageQualityReportSchema.parse(report)).toMatchObject({ approved: true, scoreBasis: "screened_unscored", score: 75 });
    expect(f.decisions.recordOutcome).toHaveBeenCalledWith(expect.objectContaining({ reviewAvoided: true, wouldAvoidReview: true, mode: "pass" }));
  });
  it.each(PAGE_REVIEW_QUESTIONS.map((q) => q.id))("a defect in %s reaches actionable diagnosis", async (id) => {
    const f = fixture(); const result = answers(); result.answers[id] = { type: "choice", selectedOption: "defect", probabilities: { clean: 0.05, defect: 0.9, insufficient_context: 0.05 } };
    f.evaluate.mockResolvedValue(result);
    expect(await reviewPageDraft(f.options)).toMatchObject({ approved: false, score: 61, requiredRevisions: diagnostic.requiredRevisions, scoreBasis: "reviewer" });
    expect(f.generate).toHaveBeenCalledTimes(1);
  });
  it.each(["insufficient_context", "low", "missing", "unknown", "bad_distribution", "failure"])("escalates %s without manufacturing repair prose", async (kind) => {
    const f = fixture(); const result = answers(kind === "insufficient_context" ? kind : "clean", kind === "low" ? 0.69 : 0.9);
    if (kind === "missing") delete result.answers.style;
    if (kind === "unknown") result.answers.extra = { type: "boolean", probability: 1 };
    if (kind === "bad_distribution") result.answers.style = { type: "choice", selectedOption: "clean", probabilities: { clean: 0.9, defect: 0.9, insufficient_context: 0 } };
    if (kind === "failure") f.evaluate.mockRejectedValue(new Error("Unavailable")); else f.evaluate.mockResolvedValue(result);
    expect((await reviewPageDraft(f.options)).requiredRevisions).toEqual(diagnostic.requiredRevisions);
    expect(f.generate).toHaveBeenCalledTimes(1);
  });
  it("shadow measures disagreement while keeping the diagnostic verdict", async () => {
    const f = fixture(); expect((await reviewPageDraft({ ...f.options, pageReviewDecisionMode: "shadow" })).approved).toBe(false);
    expect(f.generate).toHaveBeenCalledTimes(1);
    expect(f.decisions.recordOutcome).toHaveBeenCalledWith(expect.objectContaining({ reviewAvoided: false, wouldAvoidReview: true, disagreement: true, diagnosticApproved: false, screenDurationMs: expect.any(Number), totalDurationMs: expect.any(Number) }));
    expect(pageReviewDecisionMode("unexpected")).toBe("shadow");
  });
  it("off and unavailable routes preserve ordinary review", async () => {
    const f = fixture(); await reviewPageDraft({ ...f.options, pageReviewDecisionMode: "off" });
    expect(f.decisions.resolve).not.toHaveBeenCalled(); expect(f.generate).toHaveBeenCalledTimes(1);
    expect(f.capture.payload).not.toHaveProperty("comparisonProse");
    await reviewPageDraft({ ...f.options, decisions: { resolve: async () => undefined } });
    expect(f.generate).toHaveBeenCalledTimes(2);
    expect(f.capture.payload).not.toHaveProperty("comparisonProse");
  });
  it("missing current brief, adjacent prose or future map cannot receive a cheap pass", async () => {
    for (const patch of [{ pageBrief: undefined }, { pageIndex: 2, pageBrief: { ...brief, pageIndex: 2 } }, { chapterPageEnd: 3 }]) {
      const f = fixture(); await reviewPageDraft({ ...f.options, ...patch });
      expect(f.evaluate).not.toHaveBeenCalled(); expect(f.generate).toHaveBeenCalledTimes(1);
      expect(f.decisions.recordOutcome).toHaveBeenCalledWith(expect.objectContaining({ escalationReason: "insufficient_context" }));
    }
  });
  it("uses complete inferred chapter bounds for edits but refuses a truncated chapter map", async () => {
    const f = fixture();
    await reviewPageDraft({ ...f.options, chapter: { ...plan.chapters[0]!, targetPages: 2 }, chapterPageEnd: undefined, userRequest: "Make the tone solemn" });
    expect(f.evaluate).toHaveBeenCalledTimes(1); expect(f.generate).not.toHaveBeenCalled();
    await reviewPageDraft({ ...f.options, chapter: { ...plan.chapters[0]!, targetPages: 3 }, chapterPageEnd: undefined });
    expect(f.evaluate).toHaveBeenCalledTimes(1); expect(f.generate).toHaveBeenCalledTimes(1);
  });
  it("does not bypass diagnostic integrity when configurable QA is disabled", async () => {
    const f = fixture();
    await reviewPageDraft({ ...f.options, skipLocalChecks: true, draft: { ...f.options.draft, markdown: goodMarkdown() + " mock_ai placeholder" } });
    expect(f.evaluate).not.toHaveBeenCalled(); expect(f.generate).toHaveBeenCalledTimes(1);
    expect(f.decisions.recordOutcome).toHaveBeenCalledWith(expect.objectContaining({ escalationReason: "integrity_defect" }));
  });
  it("required generated opening rules run even when local checks are disabled", async () => {
    const f = fixture(); const report = await reviewPageDraft({ ...f.options, skipLocalChecks: true, draft: { ...f.options.draft, markdown: "Welcome to this book. In this book, we will explore the topic." } });
    expect(report.approved).toBe(false); expect(f.evaluate).not.toHaveBeenCalled(); expect(f.generate).not.toHaveBeenCalled();
  });
  it("shares import exemptions, final-page rules, edit intent, following prose and research with both paths", async () => {
    const f = fixture(); f.evaluate.mockResolvedValue(answers("defect"));
    const options = { ...f.options, input: importedInput, plan: { ...plan, openingHook: "Invented plan hook" }, userRequest: "Make the tone solemn", retrievedResearch: ["A qualified finding"], nextPages: [{ index: 2, title: "After", markdown: "Existing aftermath", summary: "Aftermath" }] };
    await reviewPageDraft(options);
    const context = f.evaluate.mock.calls[0]![0].context;
    expect(context).not.toContain("Invented plan hook"); expect(context).toContain("Make the tone solemn"); expect(context).toContain("A qualified finding"); expect(context).toContain("Existing aftermath");
    expect(f.capture.system).toContain("For a final page"); expect(f.capture.system).toContain("userRequest is the approved reader edit intent");
    expect(f.capture.payload?.userRequest).toBe("Make the tone solemn");
  });
  it("prepares sources once for all questions and diagnostic JSON retries, retaining exact citations", async () => {
    const f = fixture(); f.evaluate.mockResolvedValue(answers("insufficient_context"));
    const passage = { sourceId: "s1", version: 1, ordinal: 2, name: "Canon", locator: "Chapel", content: "The seal is cracked. PRIVATE-END" };
    const service: SourceService = { search: vi.fn(async () => []), read: vi.fn(async () => passage), overview: vi.fn(async () => []) };
    f.generate.mockRejectedValueOnce(new SyntaxError("Unexpected token in JSON"));
    await reviewPageDraft({ ...f.options, draft: { ...f.options.draft, markdown: goodMarkdown() + " [source:s1:1:2]" }, textModel: new SourceAwareTextModel(f.capture.model, async () => service) });
    expect(service.search).toHaveBeenCalledTimes(1); expect(service.read).toHaveBeenCalledTimes(1); expect(service.overview).toHaveBeenCalledTimes(1);
    expect(f.generate).toHaveBeenCalledTimes(2);
    expect(f.evaluate.mock.calls[0]![0]).toMatchObject({ sourceContextPrepared: true });
    expect(f.evaluate.mock.calls[0]![0].context).toContain("PRIVATE-END");
    for (const [call] of f.generate.mock.calls) expect(JSON.stringify(call.messages)).toContain("PRIVATE-END");
  });
  it("cancellation and failed outcome logs never buy diagnosis", async () => {
    const f = fixture(); f.decisions.recordOutcome.mockRejectedValue(new Error("disk offline"));
    expect((await reviewPageDraft(f.options)).approved).toBe(true);
    const controller = new AbortController();
    f.evaluate.mockImplementation(async () => { controller.abort(); return answers(); });
    await expect(reviewPageDraft({ ...f.options, signal: controller.signal })).rejects.toMatchObject({ name: "AbortError" });
    expect(f.generate).not.toHaveBeenCalled();
  });
});

it("keeps score-based selection for legacy reports and uses eligibility then stable ties for unscored failures", async () => {
  const f = fixture(); const clean = await reviewPageDraft(f.options);
  const failed = withStyleAudit(clean, { styleOk: false, styleIssues: ["Unintended drift"] });
  const scoredFailure = { ...pageQualityReportSchema.parse(diagnostic), score: 99 };
  expect(styleAuditedScoreBeats(clean, scoredFailure)).toBe(true);
  expect(styleAuditedScoreBeats(scoredFailure, failed)).toBe(false);
  expect(styleAuditedScoreBeats(failed, scoredFailure)).toBe(false);
  expect(styleAuditedScoreBeats(failed, { ...scoredFailure, checks: { ...scoredFailure.checks, promptLeakFree: false } })).toBe(true);
  expect(styleAuditedScoreBeats({ score: 91, stylePenalty: 30 }, { score: 85, stylePenalty: 0 })).toBe(false);
  expect(styleAuditedScoreBeats({ score: 91, stylePenalty: 30 }, { score: 85 })).toBe(true);
});
