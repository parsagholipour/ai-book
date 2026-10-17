import { expect, it } from "vitest";
import { pictureBookReviewKind } from "./pictureBookReviewContext.js";

it("frames a children's book as a picture book and every other short illustrated book as a story", () => {
  expect(pictureBookReviewKind({ category: "KIDS" })).toBe("picture_book");
  for (const category of ["STORY", "CUSTOM", "ARTS"] as const) expect(pictureBookReviewKind({ category })).toBe("illustrated_story");
});
