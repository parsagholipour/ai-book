import { expect, it } from "vitest";
import { reviewManuscriptCoverage, type CoverageEvidenceContext } from "./manuscriptCoverage.js";
import { scriptedDevelopmentModel } from "./testing/bookDevelopmentFixtures.js";

const prose = "Rabbit asked for help, and Wise Turtle trusted Rabbit to lead across the river.";
const context: CoverageEvidenceContext = {
  title: "The Lantern Path", targetStoryPages: 30,
  storyPageIndexes: Array.from({ length: 30 }, (_, i) => i + 1),
  illustratedPageIndexes: Array.from({ length: 30 }, (_, i) => i + 1),
  expectedIllustratedPageIndexes: Array.from({ length: 30 }, (_, i) => i + 1),
  characters: [{ name: "Wise Turtle", description: "A careful mentor", traits: ["wise"], visualRules: ["green shell"], referenceVersion: "portrait-v1" }],
  referenceProvenance: [{ id: "reference-1", path: "images/reference-1.webp", characterName: "Wise Turtle" }]
};

it("checks title, story count and illustration presence from export facts despite absent prose mentions", async () => {
  const requirements = [
    { text: 'Title the book The Lantern Path.', quote: 'Title the book The Lantern Path.', kind: "title", expectedTitle: "The Lantern Path" },
    { text: "Use 30 story pages.", quote: "Use 30 story pages.", kind: "page_count", expectedCount: 30 },
    { text: "Illustrate every page.", quote: "Illustrate every page.", kind: "illustration" }
  ];
  const { model, calls } = scriptedDevelopmentModel([
    { complete: true, requirements },
    { complete: true, requirements: requirements.map((_, i) => ({ id: `brief-${i + 1}`, status: "missing", reason: "Not in page prose", evidence: [] })) }
  ]);
  const result = await reviewManuscriptCoverage({ brief: requirements.map((r) => r.quote).join(" "), promises: [], pages: [{ index: 1, markdown: prose }], evidenceContext: context, textModel: model });
  expect(result.requirements.map((r) => r.status)).toEqual(["fulfilled", "fulfilled", "fulfilled"]);
  expect(result.issues).toEqual([]);
  expect(JSON.parse(calls[1]!.messages[1]!.content).evidenceContext.referenceProvenance).toEqual(context.referenceProvenance);
});

it("keeps verified character growth when visual likeness cannot be inspected", async () => {
  const requirements = [
    { text: "Both characters grow.", quote: "Both characters grow.", kind: "content" },
    { text: "Preserve their portrait likeness.", quote: "Preserve their portrait likeness.", kind: "visual" }
  ];
  const { model, calls } = scriptedDevelopmentModel([
    { complete: true, requirements },
    { complete: false, requirements: [
      { id: "brief-1", status: "fulfilled", reason: "Both change how they work together.", evidence: [{ pageIndex: 1, quote: prose }] },
      { id: "brief-2", status: "missing", reason: "The page does not describe the portrait.", evidence: [] }
    ] }
  ]);
  const result = await reviewManuscriptCoverage({ brief: requirements.map((r) => r.quote).join(" "), promises: [], pages: [{ index: 1, markdown: prose }], evidenceContext: context, textModel: model });
  expect(result.status).toBe("incomplete");
  expect(result.requirements.map((r) => r.status)).toEqual(["fulfilled", "unverified"]);
  expect(result.issues.map((i) => i.code)).toEqual(["BRIEF_COVERAGE_UNVERIFIED"]);
  expect(calls[1]!.messages[0]!.content).toContain("boasts and mistaken beliefs are not literal narrative guarantees");
});

it("does not grant factual requirements when actual export facts are missing", async () => {
  const brief = "Use 30 story pages. Illustrate every page.";
  const { model } = scriptedDevelopmentModel([
    { complete: true, requirements: [{ text: brief, quote: brief, kind: "illustration" }] },
    { complete: true, requirements: [{ id: "brief-1", status: "fulfilled", reason: "The user requested pictures", evidence: [] }] }
  ]);
  const result = await reviewManuscriptCoverage({ brief, promises: [], pages: [], textModel: model });
  expect(result.requirements[0]?.status).toBe("unverified");
});

it("reports a missing illustration even when the reviewer claims fulfillment", async () => {
  const brief = "Illustrate every page.";
  const { model } = scriptedDevelopmentModel([
    { complete: true, requirements: [{ text: brief, quote: brief, kind: "illustration" }] },
    { complete: true, requirements: [{ id: "brief-1", status: "fulfilled", reason: "Pictures are mentioned", evidence: [{ pageIndex: 1, quote: prose }] }] }
  ]);
  const result = await reviewManuscriptCoverage({ brief, promises: [], pages: [{ index: 1, markdown: prose }], evidenceContext: { ...context, illustratedPageIndexes: [1] }, textModel: model });
  expect(result.requirements[0]?.status).toBe("missing");
});

it.each([[...context.storyPageIndexes, 1], context.storyPageIndexes.map((i) => i + 1)].map((storyPageIndexes) => ({ storyPageIndexes })))("rejects duplicated or shifted story-page numbering", async ({ storyPageIndexes }) => {
  const brief = "Use 30 story pages.";
  const { model } = scriptedDevelopmentModel([
    { complete: true, requirements: [{ text: brief, quote: brief, kind: "page_count", expectedCount: 30 }] },
    { complete: true, requirements: [{ id: "brief-1", status: "fulfilled", reason: "There are thirty", evidence: [] }] }
  ]);
  const result = await reviewManuscriptCoverage({ brief, promises: [], pages: [], evidenceContext: { ...context, storyPageIndexes }, textModel: model });
  expect(result.requirements[0]?.status).toBe("missing");
});
