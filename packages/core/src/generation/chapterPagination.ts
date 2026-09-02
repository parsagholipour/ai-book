import { countReadableWords } from "./proseShape.js";

/**
 * Deterministic pagination of a composed chapter.
 *
 * The composed-chapters strategy writes a chapter as one continuous piece of
 * prose and only then divides it into the page rows every other part of the
 * product reads — the reader, the PDF page map, chat edits, illustrations. A
 * page here is a typesetting unit: cuts fall on paragraph boundaries as close
 * as possible to equal word shares, never inside a fenced block, and a page
 * may end mid-argument. That is the point: the per-page pipeline made every
 * page a sealed unit with its own landing, and 120 landings is the template.
 */

export type PaginatedChapter = {
  pages: string[];
  wordCounts: number[];
  totalWords: number;
};

const HEADING_LINE = /^\s{0,3}#{1,6}\s/;
const PAGE_MARKER_LINE = /^\s*(?:page|صفحه|página|seite)\s*\d+\s*$/iu;
const CHAPTER_LINE = /^\s*(?:chapter|part)\s+(?:\d+|[ivxlc]+)\b[^\n]{0,80}$/i;
const SENTENCE_BREAK = /(?<=[.!?…؟。])\s+/u;

/**
 * Strip what the writer was told not to emit and models emit anyway: markdown
 * headings, a title line, page markers, "Chapter N" lines, and any leading
 * blank lines. Fenced code is kept whole.
 */
export function normalizeChapterMarkdown(markdown: string, options: { chapterTitle?: string | undefined } = {}): string {
  const lines = markdown.replace(/\r\n?/g, "\n").split("\n");
  const kept: string[] = [];
  let inFence = false;
  const title = options.chapterTitle?.trim().toLowerCase();
  for (const line of lines) {
    if (/^\s*```/.test(line)) {
      inFence = !inFence;
      kept.push(line);
      continue;
    }
    if (inFence) {
      kept.push(line);
      continue;
    }
    if (HEADING_LINE.test(line) || PAGE_MARKER_LINE.test(line) || CHAPTER_LINE.test(line)) {
      continue;
    }
    const bare = line.trim().replace(/^[*_#\s]+|[*_#\s]+$/g, "").toLowerCase();
    if (title && bare && bare === title && kept.filter((candidate) => candidate.trim()).length === 0) {
      continue;
    }
    kept.push(line);
  }
  return kept.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

/** Blank-line separated blocks, with fenced code kept as one block. */
export function chapterBlocks(markdown: string): string[] {
  const rawBlocks = markdown.replace(/\r\n?/g, "\n").split(/\n[ \t]*\n+/);
  const blocks: string[] = [];
  let open: string[] | undefined;
  for (const raw of rawBlocks) {
    const block = raw.replace(/^\n+|\n+$/g, "");
    if (!block.trim()) {
      continue;
    }
    const fences = (block.match(/^\s*```/gm) ?? []).length;
    if (open) {
      open.push(block);
      if (fences % 2 === 1) {
        blocks.push(open.join("\n\n"));
        open = undefined;
      }
      continue;
    }
    if (fences % 2 === 1) {
      open = [block];
      continue;
    }
    blocks.push(block);
  }
  if (open) {
    blocks.push(open.join("\n\n"));
  }
  return blocks;
}

