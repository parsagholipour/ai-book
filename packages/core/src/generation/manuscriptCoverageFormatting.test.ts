import { expect, it } from "vitest";
import { manuscriptCoverageSchema, manuscriptRequirementInventorySchema, reviewManuscriptCoverage } from "./manuscriptCoverage.js";
import { scriptedDevelopmentModel } from "./testing/bookDevelopmentFixtures.js";
import captured from "./testing/coverageFormatting0338.json" with { type: "json" };

async function replay(tier: keyof typeof captured) {
  const fixture = captured[tier];
  const { model, calls } = scriptedDevelopmentModel([{ complete: true, requirements: [{ ...fixture.answer, id: "brief-1" }] }]);
  const result = await reviewManuscriptCoverage({ brief: fixture.brief, promises: [], pages: fixture.pages, textModel: model,
    inventory: manuscriptRequirementInventorySchema.parse({ status: "available", complete: true, brief: fixture.brief,
      requirements: [fixture.requirement] }), evidenceContext: fixture.evidenceContext });
  return { result: manuscriptCoverageSchema.parse(result), calls };
}

it("recovers the captured Balanced cast coordinates and descriptive group label without spending another call", async () => {
  const before = structuredClone(captured.balanced);
  const { result, calls } = await replay("balanced");
  expect(result.requirements[0]?.status).toBe("fulfilled");
  const assessment = result.requirements[0]?.prohibitionAssessment;
  expect(assessment?.entities.find(entity => entity.name === "Ridge Turn")?.evidence)
    .toEqual([{ pageIndex: 10, quote: "Rabbit went ahead along the marked path to Ridge Turn." }]);
  expect(assessment?.entities.map(entity => entity.role)).toEqual(before.answer.prohibitionAssessment.entities.map(entity => entity.role));
  expect(assessment?.entities).toHaveLength(before.answer.prohibitionAssessment.entities.length);
  expect(calls).toHaveLength(1);
  expect(captured.balanced).toEqual(before);
});

it("retains Premium's exact short dialogue with its source context and no extra model call", async () => {
  const { result, calls } = await replay("premium");
  expect(result.requirements[0]?.status).toBe("fulfilled");
  const evidence = result.requirements[0]?.evidence;
  expect(evidence?.[0]).toEqual(captured.premium.answer.evidence[0]);
  expect(evidence?.[1]).toEqual({ pageIndex: 20, quote: captured.premium.pages[19]!.markdown });
  expect(evidence?.[1]?.quote).toContain("Wise Turtle");
  expect(evidence?.[1]?.quote).toContain("“You lead.”");
  expect(calls).toHaveLength(1);
});
