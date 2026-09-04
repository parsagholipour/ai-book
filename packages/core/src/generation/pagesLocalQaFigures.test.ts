import { describe, expect, it } from "vitest";
import { makeFallbackPlan } from "../prompting/templates.js";
import type { CreateProjectInput } from "../schemas/book.js";
import { reviewPageDraftLocally } from "./pagesLocalQa.js";

/**
 * The local checks read a page's prose and never its figure block; kept apart
 * from `pagesLocalQa.test.ts`, which is at the file-size budget.
 */
const input: CreateProjectInput = {
  prompt: "A practical history of city water systems and home filtration.",
  category: "EDUCATION",
  targetPages: 12,
  complexity: 6,
  temperature: 0.4,
  language: "en",
  mediaSettings: {
    fullIllustrations: false,
    illustrationCadence: "template-driven",
    includeCover: true,
    coverTemplate: "auto",
    finalReview: true,
    toneProfile: "scholarly"
  }
};

describe("figure blocks in the local checks", () => {
  it("reads a page the same with and without its figure", () => {
    const prose = Array.from(
      { length: 6 },
      (_, index) =>
        `The clerks counted the carts at the north gate in ${1500 + index * 10}, and the ledger they kept still names every carrier who paid the toll and every one who argued about it.`
    ).join(" ");
    const fence =
      "```figure\n" +
      JSON.stringify({ kind: "bar", title: "Carts by decade", categories: ["1500", "1510"], series: [{ name: "Carts", values: [120, 140] }], source: "The gate ledger" }) +
      "\n```";
    const review = (markdown: string) =>
      reviewPageDraftLocally({
        input,
        plan: makeFallbackPlan(input),
        pageIndex: 3,
        draft: { title: "The North Gate", markdown, summary: "The carts and their tolls.", continuityNotes: [] },
        previousPages: [],
        continuityNotes: []
      });
    expect(review(`${prose}\n\n${fence}\n\n${prose}`)).toEqual(review(`${prose}\n\n${prose}`));
  });
});
