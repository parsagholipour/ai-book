import { expect, it, vi } from "vitest";
import { AdapterJsonValidationError } from "../adapters/json.js";
import type { TextModelAdapter } from "../adapters/types.js";
import { bookPlanSchema, chapterBriefSchema, createProjectSchema } from "../schemas/book.js";
import { critiquePageMap } from "./pageMapCritic.js";
import { scriptedDevelopmentModel } from "./testing/bookDevelopmentFixtures.js";
import lanternMaps from "./testing/lanternStoryMaps.json" with { type: "json" };

function response() {
  return { flowAudit: {
    stateDependencies: [{ pageIndexes: [1, 26], assessment: "The hook stays bent from the storm until its later use, so page 26 needs a working support.", repairPageIndexes: [26] }],
    setupPayoffs: [{ pageIndexes: [1, 26], assessment: "Secure an alternative support before returning the gate lantern.", repairPageIndexes: [26] }],
    sceneProgression: []
  }, sceneRevisions: [{ pageIndex: 26, reason: "Resolve the damaged hook before reuse.", relatedPageIndexes: [1, 26],
    purpose: "Secure a working support for the gate lantern", beat: "Rabbit secures the lantern cord to a stout branch above the bent hook and tests its hold.",
    endingPressure: "The restored gate light now guides the neighbors safely.", requiredContinuity: ["The branch supports the lantern; the hook remains bent."], imageMoment: null }] };
}
const failure = () => new AdapterJsonValidationError("Fixture", "critique-page-map", ["flowAudit", "sceneRevisions"],
  "A progression quote did not match its input beat.", JSON.stringify(response()), response());
function book() {
  const f = lanternMaps.premium;
  return { input: createProjectSchema.parse(f.input), plan: bookPlanSchema.parse(f.plan),
    briefs: f.briefs.map(b => chapterBriefSchema.parse(b)), promises: [] };
}

it("rejects a format retry that erases an identified repair and returns a clean map", async () => {
  const model = scriptedDevelopmentModel([failure(), { flowAudit: { stateDependencies: [], setupPayoffs: [], sceneProgression: [] }, sceneRevisions: [] }]);
  await expect(critiquePageMap({ ...book(), textModel: model.model })).rejects.toThrow(/Retain the identified repair on page 26/);
  expect(model.calls).toHaveLength(2);
});

it("keeps the repair targets and reviewed scenes available while correcting the response on the same model route", async () => {
  const model = scriptedDevelopmentModel([failure(), response()]);
  const adapter: TextModelAdapter = model.model;
  const bindForCall = vi.fn(async () => ({ adapter }));
  adapter.bindForCall = bindForCall;
  const patch = await critiquePageMap({ ...book(), textModel: model.model });
  expect(patch.beatPatches[0]?.beat).toBe(response().sceneRevisions[0]!.beat);
  expect(model.calls).toHaveLength(2);
  expect(bindForCall).toHaveBeenCalledTimes(1);
  const recovery = JSON.parse(model.calls[1]!.messages.at(-1)!.content);
  expect(recovery.priorRepairTargets).toEqual([{ pageIndex: 26, reason: response().sceneRevisions[0]!.reason, proposedBeat: response().sceneRevisions[0]!.beat }]);
  expect(recovery.priorReviewedPageIndexes.setupPayoffs).toEqual([1, 26]);
});

it("rejects disappearing audit coverage even when the page revision survives", async () => {
  const corrected = response();
  corrected.flowAudit.stateDependencies = [];
  const model = scriptedDevelopmentModel([failure(), corrected]);
  await expect(critiquePageMap({ ...book(), textModel: model.model })).rejects.toThrow(/Retain stateDependencies checks for pages 1, 26/);
});

it("does not retry cancellation or provider errors", async () => {
  const error = new Error("Request aborted"); error.name = "AbortError";
  const model = scriptedDevelopmentModel([error]);
  await expect(critiquePageMap({ ...book(), textModel: model.model })).rejects.toBe(error);
  expect(model.calls).toHaveLength(1);
});
