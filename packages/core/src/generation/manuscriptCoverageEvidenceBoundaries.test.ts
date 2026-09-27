import { expect, it } from "vitest";
import { recoverProhibitionEvidence } from "./manuscriptCoverageCastRecovery.js";
import { prohibitionCoverageVerdict, type ProhibitionAssessment } from "./manuscriptCoverageProhibitions.js";
import { coverageCitationResolver } from "./manuscriptCoverageCitations.js";
import { recoverCoverageCitations } from "./manuscriptCoverageCitationRecovery.js";
import { scriptedDevelopmentModel } from "./testing/bookDevelopmentFixtures.js";

const pages = [{ index: 1, markdown: "The neighbors brought baskets to the picnic." },
  { index: 2, markdown: "Ridge Turn lay at the top of the steep path." }];
const requirement = { id: "brief-1", kind: "prohibition", prohibitionScope: "named_main_characters" };
const base: ProhibitionAssessment = { scope: "whole_manuscript", complete: true, checkedPageIndexes: [1, 2], counterexamples: [],
  entities: [{ name: "unnamed neighbors", aliases: ["the neighbors"], role: "other", reason: "An unnamed group.",
    evidence: [{ pageIndex: 1, quote: pages[0]!.markdown }], permissionQuote: null },
  { name: "Ridge Turn", aliases: [], role: "place", reason: "A place on the route.",
    evidence: [{ pageIndex: 1, quote: pages[1]!.markdown }], permissionQuote: null }] };

async function recover(assessment: ProhibitionAssessment, source = pages) {
  const { model, calls } = scriptedDevelopmentModel([]);
  const before = structuredClone(assessment);
  const context = { brief: "No extra named main characters.", pages: source, assessmentComplete: true };
  const answers = await recoverProhibitionEvidence({ ...context, requirements: [requirement],
    verdicts: [{ id: requirement.id, status: "fulfilled", prohibitionAssessment: assessment }], textModel: model });
  expect(calls).toHaveLength(0);
  expect(assessment).toEqual(before);
  return prohibitionCoverageVerdict({ ...context, requirement, answer: answers[0] });
}

it("keeps every entity and role while recovering an exact named witness and a literal group alias", async () => {
  const result = await recover(base);
  expect(result?.status).toBe("fulfilled");
  expect(result?.prohibitionAssessment?.entities).toEqual([
    { ...base.entities[0], name: "the neighbors", aliases: [] },
    { ...base.entities[1], evidence: [{ pageIndex: 2, quote: pages[1]!.markdown }] }
  ]);
});

it.each<{ label: string; change: (audit: ProhibitionAssessment) => void }>([
  { label: "unrelated descriptive label", change: a => { a.entities[0]!.name = "unfamiliar villagers"; } },
  { label: "missing literal alias", change: a => { a.entities[0]!.aliases = []; } },
  { label: "mismatched literal alias", change: a => { a.entities[0]!.aliases = ["baskets"]; } },
  { label: "duplicate aliases", change: a => { a.entities[0]!.aliases.push("the neighbors"); } },
  { label: "invented additional alias", change: a => { a.entities[0]!.aliases.push("villagers"); } },
  { label: "main character label", change: a => { a.entities[0]!.role = "main_character"; } },
  { label: "supporting character label", change: a => { a.entities[0]!.role = "supporting_character"; } },
  { label: "invented permission", change: a => { a.entities[0]!.permissionQuote = "They are permitted."; } },
  { label: "incomplete page scope", change: a => { a.checkedPageIndexes.pop(); } },
  { label: "uncertain role", change: a => { a.entities[1]!.role = "uncertain"; } },
  { label: "fabricated role quote", change: a => { a.entities[1]!.evidence[0]!.quote = "Ridge Turn floated above the clouds."; } },
  { label: "forged counterexample", change: a => { a.counterexamples.push({ pageIndex: 2, quote: pages[1]!.markdown }); } }
])("does not turn $label into a verified absence claim", async ({ change }) => {
  const audit = structuredClone(base); change(audit);
  expect((await recover(audit))?.status).toBe("unverified");
});

