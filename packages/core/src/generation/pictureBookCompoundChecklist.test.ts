import { expect, it } from "vitest";
import { createProjectSchema } from "../schemas/book.js";
import { manuscriptRequirementInventorySchema } from "../schemas/manuscriptRequirements.js";
import { makeFallbackPlan } from "../prompting/templates.js";
import { reviewPictureBookManuscript } from "./pictureBookReview.js";
import { pictureBookRequirementTargets } from "./pictureBookRequirementTargets.js";
import { pictureBookChecklistErrors, pictureBookPageRequirements } from "./pictureBookPreRepairChecklist.js";
import { pictureBookFindingSchema } from "./pictureBookReviewValidation.js";
import { scriptedDevelopmentModel } from "./testing/bookDevelopmentFixtures.js";
import captured from "./testing/compoundChecklist0928.json" with { type: "json" };

const input = createProjectSchema.parse({ prompt: captured.brief, category: "KIDS", targetPages: 30, language: "en" });
const plan = { ...makeFallbackPlan(input), requirementInventory: manuscriptRequirementInventorySchema.parse(captured.inventory) };

it("keeps the two captured dialogue failures actionable without duplicating them for the compound checklist", async () => {
  const { model, calls } = scriptedDevelopmentModel([{ findings: captured.findings,
    pages: captured.rows.map(({ requirementAssessments: _, storyExtract: _s, styleAudit: _a, ...row }) => row) }]);
  const reviews = await reviewPictureBookManuscript({ input, plan, pages: captured.pages, chapterBriefs: [], textModel: model,
    continuityReview: false, checks: { pageModelReview: true, storyExtractAudit: false, styleAuditor: false } });
  expect(calls).toHaveLength(1);
  expect(reviews.map(row => row.report.approved)).toEqual([false, false]);
  expect(reviews.map(row => row.findings?.length)).toEqual([1, 1]);
  expect(pictureBookRequirementTargets(input.prompt, captured.pages, reviews).map(t => [t.pageIndex, t.requirementQuote]))
    .toEqual([[2, "natural dialogue"], [8, "natural dialogue"]]);
  const payload = JSON.parse(calls[0]!.messages.find(m => m.role === "user")!.content);
  expect(payload.pageRequirements[0].failedByRequirementIndexes).toEqual([1,2,3,4]);
});

const compound = "Each page must include natural dialogue and concrete sensory details.";
function checklistCase(parent = compound, otherScope?: string) {
  const prompt = parent + (otherScope ? ` ${otherScope}` : "");
  const reqs = [parent, "natural dialogue", "concrete sensory details"].map(quote => ({ kind: "content" as const, quote, text: quote,
    scope: { extent: "each_page" as const, quote: quote === "natural dialogue" && otherScope ? otherScope : parent } }));
  const scopedInput = { ...input, prompt }, scopedPlan = { ...plan, requirementInventory: { ...plan.requirementInventory, brief: prompt, requirements: reqs } };
  const markdown = captured.pages[0]!.markdown;
  const { pageIndex: _page, ...capturedFinding } = captured.findings[0]!;
  const finding = pictureBookFindingSchema.parse(capturedFinding);
  const checks = [null, null, "Rain rattled the leaves."].map((evidence, requirementIndex) => ({ requirementIndex, evidence }));
  const errors = (values = checks, findings = [finding]) => pictureBookChecklistErrors({ input: scopedInput, plan: scopedPlan, enabled: true }, markdown, values, findings);
  return { errors, checks, finding, requirements: pictureBookPageRequirements(scopedInput, scopedPlan) };
}

it("propagates a conjunct's failure upward without approving the compound or other children", () => {
  const test = checklistCase();
  expect(test.errors()).toEqual([]);
  expect(test.errors(test.checks.map(c => c.requirementIndex === 0 ? { ...c, evidence: "Rain rattled the leaves." } : c)))
    .toEqual([expect.stringContaining("consistent finding verdict")]);
  expect(test.errors(test.checks.map(c => ({ ...c, evidence: null }))))
    .toEqual([expect.stringContaining("Missing requirement 2")]);
  expect(test.errors(test.checks, [{ ...test.finding, requirementQuote: compound }]))
    .toEqual([expect.stringContaining("Missing requirement 1")]);
});

it.each([
  "Each page must include natural dialogue or concrete sensory details.",
  "Each page must include natural dialogue and concrete sensory details only if Rabbit speaks.",
  "Each page must include no natural dialogue and concrete sensory details.",
  "Each page must discuss natural dialogue and concrete sensory details.",
  "Each page must include an explanation of natural dialogue and concrete sensory details."
])("does not infer an entailment from alternatives, conditions, negation or mere mention: %s", parent => {
  const test = checklistCase(parent);
  expect(test.errors()).toContainEqual(expect.stringContaining("Missing requirement 0"));
});

it("does not connect identical fragments from a different governing clause", () => {
  const test = checklistCase(compound, "Each page must discuss natural dialogue.");
  expect(test.errors()).toContainEqual(expect.stringContaining("Missing requirement 0"));
});

it("retains citation validation for a child finding that explains its parent", async () => {
  const findings = captured.findings.map(f => ({ ...f, quote: "An invented sentence with no source witness." }));
  const { model } = scriptedDevelopmentModel([{ findings, pages: captured.rows.map(row => ({ pageIndex: row.pageIndex,
    score: row.score, requirementChecks: row.requirementChecks })) }, { corrections: [] }]);
  await expect(reviewPictureBookManuscript({ input, plan, pages: captured.pages, chapterBriefs: [], textModel: model,
    continuityReview: false, checks: { pageModelReview: true, storyExtractAudit: false, styleAuditor: false } })).rejects.toThrow();
});

it("completes auxiliary recovery with one atomic finding rather than duplicating the diagnosis", async () => {
  const rows = captured.rows.map(row => ({ pageIndex: row.pageIndex, score: row.score }));
  const { model, calls } = scriptedDevelopmentModel([{ findings: captured.findings, pages: rows },
    { pages: [], auxiliaryCorrections: captured.rows.map(row => ({ id: `page:${row.pageIndex}`, requirementChecks: row.requirementChecks, requirementFindings: [] })) }]);
  const reviews = await reviewPictureBookManuscript({ input, plan, pages: captured.pages, chapterBriefs: [], textModel: model,
    continuityReview: false, checks: { pageModelReview: true, storyExtractAudit: false, styleAuditor: false } });
  expect(calls).toHaveLength(2);
  expect(reviews.every(r => !r.report.approved && r.findings?.length === 1)).toBe(true);
  const payload = JSON.parse(calls[1]!.messages.find(m => m.role === "user")!.content);
  expect(payload.auxiliaryRecovery.pageRequirements[0].failedByRequirementIndexes).toEqual([1,2,3,4]);
});
