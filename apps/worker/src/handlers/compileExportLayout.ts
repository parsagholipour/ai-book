import {
  authorReaderChapters, createDeterministicReaderChapters, createReaderChaptersForExport, isAuthorManuscript,
  readerChapterFingerprint, readerChaptersFromComposedChapters, strategyComposesChapters,
  type BookGenerationStrategy, type BookPlan, type CreateProjectInput, type TextModelAdapter
} from "@book-maker/core";
import { objectKey, objectStore } from "@book-maker/storage";
import { readCompatibleCachedReaderChapters, readerChaptersFromPublishedMarkdown, readerChaptersWithCache } from "../generation/readerChapterCache.js";
import { shortPictureBookReaderChapters } from "../generation/shortPictureBookExport.js";
import type { ExportPageForRepair } from "../runtime/jobTypes.js";

export async function resolveCompileReaderLayout(options: {
  projectId: string; input: CreateProjectInput; plan: BookPlan; strategy: BookGenerationStrategy;
  pages: ExportPageForRepair[]; textModel: TextModelAdapter; superseded: boolean;
  detachedRepair: boolean; presentationOnly: boolean;
}) {
  const { projectId, input, plan, pages, detachedRepair, presentationOnly } = options;
  const publishedMarkdown = detachedRepair || presentationOnly
    ? (await objectStore().get(objectKey("books", projectId, "book.md")))?.toString("utf8") : undefined;
  // An author's book is printed in the chapters the author wrote, in every lane
  // and never through the model: its `Chapter` rows, or `[]` for the plan's
  // partition, which a publish writes from the same chapters. See `authorReaderChapters`.
  if (isAuthorManuscript(input.mediaSettings)) return { publishedMarkdown, readerChapters: authorReaderChapters(pages) };
  let preserved = publishedMarkdown !== undefined ? readerChaptersFromPublishedMarkdown(publishedMarkdown, pages) : undefined;
  if (preserved === undefined && detachedRepair && publishedMarkdown === undefined) preserved = await readCompatibleCachedReaderChapters(projectId, pages);
  const composed = strategyComposesChapters(options.strategy) ? readerChaptersFromComposedChapters(pages) : undefined;
  // Free reprints preserve the published layout before considering the new-book optimization.
  const short = !detachedRepair && !presentationOnly ? shortPictureBookReaderChapters(options) : undefined;
  const readerChapters = composed ?? short ?? (options.superseded ? [] : await readerChaptersWithCache({
    projectId, fingerprint: readerChapterFingerprint({ input, plan, pages }),
    allowModelCall: !detachedRepair && !presentationOnly,
    compute: () => createReaderChaptersForExport({ input, plan, pages, textModel: options.textModel }),
    deterministic: () => preserved ?? createDeterministicReaderChapters(pages)
  }));
  return { publishedMarkdown, readerChapters };
}
