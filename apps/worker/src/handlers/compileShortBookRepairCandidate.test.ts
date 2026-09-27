import { expect, it, vi } from "vitest";
import { bookPlanSchema, createProjectSchema, FakeTextModelAdapter, reviewPageDraftLocally, type GenerateJsonOptions } from "@book-maker/core";
import { checkedShortBookRepairCandidate } from "./compileShortBookRepairCandidate.js";
import { RepairRejectedError } from "./compileRepairOutcome.js";
import { StopRequestedError } from "../runtime/jobTypes.js";
import captured from "./testing/omittedRepair0338.json" with { type: "json" };

const input = createProjectSchema.parse(captured.input), plan = bookPlanSchema.parse(captured.plan);
const p29 = captured.pages[28]!;
const correction = { pages: [...captured.patch.pages, { pageIndex: 29, reason: "Split the food sentence to resolve the omitted original target.", summary: null,
  patches: [{ find: "Honey rolls, crisp apples, and warm seed cakes filled the clearing with a sweet smell.",
    replace: "Honey rolls, crisp apples, and warm seed cakes filled the clearing. They smelled sweet." }] }] };

function setup(responses: unknown[] = [captured.patch, correction]) {
  const model = new FakeTextModelAdapter(), calls: GenerateJsonOptions<unknown>[] = [];
  model.generateJson = async request => {
    const raw = responses[calls.length]; calls.push(request);
    return { data: request.schema.parse(raw), text: JSON.stringify(raw), provider: "captured", model: "captured" };
  };
  const options: Parameters<typeof checkedShortBookRepairCandidate>[0] = {
    ...captured, input, plan, textModel: model, assertActive: async () => {},
    check: async proposed => proposed.pages.flatMap(page => {
      const report = reviewPageDraftLocally({ input, plan, pageIndex: page.index, draft: { ...page, continuityNotes: [] },
        previousPages: proposed.pages.filter(p => p.index < page.index), nextPages: proposed.pages.filter(p => p.index > page.index), continuityNotes: [] });
      return report.approved ? [] : [{ pageIndex: page.index, issues: report.issues }];
    }), verify: vi.fn(async () => undefined)
  };
  return { options, calls, model, run: () => checkedShortBookRepairCandidate(options) };
}

it("uses the existing correction for Premium's omitted page 29, retaining the page 19 patch", async () => {
  const test = setup(), { calls } = test;
  const candidate = await test.run();
  expect(calls).toHaveLength(2);
  expect(test.options.verify).toHaveBeenCalledTimes(1);
  expect(candidate.context.changes.map(p => p.pageIndex)).toEqual([19, 29]);
  expect(candidate.pages[28]!.markdown).not.toBe(p29.markdown);
  const payload = JSON.parse(calls[1]!.messages.at(-1)!.content);
  expect(payload.feedback.failures).toEqual([{ pageIndex: 29, issues: [expect.stringContaining("Sentences are too long")] }]);
  expect(payload.pages[28].markdown).toBe(p29.markdown);
  expect(payload.feedback.candidatePages.map((p: { index: number }) => p.index)).toEqual([19]);
  expect(calls[0]!.textAttemptBudget).toBe(calls[1]!.textAttemptBudget);
});

it("does not grant a third proposal when the original target is still omitted", async () => {
  const test = setup([captured.patch, captured.patch]);
  await expect(test.run()).rejects.toMatchObject({ name: "RepairRejectedError" });
  expect(test.calls).toHaveLength(2);
  expect(test.options.verify).not.toHaveBeenCalled();
});

it("cannot correct an omission after exhausting the physical attempt budget", async () => {
  const test = setup(), generate = test.model.generateJson.bind(test.model);
  test.model.generateJson = async request => {
    request.textAttemptBudget!.used = request.textAttemptBudget!.limit;
    return generate(request);
  };
  await expect(test.run()).rejects.toBeInstanceOf(RepairRejectedError);
  expect(test.calls).toHaveLength(1);
  expect(test.options.verify).not.toHaveBeenCalled();
});

it("keeps unrelated inherited local failures outside the correction scope", async () => {
  const test = setup();
  test.options.check = async () => [{ pageIndex: 1, issues: ["Unrelated inherited defect"] }];
  await expect(test.run()).rejects.toThrow("Unrelated inherited defect");
  expect(test.calls).toHaveLength(1);
  expect(test.options.verify).not.toHaveBeenCalled();
});

it("honors cancellation before correcting the omitted target", async () => {
  const test = setup();
  let checks = 0;
  test.options.assertActive = async () => { if (++checks === 3) throw new StopRequestedError(); };
  await expect(test.run()).rejects.toBeInstanceOf(StopRequestedError);
  expect(test.calls).toHaveLength(1);
  expect(test.options.verify).not.toHaveBeenCalled();
});

it("requires semantic acceptance after the omission correction without granting another proposal", async () => {
  const test = setup();
  const rejection = new RepairRejectedError("semantic_regression", [29], "The food sentence lost meaning");
  test.options.verify = vi.fn(async () => ({ rejection, failures: [{ pageIndex: 29, issues: [rejection.message] }] }));
  await expect(test.run()).rejects.toBe(rejection);
  expect(test.calls).toHaveLength(2);
  expect(test.options.verify).toHaveBeenCalledTimes(1);
});

it("corrects a sentence scope violation before review while retaining the story edit", async () => {
  const invalid = structuredClone(correction);
  invalid.pages[1]!.summary = "A rewritten summary is outside this sentence-only target.";
  const test = setup([invalid, correction]);
  const candidate = await test.run();
  expect(candidate.context.changes.map(p => p.pageIndex)).toEqual([19, 29]);
  expect(test.calls).toHaveLength(2);
  expect(test.options.verify).toHaveBeenCalledTimes(1);
  const payload = JSON.parse(test.calls[1]!.messages.at(-1)!.content);
  expect(payload.feedback.failures).toEqual([{ pageIndex: 29, issues: [expect.stringMatching(/sentence-only.*summary/i)] }]);
  expect(payload.pages[28].markdown).toBe(p29.markdown);
  expect(payload.feedback.candidatePages.map((p: { index: number }) => p.index)).toEqual([19, 29]);
});
