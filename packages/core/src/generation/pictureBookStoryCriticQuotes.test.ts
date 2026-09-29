import { expect, it, vi } from "vitest";
import { FakeTextModelAdapter } from "../adapters/fake.js";
import { parseSchemaWithContext } from "../adapters/json.js";
import { bookPlanSchema } from "../schemas/book.js";
import { critiquePlan, mergePlanCriticPatch } from "./planCritic.js";
import captures from "./testing/storyCriticQuoteWrapping.json" with { type: "json" };

// Critic requests omit plan fields that this pass never reads.
function capturedPlan(capture: typeof captures[number]) {
  return bookPlanSchema.parse({ ...capture.plan, writingComplexity: 3,
    illustrationPlan: { cadence: "manual", globalStyle: "Text-only story; no illustrations." } });
}

function replay(responses: unknown[]) {
  const model = new FakeTextModelAdapter();
  model.generateJson = async request => {
    const raw = responses.shift();
    if (!raw) throw new Error("Unexpected critic call");
    return { data: parseSchemaWithContext("Fixture", request.schema, raw, request.purpose, JSON.stringify(raw)),
      text: JSON.stringify(raw), provider: "fixture", model: "fixture" };
  };
  return { model, calls: vi.spyOn(model, "generateJson") };
}

it.each(captures)("accepts $tier's captured wrapped evidence in one call without rewriting its critique", async capture => {
  const plan = capturedPlan(capture), original = structuredClone(capture.response);
  const fixture = replay([capture.response, { storyRevision: null }]);
  const patch = await critiquePlan({ plan, userPrompt: capture.userPrompt, textModel: fixture.model });
  expect(fixture.calls).toHaveBeenCalledTimes(1);
  expect(patch).toEqual({ ...original, storyRevision: { ...original.storyRevision,
    evidenceQuotes: original.storyRevision.evidenceQuotes.map(quote => quote.slice(1, -1)) } });
  expect(patch.storyRevision?.evidenceQuotes.every(quote => plan.storyTreatment!.includes(quote))).toBe(true);
  expect(mergePlanCriticPatch(plan, patch).storyTreatment).toBe(original.storyRevision.storyTreatment);
  expect(mergePlanCriticPatch(plan, capture.response).storyTreatment).toBe(original.storyRevision.storyTreatment);
  expect(capture.response).toEqual(original);
  // Keep the provider's detailed wire schema; quote recovery must not replace it with an opaque transform.
  expect(fixture.calls.mock.calls[0]![0].messages[0]!.content).toContain('"evidenceQuotes"');
});

const base = captures[0]!;
const source = "Rabbit did not move the three lanterns.";
const plan = { ...capturedPlan(base), storyTreatment: `${source}\n${base.plan.storyTreatment}` };
const response = (quote: string) => ({ ...base.response,
  storyRevision: { ...base.response.storyRevision, evidenceQuotes: [quote] } });

it.each([source, `“${source}”`, `"${source}"`])("grounds exact evidence or one matched wrapper: %s", async quote => {
  const fixture = replay([response(quote), { storyRevision: null }]);
  const patch = await critiquePlan({ plan, textModel: fixture.model });
  expect(fixture.calls).toHaveBeenCalledTimes(1);
  expect(patch.storyRevision?.evidenceQuotes).toEqual([source]);
});

it.each(["“Do not move the three lanterns,” Rabbit said.", '"Do not move the three lanterns," Rabbit said.',
  "“Do not move the three lanterns.”", '"Do not move the three lanterns."'])(
  "preserves source dialogue punctuation, including under one added outer wrapper: %s", async dialogue => {
    const target = { ...plan, storyTreatment: `${dialogue}\n${plan.storyTreatment}` };
    for (const quote of [dialogue, `“${dialogue}”`]) {
      const fixture = replay([response(quote), { storyRevision: null }]);
      const patch = await critiquePlan({ plan: target, textModel: fixture.model });
      expect(fixture.calls).toHaveBeenCalledTimes(1);
      expect(patch.storyRevision?.evidenceQuotes).toEqual([dialogue]);
    }
  }
);

it.each([
  `“${source}"`, `"${source}”`, `“${source}`, `${source}”`, `““${source}””`,
  "“Turtle did not move the three lanterns.”", "“Rabbit did move the three lanterns.”",
  "“Rabbit did not move the four lanterns.”", "“rabbit did not move the three lanterns.”",
  "“Rabbit did not move the three lanterns!”", "“Rabbit  did not move the three lanterns.”",
  "“Rabbit … move the three lanterns.”"
])("keeps unsupported or changed wrapped evidence on the bounded retry path: %s", async quote => {
  expect(() => mergePlanCriticPatch(plan, response(quote))).toThrow(/evidence quote/);
  const fixture = replay([response(quote), response(source)]);
  const patch = await critiquePlan({ plan, textModel: fixture.model });
  expect(fixture.calls).toHaveBeenCalledTimes(2);
  expect(patch.storyRevision?.evidenceQuotes).toEqual([source]);
});

it("does not let wrapping satisfy the minimum source-evidence length", () => {
  const target = { ...plan, storyTreatment: `Rain fell.\n${plan.storyTreatment}` };
  expect(() => mergePlanCriticPatch(target, response('“Rain fell.”'))).toThrow(/evidence quote/);
});

it("requires every quote to be grounded, even alongside recoverable wrapped evidence", async () => {
  const mixed = response(`“${source}”`);
  mixed.storyRevision.evidenceQuotes.push("“Rabbit did move the three lanterns.”");
  expect(() => mergePlanCriticPatch(plan, mixed)).toThrow(/evidence quote/);
  const fixture = replay([mixed, response(source)]);
  await critiquePlan({ plan, textModel: fixture.model });
  expect(fixture.calls).toHaveBeenCalledTimes(2);
});
