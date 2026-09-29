import { expect, it } from "vitest";
import capture from "./testing/optionalPagePolicy0928.json" with { type: "json" };
import { inventoryManuscriptRequirements, manuscriptCoverageSchema, refreshManuscriptCoverageFacts, reviewManuscriptCoverage, type CoverageEvidenceContext } from "./manuscriptCoverage.js";
import { manuscriptRequirementInventorySchema } from "../schemas/manuscriptRequirements.js";
import { scriptedDevelopmentModel } from "./testing/bookDevelopmentFixtures.js";

const clause = "Extra pages are optional and must add meaningful progression.";
const pagesFor = (count: number) => Array.from({ length: count }, (_, i) => ({ index: i + 1,
  markdown: `Rabbit finds a new clue and chooses a different path on page ${i + 1}.` }));
const contextFor = (count: number): CoverageEvidenceContext => ({ title: "The Lantern Path", targetStoryPages: count,
  requestedStoryPages: 30, storyPageCountBounds: { minimumPages: count, maximumPages: count },
  storyPageIndexes: pagesFor(count).map(page => page.index), illustratedPageIndexes: [], expectedIllustratedPageIndexes: [],
  characters: [], referenceProvenance: [] });
const inventory = () => manuscriptRequirementInventorySchema.parse({ version: 1, status: "available", complete: true,
  brief: capture.brief, requirements: capture.requirements });

it("replays Premium's split optional permission without demanding a manuscript quotation", async () => {
  const { model, calls } = scriptedDevelopmentModel([{ complete: true,
    requirements: capture.verdicts.map(v => ({ ...v, id: "brief-1" })) }]);
  const result = await reviewManuscriptCoverage({ brief: capture.brief, promises: [], pages: pagesFor(30),
    evidenceContext: contextFor(30), inventory: inventory(), textModel: model });
  expect(result.requirements.map(r => r.status)).toEqual(["fulfilled", "fulfilled"]);
  expect(result.issues).toEqual([]);
  expect(result.status).toBe("reviewed");
  expect(calls).toHaveLength(1);
  expect(JSON.parse(calls[0]!.messages[1]!.content).requirements).toEqual([]);
});

it("freezes one complete conditional obligation when inventory splits permission from its duty", async () => {
  const { model, calls } = scriptedDevelopmentModel([{ complete: true, requirements: capture.requirements }]);
  const result = await inventoryManuscriptRequirements({ brief: capture.brief, textModel: model, requireScope: true });
  expect(result.requirements).toHaveLength(1);
  expect(result.requirements[0]).toMatchObject({ kind: "content", quote: clause,
    scope: { quote: clause, extent: "specified" } });
  expect(result.complete).toBe(true);
  expect(calls).toHaveLength(1);
});

async function reviewSplit(count: number, evidence: { pageIndex: number; quote: string }[], fields: object = {}) {
  const { model, calls } = scriptedDevelopmentModel([{ complete: true, requirements: [
    { id: "brief-1", status: "fulfilled", reason: "The additional scenes progress the story.", evidence, ...fields }
  ] }]);
  const result = await reviewManuscriptCoverage({ brief: capture.brief, promises: [], pages: pagesFor(count),
    evidenceContext: contextFor(count), inventory: inventory(), textModel: model });
  return { result, calls };
}

it.each([31, 32, 33])("judges split legacy obligations once and requires evidence from every added page at %i pages", async count => {
  const empty = await reviewSplit(count, []);
  expect(empty.result.requirements.map(r => r.status)).toEqual(["unverified", "unverified"]);
  const baseOnly = await reviewSplit(count, [{ pageIndex: 30, quote: pagesFor(count)[29]!.markdown }]);
  expect(baseOnly.result.requirements.every(r => r.status === "unverified")).toBe(true);
  const evidence = pagesFor(count).slice(30).map(page => ({ pageIndex: page.index, quote: page.markdown }));
  const { result, calls } = await reviewSplit(count, evidence);
  expect(result.requirements.map(r => r.status)).toEqual(["fulfilled", "fulfilled"]);
  expect(new Set(result.requirements.map(r => r.obligationId)).size).toBe(1);
  expect(result.requirements.map(r => r.id)).toEqual(["brief-1", "brief-2"]);
  expect(calls).toHaveLength(1);
  const request = JSON.parse(calls[0]!.messages[1]!.content);
  expect(request.requirements).toHaveLength(1);
  expect(request.requirements[0]).toMatchObject({ quote: clause,
    applicability: { status: "applicable", extraPageIndexes: evidence.map(e => e.pageIndex) } });
  if (count > 31) {
    expect((await reviewSplit(count, evidence.slice(0, -1))).result.requirements.every(r => r.status === "unverified")).toBe(true);
  }
});

