import { expect, it } from "vitest";
import { bookPlanSchema, createProjectSchema } from "../schemas/book.js";
import { repairPictureBookManuscript } from "./pictureBookRepair.js";
import { pictureBookReviewMessages } from "./pictureBookReviewPrompt.js";
import { pictureBookRepairPageScopes } from "./pictureBookRepairScope.js";
import { scriptedDevelopmentModel } from "./testing/bookDevelopmentFixtures.js";
import captured from "./testing/repairScope0338.json" with { type: "json" };

const input = createProjectSchema.parse(captured.input), plan = bookPlanSchema.parse(captured.plan);
const options = { input, plan, pages: captured.pages, issues: captured.issues };
const original = captured.pages[4]!;
const sentence = "Wise Turtle counted the three dark posts, walked a few paces down the path to check the nearest one, then returned and counted again.";
const safe = { pageIndex: 5, summary: null, reason: "Split the long sentence without removing Turtle's costly overchecking.",
  patches: [{ find: sentence, replace: "Wise Turtle counted the three dark posts. He walked a few paces down the path to check the nearest one. Then he returned and counted again." }] };

it("rejects the captured mixed repair that rewrites the sentence-only page's scene and summary", async () => {
  const { model } = scriptedDevelopmentModel([captured.patch]);
  await expect(repairPictureBookManuscript({ ...options, textModel: model })).rejects.toThrow(/sentence-only.*page 5/i);
});

it("keeps sentence scope per page through mixed drafting and candidate review", async () => {
  const { model, calls } = scriptedDevelopmentModel([{ pages: [safe, captured.patch.pages.find(p => p.pageIndex === 17)!] }]);
  const candidate = await repairPictureBookManuscript({ ...options, textModel: model });
  expect(candidate.context).toMatchObject({ sentenceOnlyPageIndexes: [5, 10, 13, 21, 30] });
  expect(candidate.context.sentenceOnly).toBeUndefined();
  expect(candidate.pages[4]!.summary).toBe(original.summary);
  expect(candidate.pages[4]!.markdown).toContain("Then he returned and counted again. The repeated checks took more minutes.");
  const payload = JSON.parse(calls[0]!.messages.at(-1)!.content);
  expect(payload.sentenceRepairs.find((p: { pageIndex: number }) => p.pageIndex === 5).eligibleSentences).toContain(sentence);
  const review = pictureBookReviewMessages({ ...options, pages: candidate.pages, textModel: model, chapterBriefs: [],
    checks: { pageModelReview: true, storyExtractAudit: false, styleAuditor: false }, repairContext: candidate.context }, [5, 17], []);
  expect(JSON.parse(review[1]!.content).repairContext.sentenceOnlyPageIndexes).toEqual([5, 10, 13, 21, 30]);
  expect(review[0]!.content).toContain("sentenceOnlyPageIndexes");
});

it("rejects removing a protected short sentence even when the summary is unchanged", async () => {
  const { model } = scriptedDevelopmentModel([{ pages: [{ ...safe, patches: [{ find: "The repeated checks took more minutes.", replace: "" }] }] }]);
  await expect(repairPictureBookManuscript({ ...options, textModel: model })).rejects.toThrow(/sentence-only.*page 5/i);
});

it("allows a wider exact anchor when the actual edit only splits the eligible sentence", async () => {
  const { model } = scriptedDevelopmentModel([{ pages: [{ ...safe, patches: [{ find: original.markdown,
    replace: original.markdown.replace(sentence, safe.patches[0]!.replace) }] }] }]);
  const candidate = await repairPictureBookManuscript({ ...options, textModel: model });
  expect(candidate.pages[4]!.markdown).toBe(original.markdown.replace(sentence, safe.patches[0]!.replace));
});

it("does not widen original sentence scope when rejected-candidate feedback asks to relocate a character beat", async () => {
  const { model } = scriptedDevelopmentModel([captured.patch]);
  await expect(repairPictureBookManuscript({ ...options, textModel: model, feedback: { phase: "semantic",
    candidatePages: [{ index: 5, markdown: "Turtle has no costly limitation." }],
    failures: [{ pageIndex: 5, issues: ["Move Turtle's costly overchecking to page 2."] }] }
  })).rejects.toThrow(/sentence-only.*page 5/i);
});

it("blocks summary-only drift on a sentence target even when the prose patch is unchanged", async () => {
  const { model } = scriptedDevelopmentModel([{ pages: [{ ...safe, summary: "Turtle never wastes time.",
    patches: [{ find: sentence, replace: sentence }] }] }]);
  await expect(repairPictureBookManuscript({ ...options, textModel: model })).rejects.toThrow(/original summary/i);
});

it("distinguishes primary page labels from related evidence and honors explicit story obligations", () => {
  const syntax = captured.issues.flatMap(issue => issue.messages).find(message => /^Page 5: .*Sentences are too long/u.test(message))!;
  expect(syntax).toBeTruthy();
  const issues = [{ pageIndexes: [5, 17], messages: [syntax] }];
  expect(pictureBookRepairPageScopes({ ...options, issues })).toEqual([{ pageIndex: 5, sentenceOnly: true }]);
  expect(pictureBookRepairPageScopes({ ...options, issues, requirementTargets: [{ pageIndex: 5 }] }))
    .toEqual([{ pageIndex: 5, sentenceOnly: false }]);
  expect(pictureBookRepairPageScopes({ ...options, issues: [...issues,
    { pageIndexes: [5, 17], messages: ["Reconcile the linked story events."] }] }))
    .toEqual([{ pageIndex: 5, sentenceOnly: false }, { pageIndex: 17, sentenceOnly: false }]);
});
