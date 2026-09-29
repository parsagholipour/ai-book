import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { createProjectSchema } from "../schemas/book.js";
import { makeFallbackPlan } from "../prompting/templates.js";
import { scriptedDevelopmentModel } from "./testing/bookDevelopmentFixtures.js";
import { reviewPictureBookManuscript, PictureBookReviewIncompleteError, type PictureBookReviewCheckpoint } from "./pictureBookReview.js";
import { pictureBookEditorialRowsSchema } from "./pictureBookReviewRecovery.js";
import { pictureBookChecklistSpans } from "./pictureBookChecklistSpans.js";

const saved = JSON.parse(readFileSync(new URL("./testing/representationRecovery0928.json", import.meta.url), "utf8"));
function setup(tier: "quick" | "premium", answers: unknown[]) {
  const fixture = saved[tier];
  const input = createProjectSchema.parse({ prompt: fixture.brief, category: "KIDS", targetPages: 30, language: "en" });
  const { model, calls } = scriptedDevelopmentModel(answers);
  const options = { input, plan: makeFallbackPlan(input), pages: fixture.pages, chapterBriefs: [], continuityReview: false,
    checks: { pageModelReview: true, storyExtractAudit: false, styleAuditor: false }, textModel: model };
  return { options, calls };
}
function response(tier: "quick" | "premium") {
  return { findings: structuredClone(saved[tier].response.findings), pages: saved[tier].pages.map((p: { index: number }) => ({ pageIndex: p.index, score: 80 })) };
}
function correction() {
  const page = saved.quick.pages.find((p: { index: number }) => p.index === 25);
  const spanId = Object.keys(pictureBookChecklistSpans(page))[0]!;
  return { pages: [], metadataCorrections: [{ id: "20:0", supportsSameFinding: true,
    repairPageIndexes: [20, 21, 22, 23, 24, 25], relatedEvidenceIndexes: [0], endpointEvidence: [{ pageIndex: 25, spanId }] }] };
}

it("recovers Quick's missing endpoint inside its original interval without rewriting the diagnosis", async () => {
  const { options, calls } = setup("quick", [response("quick"), correction()]);
  const reviews = await reviewPictureBookManuscript(options);
  const finding = reviews[19]?.findings?.[0];
  expect(finding).toMatchObject({ message: saved.quick.response.findings[0].message, repairPageIndexes: [20, 21, 22, 23, 24, 25] });
  expect(finding?.relatedEvidence.map(e => e.pageIndex)).toEqual([24, 25]);
  expect(reviews[19]?.report.approved).toBe(false);
  expect(calls).toHaveLength(2);
  const payload = JSON.parse(calls[1]!.messages.find(m => m.role === "user")!.content);
  expect(payload.metadataRecovery.pages.map((p: { index: number }) => p.index).sort()).toEqual([20, 24, 25]);
  expect(payload).not.toHaveProperty("book");
});

it.each(["outside", "stale", "prototype", "duplicate", "widen", "refused"])("does not grant repair scope from %s endpoint evidence", async kind => {
  const corrected = correction(), item = corrected.metadataCorrections[0]!;
  if (kind === "outside") item.endpointEvidence[0]!.pageIndex = 26;
  if (kind === "stale") item.endpointEvidence[0]!.spanId = "stale:0";
  if (kind === "prototype") item.endpointEvidence[0]!.spanId = "__proto__";
  if (kind === "duplicate") item.endpointEvidence.push(item.endpointEvidence[0]!);
  if (kind === "widen") item.repairPageIndexes.push(26);
  if (kind === "refused") item.supportsSameFinding = false;
  const { options, calls } = setup("quick", [response("quick"), corrected]);
  const error = await reviewPictureBookManuscript(options).catch(e => e);
  expect(error).toBeInstanceOf(PictureBookReviewIncompleteError);
  expect(error.checkpoint.metadataRows[0].findings[0].message).toBe(saved.quick.response.findings[0].message);
  expect(calls).toHaveLength(2);
  await expect(reviewPictureBookManuscript({ ...options, resume: error.checkpoint })).rejects.toBeInstanceOf(PictureBookReviewIncompleteError);
  expect(calls).toHaveLength(2);
});

it("normalizes Premium's empty LOCAL scopes without spending a metadata call or erasing findings", async () => {
  const { options, calls } = setup("premium", [response("premium")]);
  const reviews = await reviewPictureBookManuscript(options);
  expect(reviews.filter(r => !r.report.approved).map(r => r.pageIndex)).toEqual([2, 8, 26, 27]);
  expect(reviews[1]?.findings?.[0]).not.toHaveProperty("repairPageIndexes");
  expect(reviews[25]?.findings?.[0]?.repairPageIndexes).toEqual([26, 27, 28, 29]);
  expect(calls).toHaveLength(1);
});

it("recovers only invalid story state and freezes the valid style result", async () => {
  const first = { findings: [], pages: [{ pageIndex: 30, score: 95, storyExtract: "reuse", styleAudit: "clean" }] };
  const { options, calls } = setup("premium", [first, { pages: [], auxiliaryCorrections: [{ id: "page:30", storyExtract: "no_changes" }] }]);
  const reviews = await reviewPictureBookManuscript({ ...options, pages: options.pages.filter((p: { index: number }) => p.index === 30),
    checks: { pageModelReview: true, storyExtractAudit: true, styleAuditor: true } });
  expect(reviews[0]?.styleAudit?.styleOk).toBe(true);
  const payload = JSON.parse(calls[1]!.messages.find(m => m.role === "user")!.content);
  expect(payload.auxiliaryRecovery.rows[0].requiredFields).toEqual(["storyExtract"]);
  expect(payload.auxiliaryRecovery).not.toHaveProperty("voiceGuide");
  expect(calls).toHaveLength(2);
});

