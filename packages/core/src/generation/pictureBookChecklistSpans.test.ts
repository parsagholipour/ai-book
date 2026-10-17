import { expect, it } from "vitest";
import { pictureBookChecklistSpans } from "./pictureBookChecklistSpans.js";

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