it("retains the missing-progression verdict instead of granting an optionality exemption", async () => {
  const { result } = await reviewSplit(31, [{ pageIndex: 31, quote: pagesFor(31)[30]!.markdown }], {
    status: "missing", reason: "The added scene repeats an earlier clue without a new consequence.",
    scopeAssessment: { supported: true, authority: "brief", quote: clause, extent: "specified", explanation: "An added page must progress the story." }
  });
  expect(result.requirements.map(r => r.status)).toEqual(["missing", "missing"]);
  expect(result.issues.map(issue => issue.code)).toContain("MISSING_BRIEF_REQUIREMENT");
});

it.each(["Extra pages are optional", "must add meaningful progression", "add meaningful progression", "and must add meaningful progression."])("recovers the complete duty even when inventory keeps only %s", async quote => {
  const raw = { ...capture.requirements[0], quote };
  const { model, calls } = scriptedDevelopmentModel([{ complete: true, requirements: [raw] },
    { complete: true, requirements: [{ id: "brief-1", status: "fulfilled", reason: "Optional", evidence: [] }] }]);
  const frozen = await inventoryManuscriptRequirements({ brief: capture.brief, textModel: model, requireScope: true });
  expect(frozen.requirements[0]?.quote).toBe(clause);
  const restored = manuscriptRequirementInventorySchema.parse(JSON.parse(JSON.stringify(frozen)));
  const result = await reviewManuscriptCoverage({ brief: capture.brief, promises: [], pages: pagesFor(31),
    evidenceContext: contextFor(31), inventory: restored, textModel: model });
  expect(result.requirements[0]).toMatchObject({ status: "unverified", applicability: { status: "applicable", extraPageIndexes: [31] } });
  expect(calls).toHaveLength(2); // existing inventory + existing coverage only
});

it("refreshes a saved 30-page false failure without granting that pass to added pages", () => {
  const stored = manuscriptCoverageSchema.parse({ status: "incomplete", assessmentComplete: true,
    requirements: inventory().requirements.map((r, i) => ({ ...r, id: `brief-${i + 1}`, source: "brief",
      status: i ? "fulfilled" : "unverified", reason: "The story uses the requested 30 pages.", evidence: [] })) });
  const refreshed = refreshManuscriptCoverageFacts(stored, contextFor(30), pagesFor(30), capture.brief);
  expect(refreshed.requirements.every(r => r.status === "fulfilled")).toBe(true);
  expect(refreshed.status).toBe("reviewed");
  const restored = manuscriptCoverageSchema.parse(JSON.parse(JSON.stringify(refreshed)));
  expect(refreshManuscriptCoverageFacts(restored, contextFor(31), pagesFor(31), capture.brief).requirements
    .every(r => r.status === "unverified" && r.applicability?.status === "applicable")).toBe(true);
  expect(refreshManuscriptCoverageFacts({ ...stored, assessmentComplete: false }, contextFor(30), pagesFor(30), capture.brief).status).toBe("incomplete");
});

it.each([
  { quote: "Extra pages are optional", scope: { extent: "each_page", quote: clause }, brief: clause },
  { quote: "Extra pages are optional", scope: { extent: "whole_book", quote: `${clause} Rabbit must rescue Turtle.` }, brief: `${clause} Rabbit must rescue Turtle.` },
  { quote: "Extra pages are optional", scope: { extent: "whole_book", quote: clause }, brief: "Extra pages are optional." },
  { quote: "Every page must progress the story.", scope: { extent: "whole_book", quote: "Every page must progress the story." }, brief: "Every page must progress the story." },
  { quote: "Extra pages are optional but must resolve Turtle's arc.", scope: { extent: "whole_book", quote: "Extra pages are optional but must resolve Turtle's arc." }, brief: "Extra pages are optional but must resolve Turtle's arc." }
])("does not waive a different, compound or ungrounded obligation: $quote ($scope.extent)", async ({ quote, scope, brief }) => {
  const { model } = scriptedDevelopmentModel([{ complete: true, requirements: [
    { id: "brief-1", status: "fulfilled", reason: "Optional", evidence: [] }
  ] }]);
  const supplied = manuscriptRequirementInventorySchema.parse({ brief, version: 1, complete: true, status: "available",
    requirements: [{ text: "Meaningful progression on optional extra pages", kind: "content", quote, scope }] });
  const result = await reviewManuscriptCoverage({ brief, promises: [], pages: pagesFor(30),
    evidenceContext: contextFor(30), inventory: supplied, textModel: model });
  expect(result.requirements[0]?.status).toBe("unverified");
  expect(result.requirements[0]?.quote).toBe(quote);
  expect(refreshManuscriptCoverageFacts(result, contextFor(30), pagesFor(30), brief).requirements[0]?.status).toBe("unverified");
});
