import { expect, it } from "vitest";
import { createProjectSchema } from "../schemas/book.js";
import { makeFallbackPlan } from "../prompting/templates.js";
import { scriptedDevelopmentModel } from "./testing/bookDevelopmentFixtures.js";
import { reviewPictureBookManuscript } from "./pictureBookReview.js";

const input = createProjectSchema.parse({ prompt: "Rabbit waits while Turtle guides the neighbors across the brook.", category: "KIDS", targetPages: 5 });
const checks = { pageModelReview: true, storyExtractAudit: false, styleAuditor: false };
const pages = ["Rabbit found the lantern deep inside the stump.", "Tilting its lid made the lantern rise into his paws.",
  "Rabbit counted fireflies while Turtle brought the neighbors across.", "Back at the brook, the neighbors crossed one at a time.", "Rabbit joined them for their picnic."]
  .map((markdown, i) => ({ index: i + 1, title: `Scene ${i + 1}`, markdown, summary: markdown }));
const rows = () => ({ pages: pages.map(page => ({ pageIndex: page.index, score: 96, findings: [], storyExtract: null, styleAudit: null })) });
const finding = { domain: "prose", basis: "page_prose", requirementQuote: null, category: "continuity", message: "The lid cannot lift the lantern.",
  guidance: "Use a twig to reach the handle.", quote: pages[1]!.markdown, relatedEvidence: [] };

it("carries verified prior verdicts and exact changed pages into the existing candidate review", async () => {
  const original = rows();
  Object.assign(original.pages[1]!, { findings: [finding] });
  const { model } = scriptedDevelopmentModel([original]);
  const options = { input, plan: makeFallbackPlan(input), pages, chapterBriefs: [], checks, textModel: model };
  const previous = await reviewPictureBookManuscript(options);
  const candidate = pages.map(page => page.index === 2 ? { ...page, markdown: "Rabbit lifted the lid and used a twig to raise the lantern." } : page);
  const answer = rows();
  Object.assign(answer.pages[1]!, { repairAssessment: { targetResolved: true, meaningPreserved: true, noNewRegressions: true, reason: "The twig reaches the handle." } });
  const next = scriptedDevelopmentModel([answer]);
  await reviewPictureBookManuscript({ ...options, pages: candidate, textModel: next.model,
    previousReview: { pages, reviews: previous },
    repairContext: { issues: [{ pageIndexes: [2], messages: [finding.message] }], changes: [{ pageIndex: 2, originalMarkdown: pages[1]!.markdown, reason: finding.message }] }
  } as Parameters<typeof reviewPictureBookManuscript>[0]);
  const payload = JSON.parse(next.calls[0]!.messages.find(message => message.role === "user")!.content);
  expect(payload.previousEditorialReview).toMatchObject({ changedPageIndexes: [2], unchangedCleanPageIndexes: [1, 3, 4, 5], findings: [{ pageIndex: 2, message: finding.message }] });
  expect(next.calls).toHaveLength(1);
});

it("never reuses a prior clean verdict to suppress a real current defect", async () => {
  const initial = scriptedDevelopmentModel([rows()]);
  const options = { input, plan: makeFallbackPlan(input), pages, chapterBriefs: [], checks, textModel: initial.model };
  const previous = await reviewPictureBookManuscript(options);
  const answer = rows();
  Object.assign(answer.pages[1]!, { findings: [finding] });
  const next = scriptedDevelopmentModel([answer]);
  const reviewed = await reviewPictureBookManuscript({ ...options, textModel: next.model, previousReview: { pages, reviews: previous } });
  expect(reviewed[1]!.report.approved).toBe(false);
  expect(reviewed[1]!.report.issues[0]).toContain(finding.message);
  expect(next.calls).toHaveLength(1);
});

it("excludes stale, duplicate and unverified prior verdicts from the clean-page history", async () => {
  const initial = scriptedDevelopmentModel([rows()]);
  const options = { input, plan: makeFallbackPlan(input), pages, chapterBriefs: [], checks, textModel: initial.model };
  const previous = await reviewPictureBookManuscript(options);
  previous[0]!.draftMarkdown = "A different manuscript.";
  previous.push(previous[1]!);
  previous[2]!.unverifiedFindings = [{ ...finding, domain: "prose", basis: "page_prose", category: "continuity" }];
  const next = scriptedDevelopmentModel([rows()]);
  await reviewPictureBookManuscript({ ...options, textModel: next.model, previousReview: { pages, reviews: previous } });
  const payload = JSON.parse(next.calls[0]!.messages.find(message => message.role === "user")!.content);
  expect(payload.previousEditorialReview.unchangedCleanPageIndexes).toEqual([4, 5]);
});
