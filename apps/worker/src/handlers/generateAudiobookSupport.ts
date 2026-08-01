import {
  concatPcm16ChunksWithSilence,
  createDeterministicReaderChapters,
  languageLabel,
  silencePcm16,
  type ChapterNarration,
  type Pcm16AudioChunk
} from "@book-maker/core";

/**
 * The pure parts of narrating a book: how it is divided into chapters, how the
 * pieces are joined, and what the narrator calls a chapter.
 *
 * Split out of the handler so they can be tested without a queue, a database or
 * a provider — the partition in particular is worth pinning down, because a
 * retry that chapters the book differently would renumber audio that is already
 * on disk.
 */

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
