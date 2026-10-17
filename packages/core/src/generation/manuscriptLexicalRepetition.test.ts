import { expect, it } from "vitest";
import { runDeterministicManuscriptChecks } from "./manuscriptQuality.js";
import { isNameOrTitle } from "./manuscriptLexicalRepetition.js";

const filler = (count: number, prefix: string) => Array.from({ length: count }, (_, i) => `${prefix}${i}`).join(" ");
const bookCarrying = (phrase: string) => Array.from({ length: 30 }, (_, offset) => {
  const index = offset + 1;
  const carries = [2, 6, 10, 14, 18, 22, 26].includes(index);
  return { index, title: `Page ${index}`, markdown: carries ? `${filler(90, `p${index}w`)} ${phrase} ${filler(20, `p${index}x`)}` : filler(100, `p${index}w`) };
});
const repeated = (phrase: string) => runDeterministicManuscriptChecks({ pages: bookCarrying(phrase), expectedPageCount: 30 })
  .filter((issue) => issue.code === "REPEATED_PHRASE");

it("does not report a story's artifact or an institution as a repeated phrase", () => {
  // cmuonms7d (2026-10-15): "Book of First Flight" was the plot's artifact, labelled false.
  expect(repeated("the Book of First Flight")).toEqual([]);
  expect(repeated("the Supreme Federal Court")).toEqual([]);
  // A phrase is still a phrase: one labelled real kept a lower-case content word.
  expect(repeated("Lena, a freelance illustrator")).toHaveLength(1);
});

it("reads a name or a title as every content word capitalised", () => {
  expect(isNameOrTitle("Book of First Flight")).toBe(true);
  expect(isNameOrTitle("the Supreme Federal Court")).toBe(true);
  expect(isNameOrTitle("Nana Jo turned the")).toBe(false);
  expect(isNameOrTitle("If the direct report")).toBe(false);
  expect(isNameOrTitle("does not by itself")).toBe(false);
  // A script with no case is never read as a name.
  expect(isNameOrTitle("کتاب پرواز نخست")).toBe(false);
});
