import { expect, it } from "vitest";
import { FakeTextModelAdapter } from "../adapters/fake.js";
import { createProjectSchema } from "../schemas/book.js";
import { makeFallbackPlan } from "../prompting/templates.js";
import { reviewPictureBookManuscript } from "./pictureBookReview.js";
import captured from "./testing/dialogueWitness0928.json" with { type: "json" };
import { pictureBookRequirementTargets } from "./pictureBookRequirementTargets.js";
import { pictureBookChecklistSpans } from "./pictureBookChecklistSpans.js";
import { pictureBookReviewFingerprint } from "./pictureBookReviewContext.js";
import { reusablePictureBookChecklists } from "./pictureBookChecklistReuse.js";
import { scriptedDevelopmentModel } from "./testing/bookDevelopmentFixtures.js";
import { pictureBookChecklistErrors } from "./pictureBookPreRepairChecklist.js";

const prompt = "Write a woodland story. Each page must include natural dialogue.";
const input = createProjectSchema.parse({ prompt, category: "KIDS", targetPages: 30, language: "en" });
const plan = { ...makeFallbackPlan(input), requirementInventory: { version: 1 as const, complete: true, status: "available" as const,
  brief: prompt, requirements: [{ kind: "content" as const, quote: "natural dialogue", text: "natural dialogue",
    scope: { extent: "each_page" as const, quote: "Each page must include natural dialogue." } }] } };

it("uses valid same-page atomic speech evidence for a compound obligation without another model call", async () => {
  const compound = "Each page must include a distinct scene and natural dialogue.";
  const compoundInput = { ...input, prompt: compound };
  const base = plan.requirementInventory.requirements[0]!;
  const compoundPlan = { ...plan, requirementInventory: { ...plan.requirementInventory, brief: compound,
    requirements: [compound, "natural dialogue"].map(quote => ({ ...base, quote, scope: { ...base.scope, quote: compound } })) } };
  const page = { ...captured[2]!.page, markdown: 'Rabbit followed the lights. “This way!” Rabbit called.' };
  const spans = Object.keys(pictureBookChecklistSpans(page));
  const { model, calls } = scriptedDevelopmentModel([{ findings: [], pages: [{ pageIndex: 29, score: 96,
    requirementChecks: [spans[0], spans[1]] }] }]);
  const result = await reviewPictureBookManuscript({ input: compoundInput, plan: compoundPlan, pages: [page], chapterBriefs: [], textModel: model,
    continuityReview: false, checks: { pageModelReview: true, storyExtractAudit: false, styleAuditor: false } });
  expect(result[0]?.report.approved).toBe(true);
  expect(calls).toHaveLength(1);
  const errors = pictureBookChecklistErrors({ input: compoundInput, plan: compoundPlan, enabled: true }, page.markdown,
    [0, 1].map(requirementIndex => ({ requirementIndex, evidence: "Rabbit followed the lights." })), []);
  expect(errors).toHaveLength(2);
  expect(errors.every(error => error.includes("spoken"))).toBe(true);
});

it.each(captured)("cannot approve narration as dialogue in $case", async ({ page, witness }) => {
  const textModel = new FakeTextModelAdapter();
  textModel.generateJson = async request => {
    const data = request.schema.parse({ findings: [], pages: [{ pageIndex: page.index, score: 96,
      requirementChecks: [{ requirementIndex: 0, evidence: witness }] }] });
    return { data, text: JSON.stringify(data), provider: "fixture", model: "fixture" };
  };
  await expect(reviewPictureBookManuscript({ input, plan, pages: [page], chapterBriefs: [], textModel,
    continuityReview: false, checks: { pageModelReview: true, storyExtractAudit: false, styleAuditor: false } }))
    .rejects.toMatchObject({ name: "PictureBookReviewIncompleteError" });
});

