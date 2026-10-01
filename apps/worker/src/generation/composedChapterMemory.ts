import {
  PREVIOUS_CHAPTER_TAIL_WORDS,
  chapterTail,
  extractChapterFacts,
  type ChapterComposition,
  type ChapterFact,
  type ChapterFactDrops,
  type EarlierChapterDigest,
  type TextModelAdapter
} from "@book-maker/core";
import type { RunLogger } from "../providers/runLogging.js";
import { isStopRequestedError, type ChapterSetup } from "../runtime/jobTypes.js";

/**
 * What a composed chapter is told about the chapters before it, and only
 * those: the previous chapter's tail, every earlier chapter's digest and
 * edges, the notes their pages were described with, and the continuity
 * ledger. Everything here is keyed by chapter index and read below the
 * chapter being written, because a resumed run can hold a chapter that was
 * checkpointed ahead of its failed neighbour (`composedResumeState` takes done
 * chapters as a set), and the neighbour's redo must not be told what the later
 * chapter wrote. The page notes used to be one list every finished chapter
 * pushed onto, so that redo was handed them.
 */
export type EarlierChapterMemory = {
  setups: readonly ChapterSetup[];
  finalText: ReadonlyMap<number, string>;
  digests: ReadonlyMap<number, string>;
  provisionalDigests: ReadonlyMap<number, string>;
  edges: ReadonlyMap<number, { opening: string; closing: string }>;
  /** The notes each chapter's pages were described with, by chapter. */
  notes: ReadonlyMap<number, readonly string[]>;
  compositionFor: (setup: ChapterSetup) => ChapterComposition;
};

export function earlierChapterContext(setup: ChapterSetup, memory: EarlierChapterMemory, drafts: ReadonlyMap<number, string>) {
  const earlier = memory.setups.filter((candidate) => candidate.chapter.index < setup.chapter.index);
  const previous = earlier.at(-1);
  const previousText = previous ? drafts.get(previous.chapter.index) ?? memory.finalText.get(previous.chapter.index) : undefined;
  const earlierChapters: EarlierChapterDigest[] = earlier.map((candidate) => {
    const digest = memory.digests.get(candidate.chapter.index) ?? memory.provisionalDigests.get(candidate.chapter.index) ?? candidate.chapter.summary;
    const told = [...new Set(memory.compositionFor(candidate).sections.flatMap((section) => section.owns ?? []))];
    return {
      index: candidate.chapter.index,
      title: candidate.chapter.title,
      // Sixty words: 11k characters of digests rode in every call before.
      digest: digest.split(/\s+/).slice(0, 60).join(" "),
      ...(told.length > 0 ? { told } : {})
    };
  });
  return {
    ...(previousText ? { previousChapterTail: chapterTail(previousText, PREVIOUS_CHAPTER_TAIL_WORDS) } : {}),
    earlierChapters,
    earlierOpenings: earlier.map((candidate) => memory.edges.get(candidate.chapter.index)?.opening ?? "").filter(Boolean),
    earlierClosings: earlier.map((candidate) => memory.edges.get(candidate.chapter.index)?.closing ?? "").filter(Boolean),
    earlierNotes: earlier.flatMap((candidate) => memory.notes.get(candidate.chapter.index) ?? [])
  };
}

/**
 * The continuity ledger (core `chapterFacts.ts`). A chapter's facts are read
 * off its composed draft the moment the draft is validated, and the next
 * chapter's compose waits for them: that wait is the ledger's whole cost on
 * the critical path, 2.5–4.7 s a chapter on the 2026-09-30 Quick Draft books.
 * Composing chapter N from chapters up to N-2 only would have cost nothing and
 * missed three of the seven contradictions those books printed, each between
 * neighbours.
 *
 * `record` chains on the chapters below it, whose facts are the extraction's
 * `knownFacts`; `before` never returns a chapter at or above the one asked
 * about, whatever a resumed run seeded. A failed extraction is a chapter the
 * ledger knows nothing about (`of` answers undefined, so a resume tries it
 * again); a stop travels.
 */
export type ChapterFactLedger = {
  seed(chapterIndex: number, facts: readonly ChapterFact[]): void;
  record(chapterIndex: number, markdown: string): void;
  before(chapterIndex: number): Promise<ChapterFact[]>;
  of(chapterIndex: number): Promise<ChapterFact[] | undefined>;
};

export function chapterFactLedger(options: {
  enabled: boolean;
  projectId: string;
  title: string;
  language?: string | undefined;
  textModel: TextModelAdapter;
  /** The book's last chapter: no chapter reads its facts, so none are taken. */
  lastChapterIndex: number | undefined;
  runLog?: Pick<RunLogger, "append"> | undefined;
}): ChapterFactLedger {
  const entries = new Map<number, Promise<ChapterFact[] | undefined>>();
  const before = async (chapterIndex: number): Promise<ChapterFact[]> => {
    const lower = [...entries].filter(([index]) => index < chapterIndex).sort(([a], [b]) => a - b);
    return (await Promise.all(lower.map(([, facts]) => facts))).flatMap((facts) => facts ?? []);
  };
  return {
    seed: (chapterIndex, facts) => void entries.set(chapterIndex, Promise.resolve([...facts])),
    record(chapterIndex, markdown) {
      if (!options.enabled || chapterIndex === options.lastChapterIndex) return;
      const facts = before(chapterIndex).then(async (known) => {
        const started = Date.now();
        let found: ChapterFact[] | undefined;
        let dropped: ChapterFactDrops | undefined;
        let failure: unknown;
        try {
          ({ facts: found, dropped } = await extractChapterFacts({ title: options.title, chapterIndex, markdown, known, textModel: options.textModel, language: options.language }));
        } catch (error) {
          if (isStopRequestedError(error)) throw error;
          failure = error;
        }
        await options.runLog?.append(found ? "generation.composed_chapters.facts" : "generation.composed_chapters.facts_failed", {
          projectId: options.projectId,
          chapterIndex,
          ms: Date.now() - started,
          ...(found ? { facts: found.length, dropped } : { error: failure instanceof Error ? failure.message : String(failure) })
        }).catch(() => undefined);
        return found;
      });
      // Awaited by the next compose and by this chapter's report; a stop that lands first is not an unhandled rejection.
      facts.catch(() => undefined);
      entries.set(chapterIndex, facts);
    },
    before,
    of: (chapterIndex) => entries.get(chapterIndex) ?? Promise.resolve(undefined)
  };
}
