import { expect, it } from "vitest";
import { createProjectSchema } from "../schemas/book.js";
import { makeFallbackPlan } from "../prompting/templates.js";
import { scriptedDevelopmentModel } from "./testing/bookDevelopmentFixtures.js";
import { reviewPictureBookManuscript, type PictureBookReviewOptions } from "./pictureBookReview.js";
import { pictureBookReviewFingerprint } from "./pictureBookReviewContext.js";
import { pictureBookChecklistSpans } from "./pictureBookChecklistSpans.js";
import { reusablePictureBookChecklists } from "./pictureBookChecklistReuse.js";
import { pictureBookSceneRepairTargets } from "./pictureBookSceneRepairTargets.js";
import quick from "./testing/quickContinuityInterval0928.json" with { type: "json" };

const input = createProjectSchema.parse({ category: "KIDS", targetPages: 8, language: "en",
  prompt: "Write a woodland story. Each page must include natural dialogue." });
const plan = { ...makeFallbackPlan(input), requirementInventory: { version: 1 as const, complete: true, status: "available" as const,
  brief: input.prompt, requirements: [{ kind: "content" as const, quote: "natural dialogue", text: "natural dialogue",
    scope: { extent: "each_page" as const, quote: "Each page must include natural dialogue." } }] } };
const pages = [
  '“Leave the fern lantern here,” Turtle said. Rabbit hung the fern lantern on the fork post.',
  '“Look up,” Rabbit said. The fork post stood empty beside the path.',
  '“Wait here,” Turtle said. The fork post was still empty.',
  '“Here it is,” Rabbit said. He lifted the fern lantern from the fork post.'
].map((markdown, offset) => ({ index: offset + 1, title: `Scene ${offset + 1}`, markdown, summary: "" }));
const checks = { pageModelReview: true, storyExtractAudit: false, styleAuditor: false };
const common = { input, plan, pages, chapterBriefs: [], checks };
const clean = () => ({ findings: [], pages: pages.map(page => ({ pageIndex: page.index, score: 96,
  requirementChecks: [Object.keys(pictureBookChecklistSpans(page))[0]] })) });
const conflict = { pageIndex: 2, domain: "prose", basis: "cross_page", requirementQuote: null, category: "continuity", repairKind: "semantic",
  quote: "The fork post stood empty beside the path.", message: "The post is called empty while the fern lantern is still there.",
  guidance: "Describe the lantern still hanging here; keep the later removal.",
  relatedEvidence: [{ pageIndex: 1, quote: "Rabbit hung the fern lantern on the fork post." },
    { pageIndex: 4, quote: "He lifted the fern lantern from the fork post." }] };

it("collects continuity defects before repair even when the grouped reviewer found a different defect", async () => {
  const style = { ...conflict, pageIndex: 4, basis: "page_prose", category: "style", relatedEvidence: [],
    quote: pages[3]!.markdown, message: "The final action is awkwardly worded.", guidance: "Smooth the final action." };
  const { model, calls } = scriptedDevelopmentModel([{ ...clean(), findings: [style] }, { findings: [conflict] }]);
  const reviews = await reviewPictureBookManuscript({ ...common, textModel: model });
  expect(reviews.filter(review => !review.report.approved).map(review => review.pageIndex)).toEqual([2, 4]);
  expect(calls.map(call => call.purpose)).toEqual(["review-page", "review-picture-book-continuity"]);
});

it("makes every repeated contradiction in a state interval actionable in the same read", async () => {
  const { model, calls } = scriptedDevelopmentModel([clean(), { findings: [{ ...conflict,
    relatedOccurrences: [{ pageIndex: 3, quote: "The fork post was still empty." }] }] }]);
  const reviews = await reviewPictureBookManuscript({ ...common, textModel: model });
  expect(reviews.filter(review => !review.report.approved).map(review => review.pageIndex)).toEqual([2, 3]);
  expect(reviews[2]!.findings).toMatchObject([{ quote: "The fork post was still empty.", relatedEvidence: conflict.relatedEvidence }]);
  expect(calls).toHaveLength(2);
});

it("reuses verified checklist witnesses on unchanged pages without reusing the story verdict", async () => {
  const initial = scriptedDevelopmentModel([clean(), { findings: [] }]);
  const reviews = await reviewPictureBookManuscript({ ...common, textModel: initial.model });
  const candidatePages = pages.map(page => page.index === 4 ? { ...page, markdown: page.markdown + " He smiled." } : page);
  const candidate = clean();
  const rows = candidate.pages.map(row => row.pageIndex === 4 ? { ...row,
    requirementChecks: [Object.keys(pictureBookChecklistSpans(candidatePages[3]!))[0]],
    repairAssessment: { targetResolved: true, meaningPreserved: true, noNewRegressions: true, reason: "The ending reads smoothly." }
  } : { ...row, requirementChecks: "reuse" });
  const { model, calls } = scriptedDevelopmentModel([{ pages: rows, findings: [] }, { findings: [conflict] }]);
  const previousReview = { pages, reviews, fingerprint: pictureBookReviewFingerprint(common) };
  const result = await reviewPictureBookManuscript({ ...common, pages: candidatePages, textModel: model, previousReview,
    repairContext: { issues: [{ pageIndexes: [4], messages: ["Smooth the ending."] }],
      changes: [{ pageIndex: 4, originalMarkdown: pages[3]!.markdown, reason: "Smooth the ending." }] } });
  expect(result[0]!.requirementChecks).toEqual(reviews[0]!.requirementChecks);
  expect(result[1]!.report.approved).toBe(false);
  const payload = JSON.parse(calls[0]!.messages.find(message => message.role === "user")!.content);
  expect(payload.reusableRequirementCheckPageIndexes).toEqual([1, 2, 3]);
  expect(calls).toHaveLength(2);
});

