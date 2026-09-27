import { expect, it } from "vitest";
import { refreshManuscriptCoverageFacts, manuscriptCoverageSchema, reviewManuscriptCoverage, type CoverageEvidenceContext } from "./manuscriptCoverage.js";
import captures from "./testing/compoundDeliveryPromises.json" with { type: "json" };
import { countReadableWords } from "./proseShape.js";
import { coverageStoryPageWordCounts } from "./manuscriptCoverageDelivery.js";
import { scriptedDevelopmentModel } from "./testing/bookDevelopmentFixtures.js";

const facts = (pages: { index: number; markdown: string }[]): CoverageEvidenceContext => ({
  title: "The Lantern Path", targetStoryPages: 30, storyPageIndexes: pages.map(p => p.index),
  storyPageWordCounts: coverageStoryPageWordCounts(pages), illustratedPageIndexes: [], expectedIllustratedPageIndexes: [],
  characters: [], referenceProvenance: [], mediaInventory: { storyPagesWithArtwork: [], coverArtworkCount: 0, characterReferenceCount: 0 }
});
const recorded = (index: number) => manuscriptCoverageSchema.parse({ status: "incomplete", assessmentComplete: true, requirements: [captures[index]!.requirement] });

it.each(captures)("settles $tier's recorded compound promise from complete actual facts", ({ requirement, pages, assessmentComplete }) => {
  const review = manuscriptCoverageSchema.parse({ status: "incomplete", assessmentComplete, requirements: [requirement] });
  const context = { title: "The Lantern Path", targetStoryPages: 30, storyPageIndexes: pages.map(p => p.index),
    storyPageWordCounts: pages.map(p => ({ index: p.index, words: countReadableWords(p.markdown) })),
    illustratedPageIndexes: [], expectedIllustratedPageIndexes: [], characters: [], referenceProvenance: [],
    mediaInventory: { storyPagesWithArtwork: [], coverArtworkCount: 0, characterReferenceCount: 0 } };
  const final = refreshManuscriptCoverageFacts(review, context);
  expect(final.requirements[0]?.status).toBe("fulfilled");
  expect(final.status).toBe("reviewed");
  expect(final.requirements[0]?.deliveryChecks).toHaveLength(4);
  expect(final.requirements[0]?.id).toBe(requirement.id);
  expect(final.requirements[0]?.quote).toBe(requirement.quote);
  expect(manuscriptCoverageSchema.parse(JSON.parse(JSON.stringify(final)))).toEqual(final);
});

it.each([
  ["interior", { storyPagesWithArtwork: [1], coverArtworkCount: 0, characterReferenceCount: 0 }],
  ["cover", { storyPagesWithArtwork: [], coverArtworkCount: 1, characterReferenceCount: 0 }],
  ["reference", { storyPagesWithArtwork: [], coverArtworkCount: 0, characterReferenceCount: 1 }]
])("does not discharge Quick's promise when %s assets exist", (_name, mediaInventory) => {
  const final = refreshManuscriptCoverageFacts(recorded(0), { ...facts(captures[0]!.pages), mediaInventory });
  expect(final.requirements[0]?.status).toBe("missing");
  expect(final.requirements[0]?.deliveryChecks?.filter(c => c.status === "missing")).toHaveLength(1);
});

it.each([
  {}, { storyPagesWithArtwork: [], coverArtworkCount: 0 },
  { storyPagesWithArtwork: [], characterReferenceCount: 0 },
  { coverArtworkCount: 0, characterReferenceCount: 0 }
])("does not infer an omitted asset inventory is empty: %j", (mediaInventory) => {
  const final = refreshManuscriptCoverageFacts(recorded(0), { ...facts(captures[0]!.pages), mediaInventory });
  expect(final.requirements[0]?.status).toBe("unverified");
});

it.each([0, 34, 101])("checks every page's promised word range: %s words", (words) => {
  const context = facts(captures[1]!.pages);
  context.storyPageWordCounts![14]!.words = words;
  const final = refreshManuscriptCoverageFacts(recorded(1), context);
  expect(final.requirements[0]?.status).toBe("missing");
  expect(final.requirements[0]?.reason).toContain(`15 (${words})`);
});

it.each([35, 100])("accepts the exact word-range boundary: %s", (words) => {
  const context = facts(captures[1]!.pages);
  context.storyPageWordCounts!.forEach(c => { c.words = words; });
  expect(refreshManuscriptCoverageFacts(recorded(1), context).requirements[0]?.status).toBe("fulfilled");
});

it.each(["missing", "partial", "duplicate", "wrong-page", "invalid"])("keeps %s word counts unverified", (mode) => {
  const context = facts(captures[1]!.pages);
  if (mode === "missing") delete context.storyPageWordCounts;
  if (mode === "partial") context.storyPageWordCounts!.pop();
  if (mode === "duplicate") context.storyPageWordCounts![0]!.index = 2;
  if (mode === "wrong-page") context.storyPageWordCounts![0]!.index = 31;
  if (mode === "invalid") context.storyPageWordCounts![0]!.words = NaN;
  expect(refreshManuscriptCoverageFacts(recorded(1), context).requirements[0]?.status).toBe("unverified");
});

