import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { recoverProhibitionEvidence } from "./manuscriptCoverageCastRecovery.js";
import { prohibitionCoverageVerdict } from "./manuscriptCoverageProhibitions.js";
import { scriptedDevelopmentModel } from "./testing/bookDevelopmentFixtures.js";

const fixture = JSON.parse(readFileSync(new URL("./testing/representationRecovery0928.json", import.meta.url), "utf8"));
const requirement = { id: "brief-35", kind: "prohibition", prohibitionScope: "named_main_characters" };
const context = { brief: fixture.quick.brief, pages: fixture.cast.pages, assessmentComplete: true,
  knownCharacterNames: ["Rabbit", "Wise Turtle"], selectedCharacterNames: ["Rabbit", "Wise Turtle"] };
function corrections() {
  return { corrections: [
    { id: "brief-35:entity-4", supportsSameEntityAndRole: true, namingEvidence: { pageIndex: 21,
      quote: fixture.cast.pages.find((p: { index: number }) => p.index === 21).markdown } },
    { id: "brief-35:entity-8", supportsSameEntityAndRole: true, namingEvidence: { pageIndex: 17,
      quote: "The lantern itself remained at the pond bank." } }
  ] };
}
it("recovers the captured cast anchors without letting a nonexistent alias block the bounded correction", async () => {
  const { model, calls } = scriptedDevelopmentModel([corrections()]);
  const [answer] = await recoverProhibitionEvidence({ ...context, requirements: [requirement], verdicts: [fixture.cast.verdict], textModel: model });
  expect(calls).toHaveLength(1);
  expect(prohibitionCoverageVerdict({ ...context, requirement, answer })?.status).toBe("fulfilled");
  expect(answer.prohibitionAssessment.entities).toHaveLength(fixture.cast.verdict.prohibitionAssessment.entities.length);
  expect(answer.prohibitionAssessment.entities.map((e: { name: string; role: string }) => [e.name, e.role]))
    .toEqual(fixture.cast.verdict.prohibitionAssessment.entities.map((e: { name: string; role: string }) => [e.name, e.role]));
  expect(answer.prohibitionAssessment.entities.at(-1).aliases).toEqual([]);
});

it.each(["refused", "inventedQuote", "wrongIdentity", "missing"])("retains an unverified cast after %s anchor recovery", async kind => {
  const response = corrections();
  if (kind === "refused") response.corrections[0]!.supportsSameEntityAndRole = false;
  if (kind === "inventedQuote") response.corrections[0]!.namingEvidence.quote = "A path that is not in the story.";
  if (kind === "wrongIdentity") response.corrections[0]!.namingEvidence = { pageIndex: 17, quote: "The lantern itself remained at the pond bank." };
  if (kind === "missing") response.corrections.pop();
  const { model, calls } = scriptedDevelopmentModel([response]);
  const [answer] = await recoverProhibitionEvidence({ ...context, requirements: [requirement], verdicts: [fixture.cast.verdict], textModel: model });
  expect(prohibitionCoverageVerdict({ ...context, requirement, answer })?.status).toBe("unverified");
  expect(calls).toHaveLength(1);
});

it("does not remove an observed extra protagonist or use its phantom alias as permission", async () => {
  const verdict = structuredClone(fixture.cast.verdict);
  verdict.prohibitionAssessment.entities.push({ name: "Fox", aliases: ["Rabbit"], role: "main_character", reason: "Fox takes charge.",
    evidence: [{ pageIndex: 31, quote: "Fox took charge and led the entire search alone." }], permissionQuote: "Use the selected saved characters Rabbit and Wise Turtle as the two central characters, respecting their saved character profiles." });
  const pages = [...context.pages, { index: 31, markdown: "Fox took charge and led the entire search alone." }];
  verdict.prohibitionAssessment.checkedPageIndexes.push(31);
  const { model, calls } = scriptedDevelopmentModel([]);
  const [answer] = await recoverProhibitionEvidence({ ...context, pages, requirements: [requirement], verdicts: [verdict], textModel: model });
  expect(prohibitionCoverageVerdict({ ...context, pages, requirement, answer })?.status).toBe("unverified");
  expect(answer.prohibitionAssessment.entities.at(-1).name).toBe("Fox");
  expect(calls).toHaveLength(0);
});