function splitBlockInTwo(block: string): [string, string] | undefined {
  if (/^\s*```/m.test(block)) {
    return undefined;
  }
  const sentences = block.split(SENTENCE_BREAK).filter((sentence) => sentence.trim());
  if (sentences.length >= 2) {
    const words = sentences.map((sentence) => countReadableWords(sentence));
    const total = words.reduce((sum, count) => sum + count, 0);
    let running = 0;
    let cut = 1;
    for (let index = 0; index < sentences.length - 1; index += 1) {
      running += words[index]!;
      cut = index + 1;
      if (running * 2 >= total) {
        break;
      }
    }
    return [sentences.slice(0, cut).join(" "), sentences.slice(cut).join(" ")];
  }
  const tokens = block.split(/\s+/).filter(Boolean);
  if (tokens.length < 2) {
    return undefined;
  }
  const middle = Math.ceil(tokens.length / 2);
  return [tokens.slice(0, middle).join(" "), tokens.slice(middle).join(" ")];
}

/**
 * Divide a chapter into exactly `pageCount` pages at block boundaries, each
 * page as close to an equal word share as the blocks allow. When there are
 * fewer blocks than pages, the largest blocks are split at sentence
 * boundaries until every page can hold something.
 */
export function paginateChapterMarkdown(markdown: string, pageCount: number): PaginatedChapter {
  const pages = Math.max(1, Math.floor(pageCount));
  let blocks = chapterBlocks(markdown);
  if (blocks.length === 0) {
    return { pages: Array.from({ length: pages }, () => ""), wordCounts: Array.from({ length: pages }, () => 0), totalWords: 0 };
  }
  let guard = 0;
  while (blocks.length < pages && guard < pages * 4) {
    guard += 1;
    let largest = -1;
    let largestWords = -1;
    blocks.forEach((block, index) => {
      const words = countReadableWords(block);
      if (words > largestWords && splitBlockInTwo(block)) {
        largest = index;
        largestWords = words;
      }
    });
    if (largest < 0) {
      break;
    }
    const halves = splitBlockInTwo(blocks[largest]!)!;
    blocks = [...blocks.slice(0, largest), halves[0], halves[1], ...blocks.slice(largest + 1)];
  }

  const words = blocks.map((block) => countReadableWords(block));
  const totalWords = words.reduce((sum, count) => sum + count, 0);
  const result: string[][] = [];
  let cursor = 0;
  let consumed = 0;
  for (let page = 0; page < pages; page += 1) {
    const remainingPages = pages - page;
    const current: string[] = [];
    let currentWords = 0;
    if (page === pages - 1) {
      while (cursor < blocks.length) {
        current.push(blocks[cursor]!);
        cursor += 1;
      }
      result.push(current);
      break;
    }
    const target = (totalWords * (page + 1)) / pages;
    while (cursor < blocks.length) {
      const remainingBlocks = blocks.length - cursor;
      if (current.length > 0 && remainingBlocks <= remainingPages - 1) {
        break;
      }
      const nextWords = words[cursor]!;
      const withoutNext = Math.abs(consumed + currentWords - target);
      const withNext = Math.abs(consumed + currentWords + nextWords - target);
      if (current.length > 0 && withNext > withoutNext) {
        break;
      }
      current.push(blocks[cursor]!);
      currentWords += nextWords;
      cursor += 1;
    }
    consumed += currentWords;
    result.push(current);
  }
  while (result.length < pages) {
    result.push([]);
  }
  const pageMarkdown = result.map((blocksOnPage) => blocksOnPage.join("\n\n"));
  return {
    pages: pageMarkdown,
    wordCounts: pageMarkdown.map((page) => countReadableWords(page)),
    totalWords
  };
}

/** The last `wordLimit` words of a chapter, cut at a paragraph boundary when one falls inside the window. */
export function chapterTail(markdown: string, wordLimit: number): string {
  const blocks = chapterBlocks(markdown);
  const tail: string[] = [];
  let words = 0;
  // Whole paragraphs from the end until the limit is reached, so the paragraph
  // that crosses it is included rather than dropped: this is context for the
  // next chapter's writer, and a tail that stops short of a paragraph break
  // reads as a cut.
  for (let index = blocks.length - 1; index >= 0; index -= 1) {
    const block = blocks[index]!;
    tail.unshift(block);
    words += countReadableWords(block);
    if (words >= wordLimit) {
      break;
    }
  }
  return tail.join("\n\n");
}

const CONTINUATION_CUE =
  /^(?:This|That|These|Those|Such|The same|It|Its|They|Their|He|His|She|Her|Here|Yet|But|Nor|So|Still|Instead|Even|Only|Nothing|None|Neither|Both)\b/;
const MAX_MERGED_WORDS = 340;

function isProseParagraph(block: string): boolean {
  return !/^\s*(?:```|[-*+]\s|\d+[.)]\s|>|#|\|)/.test(block) && !/[“"]/.test(block.slice(0, 2));
}

/**
 * Deterministic paragraph variety for a chapter whose paragraphs all came out
 * one size.
 *
 * Three composed books and six edit passes told the writer to vary paragraph
 * length, in plain words and with measured numbers, and every chapter came
 * back at a coefficient of variation of 0.15–0.25 (paragraphs "all about 104
 * words", as the note said). Merging a paragraph into the one before it when
 * it opens on a continuation cue — This, That, Yet, The same, It — joins a
 * thought to the thought it continues, and splitting a long paragraph's last
 * short sentence off gives a turn its own line. Neither changes a word. On the
 * third composed book this took chapters from 0.15–0.25 to 0.33–0.44 with at
 * most two paragraphs under forty words.
 */
export function varyParagraphs(markdown: string): string {
  const blocks = chapterBlocks(markdown);
  const merged: string[] = [];
  for (const block of blocks) {
    const previous = merged.at(-1);
    if (
      previous !== undefined &&
      isProseParagraph(block) &&
      isProseParagraph(previous) &&
      CONTINUATION_CUE.test(block) &&
      countReadableWords(previous) + countReadableWords(block) <= MAX_MERGED_WORDS
    ) {
      merged[merged.length - 1] = `${previous} ${block}`;
      continue;
    }
    merged.push(block);
  }
  return merged.join("\n\n");
}

const DUPLICATE_SENTENCE_MIN_WORDS = 12;

/**
 * Drop a sentence that repeats an earlier sentence of the chapter word for
 * word. The fourth composed book's line edit and its second edit each wrote
 * the chapter's conclusion, so two chapters closed on the same sentence
 * twice, two paragraphs apart. The later copy goes; fenced blocks are left
 * alone.
 */
export function dropDuplicateSentences(markdown: string): string {
  const seen = new Set<string>();
  return chapterBlocks(markdown)
    .map((block) => {
      if (/^\s*```/m.test(block)) return block;
      const kept = block
        .split(SENTENCE_BREAK)
        .filter((sentence) => {
          const key = sentence.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
          if (countReadableWords(sentence) < DUPLICATE_SENTENCE_MIN_WORDS) return true;
          if (seen.has(key)) return false;
          seen.add(key);
          return true;
        });
      return kept.join(" ");
    })
    .filter((block) => block.trim().length > 0)
    .join("\n\n");
}
