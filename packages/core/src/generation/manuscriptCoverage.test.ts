import { expect, it } from "vitest";
import { reviewManuscriptCoverage } from "./manuscriptCoverage.js";
import { scriptedDevelopmentModel } from "./testing/bookDevelopmentFixtures.js";

const brief = "Include at least one useful comparison table.";
const inventory = { complete: true, requirements: [{ text: brief, quote: brief, kind: "table" }] };
const prose = "Factoring recovers prime factors of a composite; a discrete logarithm recovers an exponent in a group.";
const verdict = (id = "brief-1", quote = prose, status = "fulfilled") => ({ id, status, reason: "The passage supplies the requested explanation.", evidence: [{ pageIndex: 1, quote }] });

it("does not let a prose comparison fulfill Balanced's requested table", async () => {
  const { model, calls } = scriptedDevelopmentModel([inventory, { complete: true, requirements: [verdict()] }]);
  const result = await reviewManuscriptCoverage({ brief, promises: [], pages: [{ index: 1, markdown: prose }], textModel: model });
  expect(result.requirements[0]?.status).toBe("missing");
  expect(result.issues).toContainEqual(expect.objectContaining({ code: "MISSING_BRIEF_REQUIREMENT", affectedPageIndexes: [] }));
  expect(calls).toHaveLength(2);
  expect(calls[0]?.messages[1]?.content).not.toContain(prose);
  expect(calls[1]?.messages[1]?.content).toContain(prose);
});

it("recognizes differently phrased explanations as promise evidence without relying on extracted state", async () => {
  const promise = "Clearly explain the conceptual difference between the discrete logarithm problem and integer factorization.";
  const { model } = scriptedDevelopmentModel([{ complete: true, requirements: [] }, { complete: true, requirements: [verdict("promise-1")] }]);
  const result = await reviewManuscriptCoverage({ brief: "", promises: [promise], pages: [{ index: 1, markdown: prose }], textModel: model });
  expect(result.status).toBe("reviewed");
  expect(result.issues).toEqual([]);
  expect(result.requirements[0]?.evidence).toEqual([{ pageIndex: 1, quote: prose }]);
});

it("keeps a genuinely missing promise visible", async () => {
  const { model } = scriptedDevelopmentModel([{ complete: true, requirements: [] }, { complete: true, requirements: [verdict("promise-1", prose, "missing")] }]);
  const result = await reviewManuscriptCoverage({ brief: "", promises: ["Explain forward secrecy."], pages: [{ index: 1, markdown: prose }], textModel: model });
  expect(result.issues[0]?.code).toBe("UNPAID_PROMISE");
});

const table = "| Problem | Unknown |\n| --- | --- |\n| Factoring | Prime factors |\n| Discrete logarithm | Exponent |\n";
it.each([table, "<table><tr><th>Problem</th><th>Unknown</th></tr><tr><td>Factoring</td><td>Prime factors</td></tr></table>"])("accepts a real rendered table with exact evidence", async (markdown) => {
  const { model } = scriptedDevelopmentModel([inventory, { complete: true, requirements: [verdict("brief-1", markdown)] }]);
  const result = await reviewManuscriptCoverage({ brief, promises: [], pages: [{ index: 1, markdown }], textModel: model });
  expect(result.issues).toEqual([]);
});

it.each(["<!-- <table><tr><th>X</th></tr><tr><td>Y</td></tr></table> -->", `\`\`\`md\n${table}\`\`\``, `~~~html\n<table><tr><th>X</th></tr><tr><td>Y</td></tr></table>\n~~~`])("does not count table syntax in fenced examples", async (markdown) => {
  const { model } = scriptedDevelopmentModel([inventory, { complete: true, requirements: [verdict("brief-1", markdown)] }]);
  const result = await reviewManuscriptCoverage({ brief, promises: [], pages: [{ index: 1, markdown }], textModel: model });
  expect(result.requirements[0]?.status).toBe("missing");
});

it.each([
  [verdict("promise-1", "A fabricated passage that is not in the book.")],
  [{ ...verdict("promise-1"), evidence: [{ pageIndex: 99, quote: prose }] }],
  [],
  [verdict("promise-1"), verdict("promise-1")]
].map((requirements) => ({ requirements })))("does not pass missing, duplicate or fabricated payoff evidence", async ({ requirements }) => {
  const { model } = scriptedDevelopmentModel([{ complete: true, requirements: [] }, { complete: true, requirements }]);
  const result = await reviewManuscriptCoverage({ brief: "", promises: ["Explain the two problems."], pages: [{ index: 1, markdown: prose }], textModel: model });
  expect(result.status).toBe("incomplete");
  expect(result.issues.map((issue) => issue.code)).toEqual(["BRIEF_COVERAGE_UNVERIFIED"]);
});

it("does not accuse the book of a fabricated brief requirement", async () => {
  const { model } = scriptedDevelopmentModel([inventory]);
  const result = await reviewManuscriptCoverage({ brief: "Do not include tables.", promises: [], pages: [{ index: 1, markdown: prose }], textModel: model });
  expect(result.issues.map((issue) => issue.code)).toEqual(["BRIEF_COVERAGE_UNVERIFIED"]);
});

it.each([new Error("provider unavailable"), { complete: false, requirements: [] }])("makes unavailable or partial reviews explicit", async (response) => {
  const { model } = scriptedDevelopmentModel([response]);
  const result = await reviewManuscriptCoverage({ brief, promises: [], pages: [{ index: 1, markdown: prose }], textModel: model });
  expect(result.issues[0]?.code).toBe("BRIEF_COVERAGE_UNVERIFIED");
});

it("does not silently review only a prefix of an oversized manuscript", async () => {
  const { model, calls } = scriptedDevelopmentModel([]);
  const result = await reviewManuscriptCoverage({ brief, promises: [], pages: [{ index: 1, markdown: "a".repeat(500_001) }], textModel: model });
  expect(result.status).toBe("incomplete");
  expect(calls).toHaveLength(0);
});

it("propagates cancellation", async () => {
  const error = Object.assign(new Error("Stopped"), { name: "StopRequestedError" });
  const { model } = scriptedDevelopmentModel([error]);
  await expect(reviewManuscriptCoverage({ brief, promises: [], pages: [], textModel: model })).rejects.toBe(error);
});
