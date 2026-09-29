import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { recoverCoverageCitations } from "./manuscriptCoverageCitationRecovery.js";
import { reviewManuscriptCoverage } from "./manuscriptCoverage.js";
import { scriptedDevelopmentModel } from "./testing/bookDevelopmentFixtures.js";

const fixture = JSON.parse(readFileSync(new URL("./testing/balancedCoverageCitation.json", import.meta.url), "utf8"));
const spanId = "page-27:231-309";

it("resolves Balanced's captured name transcription through a source selection, preserving its multi-page evidence", async () => {
  const { id: _id, source: _source, obligationId: _identity, ...requirement } = fixture.requirement;
  const { model, calls } = scriptedDevelopmentModel([
    { complete: true, requirements: [{ ...fixture.verdict, id: "brief-1" }] },
    fixture.recoveredCorrection
  ]);
  const result = await reviewManuscriptCoverage({ brief: fixture.brief, promises: [], pages: fixture.pages, textModel: model,
    inventory: { brief: fixture.brief, complete: true, status: "available", requirements: [requirement] } });
  expect(result.requirements[0]).toMatchObject({ status: "fulfilled", reason: fixture.verdict.reason,
    evidence: [fixture.verdict.evidence[0], { pageIndex: 27, quote: fixture.exactQuote }] });
  expect(result.issues).toEqual([]);
  expect(calls).toHaveLength(2);
  const payload = JSON.parse(calls[1]!.messages[1]!.content);
  expect(payload.sourceSpans).toContainEqual({ id: spanId, pageIndex: 27, quote: fixture.exactQuote });
  expect(payload.citations[0].claims[0].supportingEvidence).toEqual([fixture.verdict.evidence[0]]);
  expect(payload.pages.map((page: { index: number }) => page.index)).toEqual([27]);
  expect(calls[1]?.textAttemptBudget?.limit).toBe(1);
});

it("does not override the captured refusal even when the matching source passage is offered", async () => {
  const { model, calls } = scriptedDevelopmentModel([fixture.declinedCorrection]);
  const result = await recoverCoverageCitations({ requirements: [fixture.requirement], verdicts: [fixture.verdict],
    pages: fixture.pages, textModel: model });
  expect(result).toEqual([fixture.verdict]);
  expect(calls).toHaveLength(1);
});

it.each([
  { label: "unknown span", correction: { sourceSpanId: "page-27:0-999" } },
  { label: "unknown span with an exact quote", correction: { sourceSpanId: "page-27:0-999", quote: fixture.exactQuote } },
  { label: "contradictory quote", correction: { sourceSpanId: spanId, quote: "A different action by another character." } },
  { label: "refused selection", correction: { sourceSpanId: spanId, supportsSameClaim: false } }
])("leaves a $label unverified", async ({ correction }) => {
  const { model, calls } = scriptedDevelopmentModel([{ corrections: [{ id: "citation-1", supportsSameClaim: true, quote: null, ...correction }] }]);
  expect(await recoverCoverageCitations({ requirements: [fixture.requirement], verdicts: [fixture.verdict],
    pages: fixture.pages, textModel: model })).toEqual([fixture.verdict]);
  expect(calls).toHaveLength(1);
});

it("rejects a real offered span from a different cited page", async () => {
  const otherQuote = "The lantern waited by the gate.";
  const otherVerdict = { ...fixture.verdict, id: "brief-other", evidence: [{ pageIndex: 28, quote: "The old lantern waited by the gate." }] };
  const { model, calls } = scriptedDevelopmentModel([{ corrections: [
    { id: "citation-1", supportsSameClaim: true, sourceSpanId: `page-28:0-${otherQuote.length}`, quote: null },
    { id: "citation-2", supportsSameClaim: false, sourceSpanId: null, quote: null }
  ] }]);
  const verdicts = [fixture.verdict, otherVerdict];
  expect(await recoverCoverageCitations({ requirements: [fixture.requirement, { ...fixture.requirement, id: otherVerdict.id }],
    verdicts, pages: [...fixture.pages, { index: 28, markdown: otherQuote }], textModel: model })).toEqual(verdicts);
  expect(JSON.parse(calls[0]!.messages[1]!.content).sourceSpans).toContainEqual({
    id: `page-28:0-${otherQuote.length}`, pageIndex: 28, quote: otherQuote
  });
});

it("keeps supporting evidence attached to its own claim when verdict reasons are identical", async () => {
  const otherEvidence = { pageIndex: 11, quote: "Now two lanterns were home." };
  const otherVerdict = { ...fixture.verdict, id: "brief-other", evidence: [otherEvidence, fixture.verdict.evidence[1]] };
  const { model, calls } = scriptedDevelopmentModel([fixture.declinedCorrection]);
  await recoverCoverageCitations({ requirements: [fixture.requirement, { ...fixture.requirement, id: otherVerdict.id }],
    verdicts: [fixture.verdict, otherVerdict], pages: fixture.pages, textModel: model });
  const payload = JSON.parse(calls[0]!.messages[1]!.content);
  expect(payload.citations).toHaveLength(1);
  expect(payload.citations[0].claims.map((claim: { supportingEvidence: unknown }) => claim.supportingEvidence))
    .toEqual([[fixture.verdict.evidence[0]], [otherEvidence]]);
});

it("copies source selection bytes without changing Unicode, whitespace or negation", async () => {
  const quote = "🦉 Turtle did not cross  the bridge.";
  const { model } = scriptedDevelopmentModel([{ corrections: [
    { id: "citation-1", supportsSameClaim: true, sourceSpanId: `page-27:2-${2 + quote.length}`, quote: null }
  ] }]);
  const verdict = { ...fixture.verdict, evidence: [{ pageIndex: 27, quote: quote.replace("Turtle", "Wise Turtle") }] };
  const result = await recoverCoverageCitations({ requirements: [fixture.requirement], verdicts: [verdict],
    pages: [{ index: 27, markdown: `  ${quote}\n` }], textModel: model });
  expect(result[0]?.evidence).toEqual([{ pageIndex: 27, quote }]);
});

it("omits the optional span catalog before it would exceed the existing payload limit", async () => {
  const quote = `Turtle carried ${"a".repeat(450)} along the path.`;
  const markdown = `${quote} `.repeat(25);
  const verdict = { ...fixture.verdict, evidence: [{ pageIndex: 27, quote: quote.replace("Turtle", "Wise Turtle") }] };
  const { model, calls } = scriptedDevelopmentModel([{ corrections: [
    { id: "citation-1", supportsSameClaim: true, sourceSpanId: null, quote }
  ] }]);
  const result = await recoverCoverageCitations({ requirements: [fixture.requirement], verdicts: [verdict],
    pages: [{ index: 27, markdown }], textModel: model });
  expect(result[0]?.evidence).toEqual([{ pageIndex: 27, quote }]);
  expect(calls).toHaveLength(1);
  const content = calls[0]!.messages[1]!.content;
  expect(content.length).toBeLessThanOrEqual(20_000);
  expect(JSON.parse(content)).toMatchObject({ pages: [{ index: 27, markdown }] });
  expect(JSON.parse(content)).not.toHaveProperty("sourceSpans");
});
