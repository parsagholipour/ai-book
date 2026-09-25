import {
  createDeterministicReaderChapters, createReaderChaptersForExport, readerChapterFingerprint,
  readerChaptersFromComposedChapters, strategyComposesChapters,
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
