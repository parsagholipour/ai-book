import { expect, it } from "vitest";
import { manuscriptCoverageSchema, refreshManuscriptCoverageFacts, reviewManuscriptCoverage, type CoverageEvidenceContext } from "./manuscriptCoverage.js";
import { normalizeCoverageProhibition } from "./manuscriptCoverageProhibitions.js";
import { scriptedDevelopmentModel } from "./testing/bookDevelopmentFixtures.js";
import captured from "./testing/balancedNamedCast.json" with { type: "json" };

const brief = "Use Rabbit and Wise Turtle as the two central characters. Avoid extra named main characters.";
const pages = [
  { index: 1, markdown: "Rabbit and Wise Turtle followed Amber's light through Woodland Gate." },
  { index: 2, markdown: "Wise Turtle helped Rabbit guide the unnamed neighbors to the picnic." }
];
const permission = "Use Rabbit and Wise Turtle as the two central characters.";
const entity = (name: string, role = "main_character") => ({ name, aliases: [], role,
  reason: role === "main_character" ? "One of the two protagonists who solves the problem." : "A lantern or place, not an acting character.",
  evidence: [{ pageIndex: 1, quote: pages[0]!.markdown }], permissionQuote: role === "main_character" ? permission : null });
const assessment = () => ({ scope: "whole_manuscript", complete: true, checkedPageIndexes: [1, 2],
  entities: [entity("Rabbit"), entity("Wise Turtle"), entity("Amber", "object"), entity("Woodland Gate", "place")], counterexamples: [] });

const context: CoverageEvidenceContext = { title: "The Lantern Path", targetStoryPages: 2, storyPageIndexes: [1, 2],
  characters: ["Rabbit", "Wise Turtle"].map(name => ({ name, description: "", traits: [], visualRules: [] })),
  illustratedPageIndexes: [], expectedIllustratedPageIndexes: [], referenceProvenance: [] };
async function review(prohibitionAssessment?: unknown, evidence: { pageIndex: number; quote: string }[] = [], options: {
  pages?: typeof pages; complete?: boolean; context?: CoverageEvidenceContext; status?: string;
  recovery?: unknown;
  brief?: string; requirement?: { text: string; quote: string; kind: string; prohibitionScope?: string };
} = {}) {
  const { model, calls } = scriptedDevelopmentModel([
    { complete: true, requirements: [options.requirement ?? { text: "Avoid extra named main characters", quote: "Avoid extra named main characters.", kind: "content" }] },
    { complete: options.complete ?? true, requirements: [{ id: "brief-1", status: options.status ?? "fulfilled", reason: "Only the requested characters lead the story.", evidence,
      ...(prohibitionAssessment === undefined ? {} : { prohibitionAssessment }) }] },
    ...("recovery" in options ? [options.recovery] : [])
  ]);
  const result = await reviewManuscriptCoverage({ brief: options.brief ?? brief, promises: [], pages: options.pages ?? pages,
    evidenceContext: options.context ?? context, textModel: model });
  expect(calls).toHaveLength("recovery" in options ? 3 : 2);
  return result;
}

it("accepts a grounded whole-manuscript cast assessment without a fake absence quotation", async () => {
  const result = await review(assessment());
  expect(result.requirements[0]?.status).toBe("fulfilled");
  expect(result.status).toBe("reviewed");
  expect(result.requirements[0]).toMatchObject({ prohibitionAssessment: assessment() });
});

it("does not let an arbitrary opening quote stand in for a complete cast assessment", async () => {
  const result = await review(undefined, [{ pageIndex: 1, quote: pages[0]!.markdown }]);
  expect(result.requirements[0]?.status).toBe("unverified");
  expect(result.status).toBe("incomplete");
});

