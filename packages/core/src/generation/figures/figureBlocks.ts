import { countReadableWords } from "../proseShape.js";
import { FIGURE_FENCE_TAG, canonicalFigureFence, parseFigureSpec, type FigureSpec } from "./figureSpec.js";

/**
 * Finding, hiding and restoring figure blocks in chapter and page markdown.
 *
 * Every model call after the compose call is blind to a figure's markup: the
 * editor and the read see a one-line stand-in (`[Figure: title]`), the
 * measures see no block at all, and the real block is spliced back next to
 * the paragraph it followed. That is what keeps a figure from costing the
 * writer any focus — a fenced JSON object shown to a line editor is a thing
 * to imitate, misquote or "improve". Nothing here imports the renderer, so
 * `chapterPagination.ts` can weigh a block without a cycle.
 */

/** How much of a page a chart occupies, in the words of prose it displaces. */
export const FIGURE_WORD_EQUIVALENT = 140;

const OPENER = "```" + FIGURE_FENCE_TAG;

/** A fresh regex per call: a shared global regex carries `lastIndex` between callers. */
function figureFenceRe(): RegExp {
  return new RegExp("^[ \\t]{0,3}" + OPENER + "[ \\t]*\\r?\\n([\\s\\S]*?)\\r?\\n[ \\t]{0,3}```[ \\t]*$", "gm");
}

const WHOLE_FENCE_RE = new RegExp("^" + OPENER + "[ \\t]*\\r?\\n[\\s\\S]*?\\r?\\n```[ \\t]*$");
const STAND_IN_RE = /^[ \t]*\[figure:[^\n]*\][ \t]*$/i;
const TITLE_KEY_RE = /"title"\s*:\s*"((?:[^"\\]|\\.)*)"/;

export type FigureFence = {
  /** The whole block, opener to closer, as it sits in the markdown. */
  raw: string;
  body: string;
  start: number;
  end: number;
  /** The parsed figure when the body is one; a parsed body is what the renderer draws. */
  spec: FigureSpec | undefined;
  /** What the figure is called, for the stand-in: the parsed title, else the JSON's title key, else nothing. */
  title: string | undefined;
};

export function findFigureFences(markdown: string): FigureFence[] {
  const fences: FigureFence[] = [];
  for (const match of markdown.matchAll(figureFenceRe())) {
    const body = match[1] ?? "";
    const parsed = parseFigureSpec(body);
    const title = parsed.spec?.title ?? body.match(TITLE_KEY_RE)?.[1]?.replace(/\\(.)/g, "$1");
    fences.push({
      raw: match[0],
      body,
      start: match.index ?? 0,
      end: (match.index ?? 0) + match[0].length,
      spec: parsed.spec,
      title: title?.replace(/\s+/g, " ").trim() || undefined
    });
  }
  return fences;
}

export function hasFigureFence(markdown: string): boolean {
  return figureFenceRe().test(markdown);
}

/** Whether a blank-line-separated block is exactly one figure fence. */
export function isFigureFenceBlock(block: string): boolean {
  return WHOLE_FENCE_RE.test(block.trim());
}

export function isFigureStandIn(block: string): boolean {
  return STAND_IN_RE.test(block.trim());
}

/** The line a prose pass sees where a figure sits. Model-facing only; the manuscript never stores it. */
export function figureStandIn(title: string | undefined): string {
  const name = (title ?? "").replace(/\s+/g, " ").replace(/[[\]]/g, "").trim();
  return `[Figure: ${name || "figure"}]`;
}

