import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { pageQualityReportSchema } from "../schemas/book.js";
import { PictureBookReviewIncompleteError, reviewPictureBookManuscript, type PictureBookReviewCheckpoint } from "./pictureBookReview.js";
import { pictureBookSceneRepairTargets } from "./pictureBookSceneRepairTargets.js";
import { developmentInput, originalDevelopmentPlan, scriptedDevelopmentModel } from "./testing/bookDevelopmentFixtures.js";

// Quick's 2026-09-28 thirty-page review put page 24's quote on the page 23
// finding. Citation and scene-scope checks failed together; recovery erased it.
const captured = JSON.parse(readFileSync(new URL("./testing/quickCitationScopeRecovery.json", import.meta.url), "utf8"));
const { pageIndex: owner, ...originalFinding } = captured.response.findings[1];
const ownerQuote = captured.pages.find((page: { index: number }) => page.index === owner).markdown.split(". ")[0] + ".";
function setup(minimal = true, answers?: unknown[]) {
  const response = structuredClone(captured.response);
  const pages = minimal ? captured.pages.filter((page: { index: number }) => page.index >= 23 && page.index <= 26) : captured.pages;
  if (minimal) {
    response.pages = response.pages.filter((page: { pageIndex: number }) => page.pageIndex >= 23 && page.pageIndex <= 26);
    response.findings = [response.findings[1]];
  }
  const recoveryResponse = structuredClone(captured.recoveryResponse);
  if (minimal) delete recoveryResponse.auxiliaryCorrections;
  // The new contract keeps page 29's valid story delta and asks only for an
  // acknowledgement of its malformed outer envelope, not a replacement delta.
  else recoveryResponse.auxiliaryCorrections.forEach((patch: { storyExtract?: unknown }) => { delete patch.storyExtract; });
  const fixture = scriptedDevelopmentModel(answers ?? [response, recoveryResponse]);
  const options: Parameters<typeof reviewPictureBookManuscript>[0] = {
    input: { ...developmentInput, category: "KIDS", targetPages: 30, prompt: captured.brief },
    plan: originalDevelopmentPlan(), pages, chapterBriefs: [], continuityReview: false, checks: captured.checks, textModel: fixture.model
  };
  return { ...fixture, response, options };
}
const correction = (quote: string | null, supportsSameClaim = true) => ({
  pages: [], corrections: [{ id: "23:0:page", supportsSameClaim, quote }]
});

it.each([false, true])("preserves Quick's scene finding when citation and scope validation fail together (minimal=%s)", async minimal => {
  const { options, calls } = setup(minimal);
  const result = await reviewPictureBookManuscript(options).catch(error => error);
  expect(result).toBeInstanceOf(PictureBookReviewIncompleteError);
  expect(result.checkpoint).toMatchObject({ unresolvedPageIndexes: [23], roundsStarted: 2, attemptsUsed: 2,
    citationRows: [{ pageIndex: 23, findings: [originalFinding] }] });
  expect(result.checkpoint.reviews).toHaveLength(minimal ? 3 : 29);
  expect(calls).toHaveLength(2);
  const payload = JSON.parse(calls[1]!.messages.find(message => message.role === "user")!.content);
  expect(payload.reviewPageIndexes ?? []).toEqual([]);
  expect(payload).not.toHaveProperty("book");
  expect(payload.citationRecovery.citations).toMatchObject([{ id: "23:0:page", finding: originalFinding }]);
  if (!minimal) {
    expect(payload.auxiliaryRecovery.rows).toEqual([{ id: "page:29", pageIndex: 29, requiredFields: [] }]);
    expect(result.checkpoint.reviews.find((row: { pageIndex: number }) => row.pageIndex === 29).storyExtract.storyDelta.factsAdded)
      .toEqual(captured.response.pages.find((row: { pageIndex: number }) => row.pageIndex === 29).storyExtract.storyDelta.factsAdded);
  }
  // The original scope is retained as a concern, never as editing authority.
  expect(pictureBookSceneRepairTargets(options.pages, [{ pageIndex: 23, draftMarkdown: options.pages.find(page => page.index === 23)!.markdown,
    report: pageQualityReportSchema.parse({ approved: false }), completedChecks: options.checks,
    storyExtract: null, styleAudit: null, unverifiedFindings: [originalFinding]
  }])).toEqual([]);
  await expect(reviewPictureBookManuscript({ ...options, resume: result.checkpoint })).rejects.toBeInstanceOf(PictureBookReviewIncompleteError);
  expect(calls).toHaveLength(2);
});

