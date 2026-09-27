import { expect, it } from "vitest";
import { manuscriptCoverageSchema, refreshManuscriptCoverageFacts, reviewManuscriptCoverage, type CoverageEvidenceContext } from "./manuscriptCoverage.js";
import { coverageStoryPageWordCounts } from "./manuscriptCoverageDelivery.js";
import capture from "./testing/balancedDelivery0000.json" with { type: "json" };
import { scriptedDevelopmentModel } from "./testing/bookDevelopmentFixtures.js";

const recorded = () => manuscriptCoverageSchema.parse({ status: "incomplete", assessmentComplete: true, requirements: [capture.requirement] });
const facts = (): CoverageEvidenceContext => ({ title: "The Lantern Path", targetStoryPages: 30,
  storyPageIndexes: capture.pages.map(p => p.index), storyPageWordCounts: coverageStoryPageWordCounts(capture.pages),
  illustratedPageIndexes: [], expectedIllustratedPageIndexes: [], characters: [], referenceProvenance: [],
  mediaInventory: { storyPagesWithArtwork: [], coverArtworkCount: 0, characterReferenceCount: 0 } });

it("settles Balanced's captured complete-page promise from final page and image facts", () => {
  const final = refreshManuscriptCoverageFacts(recorded(), facts());
  expect(final.status).toBe("reviewed");
  expect(final.requirements[0]).toMatchObject({ id: capture.requirement.id, quote: capture.requirement.quote, status: "fulfilled" });
  expect(final.requirements[0]?.reason).not.toContain("unavailable");
  expect(final.requirements[0]?.deliveryChecks?.map(c => c.kind === "media_absence" ? c.mediaScope : c.kind))
    .toEqual(["page_count", "story_pages", "cover", "character_references"]);
  expect(manuscriptCoverageSchema.parse(JSON.parse(JSON.stringify(final)))).toEqual(final);
});

it.each(["story_pages", "cover", "character_references"])("fails the captured promise when %s artwork appears after a pass", scope => {
  const context = facts();
  const passed = refreshManuscriptCoverageFacts(recorded(), context);
  if (scope === "story_pages") context.mediaInventory!.storyPagesWithArtwork = [2];
  if (scope === "cover") context.mediaInventory!.coverArtworkCount = 1;
  if (scope === "character_references") context.mediaInventory!.characterReferenceCount = 1;
  expect(refreshManuscriptCoverageFacts(passed, context).requirements[0]?.status).toBe("missing");
});

it.each(["unknown", "partial", "wrong-index", "duplicate", "invalid", "empty"])("requires complete nonempty page facts: %s", mode => {
  const context = facts();
  if (mode === "unknown") delete context.storyPageWordCounts;
  if (mode === "partial") context.storyPageWordCounts!.pop();
  if (mode === "wrong-index") context.storyPageWordCounts![0]!.index = 31;
  if (mode === "duplicate") context.storyPageWordCounts![0]!.index = 2;
  if (mode === "invalid") context.storyPageWordCounts![0]!.words = NaN;
  if (mode === "empty") context.storyPageWordCounts![0]!.words = 0;
  expect(refreshManuscriptCoverageFacts(recorded(), context).requirements[0]?.status).toBe(mode === "empty" ? "missing" : "unverified");
});

it.each([{}, { storyPagesWithArtwork: [], coverArtworkCount: 0 },
  { storyPagesWithArtwork: [], characterReferenceCount: 0 }, { coverArtworkCount: 0, characterReferenceCount: 0 }])(
  "keeps unknown artwork unverified: %j", mediaInventory => {
    expect(refreshManuscriptCoverageFacts(recorded(), { ...facts(), mediaInventory }).requirements[0]?.status).toBe("unverified");
  });

it("requires exactly the promised ordered page set even while images are pending", () => {
  const context = facts();
  context.storyPageIndexes[29] = 29;
  context.mediaInventory = {};
  expect(refreshManuscriptCoverageFacts(recorded(), context).requirements[0]?.status).toBe("missing");
});

it("does not clear other concerns, an unfinished read, or an invalid source", () => {
  const review = recorded();
  review.requirements.push({ id: "narrative", source: "promise", kind: "content", text: "Both characters grow.",
    quote: "Both characters grow.", status: "missing", reason: "Turtle never changes.", evidence: [] });
  expect(refreshManuscriptCoverageFacts(review, facts()).requirements[1]?.status).toBe("missing");
  expect(refreshManuscriptCoverageFacts({ ...review, assessmentComplete: false }, facts()).status).toBe("incomplete");
  review.requirements[0]!.sourceQuoteIssue = "not_in_brief";
  expect(refreshManuscriptCoverageFacts(review, facts()).requirements[0]?.status).toBe("unverified");
});

it("routes the entire delivery promise to fact checks in a fresh review without an extra model stage", async () => {
  const { model, calls } = scriptedDevelopmentModel([{ complete: true, requirements: [] }]);
  const pending = await reviewManuscriptCoverage({ brief: "", promises: [capture.requirement.quote], pages: capture.pages,
    inventory: { brief: "", status: "available", complete: true, requirements: [] },
    evidenceContext: { ...facts(), mediaInventory: {} }, textModel: model });
  const payload = JSON.parse(calls[0]!.messages[1]!.content);
  expect(payload.requirements).toEqual([]);
  expect(payload.factRequirements).toHaveLength(1);
  expect(pending.requirements[0]?.status).toBe("unverified");
  expect(refreshManuscriptCoverageFacts(manuscriptCoverageSchema.parse(JSON.parse(JSON.stringify(pending))), facts()).requirements[0]?.status).toBe("fulfilled");
  expect(calls).toHaveLength(1);
});

it.each([
  `${capture.requirement.quote.slice(0, -1)}; both characters must grow.`,
  "Deliver exactly 30 complete story pages, all text-only, with no cover art unless requested.",
  "Deliver exactly 30 complete story pages, all text-only, with no interior illustrations of frightening scenes.",
  "Deliver exactly 30 complete story pages with a complete ending.",
  "Deliver exactly 30 complete stories, all text-only, with no cover art.",
  "Deliver exactly 30 story pages, all text-only except the final illustration.",
  "Deliver exactly 30 story pages, all text-only, with no cover art and a resolved mystery."
])("keeps additional narrative or conditional obligations semantic: %s", async quote => {
  const { model, calls } = scriptedDevelopmentModel([{ complete: true, requirements: [
    { id: "promise-1", status: "unverified", reason: "The complete obligation needs review.", evidence: [] }
  ] }]);
  const review = await reviewManuscriptCoverage({ brief: "", promises: [quote], pages: capture.pages,
    inventory: { brief: "", status: "available", complete: true, requirements: [] }, evidenceContext: facts(), textModel: model });
  expect(JSON.parse(calls[0]!.messages[1]!.content).requirements).toHaveLength(1);
  expect(refreshManuscriptCoverageFacts(review, facts()).requirements[0]?.status).toBe("unverified");
});
