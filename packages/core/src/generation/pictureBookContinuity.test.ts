import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { createProjectSchema } from "../schemas/book.js";
import { makeFallbackPlan } from "../prompting/templates.js";
import { scriptedDevelopmentModel } from "./testing/bookDevelopmentFixtures.js";
import { reviewPictureBookManuscript, type PictureBookReviewCheckpoint } from "./pictureBookReview.js";
import { reviewPictureBookContinuity } from "./pictureBookContinuity.js";
import { pictureBookReviewFingerprint } from "./pictureBookReviewContext.js";

// Actual 30-page manuscripts and captured Sol/high continuity findings. Live
// detection is evaluated separately; these tests lock down their acceptance path.
const corpus: { tier: string; brief: string; pages: { index: number; title: string; markdown: string }[];
  findings: Record<string, unknown>[] }[] = JSON.parse(readFileSync(new URL("./testing/pictureBookContinuityRegression.json", import.meta.url), "utf8"));
function setup(index: number, continuity: unknown = { findings: corpus[index]!.findings }) {
  const fixture = corpus[index]!;
  const input = createProjectSchema.parse({ category: "KIDS", targetPages: 30, prompt: fixture.brief, language: "en" });
  const primary = { findings: [], pages: fixture.pages.map(page => ({ pageIndex: page.index, score: 96 })) };
  const scripted = scriptedDevelopmentModel([primary, continuity]);
  const options = { input, plan: makeFallbackPlan(input), pages: fixture.pages.map(page => ({ ...page, summary: "" })), chapterBriefs: [], textModel: scripted.model,
    checks: { pageModelReview: true, storyExtractAudit: false, styleAuditor: false } };
  return { ...scripted, fixture, primary, options };
}

it.each([[0, [9, 20]], [1, [12]], [2, [21]]] as const)(
  "retains the %s manuscript's missed continuity findings after a clean grouped verdict", async (index, rejected) => {
    const { options, calls, fixture } = setup(index);
    const reviews = await reviewPictureBookManuscript(options);
    expect(reviews.filter(review => !review.report.approved).map(review => review.pageIndex)).toEqual(rejected);
    expect(calls.map(call => call.purpose)).toEqual(["review-page", "review-picture-book-continuity"]);
    expect(JSON.parse(calls[1]!.messages.find(message => message.role === "user")!.content).pages).toEqual(fixture.pages);
    expect(reviews.flatMap(review => review.findings ?? []).map(finding => finding.message)).toEqual(fixture.findings.map(finding => finding.message));
  }
);

it("checks untouched pages of a repair and shares its physical attempt allowance", async () => {
  const { options, model, primary, fixture, calls } = setup(1);
  const page = primary.pages[6]!;
  Object.assign(page, { repairAssessment: { targetResolved: true, meaningPreserved: true, noNewRegressions: true, reason: "The page 7 moon reference was corrected." } });
  let saved!: PictureBookReviewCheckpoint;
  const budget = { limit: 5, used: 0, outputWidened: false };
  const result = await reviewPictureBookManuscript({ ...options, textModel: model, textAttemptBudget: budget,
    repairContext: { issues: [{ pageIndexes: [7], messages: ["An early moon reference contradicts arrival before moonrise."] }],
      changes: [{ pageIndex: 7, originalMarkdown: "The moon was climbing as the neighbors waited.", reason: "Restore the before-moonrise chronology." }] },
    onCheckpoint: async checkpoint => { saved = structuredClone(checkpoint); } });
  expect(result.find(review => review.pageIndex === 12)).toMatchObject({ report: { approved: false } });
  expect(calls).toHaveLength(2);
  expect(saved.attemptsUsed).toBe(2);
  expect(budget.used).toBe(2);
  expect(JSON.parse(calls[1]!.messages.find(message => message.role === "user")!.content).pages).toContainEqual(fixture.pages[11]);
});

it("cannot turn an unavailable continuity check into approval or buy a new allowance on resume", async () => {
  const { options, calls } = setup(1, new Error("Continuity provider unavailable"));
  let saved!: PictureBookReviewCheckpoint;
  await expect(reviewPictureBookManuscript({ ...options,
    onCheckpoint: async checkpoint => { saved = structuredClone(checkpoint); } })).rejects.toMatchObject({ name: "PictureBookReviewIncompleteError" });
  expect(saved.protocolIssues.join(" ")).toContain("continuity");
  expect(saved.attemptsUsed).toBe(2);
  await expect(reviewPictureBookManuscript({ ...options, resume: saved })).rejects.toMatchObject({ name: "PictureBookReviewIncompleteError" });
  expect(calls).toHaveLength(2);
});

it("keeps explicit clean continuity results compact and reuses the complete checkpoint", async () => {
  const { options, calls } = setup(1, { findings: [] });
  let saved!: PictureBookReviewCheckpoint;
  const result = await reviewPictureBookManuscript({ ...options,
    onCheckpoint: async checkpoint => { saved = structuredClone(checkpoint); } });
  expect(result.every(review => review.report.approved)).toBe(true);
  expect(calls).toHaveLength(2);
  expect(await reviewPictureBookManuscript({ ...options, resume: saved })).toEqual(result);
  expect(calls).toHaveLength(2);
});

