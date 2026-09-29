import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { createProjectSchema } from "../schemas/book.js";
import { makeFallbackPlan } from "../prompting/templates.js";
import { scriptedDevelopmentModel } from "./testing/bookDevelopmentFixtures.js";
import { PictureBookReviewIncompleteError, reviewPictureBookManuscript, type PictureBookReviewCheckpoint } from "./pictureBookReview.js";

const fixture = JSON.parse(readFileSync(new URL("./testing/pictureBookRecoveryScope.json", import.meta.url), "utf8"));
function setup(tier: "fast" | "balanced", answers: unknown[]) {
  const capture = fixture[tier];
  const input = createProjectSchema.parse({ prompt: capture.brief, category: "KIDS", targetPages: 30, language: "en",
    mediaSettings: { audienceAgeRange: "6-8" } });
  const { model, calls } = scriptedDevelopmentModel(answers);
  const options = { input, plan: makeFallbackPlan(input), pages: capture.pages, chapterBriefs: [],
    checks: capture.enabledChecks, continuityReview: false, textModel: model };
  return { options, calls };
}
const balancedCorrection = (scope: number[] | null) => ({ pages: [], metadataCorrections: [
  { id: "7:0", supportsSameFinding: true, repairPageIndexes: scope, relatedEvidenceIndexes: [0] }
] });
function quickCorrection() {
  return { pages: [], metadataCorrections: [
    { id: "19:0", supportsSameFinding: true, repairPageIndexes: [19, 20, 21, 22, 23, 24], relatedEvidenceIndexes: [0, 1] },
    { id: "25:0", supportsSameFinding: true, repairPageIndexes: [25, 26, 27, 28], relatedEvidenceIndexes: [0, 1] }
  ], auxiliaryCorrections: [13, 30].map(pageIndex => ({ id: `page:${pageIndex}`,
    storyExtract: fixture.fast.response.pages.find((row: { pageIndex: number }) => row.pageIndex === pageIndex).storyExtract })) };
}

it("does not turn Balanced's two supporting pages into a 21-page edit interval", async () => {
  const { options, calls } = setup("balanced", [fixture.balanced.response, balancedCorrection(Array.from({ length: 21 }, (_, i) => i + 7))]);
  const error = await reviewPictureBookManuscript(options).catch(error => error);
  expect(error).toBeInstanceOf(PictureBookReviewIncompleteError);
  expect(error.checkpoint.metadataRows[0].findings[0].repairPageIndexes).toEqual([7, 27]);
  expect(calls).toHaveLength(2);
});

it("keeps Balanced's evidence separate while correcting its repair to a local edit", async () => {
  const { options, calls } = setup("balanced", [fixture.balanced.response, balancedCorrection(null)]);
  const result = await reviewPictureBookManuscript(options);
  expect(result[6]?.findings?.[0]).toMatchObject({ message: fixture.balanced.response.findings[0].message,
    relatedEvidence: fixture.balanced.response.findings[0].relatedEvidence });
  expect(result[6]?.findings?.[0]).not.toHaveProperty("repairPageIndexes");
  const request = JSON.parse(calls[1]!.messages.find(m => m.role === "user")!.content);
  expect(request.metadataRecovery.findings[0].evidencePageIndexes).toEqual([7, 27]);
  expect(request).not.toHaveProperty("book");
  expect(calls).toHaveLength(2);
});

it("recovers Quick's auxiliary checks and known finding metadata without another editorial pass", async () => {
  const { options, calls } = setup("fast", [fixture.fast.response, quickCorrection()]);
  const result = await reviewPictureBookManuscript(options);
  expect(result.filter(row => !row.report.approved).map(row => row.pageIndex)).toEqual([19, 21, 25]);
  const request = JSON.parse(calls[1]!.messages.find(m => m.role === "user")!.content);
  expect(request).not.toHaveProperty("book");
  expect(request.reviewPageIndexes ?? []).toEqual([]);
  expect(request.auxiliaryRecovery.rows.map((row: { id: string }) => row.id)).toEqual(["page:13", "page:30"]);
  expect(JSON.stringify(calls[1]!.messages).length).toBeLessThan(JSON.stringify(calls[0]!.messages).length * 0.6);
  expect(calls).toHaveLength(2);
});

