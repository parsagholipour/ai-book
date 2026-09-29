import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { createProjectSchema } from "../schemas/book.js";
import { makeFallbackPlan } from "../prompting/templates.js";
import { scriptedDevelopmentModel } from "./testing/bookDevelopmentFixtures.js";
import { consumeTextAttempt } from "../adapters/textAttemptBudget.js";
import { pictureBookMetadataRow } from "./pictureBookReviewMetadata.js";
import { distributePictureBookFindings } from "./pictureBookReviewFindings.js";
import { canonicalPictureBookChecks } from "./pictureBookReviewContract.js";
import { PictureBookReviewIncompleteError, reviewPictureBookManuscript, type PictureBookReviewCheckpoint } from "./pictureBookReview.js";

const captured = JSON.parse(readFileSync(new URL("./testing/quickMalformedFindingMetadata.json", import.meta.url), "utf8"));
const input = createProjectSchema.parse({ prompt: captured.brief, category: "KIDS", targetPages: 30, language: "en",
  mediaSettings: { audienceAgeRange: "6-8", finalReview: true } });
function setup(answers: unknown[]) {
  const { model, calls } = scriptedDevelopmentModel(answers);
  const options: Parameters<typeof reviewPictureBookManuscript>[0] = { input, plan: makeFallbackPlan(input), pages: captured.pages, chapterBriefs: [], continuityReview: false,
    checks: captured.enabledChecks, repairContext: captured.repairContext, textModel: model };
  return { options, calls };
}
const correctedResponse = () => ({ pages: [] as unknown[], metadataCorrections: [
  { id: "4:0", supportsSameFinding: true, repairPageIndexes: null as number[] | null, relatedEvidenceIndexes: [0, 1] },
  { id: "25:0", supportsSameFinding: true, repairPageIndexes: [25, 26, 27, 28, 29], relatedEvidenceIndexes: [1, 2, 3] }
] });

it("cannot approve Quick's unchanged pages when format recovery erases the two diagnoses", async () => {
  const { options, calls } = setup([captured.response, captured.emptyRecovery]);
  const result = await reviewPictureBookManuscript(options).catch(error => error);
  expect(result).toBeInstanceOf(PictureBookReviewIncompleteError);
  expect(result.checkpoint.unresolvedPageIndexes).toEqual([4, 25]);
  expect(result.checkpoint.metadataRows.map((row: { pageIndex: number }) => row.pageIndex)).toEqual([4, 25]);
  expect(result.checkpoint.metadataRows.flatMap((row: { findings: { message: string }[] }) => row.findings.map(f => f.message)))
    .toEqual(captured.response.findings.map((f: { message: string }) => f.message));
  expect(calls).toHaveLength(2);
  await expect(reviewPictureBookManuscript({ ...options, resume: result.checkpoint })).rejects.toBeInstanceOf(PictureBookReviewIncompleteError);
  expect(calls).toHaveLength(2);
});

it("retains the actual malformed findings at the durable checkpoint before spending recovery", async () => {
  const { options, calls } = setup([captured.response]);
  let saved!: PictureBookReviewCheckpoint;
  await expect(reviewPictureBookManuscript({ ...options, onCheckpoint: async checkpoint => {
    if (checkpoint.roundsStarted === 1 && checkpoint.attemptsUsed === 1) {
      saved = structuredClone(checkpoint);
      throw new Error("Process exited after durable commit");
    }
  } })).rejects.toThrow("Process exited");
  expect(saved).toMatchObject({ unresolvedPageIndexes: [4, 25], metadataRows: [
    { pageIndex: 4, findings: [expect.objectContaining({ repairPageIndexes: [4] })] },
    { pageIndex: 25, findings: [expect.objectContaining({ relatedEvidence: expect.any(Array) })] }
  ] });
  expect(calls).toHaveLength(1);
  const next = setup([correctedResponse()]);
  const checkpoints: PictureBookReviewCheckpoint[] = [];
  const reviews = await reviewPictureBookManuscript({ ...next.options, resume: JSON.parse(JSON.stringify(saved)),
    onCheckpoint: async checkpoint => { checkpoints.push(structuredClone(checkpoint)); } });
  expect(reviews.filter(review => !review.report.approved).map(review => review.pageIndex)).toEqual([4, 25]);
  expect(checkpoints[0]).toMatchObject({ roundsStarted: 2, attemptsUsed: 5, metadataRows: [expect.any(Object), expect.any(Object)] });
  expect(checkpoints.at(-1)).toMatchObject({ roundsStarted: 2, attemptsUsed: 2, metadataRows: [] });
  expect(next.calls).toHaveLength(1);
});

