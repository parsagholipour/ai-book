import { expect, it } from "vitest";
import { reviewManuscriptCoverage, type CoverageEvidenceContext } from "./manuscriptCoverage.js";
import { scriptedDevelopmentModel } from "./testing/bookDevelopmentFixtures.js";

const promise = "Deliver exactly 30 text-only story pages, organized as ten three-page chapters, with no illustrations or cover artwork.";
const context: CoverageEvidenceContext = { title: "The Lantern Path", targetStoryPages: 30,
  storyPageIndexes: Array.from({ length: 30 }, (_, i) => i + 1), illustratedPageIndexes: [], expectedIllustratedPageIndexes: [],
  mediaInventory: { storyPagesWithArtwork: [], coverArtworkCount: 0 }, characters: [], referenceProvenance: [] };
async function review(text = promise, evidenceContext = context) {
  const { model, calls } = scriptedDevelopmentModel([
    { complete: true, requirements: [] },
    { complete: true, requirements: [{ id: "promise-1", status: "fulfilled", reason: "The requested format is delivered.", evidence: [], chapterEvidence: [1] }] }
  ]);
  const result = await reviewManuscriptCoverage({ brief: "", promises: [text], pages: [], chapters: [], evidenceContext, textModel: model });
  expect(calls).toHaveLength(2);
  return result;
}

it("checks Quick's delivery-only promise from export facts without enforcing provisional chapter groups", async () => {
  expect((await review()).status).toBe("reviewed");
});

it.each([
  { ...context, storyPageIndexes: context.storyPageIndexes.slice(1) },
  { ...context, mediaInventory: { storyPagesWithArtwork: [2], coverArtworkCount: 0 } },
  { ...context, mediaInventory: { storyPagesWithArtwork: [], coverArtworkCount: 1 } }
])("retains delivery warnings when actual count or artwork contradicts the promise", async (evidenceContext) => {
  expect((await review(promise, evidenceContext)).requirements[0]?.status).toBe("missing");
});

it("requires complete actual artwork inventory even when settings request text only", async () => {
  expect((await review(promise, { ...context, mediaInventory: {} })).requirements[0]?.status).toBe("unverified");
});

it.each([
  `${promise.slice(0, -1)}; the prose must tell a complete story.`,
  "Deliver exactly 30 story pages that show both characters growing.",
  "Deliver exactly 30 text-only story pages, organized as a clear argument in chapters.",
  "Let both protagonists solve the problem, with a complete ending on page thirty."
])("does not let metadata discharge mixed or substantive promises: %s", async (text) => {
  expect((await review(text)).requirements[0]?.status).toBe("unverified");
});
