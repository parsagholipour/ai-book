import { expect, it } from "vitest";
import captured from "./testing/pageCountMaximum0928.json" with { type: "json" };
import { manuscriptCoverageSchema, refreshManuscriptCoverageFacts, reviewManuscriptCoverage, type CoverageEvidenceContext } from "./manuscriptCoverage.js";
import { scriptedDevelopmentModel } from "./testing/bookDevelopmentFixtures.js";
import { inventoryManuscriptRequirements } from "./manuscriptCoverage.js";
import { briefRequirementSchema } from "../schemas/manuscriptRequirements.js";
import { groupCoverageRequirements } from "./manuscriptCoverageGrouping.js";

const context: CoverageEvidenceContext = captured.evidenceContext;
const saved = () => manuscriptCoverageSchema.parse({ status: "reviewed", assessmentComplete: true, requirements: [
  { ...captured.requirement, id: "brief-3", source: "brief", status: "missing", reason: "Expected 33 pages", evidence: [] }
] });

it("replays Quick's saved maximum without requiring 33 pages or another model call", () => {
  const result = refreshManuscriptCoverageFacts(saved(), context);
  expect(result.requirements[0]?.status).toBe("fulfilled");
});

const indexes = (count: number) => Array.from({ length: count }, (_, i) => i + 1);
function assess(row: unknown, count: number, policy: Partial<CoverageEvidenceContext> = {}) {
  const review = manuscriptCoverageSchema.parse({ status: "reviewed", assessmentComplete: true, requirements: [
    { id: "brief-1", source: "brief", status: "fulfilled", reason: "Old verdict", evidence: [], ...briefRequirementSchema.parse(row) }
  ] });
  const facts: CoverageEvidenceContext = { title: "Story", targetStoryPages: count, storyPageIndexes: indexes(count),
    illustratedPageIndexes: [], expectedIllustratedPageIndexes: [], characters: [], referenceProvenance: [], ...policy };
  return refreshManuscriptCoverageFacts(review, facts).requirements[0]!;
}
const requirement = (quote: string, fields: object = {}) => ({ kind: "page_count", text: "Quantity", quote, ...fields });

it.each([30, 31, 32, 33])("accepts %i complete selected pages against the captured range", count => {
  expect(assess(captured.requirement, count, { requestedStoryPages: 30,
    storyPageCountBounds: { minimumPages: count, maximumPages: count } }).status).toBe("fulfilled");
});

it.each([29, 34])("rejects %i pages outside the captured range", count => {
  expect(assess(captured.requirement, count, { requestedStoryPages: 30,
    storyPageCountBounds: { minimumPages: 30, maximumPages: 33 } }).status).toBe("missing");
});

it.each([
  { quote: "At most 33 story pages", constraint: { kind: "maximum", count: 33 }, actual: 30, status: "fulfilled" },
  { quote: "At most 33 story pages", constraint: { kind: "maximum", count: 33 }, actual: 34, status: "missing" },
  { quote: "At least 30 story pages", constraint: { kind: "minimum", count: 30 }, actual: 31, status: "fulfilled" },
  { quote: "At least 30 story pages", constraint: { kind: "minimum", count: 30 }, actual: 29, status: "missing" },
  { quote: "Exactly 32 story pages", constraint: { kind: "exact", count: 32 }, actual: 32, status: "fulfilled" },
  { quote: "Exactly 32 story pages", constraint: { kind: "exact", count: 32 }, actual: 31, status: "missing" },
  { quote: "Write 30–33 story pages", constraint: { kind: "range", minimum: 30, maximum: 33 }, actual: 31, status: "fulfilled" },
  { quote: "Write 30–33 story pages", constraint: { kind: "range", minimum: 30, maximum: 33 }, actual: 34, status: "missing" }
])("checks $quote against $actual delivered pages", ({ quote, constraint, actual, status }) => {
  expect(assess(requirement(quote, { pageCountConstraint: constraint }), actual).status).toBe(status);
});

it("never lets an upper bound waive the selected map or original customer floor", () => {
  const row = requirement("At most 33 story pages", { pageCountConstraint: { kind: "maximum", count: 33 } });
  expect(assess(row, 32, { requestedStoryPages: 30, targetStoryPages: 33,
    storyPageCountBounds: { minimumPages: 33, maximumPages: 33 } }).status).toBe("missing");
  expect(assess(row, 29, { requestedStoryPages: 30 }).status).toBe("missing");
  expect(assess(row, 30, { storyPageIndexes: [1, ...indexes(29)] }).status).toBe("missing");
  expect(assess(row, 30, { storyPageIndexes: indexes(30).map(index => index + 1) }).status).toBe("missing");
});

it("migrates a legacy bound using its governing source scope, never its label", () => {
  const row = requirement("33 story pages", { text: "Exactly 33", expectedCount: 33,
    scope: { extent: "whole_book", quote: "Write at most 33 story pages" } });
  expect(assess(row, 30)).toMatchObject({ status: "fulfilled", pageCountConstraint: { kind: "maximum", count: 33 } });
  expect(assess({ ...row, quote: "Exactly 33 story pages", scope: undefined, text: "Maximum 33" }, 30).status).toBe("missing");
});