it.each([
  [...pages, { index: 3, markdown: pages[1]!.markdown }],
  [pages[0]!, { index: 2, markdown: `${pages[1]!.markdown} ${pages[1]!.markdown}` }],
  [...pages, { index: 2, markdown: "A duplicate page number." }]
].map(source => ({ source })))("does not relocate ambiguous source evidence", async ({ source }) => {
  const audit = structuredClone(base); audit.checkedPageIndexes = source.map(page => page.index);
  expect((await recover(audit, source))?.status).toBe("unverified");
});

it("does not move pronoun-only role evidence to another page even with a separate name anchor", async () => {
  const audit = structuredClone(base);
  audit.entities[1]!.evidence = [{ pageIndex: 1, quote: "It was where the travelers stopped." }];
  audit.entities[1]!.namingEvidence = { pageIndex: 2, quote: "Ridge Turn" };
  expect((await recover(audit, [pages[0]!, { index: 2, markdown: `${pages[1]!.markdown} It was where the travelers stopped.` }]))?.status).toBe("unverified");
});

it("does not canonicalize a descriptive label when its alias appears only outside the role witness", async () => {
  const audit = structuredClone(base);
  audit.entities[0]!.evidence = [{ pageIndex: 1, quote: "Baskets stood on the ground." }];
  audit.entities[0]!.namingEvidence = { pageIndex: 1, quote: "The neighbors" };
  expect((await recover(audit, [{ index: 1, markdown: `${pages[0]!.markdown} Baskets stood on the ground.` }, pages[1]!]))?.status).toBe("unverified");
});

it("expands short exact dialogue without dropping negation, changing bytes, or searching other pages", async () => {
  const quote = "“Go.”", markdown = `Wise Turtle did not say ${quote} Rabbit had imagined the command.`;
  const { model, calls } = scriptedDevelopmentModel([]);
  const answer = { id: "brief-1", status: "fulfilled", reason: "The reviewer evaluates the whole passage.", evidence: [{ pageIndex: 2, quote }] };
  const result = await recoverCoverageCitations({ requirements: [{ id: "brief-1", kind: "content", text: "Show the choice." }],
    verdicts: [answer], pages: [{ index: 2, markdown }], textModel: model });
  expect(result[0]?.evidence).toEqual([{ pageIndex: 2, quote: markdown }]);
  expect(result[0]?.reason).toBe(answer.reason);
  expect(calls).toHaveLength(0);
});

it.each([
  { quote: "“You lead.”", markdown: "Wise Turtle said, “You lead.” Then Rabbit said, “You lead.”" },
  { quote: "“You lead.”", markdown: "Wise Turtle said, “You wait.”" },
  { quote: "You lead.", markdown: "Wise Turtle said, “You lead.”" },
  { quote: "“You lead.”", markdown: "“You lead.”\n\nWise Turtle stood nearby." },
  { quote: "“You lead.”", markdown: `${"Long context. ".repeat(60)}Wise Turtle said, “You lead.”` },
  { quote: "“You lead”", markdown: "Wise Turtle said, “You lead”" },
  { quote: "Turtle", markdown: "Wise Turtle said nothing." },
  { quote: "“!!!”", markdown: "Wise Turtle shouted, “!!!”" }
])("keeps unsupported short evidence unverified: $quote / $markdown", ({ quote, markdown }) => {
  expect(coverageCitationResolver([{ index: 2, markdown }])({ pageIndex: 2, quote })).toBeUndefined();
});

it("never relocates short dialogue or accepts duplicate page indexes", () => {
  const page = { index: 2, markdown: "Wise Turtle stepped aside. “You lead.”" };
  expect(coverageCitationResolver([page])({ pageIndex: 1, quote: "“You lead.”" })).toBeUndefined();
  expect(coverageCitationResolver([page, page])({ pageIndex: 2, quote: "“You lead.”" })).toBeUndefined();
});
