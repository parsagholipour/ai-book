import { expect, it, vi } from "vitest";
import { bookPlanSchema, createProjectSchema } from "../schemas/book.js";
import { FakeTextModelAdapter } from "../adapters/fake.js";
import { parseSchemaWithContext } from "../adapters/json.js";
import { critiquePlan, mergePlanCriticPatch, planCriticPatchSchema } from "./planCritic.js";
import { generateWholeBookPageMap } from "./pagesPageMap.js";
import { scriptedDevelopmentModel } from "./testing/bookDevelopmentFixtures.js";
import captured from "./testing/storyCriticLantern.json" with { type: "json" };

const input = createProjectSchema.parse(captured.input);
const plan = bookPlanSchema.parse(captured.plan);
const quote = "The neighbors waited at the picnic meadow, hoping to find the path before moonrise.";
function correction() {
  return { storyRevision: {
    reason: "The neighbors must start outside the picnic destination, and Rabbit's proposed wrong destination must differ from the right one.",
    evidenceQuotes: [quote, "Rabbit wanted to carry it straight to the meadow."],
    storyTreatment: plan.storyTreatment!
      .replace(quote, "The neighbors waited outside the woodland gate, hoping to reach the picnic before moonrise.")
      .replace("Rabbit wanted to carry it straight to the meadow.", "Rabbit wanted to leave it at the reed gate.")
      .replace("The light now joined the amber and blue lanterns in the correct order.", "Green lit the brook, but amber and blue still needed their proper posts.")
      .replace("At the meadow, the last neighbors were waiting beneath the trees.", "Rabbit returned blue to the birch and amber to the gate. The last neighbors waited by the brambles."),
    premise: "Rabbit and Wise Turtle restore the lanterns and bring waiting neighbors from the woodland gate to the picnic meadow.",
    openingHook: "A storm scatters the lanterns while the neighbors wait outside the woodland gate.",
    continuityRules: [...plan.continuityRules, "The neighbors begin at the woodland gate and reach the meadow only after following the restored path."],
    locations: plan.locations.map(location => ({ ...location, rules: location.name === "Picnic meadow"
      ? [...location.rules, "The neighbors arrive here after following the restored lantern path."] : location.rules }))
  } };
}

it("gives the existing critic the captured treatment, canon and causal contracts", async () => {
  const fixture = scriptedDevelopmentModel([{}]);
  await critiquePlan({ plan, userPrompt: input.prompt, textModel: fixture.model });
  expect(fixture.calls).toHaveLength(1);
  const request = fixture.calls[0]!;
  const payload = JSON.parse(request.messages.at(-1)!.content);
  expect(request.purpose).toBe("critique-plan");
  expect(payload.storyTreatment).toBe(plan.storyTreatment);
  expect(payload.characters).toEqual(plan.characters);
  expect(payload.locations).toEqual(plan.locations);
  expect(payload.continuityRules).toEqual(plan.continuityRules);
  expect(payload.userPrompt).toBe(input.prompt);
  expect(request.messages[0]!.content).toContain("storyRevision");
});

it("persists the corrected treatment and metadata into allocation with one critic call", async () => {
  const original = structuredClone(plan);
  const fixture = scriptedDevelopmentModel([correction()]);
  const patch = await critiquePlan({ plan, userPrompt: input.prompt, textModel: fixture.model });
  const merged = mergePlanCriticPatch(plan, patch, { input });
  const resumed = bookPlanSchema.parse(JSON.parse(JSON.stringify(merged)));
  const { reason: _reason, evidenceQuotes: _evidence, ...correctedFields } = correction().storyRevision;
  expect(resumed).toMatchObject(correctedFields);
  expect(resumed.chapters[0]!.summary).toBe(correction().storyRevision.premise);
  expect(resumed.chapters[0]!.targetPages).toBe(30);
  expect(resumed.characters).toEqual(plan.characters);
  expect(resumed.title).toBe(plan.title);
  expect(resumed.promises).toEqual(plan.promises);
  expect(plan).toEqual(original);
  const mapper = new FakeTextModelAdapter(input);
  const calls = vi.spyOn(mapper, "generateJson");
  await generateWholeBookPageMap({ input, plan: resumed, textModel: mapper });
  const payload = JSON.parse(calls.mock.calls[0]![0].messages.at(-1)!.content);
  expect(payload.storyTreatment).toBe(correction().storyRevision.storyTreatment);
  expect(payload.storyTreatment).not.toContain(quote);
  expect(payload.book.premise).toBe(resumed.premise);
  expect(payload.book.continuityRules).toEqual(resumed.continuityRules);
  expect(payload.openingHook).toBe(resumed.openingHook);
  expect(fixture.calls).toHaveLength(1);
  expect(calls).toHaveBeenCalledTimes(1);
});

