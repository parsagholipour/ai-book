import { expect, it } from "vitest";
import { manuscriptCoverageSchema, manuscriptRequirementInventorySchema, reviewManuscriptCoverage } from "./manuscriptCoverage.js";
import { scriptedDevelopmentModel } from "./testing/bookDevelopmentFixtures.js";
import captures from "./testing/capturedCastEvidence.json" with { type: "json" };

it.each(captures)("recovers $tier's captured cast witnesses once for identical obligations, preserving roles, scope and prose", async capture => {
  const answer = structuredClone(capture.answer);
  const original = structuredClone(answer);
  const entities = answer.prohibitionAssessment.entities;
  const corrections = entities.flatMap((entity, index) => {
    const names = [entity.name, ...entity.aliases];
    if (entity.evidence.some(e => names.some(n => e.quote.toLowerCase().includes(n.toLowerCase())))) return [];
    const page = [...entity.evidence.map(e => capture.pages.find(p => p.index === e.pageIndex)!), ...capture.pages]
      .find(p => names.some(n => p.markdown.toLowerCase().includes(n.toLowerCase())))!;
    return [{ id: `brief-1:entity-${index + 1}`, supportsSameEntityAndRole: true, namingEvidence: { pageIndex: page.index, quote: page.markdown } }];
  });
  const { model, calls } = scriptedDevelopmentModel([{ complete: true, requirements: [answer] }, { corrections }]);
  const result = await reviewManuscriptCoverage({ brief: capture.brief, promises: [], pages: capture.pages, textModel: model,
    inventory: manuscriptRequirementInventorySchema.parse({ brief: capture.brief, status: "available", complete: true, requirements: [capture.requirement, capture.requirement] }),
    evidenceContext: { title: "The Lantern Path", targetStoryPages: 30, storyPageIndexes: capture.pages.map(p => p.index),
      characters: capture.characters, selectedCharacterNames: capture.selectedCharacterNames,
      illustratedPageIndexes: [], expectedIllustratedPageIndexes: [], referenceProvenance: [] } });
  expect(result.requirements[0]?.status).toBe("fulfilled");
  expect(result.requirements.map(item => item.status)).toEqual(["fulfilled", "fulfilled"]);
  expect(result.requirements[1]?.prohibitionAssessment).toEqual(result.requirements[0]?.prohibitionAssessment);
  expect(result.status).toBe("reviewed");
  expect(calls).toHaveLength(2);
  const payload = JSON.parse(calls[1]!.messages[1]!.content);
  expect(payload.phase).toBe("prohibition_evidence_recovery");
  expect(payload.entities).toHaveLength(corrections.length);
  expect(calls[1]?.textAttemptBudget).toEqual({ limit: 1, used: 0, outputWidened: true });
  const stored = manuscriptCoverageSchema.parse(JSON.parse(JSON.stringify(result)));
  expect(stored.requirements[0]?.prohibitionAssessment?.entities.map(({ namingEvidence: _anchor, ...entity }) => entity))
    .toEqual(original.prohibitionAssessment.entities);
  expect(stored.requirements[0]?.prohibitionAssessment).toMatchObject({
    complete: true, checkedPageIndexes: original.prohibitionAssessment.checkedPageIndexes, counterexamples: []
  });
  expect(answer).toEqual(original);
});
