import { expect, it } from "vitest";
import { createProjectSchema } from "../schemas/book.js";
import { makeFallbackPlan } from "../prompting/templates.js";
import { scriptedDevelopmentModel } from "./testing/bookDevelopmentFixtures.js";
import { reviewPictureBookManuscript, PictureBookReviewIncompleteError } from "./pictureBookReview.js";
import { inputWithSelectedPageCount } from "./pageCountAllowance.js";

const input = createProjectSchema.parse({ prompt: "Rabbit found the missing lantern.", category: "KIDS", targetPages: 1 });
const pages = [{ index: 1, title: "The Light", markdown: "Rabbit found the missing lantern.", summary: "Rabbit finds it." }];
const options = { input, pages, plan: makeFallbackPlan(input), chapterBriefs: [], continuityReview: false };

it("reviews every page when a forty-page request uses its full allowance", async () => {
  const selected = inputWithSelectedPageCount({ ...input, targetPages: 40 }, 44);
  const manuscript = Array.from({ length: 44 }, (_, i) => ({ ...pages[0]!, index: i + 1 }));
  const { model, calls } = scriptedDevelopmentModel([{ findings: [], pages: manuscript.map(page => ({ pageIndex: page.index, score: 95 })) }]);
  const reviewed = await reviewPictureBookManuscript({ ...options, input: selected, pages: manuscript,
    textModel: model, checks: { pageModelReview: true, storyExtractAudit: false, styleAuditor: false } });
  expect(reviewed).toHaveLength(44);
  expect(calls).toHaveLength(1);
});

it.each([[true, false], [false, true], [false, false], [true, true]])(
  "requests only enabled auxiliary fields (story %s, style %s), storing disabled checks as null", async (story, style) => {
    const { model, calls } = scriptedDevelopmentModel([{ findings: [], pages: [{ pageIndex: 1, score: 95,
      ...(story ? { storyExtract: "no_changes" } : {}), ...(style ? { styleAudit: "clean" } : {}) }] }]);
    const reviewed = await reviewPictureBookManuscript({ ...options, textModel: model,
      checks: { pageModelReview: true, storyExtractAudit: story, styleAuditor: style } });
    const system = calls[0]!.messages.find(message => message.role === "system")!.content;
    if (!style) expect(system).not.toContain("styleAudit");
    if (!story) expect(system).not.toContain("storyExtract");
    expect(reviewed[0]!.styleAudit === null).toBe(!style);
    expect(reviewed[0]!.storyExtract === null).toBe(!story);
    expect(calls).toHaveLength(1);
  });

it("still refuses omitted enabled checks instead of normalizing them to a pass", async () => {
  const answer = { findings: [], pages: [{ pageIndex: 1, score: 95 }] };
  const { model } = scriptedDevelopmentModel([answer, answer]);
  await expect(reviewPictureBookManuscript({ ...options, textModel: model,
    checks: { pageModelReview: true, storyExtractAudit: true, styleAuditor: false } })).rejects.toBeInstanceOf(PictureBookReviewIncompleteError);
});