it("turns a false fulfillment into an actionable finding through bounded local recovery", async () => {
  const { page, witness } = captured[2]!;
  const finding = { domain: "prose", basis: "missing_requirement", category: "brief", repairKind: "semantic",
    requirementQuote: "natural dialogue", quote: witness, relatedEvidence: [],
    message: "This page has no spoken dialogue.", guidance: "Add a natural spoken line as they guide the neighbors." };
  const { model, calls } = scriptedDevelopmentModel([
    { findings: [], pages: [{ pageIndex: 29, score: 96, requirementChecks: [Object.keys(pictureBookChecklistSpans(page))[0]] }] },
    { pages: [], auxiliaryCorrections: [{ id: "page:29", requirementChecks: [null], requirementFindings: [finding] }] }
  ]);
  const result = await reviewPictureBookManuscript({ input, plan, pages: [page], chapterBriefs: [], textModel: model,
    continuityReview: false, checks: { pageModelReview: true, storyExtractAudit: false, styleAuditor: false } });
  expect(result[0]).toMatchObject({ report: { approved: false }, findings: [finding] });
  expect(pictureBookRequirementTargets(prompt, [page], result)).toMatchObject([{ pageIndex: 29, requirementQuote: "natural dialogue" }]);
  expect(calls).toHaveLength(2);
  const q = JSON.parse(calls[1]!.messages.find(m => m.role === "user")!.content).auxiliaryRecovery;
  expect(q.pages.map((p: { index: number }) => p.index)).toEqual([29]);
  expect(q.rows[0].witnessConcerns[0]).toContain("spoken words");
});

it("can select actual speech elsewhere on the same page without inventing a missing finding", async () => {
  const page = { ...captured[2]!.page, markdown: 'Rabbit followed the lights. “This way!” Rabbit called.' };
  const spans = Object.keys(pictureBookChecklistSpans(page));
  const { model, calls } = scriptedDevelopmentModel([
    { findings: [], pages: [{ pageIndex: 29, score: 96, requirementChecks: [spans[0]] }] },
    { pages: [], auxiliaryCorrections: [{ id: "page:29", requirementChecks: [spans[1]] }] }
  ]);
  const result = await reviewPictureBookManuscript({ input, plan, pages: [page], chapterBriefs: [], textModel: model,
    continuityReview: false, checks: { pageModelReview: true, storyExtractAudit: false, styleAuditor: false } });
  expect(result[0]?.report.approved).toBe(true);
  expect(calls).toHaveLength(2);
});

it("does not approve lost dialogue merely because a changed page's repair assessment says no regressions", async () => {
  const { page, witness } = captured[0]!;
  const { model } = scriptedDevelopmentModel([
    { findings: [], pages: [{ pageIndex: page.index, score: 98,
      requirementChecks: [{ requirementIndex: 0, evidence: witness }],
      repairAssessment: { targetResolved: true, meaningPreserved: true, noNewRegressions: true, reason: "The scene is improved." } }] },
    { pages: [], auxiliaryCorrections: [{ id: `page:${page.index}`, requirementChecks: [{ requirementIndex: 0, evidence: witness }] }] }
  ]);
  await expect(reviewPictureBookManuscript({ input, plan, pages: [page], chapterBriefs: [], textModel: model,
    continuityReview: false, checks: { pageModelReview: true, storyExtractAudit: false, styleAuditor: false },
    repairContext: { issues: [{ pageIndexes: [page.index], messages: ["Improve the scene's pacing."] }],
      changes: [{ pageIndex: page.index, originalMarkdown: '“Two lights now,” Rabbit said. ' + page.markdown, reason: "Improve pacing." }] }
  })).rejects.toMatchObject({ checkpoint: { unresolvedPageIndexes: [22] } });
});

it("does not reuse an old clean checklist whose dialogue witness is narration", async () => {
  const speaking = { ...captured[0]!.page, markdown: '“Two lights now,” Rabbit said.' };
  const { model } = scriptedDevelopmentModel([{ findings: [], pages: [{ pageIndex: 22, score: 96,
    requirementChecks: [Object.keys(pictureBookChecklistSpans(speaking))[0]] }] }]);
  const options = { input, plan, pages: [speaking], chapterBriefs: [], textModel: model,
    continuityReview: false, checks: { pageModelReview: true, storyExtractAudit: false, styleAuditor: false } };
  const reviews = await reviewPictureBookManuscript(options);
  const { page, witness } = captured[0]!;
  const stale = { ...options, pages: [page], previousReview: { pages: [page],
    fingerprint: pictureBookReviewFingerprint({ ...options, pages: [page] }),
    reviews: reviews.map(review => ({ ...review, draftMarkdown: page.markdown,
      requirementChecks: [{ requirementIndex: 0, evidence: witness }] })) } };
  expect(reusablePictureBookChecklists(stale).size).toBe(0);
});