it("corrects only invalid metadata, preserving the complete original diagnoses and every other assessment", async () => {
  const { options, calls } = setup([captured.response, correctedResponse()]);
  const reviews = await reviewPictureBookManuscript(options);
  const control = structuredClone(captured.response);
  delete control.findings[0].repairPageIndexes;
  control.findings[1].relatedEvidence.splice(0, 1);
  const original = setup([control]);
  expect(reviews).toEqual(await reviewPictureBookManuscript(original.options));
  expect(reviews).toHaveLength(30);
  expect(reviews.filter(review => !review.report.approved).map(review => review.pageIndex)).toEqual([4, 25]);
  expect(calls).toHaveLength(2);
  const payload = JSON.parse(calls[1]!.messages.find(message => message.role === "user")!.content);
  expect(payload.phase).toBe("picture_book_metadata_recovery");
  expect(payload.metadataRecovery.findings.map((finding: { id: string }) => finding.id)).toEqual(["4:0", "25:0"]);
  expect(payload.metadataRecovery.pages.map((page: { index: number }) => page.index).sort((a: number, b: number) => a - b))
    .toEqual([4, 12, 18, 25, 26, 27, 28, 29]);
  expect(payload).not.toHaveProperty("book");
  expect(JSON.stringify(calls[1]!.messages).length).toBeLessThan(JSON.stringify(calls[0]!.messages).length / 2);
});

it.each(["refused", "missing", "duplicate", "unknown", "dropEvidence", "inventEvidence", "duplicateEvidence", "dropEndpoint", "changeValidScope", "rewriteRow"])
  ("keeps the concern unresolved after %s metadata correction within the same retry cap", async kind => {
    const response = correctedResponse();
    const second = response.metadataCorrections[1]!;
    if (kind === "refused") second.supportsSameFinding = false;
    if (kind === "missing") response.metadataCorrections.pop();
    if (kind === "duplicate") response.metadataCorrections.push({ ...second });
    if (kind === "unknown") second.id = "unknown";
    if (kind === "dropEvidence") second.relatedEvidenceIndexes = [];
    if (kind === "inventEvidence") second.relatedEvidenceIndexes = [4];
    if (kind === "duplicateEvidence") second.relatedEvidenceIndexes = [3, 3];
    if (kind === "dropEndpoint") second.relatedEvidenceIndexes = [0, 1, 2];
    if (kind === "changeValidScope") second.repairPageIndexes = null;
    if (kind === "rewriteRow") response.pages = captured.emptyRecovery.pages;
    const { options, calls } = setup([captured.response, response]);
    const error = await reviewPictureBookManuscript(options).catch(error => error);
    expect(error).toBeInstanceOf(PictureBookReviewIncompleteError);
    expect(error.checkpoint.metadataRows.find((row: { pageIndex: number }) => row.pageIndex === 25).findings[0].message)
      .toBe(captured.response.findings[1].message);
    await expect(reviewPictureBookManuscript({ ...options, resume: error.checkpoint })).rejects.toBeInstanceOf(PictureBookReviewIncompleteError);
    expect(calls).toHaveLength(2);
  });

it("combines missing verdicts and metadata corrections in the one remaining round", async () => {
  const first = structuredClone(captured.response);
  const missing = first.pages.pop();
  const { options, calls } = setup([first, { ...correctedResponse(), pages: [{ ...missing, findings: [] }] }]);
  const reviews = await reviewPictureBookManuscript(options);
  expect(reviews).toHaveLength(30);
  expect(reviews.filter(review => !review.report.approved).map(review => review.pageIndex)).toEqual([4, 25]);
  expect(JSON.parse(calls[1]!.messages.find(message => message.role === "user")!.content).reviewPageIndexes).toEqual([30]);
  expect(calls).toHaveLength(2);
});

