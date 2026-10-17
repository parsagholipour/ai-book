import { describe, expect, it, vi } from "vitest";
import {
  createProjectSchema, FakeTextModelAdapter, makeFallbackPlan, JEV_SELECTION, pageQualityReportSchema,
  type BookGenerationStrategy, type DecisionRequest, type PageDraft, type PageQualityReport
} from "@book-maker/core";
import { report, qualityGates } from "./testing/pageReviewHarness.js";
import { runPageQualityLoop } from "./pageReview.js";
import { changedCandidateGrounding } from "./changedCandidateGrounding.js";

const input = createProjectSchema.parse({ title: "Trials", prompt: "Explain scientific evidence", category: "SCIENCE", targetPages: 8 });
const plan = makeFallbackPlan(input);
const notes = ["North trial, results: A small trial suggests the treatment may help. Recovery rates were not measured; East did not conduct this trial."];
const original = "The North team reported that the treatment may help. Recovery rates were not measured.";
const page = (markdown: string): PageDraft => ({ title: "Trial", markdown, summary: "Trial results", continuityNotes: [] });
const initialReport = () => report(50, { groundedOk: true, groundingStatus: "verified", unsupportedClaims: [], issues: ["Improve structure"] });
function fixture(rewrites: string[], approved = true) {
  const textModel = new FakeTextModelAdapter();
  const generate = vi.spyOn(textModel, "generateJson").mockResolvedValue({ data: {
    groundedOk: false, unsupportedClaims: ["Unsupported statistic or attribution: remove it and retain the North trial's qualified finding."]
  }, text: "", provider: "fake", model: "fake" });
  const choose = vi.fn(async (_request: DecisionRequest) => ({ ...JEV_SELECTION, selectedOption: "defect", probabilities: { supported: 0.02, defect: 0.96, insufficient_context: 0.02 } }));
  const revise = vi.fn(async () => page(rewrites.shift() ?? original));
  const review = vi.fn(async () => report(85, { approved, groundedOk: true, unsupportedClaims: [] }));
  const options = {
    projectId: "project-1", strategy: { revisePageDraft: revise, reviewPageDraft: review } as unknown as BookGenerationStrategy,
    input, plan, pageIndex: 4, draft: page(original), report: initialReport(), previousPages: [], continuityNotes: [],
    textModel, decisions: { resolve: async () => ({ choose }) }, researchNotes: notes,
    maxCandidates: 3, reviseContext: "Page 4", quality: qualityGates("changedCandidateGrounding")
  };
  return { generate, choose, revise, review, options };
}

