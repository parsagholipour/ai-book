import { expect, it, vi } from "vitest";
import { createProjectSchema, manuscriptRequirementInventorySchema, FakeTextModelAdapter, makeFallbackPlan,
  pictureBookRequirementTargetSchema, type GenerateJsonOptions } from "@book-maker/core";
import { checkedShortBookRepairCandidate } from "./compileShortBookRepairCandidate.js";
import { RepairRejectedError } from "./compileRepairOutcome.js";
import { StopRequestedError } from "../runtime/jobTypes.js";
import captured from "./testing/incompleteRepair0928.json" with { type: "json" };

const input = createProjectSchema.parse({ prompt: captured.brief, category: "KIDS", targetPages: 30, language: "en" });
const plan = { ...makeFallbackPlan(input), requirementInventory: manuscriptRequirementInventorySchema.parse(captured.inventory) };
const corrected = { ...captured.candidate, pages: [2, 8].map(pageIndex => {
  const page = captured.pages.find(p => p.index === pageIndex)!;
  return { pageIndex, reason: "Restore the omitted per-page dialogue without changing the scene.", summary: null,
    patches: [{ find: page.markdown, replace: page.markdown + (pageIndex === 2 ? '\n\n“The lights!” Rabbit cried.' : '\n\n“It fell again,” Wise Turtle said.') }] };
}) };

function setup(responses: unknown[] = [captured.candidate, corrected]) {
  const model = new FakeTextModelAdapter(), calls: GenerateJsonOptions<unknown>[] = [];
  model.generateJson = async request => {
    const raw = responses[calls.length]; calls.push(request);
    return { data: request.schema.parse(raw), text: JSON.stringify(raw), provider: "fixture", model: "fixture" };
  };
  const verify = vi.fn<Parameters<typeof checkedShortBookRepairCandidate>[0]["verify"]>(async () => undefined);
  const options: Parameters<typeof checkedShortBookRepairCandidate>[0] = { input, plan, pages: captured.pages,
    issues: captured.issues, requirementTargets: captured.requirementTargets.map(t => pictureBookRequirementTargetSchema.parse(t)),
    sceneRepairTargets: captured.sceneRepairTargets, textModel: model, assertActive: async () => {}, check: async () => [], verify };
  return { options, calls, verify, model, run: () => checkedShortBookRepairCandidate(options) };
}

it("corrects the captured omitted dialogue targets before any paid review, keeping the valid scene edits", async () => {
  const test = setup();
  test.verify.mockImplementation(async () => { expect(test.calls).toHaveLength(2); return undefined; });
  const result = await test.run();
  expect(test.verify).toHaveBeenCalledTimes(1);
  expect(result.context.changes.map(p => p.pageIndex).sort((a,b) => a-b)).toEqual([2,8,26,27,28,29]);
  const feedback = JSON.parse(test.calls[1]!.messages.at(-1)!.content);
  expect(feedback.feedback.failures.map((f: { pageIndex: number }) => f.pageIndex)).toEqual([2,8]);
  expect(feedback.feedback.candidatePages.map((p: { index: number }) => p.index)).toEqual([26,27,28,29]);
  expect(test.calls[0]!.textAttemptBudget).toBe(test.calls[1]!.textAttemptBudget);
});

it("rejects repeated omission within the existing two proposals without purchasing review", async () => {
  const test = setup([captured.candidate, captured.candidate]);
  await expect(test.run()).rejects.toMatchObject({ name: "RepairRejectedError", affectedPageIndexes: [2,8] });
  expect(test.calls).toHaveLength(2);
  expect(test.verify).not.toHaveBeenCalled();
});

it("does not let an empty response bypass the omitted-target correction", async () => {
  const test = setup([{ pages: [], sceneRevisions: [] }, corrected]);
  await test.run();
  expect(test.calls).toHaveLength(2);
  expect(test.verify).toHaveBeenCalledTimes(1);
});

it("does not treat a title-only change as repairing missing spoken text", async () => {
  const titleOnly = structuredClone(captured.candidate);
  titleOnly.sceneRevisions.push({ reason: "Rename the opening without changing its prose.", pages: captured.pages.filter(p => p.index >= 1 && p.index <= 2)
    .map(p => ({ pageIndex: p.index, title: p.title + " revised", markdown: p.markdown, summary: p.summary })) });
  const test = setup([titleOnly, corrected]);
  await test.run();
  const feedback = JSON.parse(test.calls[1]!.messages.at(-1)!.content);
  expect(feedback.feedback.failures.map((f: { pageIndex: number }) => f.pageIndex)).toEqual([2,8]);
});