it("keeps legacy original-target compatibility while explicit typed exact quantities remain exact", () => {
  const policy = { requestedStoryPages: 30, targetStoryPages: 33, storyPageCountBounds: { minimumPages: 33, maximumPages: 33 } };
  const row = requirement("Exactly 30 story pages", { expectedCount: 30 });
  expect(assess(row, 33, policy).status).toBe("fulfilled");
  expect(assess({ ...row, pageCountConstraint: { kind: "exact", count: 30 } }, 33, policy).status).toBe("missing");
});

it("does not replace an explicit source count with the current target when its scalar is absent or wrong", () => {
  expect(assess(requirement("Exactly 33 story pages"), 31).status).toBe("missing");
  expect(assess(requirement("Exactly 33 story pages", { expectedCount: 31 }), 31).status).toBe("unverified");
  expect(assess(requirement("Use 30 or 33 story pages", { expectedCount: 33 }), 33).status).toBe("unverified");
  expect(assess(requirement("Use 30 and 33 story pages", { expectedCount: 33 }), 33).status).toBe("unverified");
});

it.each([
  requirement("At most 33 story pages", { pageCountConstraint: { kind: "minimum", count: 33 } }),
  requirement("Exactly 33 story pages", { pageCountConstraint: { kind: "maximum", count: 33 } }),
  requirement("Write 30–33 story pages", { expectedCount: 32 }),
  requirement("Write 30–33 story pages", { pageCountConstraint: { kind: "maximum", count: 32 } }),
  requirement("Write 33–30 story pages", { pageCountConstraint: { kind: "range", minimum: 33, maximum: 30 } }),
  requirement("33 lanterns on each page", { pageCountConstraint: { kind: "maximum", count: 3 } }),
  requirement("Use 30 or 33 story pages", { expectedCount: 33 })
])("does not invent or weaken an ungrounded quantity: $quote", row => {
  expect(assess(row, 31).status).toBe("unverified");
});

it("keeps different operators separate when grouping and preserves typed bounds through inventory and storage", async () => {
  const quote = "Write 30–33 story pages";
  const rows = [requirement(quote, { pageCountConstraint: { kind: "minimum", count: 30 } }),
    requirement(quote, { pageCountConstraint: { kind: "maximum", count: 33 } })].map((row, i) => ({ ...briefRequirementSchema.parse(row), id: String(i) }));
  expect(groupCoverageRequirements(rows).representatives).toHaveLength(2);
  const { model, calls } = scriptedDevelopmentModel([{ complete: true, requirements: [
    requirement(quote, { scope: { extent: "whole_book", quote }, pageCountConstraint: { kind: "range", minimum: 30, maximum: 33 } })
  ] }]);
  const inventory = await inventoryManuscriptRequirements({ brief: quote, textModel: model, requireScope: true });
  expect(JSON.parse(JSON.stringify(inventory)).requirements[0].pageCountConstraint).toEqual({ kind: "range", minimum: 30, maximum: 33 });
  expect(calls).toHaveLength(1);
  expect(calls[0]!.messages[0]!.content).toContain("Never turn a maximum into an exact count");
});

it("assesses the captured upper bound in a fresh coverage read using export facts", async () => {
  const { model, calls } = scriptedDevelopmentModel([{ complete: true, requirements: [] }]);
  const result = await reviewManuscriptCoverage({ brief: captured.brief, promises: [], pages: [], evidenceContext: context, textModel: model,
    inventory: { version: 1, brief: captured.brief, complete: true, status: "available", requirements: saved().requirements } });
  expect(result.requirements[0]?.status).toBe("fulfilled");
  expect(calls).toHaveLength(1);
  expect(JSON.parse(calls[0]!.messages[1]!.content).requirements).toEqual([]);
});

it.each([false, true])("retains the operator in mixed promise delivery checks after serialization (typed=%s)", async typed => {
  const quote = "At most 33 story pages", promise = `${quote}, with a resolved ending.`;
  const prose = "Rabbit and Turtle reached the picnic together.";
  const row = requirement(quote, typed ? { pageCountConstraint: { kind: "maximum", count: 33 } } : { expectedCount: 33 });
  const { model, calls } = scriptedDevelopmentModel([{ complete: true, requirements: [
    { id: "promise-1", status: "unverified", reason: "Delivery pending", evidence: [], mixedPromiseAssessment: {
      promiseQuote: promise, deliveryRequirements: [{ id: "brief-1", quote }],
      narrative: { status: "fulfilled", reason: "They reach the picnic.", evidence: [{ pageIndex: 30, quote: prose }] }
    } }
  ] }]);
  const review = await reviewManuscriptCoverage({ brief: quote, promises: [promise], pages: [{ index: 30, markdown: prose }],
    textModel: model, evidenceContext: context, inventory: { version: 1, brief: quote, complete: true, status: "available",
      requirements: [briefRequirementSchema.parse(row)] } });
  const restored = manuscriptCoverageSchema.parse(JSON.parse(JSON.stringify(review)));
  const result = refreshManuscriptCoverageFacts(restored, context);
  expect(result.requirements.map(row => row.status)).toEqual(["fulfilled", "fulfilled"]);
  expect(result.requirements[1]?.deliveryChecks?.[0]).toMatchObject({ kind: "page_count", status: "fulfilled",
    pageCountConstraint: { kind: "maximum", count: 33 } });
  expect(refreshManuscriptCoverageFacts(restored, { ...context, storyPageIndexes: indexes(29) }).requirements.map(row => row.status))
    .toEqual(["missing", "missing"]);
  expect(calls).toHaveLength(1);
});
