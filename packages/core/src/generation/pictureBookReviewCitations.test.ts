import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { consumeTextAttempt } from "../adapters/textAttemptBudget.js";
import { PictureBookReviewIncompleteError, type PictureBookReviewCheckpoint, reviewPictureBookManuscript } from "./pictureBookReview.js";
import { scriptedDevelopmentModel, originalDevelopmentPlan, developmentInput } from "./testing/bookDevelopmentFixtures.js";

const captured = JSON.parse(readFileSync(new URL("./testing/quickGroupReview.json", import.meta.url), "utf8"));
const originalFinding = captured.response.pages[19].findings[0];
const correctQuote = "Six lanterns glowed in order, from the gate to the reeds.";
const correction = { id: "20:0:0", supportsSameClaim: true, quote: correctQuote };
const correctedResponse = () => ({ pages: [], corrections: [{ ...correction }] });
function setup(answers: unknown[]) {
  const fixture = scriptedDevelopmentModel(answers);
  const options: Parameters<typeof reviewPictureBookManuscript>[0] = {
    input: { ...developmentInput, category: "KIDS", targetPages: 30, prompt: captured.brief },
    plan: originalDevelopmentPlan(), pages: captured.pages, chapterBriefs: [], checks: captured.checks, textModel: fixture.model
  };
  return { ...fixture, options };
}

it.each([false, true])("cannot approve Quick's unchanged page 20 by dropping a finding during quote recovery (minimal=%s)", async (minimal) => {
  const response = minimal ? { pages: captured.response.pages.filter((p: { pageIndex: number }) => [18, 20].includes(p.pageIndex)) } : captured.response;
  const pages = minimal ? captured.pages.filter((p: { index: number }) => [18, 20].includes(p.index)) : captured.pages;
  const { model, calls } = scriptedDevelopmentModel([response, captured.recoveryResponse]);
  const result = await reviewPictureBookManuscript({ input: { ...developmentInput, category: "KIDS", targetPages: 30, prompt: captured.brief },
    plan: originalDevelopmentPlan(), pages, chapterBriefs: [], checks: captured.checks, textModel: model
  }).then(() => "unexpected approval", error => error);
  expect(result).toMatchObject({ name: "PictureBookReviewIncompleteError", checkpoint: { unresolvedPageIndexes: [20] } });
  expect(calls).toHaveLength(2);
});

it("corrects only Quick's failed supporting quote and retains the finding, score and other assessments", async () => {
  const { options, calls } = setup([captured.response, correctedResponse()]);
  const reviews = await reviewPictureBookManuscript(options);
  const page = reviews.find(r => r.pageIndex === 20)!;
  expect(page.report).toMatchObject({ approved: false, score: 78, requiredRevisions: [originalFinding.guidance] });
  expect(page.findings).toEqual([{ ...originalFinding, relatedEvidence: [{ pageIndex: 18, quote: correctQuote }] }]);
  expect(page.storyExtract?.storyDelta.factsAdded).toEqual(captured.response.pages[19].storyExtract.storyDelta.factsAdded);
  expect(page.draftMarkdown).toBe(captured.pages[19].markdown);
  expect(reviews).toHaveLength(30);
  expect(reviews.filter(r => r.pageIndex !== 20).every(r => r.report.approved)).toBe(true);
  expect(calls).toHaveLength(2);
  const request = calls[1]!;
  const payload = JSON.parse(request.messages.find(m => m.role === "user")!.content);
  expect(payload.phase).toBe("picture_book_citation_recovery");
  expect(payload.citationRecovery.pages.map((p: { index: number }) => p.index)).toEqual([20, 18]);
  expect(payload.citationRecovery.pages.every((p: object) => Object.keys(p).sort().join(",") === "index,markdown")).toBe(true);
  expect(payload.citationRecovery.citations[0].finding).toEqual(originalFinding);
  expect(payload).not.toHaveProperty("book");
  expect(JSON.stringify(request.messages).length).toBeLessThan(5_000);
});

