import { expect, it } from "vitest";
import { inventoryManuscriptRequirements, manuscriptCoverageSchema, manuscriptRequirementInventorySchema,
  refreshManuscriptCoverageFacts, reviewManuscriptCoverage, type CoverageEvidenceContext } from "./manuscriptCoverage.js";
import { scriptedDevelopmentModel } from "./testing/bookDevelopmentFixtures.js";
import { recoverRequirementQuotes } from "./manuscriptRequirementQuotes.js";
import captured from "./testing/lanternRequirementInventory.json" with { type: "json" };

const bad = captured.inventory.requirements.filter(r => !captured.brief.includes(r.quote));
const context: CoverageEvidenceContext = { title: "Story", targetStoryPages: 1, storyPageIndexes: [1],
  illustratedPageIndexes: [], expectedIllustratedPageIndexes: [], characters: [], referenceProvenance: [] };
const growth = "Keep both active across the story, with meaningful choices and growth for each.";
const strengths = "Let Rabbit's energy and Wise Turtle's patience both solve part of the problem.";
const corrections = [9, 10, 23, 24].map(i => ({ id: `brief-${i}`, supportsSameRequirement: true, quote: i < 20 ? growth : strengths }));

it("recovers Quick's four source quotes in one call without merging or relabeling the obligations", async () => {
  const { model, calls } = scriptedDevelopmentModel([captured.inventory, { corrections }]);
  const inventory = await inventoryManuscriptRequirements({ brief: captured.brief, textModel: model });
  expect(inventory.complete).toBe(true);
  expect(inventory.requirements).toHaveLength(36);
  inventory.requirements.forEach((r, i) => {
    const original = captured.inventory.requirements[i]!;
    const correction = corrections.find(c => c.id === `brief-${i + 1}`);
    const expected = original.text === "Avoid extra named main characters"
      ? { ...original, kind: "prohibition", prohibitionScope: "named_main_characters" } : original;
    expect(r).toEqual(correction ? { ...expected, originalQuote: original.quote, quote: correction.quote } : expected);
  });
  const request = JSON.parse(calls[1]!.messages.at(-1)!.content);
  expect(request.phase).toBe("brief_requirement_quote_recovery");
  expect(request.requirements.map((r: { id: string }) => r.id)).toEqual(corrections.map(c => c.id));
  expect(Object.keys(request)).toEqual(["phase", "brief", "requirements"]);
  expect(calls).toHaveLength(2);
});

it("assesses separately labeled character arcs grounded in the same exact shared sentence", async () => {
  const prose = "Rabbit stopped rushing and listened. Turtle tried Rabbit's idea despite his doubts.";
  const { model, calls } = scriptedDevelopmentModel([{ complete: true, requirements: [1, 2].map(i => ({
    id: `brief-${i}`, status: "fulfilled", reason: "A changed choice is shown.", evidence: [{ pageIndex: 1, quote: prose }]
  })) }]);
  const review = await reviewManuscriptCoverage({ brief: captured.brief, promises: [], pages: [{ index: 1, markdown: prose }], textModel: model,
    inventory: manuscriptRequirementInventorySchema.parse({ brief: captured.brief, status: "available", complete: true,
      requirements: bad.slice(0, 2).map(r => ({ ...r, quote: growth, originalQuote: r.quote })) }) });
  expect(review.status).toBe("reviewed");
  expect(review.requirements.map(r => [r.text, r.status])).toEqual(bad.slice(0, 2).map(r => [r.text, "fulfilled"]));
  expect(JSON.parse(calls[0]!.messages.at(-1)!.content).requirements).toHaveLength(2);
});

it("retains all four rejected Quick obligations when source-quote correction is unavailable", async () => {
  const { model, calls } = scriptedDevelopmentModel([captured.inventory, new Error("Correction unavailable")]);
  const inventory = await inventoryManuscriptRequirements({ brief: captured.brief, textModel: model });
  expect(inventory.requirements).toHaveLength(captured.inventory.requirements.length);
  expect(inventory.complete).toBe(false);
  for (const requirement of bad) expect(inventory.requirements).toContainEqual({ ...requirement, sourceQuoteIssue: "not_in_brief" });
  expect(manuscriptRequirementInventorySchema.parse(JSON.parse(JSON.stringify(inventory)))).toEqual(inventory);
  expect(calls).toHaveLength(2);
  expect(calls[1]?.textAttemptBudget).toMatchObject({ limit: 1, outputWidened: true });
});

it("keeps invalid cached requests unverified through semantic review and export-fact refresh", async () => {
  const brief = "Use one story page. Show growth for Rabbit and Turtle.";
  const { model, calls } = scriptedDevelopmentModel([{ complete: true, requirements: [
    { id: "brief-1", status: "fulfilled", reason: "The title matches.", evidence: [] }
  ] }]);
  const review = await reviewManuscriptCoverage({ brief, promises: [], pages: [{ index: 1, markdown: "Rabbit listened." }],
    textModel: model, evidenceContext: context, inventory: { brief, status: "available", complete: true, requirements: [
      { text: "Invented title", quote: "Title the book Story.", kind: "title", expectedTitle: "Story" },
      { text: "Story page count", quote: "Use one story page.", kind: "page_count", expectedCount: 1 }
    ] } });
  expect(review.requirements.map(r => [r.id, r.status])).toEqual([["brief-1", "unverified"], ["brief-2", "fulfilled"]]);
  expect(review.requirements[0]).toMatchObject({ sourceQuoteIssue: "not_in_brief", evidence: [], reason: expect.stringContaining("source quote") });
  const payload = JSON.parse(calls[0]!.messages.at(-1)!.content);
  expect(payload.requirements).toEqual([]);
  expect(payload.factRequirements.map((r: { id: string }) => r.id)).toEqual(["brief-2"]);
  const persisted = manuscriptCoverageSchema.parse(JSON.parse(JSON.stringify(review)));
  const refreshed = refreshManuscriptCoverageFacts(persisted, context);
  expect(refreshed.requirements[0]?.status).toBe("unverified");
  expect(refreshed.status).toBe("incomplete");
  expect(review.issues.map(i => i.code)).toEqual(["BRIEF_COVERAGE_UNVERIFIED"]);
  expect(review.issues[0]?.message).toContain("Invented title");
});

