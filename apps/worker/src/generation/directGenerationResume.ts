/**
 * Resume policy for the in-process generation modes (chapter-whole-pass,
 * batch-window, draft-then-polish). These modes persist pages incrementally
 * (reviewAndSaveGeneratedPage upserts by project+index), so a re-run after a
 * mid-book failure can keep the settled prefix instead of wiping the book with
 * resetBookForDirectGeneration. Pure decisions only — no database access —
 * mirroring the staleJobGuard pattern.
 */

export type DirectResumeState =
  | { kind: "fresh" }
  | { kind: "resume"; firstMissingPageIndex: number }
  | { kind: "already-complete" };

export type DirectResumeInput = {
  targetPages: number;
  planChapters: Array<{ index: number; title: string; targetPages: number }>;
  storedChapters: Array<{ index: number; title: string; targetPages: number; hasBrief: boolean }>;
  storedPages: Array<{ index: number; status: string }>;
  /** The strategy generates chapter briefs, so resuming requires every stored chapter to still carry one. */
  requiresBriefs: boolean;
  /**
   * draft-then-polish checkpoints the whole accepted draft as PENDING rows, so
   * every page must already exist; the chapter modes only persist the settled
   * prefix, so pages are expected to stop at the failure point.
   */
  requireAllPagesPresent: boolean;
};

/** Pages in these statuses count as finished work worth keeping (final QA repairs FAILED_QA at export). */
const SETTLED_PAGE_STATUSES = new Set(["COMPLETED", "FAILED_QA"]);

export function directGenerationResumeState(input: DirectResumeInput): DirectResumeState {
  if (input.targetPages < 1 || input.storedChapters.length === 0 || input.storedPages.length === 0) {
    return { kind: "fresh" };
  }
  if (!storedChaptersMatchPlan(input)) {
    return { kind: "fresh" };
  }

  const pages = [...input.storedPages].sort((a, b) => a.index - b.index);
  if (hasDuplicateIndexes(pages) || pages.some((page) => page.index < 1 || page.index > input.targetPages)) {
    return { kind: "fresh" };
  }

  return input.requireAllPagesPresent ? draftThenPolishState(input.targetPages, pages) : settledPrefixState(input.targetPages, pages);
}

function draftThenPolishState(
  targetPages: number,
  pages: Array<{ index: number; status: string }>
): DirectResumeState {
  if (pages.length !== targetPages || pages.some((page, position) => page.index !== position + 1)) {
    return { kind: "fresh" };
  }
  if (pages.some((page) => page.status !== "PENDING" && !SETTLED_PAGE_STATUSES.has(page.status))) {
    return { kind: "fresh" };
  }
  const firstPending = pages.find((page) => page.status === "PENDING");
  if (!firstPending) {
    return { kind: "already-complete" };
  }
  return { kind: "resume", firstMissingPageIndex: firstPending.index };
}

function settledPrefixState(
  targetPages: number,
  pages: Array<{ index: number; status: string }>
): DirectResumeState {
  if (pages.some((page, position) => page.index !== position + 1)) {
    return { kind: "fresh" };
  }
  if (pages.some((page) => !SETTLED_PAGE_STATUSES.has(page.status))) {
    return { kind: "fresh" };
  }
  if (pages.length >= targetPages) {
    return { kind: "already-complete" };
  }
  return { kind: "resume", firstMissingPageIndex: pages.length + 1 };
}

function storedChaptersMatchPlan(input: DirectResumeInput): boolean {
  if (input.storedChapters.length !== input.planChapters.length) {
    return false;
  }
  return input.planChapters.every((planChapter) => {
    const stored = input.storedChapters.find((chapter) => chapter.index === planChapter.index);
    if (!stored || stored.title !== planChapter.title || stored.targetPages !== planChapter.targetPages) {
      return false;
    }
    return !input.requiresBriefs || stored.hasBrief;
  });
}

function hasDuplicateIndexes(pages: Array<{ index: number }>): boolean {
  return new Set(pages.map((page) => page.index)).size !== pages.length;
}
