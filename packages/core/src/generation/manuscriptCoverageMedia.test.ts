import { expect, it } from "vitest";
import { refreshManuscriptCoverageFacts, reviewManuscriptCoverage } from "./manuscriptCoverage.js";
import { scriptedDevelopmentModel } from "./testing/bookDevelopmentFixtures.js";

const brief = "No illustrations, images, or cover artwork";
const context = {
  title: "The Lantern Path", targetStoryPages: 1, storyPageIndexes: [1],
  illustratedPageIndexes: [], expectedIllustratedPageIndexes: [], characters: [], referenceProvenance: [],
  mediaInventory: { storyPagesWithArtwork: [], coverArtworkCount: 0 }
};
const verdict = { complete: true, requirements: [
  { id: "brief-1", status: "fulfilled", reason: "The supplied image inventory is empty.", evidence: [] }
] };

it("verifies the recorded no-artwork content constraint without requiring prose evidence", async () => {
  const { model, calls } = scriptedDevelopmentModel([
    { complete: true, requirements: [{ text: brief, quote: brief, kind: "content" }] }, verdict
  ]);
  const result = await reviewManuscriptCoverage({ brief, promises: [], pages: [], textModel: model, evidenceContext: context });
  expect(result.requirements[0]?.status).toBe("fulfilled");
  expect(result.requirements[0]?.kind).toBe("media_absence");
  expect(result.issues).toEqual([]);
  expect(calls).toHaveLength(2);
});

it.each([{ storyPagesWithArtwork: [] }, { storyPagesWithArtwork: [1] }])("checks pure text-only pages against actual artwork inventory: %j", async ({ storyPagesWithArtwork }) => {
  const text = "All story pages are text-only.";
  const { model } = scriptedDevelopmentModel([
    { complete: true, requirements: [{ text, quote: text, kind: "content" }] }, verdict
  ]);
  const result = await reviewManuscriptCoverage({ brief: text, promises: [], pages: [], textModel: model,
    evidenceContext: { ...context, mediaInventory: { storyPagesWithArtwork, coverArtworkCount: 1 } } });
  expect(result.requirements[0]).toMatchObject({ kind: "media_absence", mediaScope: "story_pages",
    status: storyPagesWithArtwork.length ? "missing" : "fulfilled" });
});

it.each([
  { storyPagesWithArtwork: [1], coverArtworkCount: 0 },
  { storyPagesWithArtwork: [], coverArtworkCount: 1 }
])("rejects unwanted artwork despite a model pass: %j", async (mediaInventory) => {
  const { model } = scriptedDevelopmentModel([
    { complete: true, requirements: [{ text: brief, quote: brief, kind: "content" }] }, verdict
  ]);
  const result = await reviewManuscriptCoverage({ brief, promises: [], pages: [], textModel: model, evidenceContext: { ...context, mediaInventory } });
  expect(result.requirements[0]?.status).toBe("missing");
  expect(result.issues[0]?.guidance).toContain("Remove");
});

it.each([undefined, {}, { storyPagesWithArtwork: [] }, { coverArtworkCount: 0 }])(
  "does not prove absence from an unknown or partial inventory: %j", async (mediaInventory) => {
    const { model } = scriptedDevelopmentModel([
      { complete: true, requirements: [{ text: brief, quote: brief, kind: "content" }] }, verdict
    ]);
    const { mediaInventory: _inventory, ...base } = context;
    const result = await reviewManuscriptCoverage({ brief, promises: [], pages: [], textModel: model,
      evidenceContext: { ...base, ...(mediaInventory ? { mediaInventory } : {}) } });
    expect(result.requirements[0]?.status).toBe("unverified");
  }
);

it.each([
  ["story_pages", { storyPagesWithArtwork: [], coverArtworkCount: 1 }],
  ["cover", { storyPagesWithArtwork: [1], coverArtworkCount: 0 }]
])("checks a scoped media-absence requirement independently: %s", async (mediaScope, mediaInventory) => {
  const text = mediaScope === "cover" ? "Omit the cover artwork." : "Keep the story pages free of artwork.";
  const { model } = scriptedDevelopmentModel([
    { complete: true, requirements: [{ text, quote: text, kind: "media_absence", mediaScope }] }, verdict
  ]);
  const result = await reviewManuscriptCoverage({ brief: text, promises: [], pages: [], textModel: model, evidenceContext: { ...context, mediaInventory } });
  expect(result.requirements[0]?.status).toBe("fulfilled");
});

it.each([
  "No illustrations, images, or cover artwork; the prose must tell the complete story on its own.",
  "No illustrations of frightening scenes.",
  "No changes to the characters' visual appearance."
])("does not clear mixed or visual constraints using an empty inventory: %s", async (text) => {
  const { model } = scriptedDevelopmentModel([
    { complete: true, requirements: [{ text, quote: text, kind: "content" }] }, verdict
  ]);
  const result = await reviewManuscriptCoverage({ brief: text, promises: [], pages: [], textModel: model, evidenceContext: context });
  expect(result.requirements[0]?.status).toBe("unverified");
});

it("refreshes cached media facts without a paid reread and preserves other unverified evidence", async () => {
  const text = "Both characters grow.";
  const { model, calls } = scriptedDevelopmentModel([
    { complete: true, requirements: [{ text: brief, quote: brief, kind: "content" }, { text, quote: text, kind: "content" }] },
    { complete: true, requirements: [...verdict.requirements, { ...verdict.requirements[0]!, id: "brief-2" }] }
  ]);
  const review = await reviewManuscriptCoverage({ brief: `${brief}. ${text}`, promises: [], pages: [], textModel: model });
  const refreshed = refreshManuscriptCoverageFacts(review, context);
  expect(refreshed.requirements.map((r) => r.status)).toEqual(["fulfilled", "unverified"]);
  expect(refreshed.status).toBe("incomplete");
  expect(refreshManuscriptCoverageFacts(refreshed, { ...context, mediaInventory: { ...context.mediaInventory, coverArtworkCount: 1 } }).requirements[0]?.status).toBe("missing");
  expect(calls).toHaveLength(2);
});

it.each([{ illustratedPageIndexes: [] }, { illustratedPageIndexes: [1] }])("treats an explicit zero illustration count as absence, not a minimum: %j", async ({ illustratedPageIndexes }) => {
  const text = "Use 0 illustrations.";
  const { model } = scriptedDevelopmentModel([
    { complete: true, requirements: [{ text, quote: text, kind: "illustration", expectedCount: 0 }] }, verdict
  ]);
  const result = await reviewManuscriptCoverage({ brief: text, promises: [], pages: [], textModel: model,
    evidenceContext: { ...context, illustratedPageIndexes,
      mediaInventory: { ...context.mediaInventory, storyPagesWithArtwork: illustratedPageIndexes } } });
  expect(result.requirements[0]?.status).toBe(illustratedPageIndexes.length ? "missing" : "fulfilled");
});

it("does not prove a media prohibition without its scope", async () => {
  const { model } = scriptedDevelopmentModel([
    { complete: true, requirements: [{ text: brief, quote: brief, kind: "media_absence" }] }, verdict
  ]);
  const result = await reviewManuscriptCoverage({ brief, promises: [], pages: [], textModel: model, evidenceContext: context });
  expect(result.requirements[0]?.status).toBe("unverified");
});
