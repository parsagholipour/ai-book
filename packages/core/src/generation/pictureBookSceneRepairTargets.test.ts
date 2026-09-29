import { expect, it } from "vitest";
import { createProjectSchema } from "../schemas/book.js";
import { makeFallbackPlan } from "../prompting/templates.js";
import { pictureBookPageReview, validatedPictureBookReviewRow, type PictureBookPageReview } from "./pictureBookReviewValidation.js";
import { pictureBookSceneRepairTargets } from "./pictureBookSceneRepairTargets.js";
import { pictureBookRepairPageScopes, repairPictureBookManuscript } from "./pictureBookRepair.js";
import { reviewPictureBookManuscript } from "./pictureBookReview.js";
import { scriptedDevelopmentModel } from "./testing/bookDevelopmentFixtures.js";

const input = createProjectSchema.parse({ prompt: "Rabbit and Turtle restore the lanterns together.", category: "KIDS", targetPages: 5,
  mediaSettings: { audienceAgeRange: "6-8" } });
const plan = makeFallbackPlan(input);
const pages = ["Rabbit and Turtle followed the path.", "Rabbit hung the fern lantern on its hook.",
  "Turtle hung the stone lantern on its hook.", "They walked toward the willow together.", "They reached the clearing before moonrise."]
  .map((markdown, i) => ({ index: i + 1, title: `Scene ${i + 1}`, markdown, summary: markdown }));
const checks = { pageModelReview: true, storyExtractAudit: false, styleAuditor: false };
const finding = { domain: "prose" as const, basis: "cross_page" as const, requirementQuote: null, category: "progression" as const,
  message: "Pages 2–3 split two simple restorations without a new discovery.",
  guidance: "Combine the connected page 2–3 interval into one scene: restore both lanterns and continue toward the willow.",
  quote: pages[2]!.markdown, relatedEvidence: [{ pageIndex: 2, quote: pages[1]!.markdown }, { pageIndex: 5, quote: pages[4]!.markdown }] };
const row = { pageIndex: 3, score: 85, findings: [finding], storyExtract: null, styleAudit: null };
const review = (): PictureBookPageReview => pictureBookPageReview(row, pages[2]!, checks, input.prompt);
const byPage = new Map(pages.map(page => [page.index, page]));
const schema = validatedPictureBookReviewRow({ input, checks, pages: byPage });
const syntax = "Sentences are too long for ages 6-8 (average 14 words, longest 20; target average <= 12, longest <= 22).";
const issues = [{ pageIndexes: [2, 3, 4, 5], messages: [2, 4, 5].map(index => `Page ${index}: ${syntax}`).concat(`Page 3: ${finding.guidance}`) }];
const scene = { reason: "Combine the connected restorations and advance toward the willow.", pages: [
  { pageIndex: 2, markdown: "Rabbit hung the fern lantern. Turtle restored the stone light beside it.", summary: "Both lights mark the trail." },
  { pageIndex: 3, markdown: "Two lights shone behind them as they turned toward the willow.", summary: "They continue their search." }
] };

it("preserves explicit repair intervals through model review, scope selection, repair and acceptance context", async () => {
  const { model, calls } = scriptedDevelopmentModel([{ findings: [{ ...finding, pageIndex: 3, repairPageIndexes: [2, 3] }],
    pages: pages.map(page => ({ pageIndex: page.index, score: 85, storyExtract: null, styleAudit: null })) },
  { pages: [], sceneRevisions: [scene] }]);
  const reviews = await reviewPictureBookManuscript({ input, plan, pages, checks, chapterBriefs: [], continuityReview: false, textModel: model });
  expect(reviews[2]!.findings?.[0]?.repairPageIndexes).toEqual([2, 3]);
  const sceneRepairTargets = pictureBookSceneRepairTargets(pages, reviews);
  expect(sceneRepairTargets).toEqual([{ pageIndex: 3, pageIndexes: [2, 3] }]);
  const candidate = await repairPictureBookManuscript({ input, plan, pages, issues, sceneRepairTargets, textModel: model });
  expect(candidate.context).toMatchObject({ sceneRepairTargets, sentenceOnlyPageIndexes: [4, 5],
    sceneRevisions: [{ pageIndexes: [2, 3], reason: scene.reason }] });
  const payload = JSON.parse(calls[1]!.messages[1]!.content);
  expect(payload.semanticTargetPageIndexes).toEqual([2, 3]);
  expect(payload.sentenceRepairs.map((page: { pageIndex: number }) => page.pageIndex)).toEqual([4, 5]);
});

it("recovers a grounded legacy interval without expanding to other supporting citations", () => {
  expect(pictureBookSceneRepairTargets(pages, [review()])).toEqual([{ pageIndex: 3, pageIndexes: [2, 3] }]);
});

it.each([[3, 2], [2, 2, 3], [1, 3], [1, 2], [2, 3, 4], [2, 3, 4, 5, 6], [2]])(
  "rejects an invalid, unowned or ungrounded explicit interval %j", (...repairPageIndexes) => {
    const invalid = { ...finding, repairPageIndexes };
    expect(schema.safeParse({ ...row, findings: [invalid] }).success).toBe(false);
    expect(pictureBookSceneRepairTargets(pages, [{ ...review(), findings: [invalid] }])).toEqual([]);
  });

it.each([
  { guidance: "Check the relationship between pages 2–3." },
  { guidance: "Preserve the scene on pages 2–3; split the long sentence only." },
  { guidance: "Combine the connected page 2–40 interval into one scene." },
  { relatedEvidence: [{ pageIndex: 5, quote: pages[4]!.markdown }] },
  { quote: "This invented sentence does not occur in the book." },
  { domain: "deferred_media" as const },
  { basis: "page_prose" as const },
  { category: "language" as const }
])("does not infer scope from arbitrary mentions, missing evidence or non-scene findings %#", change => {
  expect(pictureBookSceneRepairTargets(pages, [{ ...review(), findings: [{ ...finding, ...change }] }])).toEqual([]);
});

it("does not unlock pages from stale, disabled or unverified review findings", () => {
  expect(pictureBookSceneRepairTargets(pages, [{ ...review(), draftMarkdown: "Stale prose." }])).toEqual([]);
  expect(pictureBookSceneRepairTargets(pages, [{ ...review(), completedChecks: { ...checks, pageModelReview: false } }])).toEqual([]);
  expect(pictureBookSceneRepairTargets(pages, [{ ...review(), findings: [], unverifiedFindings: [finding] }])).toEqual([]);
});

it("rejects a connected rewrite extending into an unrelated sentence-only target, including after feedback", async () => {
  const sceneRepairTargets = pictureBookSceneRepairTargets(pages, [review()]);
  const { model } = scriptedDevelopmentModel([{ pages: [], sceneRevisions: [{ ...scene,
    pages: [...scene.pages, { pageIndex: 4, markdown: "Rabbit suddenly chose a different adventure.", summary: "A new scene." }] }] }]);
  await expect(repairPictureBookManuscript({ input, plan, pages, issues, sceneRepairTargets, textModel: model,
    feedback: { phase: "semantic", candidatePages: [], failures: [{ pageIndex: 4, issues: ["Rewrite pages 2–4 together."] }] }
  })).rejects.toThrow(/cannot rewrite sentence-only page 4/);
});

it("requires an existing semantic owner before an interval can override sentence-only protection", () => {
  expect(() => pictureBookRepairPageScopes({ input, pages, issues: [{ pageIndexes: [3], messages: [syntax] }],
    sceneRepairTargets: [{ pageIndex: 3, pageIndexes: [2, 3] }] })).toThrow(/original semantic target/);
});
