import { expect, it, vi } from "vitest";
import { bookPlanSchema, createProjectSchema, FakeTextModelAdapter, pictureBookPageReview, pictureBookFindingSchema, type PictureBookPageReview } from "@book-maker/core";
import { checkedShortBookRepairCandidate } from "./compileShortBookRepairCandidate.js";
import { independentSentenceCandidate, retainRestoredSceneFindings } from "./compileIndependentSentenceRepair.js";
import { RepairRejectedError } from "./compileRepairOutcome.js";
import captured from "./testing/quickIndependentRepair0928.json" with { type: "json" };

const input = createProjectSchema.parse(captured.input), plan = bookPlanSchema.parse(captured.plan);
const checks = { pageModelReview: true, storyExtractAudit: false, styleAuditor: false };
const clean = (pages = captured.pages) => pages.map(page => pictureBookPageReview({
  pageIndex: page.index, score: 96, findings: [], storyExtract: null, styleAudit: null
}, page, checks, input.prompt));
const baseline = clean();
baseline[19] = pictureBookPageReview({ pageIndex: 20, score: 86, findings: [pictureBookFindingSchema.parse(captured.sceneReview.findings[0]!)],
  storyExtract: null, styleAudit: null }, captured.pages[19]!, checks, input.prompt);
const issues = [
  { pageIndexes: [18], messages: ["Sentences are too long for ages 6-8 (average 12.8 words, longest 15; target average <= 12, longest <= 22)."] },
  { pageIndexes: [20], messages: baseline[19]!.report.issues }
];
function setup(mode: "accept" | "reject" | "exhausted" = "accept") {
  const textModel = new FakeTextModelAdapter();
  textModel.generateJson = async request => ({ data: request.schema.parse(captured.patch), text: JSON.stringify(captured.patch), provider: "fixture", model: "fixture" });
  const rejection = new RepairRejectedError("target_unresolved", [20, 21], "The route is still checked twice.");
  let reviews: PictureBookPageReview[] = [], isolated = false;
  const verify = vi.fn(async (candidate, budget) => {
    budget.used++;
    if (mode === "exhausted") budget.used = budget.limit;
    reviews = clean(candidate.pages);
    for (const change of candidate.context.changes) reviews[change.pageIndex - 1]!.repairAssessment = {
      targetResolved: change.pageIndex === 18, meaningPreserved: true, noNewRegressions: true, reason: "Captured page 18 passes; scene still repeats."
    };
    if (isolated && mode === "accept") return undefined;
    return { rejection, failures: [{ pageIndex: 20, issues: [rejection.message] }] };
  });
  const selectIndependent = vi.fn(candidate => {
    const subset = independentSentenceCandidate(captured.pages, candidate, reviews, baseline);
    isolated = Boolean(subset); return subset;
  });
  return { verify, selectIndependent, rejection, run: () => checkedShortBookRepairCandidate({
    input, plan, pages: captured.pages, issues, textModel, originalReviews: baseline,
    sceneRepairTargets: [{ pageIndex: 20, pageIndexes: [20, 21, 22] }],
    assertActive: async () => {}, check: async () => [], verify, selectIndependent
  }) };
}

it("rechecks the exact 30-page combination before retaining Quick's independent page 18 repair", async () => {
  const test = setup(), result = await test.run();
  expect(test.verify).toHaveBeenCalledTimes(2);
  expect(test.selectIndependent).toHaveBeenCalledTimes(1);
  expect(result.context.changes.map(change => change.pageIndex)).toEqual([18]);
  expect(result.pages[17]!.markdown).toContain("Rabbit watched the light settle. Then they turned back toward the log.");
  for (const page of result.pages.filter(page => page.index !== 18)) expect(page).toEqual(captured.pages[page.index - 1]);
  expect(test.verify.mock.calls[0]![1]).toBe(test.verify.mock.calls[1]![1]);
  const finalReviews = clean(result.pages);
  retainRestoredSceneFindings(finalReviews, baseline, result.context);
  expect(finalReviews[19]!.report.approved).toBe(false);
  expect(finalReviews[19]!.findings).toEqual(baseline[19]!.findings);
});

it.each(["reject", "exhausted"] as const)("keeps originals when independent verification is %s", async mode => {
  const test = setup(mode);
  await expect(test.run()).rejects.toBe(test.rejection);
  expect(test.verify).toHaveBeenCalledTimes(mode === "exhausted" ? 1 : 2);
});

it.each(["dependent_finding", "unresolved_sentence", "stale_baseline", "missing_requirement"])(
  "does not isolate an unsafe improvement with %s", async mode => {
    const test = setup(); await test.run();
    const candidate = test.verify.mock.calls[0]![0], reviews = clean(candidate.pages), original = structuredClone(baseline);
    reviews[17]!.repairAssessment = { targetResolved: mode !== "unresolved_sentence", meaningPreserved: true, noNewRegressions: true, reason: "Comparison." };
    if (mode === "dependent_finding") reviews[19]!.findings = [{ ...pictureBookFindingSchema.parse(captured.sceneReview.findings[0]),
      relatedEvidence: [{ pageIndex: 18, quote: candidate.pages[17]!.markdown }] }];
    if (mode === "stale_baseline") original[0]!.draftMarkdown = "A different manuscript.";
    if (mode === "missing_requirement") original[19]!.findings = [{ ...original[19]!.findings![0]!,
      basis: "missing_requirement", requirementQuote: "natural dialogue" }];
    expect(independentSentenceCandidate(captured.pages, candidate, reviews, original)).toBeUndefined();
  });
