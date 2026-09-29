import { describe, expect, it } from "vitest";
import { buildManuscriptQualityReport, runDeterministicManuscriptChecks } from "./manuscriptQuality.js";

function words(count: number, prefix = "word"): string {
  return Array.from({ length: count }, (_, index) => `${prefix}${index}`).join(" ");
}

describe("an author's manuscript answers to the content-integrity checks alone", () => {
  // Page 2 carries every per-page finding at once; pages 3 and 4 are a
  // refrain, which is a near-duplicate to the slop detectors.
  const refrain = `${words(120, "refrain")} and the river kept its promise.`;
  const pages = [
    { index: 1, title: "Opening", markdown: `The book opens. ${words(60, "open")}` },
    { index: 2, title: "", markdown: "system prompt TODO [^missing]\n```" },
    { index: 3, title: "Refrain", markdown: `${refrain} alpha.` },
    { index: 4, title: "Refrain again", markdown: `${refrain} beta.` }
  ];

  it("keeps integrity and drops the prose judgments, the prompt-leak and the per-page footnote rule", () => {
    const generated = runDeterministicManuscriptChecks({ pages, expectedPageCount: 5 }).map((issue) => issue.code);
    const author = runDeterministicManuscriptChecks({ pages, expectedPageCount: 5, authorManuscript: true })
      .map((issue) => issue.code);

    expect(generated).toEqual(expect.arrayContaining(["PROMPT_LEAKAGE", "UNSUPPORTED_CITATION", "NEAR_DUPLICATE_PAGES"]));
    expect(author).toEqual(["PAGE_COUNT_MISMATCH", "EMPTY_PAGE", "PLACEHOLDER_TEXT", "MALFORMED_MARKDOWN"]);
  });

  it("reports a misnumbered author book, and passes a whole one however repetitive", () => {
    const misnumbered = runDeterministicManuscriptChecks({
      pages: [pages[0]!, { ...pages[2]!, index: 3 }], expectedPageCount: 2, authorManuscript: true
    });
    expect(misnumbered.map((issue) => issue.code)).toEqual(["PAGE_INDEX_INVALID"]);

    const whole = runDeterministicManuscriptChecks({
      pages: [pages[0]!, { ...pages[2]!, index: 2 }, { ...pages[3]!, index: 3 }], expectedPageCount: 3, authorManuscript: true
    });
    expect(whole).toEqual([]);
    expect(buildManuscriptQualityReport(whole, [], { finalReviewRan: false }).state).toBe("passed");
  });
});
