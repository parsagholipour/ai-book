import { countReadableWords } from "../generation/proseShape.js";
import type { StudioLayout } from "../schemas/mediaSettings.js";

/**
 * Text rules for an author's working copy in the Writing Studio.
 *
 * The working copy is plain markdown — the same markdown the book's pages,
 * the compile and every edit tool already speak — so these helpers only
 * normalize what an editor or a paste can smuggle in, and measure it. They
 * never rewrite the author's words: no heading, "Page N" line or title line is
 * removed here (`normalizeChapterMarkdown` does that for model output, and must
 * never see an author's chapter).
 */

/**
 * The picture-book layout's page boundary: a line on its own. Only the working
 * copy carries it — publish splits on it, so it never reaches `Page.markdown`
 * or the compiled book.
 */
export const MANUSCRIPT_PAGE_SEPARATOR = "<!-- page -->";

const SEPARATOR_LINE = /^\s*<!--\s*page\s*-->\s*$/i;
const RAW_PAGE_BREAK_LINE = /^\s*<div\b[^>]*class=["'][^"']*\bpage-break\b[^"']*["'][^>]*>\s*(?:<\/div>)?\s*$/i;
const FENCE_LINE = /^\s{0,3}(```|~~~)/;
const IMAGE_LINE = /^\s*!\[[^\]]*\]\([^)\s]+(?:\s+"[^"]*")?\)\s*$/;
const PLACEHOLDER = /\b(?:TODO|TBD|FIXME|XXX)\b|\[(?:placeholder|insert[^\]]*)\]|lorem ipsum/gi;

export function isManuscriptPageSeparatorLine(line: string): boolean {
  return SEPARATOR_LINE.test(line);
}

export function isManuscriptImageLine(line: string): boolean {
  return IMAGE_LINE.test(line);
}

/**
 * Line endings, trailing spaces, runs of blank lines, and raw page-break markup
 * a paste can carry. Raw `<div class="page-break">` fails the export's
 * book-like-markdown check, so it becomes the picture layout's separator, or a
 * paragraph break in the flow layout (which has no mid-chapter page break).
 * Fenced blocks are copied through untouched. Idempotent.
 */
export function normalizeManuscriptMarkdown(markdown: string, layout: StudioLayout = "flow"): string {
  const lines = markdown.replace(/\r\n?/g, "\n").replace(/\u0000/g, "").split("\n");
  const kept: string[] = [];
  let fence: string | undefined;
  for (const rawLine of lines) {
    const fenceMatch = rawLine.match(FENCE_LINE);
    if (fence) {
      kept.push(rawLine);
      if (fenceMatch && fenceMatch[1] === fence) fence = undefined;
      continue;
    }
    if (fenceMatch) {
      fence = fenceMatch[1];
      kept.push(rawLine.replace(/[ \t]+$/, ""));
      continue;
    }
    const line = rawLine.replace(/[ \t]+$/, "");
    if (RAW_PAGE_BREAK_LINE.test(line) || SEPARATOR_LINE.test(line)) {
      kept.push("", layout === "picture" ? MANUSCRIPT_PAGE_SEPARATOR : "", "");
      continue;
    }
    kept.push(line);
  }
  return collapseBlankRuns(kept).trim();
}

function collapseBlankRuns(lines: string[]): string {
  const out: string[] = [];
  let fence: string | undefined;
  let blanks = 0;
  for (const line of lines) {
    const fenceMatch = line.match(FENCE_LINE);
    if (fence) {
      out.push(line);
      if (fenceMatch && fenceMatch[1] === fence) fence = undefined;
      continue;
    }
    if (fenceMatch) fence = fenceMatch[1];
    if (line.trim() === "") {
      blanks += 1;
      if (blanks <= 1) out.push("");
      continue;
    }
    blanks = 0;
    out.push(line);
  }
  return out.join("\n");
}

/** The prose an author wrote: no image lines, fences or page separators. */
export function manuscriptProse(markdown: string): string {
  const out: string[] = [];
  let fence: string | undefined;
  for (const line of markdown.replace(/\r\n?/g, "\n").split("\n")) {
    const fenceMatch = line.match(FENCE_LINE);
    if (fence) {
      if (fenceMatch && fenceMatch[1] === fence) fence = undefined;
      continue;
    }
    if (fenceMatch) {
      fence = fenceMatch[1];
      continue;
    }
    if (IMAGE_LINE.test(line) || SEPARATOR_LINE.test(line)) continue;
    out.push(line);
  }
  return out.join("\n");
}

/** Words the author wrote, counted the way the rest of the product counts them. */
export function manuscriptWordCount(markdown: string): number {
  return countReadableWords(stripInlineMarkdown(manuscriptProse(markdown)));
}

/** A plain-text opening of the chapter, for outlines and cards. */
export function manuscriptExcerpt(markdown: string, max = 160): string {
  const text = stripInlineMarkdown(manuscriptProse(markdown)).replace(/\s+/g, " ").trim();
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const space = cut.lastIndexOf(" ");
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

function stripInlineMarkdown(text: string): string {
  return text
    .replace(/^\s{0,3}#{1,6}\s+/gm, "")
    .replace(/^\s{0,3}>\s?/gm, "")
    .replace(/^\s*(?:[-*+]|\d+[.)])\s+/gm, "")
    .replace(/^\s*(?:\*\s*){3,}$|^\s*(?:-\s*){3,}$|^\s*(?:_\s*){3,}$/gm, "")
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/(\*\*|__|\*|_|~~|`)/g, "");
}

/** Placeholder text an author may have left behind, as the matched snippets. */
export function manuscriptPlaceholderIssues(markdown: string): string[] {
  const prose = manuscriptProse(markdown);
  const hits = new Set<string>();
  for (const match of prose.matchAll(PLACEHOLDER)) {
    hits.add(match[0]);
    if (hits.size >= 5) break;
  }
  return [...hits];
}

/** Whether a fenced block is opened and never closed. */
export function hasUnclosedFence(markdown: string): boolean {
  return unclosedFenceMarker(markdown) !== undefined;
}

/** The marker (``` or ~~~) of a fence left open at the end, if any. */
export function unclosedFenceMarker(markdown: string): string | undefined {
  let fence: string | undefined;
  for (const line of markdown.replace(/\r\n?/g, "\n").split("\n")) {
    const fenceMatch = line.match(FENCE_LINE);
    if (!fenceMatch) continue;
    if (!fence) fence = fenceMatch[1];
    else if (fenceMatch[1] === fence) fence = undefined;
  }
  return fence;
}
