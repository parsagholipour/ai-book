import { expect, it } from "vitest";
import { reviewManuscriptCoverage } from "./manuscriptCoverage.js";
import { scriptedDevelopmentModel } from "./testing/bookDevelopmentFixtures.js";
import { coverageCitationResolver } from "./manuscriptCoverageCitations.js";

const brief = "Keep the path problem gentle and understandable.";
const quote = "A shallow dip cuts across the slope ahead.";
async function review(pages: { index: number; markdown: string }[], evidence = [{ pageIndex: 14, quote }], correctionAttempt = false) {
  const { model, calls } = scriptedDevelopmentModel([
    { complete: true, requirements: [{ text: brief, quote: brief, kind: "content" }] },
    { complete: true, requirements: [{ id: "brief-1", status: "fulfilled", reason: "The path obstacle is gentle.", evidence }] },
    ...(correctionAttempt ? [{ corrections: [{ id: "citation-1", supportsSameClaim: false, quote: null }] }] : [])
  ]);
  const result = await reviewManuscriptCoverage({ brief, promises: [], pages, textModel: model });
  expect(calls).toHaveLength(correctionAttempt ? 3 : 2);
  return result;
}

it("relocates the Balanced citation to its unique exact manuscript page without a model retry", async () => {
  const result = await review([{ index: 13, markdown: quote }, { index: 14, markdown: "They walked around the dip." }]);
  expect(result.status).toBe("reviewed");
  expect(result.requirements[0]?.evidence).toEqual([{ pageIndex: 13, quote }]);
});

it("removes only enclosing quotation marks when Quick closes a copied dialogue excerpt early", async () => {
  const body = "Look at the grass, reeds, and tracks. They all bend away from the brook.";
  const result = await review([{ index: 17, markdown: `Wise Turtle spoke firmly. “${body} The gust pushed things that way.”` }],
    [{ pageIndex: 17, quote: `“${body}”` }]);
  expect(result.status).toBe("reviewed");
  expect(result.requirements[0]?.evidence).toEqual([{ pageIndex: 17, quote: body }]);
});

it("keeps correctly cited repeated passages unchanged", async () => {
  const result = await review([{ index: 13, markdown: quote }, { index: 14, markdown: quote }]);
  expect(result.requirements[0]?.evidence).toEqual([{ pageIndex: 14, quote }]);
  expect(result.status).toBe("reviewed");
});

it("recovers Balanced's capitalized page-2 clause locally as exact source bytes", async () => {
  const source = "the neighbors huddled beneath the old stones.";
  const result = await review([{ index: 2, markdown: `At the stone arch, ${source} They had packed berry cakes and warm soup for the night picnic.` }],
    [{ pageIndex: 2, quote: `T${source.slice(1)}` }]);
  expect(result.status).toBe("reviewed");
  expect(result.requirements[0]?.evidence).toEqual([{ pageIndex: 2, quote: source }]);
});

it("preserves original whitespace and Unicode offsets when recovering a unique same-page span", () => {
  const source = "the neighbors  huddled\nbeneath the old stones.";
  const resolve = coverageCitationResolver([{ index: 2, markdown: `🌙 At the stone arch, ${source}` }]);
  expect(resolve({ pageIndex: 2, quote: "The neighbors huddled beneath the old stones." }))
    .toEqual({ pageIndex: 2, quote: source });
});

it.each([
  ["the neighbors huddled. And the neighbors huddled.", "The neighbors huddled."],
  ["the the the the the", "The the the the"],
  ["a dog.", "A           dog."],
  ["the neighbors did not huddle.", "The neighbors did huddle."],
  ["the neighbors huddled!", "The neighbors huddled."],
  ["they visited US in spring.", "They visited us in spring."],
  ["they visited Turtle in spring.", "They visited turtle in spring."],
  ["another neighbors huddled.", "Other neighbors huddled."],
  ["the neighbors huddled beneath the trees.", "The neighbors huddled beneath the tree"],
  ["the neighbors huddled.", "“The neighbors huddled.”"],
  ["İt was a gentle night.", "it was a gentle night."]
])("refuses ambiguous spans or changes beyond whitespace and initial capitalization: %s", (markdown, quote) => {
  expect(coverageCitationResolver([{ index: 2, markdown }])({ pageIndex: 2, quote })).toBeUndefined();
});

it("does not combine normalization with page relocation or duplicate page numbering", () => {
  const quote = "The neighbors huddled beneath the old stones.";
  const page = { index: 2, markdown: `At the stone arch, t${quote.slice(1)}` };
  expect(coverageCitationResolver([page])({ pageIndex: 3, quote })).toBeUndefined();
  expect(coverageCitationResolver([page, page])({ pageIndex: 2, quote })).toBeUndefined();
});

it.each([
  [{ index: 12, markdown: quote }, { index: 13, markdown: quote }],
  [{ index: 13, markdown: "A deep ravine cuts across the slope ahead." }],
  [{ index: 13, markdown: quote }, { index: 13, markdown: "Different page with duplicate numbering." }]
].map((pages) => ({ pages })))("leaves ambiguous, paraphrased and duplicate-page citations unverified", async ({ pages }) => {
  expect((await review(pages)).status).toBe("incomplete");
});

it("does not discard a fabricated citation just because another one is valid", async () => {
  const result = await review([{ index: 14, markdown: quote }], [{ pageIndex: 14, quote }, { pageIndex: 14, quote: "A fabricated sentence about solving the problem." }], true);
  expect(result.status).toBe("incomplete");
});

it("does not accept altered words or punctuation without an approved exact correction, or tiny quotes", async () => {
  for (const invented of [quote.replace("shallow", "tiny"), `“${quote.replace(".", "!")}”`, "“A dip.”"]) {
    const result = await review([{ index: 14, markdown: `${quote} A dip.` }], [{ pageIndex: 14, quote: invented }], invented.length >= 12);
    expect(result.status).toBe("incomplete");
  }
});