it.each(["content", "table", "structure", "title", "page_count", "illustration", "media_absence", "character", "visual"])(
  "never assesses an ungrounded %s requirement as a fulfilled or missing obligation", async (kind) => {
    const { model, calls } = scriptedDevelopmentModel([]);
    const review = await reviewManuscriptCoverage({ brief: "A gentle story.", promises: [], pages: [], textModel: model, evidenceContext: context,
      inventory: manuscriptRequirementInventorySchema.parse({ brief: "A gentle story.", status: "available", complete: true,
        requirements: [{ text: "Invented request", quote: "This request was invented.", kind, expectedTitle: "Story", expectedCount: 1 }] }) });
    expect(review.requirements[0]).toMatchObject({ id: "brief-1", status: "unverified", sourceQuoteIssue: "not_in_brief", evidence: [] });
    expect(refreshManuscriptCoverageFacts(review, context).requirements[0]?.status).toBe("unverified");
    expect(review.issues.map(i => i.code)).toEqual(["BRIEF_COVERAGE_UNVERIFIED"]);
    expect(calls).toHaveLength(0);
  });

const single = { text: "Rabbit's growth", quote: "Rabbit ... grows", kind: "content" };
const valid = { id: "brief-1", supportsSameRequirement: true, quote: growth };
it.each([
  { label: "declined", corrections: [{ ...valid, supportsSameRequirement: false }] },
  { label: "invented quote", corrections: [{ ...valid, quote: "Rabbit grows by flying." }] },
  { label: "missing", corrections: [] },
  { label: "duplicate", corrections: [valid, valid] },
  { label: "invented ID", corrections: [{ ...valid, id: "brief-99" }] },
  { label: "empty", corrections: [{ ...valid, quote: " " }] },
  { label: "null", corrections: [{ ...valid, quote: null }] }
])("retains a source-quote failure when recovery is $label", async ({ corrections }) => {
  const { model, calls } = scriptedDevelopmentModel([{ corrections }]);
  const requirements = await recoverRequirementQuotes({ brief: captured.brief, requirements: [single], textModel: model });
  expect(requirements).toEqual([{ ...single, sourceQuoteIssue: "not_in_brief" }]);
  expect(calls).toHaveLength(1);
});

it.each([new Error("Provider unavailable"), new Error("max_output_tokens"), { corrections: "bad schema" }])(
  "keeps source failures after one failed correction without widening or retrying", async response => {
    const { model, calls } = scriptedDevelopmentModel([response]);
    const requirements = await recoverRequirementQuotes({ brief: captured.brief, requirements: [single], textModel: model });
    expect(requirements[0]?.sourceQuoteIssue).toBe("not_in_brief");
    expect(calls).toHaveLength(1);
  });

it("skips correction for a clean inventory, too many failures, or an oversized brief", async () => {
  for (const options of [
    { brief: growth, requirements: [{ ...single, quote: growth }] },
    { brief: captured.brief, requirements: Array.from({ length: 9 }, () => single) },
    { brief: "x".repeat(20_001), requirements: [single] }
  ]) {
    const { model, calls } = scriptedDevelopmentModel([]);
    const result = await recoverRequirementQuotes({ ...options, textModel: model });
    expect(result).toHaveLength(options.requirements.length);
    expect(calls).toHaveLength(0);
  }
});

it("preserves empty source quotes and propagates cancellation during correction", async () => {
  const { model } = scriptedDevelopmentModel([{ corrections: [] }]);
  expect((await recoverRequirementQuotes({ brief: growth, requirements: [{ ...single, quote: "" }], textModel: model }))[0]?.sourceQuoteIssue).toBe("empty");
  const stopped = Object.assign(new Error("Stopped"), { name: "StopRequestedError" });
  const cancelled = scriptedDevelopmentModel([captured.inventory, stopped]);
  await expect(inventoryManuscriptRequirements({ brief: captured.brief, textModel: cancelled.model })).rejects.toBe(stopped);
});

it("retains rejected source entries even if the later manuscript verifier is unavailable", async () => {
  const { model } = scriptedDevelopmentModel([new Error("Verifier unavailable")]);
  const review = await reviewManuscriptCoverage({ brief: growth, promises: [], pages: [], textModel: model,
    inventory: manuscriptRequirementInventorySchema.parse({ brief: growth, status: "available", complete: false, requirements: [single, { ...single, text: "Turtle's growth", quote: growth }] }) });
  expect(review.status).toBe("unavailable");
  expect(review.requirements[0]).toMatchObject({ id: "brief-1", quote: single.quote, status: "unverified" });
  expect(review.issues[0]?.message).toContain(single.text);
});
