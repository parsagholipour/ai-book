import { isImportedManuscript, readerChaptersFromComposedChapters, type BookGenerationStrategy, type BookPlan, type CreateProjectInput } from "@book-maker/core";
import type { ExportPageForRepair } from "../runtime/jobTypes.js";
import { usesShortPictureBookReview } from "./shortPictureBook.js";

/** Retain the current titled partition only when it completely covers this short book. */
export function shortPictureBookReaderChapters(options: {
  input: CreateProjectInput; plan: BookPlan; strategy: BookGenerationStrategy; pages: readonly ExportPageForRepair[];
}) {
  if (isImportedManuscript(options.input.mediaSettings) || !usesShortPictureBookReview(options)) return undefined;
  const identities = new Map<number, string>();
  for (const page of options.pages) {
    const chapter = page.chapter;
    if (!chapter?.title?.trim() || !Number.isInteger(chapter.index) || chapter.index < 1) return undefined;
    const previous = identities.get(chapter.index);
    const identity = JSON.stringify([chapter.id, chapter.title, chapter.summary]);
    if (previous !== undefined && previous !== identity) return undefined;
    identities.set(chapter.index, identity);
  }
  const chapters = readerChaptersFromComposedChapters([...options.pages]);
  return chapters?.length && chapters[0]!.startPageIndex === 1 && chapters.at(-1)!.endPageIndex === options.input.targetPages
    ? chapters : undefined;
}