it("handles the captured 30-page Balanced prohibition without changing the manuscript or inventing evidence", async () => {
  const permissionQuote = "Use the selected saved characters Rabbit and Wise Turtle as the two central characters, respecting their saved character profiles.";
  const audit = { scope: "whole_manuscript", complete: true, checkedPageIndexes: captured.pages.map(p => p.index),
    entities: [
      { ...entity("Rabbit"), evidence: [{ pageIndex: 1, quote: captured.pages[0]!.markdown }], permissionQuote },
      { ...entity("Wise Turtle"), aliases: ["Turtle"], evidence: [{ pageIndex: 5, quote: captured.pages[4]!.markdown }], permissionQuote },
      ...["Amber", "Blue", "Red", "Green"].map(name => ({ ...entity(name, "object"), evidence: [{ pageIndex: 2, quote: captured.pages[1]!.markdown }] })),
      { ...entity("Woodland Gate", "place"), evidence: [{ pageIndex: 1, quote: captured.pages[0]!.markdown }] }
    ], counterexamples: [] };
  const options = { brief: captured.brief, pages: captured.pages, requirement: captured.requirement,
    context: { ...context, targetStoryPages: 30, storyPageIndexes: audit.checkedPageIndexes } };
  expect((await review(undefined, [], options)).requirements[0]?.status).toBe("unverified");
  expect((await review(undefined, [{ pageIndex: 1, quote: captured.pages[0]!.markdown }], options)).requirements[0]?.status).toBe("unverified");
  const result = await review(audit, [], options);
  expect(result.requirements[0]).toMatchObject({ kind: "prohibition", prohibitionScope: "named_main_characters", status: "fulfilled", evidence: [], prohibitionAssessment: audit });
  const stored = manuscriptCoverageSchema.parse(JSON.parse(JSON.stringify(result)));
  expect(refreshManuscriptCoverageFacts(stored, options.context).requirements).toEqual(stored.requirements);
});

it.each([[1], [1, 1], [1, 2, 3]].map(indexes => ({ indexes })))("rejects incomplete, duplicate or invented inspected scope $indexes", async ({ indexes }) => {
  expect((await review({ ...assessment(), checkedPageIndexes: indexes })).requirements[0]?.status).toBe("unverified");
});

it("keeps incomplete reads and uncertain roles unverified", async () => {
  expect((await review({ ...assessment(), complete: false })).requirements[0]?.status).toBe("unverified");
  expect((await review(assessment(), [], { complete: false })).requirements[0]?.status).toBe("unverified");
  const audit = assessment(); audit.entities[0]!.role = "uncertain";
  expect((await review(audit)).requirements[0]?.status).toBe("unverified");
});

it.each([undefined, { scope: "first_chapter" }, { ...assessment(), entities: "missing" }])("rejects missing or malformed audits without a recovery call", async audit => {
  expect((await review(audit)).requirements[0]?.status).toBe("unverified");
});

it("requires exact entity-role witnesses, recovering only a unique named source coordinate", async () => {
  const invented = assessment(); invented.entities[0]!.evidence = [{ pageIndex: 1, quote: "Rabbit invented this passage." }];
  expect((await review(invented)).requirements[0]?.status).toBe("unverified");
  const misplaced = assessment(); misplaced.entities[0]!.evidence = [{ pageIndex: 2, quote: pages[0]!.markdown }];
  const result = await review(misplaced);
  expect(result.requirements[0]?.status).toBe("fulfilled");
  expect(result.requirements[0]?.prohibitionAssessment?.entities[0]?.evidence).toEqual([{ pageIndex: 1, quote: pages[0]!.markdown }]);
});

it("leaves unrelated role evidence unverified when the recovery reviewer rejects its identity link", async () => {
  const audit = assessment(); audit.entities[0]!.evidence = [{ pageIndex: 1, quote: "Amber's light through Woodland Gate." }];
  const result = await review(audit, [], { recovery: { corrections: [{ id: "brief-1:entity-1", supportsSameEntityAndRole: false, namingEvidence: null }] } });
  expect(result.requirements[0]?.status).toBe("unverified");
  expect(result.requirements[0]?.prohibitionAssessment).toEqual(audit);
});