describe("page candidate grounding gate", () => {
  it("keeps the fiction context through both grounding passes for a researched celebrity romance", async () => {
    const test = fixture([]);
    const storyInput = { ...input, category: "CUSTOM" as const,
      prompt: "Write a fictional romance with Neymar; research his real football career." };
    const storyPlan = { ...plan, premise: "A fictional romance between Neymar and Camila at Café Maré." };
    const candidate = page("The reservation sign swayed as Neymar stepped into Café Maré. ‘We came for the window,’ he said.");
    const check = changedCandidateGrounding({ ...test.options, input: storyInput, plan: storyPlan, pageIndex: 1 });
    await check(candidate, report(90, { approved: true }), ["Neymar made his Santos debut in 2009."]);

    const book = { category: storyInput.category, prompt: storyInput.prompt, premise: storyPlan.premise };
    const screen = test.choose.mock.calls[0]![0];
    expect(JSON.parse(JSON.parse(screen.context).reviewerContext[0].content).book).toEqual(book);
    const diagnostic = test.generate.mock.calls[0]![0];
    expect(JSON.parse(diagnostic.messages[1]!.content).book).toEqual(book);
    for (const instructions of [screen.instructions, diagnostic.messages[0]!.content]) {
      expect(instructions).toContain("Fictional scenes and dialogue are not factual claims");
      expect(instructions).toContain("Do not require fiction disclaimers in story prose");
    }
  });

  it.each(["unavailable", "unverified_no_sources"])("preserves a known grounding failure through %s and persistence", async (status) => {
    const test = fixture([]);
    test.generate.mockRejectedValue(new Error("Verifier offline"));
    const check = changedCandidateGrounding(test.options);
    const failed = report(40, { approved: false, groundedOk: false, groundingStatus: "failed", unsupportedClaims: ["False statistic"] });
    const updated = await check(page("Changed."), failed, status === "unavailable" ? notes : []);
    expect(pageQualityReportSchema.parse(JSON.parse(JSON.stringify(updated)))).toMatchObject({
      approved: false, groundedOk: false, groundingStatus: "failed", groundingAvailability: status, unsupportedClaims: ["False statistic"]
    });
  });
  it.each([
    "The treatment helped 94% of participants recover.",
    "The East team reported that the treatment may help.",
    "The North team proved that the treatment always helps.",
    "The North team found no basis to think the treatment could help."
  ])("repairs an approved rewrite's new claim: %s", async (bad) => {
    const test = fixture([bad, "The small North trial suggests a possible benefit."]);
    test.choose.mockResolvedValueOnce({ ...JEV_SELECTION, selectedOption: "defect", probabilities: { supported: 0.02, defect: 0.96, insufficient_context: 0.02 } });
    test.choose.mockResolvedValueOnce({ ...JEV_SELECTION, selectedOption: "supported", probabilities: { supported: 0.96, defect: 0.02, insufficient_context: 0.02 } });
    const outcome = await runPageQualityLoop(test.options);
    expect(outcome).toMatchObject({ approved: true, revision: 3, attempts: 3, report: { groundingStatus: "verified", unsupportedClaims: [] } });
    expect(test.choose).toHaveBeenCalledTimes(2);
    expect(test.generate).toHaveBeenCalledOnce();
    const repair = test.revise.mock.calls[1] as unknown as [{ reviseOptions?: unknown; report: PageQualityReport }];
    expect(repair[0].report.requiredRevisions.join(" ")).toContain("retain the North trial");
  });

  it("keeps an earlier failed candidate with its own grounding findings after the budget expires", async () => {
    const test = fixture(["94% recovered.", "East proved recovery."], false);
    test.review.mockResolvedValueOnce(report(95)).mockResolvedValueOnce(report(60));
    const outcome = await runPageQualityLoop(test.options);
    expect(outcome).toMatchObject({ approved: false, revision: 2, attempts: 3, draft: { markdown: "94% recovered." }, report: { groundingStatus: "failed", groundedOk: false } });
    expect(outcome.report.requiredRevisions.join(" ")).toContain("Ground or remove:");
    expect(test.choose).toHaveBeenCalledTimes(2);
    expect(test.generate).toHaveBeenCalledTimes(2);
  });

  it("retains the initial candidate without repeating its enrichment verification", async () => {
    const test = fixture(["94% recovered.", "East proved recovery."], false);
    const outcome = await runPageQualityLoop({ ...test.options, report: { ...initialReport(), score: 99 } });
    expect(outcome).toMatchObject({ revision: 1, draft: { markdown: original }, report: { groundingStatus: "verified" }, approved: false });
    expect(test.choose).toHaveBeenCalledTimes(2);
    expect(test.generate).toHaveBeenCalledTimes(2);
  });

  it("does not repeat Jev or diagnosis for identical changed text/evidence", async () => {
    const test = fixture(["94% recovered.", "94% recovered."]);
    const outcome = await runPageQualityLoop(test.options);
    expect(outcome).toMatchObject({ approved: false, attempts: 3, report: { groundingStatus: "failed" } });
    expect(test.choose).toHaveBeenCalledOnce();
    expect(test.generate).toHaveBeenCalledOnce();
    expect(test.revise).toHaveBeenCalledTimes(2);
  });

  it("allows removal of an unsupported claim without inheriting its original failure", async () => {
    const test = fixture([original]);
    test.choose.mockResolvedValue({ ...JEV_SELECTION, selectedOption: "supported", probabilities: { supported: 0.96, defect: 0.02, insufficient_context: 0.02 } });
    const outcome = await runPageQualityLoop({ ...test.options, draft: page("94% recovered."), report: report(50, {
      groundedOk: false, groundingStatus: "failed", unsupportedClaims: ["94% recovered"], requiredRevisions: ["Remove unsupported statistic"]
    }) });
    expect(outcome).toMatchObject({ approved: true, revision: 2, draft: { markdown: original }, report: { groundingStatus: "verified", unsupportedClaims: [], requiredRevisions: [] } });
  });

  it("reuses an unchanged original's failure even if general review now approves it", async () => {
    const test = fixture([original, original]);
    const outcome = await runPageQualityLoop({ ...test.options, report: report(50, { groundedOk: false, groundingStatus: "failed", unsupportedClaims: ["Original unsupported claim"] }) });
    expect(outcome).toMatchObject({ approved: false, report: { groundingStatus: "failed" } });
    expect(test.choose).not.toHaveBeenCalled();
  });

  it("marks missing evidence as unverified and preserves another failed gate", async () => {
    const test = fixture(["A changed assertion."]);
    const outcome = await runPageQualityLoop({ ...test.options, researchNotes: [] });
    expect(outcome).toMatchObject({ report: { groundingStatus: "unverified_no_sources" }, approved: true });
    expect(test.choose).not.toHaveBeenCalled();
    const check = changedCandidateGrounding({ ...test.options, researchNotes: [] });
    expect(await check(page("Changed."), report(80, { groundedOk: false, issues: ["Another failure"] }), [])).toMatchObject({ approved: false, groundedOk: false, issues: ["Another failure"], groundingStatus: "failed", groundingAvailability: "unverified_no_sources" });
  });

  it("checks an externally rewritten seed even when further QA rewriting is disabled", async () => {
    const test = fixture([]);
    const outcome = await runPageQualityLoop({ ...test.options, originalDraft: page(original), draft: page("94% recovered."), report: report(95, { approved: true }), quality: { enabled: (id) => id === "changedCandidateGrounding" } });
    expect(outcome).toMatchObject({ approved: false, attempts: 1, report: { groundingStatus: "failed" } });
    expect(test.revise).not.toHaveBeenCalled();
  });

  it("supports disabling the new gate independently and skips nonfactual books", async () => {
    const test = fixture(["94% recovered."]);
    expect(await runPageQualityLoop({ ...test.options, quality: qualityGates() })).toMatchObject({ approved: true });
    const story = { ...input, category: "STORY" as const, prompt: "An imaginary dragon" };
    expect(await runPageQualityLoop({ ...test.options, input: story })).toMatchObject({ report: { groundingStatus: "not_applicable" } });
    expect(test.choose).not.toHaveBeenCalled();
  });
});
