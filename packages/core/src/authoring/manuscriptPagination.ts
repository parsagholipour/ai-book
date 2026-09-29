import type { StudioLayout } from "../schemas/mediaSettings.js";
import {
  isManuscriptPageSeparatorLine,
  MANUSCRIPT_PAGE_SEPARATOR,
  normalizeManuscriptMarkdown,
  unclosedFenceMarker
} from "./manuscriptText.js";

/**
 * Cutting an author's chapter into the book's page rows at publish.
 *
 * A page here is a typesetting unit, as it is for composed books: the reader,
 * the page map, chat edits and the audiobook all address `Page` rows, but the
 * PDF flows the whole book. Two rules make the cut invisible in print:
 *
 * - **Cuts fall only between blocks.** The compile trims every page and joins
 *   an author book's page boundaries as paragraph breaks (the `authorManuscript`
 *   compile flag). A cut inside a paragraph, list, quote, table or fence would
 *   print as a break the author never wrote. Only a lone paragraph longer than
 *   four page targets is split, at sentence boundaries, because a single model
 *   page of tens of thousands of characters is worse for every per-page tool.
 * - **A heading never ends a page.** It moves to the page it introduces.
 *
 * The picture layout is the opposite: the author placed every page boundary
 * with a separator line, so nothing else cuts.
 */

const BASE_PAGE_CHARS = 1900;
const MAX_BOOK_PAGES = 600;
const FENCE_LINE = /^\s{0,3}(```|~~~)/;
const HEADING_BLOCK = /^\s{0,3}#{1,6}\s/;
const SENTENCE_BREAK = /(?<=[.!?…؟。！？])\s+/u;

/** Characters per page for a book of this length: at least 1,900, and never more than 600 pages. */
export function manuscriptPageTargetChars(totalChars: number): number {
  return Math.max(BASE_PAGE_CHARS, Math.ceil(Math.max(0, totalChars) / MAX_BOOK_PAGES));
}

type Block = { text: string; kind: "prose" | "heading" | "atomic" };

/**
 * Blank-line separated blocks. A fenced block (``` or ~~~, closed by the same
 * marker) is one block across its blank lines; an unclosed fence runs to the
 * end of the chapter rather than swallowing it silently into prose.
 */
export function manuscriptBlocks(markdown: string): string[] {
  return parseBlocks(markdown).map((block) => block.text);
}

function parseBlocks(markdown: string): Block[] {
  const lines = markdown.replace(/\r\n?/g, "\n").split("\n");
  const blocks: Block[] = [];
  let current: string[] = [];
  let fence: string | undefined;
  const flush = () => {
    const text = current.join("\n").replace(/^\n+|\n+$/g, "");
    current = [];
    if (!text.trim()) return;
    blocks.push({ text, kind: classify(text) });
  };
  for (const line of lines) {
    const fenceMatch = line.match(FENCE_LINE);
    if (fence) {
      current.push(line);
      if (fenceMatch && fenceMatch[1] === fence) {
        fence = undefined;
        flush();
      }
      continue;
    }
    if (fenceMatch) {
      flush();
      fence = fenceMatch[1];
      current.push(line);
      continue;
    }
    if (line.trim() === "") {
      flush();
      continue;
    }
    current.push(line);
  }
  flush();
  return blocks;
}

function classify(text: string): Block["kind"] {
  if (HEADING_BLOCK.test(text) && !text.includes("\n")) return "heading";
  const first = text.trimStart();
  if (FENCE_LINE.test(first)) return "atomic";
  const lines = text.split("\n");
  // Lists, quotes, tables, images and rules are kept whole; a plain paragraph
  // is the only block a sentence split may ever touch.
  if (lines.some((line) => /^\s*(?:[-*+]|\d+[.)])\s+/.test(line) || /^\s{0,3}>/.test(line) || /\|/.test(line))) {
    return "atomic";
  }
  if (/^\s*!\[/.test(first) || /^\s*(?:[*_-]\s*){3,}$/.test(first) || /^\s*</.test(first)) return "atomic";
  return "prose";
}

