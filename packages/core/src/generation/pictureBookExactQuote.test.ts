import { expect, it } from "vitest";
import { pictureBookExactQuote } from "./pictureBookExactQuote.js";

const first = "Rabbit held the lantern.", last = "Turtle followed the path.";
const prose = `${first} He did not cross the stream. ${last}`;

it.each([`“${first}” Later, “${last}”`, `"${first}" ... "${last}"`, `“${first}”; “${last}”`])(
  "copies intervening negation and exact punctuation from the manuscript: %s", quote => {
    expect(pictureBookExactQuote(prose, quote)).toBe(prose);
  });

it("preserves an already exact citation, including repeated passages", () => {
  expect(pictureBookExactQuote(`${prose} ${prose}`, prose)).toBe(prose);
});

it.each([
  [`${first} ${first} ${last}`, `“${first}” Later, “${last}”`],
  [prose, `“${last}” Later, “${first}”`],
  [first, `“${first}” Later, “${last}”`],
  [prose, `“Rabbit carried the lantern.” Later, “${last}”`],
  [prose, `“rabbit held the lantern.” Later, “${last}”`],
  [prose, `“${first}” therefore “${last}”`],
  [prose, `“${first}” but not “${last}”`],
  [prose, `“${first}” Later, “${last}” This proves they crossed.`],
  [prose, `“Rabbit” Later, “${last}”`],
  [prose, `“${first}" Later, “${last}”`],
  [`${first} ${"unrelated ".repeat(100)} ${last}`, `“${first}” Later, “${last}”`],
  ["Rabbit held the lantern beside Turtle.", '"Rabbit held the lantern" Later, "lantern beside Turtle."']
])("refuses ambiguous, reordered, invented, partial, or overlong evidence %#", (markdown, quote) => {
  expect(pictureBookExactQuote(markdown, quote)).toBeUndefined();
});
