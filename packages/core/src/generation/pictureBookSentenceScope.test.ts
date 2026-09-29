import { expect, it } from "vitest";
import { createProjectSchema } from "../schemas/book.js";
import { makeFallbackPlan } from "../prompting/templates.js";
import { pictureBookPageReview, pictureBookReviewRowSchema, validatedPictureBookReviewRow } from "./pictureBookReviewValidation.js";
import { pictureBookReviewMessages } from "./pictureBookReviewPrompt.js";
import { pictureBookRepairPageScopes } from "./pictureBookRepairScope.js";
import { repairPictureBookManuscript } from "./pictureBookRepair.js";
import { reviewPictureBookManuscript } from "./pictureBookReview.js";
import { pictureBookReviewContract } from "./pictureBookReviewContract.js";
import { scriptedDevelopmentModel } from "./testing/bookDevelopmentFixtures.js";
import captured from "./testing/sentenceScope0000.json" with { type: "json" };

const input = createProjectSchema.parse(captured.input), plan = makeFallbackPlan(input);
const checks = { pageModelReview: true, storyExtractAudit: false, styleAuditor: false };
function options() {
  const originalReviews = captured.pages.map(page => pictureBookPageReview(pictureBookReviewRowSchema.parse({
    pageIndex: page.index, score: 80, findings: captured.findings.filter(f => f.pageIndex === page.index)
      .map(({ pageIndex: _index, ...finding }) => finding), storyExtract: null, styleAudit: null
  }), page, checks, input.prompt));
  return { input, plan, pages: captured.pages, issues: captured.issues, sceneRepairTargets: captured.sceneRepairTargets, originalReviews };
}

it("keeps the captured paraphrased length findings on pages 1 and 26 sentence-only", () => {
  expect(pictureBookRepairPageScopes(options())).toEqual([
    { pageIndex: 1, sentenceOnly: true }, ...[7, 8, 9].map(pageIndex => ({ pageIndex, sentenceOnly: false })),
    { pageIndex: 26, sentenceOnly: true }
  ]);
});

it("carries the original sentence restrictions into mixed repair prompts and candidate context", async () => {
  const { model, calls } = scriptedDevelopmentModel([captured.patch]);
  const candidate = await repairPictureBookManuscript({ ...options(), textModel: model });
  expect(candidate.context.sentenceOnlyPageIndexes).toEqual([1, 26]);
  const payload = JSON.parse(calls[0]!.messages.at(-1)!.content);
  expect(payload.sentenceRepairs.map((p: { pageIndex: number }) => p.pageIndex)).toEqual([1, 26]);
  expect(payload.semanticTargetPageIndexes).toEqual([7, 8, 9]);
});

it("rejects rewriting a short protected sentence despite the paraphrased length diagnosis", async () => {
  const { model } = scriptedDevelopmentModel([{ pages: [{ pageIndex: 1, summary: null, reason: "A new opening",
    patches: [{ find: "Now the woodland path went dark.", replace: "Rabbit ran to the gate with a spare lantern." }] }] }]);
  await expect(repairPictureBookManuscript({ ...options(), textModel: model })).rejects.toThrow(/sentence-only.*page 1/i);
});

it("keeps a genuine additional story defect semantic on the same page", () => {
  const test = options();
  test.issues = [...test.issues, { pageIndexes: [1], messages: ["Move the neighbors from their destination to the woodland entrance."] }];
  expect(pictureBookRepairPageScopes(test).find(scope => scope.pageIndex === 1)?.sentenceOnly).toBe(false);
});

function typedOptions() {
  const test = options(), page = test.pages[0]!;
  const finding = { ...test.originalReviews[0]!.findings![0]!, repairKind: "sentence_length",
    message: "The measured reading limit needs a sentence split here.", guidance: "Split that sentence and retain every event." };
  const row = validatedPictureBookReviewRow({ input, checks, pages: new Map(test.pages.map(p => [p.index, p])) })
    .parse({ pageIndex: 1, score: 78, findings: [finding], storyExtract: null, styleAudit: null });
  const review = pictureBookPageReview(row, page, checks, input.prompt);
  return { ...test, originalReviews: [review], sceneRepairTargets: [],
    issues: [{ pageIndexes: [1], messages: [...review.report.issues, ...review.report.requiredRevisions] }] };
}

it("uses structured scope for new wording and keeps a sentence-only correction sentence-only", async () => {
  const test = typedOptions();
  expect(pictureBookRepairPageScopes(test)).toEqual([{ pageIndex: 1, sentenceOnly: true }]);
  const { model, calls } = scriptedDevelopmentModel([{ pages: [captured.patch.pages[0]] }]);
  const candidate = await repairPictureBookManuscript({ ...test, textModel: model, feedback: { phase: "semantic",
    candidatePages: [], failures: [{ pageIndex: 1, issues: ["Rewrite this scene instead."] }] } });
  expect(candidate.context.sentenceOnly).toBe(true);
  expect(candidate.context.sentenceOnlyPageIndexes).toEqual([1]);
  expect(JSON.parse(calls[0]!.messages.at(-1)!.content).semanticTargetPageIndexes).toEqual([]);
});

it("does not let semantic correction feedback add pages to a sentence-only repair", async () => {
  const test = typedOptions(), page = test.pages[1]!;
  const { model } = scriptedDevelopmentModel([{ pages: [{ pageIndex: 2, summary: null, reason: "Follow reviewer advice",
    patches: [{ find: page.markdown, replace: "Rabbit went back to the gate." }] }] }]);
  await expect(repairPictureBookManuscript({ ...test, textModel: model, feedback: { phase: "semantic",
    candidatePages: [], failures: [{ pageIndex: 2, issues: ["Rewrite this additional page."] }] }
  })).rejects.toThrow("Sentence-only repair cannot change additional pages or metadata.");
});

