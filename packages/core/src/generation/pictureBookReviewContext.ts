import type { CreateProjectInput } from "../schemas/book.js";

/** A children's book is a picture book; any other short illustrated story is read by the
 * audience and genre its own brief names, never held to picture-book rules. The worker's
 * short-book path asks it (`usesShortBookPath`); the grouped picture-book review that
 * framed its prompts by it was removed on 2026-10-16 (E4). */
export type PictureBookReviewKind = "picture_book" | "illustrated_story";
export function pictureBookReviewKind(input: Pick<CreateProjectInput, "category">): PictureBookReviewKind {
  return input.category === "KIDS" ? "picture_book" : "illustrated_story";
}