it.each(["missing", "declined", "wrongPage", "invalidScope"])("keeps the finding unverified after %s citation recovery", async kind => {
  const { response } = setup();
  if (kind === "invalidScope") response.findings[0].repairPageIndexes = [23, 26];
  const answer = kind === "missing" ? { pages: [], corrections: [] }
    : correction(kind === "invalidScope" ? ownerQuote : kind === "wrongPage" ? originalFinding.quote : null, kind !== "declined");
  const { options, calls } = setup(true, [response, answer]);
  const result = await reviewPictureBookManuscript(options).catch(error => error);
  expect(result).toBeInstanceOf(PictureBookReviewIncompleteError);
  expect(result.checkpoint.citationRows[0].findings).toEqual([{ ...originalFinding,
    ...(kind === "invalidScope" ? { repairPageIndexes: [23, 26] } : {}) }]);
  expect(result.checkpoint.reviews.map((review: { pageIndex: number }) => review.pageIndex)).not.toContain(23);
  if (kind === "invalidScope") expect(result.checkpoint.validationIssues[0].message).toContain("repairPageIndexes must name a contiguous");
  expect(calls).toHaveLength(2);
});

it.each(["malformedScope", "auxiliary", "anotherFinding"])("cannot erase a diagnosis when citation failure also has an unsupported %s error", async kind => {
  const { response } = setup();
  if (kind === "malformedScope") response.findings[0].repairPageIndexes = [23];
  if (kind === "auxiliary") response.pages[0].storyExtract = {};
  if (kind === "anotherFinding") response.findings.push({ ...response.findings[0], quote: ownerQuote, repairPageIndexes: [23, 26] });
  const cleanRecovery = structuredClone(captured.recoveryResponse);
  delete cleanRecovery.auxiliaryCorrections;
  const { options, calls } = setup(true, [response, cleanRecovery]);
  const result = await reviewPictureBookManuscript(options).catch(error => error);
  expect(result).toBeInstanceOf(PictureBookReviewIncompleteError);
  expect(result.checkpoint.protocolIssues.join(" ")).toContain(originalFinding.message);
  expect(result.checkpoint.protocolIssues.join(" ")).toContain(originalFinding.guidance);
  expect(pictureBookSceneRepairTargets(options.pages, result.checkpoint.reviews)).toEqual([]);
  await expect(reviewPictureBookManuscript({ ...options, resume: result.checkpoint })).rejects.toBeInstanceOf(PictureBookReviewIncompleteError);
  expect(calls).toHaveLength(2);
});

it("accepts a faithful quote correction only after revalidating the complete scene scope", async () => {
  const { response } = setup();
  // This control has a genuine quote typo on the owner page, rather than the
  // captured wrong-page quotation, which cannot truthfully be moved to page 24.
  response.findings[0].quote = ownerQuote.replace("neighbors", "neighbours");
  const { options, calls } = setup(true, [response, correction(ownerQuote)]);
  const reviews = await reviewPictureBookManuscript(options);
  const review = reviews.find(page => page.pageIndex === 23)!;
  expect(review.findings).toEqual([{ ...originalFinding, quote: ownerQuote }]);
  expect(review.report).toMatchObject({ approved: false, score: response.pages[0].score, requiredRevisions: [originalFinding.guidance] });
  expect(pictureBookSceneRepairTargets(options.pages, reviews)).toEqual([{ pageIndex: 23, pageIndexes: [23, 24, 25, 26] }]);
  expect(calls).toHaveLength(2);
});

it("resumes the retained citation-and-scope finding without requesting a fresh verdict", async () => {
  const first = setup();
  let saved!: PictureBookReviewCheckpoint;
  first.options.onCheckpoint = async checkpoint => {
    if (checkpoint.roundsStarted === 1 && checkpoint.attemptsUsed === 1) {
      saved = structuredClone(checkpoint);
      throw new Error("Simulated worker exit after checkpoint");
    }
  };
  await expect(reviewPictureBookManuscript(first.options)).rejects.toThrow("Simulated worker exit");
  expect(saved.citationRows?.[0]?.findings).toEqual([originalFinding]);
  const next = setup(true, [correction(null, false)]);
  const result = await reviewPictureBookManuscript({ ...next.options, resume: saved }).catch(error => error);
  expect(result).toBeInstanceOf(PictureBookReviewIncompleteError);
  expect(result.checkpoint.citationRows[0].findings).toEqual([originalFinding]);
  expect(next.calls).toHaveLength(1);
});
