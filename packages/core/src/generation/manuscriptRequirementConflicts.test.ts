import { describe, expect, it } from "vitest";
import { reviewManuscriptCoverage, refreshManuscriptCoverageFacts } from "./manuscriptCoverage.js";
import { manuscriptRequirementId } from "./pictureBookRequirementTargets.js";
import { scriptedDevelopmentModel } from "./testing/bookDevelopmentFixtures.js";

const quote = "Wise Turtle notices a pattern in where the lanterns blew";
const brief = `${quote}. Rabbit is playful and hasty.`;
const pages = [{ index: 10, markdown: "Wise Turtle bent low beside the path. Grass near post one leaned toward the fern spur, all its blades pointing the same way. “The wind pushed the lantern that way,” he said." }];
const target = { id: "finding-10", requirementId: manuscriptRequirementId(brief, quote), requirementQuote: quote,
  pageIndex: 10, problem: "Only one displaced lantern's direction is established.",
  acceptanceCriteria: "Compare another displaced lantern or its wind-bent surroundings to establish the shared pattern.",
  evidence: [{ pageIndex: 10, quote: "Grass near post one leaned toward the fern spur, all its blades pointing the same way." }] };
const inventory = { status: "available" as const, brief, complete: true, requirements: [{ text: "Turtle's pattern", quote, kind: "content" as const },
  { text: "Rabbit's traits", quote: "Rabbit is playful and hasty", kind: "content" as const }] };

describe("coverage disagreement with an outstanding full-prose requirement finding", () => {
  it("retains both assessments as an actionable uncertainty instead of claiming fulfillment", async () => {
    const fixture = scriptedDevelopmentModel([{ complete: true, requirements: [
      { id: "brief-1", status: "fulfilled", reason: "Turtle reads the bent grass as a clue to where the wind pushed the lantern.", evidence: target.evidence },
      { id: "brief-2", status: "missing", reason: "Rabbit's playfulness is not established.", evidence: [] }
    ] }]);
    const options = { brief, pages, promises: [], inventory, textModel: fixture.model, requirementTargets: [target] };
    const reviewed = await reviewManuscriptCoverage(options);
    expect(reviewed.requirements[0]).toMatchObject({ status: "unverified", reason: expect.stringContaining("Reviewers disagree") });
    expect(reviewed.requirements[0]!.reason).toContain(target.acceptanceCriteria);
    expect(reviewed.requirements[0]!.reason).toContain("Turtle reads the bent grass");
    expect(reviewed.requirements[1]!.status).toBe("missing");
    expect(reviewed.status).toBe("incomplete");
    expect(fixture.calls).toHaveLength(1);
    expect(JSON.parse(fixture.calls[0]!.messages[1]!.content).requirementTargets).toEqual([target]);
    const refreshed = refreshManuscriptCoverageFacts(reviewed, { title: "The Lantern Path", targetStoryPages: 1,
      storyPageIndexes: [10], illustratedPageIndexes: [], expectedIllustratedPageIndexes: [], characters: [], referenceProvenance: [], mediaInventory: {} });
    expect(refreshed.requirements[0]!.status).toBe("unverified");
  });
});


it.each(["missing", "unverified"] as const)("keeps a coverage verdict of %s without claiming the target was resolved", async status => {
  const fixture = scriptedDevelopmentModel([{ complete: true, requirements: [
    { id: "brief-1", status, reason: "The comparison remains absent or uncertain.", evidence: [] },
    { id: "brief-2", status: "missing", reason: "Rabbit's playfulness is not established.", evidence: [] }
  ] }]);
  const reviewed = await reviewManuscriptCoverage({ brief, pages, promises: [], inventory, textModel: fixture.model, requirementTargets: [target] });
  expect(reviewed.requirements[0]).toMatchObject({ status, reason: "The comparison remains absent or uncertain." });
  expect(fixture.calls).toHaveLength(1);
});

it("retains a finding when coverage chose a different source clause instead of silently matching by topic", async () => {
  const fixture = scriptedDevelopmentModel([{ complete: true, requirements: [
    { id: "brief-1", status: "fulfilled", reason: "A direction is described.", evidence: target.evidence }
  ] }]);
  const reviewed = await reviewManuscriptCoverage({ brief, pages, promises: [],
    inventory: { ...inventory, requirements: [{ text: "Turtle's observation", quote: "Wise Turtle notices a pattern", kind: "content" }] },
    textModel: fixture.model, requirementTargets: [target] });
  expect(reviewed.requirements).toContainEqual(expect.objectContaining({ id: target.id, quote, status: "unverified",
    reason: expect.stringContaining("not aligned with the coverage inventory") }));
  expect(reviewed.status).toBe("incomplete");
});


it("keeps distinct obligations quoted from one shared clause separate", async () => {
  const fixture = scriptedDevelopmentModel([{ complete: true, requirements: [
    { id: "brief-1", status: "fulfilled", reason: "Turtle observes the grass.", evidence: target.evidence },
    { id: "brief-2", status: "missing", reason: "No relationship between locations is established.", evidence: [] }
  ] }]);
  const reviewed = await reviewManuscriptCoverage({ brief, pages, promises: [],
    inventory: { ...inventory, requirements: [{ text: "Turtle makes an observation", quote, kind: "content" },
      { text: "A pattern across lantern locations", quote, kind: "content" }] },
    textModel: fixture.model, requirementTargets: [target] });
  expect(reviewed.requirements.map(r => [r.id, r.status])).toEqual([["brief-1", "fulfilled"], ["brief-2", "missing"], [target.id, "unverified"]]);
  expect(reviewed.requirements[2]!.reason).toContain(target.acceptanceCriteria);
});