const invalidPriorCases: [string, (options: PictureBookReviewOptions) => void][] = [
  ["missing fingerprint", options => { delete options.previousReview!.fingerprint; }],
  ["changed brief", options => { options.input = { ...input, prompt: input.prompt + " Use two speakers." }; }],
  ["changed plan", options => { options.plan = { ...plan, premise: "A different premise." }; }],
  ["changed enabled checks", options => { options.checks = { ...checks, styleAuditor: true }; }],
  ["changed page", options => { options.pages = options.pages.map(page => ({ ...page, markdown: page.markdown + "!" })); }],
  ["changed title", options => { options.pages = options.pages.map(page => ({ ...page, title: "Changed" })); }],
  ["stale verdict", options => { options.previousReview!.reviews[0]!.draftMarkdown += "!"; }],
  ["unapproved verdict", options => { options.previousReview!.reviews[0]!.report.approved = false; }],
  ["unknown findings", options => { delete options.previousReview!.reviews[0]!.findings; }],
  ["omitted checklist", options => { delete options.previousReview!.reviews[0]!.requirementChecks; }],
  ["invented witness", options => { options.previousReview!.reviews[0]!.requirementChecks![0]!.evidence = "An invented quotation."; }],
  ["null witness", options => { options.previousReview!.reviews[0]!.requirementChecks![0]!.evidence = null; }],
  ["duplicate verdict", options => { options.previousReview = { ...options.previousReview!,
    reviews: [...options.previousReview!.reviews, options.previousReview!.reviews[0]!] }; }],
  ["duplicate source page", options => { options.previousReview = { ...options.previousReview!, pages: [...pages, pages[0]!] }; }]
];
it.each(invalidPriorCases)("does not offer witness reuse with %s", async (_name, invalidate) => {
  const initial = scriptedDevelopmentModel([clean()]);
  const base = { ...common, textModel: initial.model, continuityReview: false };
  const reviews = await reviewPictureBookManuscript(base);
  const options: PictureBookReviewOptions = { ...base, previousReview: { pages, reviews, fingerprint: pictureBookReviewFingerprint(base) } };
  expect(reusablePictureBookChecklists(options).has(1)).toBe(true);
  invalidate(options);
  expect(reusablePictureBookChecklists(options).has(1)).toBe(false);
});

it("rejects an unoffered reuse marker instead of silently approving an unchanged page", async () => {
  const answer = { ...clean(), pages: clean().pages.map(row => ({ ...row, requirementChecks: "reuse" })) };
  const { model, calls } = scriptedDevelopmentModel([answer, { pages: [] }]);
  await expect(reviewPictureBookManuscript({ ...common, textModel: model, continuityReview: false }))
    .rejects.toMatchObject({ name: "PictureBookReviewIncompleteError" });
  expect(calls).toHaveLength(2);
});

it("cannot use old witnesses to erase a fresh requirement finding", async () => {
  const initial = scriptedDevelopmentModel([clean()]);
  const base = { ...common, textModel: initial.model, continuityReview: false };
  const reviews = await reviewPictureBookManuscript(base);
  const finding = { ...conflict, pageIndex: 1, category: "brief", basis: "missing_requirement", relatedEvidence: [],
    requirementQuote: "natural dialogue", quote: pages[0]!.markdown,
    message: "The dialogue sounds unnatural in this scene.", guidance: "Make the dialogue natural in context." };
  const { model } = scriptedDevelopmentModel([{ pages: clean().pages.map(row => ({ ...row, requirementChecks: "reuse" })), findings: [finding] }, { pages: [] }]);
  await expect(reviewPictureBookManuscript({ ...base, textModel: model,
    previousReview: { pages, reviews, fingerprint: pictureBookReviewFingerprint(base) } }))
    .rejects.toMatchObject({ name: "PictureBookReviewIncompleteError", checkpoint: { unresolvedPageIndexes: [1] } });
});

it.each(["duplicate", "owner", "unknown", "quote", "scene_scope"])("fails closed on a %s continuity occurrence", async mode => {
  const occurrence = { pageIndex: mode === "owner" ? 2 : mode === "unknown" ? 99 : 3,
    quote: mode === "quote" ? "Invented prose from no page." : "The fork post was still empty." };
  const finding = { ...conflict, relatedOccurrences: mode === "duplicate" ? [occurrence, occurrence] : [occurrence],
    ...(mode === "scene_scope" ? { repairPageIndexes: [2, 3] } : {}) };
  const { model } = scriptedDevelopmentModel([clean(), { findings: [finding] }, { pages: [] }]);
  await expect(reviewPictureBookManuscript({ ...common, textModel: model }))
    .rejects.toMatchObject({ name: "PictureBookReviewIncompleteError" });
});

it("retains both empty-post assertions from the captured 30-page Quick manuscript", async () => {
  const fixtureInput = createProjectSchema.parse({ category: "KIDS", targetPages: 30, language: "en", prompt: quick.brief });
  const { model, calls } = scriptedDevelopmentModel([
    { pages: quick.pages.map(page => ({ pageIndex: page.index, score: 96 })), findings: [] }, { findings: [quick.finding] }
  ]);
  const manuscript = quick.pages.map(page => ({ ...page, summary: "" }));
  const reviews = await reviewPictureBookManuscript({ input: fixtureInput, plan: makeFallbackPlan(fixtureInput),
    pages: manuscript, checks, chapterBriefs: [], textModel: model });
  expect(reviews.filter(review => !review.report.approved).map(review => review.pageIndex)).toEqual([11, 19]);
  // Two independent local corrections must not turn into an 11–19 scene rewrite.
  expect(pictureBookSceneRepairTargets(manuscript, reviews)).toEqual([]);
  expect(calls).toHaveLength(2);
});
