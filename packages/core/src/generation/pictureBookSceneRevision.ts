import { MAX_PICTURE_BOOK_PAGES } from "./pageCountAllowance.js";
import { z } from "zod";
import type { PriorPageContext } from "./pagesShared.js";

/** A replacement sequence keeps the same physical slots and page identities. */
export const pictureBookSceneRevisionSchema = z.strictObject({
  reason: z.string().trim().min(1).max(700).describe("Before writing page prose, state the revised page-index -> consequential change sequence and the entry/exit obligations against untouched neighboring pages."),
  pages: z.array(z.strictObject({
    pageIndex: z.number().int().positive(), markdown: z.string().trim().min(1).max(12_000),
    title: z.string().trim().min(1).max(200).optional(),
    summary: z.string().trim().min(1).max(1200)
  })).min(2).max(MAX_PICTURE_BOOK_PAGES)
});
export type PictureBookSceneRevision = { pageIndexes: number[]; reason: string };

/** Convert validated scene replacements to the existing atomic patch lane.
 * Syntax-only findings never authorize a semantic rewrite, even as a neighbor. */
export function sceneRevisionPatches(options: {
  scenes: readonly z.infer<typeof pictureBookSceneRevisionSchema>[];
  pages: readonly PriorPageContext[];
  scopes: readonly { pageIndex: number; sentenceOnly: boolean }[];
}) {
  const originals = new Map(options.pages.map(page => [page.index, page]));
  const semanticTargets = new Set(options.scopes.filter(scope => !scope.sentenceOnly).map(scope => scope.pageIndex));
  const syntaxTargets = new Set(options.scopes.filter(scope => scope.sentenceOnly).map(scope => scope.pageIndex));
  const seen = new Set<number>();
  const scenes: PictureBookSceneRevision[] = [];
  const rows = options.scenes.flatMap(scene => {
    const indexes = scene.pages.map(page => page.pageIndex);
    if (!indexes.some(index => semanticTargets.has(index)))
      throw new Error("Picture-book scene revision must contain an original semantic repair target.");
    for (const [i, index] of indexes.entries()) {
      if (!originals.has(index) || seen.has(index) || (i > 0 && index !== indexes[i - 1]! + 1))
        throw new Error("Picture-book scene revision must contain unique, contiguous original pages in order.");
      if (syntaxTargets.has(index)) throw new Error(`Picture-book scene revision cannot rewrite sentence-only page ${index}.`);
      seen.add(index);
    }
    scenes.push({ pageIndexes: indexes, reason: scene.reason });
    return scene.pages.map(page => ({ pageIndex: page.pageIndex, reason: scene.reason, summary: page.summary,
      ...(page.title ? { title: page.title } : {}),
      patches: [{ find: originals.get(page.pageIndex)!.markdown, replace: page.markdown }] }));
  });
  return { scenes, rows };
}
