import {
  requestedGenerationPages, inferWritingMode, isAuthorManuscript, isNarrativeWritingMode, pictureBookReviewKind,
  type BookGenerationStrategy, type BookPlan, type CreateProjectInput, type PriorPageContext
} from "@book-maker/core";

/** A story that is not a children's book is picture-book scale up to here; auto routing
 * composes 12+ requested pages by chapter, so the draft-then-polish pass is what bounds it. */
export const SHORT_ILLUSTRATED_STORY_MAX_PAGES = 16;

/** The short-book path: a children's book of 5–40 requested pages (artwork optional),
 * or an illustrated narrative of 5–16 on the draft-then-polish pass. The whole-book
 * draft is saved as written — no page is polished and no model reads or rewrites a
 * page at generation time, on any tier (`localChecksOnly`, `draftThenPolish.ts`) —
 * and every picture is queued from the checkpointed draft (`draftIllustrations.ts`).
 * The compile asks it too, for the reader-chapter layout (`shortPictureBookExport.ts`).
 * It used to be called `usesShortPictureBookReview`: the grouped picture-book review it switched on, and the
 * compile's final review and coordinated repair that followed it under `finalReview`,
 * were removed on 2026-10-16 (E4: the grouped review, its repairs and the compile's
 * final review against the draft, 7 wins / 19 ties / 2 losses with three blind readers
 * per order, lower bound 45%; the per-page polish lost to the draft 1/1/6; H7b: on 13
 * Balanced drafts the compile's defect screen found no grounded defect at all). A short
 * book's only review is the compile's defect screen on Quick Draft
 * (`usesCompileDefectScreen`); nothing here depends on a tier or a review setting.
 * Explicit research strategies keep their requested workflow. */
export function usesShortBookPath(options: {
  input: CreateProjectInput; plan: BookPlan; strategy: BookGenerationStrategy; pages: readonly PriorPageContext[];
}): boolean {
  const { input, plan, pages, strategy } = options;
  const requested = requestedGenerationPages(input);
  // A cue-word "research intent" is no evidence about the book: the app's own Auto brief
  // says "Decide the real book shape", a romance's theme was "Real connection", and the
  // brief of a 10-page otter story (cmvc7ofzj002cpep62ug9u1zw, 2026-10-17) carried the
  // creation chat's own "the warmth of friendship is the real treasure" — so it lost its
  // early pictures and its draft-decided sheets. A research strategy still opts out
  // (`researchDepth`, below), which is where the router sends a factual picture book of
  // 12 pages or more. A story's test is its writing mode; both narrative modes count: a
  // children's brief under the legacy `short_story` choice is filed STORY and its planner
  // writes `children-narrative`, which `=== "narrative"` refused.
  const shortBook = pictureBookReviewKind(input) === "picture_book" ? requested >= 5 && requested <= 40
    : requested >= 5 && requested <= SHORT_ILLUSTRATED_STORY_MAX_PAGES && strategy.executionMode === "draft-then-polish" &&
      isNarrativeWritingMode(inferWritingMode(input, plan)) && pages.some((page) => strategy.shouldIllustratePage(input, plan, page.index));
  return shortBook && !isAuthorManuscript(input.mediaSettings) &&
    (!input.mediaSettings.generationStrategy || input.mediaSettings.generationStrategy === "auto") && !strategy.researchDepth &&
    pages.length === input.targetPages && pages.every((page, position) => page.index === position + 1 && page.markdown.trim().length > 0) &&
    pages.reduce((sum, page) => sum + page.markdown.length, 0) <= 48_000 &&
    pages.reduce((sum, page) => sum + page.markdown.trim().split(/\s+/u).length, 0) <= 6_000;
}