it("combines citation and metadata corrections without replacing either diagnosis", async () => {
  const first = structuredClone(captured.response);
  const quote = captured.pages[4].markdown.slice(0, 50);
  first.findings.push({ pageIndex: 5, domain: "prose", basis: "page_prose", requirementQuote: null, category: "arc",
    message: "A separate concern on page five.", guidance: "Clarify Rabbit's choice.", relatedEvidence: [],
    quote: "This quotation does not appear anywhere in the manuscript." });
  const { options, calls } = setup([first, { ...correctedResponse(),
    corrections: [{ id: "5:0:page", supportsSameClaim: true, quote }] }]);
  const reviews = await reviewPictureBookManuscript(options);
  expect(reviews.filter(review => !review.report.approved).map(review => review.pageIndex)).toEqual([4, 5, 25]);
  expect(reviews[4]?.findings?.[0]).toMatchObject({ message: "A separate concern on page five.", quote });
  const payload = JSON.parse(calls[1]!.messages.find(message => message.role === "user")!.content);
  expect(payload).toHaveProperty("citationRecovery");
  expect(payload).toHaveProperty("metadataRecovery");
  expect(calls).toHaveLength(2);
});

it("keeps valid sibling findings and forbids removing their evidence during metadata recovery", async () => {
  const first = structuredClone(captured.response);
  const { repairPageIndexes: _scope, ...sibling } = first.findings[0];
  first.findings.push({ ...sibling, message: "A separate grounded concern on the same page." });
  const { options } = setup([first, correctedResponse()]);
  const reviews = await reviewPictureBookManuscript(options);
  expect(reviews[3]?.findings?.map(finding => finding.message)).toEqual([first.findings[0].message, "A separate grounded concern on the same page."]);
  const response = correctedResponse();
  response.metadataCorrections[0]!.relatedEvidenceIndexes = [0];
  const failure = setup([first, response]);
  const error = await reviewPictureBookManuscript(failure.options).catch(error => error);
  expect(error).toBeInstanceOf(PictureBookReviewIncompleteError);
  expect(error.checkpoint.metadataRows[0].findings).toHaveLength(2);
  expect(error.checkpoint.unresolvedPageIndexes).toEqual([4]);
});

it.each([false, true])("does not dispatch recovery after checkpoint failure or cancellation (stop=%s)", async stop => {
  const { options, calls } = setup([captured.response]);
  const controller = new AbortController();
  options.signal = controller.signal;
  options.onCheckpoint = async checkpoint => {
    if (stop && checkpoint.attemptsUsed === 1) controller.abort();
    if (!stop && checkpoint.roundsStarted === 2) throw new Error("Checkpoint unavailable");
  };
  await expect(reviewPictureBookManuscript(options)).rejects.toThrow();
  expect(calls).toHaveLength(1);
});

it("rejects restored metadata whose cited prose no longer matches", async () => {
  const first = setup([captured.response, { pages: [], metadataCorrections: [] }]);
  const error = await reviewPictureBookManuscript(first.options).catch(error => error);
  expect(error).toBeInstanceOf(PictureBookReviewIncompleteError);
  const next = setup([]);
  await expect(reviewPictureBookManuscript({ ...next.options, pages: next.options.pages.map(page => page.index === 29
    ? { ...page, markdown: "Completely different prose, after an edit." } : page),
    resume: { ...error.checkpoint, reviews: [] } })).rejects.toThrow("Pending metadata review does not match");
  expect(next.calls).toHaveLength(0);
});

it("retains diagnoses when provider attempts exhaust the shared allowance", async () => {
  const { options, calls } = setup([captured.response]);
  const generate = options.textModel.generateJson.bind(options.textModel);
  options.textModel.generateJson = async request => {
    for (let i = 0; i < 5; i++) consumeTextAttempt(request);
    return generate(request);
  };
  const error = await reviewPictureBookManuscript(options).catch(error => error);
  expect(error).toBeInstanceOf(PictureBookReviewIncompleteError);
  expect(error.checkpoint).toMatchObject({ attemptsUsed: 5, unresolvedPageIndexes: [4, 25], metadataRows: [expect.any(Object), expect.any(Object)] });
  expect(calls).toHaveLength(1);
});

it.each(["quote", "relatedQuote", "requirement"])("does not promote an ungrounded %s to a metadata-only correction", kind => {
  const { options } = setup([]);
  const response = structuredClone(captured.response);
  if (kind === "quote") response.findings[0].quote = "An invented quotation without manuscript support.";
  if (kind === "relatedQuote") response.findings[0].relatedEvidence[0].quote = "An invented supporting quotation without manuscript support.";
  if (kind === "requirement") response.findings[0].requirementQuote = "An invented user requirement.";
  const row = distributePictureBookFindings(response).pages.find((row: any) => row.pageIndex === 4);
  expect(pictureBookMetadataRow(canonicalPictureBookChecks(row, options.checks), { ...options,
    pages: new Map(options.pages.map(page => [page.index, page])) })).toBeUndefined();
});
