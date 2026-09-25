import type { ManuscriptQualityIssue } from "@book-maker/core";

type TransitionPage = { index: number; chapter?: { index: number } | null };

/** Only an actionable, located handoff earns a repair of its two actual sides. */
export function chapterTransitionRepairIssues(
  issues: readonly ManuscriptQualityIssue[],
  pages: readonly TransitionPage[]
): ManuscriptQualityIssue[] {
  const ordered = [...pages].sort((left, right) => left.index - right.index);
  return issues.flatMap((issue) => {
    if (issue.code !== "CHAPTER_TRANSITION" || issue.source !== "model" ||
      !issue.message.trim() || !issue.guidance.trim()) return [];
    const indexes = [...new Set(issue.affectedPageIndexes)].sort((left, right) => left - right);
    if (indexes.length !== 2) return [];
    const [fromIndex, toIndex] = indexes;
    const position = ordered.findIndex((page) => page.index === fromIndex);
    const from = ordered[position];
    const to = ordered[position + 1];
    if (!from || !to || to.index !== toIndex || to.index !== from.index + 1) return [];
    // Match the chapter reviewer's fallback for books without chapter rows.
    const fromChapter = from.chapter?.index ?? Math.max(1, Math.ceil(from.index / 8));
    const toChapter = to.chapter?.index ?? Math.max(1, Math.ceil(to.index / 8));
    if (fromChapter === toChapter) return [];
    return [{ ...issue, affectedPageIndexes: indexes }];
  });
}
