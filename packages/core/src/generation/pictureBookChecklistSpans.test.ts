import { expect, it } from "vitest";
import { pictureBookChecklistSpans } from "./pictureBookChecklistSpans.js";
import { pictureBookExactQuote } from "./pictureBookExactQuote.js";
import { pictureBookAuxiliaryRecovery } from "./pictureBookReviewAuxiliary.js";
import { createProjectSchema } from "../schemas/book.js";
import { makeFallbackPlan } from "../prompting/templates.js";
import { FakeTextModelAdapter } from "../adapters/fake.js";

it.each([
  '“There!” Rabbit said.\n\nThe leaves smelled damp.  The leaves smelled damp.',
  '«سلام!» گفت.\n🐢 خرگوش رفت.\n',
  'a'.repeat(299) + '🐢' + 'b'.repeat(400) + '\n\nThe end.'
])("indexes every source byte exactly once, with bounded witnesses", markdown => {
  const spans = pictureBookChecklistSpans({ index: 4, markdown });
  expect(Object.values(spans).join("")).toBe(markdown);
  expect(Object.values(spans).every(span => span.length <= 300 && decodeURIComponent(encodeURIComponent(span)) === span)).toBe(true);
  expect(pictureBookChecklistSpans({ index: 4, markdown })).toEqual(spans);
});

it.each([
  ['Rabbit hung the lantern there instead.', '“Rabbit hung it there instead.”'],
  ['Call when you find anything. Call when you find anything.', '“Call when you find anything.”'],
  ['Call when you find anything.', 'The text says “Call when you find anything.”']
])("never guesses a paraphrased, ambiguous, or annotated quotation", (markdown, quote) => {
  expect(pictureBookExactQuote(markdown, quote)).toBeUndefined();
});

it.each([[false, false, [2]], [true, false, [1, 2]], [false, true, [1, 2, 3]]])(
  "sends only auxiliary dependencies (story %s, style %s)", (story, style, expected) => {
    const input = createProjectSchema.parse({ category: "KIDS", targetPages: 3, prompt: "Every page has natural dialogue." });
    const plan = { ...makeFallbackPlan(input), requirementInventory: { version: 1 as const, status: "available" as const, complete: true,
      brief: input.prompt, requirements: [{ text: "natural dialogue", quote: "natural dialogue", kind: "content" as const,
        scope: { extent: "each_page" as const, quote: input.prompt } }] } };
    const pages = [1, 2, 3].map(index => ({ index, title: "The Wall", summary: "They wait.", markdown: '“Wait!” Rabbit called.' }));
    const recovery = pictureBookAuxiliaryRecovery([{ pageIndex: 2, score: 95, findings: [] }], {
      input, plan, pages, chapterBriefs: [], checks: { pageModelReview: true, storyExtractAudit: Boolean(story), styleAuditor: Boolean(style) },
      textModel: new FakeTextModelAdapter()
    });
    expect(recovery.payload.pages.map(page => page.index)).toEqual(expected);
  }
);
