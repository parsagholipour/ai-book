import { expect, it } from "vitest";
import { inventoryManuscriptRequirements, refreshManuscriptCoverageFacts, reviewManuscriptCoverage, type CoverageEvidenceContext } from "./manuscriptCoverage.js";
import { scriptedDevelopmentModel } from "./testing/bookDevelopmentFixtures.js";

const brief = "Illustrate every page. The neighbors arrive before moonrise.";
const inventory = { complete: true, requirements: [
  { text: "Illustrate every page.", quote: "Illustrate every page.", kind: "illustration", illustrationScope: "all_story_pages" },
  { text: "The neighbors arrive before moonrise.", quote: "The neighbors arrive before moonrise.", kind: "content" }
] };
const prose = "The neighbors reached the picnic before the moon rose.";
const context: CoverageEvidenceContext = { title: "Story", targetStoryPages: 1, storyPageIndexes: [1],
  illustratedPageIndexes: [], expectedIllustratedPageIndexes: [1], characters: [], referenceProvenance: [] };

it("reuses brief-only inventory and rechecks arrived images without another semantic call", async () => {
  const { model, calls } = scriptedDevelopmentModel([inventory, { complete: true, requirements: [
    { id: "brief-1", status: "unverified", reason: "Images pending", evidence: [] },
    { id: "brief-2", status: "fulfilled", reason: "The arrival precedes moonrise.", evidence: [{ pageIndex: 1, quote: prose }] }
  ] }]);
  const prepared = await inventoryManuscriptRequirements({ brief, textModel: model });
  const review = await reviewManuscriptCoverage({ brief, promises: [], pages: [{ index: 1, markdown: prose }],
    textModel: model, evidenceContext: context, inventory: prepared });
  expect(calls).toHaveLength(2);
  expect(review.requirements[0]?.status).toBe("missing");
  const final = refreshManuscriptCoverageFacts(review, { ...context, illustratedPageIndexes: [1] });
  expect(final.requirements.map((requirement) => requirement.status)).toEqual(["fulfilled", "fulfilled"]);
  expect(final.status).toBe("reviewed");
  expect(calls).toHaveLength(2);
  expect(final.requirements[1]?.evidence).toEqual(review.requirements[1]?.evidence);
  expect(calls[1]?.messages[0]?.content).toContain("later assertion cannot erase an earlier incompatible event");
});

it("does not turn incomplete semantic evidence or failed inventory into completion when images arrive", async () => {
  const { model, calls } = scriptedDevelopmentModel([new Error("provider unavailable")]);
  const failed = await inventoryManuscriptRequirements({ brief, textModel: model });
  expect(failed.status).toBe("unavailable");
  const review = await reviewManuscriptCoverage({ brief, promises: [], pages: [{ index: 1, markdown: prose }], textModel: model, inventory: failed });
  expect(calls).toHaveLength(1);
  expect(refreshManuscriptCoverageFacts(review, { ...context, illustratedPageIndexes: [1] }).status).toBe("unavailable");
});

it("revalidates cached brief quotes instead of accepting fabricated requirements", async () => {
  const { model, calls } = scriptedDevelopmentModel([]);
  const review = await reviewManuscriptCoverage({ brief, promises: [], pages: [{ index: 1, markdown: prose }], textModel: model,
    inventory: { brief, status: "available", complete: true, requirements: [
      { text: "Invented request.", quote: "This text is absent from the brief.", kind: "content" }
    ] } });
  expect(review.status).toBe("incomplete");
  expect(review.requirements).toEqual([]);
  expect(calls).toHaveLength(0);
});