it("accepts exact pronoun actions with an explicit name anchor in the original review without recovery", async () => {
  const manuscript = [{ index: 1, markdown: `${pages[0]!.markdown} He held the light.` }, pages[1]!];
  const audit = assessment();
  const entities = audit.entities.map((item, index) => index ? item : { ...item,
    namingEvidence: { pageIndex: 1, quote: manuscript[0]!.markdown }, evidence: [{ pageIndex: 1, quote: "He held the light." }] });
  expect((await review({ ...audit, entities }, [], { pages: manuscript })).requirements[0]?.status).toBe("fulfilled");
});

it("does not omit an observed known character or assign overlapping aliases to different entities", async () => {
  expect((await review({ ...assessment(), entities: assessment().entities.slice(1) })).requirements[0]?.status).toBe("unverified");
  const audit = assessment(); audit.entities.push(entity("Rabbit"));
  expect((await review(audit)).requirements[0]?.status).toBe("unverified");
});

it("does not establish global absence from an empty, duplicated or partial manuscript", async () => {
  for (const manuscript of [[], [pages[0]!], [pages[0]!, pages[0]!], [{ index: 1, markdown: "" }, pages[1]!]])
    expect((await review(assessment(), [], { pages: manuscript })).requirements[0]?.status).toBe("unverified");
});

const foxPage = { index: 3, markdown: "Fox took charge, solved the final clue and led the whole rescue while Rabbit and Wise Turtle followed." };
const extra = () => ({ ...entity("Fox"), permissionQuote: null, reason: "Fox takes over the central resolution.", evidence: [{ pageIndex: 3, quote: foxPage.markdown }] });
const withFox = { pages: [...pages, foxPage], context: { ...context, storyPageIndexes: [1, 2, 3], targetStoryPages: 3 } };
it("reports a grounded late extra protagonist even when the model labels the prohibition fulfilled", async () => {
  const audit = { ...assessment(), checkedPageIndexes: [1, 2, 3], entities: [...assessment().entities, extra()], counterexamples: extra().evidence };
  const result = await review(audit, [], withFox);
  expect(result.requirements[0]?.status).toBe("missing");
  expect(result.issues[0]).toMatchObject({ code: "MISSING_BRIEF_REQUIREMENT", evidence: [{ pageIndex: 3, excerpt: foxPage.markdown }] });
  expect(result.issues[0]?.guidance).toContain("extra main character");
});

it("requires grounded matching counterexamples for a violation, without upgrading reviewer uncertainty", async () => {
  const audit = { ...assessment(), checkedPageIndexes: [1, 2, 3], entities: [...assessment().entities, extra()], counterexamples: extra().evidence };
  for (const counterexamples of [[], [{ pageIndex: 3, quote: "Fox saved the moon." }], [{ pageIndex: 1, quote: pages[0]!.markdown }]])
    expect((await review({ ...audit, counterexamples }, [], withFox)).requirements[0]?.status).toBe("unverified");
  expect((await review(audit, [], { ...withFox, status: "unverified" })).requirements[0]?.status).toBe("unverified");
  expect((await review({ ...assessment(), counterexamples: [{ pageIndex: 1, quote: pages[0]!.markdown }] })).requirements[0]?.status).toBe("unverified");
});

it("permits a grounded incidental named helper and non-character names without treating every name as a protagonist", async () => {
  const helper = { index: 3, markdown: "Fox passed Rabbit a picnic cup, then returned to the unnamed neighbors." };
  const audit = { ...assessment(), checkedPageIndexes: [1, 2, 3], entities: [...assessment().entities,
    { ...extra(), role: "supporting_character", reason: "An incidental helper without an independent arc or central choice.", evidence: [{ pageIndex: 3, quote: helper.markdown }] }] };
  expect((await review(audit, [], { ...withFox, pages: [...pages, helper] })).requirements[0]?.status).toBe("fulfilled");
});