function collapseBlankLines(markdown: string): string {
  return markdown.replace(/\r\n?/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

/** The markdown with every figure block removed: what a measure reads. */
export function figureFreeProse(markdown: string): string {
  if (!hasFigureFence(markdown)) return markdown;
  return collapseBlankLines(markdown.replace(figureFenceRe(), ""));
}

/** The markdown with every figure block replaced by its stand-in line: what a read-only prose call sees. */
export function figureStandInMarkdown(markdown: string): string {
  if (!hasFigureFence(markdown)) return markdown;
  const fences = findFigureFences(markdown);
  let cursor = 0;
  let out = "";
  for (const fence of fences) {
    out += markdown.slice(cursor, fence.start) + figureStandIn(fence.title);
    cursor = fence.end;
  }
  out += markdown.slice(cursor);
  return collapseBlankLines(out);
}

/** Readable words of the prose alone: a chart's JSON keys are not words the chapter wrote. */
export function proseWordCount(markdown: string): number {
  return countReadableWords(figureFreeProse(markdown));
}

export type AnchoredFigureFence = {
  /** The block to put back, exactly as it was taken out. */
  fence: string;
  standIn: string;
  /** The prose paragraph the block followed, when there was one. */
  anchor: string | undefined;
  /** The prose paragraph the block preceded, when there was one. */
  follower: string | undefined;
};

function splitBlocks(markdown: string): string[] {
  return markdown
    .replace(/\r\n?/g, "\n")
    .split(/\n[ \t]*\n+/)
    .map((block) => block.trim())
    .filter((block) => block.length > 0);
}

function neighbouringProse(blocks: string[], fromEnd: boolean): string | undefined {
  const ordered = fromEnd ? [...blocks].reverse() : blocks;
  return ordered.find((block) => !isFigureFenceBlock(block) && !isFigureStandIn(block));
}

/**
 * Takes every figure out of the markdown, leaving its stand-in, and remembers
 * the paragraphs on either side so `reinsertFigureFences` can find the place
 * again after a pass has rewritten the prose around it.
 */
export function stripFigureFences(markdown: string): { prose: string; fences: AnchoredFigureFence[] } {
  const found = findFigureFences(markdown);
  if (found.length === 0) {
    return { prose: markdown, fences: [] };
  }
  const fences = found.map((fence) => ({
    fence: fence.raw.trim(),
    standIn: figureStandIn(fence.title),
    anchor: neighbouringProse(splitBlocks(markdown.slice(0, fence.start)), true),
    follower: neighbouringProse(splitBlocks(markdown.slice(fence.end)), false)
  }));
  return { prose: figureStandInMarkdown(markdown), fences };
}

function normalisedLine(text: string): string {
  return text.toLowerCase().replace(/\s+/g, " ").trim();
}

function firstSentenceKey(block: string): string {
  const plain = block.replace(/[*_>`#]/g, " ").replace(/\s+/g, " ").trim();
  const sentence = plain.match(/^(.*?[.!?…؟。])(\s|$)/u)?.[1] ?? plain;
  return sentence.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

function tokenSet(text: string): Set<string> {
  return new Set(text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []);
}

const MIN_OVERLAP = 0.25;

/** The block that is the remembered paragraph after an edit: same first sentence, else the best token overlap. */
function bestMatch(blocks: readonly string[], target: string): number {
  const candidates = blocks.map((block, index) => ({ block, index })).filter(({ block }) => !isFigureFenceBlock(block) && !isFigureStandIn(block));
  const key = firstSentenceKey(target);
  if (key) {
    const exact = candidates.find(({ block }) => firstSentenceKey(block) === key);
    if (exact) return exact.index;
  }
  const targetTokens = tokenSet(target);
  if (targetTokens.size === 0) return -1;
  let best = -1;
  let bestScore = 0;
  for (const { block, index } of candidates) {
    const tokens = tokenSet(block);
    let shared = 0;
    for (const token of tokens) if (targetTokens.has(token)) shared += 1;
    const score = shared / (tokens.size + targetTokens.size - shared);
    if (score > bestScore) {
      bestScore = score;
      best = index;
    }
  }
  return bestScore >= MIN_OVERLAP ? best : -1;
}

/**
 * Puts the figures back into prose a pass has rewritten. A stand-in the pass
 * kept is replaced where it stands; a figure whose stand-in is gone goes back
 * after the paragraph it followed, else before the one it preceded, else at
 * the end. Every stand-in line the pass echoed is removed, so nothing
 * model-facing reaches the manuscript. No figures: the prose comes back
 * byte for byte.
 */
export function reinsertFigureFences(prose: string, fences: readonly AnchoredFigureFence[]): string {
  if (fences.length === 0) return prose;
  const blocks = splitBlocks(prose);
  const pending: AnchoredFigureFence[] = [];
  for (const fence of fences) {
    const key = normalisedLine(fence.standIn);
    const at = blocks.findIndex((block) => isFigureStandIn(block) && normalisedLine(block) === key);
    if (at >= 0) {
      blocks[at] = fence.fence;
    } else {
      pending.push(fence);
    }
  }
  for (const fence of pending) {
    const anchorAt = fence.anchor ? bestMatch(blocks, fence.anchor) : -1;
    if (anchorAt >= 0) {
      blocks.splice(anchorAt + 1, 0, fence.fence);
      continue;
    }
    const followerAt = fence.follower ? bestMatch(blocks, fence.follower) : -1;
    if (followerAt >= 0) {
      blocks.splice(followerAt, 0, fence.fence);
      continue;
    }
    blocks.push(fence.fence);
  }
  return blocks.filter((block) => !isFigureStandIn(block)).join("\n\n");
}

export type FigureValidation = {
  markdown: string;
  kept: number;
  dropped: Array<{ reason: string; excerpt: string }>;
};

/**
 * Every figure block a chapter came back with, checked: an unreadable one is
 * removed, a valid one is re-serialised to its canonical single line with a
 * blank line on either side, and any beyond `max` is removed as over the
 * plan. A chapter whose blocks are already canonical comes back byte for byte.
 */
export function validateFigureFences(markdown: string, options: { max: number }): FigureValidation {
  const fences = findFigureFences(markdown);
  if (fences.length === 0) {
    return { markdown, kept: 0, dropped: [] };
  }
  const dropped: FigureValidation["dropped"] = [];
  let kept = 0;
  let cursor = 0;
  let out = "";
  let changed = false;
  for (const fence of fences) {
    const parsed = fence.spec ? { spec: fence.spec } : parseFigureSpec(fence.body);
    const excerpt = fence.body.replace(/\s+/g, " ").trim().slice(0, 120);
    let replacement: string;
    if (!parsed.spec) {
      dropped.push({ reason: parsed.error ?? "unreadable", excerpt });
      replacement = "";
    } else if (kept >= options.max) {
      dropped.push({ reason: options.max === 0 ? "no figure was planned for this chapter" : "over the planned count", excerpt });
      replacement = "";
    } else {
      kept += 1;
      replacement = canonicalFigureFence(parsed.spec);
    }
    if (replacement !== fence.raw) changed = true;
    out += markdown.slice(cursor, fence.start) + (replacement ? `\n\n${replacement}\n\n` : "\n\n");
    cursor = fence.end;
  }
  out += markdown.slice(cursor);
  const normalised = collapseBlankLines(out);
  return { markdown: changed || normalised !== markdown ? normalised : markdown, kept, dropped };
}

/** How many words of prose a figure block stands for when a chapter is cut into pages. */
export function figureWordEquivalent(figure: FigureSpec | string): number {
  const spec = typeof figure === "string" ? (findFigureFences(figure)[0]?.spec ?? parseFigureSpec(figure).spec) : figure;
  if (!spec) {
    return typeof figure === "string" ? countReadableWords(figure) : FIGURE_WORD_EQUIVALENT;
  }
  if (spec.kind !== "flow") return FIGURE_WORD_EQUIVALENT;
  const layers = Math.ceil(spec.nodes.length / 2);
  return Math.min(320, Math.max(100, Math.round((FIGURE_WORD_EQUIVALENT * layers) / 4)));
}

const FIGURE_WORDS =
  /\b(?:chart|figure|graph|diagram|flowchart|plot|infographic)s?\b|نمودار|شکل|جدول|gráfic|graphique|diagramm|grafico|график|диаграмм|图表|图|グラフ|図|차트|그래프/iu;

/** Whether a reader's edit request is about the figure itself, so a rewrite may change or drop it. */
export function mentionsFigure(text: string): boolean {
  return FIGURE_WORDS.test(text);
}
