/**
 * Turns a chapter's pages into the two things narration needs: the *segments*
 * the reader sees highlighted, and the *chunks* that are actually sent to the
 * speech provider.
 *
 * They are separate on purpose. A segment is a sentence — the unit a listener
 * follows and taps to seek. A chunk is one TTS request, holding as many whole
 * consecutive segments of one paragraph as fit under the request cap. Because
 * every chunk boundary is a real audio boundary, its timing is measured rather
 * than guessed, and any interpolation error inside a chunk is erased at the next
 * one.
 */

const MAX_CHUNK_CHARS = 400;
const MAX_SEGMENT_CHARS = 360;

export const SENTENCE_PAUSE_MS = 180;
export const PARAGRAPH_PAUSE_MS = 550;
export const TITLE_PAUSE_MS = 900;
export const CHAPTER_TAIL_PAUSE_MS = 700;

/**
 * Characters of speech per second, used only to estimate a chapter's length
 * before it exists. Measured durations replace it the moment a chunk is
 * synthesized, so this only has to be close enough to draw a progress bar.
 */
const NARRATION_CHARS_PER_SECOND = 14.5;

const RTL_LANGUAGES = new Set([
  "ar",
  "arabic",
  "fa",
  "farsi",
  "persian",
  "he",
  "iw",
  "hebrew",
  "ur",
  "urdu",
  "ps",
  "pashto",
  "sd",
  "sindhi",
  "yi",
  "yiddish",
  "dv",
  "ku",
  "kurdish"
]);

export type NarrationSegmentKind = "title" | "sentence";

export type NarrationSegment = {
  index: number;
  kind: NarrationSegmentKind;
  paragraph: number;
  pageIndex: number;
  text: string;
};

export type NarrationChunk = {
  index: number;
  text: string;
  segmentIndexes: number[];
  pauseAfterMs: number;
};

export type ChapterNarration = {
  chapterIndex: number;
  title: string;
  language: string;
  direction: "ltr" | "rtl";
  segments: NarrationSegment[];
  chunks: NarrationChunk[];
  estimatedDurationMs: number;
};

export type NarrationPage = {
  index: number;
  title?: string | null | undefined;
  markdown: string;
};

export type BuildChapterNarrationOptions = {
  chapterIndex: number;
  title: string;
  language?: string | null | undefined;
  /** Localized word for "Chapter", spoken before the title when it needs one. */
  chapterLabel?: string | undefined;
  pages: NarrationPage[];
};

export function buildChapterNarration(options: BuildChapterNarrationOptions): ChapterNarration {
  const language = options.language?.trim() || "en";
  const segments: NarrationSegment[] = [];
  let paragraphOrdinal = 0;

  const firstPageIndex = options.pages[0]?.index ?? 0;
  const spokenTitle = spokenChapterTitle(options.title, options.chapterIndex, options.chapterLabel);
  if (spokenTitle) {
    segments.push({
      index: segments.length,
      kind: "title",
      paragraph: paragraphOrdinal,
      pageIndex: firstPageIndex,
      text: spokenTitle
    });
    paragraphOrdinal += 1;
  }

  for (const page of options.pages) {
    for (const paragraph of narrationParagraphs(page.markdown)) {
      const sentences = splitIntoSegments(paragraph, language);
      if (sentences.length === 0) {
        continue;
      }
      for (const sentence of sentences) {
        segments.push({
          index: segments.length,
          kind: "sentence",
          paragraph: paragraphOrdinal,
          pageIndex: page.index,
          text: sentence
        });
      }
      paragraphOrdinal += 1;
    }
  }

  const chunks = buildChunks(segments);
  return {
    chapterIndex: options.chapterIndex,
    title: options.title,
    language,
    direction: isRtlLanguage(language) ? "rtl" : "ltr",
    segments,
    chunks,
    estimatedDurationMs: estimateNarrationDurationMs(chunks)
  };
}

/**
 * A rough length for a chapter that has not been narrated yet. The player draws
 * the not-yet-generated tail of its seek bar from this, so it only needs to be
 * in the right neighbourhood.
 */
export function estimateNarrationDurationMs(chunks: NarrationChunk[]): number {
  return chunks.reduce((total, chunk) => {
    const speech = (chunk.text.length / NARRATION_CHARS_PER_SECOND) * 1000;
    return total + speech + chunk.pauseAfterMs;
  }, 0);
}

export function isRtlLanguage(language: string | null | undefined): boolean {
  const normalized = (language ?? "").trim().toLowerCase();
  if (!normalized) {
    return false;
  }
  const base = normalized.split(/[-_]/)[0] ?? normalized;
  return RTL_LANGUAGES.has(normalized) || RTL_LANGUAGES.has(base);
}

/**
 * Markdown reduced to spoken paragraphs: images, code fences, tables and rules
 * are dropped outright, headings keep their words but lose their hashes, and
 * inline emphasis is unwrapped so the narrator does not read asterisks aloud.
 */
export function narrationParagraphs(markdown: string): string[] {
  const withoutBlocks = markdown
    .replace(/```[\s\S]*?```/g, "\n\n")
    .replace(/^\s*<[^>]+>\s*$/gm, "\n\n")
    .replace(/!\[[^\]]*]\([^)]*\)/g, " ");

  return withoutBlocks
    .split(/\n\s*\n+/)
    .map((block) => narrationTextFromBlock(block))
    .filter((block) => block.length > 0);
}

