import { expect, it } from "vitest";
import { reviewManuscriptCoverage, type CoverageEvidenceContext } from "./manuscriptCoverage.js";
import { scriptedDevelopmentModel } from "./testing/bookDevelopmentFixtures.js";
import { groupCoverageRequirements } from "./manuscriptCoverageGrouping.js";

const obligation = "Rabbit asks Turtle for help.";
const metadata = "Use 5 story pages.";
const context: CoverageEvidenceContext = { title: "Lanterns", targetStoryPages: 5, storyPageIndexes: [1, 2, 3, 4, 5],
  illustratedPageIndexes: [], expectedIllustratedPageIndexes: [], characters: [], referenceProvenance: [] };

it("assesses metadata in code and one identical brief/promise obligation once, retaining both report ids", async () => {
  const { model, calls } = scriptedDevelopmentModel([
    { complete: true, requirements: [{ text: metadata, quote: metadata, kind: "page_count", expectedCount: 5 },
      { text: obligation, quote: obligation, kind: "content" }] },
    { complete: true, requirements: [{ id: "brief-2", status: "fulfilled", reason: "Rabbit asks for help.", evidence: [{ pageIndex: 2, quote: obligation }] }] }
  ]);
  const result = await reviewManuscriptCoverage({ brief: `${metadata} ${obligation}`, promises: [obligation],
    pages: [{ index: 2, markdown: obligation }], evidenceContext: context, textModel: model });
  expect(result.status).toBe("reviewed");
  expect(result.requirements.map(({ id, status }) => ({ id, status }))).toEqual([
    { id: "brief-1", status: "fulfilled" }, { id: "brief-2", status: "fulfilled" }, { id: "promise-1", status: "fulfilled" }
  ]);
  const payload = JSON.parse(calls[1]!.messages[1]!.content);
  expect(payload.requirements.map((item: { id: string }) => item.id)).toEqual(["brief-2"]);
  expect(payload.factRequirements.map((item: { id: string }) => item.id)).toEqual(["brief-1"]);
  expect(payload.brief).toBe(`${metadata} ${obligation}`);
  expect(calls).toHaveLength(2);
});

it("preserves different quantities, negation, independent arcs and explicit delivery constraints", () => {
  const requirements = [
    { id: "1", kind: "content", text: "Rabbit grows brave." },
    { id: "2", kind: "content", text: "Turtle grows brave." },
    { id: "3", kind: "content", text: "Rabbit is not brave." },
    { id: "4", kind: "content", text: "Recover 3 lanterns." },
    { id: "5", kind: "content", text: "Recover 4 lanterns." },
    { id: "6", kind: "illustration", text: "Illustrate the story.", expectedCount: 3 },
    { id: "7", kind: "illustration", text: "Illustrate the story.", expectedCount: 4 },
    { id: "8", kind: "content", text: "Describe a clue.", quote: "Describe a clue at the river." },
    { id: "9", kind: "content", text: "Describe a clue.", quote: "Describe a clue in the woods." }
  ];
  expect(groupCoverageRequirements(requirements).representatives).toEqual(requirements);
});

it("still reports a mismatched fact and an omitted semantic verdict", async () => {
  const { model } = scriptedDevelopmentModel([
    { complete: true, requirements: [{ text: metadata, quote: metadata, kind: "page_count", expectedCount: 5 },
      { text: obligation, quote: obligation, kind: "content" }] },
    { complete: true, requirements: [] }
  ]);
  const result = await reviewManuscriptCoverage({ brief: `${metadata} ${obligation}`, promises: [], pages: [],
    evidenceContext: { ...context, storyPageIndexes: [1, 2, 3, 4] }, textModel: model });
  expect(result.status).toBe("incomplete");
  expect(result.requirements.map(({ status }) => status)).toEqual(["missing", "unverified"]);
});