it.each([false, true])("matches exact typed diagnoses with a model page label and outer label=%s", outer => {
  const test = typedOptions(), review = test.originalReviews[0]!;
  review.findings![0]!.message = `Page 1: ${review.findings![0]!.message}`;
  test.issues[0]!.messages[0] = `Page 1: ${test.issues[0]!.messages[0]}`;
  if (outer) test.issues[0]!.messages = test.issues[0]!.messages.map(message => `Page 1: ${message}`);
  expect(pictureBookRepairPageScopes(test)).toEqual([{ pageIndex: 1, sentenceOnly: true }]);
});

it.each(["stale", "unverified", "wrong_quote", "semantic_kind", "mixed_legacy_guidance", "mixed_legacy_message"] as const)
("does not infer sentence scope from %s review evidence", mode => {
  const test = mode === "semantic_kind" ? typedOptions() : options();
  const review = test.originalReviews[0]!, finding = review.findings![0]!;
  if (mode === "stale") review.draftMarkdown += " Changed.";
  if (mode === "unverified") { review.unverifiedFindings = review.findings; review.findings = []; }
  if (mode === "wrong_quote") finding.quote = "A sentence absent from the manuscript.";
  if (mode === "semantic_kind") finding.repairKind = "semantic";
  if (mode === "mixed_legacy_guidance") finding.guidance += " Move the neighbors to the gate.";
  if (mode === "mixed_legacy_message") finding.message += " It also puts the neighbors at the wrong destination.";
  expect(pictureBookRepairPageScopes(test).find(scope => scope.pageIndex === 1)?.sentenceOnly).toBe(false);
});

it("lets an explicit story requirement or a grounded scene interval own the affected page", () => {
  const test = typedOptions();
  expect(pictureBookRepairPageScopes({ ...test, requirementTargets: [{ pageIndex: 1 }] }))
    .toEqual([{ pageIndex: 1, sentenceOnly: false }]);
  expect(pictureBookRepairPageScopes({ ...test,
    issues: [...test.issues, { pageIndexes: [2], messages: ["Pages 1–2 contradict each other."] }],
    sceneRepairTargets: [{ pageIndex: 2, pageIndexes: [1, 2] }]
  })).toEqual([{ pageIndex: 1, sentenceOnly: false }, { pageIndex: 2, sentenceOnly: false }]);
});

it.each(["no_violation", "cross_page", "wrong_quote", "short_sentence"] as const)
("rejects a sentence_length tag with %s before it becomes reusable", mode => {
  const test = typedOptions(), finding = { ...test.originalReviews[0]!.findings![0]! };
  const page = { ...test.pages[0]! };
  if (mode === "no_violation") { page.markdown = "Rabbit found a lantern. Turtle waited nearby."; finding.quote = "Rabbit found a lantern."; }
  if (mode === "cross_page") finding.basis = "cross_page";
  if (mode === "wrong_quote") finding.quote = "This evidence does not occur in the page.";
  if (mode === "short_sentence") finding.quote = "Now the woodland path went dark.";
  const parsed = validatedPictureBookReviewRow({ input, checks, pages: new Map([[1, page]]) })
    .safeParse({ pageIndex: 1, score: 78, findings: [finding], storyExtract: null, styleAudit: null });
  expect(parsed.success).toBe(false);
});

it("asks the model to distinguish measured syntax repairs from other language defects", () => {
  const { model } = scriptedDevelopmentModel([]);
  const messages = pictureBookReviewMessages({ ...options(), textModel: model, chapterBriefs: [], continuityReview: false, checks }, [1], []);
  expect(messages[0]!.content).toContain("repairKind=sentence_length");
  expect(messages[0]!.content).toContain("repairKind=semantic");
  const finding = { ...typedOptions().originalReviews[0]!.findings![0]!, pageIndex: 1 };
  const response = { findings: [finding], pages: [{ pageIndex: 1, score: 78 }] };
  expect(pictureBookReviewContract(checks, false).safeParse(response).success).toBe(true);
  const { repairKind: _kind, ...legacy } = finding;
  expect(pictureBookReviewContract(checks, false).safeParse({ ...response, findings: [legacy] }).success).toBe(false);
});

it("preserves typed scope through narrow citation recovery without reopening the finding", async () => {
  const test = typedOptions(), finding = test.originalReviews[0]!.findings![0]!;
  const { model, calls } = scriptedDevelopmentModel([
    { findings: [{ ...finding, pageIndex: 1, quote: "An inexact quotation of the long lantern sentence." }], pages: [{ pageIndex: 1, score: 78 }] },
    { pages: [], corrections: [{ id: "1:0:page", supportsSameClaim: true, quote: finding.quote }] }
  ]);
  const originalReviews = await reviewPictureBookManuscript({ ...test, pages: [test.pages[0]!], textModel: model, chapterBriefs: [], continuityReview: false, checks });
  expect(originalReviews[0]!.findings![0]).toEqual(finding);
  expect(originalReviews[0]!.report.approved).toBe(false);
  expect(JSON.parse(calls[1]!.messages.find(m => m.role === "user")!.content).phase).toBe("picture_book_citation_recovery");
  expect(pictureBookRepairPageScopes({ ...test, originalReviews })).toEqual([{ pageIndex: 1, sentenceOnly: true }]);
});
