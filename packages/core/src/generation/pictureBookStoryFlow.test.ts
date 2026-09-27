import { expect, it } from "vitest";
import { bookPlanSchema, chapterBriefSchema, createProjectSchema } from "../schemas/book.js";
import { critiquePageMap, mergePageMapCriticPatch } from "./pageMapCritic.js";
import { pictureBookFlowAuditErrors, type PictureBookFlowAudit } from "./pictureBookStoryFlow.js";
import { generateWholeBookDraft } from "./pages.js";
import { scriptedDevelopmentModel } from "./testing/bookDevelopmentFixtures.js";
import { AdapterJsonValidationError } from "../adapters/json.js";
import lanternMaps from "./testing/lanternStoryMaps.json" with { type: "json" };

const pages = Array.from({ length: 30 }, (_, i) => ({ pageIndex: i + 1, beat: "They ask, prepare and wave to the neighbors." }));
function audit(): PictureBookFlowAudit {
  return {
    stateDependencies: [{ pageIndexes: [6, 9, 11], assessment: "Amber moves to the creek on 6; 9 and 11 must refer to its remembered landing, not a glimmer still in the hollow.", repairPageIndexes: [9, 11] }],
    setupPayoffs: [{ pageIndexes: [1, 26], assessment: "The gate hook is bent on 1; secure an alternative support before hanging the lantern on 26.", repairPageIndexes: [26] }],
    sceneProgression: [{ pageIndexes: [21, 22, 23, 24], assessment: "Combine permission and waving on 21, then let the neighbors respond and act together.", repairPageIndexes: [21, 22, 23, 24], changes: [21, 22, 23, 24].map(pageIndex => ({ pageIndex, actionQuote: "They ask, prepare and wave", change: "Another preparatory action before the same wave." })) }]
  };
}
const repairs = [9, 11, 21, 22, 23, 24, 26].map(pageIndex => ({ pageIndex }));

it("requires all linked corrections instead of leaving an acknowledged state or payoff defect for the writer", () => {
  expect(pictureBookFlowAuditErrors(audit(), pages, repairs)).toEqual([]);
  const errors = pictureBookFlowAuditErrors(audit(), pages, repairs.filter(p => ![11, 26].includes(p.pageIndex)));
  expect(errors).toHaveLength(2);
  expect(errors.join(" ")).toMatch(/page 11 needs a complete sceneRevision/);
  expect(errors.join(" ")).toMatch(/page 26 needs a complete sceneRevision/);
});

it("requires revisions that introduce complications to participate in the dependency check", () => {
  expect(pictureBookFlowAuditErrors({ stateDependencies: [], setupPayoffs: [], sceneProgression: [] }, pages, [{ pageIndex: 1 }]))
    .toEqual([expect.stringContaining("downstream effects of new complications")]);
});

it.each(["unknown scene", "duplicate scene", "duplicate repair", "unknown repair"])("rejects %s references", defect => {
  const flow = audit();
  const check = flow.stateDependencies[0]!;
  if (defect === "unknown scene") check.pageIndexes.push(31);
  if (defect === "duplicate scene") check.pageIndexes.push(6);
  if (defect === "duplicate repair") check.repairPageIndexes.push(9);
  if (defect === "unknown repair") check.repairPageIndexes.push(31);
  expect(pictureBookFlowAuditErrors(flow, pages, repairs).length).toBeGreaterThan(0);
});

it("rejects a pacing judgment based on invented actions or skipped pages", () => {
  const flow = audit();
  flow.sceneProgression[0]!.changes[0]!.actionQuote = "The neighbors answer the signal.";
  flow.sceneProgression[0]!.changes.pop();
  expect(pictureBookFlowAuditErrors(flow, pages, repairs)).toEqual([
    expect.stringContaining("each checked page exactly once"), expect.stringContaining("exact span from the INPUT beat")
  ]);
});

it("does not accept the old warning-only contract, and uses the existing bounded correction", async () => {
  const f = lanternMaps.fast;
  const input = createProjectSchema.parse(f.input), plan = bookPlanSchema.parse(f.plan);
  const briefs = f.briefs.map(b => chapterBriefSchema.parse(b));
  const fixture = scriptedDevelopmentModel([
    new AdapterJsonValidationError("Fixture", "critique-page-map", ["sceneRevisions"], "flowAudit is required", '{"sceneRevisions":[]}', { sceneRevisions: [] }),
    { sceneRevisions: [], flowAudit: { stateDependencies: [], setupPayoffs: [], sceneProgression: [] } }
  ]);
  const patch = await critiquePageMap({ input, plan, briefs, promises: plan.promises, textModel: fixture.model });
  expect(patch.beatPatches).toEqual([]);
  expect(fixture.calls).toHaveLength(2);
});

it("enacts the linked repair through merge and drafting without passing another ledger or adding calls", async () => {
  const f = lanternMaps.premium;
  const input = createProjectSchema.parse(f.input), plan = bookPlanSchema.parse(f.plan);
  const briefs = f.briefs.map(b => chapterBriefSchema.parse(b));
  const response = { flowAudit: { stateDependencies: [], sceneProgression: [], setupPayoffs: [{
    pageIndexes: [1, 26], assessment: "The damaged gate hook needs an alternative support before reuse on 26.", repairPageIndexes: [26]
  }] }, sceneRevisions: [{ pageIndex: 26, reason: "Pay off the damaged hook before rehanging the lantern.", relatedPageIndexes: [1, 26],
    purpose: "Rabbit secures a working support at the gate",
    beat: "Rabbit loops the lantern cord around a sturdy gate branch above the bent hook, then gently tests its hold.",
    endingPressure: "The neighbors can now follow the safely restored gate light.",
    requiredContinuity: ["The bent hook remains damaged; the branch supports the gate lantern."], imageMoment: null }] };
  const model = scriptedDevelopmentModel([response]);
  const patch = await critiquePageMap({ input, plan, briefs, promises: plan.promises, textModel: model.model });
  const merged = mergePageMapCriticPatch(briefs, patch, 30).map(b => chapterBriefSchema.parse(JSON.parse(JSON.stringify(b))));
  const writer = scriptedDevelopmentModel([{ pages: briefs.flatMap(b => b.pages).map(p => ({ index: p.pageIndex,
    title: `Scene ${p.pageIndex}`, markdown: "Rabbit paused beside Turtle, then held the branch steady.", summary: "They help each other.", continuityNotes: [] })) }]);
  await generateWholeBookDraft({ input, plan, chapterBriefs: merged, researchNotes: [], textModel: writer.model });
  const payload = JSON.parse(writer.calls[0]!.messages.at(-1)!.content);
  expect(payload.pageMap.find((p: { pageIndex: number }) => p.pageIndex === 26).beat).toBe(response.sceneRevisions[0]!.beat);
  expect(JSON.stringify(payload)).not.toContain("flowAudit");
  expect(JSON.stringify(payload)).not.toContain("storyFlow");
  expect(model.calls).toHaveLength(1);
  expect(writer.calls).toHaveLength(1);
});