it.each(["unanchored", "missing metadata", "renamed location", "blank treatment", "extra character", "allocated"])(
  "rejects a %s story correction without mutating the plan", defect => {
    const original = structuredClone(plan);
    const value: Record<string, unknown> = structuredClone(correction().storyRevision);
    if (defect === "unanchored") value.evidenceQuotes = ["This is not in the original story."];
    if (defect === "missing metadata") delete value.continuityRules;
    if (defect === "renamed location") value.locations = [{ ...plan.locations[0], name: "A different forest" }];
    if (defect === "blank treatment") value.storyTreatment = "";
    if (defect === "extra character") value.characters = [{ name: "Fox" }];
    const target = defect === "allocated" ? { ...plan, chapters: plan.chapters.map(c => ({ ...c, keyBeats: ["Already allocated"] })) } : plan;
    expect(() => mergePlanCriticPatch(target, planCriticPatchSchema.parse({ storyRevision: value }))).toThrow();
    expect(plan).toEqual(original);
  }
);

it("keeps no-op story critiques and legacy mechanical critiques unchanged", async () => {
  const fixture = scriptedDevelopmentModel([{ storyRevision: null }]);
  const patch = await critiquePlan({ plan, textModel: fixture.model });
  expect(mergePlanCriticPatch(plan, patch)).toEqual(plan);
  const { storyTreatment: _treatment, ...legacy } = plan;
  const mechanical = scriptedDevelopmentModel([{ promisesToAdd: ["A new promise."] }]);
  const legacyPatch = await critiquePlan({ plan: legacy, textModel: mechanical.model });
  const payload = JSON.parse(mechanical.calls[0]!.messages.at(-1)!.content);
  expect(payload).not.toHaveProperty("storyTreatment");
  expect(mechanical.calls[0]!.maxTokens).toBe(1200);
  expect(mergePlanCriticPatch(legacy, legacyPatch).promises).toContain("A new promise.");
  expect(() => mergePlanCriticPatch(legacy, planCriticPatchSchema.parse(correction()))).toThrow();
});

it("rejects notes that leave the defective treatment in place or contradict its replacement", () => {
  for (const storyRevision of [null, correction().storyRevision]) {
    expect(() => mergePlanCriticPatch(plan, { storyRevision, reorderNotes: ["Move the neighbors somewhere else."] })).toThrow();
    expect(() => mergePlanCriticPatch(plan, { storyRevision, repeatedBeatWarnings: ["Avoid the defective scene."] })).toThrow();
  }
});

it("recovers an ungrounded correction through the existing schema retry before merging", async () => {
  const bad = correction();
  bad.storyRevision.evidenceQuotes = ["An invented passage that never appeared in the story."];
  const responses = [bad, correction()];
  const model = new FakeTextModelAdapter(input);
  model.generateJson = async request => {
    const raw = responses.shift();
    if (!raw) throw new Error("Unexpected critic call");
    return { data: parseSchemaWithContext("Fixture", request.schema, raw, request.purpose, JSON.stringify(raw)),
      text: JSON.stringify(raw), provider: "fixture", model: "fixture" };
  };
  const calls = vi.spyOn(model, "generateJson");
  const patch = await critiquePlan({ plan, userPrompt: input.prompt, textModel: model });
  expect(calls).toHaveBeenCalledTimes(2);
  expect(calls.mock.calls.every(([call]) => call.purpose === "critique-plan")).toBe(true);
  expect(mergePlanCriticPatch(plan, patch).storyTreatment).toBe(correction().storyRevision.storyTreatment);
});
