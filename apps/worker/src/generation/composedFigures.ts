import {
  figureFreeProse,
  hasFigureFence,
  reinsertFigureFences,
  stripFigureFences,
  validateFigureFences,
  type AnchoredFigureFence
} from "@book-maker/core";
import type { IndexedPageDraft } from "../runtime/jobTypes.js";

/**
 * The composed pass's side of figures: what the writer returned is checked
 * against the plan once, right after the compose call, and every later step
 * — the line edit, the couplet rewrite, the quote guard, the finalize checks
 * and the story delta — reads prose with the blocks taken out. The blocks go
 * back deterministically (`figureBlocks.ts` in core) before the pages are
 * cut and before a page is staged. Nothing here makes a model call.
 */

/** The writer's figure blocks against the plan: unreadable and unplanned ones dropped and logged, kept ones canonical. */
export function validateComposedChapterFigures(options: {
  markdown: string;
  planned: number;
  projectId: string;
  chapterIndex: number;
}): string {
  const result = validateFigureFences(options.markdown, { max: options.planned });
  for (const drop of result.dropped) {
    console.warn("Figure block dropped from a composed chapter", {
      event: "generation.composed_chapters.figure_dropped",
      projectId: options.projectId,
      chapterIndex: options.chapterIndex,
      reason: drop.reason,
      excerpt: drop.excerpt
    });
  }
  return result.markdown;
}

/** Page drafts with their figures taken out, and where each page's blocks go back. */
export function figureFreeDrafts(drafts: readonly IndexedPageDraft[]): {
  drafts: IndexedPageDraft[];
  fencesByIndex: Map<number, AnchoredFigureFence[]>;
} {
  const fencesByIndex = new Map<number, AnchoredFigureFence[]>();
  const stripped = drafts.map((draft) => {
    if (!hasFigureFence(draft.markdown)) return draft;
    fencesByIndex.set(draft.index, stripFigureFences(draft.markdown).fences);
    return { ...draft, markdown: figureFreeProse(draft.markdown) };
  });
  return { drafts: stripped, fencesByIndex };
}

/** A page draft with its figures back, after the finalize checks and any revise have run on the prose. */
export function restoreFigures(draft: IndexedPageDraft, fencesByIndex: ReadonlyMap<number, AnchoredFigureFence[]>): IndexedPageDraft {
  const fences = fencesByIndex.get(draft.index);
  if (!fences || fences.length === 0) return draft;
  return { ...draft, markdown: reinsertFigureFences(draft.markdown, fences) };
}
