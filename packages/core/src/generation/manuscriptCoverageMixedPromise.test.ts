import { expect, it } from "vitest";
import { manuscriptCoverageSchema, manuscriptRequirementInventorySchema, refreshManuscriptCoverageFacts, reviewManuscriptCoverage, type CoverageEvidenceContext } from "./manuscriptCoverage.js";
import { scriptedDevelopmentModel } from "./testing/bookDevelopmentFixtures.js";
import captures from "./testing/mixedDeliveryPromises2124.json" with { type: "json" };

const facts: CoverageEvidenceContext = { title: "The Lantern Path", targetStoryPages: 30,
  storyPageIndexes: Array.from({ length: 30 }, (_, i) => i + 1), illustratedPageIndexes: [], expectedIllustratedPageIndexes: [],
  characters: [], referenceProvenance: [], mediaInventory: { storyPagesWithArtwork: [], coverArtworkCount: 0, characterReferenceCount: 0 } };

async function review(index = 0, change: (assessment: Record<string, unknown>) => void = () => {}, complete = true, supportedScope = true) {
  const capture = captures[index]!;
  // Explicit new-contract fixture, not a claim that the historical model emitted this separation.
  const mixedPromiseAssessment: Record<string, unknown> = { promiseQuote: capture.promise,
    deliveryRequirements: capture.requirements.map((r, i) => ({ id: `brief-${i + 1}`, quote: r.quote })),
    narrative: { status: "fulfilled", reason: "The complete story reaches its gentle picnic ending.", evidence: capture.recordedVerdict.evidence } };
  change(mixedPromiseAssessment);
  const { model, calls } = scriptedDevelopmentModel([{ complete, requirements: [{ ...capture.recordedVerdict, id: "promise-1", mixedPromiseAssessment,
    scopeAssessment: { supported: supportedScope, authority: "promise", quote: capture.promise, explanation: "Assess only the promised narrative payoff." }
  }] }]);
  const result = await reviewManuscriptCoverage({ brief: capture.brief, promises: [capture.promise], pages: capture.pages, textModel: model,
    inventory: manuscriptRequirementInventorySchema.parse({ brief: capture.brief, status: "available", complete: true, requirements: capture.requirements }),
    evidenceContext: { ...facts, mediaInventory: {} } });
  return { result: manuscriptCoverageSchema.parse(JSON.parse(JSON.stringify(result))), calls };
}

it.each([0, 1])("settles captured mixed promise %s from fresh delivery facts while retaining verified narrative evidence", async index => {
  const { result, calls } = await review(index);
  expect(result.requirements.at(-1)?.status).toBe("unverified");
  const final = refreshManuscriptCoverageFacts(result, facts);
  expect(final.status).toBe("reviewed");
  expect(final.requirements.at(-1)).toMatchObject({ status: "fulfilled", quote: captures[index]!.promise,
    deliveryChecks: [{ kind: "page_count", status: "fulfilled" }, { kind: "media_absence", status: "fulfilled" }] });
  expect(final.requirements.at(-1)?.evidence).toEqual(captures[index]!.recordedVerdict.evidence);
  expect(calls).toHaveLength(1);
  expect(calls[0]!.messages[0]!.content).toContain("mixedPromiseAssessment");
});

it.each(["missing", "unverified"])("never lets empty images discharge a %s narrative", async status => {
  const { result } = await review(0, a => { a.narrative = { status, reason: "The requested ending is not established.", evidence: [] }; });
  expect(refreshManuscriptCoverageFacts(result, facts).requirements.at(-1)?.status).toBe(status);
});

it("does not let a mixed delivery promise bypass the narrative scope check on refresh", async () => {
  const { result } = await review(0, a => { a.narrative = { status: "missing", reason: "The story does not stop immediately upon arrival.", evidence: [] }; }, true, false);
  const final = refreshManuscriptCoverageFacts(result, facts);
  expect(final.requirements.at(-1)?.status).toBe("unverified");
  expect(final.requirements.at(-1)?.mixedPromiseAssessment?.narrative.status).toBe("unverified");
});

