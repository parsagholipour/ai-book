import { expect, it } from "vitest";
import { createProjectSchema } from "../schemas/book.js";
import { makeFallbackPlan } from "../prompting/templates.js";
import { scriptedDevelopmentModel } from "./testing/bookDevelopmentFixtures.js";
import { PictureBookReviewIncompleteError, reviewPictureBookManuscript } from "./pictureBookReview.js";
import { distributePictureBookFindings, pictureBookFindingsFirstSchema } from "./pictureBookReviewFindings.js";

const input = createProjectSchema.parse({ prompt: "Rabbit and Turtle work together without repeated preparation.", category: "KIDS", targetPages: 5 });
const pages = ["Rabbit asked to lift the lantern.", "Turtle agreed to lift the lantern.", "Rabbit and Turtle prepared to lift the lantern.", "Together they lifted the lantern.", "They shared its light with a friend."]
  .map((markdown, i) => ({ index: i + 1, title: `Scene ${i + 1}`, markdown, summary: markdown }));
const finding = { pageIndex: 1, domain: "prose", basis: "cross_page", requirementQuote: null, category: "progression",
  message: "Pages 1–4 spread one uncomplicated lift across permission and preparation.", guidance: "Combine asking and lifting in pages 1–2; develop the consequence of sharing the light in pages 3–4.",
  quote: pages[0]!.markdown, relatedEvidence: [{ pageIndex: 3, quote: pages[2]!.markdown }] };
const answer = () => ({ findings: [structuredClone(finding)], pages: pages.map(page => ({ pageIndex: page.index, score: 94, storyExtract: null, styleAudit: null })) });
const options = { input, plan: makeFallbackPlan(input), pages, chapterBriefs: [], checks: { pageModelReview: true, storyExtractAudit: false, styleAuditor: false } };

it("settles whole-scene findings before page verdicts and keeps the existing repair evidence contract", async () => {
  const { model, calls } = scriptedDevelopmentModel([answer()]);
  const reviewed = await reviewPictureBookManuscript({ ...options, textModel: model });
  expect(Object.keys(pictureBookFindingsFirstSchema(false).shape)).toEqual(["findings", "pages"]);
  expect(reviewed[0]!.report.approved).toBe(false);
  expect(reviewed[0]!.report.requiredRevisions).toContain(finding.guidance);
  expect(reviewed[0]!.report.issues[0]).toContain(pages[2]!.markdown);
  expect(reviewed.slice(1).every(page => page.report.approved)).toBe(true);
  expect(calls).toHaveLength(1);
});

it.each([0, 40, undefined])("does not discard an unowned finding at page %s to accept the clean rows", async pageIndex => {
  const response = answer();
  Object.assign(response.findings[0]!, { pageIndex });
  const { model } = scriptedDevelopmentModel([response, response]);
  await expect(reviewPictureBookManuscript({ ...options, textModel: model })).rejects.toBeInstanceOf(PictureBookReviewIncompleteError);
});

it("refuses conflicting flat and nested diagnoses rather than dropping one silently", () => {
  const raw = answer();
  Object.assign(raw.pages[0]!, { findings: [{ ...finding, message: "A different diagnosis." }] });
  expect(distributePictureBookFindings(raw).protocolIssues).toHaveLength(1);
});

it("retains a whole-scene finding while recovering only its malformed auxiliary check", async () => {
  const first = answer();
  first.pages.forEach(page => Object.assign(page, { styleAudit: "clean" }));
  Object.assign(first.pages[0]!, { styleAudit: { malformed: true } });
  const retry = { findings: [], pages: [{ ...first.pages[0]!, styleAudit: "clean", score: 100 }] };
  const { model, calls } = scriptedDevelopmentModel([first, retry]);
  const reviewed = await reviewPictureBookManuscript({ ...options, textModel: model,
    checks: { ...options.checks, styleAuditor: true } });
  const request = JSON.parse(calls[1]!.messages.find(message => message.role === "user")!.content);
  expect(request.reviewPageIndexes).toEqual([1]);
  expect(request.retainedEditorialAssessments[0].findings[0].guidance).toBe(finding.guidance);
  expect(reviewed[0]!.report).toMatchObject({ approved: false, score: 94, requiredRevisions: [finding.guidance] });
  expect(reviewed[0]!.completedChecks.styleAuditor).toBe(true);
  expect(reviewed.slice(1).every(page => page.report.approved)).toBe(true);
  expect(calls).toHaveLength(2);
});
