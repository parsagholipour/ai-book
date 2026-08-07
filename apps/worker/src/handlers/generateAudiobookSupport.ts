import {
  chapterPresentationFor,
  concatPcm16ChunksWithSilence,
  createDeterministicReaderChapters,
  languageLabel,
  silencePcm16,
  type ChapterNarration,
  type Pcm16AudioChunk,
  type SpeechAdapter
} from "@book-maker/core";

/**
 * The parts of narrating a book that need no queue, database or storage: how it
 * is divided into chapters, how the speech requests are scheduled, how the
 * pieces are joined, and what the narrator calls a chapter.
 *
 * Split out of the handler so they can be tested against a stub adapter — the
 * partition in particular is worth pinning down, because a retry that chapters
 * the book differently would renumber audio that is already on disk.
 */

/** In-flight speech requests. Enough to hide latency, low enough to stay under provider rate limits. */
const MAX_PARALLEL_CHUNKS = 3;

export type AudiobookSourcePage = {
  index: number;
  title: string;
  markdown: string;
  chapter: { index: number; title: string } | null;
};

export type AudiobookChapterPlan = {
  index: number;
  title: string;
  pages: Array<{ index: number; title: string; markdown: string }>;
};

/**
 * Chapters come from the book's own `Chapter` rows when it has them, and from
 * the deterministic fallback when it does not (imported manuscripts, short
 * books). Deliberately never the model-driven chaptering the exporter uses: the
 * same book must produce the same chapters on every attempt.
 */
export function audiobookChapterPlans(pages: AudiobookSourcePage[]): AudiobookChapterPlan[] {
  if (pages.length === 0) {
    return [];
  }

  // Every page must know its chapter, or the book is treated as unchaptered —
  // a partial mapping would silently drop the pages that lack one.
  if (pages.every((page) => page.chapter !== null)) {
    const byChapter = new Map<number, AudiobookChapterPlan>();
    for (const page of pages) {
      const chapter = page.chapter!;
      const entry = byChapter.get(chapter.index) ?? { index: chapter.index, title: chapter.title, pages: [] };
      entry.pages.push(bookPage(page));
      byChapter.set(chapter.index, entry);
    }
    return [...byChapter.values()].sort((left, right) => left.index - right.index);
  }

  const readerChapters = createDeterministicReaderChapters(
    pages.map((page) => ({ index: page.index, title: page.title, markdown: page.markdown }))
  );
  if (readerChapters.length === 0) {
    return [{ index: 1, title: "", pages: pages.map(bookPage) }];
  }

  return readerChapters.map((chapter) => ({
    index: chapter.index,
    title: chapter.title,
    pages: pages
      .filter((page) => page.index >= chapter.startPageIndex && page.index <= chapter.endPageIndex)
      .map(bookPage)
  }));
}

function bookPage(page: AudiobookSourcePage) {
  return { index: page.index, title: page.title, markdown: page.markdown };
}

/**
 * Runs a bounded window of speech requests but keeps the results in narration
 * order, because the order is what the timeline's arithmetic depends on.
 *
 * The first failure stops the others. `Promise.all` rejects as soon as one
 * worker throws, but it cannot stop the workers still running — left alone they
 * narrate the rest of a chapter nobody will keep, spending money and burning the
 * per-minute quota that the *next* attempt needs.
 */
export async function synthesizeChunks(options: {
  narration: ChapterNarration;
  voice: string;
  narrator?: string | undefined;
  stylePrompt: string;
  speech: SpeechAdapter;
}): Promise<Pcm16AudioChunk[]> {
  const { chunks } = options.narration;
  const results = Array.from<Pcm16AudioChunk | undefined>({ length: chunks.length });
  let next = 0;
  let failure: unknown;

  const worker = async () => {
    while (failure === undefined) {
      const index = next;
      next += 1;
      const chunk = chunks[index];
      if (!chunk) {
        return;
      }
      try {
        const result = await options.speech.synthesize({
          text: chunk.text,
          voice: options.voice,
          narrator: options.narrator,
          stylePrompt: options.stylePrompt,
          language: options.narration.language
        });
        results[index] = { pcm: result.pcm, sampleRate: result.sampleRate, channels: result.channels };
      } catch (error) {
        failure ??= error;
        return;
      }
    }
  };

  await Promise.all(Array.from({ length: Math.min(MAX_PARALLEL_CHUNKS, chunks.length) }, worker));
  if (failure !== undefined) {
    throw failure;
  }

  return results.map((result, index) => {
    if (!result) {
      throw new Error(`Narration chunk ${index} produced no audio.`);
    }
    return result;
  });
}

/**
 * Joins the synthesized chunks with exactly the pauses the timeline was built
 * from, so the audio and the highlighting cannot drift apart.
 */
export function joinNarrationChunks(chunks: Pcm16AudioChunk[], narration: ChapterNarration): Buffer {
  const first = chunks[0];
  if (!first) {
    return Buffer.alloc(0);
  }

  const parts: Buffer[] = [];
  chunks.forEach((chunk, index) => {
    parts.push(concatPcm16ChunksWithSilence([chunk], 0));
    const pauseMs = narration.chunks[index]?.pauseAfterMs ?? 0;
    if (pauseMs > 0) {
      parts.push(silencePcm16(first, pauseMs));
    }
  });
  return Buffer.concat(parts);
}

/**
 * The word the narrator says before a chapter title, matched to the label the
 * printed book uses so the two tell the same story.
 */
export function spokenChapterLabel(language: string | null | undefined): string {
  return CHAPTER_LABELS[languageLabel(language).toLowerCase()] ?? "Chapter";
}

/**
 * That word again, or `undefined` when the book is too small to have chapters —
 * the same judgement the printed book makes, so a 700-word booklet narrated as
 * three ninety-second parts is not announced as three chapters.
 *
 * Only the spoken words change. The partition stays exactly as
 * {@link audiobookChapterPlans} built it, because `chapter-<n>.mp3` and the
 * READY-skip that lets a failed narration resume are keyed on chapter index —
 * re-chaptering here would renumber audio already on disk.
 */
export function narratedChapterLabel(
  plans: AudiobookChapterPlan[],
  pages: Array<{ index: number }>,
  language: string | null | undefined
): string | undefined {
  const starts = plans.flatMap((plan) => {
    const first = plan.pages[0];
    return first ? [{ pageIndex: first.index }] : [];
  });
  return chapterPresentationFor(starts, pages) === "chapters" ? spokenChapterLabel(language) : undefined;
}

const CHAPTER_LABELS: Record<string, string> = {
  arabic: "الفصل",
  french: "Chapitre",
  german: "Kapitel",
  hindi: "अध्याय",
  italian: "Capitolo",
  persian: "فصل",
  portuguese: "Capítulo",
  russian: "Глава",
  spanish: "Capítulo",
  turkish: "Bölüm",
  urdu: "باب"
};
