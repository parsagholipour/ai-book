import type { CreateProjectInput } from "../schemas/book.js";

/**
 * Whether the chapter is this book's unit of composition: every book of twelve pages or more
 * but a picture book, whose pages are real units with a picture each. The strategy router
 * chooses the composed strategies by this, and the planner enforces the compose ceiling
 * (`maxComposedChapterPages`) by it, so the choice and the guarantee cannot drift apart. It
 * lives in a file of its own because the router must stay light and the planner is inside
 * the strategies' own import graph. See `.scratch/composed-chapters/spec.md` for the measurements.
 */
export function composesByChapter(input: Pick<CreateProjectInput, "targetPages" | "category">): boolean {
  return input.targetPages >= 12 && input.category !== "KIDS";
}
