import { expect, it } from "vitest";
import { reviewManuscriptCoverage } from "./manuscriptCoverage.js";
import { scriptedDevelopmentModel } from "./testing/bookDevelopmentFixtures.js";

const brief = "Keep the path problem gentle and understandable.";
const quote = "A shallow dip cuts across the slope ahead.";
async function review(pages: { index: number; markdown: string }[], evidence = [{ pageIndex: 14, quote }]) {
  const { model, calls } = scriptedDevelopmentModel([
    { complete: true, requirements: [{ text: brief, quote: brief, kind: "content" }] },
    { complete: true, requirements: [{ id: "brief-1", status: "fulfilled", reason: "The path obstacle is gentle.", evidence }] }
  ]);
  const result = await reviewManuscriptCoverage({ brief, promises: [], pages, textModel: model });
  expect(calls).toHaveLength(2);
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

it.each([
  [{ index: 12, markdown: quote }, { index: 13, markdown: quote }],
  [{ index: 13, markdown: "A deep ravine cuts across the slope ahead." }],
  [{ index: 13, markdown: quote }, { index: 13, markdown: "Different page with duplicate numbering." }]
].map((pages) => ({ pages })))("leaves ambiguous, paraphrased and duplicate-page citations unverified", async ({ pages }) => {
  expect((await review(pages)).status).toBe("incomplete");
});

it("does not discard a fabricated citation just because another one is valid", async () => {
  const result = await review([{ index: 14, markdown: quote }], [{ pageIndex: 14, quote }, { pageIndex: 14, quote: "A fabricated sentence about solving the problem." }]);
  expect(result.status).toBe("incomplete");
});

it("does not repair altered words, interior punctuation or a quote reduced below the evidence minimum", async () => {
  for (const invented of [quote.replace("shallow", "tiny"), `“${quote.replace(".", "!")}”`, "“A dip.”"]) {
    const result = await review([{ index: 14, markdown: `${quote} A dip.` }], [{ pageIndex: 14, quote: invented }]);
    expect(result.status).toBe("incomplete");
  }
});