it.each(["refused", "missing", "null", "inventedQuote", "otherPage", "duplicate", "unknown", "rewriteRow"])("keeps the original concern unverified for %s recovery and never buys a third round", async (kind) => {
  const response: { pages: unknown[]; corrections: Array<{ id: string; supportsSameClaim: boolean; quote: string | null }> } = correctedResponse();
  if (kind === "refused") response.corrections[0]!.supportsSameClaim = false;
  if (kind === "missing") response.corrections = [];
  if (kind === "null") response.corrections[0]!.quote = null;
  if (kind === "inventedQuote") response.corrections[0]!.quote = "The owl carried away the seventh lantern.";
  if (kind === "otherPage") response.corrections[0]!.quote = captured.pages[19].markdown;
  if (kind === "duplicate") response.corrections.push({ ...correction });
  if (kind === "unknown") response.corrections[0]!.id = "unknown";
  if (kind === "rewriteRow") response.pages = captured.recoveryResponse.pages;
  const { options, calls } = setup([captured.response, response]);
  const result = await reviewPictureBookManuscript(options).catch(error => error);
  expect(result).toBeInstanceOf(PictureBookReviewIncompleteError);
  expect(result.checkpoint.citationRows[0].findings).toEqual([originalFinding]);
  expect(result.checkpoint.unresolvedPageIndexes).toEqual([20]);
  expect(result.checkpoint.reviews).toHaveLength(29);
  await expect(reviewPictureBookManuscript({ ...options, resume: result.checkpoint })).rejects.toBeInstanceOf(PictureBookReviewIncompleteError);
  expect(calls).toHaveLength(2);
});

it("retains independently valid findings on the same row while correcting every invalid quote", async () => {
  const response = structuredClone(captured.response);
  const row = response.pages[19];
  row.findings[0].quote = "Rabbit checked the lanterns and hurried back.";
  row.findings.push({ ...originalFinding, basis: "page_prose", relatedEvidence: [], message: "A second independently evidenced concern." });
  const answer = correctedResponse();
  answer.corrections.push({ ...correction, id: "20:0:page", quote: originalFinding.quote });
  const { options } = setup([response, answer]);
  const reviews = await reviewPictureBookManuscript(options);
  const result = reviews.find(r => r.pageIndex === 20)!;
  expect(result.findings).toHaveLength(2);
  expect(result.findings![1]).toEqual(row.findings[1]);
  expect(result.findings![0]!.quote).toBe(originalFinding.quote);
  expect(result.report.approved).toBe(false);
});

it("combines a missing page verdict and narrow citation corrections in the same remaining round", async () => {
  const response = structuredClone(captured.response);
  response.pages.pop();
  const { options, calls } = setup([response, { ...correctedResponse(), pages: [captured.response.pages[29]] }]);
  const result = await reviewPictureBookManuscript(options);
  expect(result).toHaveLength(30);
  expect(result.find(r => r.pageIndex === 20)?.report.approved).toBe(false);
  const payload = JSON.parse(calls[1]!.messages.find(m => m.role === "user")!.content);
  expect(payload.reviewPageIndexes).toEqual([30]);
  expect(payload.pages).toEqual(captured.pages);
  expect(payload.citationRecovery.citations[0].finding).toEqual(originalFinding);
  expect(calls).toHaveLength(2);
});