it("does not reset exhausted attempts or buy a review of the unattempted targets", async () => {
  const test = setup(), generate = test.model.generateJson.bind(test.model);
  test.model.generateJson = async request => {
    request.textAttemptBudget!.used = request.textAttemptBudget!.limit;
    return generate(request);
  };
  await expect(test.run()).rejects.toBeInstanceOf(RepairRejectedError);
  expect(test.calls).toHaveLength(1);
  expect(test.verify).not.toHaveBeenCalled();
});

it("honors cancellation before dispatching the omission correction", async () => {
  const test = setup();
  let activity = 0;
  test.options.assertActive = async () => { if (++activity === 3) throw new StopRequestedError(); };
  await expect(test.run()).rejects.toBeInstanceOf(StopRequestedError);
  expect(test.calls).toHaveLength(1);
  expect(test.verify).not.toHaveBeenCalled();
});

it("still requires semantic acceptance and grants no third proposal after the local correction", async () => {
  const test = setup();
  const rejection = new RepairRejectedError("semantic_regression", [29], "The repaired route introduces a new contradiction.");
  test.verify.mockResolvedValue({ rejection, failures: [{ pageIndex: 29, issues: [rejection.message] }] });
  await expect(test.run()).rejects.toBe(rejection);
  expect(test.calls).toHaveLength(2);
  expect(test.verify).toHaveBeenCalledTimes(1);
});

it("keeps contextual or book-wide dialogue defects on the normal review path", async () => {
  const test = setup([captured.candidate]);
  test.options.plan = { ...plan, requirementInventory: { ...plan.requirementInventory,
    requirements: plan.requirementInventory.requirements.map(r => ({ ...r, scope: { quote: input.prompt, extent: "whole_book" } })) } };
  await test.run();
  expect(test.calls).toHaveLength(1);
  expect(test.verify).toHaveBeenCalledTimes(1);
});

it("does not insist that a relational target's owner change when a neighbor may resolve it", async () => {
  const test = setup([captured.candidate]);
  const neighbor = captured.pages.find(p => p.index === 26)!;
  test.options.requirementTargets = test.options.requirementTargets!.map(t => ({ ...t,
    evidence: [...t.evidence, { pageIndex: neighbor.index, quote: neighbor.markdown }] }));
  await test.run();
  expect(test.calls).toHaveLength(1);
  expect(test.verify).toHaveBeenCalledTimes(1);
});

it("leaves dialogue naturalness to review when the unchanged original already has spoken text", async () => {
  const test = setup([captured.candidate]);
  test.options.pages = captured.pages.map(p => [2,8].includes(p.index) ? { ...p, markdown: p.markdown + '\n\n“Wait!” Rabbit called.' } : p);
  await test.run();
  expect(test.calls).toHaveLength(1);
  expect(test.verify).toHaveBeenCalledTimes(1);
});

it("does not interpret a prohibition as a positive local dialogue obligation", async () => {
  const test = setup([captured.candidate]);
  test.options.plan = { ...plan, requirementInventory: { ...plan.requirementInventory,
    requirements: plan.requirementInventory.requirements.map(r => r.quote === "natural dialogue" ? { ...r, kind: "prohibition" } : r) } };
  await test.run();
  expect(test.calls).toHaveLength(1);
  expect(test.verify).toHaveBeenCalledTimes(1);
});

it("does not turn ungrounded targets into local repair orders", async () => {
  const test = setup([captured.candidate]);
  test.options.requirementTargets = test.options.requirementTargets!.map(t => ({ ...t,
    evidence: [{ pageIndex: t.pageIndex, quote: "This quotation is absent from the manuscript." }] }));
  await expect(test.run()).rejects.toThrow("Requirement repair targets do not match the frozen brief and prose.");
  expect(test.calls).toHaveLength(0);
  expect(test.verify).not.toHaveBeenCalled();
});

it("does not approve a changed page merely because its local omission was attempted", async () => {
  const attempted = { ...corrected, pages: corrected.pages.map(p => ({ ...p,
    patches: p.patches.map(patch => ({ ...patch, replace: patch.find + "\n\nRabbit looked up." })) })) };
  const test = setup([attempted, attempted]);
  const rejection = new RepairRejectedError("semantic_regression", [2,8], "Spoken dialogue is still missing.");
  test.verify.mockResolvedValue({ rejection, failures: [2,8].map(pageIndex => ({ pageIndex, issues: [rejection.message] })) });
  await expect(test.run()).rejects.toBe(rejection);
  expect(test.calls).toHaveLength(2);
  expect(test.verify).toHaveBeenCalledTimes(1);
});
