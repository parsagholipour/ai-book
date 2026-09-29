import { expect, it } from "vitest";
import { manuscriptCoverageSchema, refreshManuscriptCoverageFacts, reviewManuscriptCoverage, type CoverageEvidenceContext } from "./manuscriptCoverage.js";
import { manuscriptRequirementInventorySchema } from "../schemas/manuscriptRequirements.js";
import { scriptedDevelopmentModel } from "./testing/bookDevelopmentFixtures.js";
import captures from "./testing/extraPageProgression.json" with { type: "json" };

const clause = "Extra pages are optional and must add meaningful progression.";
const pagesFor = (count: number) => Array.from({ length: count }, (_, i) => ({ index: i + 1,
  markdown: `On page ${i + 1}, Rabbit finds a new clue and chooses a different path.` }));
const contextFor = (count = 30): CoverageEvidenceContext => ({ title: "The Lantern Path", targetStoryPages: count,
  requestedStoryPages: 30, storyPageCountBounds: { minimumPages: count, maximumPages: count },
  storyPageIndexes: pagesFor(count).map(page => page.index), illustratedPageIndexes: [], expectedIllustratedPageIndexes: [],
  characters: [], referenceProvenance: [] });
const requirement = { text: "Meaningful progression on extra pages", kind: "content" as const, quote: clause,
  scope: { extent: "specified" as const, quote: clause } };
const answer = { id: "brief-1", status: "fulfilled", reason: "No extra pages require progression.", evidence: [] };
async function review(options: {
  count?: number; context?: CoverageEvidenceContext | undefined; pages?: ReturnType<typeof pagesFor>;
  brief?: string; requirement?: typeof requirement; answer?: unknown; complete?: boolean;
} = {}) {
  const count = options.count ?? 30, brief = options.brief ?? clause;
  const { model, calls } = scriptedDevelopmentModel([{ complete: options.complete ?? true, requirements: [options.answer ?? answer] }]);
  const result = await reviewManuscriptCoverage({ brief, promises: [], pages: options.pages ?? pagesFor(count),
    evidenceContext: "context" in options ? options.context : contextFor(count), textModel: model,
    inventory: { brief, status: "available", complete: true, requirements: [options.requirement ?? requirement] } });
  return { result, calls };
}

it.each(captures)("settles $tier's captured optional condition at the requested minimum without fabricated prose evidence", async capture => {
  const inventory = manuscriptRequirementInventorySchema.parse({ status: "available", complete: true, brief: capture.brief,
    requirements: [capture.requirement] });
  const { model, calls } = scriptedDevelopmentModel([{ complete: true, requirements: [{ ...capture.verdict, id: "brief-1" }] }]);
  const result = await reviewManuscriptCoverage({ brief: capture.brief, promises: [], pages: pagesFor(30),
    evidenceContext: contextFor(), inventory, textModel: model });
  expect(result.status).toBe("reviewed");
  expect(result.requirements[0]).toMatchObject({ status: "fulfilled", evidence: [],
    applicability: { kind: "extra_story_pages", status: "not_applicable", requestedStoryPages: 30, extraPageIndexes: [] } });
  expect(result.issues).toEqual([]);
  expect(calls).toHaveLength(1);
  expect(JSON.parse(calls[0]!.messages[1]!.content).requirements).toEqual([]);
  expect(manuscriptCoverageSchema.parse(result).requirements).toEqual(result.requirements);
});

it.each([31, 32, 33])("requires exact progression evidence for every added page in a %i-page book", async count => {
  const without = await review({ count });
  expect(without.result.requirements[0]?.status).toBe("unverified");
  const baseOnly = await review({ count, answer: { ...answer, evidence: [{ pageIndex: 30, quote: pagesFor(count)[29]!.markdown }] } });
  expect(baseOnly.result.requirements[0]?.status).toBe("unverified");
  const evidence = pagesFor(count).slice(30).map(page => ({ pageIndex: page.index, quote: page.markdown }));
  const supported = await review({ count, answer: { ...answer, reason: "Each extra scene adds a clue and a consequential choice.", evidence } });
  expect(supported.result.requirements[0]).toMatchObject({ status: "fulfilled", evidence,
    applicability: { status: "applicable", requestedStoryPages: 30, extraPageIndexes: evidence.map(e => e.pageIndex) } });
  expect(JSON.parse(supported.calls[0]!.messages[1]!.content).requirements[0].applicability.extraPageIndexes).toEqual(evidence.map(e => e.pageIndex));
  expect(supported.calls).toHaveLength(1);
});

