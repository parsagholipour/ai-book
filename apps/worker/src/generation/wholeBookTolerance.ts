import {
  normalizePlanPageTargets,
  generationPageCountBounds,
  inputWithSelectedPageCount,
  type BookGenerationStrategy,
  type BookPlan,
  type CreateProjectInput
} from "@book-maker/core";

type SavedPageTargetInput = Pick<CreateProjectInput, "targetPages"> & Partial<Pick<CreateProjectInput, "mediaSettings">>;
type SavedPageTargetStrategy = Pick<BookGenerationStrategy, "executionMode" | "generateWholeBookDraft">;

export function effectiveSavedWholeBookExportContext(
  input: CreateProjectInput,
  plan: BookPlan,
  strategy: SavedPageTargetStrategy,
  pages: Array<{ index: number }>
): { input: CreateProjectInput; plan: BookPlan } {
  const acceptedTarget = acceptedSavedPageTarget(input, strategy, pages);
  if (acceptedTarget === undefined || acceptedTarget === input.targetPages) {
    return { input, plan };
  }

  return {
    input: inputWithSelectedPageCount(input, acceptedTarget),
    plan: normalizePlanPageTargets(plan, acceptedTarget)
  };
}

export function acceptedSavedPageTarget(
  input: SavedPageTargetInput,
  strategy: SavedPageTargetStrategy,
  pages: Array<{ index: number }>
): number | undefined {
  if (!savedPagesAreContiguousFromOne(pages)) {
    return undefined;
  }

  const pageCount = pages.length;
  if (pageCount === input.targetPages) {
    return pageCount;
  }
  if (
    strategySupportsWholeBookPageTolerance(strategy) &&
    pageCountWithinWholeBookTolerance(pageCount, input)
  ) {
    return pageCount;
  }
  return undefined;
}

export function terminalSavedPageCount(pages: Array<{ status: string; markdown: string }>): number {
  return pages.filter((page) => page.status === "COMPLETED" || (page.status === "FAILED_QA" && page.markdown !== ""))
    .length;
}

export function savedPagesAreContiguousFromOne(pages: Array<{ index: number }>): boolean {
  if (pages.length === 0) {
    return false;
  }
  const indexes = pages.map((page) => page.index).sort((first, second) => first - second);
  return indexes.every((pageIndex, index) => pageIndex === index + 1);
}

function strategySupportsWholeBookPageTolerance(strategy: SavedPageTargetStrategy): boolean {
  return (
    strategy.executionMode === "whole-book" ||
    (strategy.executionMode === "draft-then-polish" && Boolean(strategy.generateWholeBookDraft))
  );
}

function pageCountWithinWholeBookTolerance(pageCount: number, input: SavedPageTargetInput): boolean {
  const { minimumPages, maximumPages } = generationPageCountBounds(input);
  return pageCount >= minimumPages && pageCount <= maximumPages;
}
