import { describe, expect, it } from "vitest";
import { createProjectSchema, paginateChapterMarkdown } from "@book-maker/core";
import { composedChapterLengthIssues } from "./composedChapterLength.js";

const input = createProjectSchema.parse({ prompt: "A book about cryptography.", category: "SCIENCE", targetPages: 20 });
const prose = (words: number) => Array.from({ length: words }, (_, i) => `word${i}`).join(" ");
function pagesFor(words: number, targetPages = 4, index = 1, suffix = "") {
  const chapter = { id: `chapter-${index}`, index, title: `Chapter ${index}`, targetPages,
    productionBrief: { report: { editedWords: 3000, wordBudget: { min: 1720 } } } };
  return paginateChapterMarkdown(prose(words) + suffix, targetPages).pages.map((markdown, offset) => ({
    index: (index - 1) * 4 + offset + 1, markdown, chapter
  }));
}

describe("final composed chapter length", () => {
  it.each([
    { tier: "Balanced", words: 1370, pages: 4, min: 1720 },
    { tier: "Quick", words: 1837, pages: 5, min: 2150 },
    { tier: "Ultra chapter 2", words: 1646, pages: 4, min: 1720 },
    { tier: "Ultra chapter 3", words: 1641, pages: 4, min: 1720 }
  ])("flags $tier despite having all its page rows and a stale passing report", ({ words, pages, min }) => {
    const manuscript = pagesFor(words, pages);
    expect(manuscript).toHaveLength(pages);
    expect(composedChapterLengthIssues(manuscript, input)).toEqual([expect.objectContaining({
      code: "CHAPTER_LENGTH_SHORTFALL", severity: "error", source: "deterministic",
      message: expect.stringContaining(`${words} readable words against a ${min}-word minimum`),
      affectedPageIndexes: manuscript.map((page) => page.index)
    })]);
  });

  it("rechecks the final text after cuts and clears itself after development", () => {
    expect(composedChapterLengthIssues(pagesFor(1800), input)).toEqual([]);
    expect(composedChapterLengthIssues(pagesFor(1600), input)).toHaveLength(1);
    expect(composedChapterLengthIssues(pagesFor(1720), input)).toEqual([]);
  });

  it("does not let a long neighboring chapter compensate for a short chapter", () => {
    const issues = composedChapterLengthIssues([...pagesFor(1370), ...pagesFor(2500, 4, 2)], input);
    expect(issues).toHaveLength(1);
    expect(issues[0]!.affectedPageIndexes).toEqual([1, 2, 3, 4]);
  });

  it("credits only a retained renderable figure, excluding its markup from the word count", () => {
    const figure = '\n\n```figure\n{"kind":"bar","title":"Key sizes","categories":["A","B"],"series":[{"name":"Bits","values":[1,2]}],"source":"Toy example"}\n```';
    expect(composedChapterLengthIssues(pagesFor(1580, 4, 1, figure), input)).toEqual([]);
    expect(composedChapterLengthIssues(pagesFor(1580, 4, 1, '\n\n```figure\n{"bad":true}\n```'), input)).toHaveLength(1);
    expect(composedChapterLengthIssues(pagesFor(1580), input)).toHaveLength(1);
  });
});
