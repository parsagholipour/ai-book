import { expect, it } from "vitest";
import { createProjectSchema } from "../schemas/book.js";
import { makeFallbackPlan } from "../prompting/templates.js";
import { repairPictureBookManuscript } from "./pictureBookRepair.js";
import { pictureBookReviewMessages } from "./pictureBookReviewPrompt.js";
import { scriptedDevelopmentModel } from "./testing/bookDevelopmentFixtures.js";
import { compactPictureBookRepairIssues } from "./pictureBookRepairPayload.js";

const input = createProjectSchema.parse({ prompt: "Rabbit and Turtle restore the lantern path.", category: "KIDS", targetPages: 5 });
const plan = makeFallbackPlan(input);
const pages = [{ index: 1, title: "A Light", markdown: "Rabbit hung the glowing lantern. He waved to Turtle.", summary: "A lantern glows." }];
const issues = [
  { pageIndexes: [1, 2], messages: ["Page 1: The lantern glows before its lighting.", "Page 1: Keep it dark until lighting."] },
  { pageIndexes: [1], messages: ["The lantern glows before its lighting.", "Fix: Keep it dark until lighting."] }
];
const patch = { pages: [{ pageIndex: 1, reason: "Lighting happens later.", summary: null,
  patches: [{ find: "the glowing lantern", replace: "the dark lantern" }] }] };

it("sends duplicate diagnostics once in both repair and candidate review, preserving the frozen context", async () => {
  const original = structuredClone(issues);
  const { model, calls } = scriptedDevelopmentModel([patch]);
  const candidate = await repairPictureBookManuscript({ input, plan, pages, issues, textModel: model });
  const payload = JSON.parse(calls[0]!.messages.at(-1)!.content);
  expect(payload.issues).toEqual([issues[0]]);
  expect(payload.pages).toEqual(pages);
  expect(candidate.context.issues).toEqual(original);
  expect(issues).toEqual(original);
  expect(candidate.pages[0]!.markdown).toBe("Rabbit hung the dark lantern. He waved to Turtle.");
  const messages = pictureBookReviewMessages({ input, plan, pages: candidate.pages, chapterBriefs: [], textModel: model,
    checks: { pageModelReview: true, storyExtractAudit: false, styleAuditor: false }, repairContext: candidate.context }, [1], []);
  const review = JSON.parse(messages[1]!.content);
  expect(review.repairContext.issues).toEqual([issues[0]]);
  expect(review.repairContext.changes).toEqual(candidate.context.changes);
  expect(review.pages[0].markdown).toBe(candidate.pages[0]!.markdown);
  expect(messages[0]!.content).toContain("For EVERY changed page");
  expect(calls).toHaveLength(1);
});

it("omits undeclared page metadata without truncating prose or summary", async () => {
  const { model, calls } = scriptedDevelopmentModel([{ pages: [] }]);
  const storedPages = pages.map(page => ({ ...page, qualityReport: { hugeDiagnostic: "x".repeat(20_000) }, id: "db-row" }));
  await repairPictureBookManuscript({ input, plan, pages: storedPages, issues, textModel: model });
  expect(JSON.parse(calls[0]!.messages.at(-1)!.content).pages).toEqual(pages);
});

it("preserves different pages, conflicting advice, ambiguous scopes, and quotation bytes", async () => {
  const independent = [
    { pageIndexes: [1], messages: ["Keep it dark.", "Make it bright."] },
    { pageIndexes: [2], messages: ["Keep it dark."] },
    { pageIndexes: [1, 2], messages: ["Keep it dark."] },
    { pageIndexes: [1], messages: ["Evidence: “Fix: Keep it dark.”", "Page 2: Keep it dark."] }
  ];
  const { model, calls } = scriptedDevelopmentModel([{ pages: [] }]);
  await repairPictureBookManuscript({ input, plan, pages, issues: independent, textModel: model });
  expect(JSON.parse(calls[0]!.messages.at(-1)!.content).issues).toEqual(independent);
});

it("removes only exact diagnostic wrappers, works in either order, and is idempotent", () => {
  const variants = [
    { pageIndexes: [1], messages: ["Keep it dark.", "Fix: Keep it dark.", "Page 1: Keep it dark."] },
    { pageIndexes: [1, 2], messages: ["Page 1: Keep it dark.", "Keep it dark.", "Keep it dark!"] }
  ];
  for (const ordered of [variants, [...variants].reverse()]) {
    const compact = compactPictureBookRepairIssues(ordered);
    expect(compact.flatMap(issue => issue.messages)).toHaveLength(3);
    expect(compact.flatMap(issue => issue.messages)).toContain("Keep it dark!");
    expect(compactPictureBookRepairIssues(compact)).toEqual(compact);
  }
});