it("retains a known violation when other facts are pending", () => {
  const context = { ...facts(captures[0]!.pages), mediaInventory: {} };
  context.storyPageIndexes[29] = 29;
  expect(refreshManuscriptCoverageFacts(recorded(0), context).requirements[0]?.status).toBe("missing");
});

it("does not turn an unfinished review or an invalid source quote into approval", () => {
  const review = recorded(0), context = facts(captures[0]!.pages);
  expect(refreshManuscriptCoverageFacts({ ...review, assessmentComplete: false }, context).status).toBe("incomplete");
  review.requirements[0]!.sourceQuoteIssue = "not_in_brief";
  expect(refreshManuscriptCoverageFacts(review, context).requirements[0]?.status).toBe("unverified");
});

it.each(captures)("excludes $tier's complete delivery obligation from semantic adjudication", async ({ requirement, pages }) => {
  const { model, calls } = scriptedDevelopmentModel([{ complete: true, requirements: [] }]);
  const pending = await reviewManuscriptCoverage({ brief: "", promises: [requirement.quote], pages, evidenceContext: { ...facts(pages), mediaInventory: {} },
    inventory: { brief: "", status: "available", complete: true, requirements: [] }, textModel: model });
  const payload = JSON.parse(calls[0]!.messages[1]!.content);
  expect(payload.requirements).toEqual([]);
  expect(payload.factRequirements).toHaveLength(1);
  expect(pending.requirements[0]?.status).toBe("unverified");
  const serialized = manuscriptCoverageSchema.parse(JSON.parse(JSON.stringify(pending)));
  expect(refreshManuscriptCoverageFacts(serialized, facts(pages)).requirements[0]?.status).toBe("fulfilled");
  expect(calls).toHaveLength(1);
});

it.each([
  "Deliver exactly 30 text-only story pages, with 35–100 words per page and no generated cover; both protagonists grow.",
  "Exactly 30 text-only story pages, planned as ten three-page chapters; no interior illustrations of frightening scenes.",
  "Plan exactly 30 story pages, with 35–100 words per page and no cover unless the author requests one.",
  "Plan exactly 30 story pages, with 35–100 words per page and a complete ending.",
  "Plan exactly 30 story pages, with 100–35 words per page.",
  "Plan exactly 30 story pages; no changes to the cover.",
  "Exactly 30 story pages, planned as ten chapters that compare the evidence."
])("leaves an unrecognized or substantive clause under semantic review: %s", async (promise) => {
  const { model, calls } = scriptedDevelopmentModel([{ complete: true, requirements: [{ id: "promise-1", status: "unverified", reason: "The full promise needs substantive verification.", evidence: [] }] }]);
  const reviewed = await reviewManuscriptCoverage({ brief: "", promises: [promise], pages: captures[0]!.pages, evidenceContext: facts(captures[0]!.pages),
    inventory: { brief: "", status: "available", complete: true, requirements: [] }, textModel: model });
  expect(JSON.parse(calls[0]!.messages[1]!.content).requirements).toHaveLength(1);
  expect(refreshManuscriptCoverageFacts(reviewed, facts(captures[0]!.pages)).requirements[0]?.status).toBe("unverified");
});

it("checks reference absence in the captured brief's combined prohibition too", async () => {
  const brief = "Do not create interior illustrations, a cover image, or character reference images.";
  const { model } = scriptedDevelopmentModel([{ complete: true, requirements: [] }]);
  const context = facts(captures[0]!.pages);
  context.mediaInventory!.characterReferenceCount = 1;
  const result = await reviewManuscriptCoverage({ brief, promises: [], pages: captures[0]!.pages, evidenceContext: context,
    inventory: { brief, complete: true, status: "available", requirements: [{ text: brief, quote: brief, kind: "media_absence", mediaScope: "all" }] }, textModel: model });
  expect(result.requirements[0]?.status).toBe("missing");
  expect(result.requirements[0]?.deliveryChecks?.map(c => c.status)).toEqual(["fulfilled", "fulfilled", "missing"]);
});

it("recomputes every obligation instead of trusting a cached subset of passing checks", () => {
  const context = facts(captures[0]!.pages);
  const final = refreshManuscriptCoverageFacts(recorded(0), context);
  final.requirements[0]!.deliveryChecks = final.requirements[0]!.deliveryChecks!.slice(0, 1);
  context.mediaInventory!.characterReferenceCount = 2;
  const refreshed = refreshManuscriptCoverageFacts(final, context);
  expect(refreshed.requirements[0]?.deliveryChecks).toHaveLength(4);
  expect(refreshed.requirements[0]?.status).toBe("missing");
});

it("counts page prose using the existing script-aware rule, excluding figure specifications", () => {
  const prose = "Rabbit holds the lantern.";
  const markdown = `${prose}\n\n\`\`\`figure\n{"kind":"bar","title":"Lanterns","categories":["A","B"],"series":[{"name":"Count","values":[1,2]}],"source":"Test data"}\n\`\`\``;
  expect(coverageStoryPageWordCounts([{ index: 1, markdown }])).toEqual([{ index: 1, words: countReadableWords(prose) }]);
});
