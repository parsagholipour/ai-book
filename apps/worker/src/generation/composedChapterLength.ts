import {
  chapterWordBudget, findFigureFences, FIGURE_WORD_EQUIVALENT, LENGTH_FLOOR_SHARE, printedWordCount, tableRowCount,
  type CreateProjectInput, type ManuscriptQualityIssue
} from "@book-maker/core";

/**
 * Measure the accepted manuscript, never a stale draft count or its page-row count,
 * as it prints: a table row counts the room it takes (`printedWordCount`).
 */
export function measureComposedChapterLength(input: CreateProjectInput, pageCount: number, markdown: string) {
  const figureWords = findFigureFences(markdown).filter((fence) => fence.closed && fence.spec).length * FIGURE_WORD_EQUIVALENT;
  const budget = chapterWordBudget(input, pageCount, { figureWords });
  const words = printedWordCount(markdown);
  return { words, tableRows: tableRowCount(markdown), wordBudget: { min: budget.min, target: budget.target, max: budget.max }, shortfall: Math.max(0, budget.min - words) };
}

type ChapterPage = {
  index: number;
  markdown: string;
  chapter?: { id: string; index: number; title?: string; targetPages?: number } | null | undefined;
};

/**
 * A chapter this close to its minimum still prints the pages paid for (the minimum
 * is already three quarters of the target), so the shortfall is reported without
 * blocking the book. Chapters 4, 16 and 23 words short sent three Quick Draft books
 * to "Review required" on 2026-09-30; the Ultra incidents this rule was written
 * for were 4.3–4.6% short and stay errors when the book is short with them.
 */
const NEAR_MISS_SHARE = 0.03;

/**
 * Under this share of its own minimum a chapter is a stub whatever the rest of
 * the book did: three quarters of a minimum that is three quarters of the
 * target is little over half of what its pages were planned to hold.
 */
const STUB_SHARE = 0.75;

/**
 * Runs at export after every edit/repair, including resumes and recompiles.
 *
 * What the reader paid for is the book's pages, so the floor that blocks is the
 * book's: a chapter under its own minimum in a book that is over the sum of
 * its chapters' minimums is unevenness, reported as a warning. The writer's
 * one retry is against the chapter's minimum and keeps the longer draft, so
 * single chapters land 5–10% under while their siblings run over: on
 * 2026-09-30 a history at 108% of its floor and a narrative at 105% both went
 * to "Review required" over one chapter 8–9% short. Replayed over the 40
 * composed books stored since the 2026-09-20 budget fix, the per-chapter rule
 * blocked ten and this one blocks two: the eight it lets through are 3–17%
 * over their floor as books, and the two it keeps have a chapter at 65–69% of
 * its minimum. A stub chapter, or any chapter of a book that is short as a
 * whole, still blocks.
 *
 * "Short as a whole" is under `LENGTH_FLOOR_SHARE` of the sum, measured as it
 * prints (2026-10-01). Five books that day were blocked at 0.94–0.995 of the
 * sum and every one printed its paid pages — the three practical ones only
 * after the fitter tightened them, because a worksheet row prints taller than
 * its words — while the fitter fills a prose book's pages down to about 0.80
 * and loses a page at 0.74. Replayed over the 75 composed books stored from
 * 2026-09-20 (56 Quick Draft, 16 Balanced), the floor at the full sum blocked 9
 * (5 and 4) and this one blocks the 2 with a stub chapter, both Quick Draft.
 */
export function composedChapterLengthIssues(pages: readonly ChapterPage[], input: CreateProjectInput): ManuscriptQualityIssue[] {
  const groups = new Map<string, ChapterPage[]>();
  for (const page of pages) {
    if (!page.chapter) continue;
    const group = groups.get(page.chapter.id) ?? [];
    group.push(page);
    groups.set(page.chapter.id, group);
  }
  const chapters = [...groups.values()].map((group) => {
    const chapter = group[0]!.chapter!;
    const ordered = [...group].sort((a, b) => a.index - b.index);
    const pageCount = chapter.targetPages ?? group.length;
    return { chapter, ordered, pageCount, length: measureComposedChapterLength(input, pageCount, ordered.map((page) => page.markdown).join("\n\n")) };
  });
  const bookWords = chapters.reduce((sum, { length }) => sum + length.words, 0);
  const bookFloor = chapters.reduce((sum, { length }) => sum + length.wordBudget.min, 0);
  const bookHolds = bookWords >= bookFloor * LENGTH_FLOOR_SHARE;
  return chapters.flatMap(({ chapter, ordered, pageCount, length }) => {
    if (!length.shortfall) return [];
    const nearMiss = length.shortfall < length.wordBudget.min * NEAR_MISS_SHARE;
    const uneven = bookHolds && length.words >= length.wordBudget.min * STUB_SHARE;
    return [{
      code: "CHAPTER_LENGTH_SHORTFALL",
      severity: nearMiss || uneven ? "warning" as const : "error" as const,
      source: "deterministic" as const,
      message: `Chapter ${chapter.index}${chapter.title ? `, “${chapter.title}”,` : ""} has ${length.words} readable words${length.tableRows > 0 ? `, its ${length.tableRows} table rows counted at the room they print,` : ""} against a ${length.wordBudget.min}-word minimum for ${pageCount} planned pages (${length.shortfall} words short).${uneven && !nearMiss ? ` The book as a whole has ${bookWords} words against a ${bookFloor}-word minimum.` : ""}`,
      guidance: "Develop the chapter's assigned material with supported explanation or worked examples, or revise its planned length. Preserve factual corrections; do not fill the gap with repetition or unsupported claims.",
      affectedPageIndexes: ordered.map((page) => page.index)
    }];
  });
}
