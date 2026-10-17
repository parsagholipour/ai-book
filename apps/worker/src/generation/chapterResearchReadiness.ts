import { chapterResearchQuery, type BookPlan, type ChapterResearchScope, type ResearchSource } from "@book-maker/core";

/**
 * Per-chapter readiness of a composed book's research expansion (harness
 * redesign H4). The expansion searches every chapter it owes at once and
 * writes its rows in one statement when the last search settles; a composed
 * chapter waits only for its own chapter's search, and reads the rows settled
 * so far from memory until that statement lands.
 */
export type ChapterResearchReadiness = {
  /** The expansion has started for these chapters (all of them without a scope). */
  started(scope: ChapterResearchScope | undefined, expansion: Promise<unknown>): void;
  /** One query of the expansion settled, with the rows it will write (none for a failed search). */
  onQuery(query: string, rows: readonly ResearchSource[]): void;
  /** Settles once chapter N's own search has, or the expansion is over, or it never searches for N. */
  readyFor(chapterIndex: number): Promise<void>;
  /** Rows settled and not yet written. */
  pendingRows(): ResearchSource[];
};

export function chapterResearchReadiness(plan: Pick<BookPlan, "title" | "chapters">): ChapterResearchReadiness {
  const queryChapter = new Map(plan.chapters.map((chapter) => [chapterResearchQuery(plan, chapter), chapter.index]));
  const waiting = new Map<number, { promise: Promise<void>; resolve: () => void }>();
  const pending: ResearchSource[] = [];
  let searched: ReadonlySet<number> | undefined;
  let over: Promise<void> | undefined;
  let written = false;
  const waiterFor = (chapterIndex: number) => {
    let entry = waiting.get(chapterIndex);
    if (!entry) {
      let resolve!: () => void;
      const promise = new Promise<void>((done) => {
        resolve = done;
      });
      entry = { promise, resolve };
      waiting.set(chapterIndex, entry);
    }
    return entry;
  };
  return {
    started(scope, expansion) {
      if (over) return;
      searched = new Set(scope ? scope.chapterIndexes : plan.chapters.map((chapter) => chapter.index));
      over = expansion.then(
        () => undefined,
        () => undefined
      ).finally(() => {
        written = true;
        for (const entry of waiting.values()) entry.resolve();
      });
    },
    onQuery(query, rows) {
      pending.push(...rows);
      const chapterIndex = queryChapter.get(query);
      if (chapterIndex !== undefined) waiterFor(chapterIndex).resolve();
    },
    readyFor(chapterIndex) {
      if (!over || !searched?.has(chapterIndex)) return Promise.resolve();
      return Promise.race([waiterFor(chapterIndex).promise, over]);
    },
    pendingRows: () => (written ? [] : [...pending])
  };
}
