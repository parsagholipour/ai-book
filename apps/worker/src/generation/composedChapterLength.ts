import {
  chapterWordBudget, findFigureFences, FIGURE_WORD_EQUIVALENT, proseWordCount,
  type CreateProjectInput, type ManuscriptQualityIssue
} from "@book-maker/core";

/** Measure the accepted manuscript, never a stale draft count or its page-row count. */
export function measureComposedChapterLength(input: CreateProjectInput, pageCount: number, markdown: string) {
  const figureWords = findFigureFences(markdown).filter((fence) => fence.closed && fence.spec).length * FIGURE_WORD_EQUIVALENT;
  const budget = chapterWordBudget(input, pageCount, { figureWords });
  const words = proseWordCount(markdown);
  return { words, wordBudget: { min: budget.min, target: budget.target, max: budget.max }, shortfall: Math.max(0, budget.min - words) };
}

type ChapterPage = {
  index: number;
  markdown: string;
  chapter?: { id: string; index: number; title?: string; targetPages?: number } | null | undefined;
};

/** Runs at export after every edit/repair, including resumes and recompiles. */
export function composedChapterLengthIssues(pages: readonly ChapterPage[], input: CreateProjectInput): ManuscriptQualityIssue[] {
  const groups = new Map<string, ChapterPage[]>();
  for (const page of pages) {
    if (!page.chapter) continue;
    const group = groups.get(page.chapter.id) ?? [];
    group.push(page);
    groups.set(page.chapter.id, group);
  }
  return [...groups.values()].flatMap((group) => {
    const chapter = group[0]!.chapter!;
    const ordered = [...group].sort((a, b) => a.index - b.index);
    const pageCount = chapter.targetPages ?? group.length;
    const length = measureComposedChapterLength(input, pageCount, ordered.map((page) => page.markdown).join("\n\n"));
    if (!length.shortfall) return [];
    return [{
      code: "CHAPTER_LENGTH_SHORTFALL",
      severity: "error" as const,
      source: "deterministic" as const,
      message: `Chapter ${chapter.index}${chapter.title ? `, “${chapter.title}”,` : ""} has ${length.words} readable words against a ${length.wordBudget.min}-word minimum for ${pageCount} planned pages (${length.shortfall} words short).`,
      guidance: "Develop the chapter's assigned material with supported explanation or worked examples, or revise its planned length. Preserve factual corrections; do not fill the gap with repetition or unsupported claims.",
      affectedPageIndexes: ordered.map((page) => page.index)
    }];
  });
}
