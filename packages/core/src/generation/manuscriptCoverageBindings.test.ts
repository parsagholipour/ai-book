import { expect, it } from "vitest";
import { manuscriptCoverageSchema, refreshManuscriptCoverageFacts, reviewManuscriptCoverage, type CoverageEvidenceContext } from "./manuscriptCoverage.js";
import { scriptedDevelopmentModel } from "./testing/bookDevelopmentFixtures.js";

// Quick, 2026-09-26 22:14 run: the promise has no numeric page-count prefix.
const promise = "Keep every planned page text-only: zero interior illustrations, no cover image, and no character reference images.";
const brief = "Do not create interior illustrations, a cover image, or character reference images.";
const requirements = [
  { text: "No interior illustrations", quote: "Do not create interior illustrations", kind: "media_absence" as const, mediaScope: "story_pages" as const },
  { text: "No cover image", quote: "a cover image", kind: "media_absence" as const, mediaScope: "cover" as const },
  { text: "No character reference images", quote: "character reference images", kind: "media_absence" as const, mediaScope: "character_references" as const }
];
const binding = { promiseQuote: promise, fullyRepresented: true,
  requirements: requirements.map((r, i) => ({ id: `brief-${i + 1}`, quote: r.quote })) };
const facts: CoverageEvidenceContext = { title: "The Lantern Path", targetStoryPages: 30,
  storyPageIndexes: Array.from({ length: 30 }, (_, i) => i + 1), illustratedPageIndexes: [], expectedIllustratedPageIndexes: [],
  characters: [], referenceProvenance: [], mediaInventory: { storyPagesWithArtwork: [], coverArtworkCount: 0, characterReferenceCount: 0 } };

async function review(deliveryBinding: unknown = binding, complete = true, promiseText = promise) {
  const { model, calls } = scriptedDevelopmentModel([{ complete, requirements: [{ id: "promise-1", status: "unverified",
    reason: "Artwork absence needs the final asset inventory.", evidence: [], deliveryBinding }] }]);
  const result = await reviewManuscriptCoverage({ brief, promises: [promiseText], pages: [{ index: 1, markdown: "Rabbit and Turtle carried the lantern home." }],
    textModel: model, inventory: { brief, status: "available", complete: true, requirements }, evidenceContext: { ...facts, mediaInventory: {} } });
  return { result: manuscriptCoverageSchema.parse(JSON.parse(JSON.stringify(result))), calls };
}

it("settles Quick's generic no-images promise using typed brief obligations after serialization, without rereading prose", async () => {
  const { result, calls } = await review();
  expect(result.requirements.at(-1)?.status).toBe("unverified");
  const final = refreshManuscriptCoverageFacts(result, facts);
  expect(final.status).toBe("reviewed");
  expect(final.requirements.at(-1)).toMatchObject({ quote: promise, status: "fulfilled", deliveryBinding: binding });
  expect(final.requirements.at(-1)?.deliveryChecks?.map(c => c.kind === "media_absence" ? c.mediaScope : c.kind))
    .toEqual(["story_pages", "cover", "character_references"]);
  expect(calls).toHaveLength(1);
});

it.each([
  { storyPagesWithArtwork: [1], coverArtworkCount: 0, characterReferenceCount: 0 },
  { storyPagesWithArtwork: [], coverArtworkCount: 1, characterReferenceCount: 0 },
  { storyPagesWithArtwork: [], coverArtworkCount: 0, characterReferenceCount: 1 },
  { characterReferenceCount: 1 }
])("retains a real asset violation on a bound promise: %j", async (mediaInventory) => {
  const { result } = await review();
  expect(refreshManuscriptCoverageFacts(result, { ...facts, mediaInventory }).requirements.at(-1)?.status).toBe("missing");
});

it.each([{}, { storyPagesWithArtwork: [], coverArtworkCount: 0 }])("keeps unknown asset scopes pending: %j", async (mediaInventory) => {
  const { result } = await review();
  expect(refreshManuscriptCoverageFacts(result, { ...facts, mediaInventory }).requirements.at(-1)?.status).toBe("unverified");
});

it.each([
  null,
  { ...binding, fullyRepresented: false },
  { ...binding, promiseQuote: "No cover image." },
  { ...binding, requirements: [] },
  { ...binding, requirements: binding.requirements.slice(0, 2) },
  { ...binding, requirements: [{ id: "promise-1", quote: promise }] },
  { ...binding, requirements: [{ id: "brief-100", quote: brief }] },
  { ...binding, requirements: [binding.requirements[0], binding.requirements[0]] },
  { ...binding, requirements: [{ id: "brief-1", quote: "Different source text" }] }
])("does not discharge an invalid or partial binding: %j", async (invalid) => {
  const { result } = await review(invalid);
  const final = refreshManuscriptCoverageFacts(result, facts);
  expect(final.status).toBe("incomplete");
  expect(final.requirements.at(-1)?.status).toBe("unverified");
});

it("does not reuse a binding for a changed or mixed substantive promise", async () => {
  const { result } = await review(binding, true, `${promise} Both protagonists learn to cooperate.`);
  expect(refreshManuscriptCoverageFacts(result, facts).requirements.at(-1)?.status).toBe("unverified");
});

it("does not upgrade an unfinished manuscript read", async () => {
  const { result } = await review(binding, false);
  expect(refreshManuscriptCoverageFacts(result, facts).status).toBe("incomplete");
});

it.each(["missing", "quote", "source", "kind", "ungrounded"])("rejects a cached binding whose source becomes %s", async (change) => {
  const { result } = await review();
  const final = refreshManuscriptCoverageFacts(result, facts);
  if (change === "missing") final.requirements.shift();
  if (change === "quote") final.requirements[0]!.quote = "Changed quote";
  if (change === "source") final.requirements[0]!.source = "promise";
  if (change === "kind") final.requirements[0]!.kind = "visual";
  if (change === "ungrounded") final.requirements[0]!.sourceQuoteIssue = "not_in_brief";
  expect(refreshManuscriptCoverageFacts(final, facts).requirements.at(-1)?.status).toBe("unverified");
});

it("recomputes all linked obligations even when cached passing checks were truncated", async () => {
  const { result } = await review();
  const final = refreshManuscriptCoverageFacts(result, facts);
  final.requirements.at(-1)!.deliveryChecks = [];
  const changed = refreshManuscriptCoverageFacts(final, { ...facts, mediaInventory: { ...facts.mediaInventory, characterReferenceCount: 1 } });
  expect(changed.requirements.at(-1)?.status).toBe("missing");
  expect(changed.requirements.at(-1)?.deliveryChecks).toHaveLength(3);
});
