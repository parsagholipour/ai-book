import { expect, it } from "vitest";
import { createProjectSchema } from "../schemas/book.js";
import { makeFallbackPlan } from "../prompting/templates.js";
import { scriptedDevelopmentModel } from "./testing/bookDevelopmentFixtures.js";
import { repairPictureBookManuscript } from "./pictureBookRepair.js";
import { pictureBookReviewMessages } from "./pictureBookReviewPrompt.js";

const input = createProjectSchema.parse({ prompt: "Rabbit and Turtle help each other cross the brook.", category: "KIDS", targetPages: 5, mediaSettings: { audienceAgeRange: "6-8" } });
const plan = makeFallbackPlan(input);
const pages = ["Rabbit reached the brook.", "Rabbit asked Turtle to help. Turtle agreed.",
  "Turtle said he was ready. Rabbit got ready to cross.", "Rabbit crossed with Turtle's help.", "They shared berries on the far bank."]
  .map((markdown, i) => ({ index: i + 1, title: `Moment ${i + 1}`, markdown, summary: markdown }));
const issues = [{ pageIndexes: [3], messages: ["Pages 2–4 stretch one crossing across asking, readiness and execution; combine the action and develop its consequence."] }];
const scene = { reason: "Combine readiness with crossing and develop Rabbit's choice to help in return.", pages: [
  { pageIndex: 2, markdown: "Turtle braced the branch. Rabbit crossed above the chattering water.", summary: "Rabbit crosses with help." },
  { pageIndex: 3, title: "A Friend Needs Help", markdown: "On the far bank, Rabbit saw Turtle searching for a foothold.", summary: "Rabbit notices Turtle's difficulty." },
  { pageIndex: 4, markdown: "Rabbit held out the branch. This time, Turtle leaned on Rabbit.", summary: "Rabbit helps Turtle cross." }
] };

it("atomically replaces a sequence, preserves its slots and supplies the whole revision to acceptance review", async () => {
  const original = structuredClone(pages);
  const { model, calls } = scriptedDevelopmentModel([{ pages: [], sceneRevisions: [scene] }]);
  const candidate = await repairPictureBookManuscript({ input, plan, pages, issues, textModel: model });
  expect(calls).toHaveLength(1);
  expect(candidate.pages.map(page => page.index)).toEqual([1, 2, 3, 4, 5]);
  expect(candidate.pages[2]!.title).toBe("A Friend Needs Help");
  expect(candidate.pages[1]!.title).toBe(pages[1]!.title);
  expect(candidate.context.changes.find(change => change.pageIndex === 3)?.originalTitle).toBe(pages[2]!.title);
  expect(candidate.pages.slice(1, 4).map(page => page.markdown)).toEqual(scene.pages.map(page => page.markdown));
  expect(candidate.pages[0]).toEqual(pages[0]);
  expect(candidate.pages[4]).toEqual(pages[4]);
  expect(pages).toEqual(original);
  expect(candidate.context.sceneRevisions).toEqual([{ pageIndexes: [2, 3, 4], reason: scene.reason }]);
  expect(candidate.context.changes.map(change => change.originalMarkdown)).toEqual(pages.slice(1, 4).map(page => page.markdown));
  const review = pictureBookReviewMessages({ input, plan, pages: candidate.pages, textModel: model, chapterBriefs: [],
    checks: { pageModelReview: true, storyExtractAudit: false, styleAuditor: false }, repairContext: candidate.context }, [1, 2, 3, 4, 5], []);
  expect(JSON.parse(review[1]!.content).repairContext.sceneRevisions).toEqual(candidate.context.sceneRevisions);
  expect(review[0]!.content).toContain("across the COMPLETE revised sequence");
});

it.each([
  [scene.pages[0]!, scene.pages[2]!],
  [...scene.pages].reverse(),
  [scene.pages[0]!, scene.pages[0]!],
  [scene.pages[0]!, { ...scene.pages[1]!, pageIndex: 99 }]
])("rejects missing, reordered, duplicate or unknown slots before returning any candidate", async (...replacement) => {
  const { model } = scriptedDevelopmentModel([{ pages: [], sceneRevisions: [{ ...scene, pages: replacement }] }]);
  await expect(repairPictureBookManuscript({ input, plan, pages, issues, textModel: model })).rejects.toThrow(/scene revision/);
});

it("rejects overlaps between an exact patch and a scene replacement", async () => {
  const { model } = scriptedDevelopmentModel([{ pages: [{ pageIndex: 2, summary: null, reason: "Overlap",
    patches: [{ find: "agreed", replace: "nodded" }] }], sceneRevisions: [scene] }]);
  await expect(repairPictureBookManuscript({ input, plan, pages, issues, textModel: model })).rejects.toThrow(/duplicate page/);
});

it("cannot turn a sentence-only target into a scene rewrite", async () => {
  const { model } = scriptedDevelopmentModel([{ pages: [], sceneRevisions: [scene] }]);
  await expect(repairPictureBookManuscript({ input, plan, pages, textModel: model,
    issues: [{ pageIndexes: [2], messages: ["Sentences are too long for ages 6-8 (average 14 words, longest 20; target average <= 12, longest <= 18)."] }] })).rejects.toThrow(/original semantic repair target/);
});