it("does not invent permissions or grant them from generated plan characters", async () => {
  const audit = assessment(); audit.entities[0]!.permissionQuote = "Rabbit may lead any story.";
  expect((await review(audit)).requirements[0]?.status).toBe("unverified");
  const unrequested = { ...extra(), permissionQuote: permission };
  const foxAudit = { ...assessment(), checkedPageIndexes: [1, 2, 3], entities: [...assessment().entities, unrequested] };
  expect((await review(foxAudit, [], { ...withFox, context: { ...withFox.context, characters: [...context.characters, { name: "Fox", description: "", traits: [], visualRules: [] }] } })).requirements[0]?.status).toBe("unverified");
});

it("accepts user-selected character authority only with a grounded clause and trusted selected identities", async () => {
  const selection = "Use the selected saved characters as the two central characters.";
  const audit = assessment(); audit.entities.slice(0, 2).forEach(e => { e.permissionQuote = selection; });
  const options = { brief: `${selection} Avoid extra named main characters.` };
  expect((await review(audit, [], options)).requirements[0]?.status).toBe("unverified");
  expect((await review(audit, [], { ...options, context: { ...context, selectedCharacterNames: ["Rabbit", "Wise Turtle"] } })).requirements[0]?.status).toBe("fulfilled");
});

it("keeps ordinary positive and other negative requirements on their own evidence contract", async () => {
  for (const text of ["Rabbit learns patience.", "Avoid generic moralizing.", "Do not avoid extra named main characters."]) {
    const result = await review(assessment(), [], { brief: text, requirement: { text, quote: text, kind: "content" } });
    expect(result.requirements[0]?.status).toBe("unverified");
    expect(result.requirements[0]?.kind).toBe("content");
  }
});

it("supports explicitly typed inventory outside the English compatibility wording", async () => {
  const text = "لا تضف شخصيات رئيسية أخرى مسماة.";
  const result = await review(assessment(), [], { brief: `${permission} ${text}`, requirement: { text, quote: text, kind: "prohibition", prohibitionScope: "named_main_characters" } });
  expect(result.requirements[0]?.status).toBe("fulfilled");
});

it("keeps other grounded requirements when one cast assessment is malformed", async () => {
  const positive = "Rabbit guides the neighbors.";
  const { model, calls } = scriptedDevelopmentModel([
    { complete: true, requirements: [
      { text: "Avoid extra named main characters", quote: "Avoid extra named main characters.", kind: "content" },
      { text: positive, quote: positive, kind: "content" }
    ] },
    { complete: true, requirements: [
      { id: "brief-1", status: "fulfilled", reason: "Only Rabbit and Turtle lead.", evidence: [], prohibitionAssessment: { entities: false } },
      { id: "brief-2", status: "fulfilled", reason: "The neighbors are guided.", evidence: [{ pageIndex: 2, quote: pages[1]!.markdown }] }
    ] }
  ]);
  const result = await reviewManuscriptCoverage({ brief: `${brief} ${positive}`, promises: [], pages, textModel: model });
  expect(result.requirements.map(r => r.status)).toEqual(["unverified", "fulfilled"]);
  expect(refreshManuscriptCoverageFacts(manuscriptCoverageSchema.parse(result), context).requirements.map(r => r.status))
    .toEqual(["unverified", "fulfilled"]);
  expect(calls).toHaveLength(2);
});

it("does not infer prohibition scope from an ungrounded, ambiguous, conditional or mixed label", () => {
  const item = { text: "Avoid extra named main characters", quote: "extra named main characters.", kind: "content" };
  for (const source of ["Introduce extra named main characters.", "Do not avoid extra named main characters.",
    "Avoid extra named main characters. Introduce extra named main characters.", "Avoid them unless you need extra named main characters."])
    expect(normalizeCoverageProhibition(item, source).kind).toBe("content");
  expect(normalizeCoverageProhibition({ ...item, text: "Avoid extra named main characters and develop Rabbit's arc." }, brief).kind).toBe("content");
});