function narrationTextFromBlock(block: string): string {
  const lines = block
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !/^([-*_]\s*){3,}$/.test(line) && !/^\|.*\|$/.test(line));

  return lines
    .map((line) =>
      line
        .replace(/^#{1,6}\s+/, "")
        .replace(/^>\s?/, "")
        .replace(/^[-*+]\s+/, "")
        .replace(/^\d+[.)]\s+/, "")
    )
    .join(" ")
    .replace(/\[([^\]]+)]\([^)]*\)/g, "$1")
    .replace(/(\*\*|__)(.*?)\1/g, "$2")
    .replace(/(\*|_)(.*?)\1/g, "$2")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Sentences, further split when one runs past what a single highlight should
 * cover. Splitting a very long sentence at its clause boundaries also keeps the
 * karaoke line moving instead of parking on a paragraph-sized block.
 */
export function splitIntoSegments(paragraph: string, language: string): string[] {
  return splitSentences(paragraph, language).flatMap((sentence) => splitLongSentence(sentence));
}

function splitSentences(paragraph: string, language: string): string[] {
  const text = paragraph.trim();
  if (!text) {
    return [];
  }

  const segmenter = sentenceSegmenter(language);
  if (segmenter) {
    const parts = [...segmenter.segment(text)]
      .map((entry) => entry.segment.trim())
      .filter((entry) => entry.length > 0);
    if (parts.length > 0) {
      return parts;
    }
  }

  return text
    .split(/(?<=[.!?。！？…]["')\]]?)\s+/u)
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

function sentenceSegmenter(language: string): Intl.Segmenter | undefined {
  if (typeof Intl.Segmenter !== "function") {
    return undefined;
  }
  try {
    return new Intl.Segmenter(language, { granularity: "sentence" });
  } catch {
    try {
      return new Intl.Segmenter(undefined, { granularity: "sentence" });
    } catch {
      return undefined;
    }
  }
}

function splitLongSentence(sentence: string): string[] {
  if (sentence.length <= MAX_SEGMENT_CHARS) {
    return [sentence];
  }

  const pieces: string[] = [];
  let current = "";
  for (const clause of sentence.split(/(?<=[,;:—–])\s+/u)) {
    const candidate = current ? `${current} ${clause}` : clause;
    if (candidate.length <= MAX_SEGMENT_CHARS || !current) {
      current = candidate;
      continue;
    }
    pieces.push(current);
    current = clause;
  }
  if (current) {
    pieces.push(current);
  }

  return pieces.flatMap((piece) => (piece.length <= MAX_SEGMENT_CHARS ? [piece] : hardWrap(piece)));
}

function hardWrap(text: string): string[] {
  const pieces: string[] = [];
  let current = "";
  for (const word of text.split(/\s+/)) {
    const candidate = current ? `${current} ${word}` : word;
    if (candidate.length <= MAX_SEGMENT_CHARS || !current) {
      current = candidate;
      continue;
    }
    pieces.push(current);
    current = word;
  }
  if (current) {
    pieces.push(current);
  }
  return pieces;
}

function buildChunks(segments: NarrationSegment[]): NarrationChunk[] {
  const chunks: NarrationChunk[] = [];
  let pending: NarrationSegment[] = [];

  const flush = () => {
    if (pending.length === 0) {
      return;
    }
    chunks.push({
      index: chunks.length,
      text: pending.map((segment) => segment.text).join(" "),
      segmentIndexes: pending.map((segment) => segment.index),
      pauseAfterMs: SENTENCE_PAUSE_MS
    });
    pending = [];
  };

  for (const segment of segments) {
    const previous = pending[pending.length - 1];
    const startsNewGroup =
      segment.kind === "title" || previous?.kind === "title" || (previous !== undefined && previous.paragraph !== segment.paragraph);
    if (startsNewGroup) {
      flush();
    }

    const projected = pending.reduce((total, entry) => total + entry.text.length + 1, 0) + segment.text.length;
    if (pending.length > 0 && projected > MAX_CHUNK_CHARS) {
      flush();
    }
    pending.push(segment);
  }
  flush();

  return chunks.map((chunk, index) => {
    const next = chunks[index + 1];
    const lastSegment = segments[chunk.segmentIndexes[chunk.segmentIndexes.length - 1] ?? 0];
    const nextSegment = next ? segments[next.segmentIndexes[0] ?? 0] : undefined;
    return { ...chunk, pauseAfterMs: pauseBetween(lastSegment, nextSegment) };
  });
}

function pauseBetween(current: NarrationSegment | undefined, next: NarrationSegment | undefined): number {
  if (!next) {
    return CHAPTER_TAIL_PAUSE_MS;
  }
  if (current?.kind === "title") {
    return TITLE_PAUSE_MS;
  }
  return current && current.paragraph !== next.paragraph ? PARAGRAPH_PAUSE_MS : SENTENCE_PAUSE_MS;
}

function spokenChapterTitle(title: string, chapterIndex: number, chapterLabel: string | undefined): string {
  const clean = title.replace(/\s+/g, " ").trim();
  const label = chapterLabel?.trim();
  if (!clean) {
    return label ? `${label} ${chapterIndex}` : "";
  }
  if (!label || new RegExp(`^${escapeRegExp(label)}\\b`, "i").test(clean)) {
    return clean;
  }
  return `${label} ${chapterIndex}. ${clean}`;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
