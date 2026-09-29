import { readFileSync } from "node:fs";
import { expect, it, vi } from "vitest";
import { createProjectSchema, FakeTextModelAdapter, makeFallbackPlan, PictureBookReviewIncompleteError,
  pictureBookReviewFingerprint, pictureBookSceneRepairTargets, reviewPictureBookManuscript } from "@book-maker/core";
vi.mock("@book-maker/db", () => ({ prisma: {} }));
import { readPictureBookDeliverySnapshot, readPictureBookReviewSnapshot } from "./shortPictureBookReviewCache.js";

const captured = JSON.parse(readFileSync(new URL("../../../../packages/core/src/generation/testing/quickCitationScopeRecovery.json", import.meta.url), "utf8"));

it.each([false, true])("delivers Quick's exhausted citation-and-scope review as unverified without authorizing repairs (auxiliary error=%s)", async auxiliaryError => {
  const input = createProjectSchema.parse({ prompt: captured.brief, category: "KIDS", targetPages: 30 });
  const context = { input, plan: makeFallbackPlan(input), pages: captured.pages, checks: captured.checks };
  const textModel = new FakeTextModelAdapter();
  const response = structuredClone(captured.response);
  if (auxiliaryError) response.pages.find((page: { pageIndex: number }) => page.pageIndex === 23).storyExtract = {};
  const answers = [response, captured.recoveryResponse];
  let calls = 0;
  textModel.generateJson = async request => {
    const answer = answers[calls++];
    if (!answer) throw new Error("Unexpected model call in offline replay");
    const data = request.schema.parse(structuredClone(answer));
    return { data, text: JSON.stringify(data), provider: "fake", model: "captured" };
  };
  const result = await reviewPictureBookManuscript({ ...context, chapterBriefs: [], continuityReview: false, textModel }).catch((error: unknown) => error);
  expect(result).toBeInstanceOf(PictureBookReviewIncompleteError);
  if (!(result instanceof PictureBookReviewIncompleteError)) throw new Error("Expected an incomplete review");
  const snapshot = JSON.parse(JSON.stringify({ ...result.checkpoint, deliveryFallback: true, fingerprint: pictureBookReviewFingerprint(context) }));
  expect(readPictureBookReviewSnapshot(snapshot, context)).toBeUndefined();
  const delivered = readPictureBookDeliverySnapshot(snapshot, context)!;
  expect(delivered).toHaveLength(30);
  const { pageIndex, ...finding } = captured.response.findings[1];
  const page = delivered.find(review => review.pageIndex === pageIndex)!;
  expect(page).toMatchObject({ reviewUnavailable: true,
    report: { approved: false, scoreBasis: "screened_unscored", issues: [], requiredRevisions: [] } });
  if (auxiliaryError) expect(page.report.notes).toContain(finding.message);
  else expect(page.unverifiedFindings).toEqual([finding]);
  expect(pictureBookSceneRepairTargets(context.pages, [page])).toEqual([]);
  expect(delivered.find(review => review.pageIndex === 20)?.findings).toHaveLength(1);
  expect(calls).toBe(2);
});