it("rechecks page counts and artwork after serialization and after a prior pass", async () => {
  const { result } = await review();
  const passed = refreshManuscriptCoverageFacts(result, facts);
  for (const context of [{ ...facts, storyPageIndexes: facts.storyPageIndexes.slice(1) },
    { ...facts, mediaInventory: { ...facts.mediaInventory, storyPagesWithArtwork: [4] } }]) {
    const failed = refreshManuscriptCoverageFacts(passed, context);
    expect(failed.requirements.at(-1)?.status).toBe("missing");
  }
  expect(refreshManuscriptCoverageFacts(passed, { ...facts, mediaInventory: {} }).requirements.at(-1)?.status).toBe("unverified");
});

it("does not upgrade a narrative with unverified evidence or an unfinished review", async () => {
  const { result } = await review(0, a => { a.narrative = { status: "fulfilled", reason: "An ending exists.",
    evidence: [{ pageIndex: 30, quote: "Invented ending evidence" }] }; });
  expect(refreshManuscriptCoverageFacts(result, facts).requirements.at(-1)?.status).toBe("unverified");
  const incomplete = await review(0, () => {}, false);
  expect(refreshManuscriptCoverageFacts(incomplete.result, facts).status).toBe("incomplete");
});

it.each(["promise", "links", "duplicate", "quote", "narrative"])("cannot clear a malformed mixed assessment: %s", async field => {
  const { result } = await review(0, a => {
    if (field === "promise") a.promiseQuote = "A different promise";
    if (field === "links") a.deliveryRequirements = [{ id: "promise-1", quote: captures[0]!.promise }];
    if (field === "duplicate") a.deliveryRequirements = Array.from({ length: 2 }, () => ({ id: "brief-1", quote: captures[0]!.requirements[0]!.quote }));
    if (field === "quote") a.deliveryRequirements = [{ id: "brief-1", quote: "Different quote" }];
    if (field === "narrative") delete a.narrative;
  });
  expect(refreshManuscriptCoverageFacts(result, facts).requirements.at(-1)?.status).toBe("unverified");
});

it("keeps legacy combined judgments unverified instead of inferring a narrative pass", async () => {
  const { result } = await review();
  for (const requirement of result.requirements) delete requirement.mixedPromiseAssessment;
  expect(refreshManuscriptCoverageFacts(result, facts).requirements.at(-1)?.status).toBe("unverified");
});

it("does not trust saved delivery checks after a linked source changes", async () => {
  const { result } = await review();
  const passed = refreshManuscriptCoverageFacts(result, facts);
  passed.requirements[1]!.quote = "A different request";
  expect(refreshManuscriptCoverageFacts(passed, facts).requirements.at(-1)?.status).toBe("unverified");
});

it("checks every scope in a linked media prohibition without dropping the story ending", async () => {
  const brief = "Do not create interior illustrations, a cover image, or character reference images.";
  const promise = "Tell a gentle woodland story with a resolved ending and no interior illustrations, cover image, or character reference images.";
  const evidence = captures[0]!.recordedVerdict.evidence;
  const { model, calls } = scriptedDevelopmentModel([{ complete: true, requirements: [{ id: "promise-1", status: "unverified",
    reason: "The export inventory is pending.", evidence: [], mixedPromiseAssessment: {
      promiseQuote: promise, deliveryRequirements: [{ id: "brief-1", quote: brief }],
      narrative: { status: "fulfilled", reason: "The gentle story resolves at the picnic.", evidence }
    } }] }]);
  const result = await reviewManuscriptCoverage({ brief, promises: [promise], pages: captures[0]!.pages, textModel: model,
    inventory: manuscriptRequirementInventorySchema.parse({ brief, status: "available", complete: true,
      requirements: [{ text: brief, quote: brief, kind: "media_absence", mediaScope: "all" }] }), evidenceContext: { ...facts, mediaInventory: {} } });
  const passed = refreshManuscriptCoverageFacts(result, facts);
  expect(passed.requirements.at(-1)?.status).toBe("fulfilled");
  expect(passed.requirements.at(-1)?.deliveryChecks).toHaveLength(3);
  for (const mediaInventory of [{ ...facts.mediaInventory, storyPagesWithArtwork: [1] },
    { ...facts.mediaInventory, coverArtworkCount: 1 }, { ...facts.mediaInventory, characterReferenceCount: 1 }]) {
    expect(refreshManuscriptCoverageFacts(passed, { ...facts, mediaInventory }).requirements.at(-1)?.status).toBe("missing");
  }
  expect(calls).toHaveLength(1);
});
