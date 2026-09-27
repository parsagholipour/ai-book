import { expect, it, vi } from "vitest";
import { bookPlanSchema, createProjectSchema, FakeTextModelAdapter, reviewPageDraftLocally,
  type GenerateJsonOptions } from "@book-maker/core";
import { checkedShortBookRepairCandidate } from "./compileShortBookRepairCandidate.js";
import { RepairRejectedError } from "./compileRepairOutcome.js";
import { StopRequestedError } from "../runtime/jobTypes.js";
import captured from "./testing/quickBoundaryRepair0000.json" with { type: "json" };

const input = createProjectSchema.parse(captured.input), plan = bookPlanSchema.parse(captured.plan);
type Candidate = Awaited<ReturnType<typeof checkedShortBookRepairCandidate>>;
const corrected = structuredClone(captured.proposal);
// A locally valid correction fixture; semantic acceptance is still required below.
Object.assign(corrected.sceneRevisions[0]!.pages[2]!, {
  title: "Together through the Rain",
  markdown: "Rabbit slowed beside Wise Turtle. A puddle crossed the way to the stump. Rabbit found a dry stone for Turtle to step on. Turtle followed without asking for another count. They left the puzzled neighbors safely waiting by the brambles and went to examine the fresh marks.",
  summary: "Rabbit helps Turtle reach the fading clue, putting their agreement into action."
});

function localFailures(pages: Candidate["pages"]) {
  return pages.flatMap(page => {
    const report = reviewPageDraftLocally({ input, plan, pageIndex: page.index,
      draft: { ...page, continuityNotes: [] }, previousPages: pages.filter(p => p.index < page.index),
      nextPages: pages.filter(p => p.index > page.index), continuityNotes: [] });
    return report.approved ? [] : [{ pageIndex: page.index, issues: report.issues }];
  });
}

function setup(responses = [captured.proposal, corrected]) {
  const textModel = new FakeTextModelAdapter(), calls: GenerateJsonOptions<unknown>[] = [];
  textModel.generateJson = async request => {
    const raw = responses[calls.length]; calls.push(request);
    return { data: request.schema.parse(raw), text: JSON.stringify(raw), provider: "fixture", model: "fixture" };
  };
  const check = vi.fn(async (candidate: Candidate) => localFailures(candidate.pages));
  const verify = vi.fn<Parameters<typeof checkedShortBookRepairCandidate>[0]["verify"]>(async () => undefined);
  const options = { ...captured, input, plan, textModel, check, verify, assertActive: vi.fn(async () => {}) };
  return { options, calls, check, verify, run: () => checkedShortBookRepairCandidate(options) };
}

it("corrects Quick's new page 9/10 collision within the existing allowance", async () => {
  expect(localFailures(captured.pages).map(f => f.pageIndex)).toEqual([1, 26]);
  const test = setup();
  const candidate = await test.run();
  expect(test.calls).toHaveLength(2);
  expect(test.verify).toHaveBeenCalledTimes(1);
  expect(localFailures(candidate.pages)).toEqual([]);
  expect(candidate.pages[9]).toEqual(captured.pages[9]);
  expect(candidate.pages[0]!.markdown).not.toBe(captured.pages[0]!.markdown);
  expect(candidate.pages[25]!.markdown).not.toBe(captured.pages[25]!.markdown);
  const first = test.check.mock.calls[0]![0];
  expect(localFailures(first.pages)).toEqual([{ pageIndex: 10, issues: [
    "Page title repeats the title of the page before it (from page 9).",
    "Page repeats or substantially overlaps the beat from page 9."
  ] }]);
  const feedback = JSON.parse(test.calls[1]!.messages.at(-1)!.content);
  expect(feedback.feedback.failures).toEqual(localFailures(first.pages));
  expect(feedback.pages).toEqual(captured.pages);
  expect(feedback.semanticTargetPageIndexes).not.toContain(10);
  expect(test.calls[0]!.textAttemptBudget).toBe(test.calls[1]!.textAttemptBudget);
});

it("still rejects an inherited defect on an unchanged neighbor", async () => {
  const test = setup();
  test.check.mockImplementation(async candidate => [...localFailures(candidate.pages), { pageIndex: 10, issues: ["Inherited defect"] }]);
  await expect(test.run()).rejects.toThrow("Inherited defect");
  expect(test.calls).toHaveLength(1);
  expect(test.verify).not.toHaveBeenCalled();
});

it("does not review or allow a third proposal when the collision remains", async () => {
  const stillBad = structuredClone(captured.proposal);
  stillBad.sceneRevisions[0]!.pages[0]!.markdown += " Rain pattered.";
  const test = setup([captured.proposal, stillBad]);
  await expect(test.run()).rejects.toThrow("Page 10");
  expect(test.calls).toHaveLength(2);
  expect(test.verify).not.toHaveBeenCalled();
});

it("does not spend another review on an identical rejected candidate", async () => {
  const test = setup([captured.proposal, captured.proposal]);
  await expect(test.run()).rejects.toThrow("Page 10");
  expect(test.calls).toHaveLength(2);
  expect(test.verify).not.toHaveBeenCalled();
});

it("requires semantic acceptance of the corrected whole manuscript", async () => {
  const test = setup();
  const rejection = new RepairRejectedError("target_unresolved", [7], "The scene's pacing remains unresolved.");
  test.verify.mockResolvedValue({ rejection, failures: [{ pageIndex: 7, issues: [rejection.message] }] });
  await expect(test.run()).rejects.toBe(rejection);
  expect(test.calls).toHaveLength(2);
  expect(test.verify).toHaveBeenCalledTimes(1);
});

it("does not widen an exhausted provider allowance to fix the neighbor", async () => {
  const test = setup(), generate = test.options.textModel.generateJson.bind(test.options.textModel);
  test.options.textModel.generateJson = async request => {
    request.textAttemptBudget!.used = request.textAttemptBudget!.limit;
    return generate(request);
  };
  await expect(test.run()).rejects.toThrow("Page 10");
  expect(test.calls).toHaveLength(1);
  expect(test.verify).not.toHaveBeenCalled();
});

it("honors cancellation before issuing the boundary correction", async () => {
  const test = setup();
  test.options.assertActive.mockImplementation(async () => {
    if (test.check.mock.calls.length >= 2) throw new StopRequestedError();
  });
  await expect(test.run()).rejects.toBeInstanceOf(StopRequestedError);
  expect(test.calls).toHaveLength(1);
  expect(test.verify).not.toHaveBeenCalled();
});