it.each([true, false])("persists a new unowned concern even when metadata corrections are present=%s", async validCorrection => {
  const response = { ...(validCorrection ? balancedCorrection(null) : { pages: [] }), findings: [fixture.balanced.legacyRecovery.findings[0]] };
  const { options, calls } = setup("balanced", [fixture.balanced.response, response]);
  const error = await reviewPictureBookManuscript(options).catch(error => error);
  expect(error).toBeInstanceOf(PictureBookReviewIncompleteError);
  expect(error.checkpoint.protocolIssues.join(" ")).toContain(fixture.balanced.legacyRecovery.findings[0].message);
  expect(error.checkpoint.protocolIssues.join(" ")).toContain('"pageIndex":6');
  await expect(reviewPictureBookManuscript({ ...options, resume: JSON.parse(JSON.stringify(error.checkpoint)) }))
    .rejects.toBeInstanceOf(PictureBookReviewIncompleteError);
  expect(calls).toHaveLength(2);
});

it.each(["missing", "duplicate", "unknown", "malformed", "rewriteVerdict"])("retains the original assessment after an auxiliary %s correction", async kind => {
  const response = quickCorrection();
  if (kind === "missing") response.auxiliaryCorrections.pop();
  if (kind === "duplicate") response.auxiliaryCorrections.push(response.auxiliaryCorrections[1]!);
  if (kind === "unknown") response.auxiliaryCorrections[1]!.id = "page:99";
  if (kind === "malformed") response.auxiliaryCorrections[1]!.storyExtract = { invented: true };
  if (kind === "rewriteVerdict") Object.assign(response.auxiliaryCorrections[1]!, { score: 100, findings: [] });
  const { options, calls } = setup("fast", [fixture.fast.response, response]);
  const error = await reviewPictureBookManuscript(options).catch(error => error);
  expect(error).toBeInstanceOf(PictureBookReviewIncompleteError);
  expect(error.checkpoint.editorialRows.map((row: { pageIndex: number }) => row.pageIndex)).toEqual([30]);
  expect(error.checkpoint.reviews.filter((row: { report: { approved: boolean } }) => !row.report.approved)
    .map((row: { pageIndex: number }) => row.pageIndex)).toEqual([19, 21, 25]);
  await expect(reviewPictureBookManuscript({ ...options, resume: error.checkpoint })).rejects.toBeInstanceOf(PictureBookReviewIncompleteError);
  expect(calls).toHaveLength(2);
});

it("does not erase an earlier unowned diagnosis when a later recovery settles its missing page", async () => {
  const response = structuredClone(fixture.balanced.response);
  delete response.findings[0].repairPageIndexes;
  response.pages.pop();
  response.findings.push({ ...fixture.balanced.legacyRecovery.findings[0], pageIndex: 30 });
  const cleanLastPage = fixture.balanced.response.pages.at(-1);
  const { options, calls } = setup("balanced", [response, { findings: [], pages: [cleanLastPage] }]);
  const error = await reviewPictureBookManuscript(options).catch(error => error);
  expect(error).toBeInstanceOf(PictureBookReviewIncompleteError);
  expect(error.checkpoint.unresolvedPageIndexes).toEqual([]);
  expect(error.checkpoint.protocolIssues.join(" ")).toContain(fixture.balanced.legacyRecovery.findings[0].message);
  expect(calls).toHaveLength(2);
});

it("resumes Quick's settled mixed recovery without replaying the initial review", async () => {
  const first = setup("fast", [fixture.fast.response]);
  let saved!: PictureBookReviewCheckpoint;
  await expect(reviewPictureBookManuscript({ ...first.options, onCheckpoint: async checkpoint => {
    if (checkpoint.roundsStarted === 1 && checkpoint.attemptsUsed === 1) {
      saved = structuredClone(checkpoint); throw new Error("durable interruption");
    }
  } })).rejects.toThrow("durable interruption");
  const next = setup("fast", [quickCorrection()]);
  const result = await reviewPictureBookManuscript({ ...next.options, resume: JSON.parse(JSON.stringify(saved)) });
  expect(result.filter(row => !row.report.approved).map(row => row.pageIndex)).toEqual([19, 21, 25]);
  expect(next.calls).toHaveLength(1);
});
