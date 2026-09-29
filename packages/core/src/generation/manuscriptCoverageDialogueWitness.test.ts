import { expect, it } from "vitest";
import { refreshManuscriptCoverageFacts, reviewManuscriptCoverage } from "./manuscriptCoverage.js";
import { scriptedDevelopmentModel } from "./testing/bookDevelopmentFixtures.js";
import captured from "./testing/dialogueWitness0928.json" with { type: "json" };

const brief = "Each page must include natural dialogue.";
const inventory = { brief, status: "available" as const, complete: true, requirements: [{ text: "Dialogue", quote: "natural dialogue", kind: "content" as const,
  scope: { extent: "each_page" as const, quote: brief } }] };
const narration = captured[2]!;
const speaking = { index: 1, markdown: '“This way,” Rabbit said, pointing to the warm lights.' };

it("does not fulfill dialogue with the captured Premium narration witness", async () => {
  const { model, calls } = scriptedDevelopmentModel([{ complete: true, requirements: [{ id: "brief-1", status: "fulfilled",
    reason: "Every page has natural dialogue.", evidence: [{ pageIndex: 29, quote: narration.witness }] }] }]);
  const result = await reviewManuscriptCoverage({ brief, inventory, pages: [narration.page], promises: [], textModel: model });
  expect(result.requirements[0]?.status).toBe("unverified");
  expect(result.requirements[0]?.reason).toContain("29");
  expect(calls).toHaveLength(1);
});

it("cannot clear every-page dialogue by citing speech on a different page", async () => {
  const { model } = scriptedDevelopmentModel([{ complete: true, requirements: [{ id: "brief-1", status: "fulfilled",
    reason: "Every page speaks naturally.", evidence: [{ pageIndex: 1, quote: speaking.markdown }] }] }]);
  const result = await reviewManuscriptCoverage({ brief, inventory, pages: [speaking, narration.page], promises: [], textModel: model });
  expect(result.requirements[0]?.status).toBe("unverified");
  expect(result.requirements[0]?.reason).toContain("29");
});

it("retains a grounded absence while surfacing an overlooked page as unverified", async () => {
  const { model } = scriptedDevelopmentModel([{ complete: true, requirements: [{ id: "brief-1", status: "missing",
    reason: "Page 2 has no dialogue.", evidence: [{ pageIndex: 2, quote: "Rain rattled the leaves." }],
    scopeAssessment: { supported: true, authority: "brief", extent: "each_page", quote: brief, explanation: "Dialogue is required on every page." } }] }]);
  const result = await reviewManuscriptCoverage({ brief, inventory, pages: [{ index: 2, markdown: "Rain rattled the leaves." }, narration.page], promises: [], textModel: model });
  expect(result.status).toBe("incomplete");
  expect(result.requirements[0]).toMatchObject({ status: "missing", reason: expect.stringContaining("29") });
  expect(result.issues.map(issue => issue.code)).toContain("MISSING_BRIEF_REQUIREMENT");
  expect(result.assessmentComplete).toBe(false);
  expect(refreshManuscriptCoverageFacts(result, { title: "Lantern Path", targetStoryPages: 2, storyPageIndexes: [2, 29],
    illustratedPageIndexes: [], expectedIllustratedPageIndexes: [], characters: [], referenceProvenance: [] }).status).toBe("incomplete");
});

it("does not impose dialogue on each page when the brief only requires it across the book", async () => {
  const { model, calls } = scriptedDevelopmentModel([{ complete: true, requirements: [{ id: "brief-1", status: "fulfilled",
    reason: "Rabbit speaks naturally in the story.", evidence: [{ pageIndex: 1, quote: speaking.markdown }] }] }]);
  const wholeBrief = "Tell a story with natural dialogue.";
  const result = await reviewManuscriptCoverage({ brief: wholeBrief, inventory: { ...inventory, brief: wholeBrief,
    requirements: [{ ...inventory.requirements[0]!, scope: { extent: "whole_book", quote: wholeBrief } }] },
    pages: [speaking, narration.page], promises: [], textModel: model });
  expect(result.requirements[0]?.status).toBe("fulfilled");
  expect(calls).toHaveLength(1);
});