it("never dispatches or increments an exhausted allowance", async () => {
  const { options, calls } = setup(1);
  const budget = { limit: 5, used: 5, outputWidened: false };
  await expect(reviewPictureBookContinuity(options, budget)).rejects.toThrow("exhausted");
  expect(budget.used).toBe(5);
  expect(calls).toHaveLength(0);
});

it("stops between the grouped verdict and continuity when cancelled", async () => {
  const { options, calls } = setup(1);
  const controller = new AbortController();
  const generate = options.textModel.generateJson.bind(options.textModel);
  options.textModel.generateJson = async request => {
    const result = await generate(request); controller.abort(); return result;
  };
  await expect(reviewPictureBookManuscript({ ...options, signal: controller.signal })).rejects.toMatchObject({ name: "AbortError" });
  expect(calls).toHaveLength(1);
});

it("collects the independent initial findings even when grounded prose findings already require repair", async () => {
  const { options, primary, fixture, calls } = setup(1);
  Object.assign(primary, { findings: fixture.findings });
  const result = await reviewPictureBookManuscript(options);
  expect(result.find(review => review.pageIndex === 12)!.report.approved).toBe(false);
  expect(calls).toHaveLength(2);
});

it("skips independent rechecking of a candidate already rejected for an unresolved new defect", async () => {
  const { options, primary, fixture, calls } = setup(1);
  Object.assign(primary, { findings: fixture.findings });
  const result = await reviewPictureBookManuscript({ ...options, repairContext: { issues: [], changes: [] } });
  expect(result.find(review => review.pageIndex === 12)!.report.approved).toBe(false);
  expect(calls).toHaveLength(1);
});

it.each(["unknown owner", "media classification", "duplicate owner"])("cannot approve a continuity diagnosis with %s", async defect => {
  const { options, primary, calls, fixture } = setup(1);
  const finding = structuredClone(fixture.findings[0]!);
  if (defect === "unknown owner") finding.pageIndex = 99;
  if (defect === "media classification") finding.domain = "deferred_media";
  if (defect === "duplicate owner") primary.pages.push({ ...primary.pages[11]! });
  const model = scriptedDevelopmentModel([primary, { findings: [finding] }]);
  let saved!: PictureBookReviewCheckpoint;
  await expect(reviewPictureBookManuscript({ ...options, textModel: model.model,
    onCheckpoint: async checkpoint => { saved = structuredClone(checkpoint); } })).rejects.toMatchObject({ name: "PictureBookReviewIncompleteError" });
  expect(saved.protocolIssues.join(" ")).toContain(String(finding.message));
  expect(model.calls).toHaveLength(2);
  expect(calls).toHaveLength(0);
});

it("does not reuse a grouped-only approval as a continuity-verified approval", () => {
  const { options } = setup(1);
  expect(pictureBookReviewFingerprint(options)).not.toBe(pictureBookReviewFingerprint({ ...options, continuityReview: false }));
  expect(pictureBookReviewFingerprint(options)).toBe(pictureBookReviewFingerprint({ ...options, continuityReview: true }));
});

it.each(["quote", "scope"])("retains a continuity finding during narrow %s recovery", async kind => {
  const { options, primary, fixture } = setup(1);
  const finding = structuredClone(fixture.findings[0]!);
  if (kind === "quote") finding.quote = "An invented quotation which does not occur in this manuscript.";
  else finding.repairPageIndexes = [12];
  const correction = kind === "quote"
    ? { pages: [], corrections: [{ id: "12:0:page", supportsSameClaim: true, quote: fixture.findings[0]!.quote }] }
    : { pages: [], metadataCorrections: [{ id: "12:0", supportsSameFinding: true, repairPageIndexes: null, relatedEvidenceIndexes: [0, 1] }] };
  const { model, calls } = scriptedDevelopmentModel([primary, { findings: [finding] }, correction]);
  const budget = { limit: 5, used: 0, outputWidened: false };
  const result = await reviewPictureBookManuscript({ ...options, textModel: model, textAttemptBudget: budget });
  expect(result.find(review => review.pageIndex === 12)).toMatchObject({ report: { approved: false }, findings: [{ message: finding.message }] });
  expect(calls.map(call => call.purpose)).toEqual(["review-page", "review-picture-book-continuity", "review-page"]);
  expect(budget.used).toBe(3);
});

it("cannot dispatch continuity when the grouped call consumes the remaining provider allowance", async () => {
  const { options, calls } = setup(1);
  const budget = { limit: 5, used: 0, outputWidened: false };
  const generate = options.textModel.generateJson.bind(options.textModel);
  options.textModel.generateJson = async request => { budget.used = 5; return generate(request); };
  await expect(reviewPictureBookManuscript({ ...options, textAttemptBudget: budget })).rejects.toMatchObject({ name: "PictureBookReviewIncompleteError" });
  expect(calls).toHaveLength(1);
  expect(budget.used).toBe(5);
});
