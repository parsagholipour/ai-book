import { expect, it, vi } from "vitest";
import { createProjectSchema, FakeTextModelAdapter, makeFallbackPlan, type GenerateJsonOptions } from "@book-maker/core";
import { checkedShortBookRepairCandidate } from "./compileShortBookRepairCandidate.js";
import { RepairRejectedError } from "./compileRepairOutcome.js";

const input = createProjectSchema.parse({ prompt: "Rabbit helps Turtle cross a brook.", category: "KIDS", targetPages: 5 });
const plan = makeFallbackPlan(input);
const pages = Array.from({ length: 5 }, (_, i) => ({ index: i + 1, title: `Moment ${i + 1}`,
  markdown: `Rabbit and Turtle prepare to cross the brook for the ${i + 1} time.`, summary: "They prepare." }));
const issues = [{ pageIndexes: [3], messages: ["Pages 2–4 repeat preparation; combine it and develop the crossing's consequence."] }];
function setup(accept: boolean) {
  const model = new FakeTextModelAdapter(), calls: GenerateJsonOptions<unknown>[] = [];
  model.generateJson = async request => {
    calls.push(request);
    const data = request.schema.parse({ pages: [], sceneRevisions: [{ reason: "Develop one connected crossing sequence.",
      pages: [2, 3, 4].map(pageIndex => ({ pageIndex, summary: "They help each other cross.",
        markdown: `Revision ${calls.length}: Rabbit steadies the branch while Turtle crosses at moment ${pageIndex}.` })) }] });
    return { data, text: JSON.stringify(data), model: "fixture", provider: "fixture" };
  };
  const verify = vi.fn(async (candidate: Awaited<ReturnType<typeof checkedShortBookRepairCandidate>>) => {
    expect(candidate.context.sceneRevisions?.[0]?.pageIndexes).toEqual([2, 3, 4]);
    expect(candidate.context.changes.map(change => change.originalMarkdown)).toEqual(pages.slice(1, 4).map(page => page.markdown));
    return accept ? undefined : { rejection: new RepairRejectedError("target_unresolved", [3], "The sequence still repeats."),
      failures: [{ pageIndex: 3, issues: ["The sequence still repeats."] }] };
  });
  return { calls, verify, run: () => checkedShortBookRepairCandidate({ input, plan, pages, issues, textModel: model,
    assertActive: async () => {}, check: async () => [], verify }) };
}

it("sends the complete scene through the existing acceptance gate without an extra edit pass", async () => {
  const test = setup(true);
  const candidate = await test.run();
  expect(test.calls).toHaveLength(1);
  expect(test.verify).toHaveBeenCalledTimes(1);
  expect(candidate.pages[0]).toEqual(pages[0]);
  expect(candidate.pages[4]).toEqual(pages[4]);
});

it("allows only the existing final correction and always uses the frozen original scene", async () => {
  const test = setup(false);
  await expect(test.run()).rejects.toThrow("The sequence still repeats.");
  expect(test.calls).toHaveLength(2);
  expect(test.verify).toHaveBeenCalledTimes(2);
  expect(JSON.parse(test.calls[1]!.messages.at(-1)!.content).pages).toEqual(pages);
  expect(test.calls[0]!.textAttemptBudget).toBe(test.calls[1]!.textAttemptBudget);
});