it("preserves a grounded missing-progression diagnosis for actual extra pages", async () => {
  const { result } = await review({ count: 31, answer: { ...answer, status: "missing", reason: "Page 31 only repeats the prior conclusion.",
    evidence: [{ pageIndex: 31, quote: pagesFor(31)[30]!.markdown }],
    scopeAssessment: { supported: true, authority: "brief", extent: "specified", quote: clause, explanation: "The optional extra page needs progression." } } });
  expect(result.requirements[0]?.status).toBe("missing");
  expect(result.issues[0]?.code).toBe("MISSING_BRIEF_REQUIREMENT");
});

const unknownMinimum = contextFor();
delete unknownMinimum.requestedStoryPages;
it.each([
  { name: "missing context", context: undefined },
  { name: "unknown original minimum", context: unknownMinimum },
  { name: "missing base page", context: contextFor(29) },
  { name: "missing selected page", context: { ...contextFor(33), storyPageIndexes: contextFor().storyPageIndexes } },
  { name: "duplicate indexes", context: { ...contextFor(), storyPageIndexes: [...contextFor().storyPageIndexes.slice(0, 29), 29] } },
  { name: "shifted indexes", context: { ...contextFor(), storyPageIndexes: contextFor().storyPageIndexes.map(i => i + 1) } }
])("does not waive progression with $name", async ({ context }) => {
  const { result } = await review({ context });
  expect(result.requirements[0]).toMatchObject({ status: "unverified", applicability: { status: "unverified" } });
});

it("does not let the fact inventory hide a page actually sent for review", async () => {
  const { result } = await review({ pages: pagesFor(31), context: contextFor(30) });
  expect(result.requirements[0]?.status).toBe("unverified");
  expect(refreshManuscriptCoverageFacts(result, contextFor(30), pagesFor(31)).requirements[0]?.status).toBe("unverified");
});

it("does not accept model-supplied non-applicability when extra pages exist", async () => {
  const { result } = await review({ count: 31, answer: { ...answer,
    applicability: { kind: "extra_story_pages", status: "not_applicable", requestedStoryPages: 31, extraPageIndexes: [] } } });
  expect(result.requirements[0]).toMatchObject({ status: "unverified", applicability: { status: "applicable", requestedStoryPages: 30 } });
});

it("does not infer conditional scope from the label or waive a compound obligation", async () => {
  for (const quote of ["Every page must add meaningful progression.", `${clause} Rabbit must rescue Turtle.`]) {
    const { result } = await review({ brief: quote, requirement: { ...requirement, quote, scope: { extent: "specified", quote } } });
    expect(result.requirements[0]?.status).toBe("unverified");
    expect(result.requirements[0]).not.toHaveProperty("applicability");
  }
});

it("does not waive an ungrounded requirement or silently complete an unfinished read", async () => {
  const ungrounded = await review({ brief: "Tell a story with meaningful progression." });
  expect(ungrounded.result.requirements[0]?.status).toBe("unverified");
  const ungroundedScope = await review({ brief: clause.slice(0, -1), requirement: { ...requirement, quote: clause.slice(0, -1) } });
  expect(ungroundedScope.result.requirements[0]?.status).toBe("unverified");
  expect(refreshManuscriptCoverageFacts(ungroundedScope.result, contextFor()).requirements[0]?.status).toBe("unverified");
  const unfinished = await review({ complete: false });
  expect(unfinished.result.status).toBe("incomplete");
});

it("recomputes applicability after serialization without granting a prior no-extra-page pass to new pages", async () => {
  const original = manuscriptCoverageSchema.parse((await review()).result);
  const restored = manuscriptCoverageSchema.parse(JSON.parse(JSON.stringify(original)));
  expect(refreshManuscriptCoverageFacts(restored, contextFor()).status).toBe("reviewed");
  const changed = refreshManuscriptCoverageFacts(restored, contextFor(31));
  expect(changed.requirements[0]).toMatchObject({ status: "unverified", applicability: { status: "applicable", extraPageIndexes: [31] } });
  const missing = refreshManuscriptCoverageFacts(restored, { ...contextFor(33), storyPageIndexes: contextFor().storyPageIndexes });
  expect(missing.requirements[0]?.status).toBe("unverified");
});
