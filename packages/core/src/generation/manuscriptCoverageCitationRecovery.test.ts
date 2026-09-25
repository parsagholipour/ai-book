import { expect, it } from "vitest";
import { AdapterJsonParseError } from "../adapters/json.js";
import { recoverCoverageCitations } from "./manuscriptCoverageCitationRecovery.js";
import { scriptedDevelopmentModel } from "./testing/bookDevelopmentFixtures.js";

const actual = "Turtle studied the grass along the path.";
const altered = "Wise Turtle studied the grass along the path.";
const pages = [{ index: 12, markdown: `Rabbit waited. ${actual}` }, { index: 30, markdown: "They shared their supper by the hearth." }];
const requirement = { id: "brief-1", kind: "content", text: "Let Turtle's patience help solve the problem." };
const verdict = { id: requirement.id, status: "fulfilled", reason: "Turtle notices the grass.", evidence: [{ pageIndex: 12, quote: altered }] };
const correction = { id: "citation-1", supportsSameClaim: true, quote: actual };

it("batches a repeated bad quote once with all claims and only the affected page", async () => {
  const requirements = Array.from({ length: 3 }, (_, i) => ({ ...requirement, id: `brief-${i + 1}`, text: `Claim ${i + 1}` }));
  const verdicts = requirements.map((item) => ({ ...verdict, id: item.id }));
  const { model, calls } = scriptedDevelopmentModel([{ corrections: [correction] }]);
  const result = await recoverCoverageCitations({ requirements, verdicts, pages, textModel: model });
  expect(result.map((item) => item.evidence)).toEqual(requirements.map(() => [{ pageIndex: 12, quote: actual }]));
  expect(verdicts[0]?.evidence[0]?.quote).toBe(altered);
  expect(calls).toHaveLength(1);
  expect(calls[0]?.textAttemptBudget).toEqual({ limit: 1, used: 0, outputWidened: true });
  expect(calls[0]?.maxTokens).toBe(2500);
  const payload = JSON.parse(calls[0]!.messages[1]!.content);
  expect(payload.pages).toEqual([pages[0]]);
  expect(payload.citations).toHaveLength(1);
  expect(payload.citations[0].claims.map((claim: { requirement: string }) => claim.requirement)).toEqual(requirements.map((item) => item.text));
});

it("recovers Balanced's capitalized clause without changing the manuscript's lowercase bytes", async () => {
  const quote = "the first three lights made a clear trail through the rain.";
  const { model } = scriptedDevelopmentModel([{ corrections: [{ ...correction, quote }] }]);
  const result = await recoverCoverageCitations({ requirements: [requirement], textModel: model,
    pages: [{ index: 12, markdown: `Rabbit looked back, and ${quote}` }],
    verdicts: [{ ...verdict, evidence: [{ pageIndex: 12, quote: `T${quote.slice(1)}` }] }] });
  expect(result[0]?.evidence).toEqual([{ pageIndex: 12, quote }]);
});

it("does not apply a shared quote correction to verdicts outside the reviewed claims", async () => {
  const other = { ...verdict, id: "brief-2", status: "missing", reason: "The same passage does not show Turtle changing his choice." };
  const { model } = scriptedDevelopmentModel([{ corrections: [correction] }]);
  const result = await recoverCoverageCitations({ requirements: [requirement, { ...requirement, id: other.id }],
    verdicts: [verdict, other], pages, textModel: model });
  expect(result[0]?.evidence).toEqual([{ pageIndex: 12, quote: actual }]);
  expect(result[1]).toEqual(other);
});

it.each([
  { label: "refused", corrections: [{ ...correction, supportsSameClaim: false }] },
  { label: "null", corrections: [{ ...correction, quote: null }] },
  { label: "fabricated", corrections: [{ ...correction, quote: actual.replace("grass", "flowers") }] },
  { label: "wrong page", corrections: [{ ...correction, quote: pages[1]!.markdown }] },
  { label: "too short", corrections: [{ ...correction, quote: "Turtle" }] },
  { label: "unknown id", corrections: [{ ...correction, id: "invented" }] },
  { label: "duplicate id", corrections: [correction, correction] },
  { label: "omitted", corrections: [] }
])("retains the original invalid quote when a correction is $label", async ({ corrections }) => {
  const { model, calls } = scriptedDevelopmentModel([{ corrections }]);
  const result = await recoverCoverageCitations({ requirements: [requirement], verdicts: [verdict], pages, textModel: model });
  expect(result).toEqual([verdict]);
  expect(calls).toHaveLength(1);
});

it.each([
  { label: "missing verdict", verdicts: [{ ...verdict, status: "missing" }], pages },
  { label: "unknown id", verdicts: [{ ...verdict, id: "unknown" }], pages },
  { label: "duplicate verdict", verdicts: [verdict, verdict], pages },
  { label: "empty evidence", verdicts: [{ ...verdict, evidence: [] }], pages },
  { label: "unknown page", verdicts: [verdict], pages: [pages[1]!] },
  { label: "duplicate page", verdicts: [verdict], pages: [pages[0]!, pages[0]!] },
  { label: "ambiguous exact quote", verdicts: [verdict], pages: [...pages, { index: 1, markdown: altered }, { index: 2, markdown: altered }] }
])("makes no correction call for $label", async ({ verdicts, pages: inputPages }) => {
  const { model, calls } = scriptedDevelopmentModel([]);
  expect(await recoverCoverageCitations({ requirements: [requirement], verdicts, pages: inputPages, textModel: model })).toEqual(verdicts);
  expect(calls).toHaveLength(0);
});

it("does not resend a large page or more than eight distinct bad citations", async () => {
  for (const input of [
    { pages: [{ index: 12, markdown: "x".repeat(20_001) }], verdicts: [verdict] },
    { pages, verdicts: [{ ...verdict, evidence: Array.from({ length: 9 }, (_, i) => ({ pageIndex: 12, quote: `An invalid citation number ${i}.` })) }] }
  ]) {
    const { model, calls } = scriptedDevelopmentModel([]);
    expect(await recoverCoverageCitations({ requirements: [requirement], ...input, textModel: model })).toEqual(input.verdicts);
    expect(calls).toHaveLength(0);
  }
});

it.each([
  new Error("provider unavailable"),
  new AdapterJsonParseError("Test", "bad JSON", 1, "{", "{"),
  new Error("output budget exhausted: max_output_tokens"),
  { corrections: "invalid schema" }
])("leaves the review intact after one unsuccessful correction attempt", async (response) => {
  const { model, calls } = scriptedDevelopmentModel([response]);
  expect(await recoverCoverageCitations({ requirements: [requirement], verdicts: [verdict], pages, textModel: model })).toEqual([verdict]);
  expect(calls).toHaveLength(1);
});

it.each(["AbortError", "StopRequestedError"])("propagates %s during citation recovery", async (name) => {
  const error = Object.assign(new Error("Stopped"), { name });
  const { model } = scriptedDevelopmentModel([error]);
  await expect(recoverCoverageCitations({ requirements: [requirement], verdicts: [verdict], pages, textModel: model })).rejects.toBe(error);
});