function splitLongParagraph(text: string, targetChars: number): string[] {
  const sentences = text.split(SENTENCE_BREAK).filter((sentence) => sentence.trim());
  if (sentences.length < 2) return [text];
  const pieces: string[] = [];
  let piece = "";
  for (const sentence of sentences) {
    if (piece && piece.length + sentence.length + 1 > targetChars) {
      pieces.push(piece);
      piece = sentence;
    } else {
      piece = piece ? `${piece} ${sentence}` : sentence;
    }
  }
  if (piece) pieces.push(piece);
  return pieces;
}

/**
 * The page markdown this chapter publishes as. Never an empty page, never a
 * trailing newline — pages are joined by the compile, not by their own ends.
 */
export function paginateManuscriptChapter(
  markdown: string,
  options: { layout: StudioLayout; targetChars?: number }
): string[] {
  const normalized = closeUnclosedFence(normalizeManuscriptMarkdown(markdown, options.layout));
  if (options.layout === "picture") {
    return splitOnSeparators(normalized);
  }
  const target = Math.max(200, options.targetChars ?? BASE_PAGE_CHARS);
  const blocks: Block[] = [];
  for (const block of parseBlocks(normalized)) {
    if (block.kind === "prose" && block.text.length > target * 4) {
      for (const piece of splitLongParagraph(block.text, target)) blocks.push({ text: piece, kind: "prose" });
    } else {
      blocks.push(block);
    }
  }

  const pages: Block[][] = [];
  let page: Block[] = [];
  let length = 0;
  for (const block of blocks) {
    const wouldBe = length + block.text.length + (page.length ? 2 : 0);
    if (page.length && length >= target * 0.5 && wouldBe > target * 1.15) {
      // Carry a trailing heading forward so it opens the page it introduces.
      const carried: Block[] = [];
      while (page.length > 1 && page[page.length - 1]!.kind === "heading") carried.unshift(page.pop()!);
      pages.push(page);
      page = carried;
      length = carried.reduce((sum, item) => sum + item.text.length + 2, 0);
    }
    page.push(block);
    length += block.text.length + (page.length > 1 ? 2 : 0);
  }
  if (page.length) pages.push(page);
  return pages.map((blocksOnPage) => blocksOnPage.map((block) => block.text).join("\n\n")).filter((text) => text.trim());
}

/**
 * A fence the author opened and never closed would swallow every page after
 * it in the compiled book — the rest of this chapter, and every later chapter,
 * printed as code. The working copy keeps the author's text exactly as typed
 * (they may be mid-block); only the published pages get the closing marker, at
 * the end of the chapter it was opened in.
 */
function closeUnclosedFence(markdown: string): string {
  const marker = unclosedFenceMarker(markdown);
  return marker ? `${markdown}\n${marker}` : markdown;
}

function splitOnSeparators(markdown: string): string[] {
  const pages: string[] = [];
  let current: string[] = [];
  const flush = () => {
    const text = current.join("\n").trim();
    if (text) pages.push(text);
    current = [];
  };
  let fence: string | undefined;
  for (const line of markdown.split("\n")) {
    const fenceMatch = line.match(FENCE_LINE);
    if (fence) {
      current.push(line);
      if (fenceMatch && fenceMatch[1] === fence) fence = undefined;
      continue;
    }
    if (fenceMatch) fence = fenceMatch[1];
    if (!fence && isManuscriptPageSeparatorLine(line)) {
      flush();
      continue;
    }
    current.push(line);
  }
  flush();
  return pages;
}

/**
 * The working-copy text of a chapter from its published pages — the inverse of
 * `paginateManuscriptChapter`, and exactly what the author compile prints: a
 * flow chapter's pages meet at a paragraph break, a picture book's at a
 * separator line.
 */
export function joinManuscriptPages(pages: readonly string[], layout: StudioLayout): string {
  const trimmed = pages.map((page) => page.trim()).filter(Boolean);
  const joined = layout === "picture" ? trimmed.join(`\n\n${MANUSCRIPT_PAGE_SEPARATOR}\n\n`) : trimmed.join("\n\n");
  return normalizeManuscriptMarkdown(joined, layout);
}