it("retains the original finding across a settled checkpoint and reserves recovery before dispatch", async () => {
  const first = setup([captured.response]);
  let saved!: PictureBookReviewCheckpoint;
  first.options.onCheckpoint = async checkpoint => {
    if (checkpoint.roundsStarted === 1 && checkpoint.attemptsUsed === 1) {
      saved = structuredClone(checkpoint);
      throw new Error("Process exits after durable commit");
    }
  };
  await expect(reviewPictureBookManuscript(first.options)).rejects.toThrow("Process exits");
  expect(saved.citationRows?.[0]?.findings).toEqual([originalFinding]);
  const next = setup([correctedResponse()]);
  const checkpoints: PictureBookReviewCheckpoint[] = [];
  const reviews = await reviewPictureBookManuscript({ ...next.options, resume: saved,
    onCheckpoint: async checkpoint => { checkpoints.push(structuredClone(checkpoint)); } });
  expect(reviews.find(r => r.pageIndex === 20)?.report.approved).toBe(false);
  expect(checkpoints[0]).toMatchObject({ roundsStarted: 2, attemptsUsed: 5, citationRows: [expect.any(Object)] });
  expect(checkpoints.at(-1)).toMatchObject({ roundsStarted: 2, attemptsUsed: 2, citationRows: [] });
  expect(next.calls).toHaveLength(1);
});

it("keeps the pending finding when transport attempts consume the shared allowance", async () => {
  const { options, model, calls } = setup([captured.response]);
  const generate = model.generateJson.bind(model);
  model.generateJson = async request => {
    for (let i = 0; i < 5; i++) consumeTextAttempt(request);
    return generate(request);
  };
  const error = await reviewPictureBookManuscript(options).catch(error => error);
  expect(error).toBeInstanceOf(PictureBookReviewIncompleteError);
  expect(error.checkpoint).toMatchObject({ attemptsUsed: 5, citationRows: [expect.any(Object)], unresolvedPageIndexes: [20] });
  expect(calls).toHaveLength(1);
});

it("never dispatches citation recovery if checkpoint reservation fails or a stop arrives", async () => {
  for (const stop of [false, true]) {
    const { options, calls } = setup([captured.response]);
    const controller = new AbortController();
    options.signal = controller.signal;
    options.onCheckpoint = async checkpoint => {
      if (stop && checkpoint.attemptsUsed === 1) controller.abort();
      if (!stop && checkpoint.roundsStarted === 2) throw new Error("Checkpoint unavailable");
    };
    await expect(reviewPictureBookManuscript(options)).rejects.toThrow();
    expect(calls).toHaveLength(1);
  }
});

it("does not turn too many invalid quotations into an unbounded correction call", async () => {
  const response = structuredClone(captured.response);
  for (const row of response.pages.slice(0, 5)) row.findings = Array.from({ length: 8 }, () => ({
    ...originalFinding, basis: "page_prose", quote: "This passage does not exist in the manuscript.", relatedEvidence: []
  }));
  const { options, calls } = setup([response]);
  const error = await reviewPictureBookManuscript(options).catch(error => error);
  expect(error).toBeInstanceOf(PictureBookReviewIncompleteError);
  expect(error.checkpoint.citationRows).toHaveLength(6);
  expect(error.checkpoint.attemptsUsed).toBe(1);
  expect(calls).toHaveLength(1);
});

it("rejects a restored citation row when enabled checks or its exact manuscript no longer match", async () => {
  const { options } = setup([captured.response, { pages: [], corrections: [] }]);
  const error = await reviewPictureBookManuscript(options).catch(error => error);
  expect(error).toBeInstanceOf(PictureBookReviewIncompleteError);
  const next = setup([]);
  const resume = error.checkpoint as PictureBookReviewCheckpoint;
  const edited = { ...next.options, pages: next.options.pages.map(p => p.index === 18
    ? { ...p, markdown: originalFinding.relatedEvidence[0].quote } : p) };
  // Removing completed rows isolates validation of the pending citation contract.
  await expect(reviewPictureBookManuscript({ ...edited, resume: { ...resume, reviews: [] } })).rejects.toThrow("Pending citation review does not match");
  await expect(reviewPictureBookManuscript({ ...next.options, checks: { ...next.options.checks, storyExtractAudit: false },
    resume: { ...resume, reviews: [] } })).rejects.toThrow("Pending citation review does not match");
  expect(next.calls).toHaveLength(0);
});
