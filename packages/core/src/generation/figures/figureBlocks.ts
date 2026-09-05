import { countReadableWords } from "../proseShape.js";
import { FIGURE_FENCE_TAG, canonicalFigureFence, parseFigureSpec, type FigureKind, type FigureSpec } from "./figureSpec.js";

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

/**
 * A fresh regex per call: a shared global regex carries `lastIndex` between
 * callers. `figure` is the fence language; an info string after it still
 * counts (` ```figure json `). `(?![\p{L}])` keeps ` ```figures ` out.
 */
function figureOpenerRe(): RegExp {
  return new RegExp("^[ \\t]{0,3}" + OPENER + "(?![\\p{L}])[^\\r\\n]*(?:\\r?\\n|$)", "gmu");
}

function figureCloserRe(): RegExp {
  return /^[ \t]{0,3}```[ \t]*$/gm;
}

const STAND_IN_PATTERN = "^[ \\t]*\\[figure:[^\\n]*\\][ \\t]*$";
/** A fresh regex per call: a shared global regex carries `lastIndex` between callers. */
function standInLineRe(flags: string): RegExp {
  return new RegExp(STAND_IN_PATTERN, flags);
}
const TITLE_KEY_RE = /"title"\s*:\s*"((?:[^"\\]|\\.)*)"/;

export type FigureFence = {
  /** The whole block, opener to closer (or to the next blank line, next opener or EOF when unterminated). */
  raw: string;
  body: string;
  start: number;
  end: number;
  /** False when the opener never met a closer before the next fence, blank paragraph, or EOF. */
  closed: boolean;
  /** The parsed figure when the body is one; a parsed body is what the renderer draws. */
  spec: FigureSpec | undefined;
  /** What the figure is called, for the stand-in: the parsed title, else the JSON's title key, else nothing. */
  title: string | undefined;
};

function nextFigureOpener(markdown: string, from: number): { start: number; bodyStart: number } | undefined {
  const openerRe = figureOpenerRe();
  openerRe.lastIndex = from;
  const match = openerRe.exec(markdown);
  if (!match || match.index === undefined) return undefined;
  return { start: match.index, bodyStart: match.index + match[0].length };
}

function fenceBodyEnd(markdown: string, closerAt: number, bodyStart: number): number {
  let bodyEnd = closerAt;
  if (bodyEnd > bodyStart && markdown[bodyEnd - 1] === "\n") {
    bodyEnd -= 1;
    if (bodyEnd > bodyStart && markdown[bodyEnd - 1] === "\r") bodyEnd -= 1;
  }
  return bodyEnd;
}

/** First blank line after the opener, else the next figure opener or EOF. */
function unterminatedFenceEnd(markdown: string, bodyStart: number, hardLimit: number): number {
  const region = markdown.slice(bodyStart, hardLimit);
  const blank = region.search(/\r?\n[ \t]*\r?\n/);
  return blank < 0 ? hardLimit : bodyStart + blank;
}

export function findFigureFences(markdown: string): FigureFence[] {
  const fences: FigureFence[] = [];
  let from = 0;
  while (from < markdown.length) {
    const opener = nextFigureOpener(markdown, from);
    if (!opener) break;
    const next = nextFigureOpener(markdown, opener.bodyStart);
    const hardLimit = next?.start ?? markdown.length;
    const region = markdown.slice(opener.bodyStart, hardLimit);
    const closer = figureCloserRe().exec(region);
    const closed = Boolean(closer);
    const closerAt = closer ? opener.bodyStart + closer.index : 0;
    // An unclosed fence is its own paragraph, not the rest of the chapter: a
    // missing closer used to run to EOF and validation then dropped every
    // following page of prose with it.
    const end = closer ? closerAt + closer[0].length : unterminatedFenceEnd(markdown, opener.bodyStart, hardLimit);
    const body = markdown.slice(
      opener.bodyStart,
      closer ? fenceBodyEnd(markdown, closerAt, opener.bodyStart) : end
    );
    const parsed = parseFigureSpec(body);
    const title = parsed.spec?.title ?? body.match(TITLE_KEY_RE)?.[1]?.replace(/\\(.)/g, "$1");
    fences.push({
      raw: markdown.slice(opener.start, end),
      body,
      start: opener.start,
      end,
      closed,
      spec: parsed.spec,
      title: title?.replace(/\s+/g, " ").trim() || undefined
    });
    from = end > opener.start ? end : opener.start + 1;
  }
  return fences;
}

export function hasFigureFence(markdown: string): boolean {
  return figureOpenerRe().test(markdown);
}

/** Whether a blank-line-separated block is exactly one figure fence. */
export function isFigureFenceBlock(block: string): boolean {
  const trimmed = block.trim();
  const fences = findFigureFences(trimmed);
  return fences.length === 1 && fences[0]!.start === 0 && fences[0]!.end === trimmed.length;
}

export function isFigureStandIn(block: string): boolean {
  return standInLineRe("i").test(block.trim());
}

/** The line a prose pass sees where a figure sits. Model-facing only; the manuscript never stores it. */
export function figureStandIn(title: string | undefined): string {
  const name = (title ?? "").replace(/\s+/g, " ").replace(/[[\]]/g, "").trim();
  return `[Figure: ${name || "figure"}]`;
}

function collapseBlankLines(markdown: string): string {
  return markdown.replace(/\r\n?/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

/**
 * One walk of the prose around figure fences. `figureFreeProse` drops the
 * blocks, `figureStandInMarkdown` replaces them, and an exact replacement
 * rewrites only the spans — three callers, one cursor.
 */
export function mapFigureRegions(
  markdown: string,
  mapProse: (span: string) => string,
  mapFence: (fence: FigureFence) => string
): string {
  const fences = findFigureFences(markdown);
  if (fences.length === 0) return mapProse(markdown);
  let cursor = 0;
  let out = "";
  for (const fence of fences) {
    out += mapProse(markdown.slice(cursor, fence.start));
    out += mapFence(fence);
    cursor = fence.end;
  }
  return out + mapProse(markdown.slice(cursor));
}

/** The markdown with every figure block removed: what a measure reads. */
export function figureFreeProse(markdown: string): string {
  const rewritten = mapFigureRegions(markdown, (span) => span, () => "");
  return rewritten === markdown ? markdown : collapseBlankLines(rewritten);
}

/** The markdown with every figure block replaced by its stand-in line: what a read-only prose call sees. */
export function figureStandInMarkdown(markdown: string): string {
  if (!hasFigureFence(markdown)) return markdown;
  return collapseBlankLines(mapFigureRegions(markdown, (span) => span, (fence) => figureStandIn(fence.title)));
}

/**
 * The markdown with every figure block and every stand-in line removed: what a
 * per-page path may store. Only a composed chapter is written with the
 * syntax, so a block in a page draft is a fabrication, and a stand-in is
 * model-facing — a page writer shown one in a neighbour's excerpt may echo it.
 */
export function figureAndStandInFreeProse(markdown: string): string {
  const prose = figureFreeProse(markdown);
  const standIn = standInLineRe("gim");
  if (!standIn.test(prose)) return prose;
  standIn.lastIndex = 0;
  return collapseBlankLines(prose.replace(standIn, ""));
}

/**
 * A per-page model draft as the pipeline may use it: `figureAndStandInFreeProse` over its
 * markdown, the same object when there was nothing to remove. Applied where
 * the draft is parsed (`generatePageDraft`, `polishPageDraft`,
 * `revisePageDraft`, the tools writer), so no review, audit or revision after
 * it ever reads a figure a page writer invented.
 */
export function figureFreeDraft<Draft extends { markdown: string }>(draft: Draft): Draft {
  const markdown = figureAndStandInFreeProse(draft.markdown);
  return markdown === draft.markdown ? draft : { ...draft, markdown };
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

export function normalisedFigureText(text: string): string {
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
 * the end. Every stand-in line the pass echoed is removed, and so is every
 * fence the pass invented — the prose it was handed held stand-ins only, so a
 * block in what came back is not one of ours, and an unrelated rewrite used
 * to store the original beside the invention. Nothing model-facing reaches
 * the manuscript. Prose with nothing to remove and nothing to put back comes
 * back byte for byte.
 */
export function reinsertFigureFences(prose: string, fences: readonly AnchoredFigureFence[]): string {
  if (fences.length === 0) return figureAndStandInFreeProse(prose);
  const blocks = splitBlocks(figureFreeProse(prose));
  const pending: AnchoredFigureFence[] = [];
  for (const fence of fences) {
    const key = normalisedFigureText(fence.standIn);
    const at = blocks.findIndex((block) => isFigureStandIn(block) && normalisedFigureText(block) === key);
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
 * Every figure block a chapter came back with, checked: an unterminated or
 * unreadable one is removed, a valid one whose kind is not the planned kind
 * is removed when a kind was given, a valid one is re-serialised to its
 * canonical single line with a blank line on either side, and any beyond
 * `max` is removed as over the plan. A chapter whose blocks are already
 * canonical comes back byte for byte. Chat rewrites pass `{ max: 1 }` with
 * no kind and keep today's count-only behaviour.
 */
export function validateFigureFences(markdown: string, options: { max: number; kind?: FigureKind }): FigureValidation {
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
    if (!fence.closed) {
      dropped.push({ reason: "unterminated", excerpt });
      replacement = "";
    } else if (!parsed.spec) {
      dropped.push({ reason: parsed.error ?? "unreadable", excerpt });
      replacement = "";
    } else if (options.kind !== undefined && parsed.spec.kind !== options.kind) {
      dropped.push({ reason: `planned ${options.kind}, got ${parsed.spec.kind}`, excerpt });
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

/** The figures a page carries, parsed; the ones a request may name by title. */
export function pageFigureSpecs(markdown: string): FigureSpec[] {
  if (!hasFigureFence(markdown)) return [];
  return findFigureFences(markdown).flatMap((fence) => (fence.spec ? [fence.spec] : []));
}
