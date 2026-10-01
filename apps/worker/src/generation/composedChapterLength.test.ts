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
    { tier: "Balanced", words: 1370, pages: 4, min: 1720, severity: "error" },
    { tier: "Quick", words: 1837, pages: 5, min: 2150, severity: "warning" },
    { tier: "Ultra chapter 2", words: 1646, pages: 4, min: 1720, severity: "warning" },
    { tier: "Ultra chapter 3", words: 1641, pages: 4, min: 1720, severity: "warning" }
  ])("flags $tier despite having all its page rows and a stale passing report", ({ words, pages, min, severity }) => {
    // A one-chapter book is its own floor: it blocks only under LENGTH_FLOOR_SHARE of it (1,370 of 1,720).
    const manuscript = pagesFor(words, pages);
    expect(manuscript).toHaveLength(pages);
    expect(composedChapterLengthIssues(manuscript, input)).toEqual([expect.objectContaining({
      code: "CHAPTER_LENGTH_SHORTFALL", severity, source: "deterministic",
      message: expect.stringContaining(`${words} readable words against a ${min}-word minimum`),
      affectedPageIndexes: manuscript.map((page) => page.index)
    })]);
  });

  it("rechecks the final text after cuts and clears itself after development", () => {
    expect(composedChapterLengthIssues(pagesFor(1800), input)).toEqual([]);
    expect(composedChapterLengthIssues(pagesFor(1600), input)).toHaveLength(1);
    expect(composedChapterLengthIssues(pagesFor(1720), input)).toEqual([]);
  });

  it("reports a shortfall of a few words as a warning, not an error that blocks the book", () => {
    // Quick Draft, 2026-09-30: chapters 4, 16 and 23 words under a 1,150–1,720-word minimum
    // printed the pages paid for and still sent their books to "Review required".
    expect(composedChapterLengthIssues(pagesFor(1700), input)).toEqual([expect.objectContaining({ code: "CHAPTER_LENGTH_SHORTFALL", severity: "warning" })]);
    expect(composedChapterLengthIssues(pagesFor(1400), input)).toEqual([expect.objectContaining({ severity: "error" })]);
  });

  it("still reports a short chapter beside a long one, against its own pages", () => {
    const issues = composedChapterLengthIssues([...pagesFor(1370), ...pagesFor(2500, 4, 2)], input);
    expect(issues).toHaveLength(1);
    expect(issues[0]!.affectedPageIndexes).toEqual([1, 2, 3, 4]);
  });

  it("blocks on the book's floor: a chapter under its own minimum in a book over its floor is a warning", () => {
    // 2026-09-30: a 28-page history at 108% of its floor and a 20-page narrative at 105% both
    // went to "Review required" over one chapter 8–9% short (1,454 and 1,559 words against 1,580 and 1,720).
    const uneven = composedChapterLengthIssues([...pagesFor(1559), ...pagesFor(1900, 4, 2)], input);
    expect(uneven).toEqual([expect.objectContaining({ code: "CHAPTER_LENGTH_SHORTFALL", severity: "warning",
      message: expect.stringContaining("The book as a whole has 3459 words against a 3440-word minimum."), affectedPageIndexes: [1, 2, 3, 4] })]);
    // A chapter in a book that is short as a whole still blocks: 2,900 of a 3,440-word floor is 0.84.
    const shortBook = composedChapterLengthIssues([...pagesFor(1300), ...pagesFor(1600, 4, 2)], input);
    expect(shortBook).toEqual([1, 2].map(() => expect.objectContaining({ severity: "error", message: expect.not.stringContaining("The book as a whole") })));
  });

  it("releases a tight book that prints its pages: under its full floor but over the share of it the fitter fills", () => {
    // 2026-10-01: five books were blocked at 0.94–0.995 of their floor, and every PDF printed its paid pages.
    // r1-bal-history: chapters of 1,550 and 1,469 against 1,720, its book 0.978 of its floor.
    const tight = composedChapterLengthIssues([...pagesFor(1550), ...pagesFor(1469, 4, 2), ...pagesFor(1808, 4, 3)], input);
    expect(tight.map((issue) => issue.severity)).toEqual(["warning", "warning"]);
    expect(tight[0]!.message).toContain("The book as a whole has 4827 words against a 5160-word minimum.");
  });

  it("counts a worksheet's rows at the room they print, so a table-heavy chapter is measured as it fills its pages", () => {
    // r1-bal-workbook chapter 5: 1,073 readable words (the cells among them) against 1,290, printed full.
    const rows = ["| Input or check | Amount | Decision |", "|---|---:|---|", ...Array.from({ length: 24 }, (_, i) => `| Line ${i} | [ ] | [ ] |`)].join("\n");
    expect(composedChapterLengthIssues(pagesFor(1500, 4, 1, `\n\n${rows}`), input)).toEqual([]);
    const proseOnly = composedChapterLengthIssues(pagesFor(1500), input);
    expect(proseOnly).toEqual([expect.objectContaining({ severity: "warning", message: expect.stringContaining("1500 readable words against") })]);
    const shortWithTable = composedChapterLengthIssues(pagesFor(1300, 4, 1, `\n\n${rows.split("\n").slice(0, 7).join("\n")}`), input);
    expect(shortWithTable).toEqual([expect.objectContaining({ message: expect.stringContaining("its 6 table rows counted at the room they print") })]);
  });

  it("blocks on a stub chapter however long the rest of the book runs", () => {
    // Under three quarters of its minimum: 1,280 of 1,720 words.
    const issues = composedChapterLengthIssues([...pagesFor(1280), ...pagesFor(2600, 4, 2)], input);
    expect(issues).toEqual([expect.objectContaining({ severity: "error", affectedPageIndexes: [1, 2, 3, 4] })]);
    expect(composedChapterLengthIssues([...pagesFor(1295), ...pagesFor(2600, 4, 2)], input)).toEqual([expect.objectContaining({ severity: "warning" })]);
  });

  it("credits only a retained renderable figure, excluding its markup from the word count", () => {
    const figure = '\n\n```figure\n{"kind":"bar","title":"Key sizes","categories":["A","B"],"series":[{"name":"Bits","values":[1,2]}],"source":"Toy example"}\n```';
    expect(composedChapterLengthIssues(pagesFor(1580, 4, 1, figure), input)).toEqual([]);
    expect(composedChapterLengthIssues(pagesFor(1580, 4, 1, '\n\n```figure\n{"bad":true}\n```'), input)).toHaveLength(1);
    expect(composedChapterLengthIssues(pagesFor(1580), input)).toHaveLength(1);
  });
});