it("retains a validated style check across a serialized auxiliary checkpoint", async () => {
  const first = setup("premium", [{ findings: [], pages: [{ pageIndex: 30, score: 95, storyExtract: "reuse", styleAudit: "clean" }] }]);
  const checks = { pageModelReview: true, storyExtractAudit: true, styleAuditor: true };
  const pages = first.options.pages.filter((p: { index: number }) => p.index === 30);
  let savedCheckpoint!: PictureBookReviewCheckpoint;
  await expect(reviewPictureBookManuscript({ ...first.options, pages, checks, onCheckpoint: async checkpoint => {
    if (checkpoint.roundsStarted === 1 && checkpoint.attemptsUsed === 1) {
      savedCheckpoint = JSON.parse(JSON.stringify(checkpoint)); throw new Error("durable interruption");
    }
  } })).rejects.toThrow("durable interruption");
  expect(pictureBookEditorialRowsSchema.parse(savedCheckpoint.editorialRows)[0]).toMatchObject({ styleAudit: "clean" });
  expect(savedCheckpoint.editorialRows?.[0]).not.toHaveProperty("storyExtract");
  const next = setup("premium", [{ pages: [], auxiliaryCorrections: [{ id: "page:30", storyExtract: "no_changes" }] }]);
  const reviews = await reviewPictureBookManuscript({ ...next.options, pages, checks, resume: savedCheckpoint });
  expect(reviews[0]?.styleAudit?.styleOk).toBe(true);
  expect(next.calls).toHaveLength(1);
  expect(JSON.parse(next.calls[0]!.messages[1]!.content).auxiliaryRecovery.rows[0].requiredFields).toEqual(["storyExtract"]);
});

it.each([{}, { storyExtract: "no_changes", styleAudit: { styleOk: false, styleIssues: ["Changed frozen verdict"] } },
  { storyExtract: "no_changes", score: 100 }])("rejects missing work or changes to frozen auxiliary results %#", async patch => {
  const { options, calls } = setup("premium", [
    { findings: [], pages: [{ pageIndex: 30, score: 95, storyExtract: "reuse", styleAudit: "clean" }] },
    { pages: [], auxiliaryCorrections: [{ id: "page:30", ...patch }] }
  ]);
  const error = await reviewPictureBookManuscript({ ...options, pages: options.pages.filter((p: { index: number }) => p.index === 30),
    checks: { pageModelReview: true, storyExtractAudit: true, styleAuditor: true } }).catch(e => e);
  expect(error).toBeInstanceOf(PictureBookReviewIncompleteError);
  expect(error.checkpoint.editorialRows[0]).toMatchObject({ score: 95, styleAudit: "clean" });
  expect(calls).toHaveLength(2);
});

it("keeps verified story state when only style needs recovery", async () => {
  const first = { findings: [], pages: saved.premium.pages.map((p: { index: number }) => ({ pageIndex: p.index,
    score: 95, storyExtract: "no_changes", styleAudit: p.index === 30 ? null : "clean" })) };
  const { options, calls } = setup("premium", [first, { pages: [], auxiliaryCorrections: [{ id: "page:30", styleAudit: "clean" }] }]);
  const reviews = await reviewPictureBookManuscript({ ...options, checks: { pageModelReview: true, storyExtractAudit: true, styleAuditor: true } });
  expect(reviews[29]?.storyExtract?.contradictions).toEqual([]);
  const payload = JSON.parse(calls[1]!.messages[1]!.content).auxiliaryRecovery;
  expect(payload.rows[0].requiredFields).toEqual(["styleAudit"]);
  // Style still needs the whole manuscript to judge repetition.
  expect(payload.pages).toHaveLength(30);
  expect(payload).not.toHaveProperty("reusableStoryExtractPageIndexes");
  expect(calls).toHaveLength(2);
});

it("sends only the chronological prefix when later style results already passed", async () => {
  const first = { findings: [], pages: saved.premium.pages.map((p: { index: number }) => ({ pageIndex: p.index,
    score: 95, storyExtract: p.index === 2 ? "reuse" : "no_changes", styleAudit: "clean" })) };
  const { options, calls } = setup("premium", [first, { pages: [], auxiliaryCorrections: [{ id: "page:2", storyExtract: "no_changes" }] }]);
  await reviewPictureBookManuscript({ ...options, checks: { pageModelReview: true, storyExtractAudit: true, styleAuditor: true } });
  const payload = JSON.parse(calls[1]!.messages[1]!.content).auxiliaryRecovery;
  expect(payload.pages.map((p: { index: number }) => p.index)).toEqual([1, 2]);
  expect(payload).not.toHaveProperty("voiceGuide");
  expect(calls).toHaveLength(2);
});

it("does not normalize an empty cross-page repair scope as local", async () => {
  const original = response("quick");
  original.findings[0].repairPageIndexes = [];
  const { options, calls } = setup("quick", [original, { pages: [], metadataCorrections: [] }]);
  const error = await reviewPictureBookManuscript(options).catch(e => e);
  expect(error).toBeInstanceOf(PictureBookReviewIncompleteError);
  expect(error.checkpoint.metadataRows[0].findings[0].repairPageIndexes).toEqual([]);
  expect(calls).toHaveLength(2);
});
