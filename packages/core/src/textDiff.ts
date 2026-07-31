/**
 * Word-level prose diffs, for showing a reader what an edit changed.
 *
 * A line-oriented diff is the wrong tool here. A book page is a handful of long
 * paragraphs, so changing one word marks the whole paragraph as deleted and
 * re-added, and the reader has to spot the difference themselves. Instead the
 * text is diffed twice: paragraphs against paragraphs to find what moved, then
 * words within a paragraph that was merely rewritten.
 *
 * Nothing here touches Markdown semantics — a paragraph is whatever sits
 * between blank lines, which is how generated pages are written.
 */

export type ProseDiffRunType = "equal" | "insert" | "delete";

export type ProseDiffBlockType = "unchanged" | "added" | "removed" | "changed";

export type ProseDiffRun = {
  type: ProseDiffRunType;
  text: string;
};

export type ProseDiffBlock = {
  type: ProseDiffBlockType;
  runs: ProseDiffRun[];
};

export type ProseDiff = {
  blocks: ProseDiffBlock[];
  addedWords: number;
  removedWords: number;
};

/**
 * How alike two paragraphs must be before one is shown as a rewrite of the
 * other rather than as a deletion next to an unrelated insertion. Below this an
 * inline diff is noise: a scatter of shared articles and prepositions.
 */
const REWRITE_SIMILARITY = 0.3;

/**
 * Ceiling on the word-level comparison, which is quadratic. A page's paragraph
 * is orders of magnitude below this; a pathological one is shown as a plain
 * replacement instead of stalling the request.
 */
const MAX_WORD_PAIRS = 250_000;

export function diffProse(before: string, after: string): ProseDiff {
  const beforeBlocks = splitBlocks(before);
  const afterBlocks = splitBlocks(after);
  const blocks = pairRewrites(diffSequence(beforeBlocks, afterBlocks, (block) => block));

  let addedWords = 0;
  let removedWords = 0;
  for (const block of blocks) {
    for (const run of block.runs) {
      if (run.type === "insert") addedWords += countWords(run.text);
      if (run.type === "delete") removedWords += countWords(run.text);
    }
  }
  return { blocks, addedWords, removedWords };
}

/** True when the two texts differ in something other than surrounding space. */
export function proseChanged(before: string, after: string): boolean {
  return before.trim() !== after.trim();
}

/** Paragraphs, in order, with blank-line runs and trailing space removed. */
export function splitBlocks(text: string): string[] {
  return text
    .split(/\n\s*\n/)
    .map((block) => block.trim())
    .filter((block) => block.length > 0);
}

function countWords(text: string): number {
  const matches = text.trim().match(/\S+/g);
  return matches ? matches.length : 0;
}

/**
 * Splits into words that carry their own trailing whitespace, so joining runs
 * back together reproduces the text exactly. Comparison is on the word alone.
 */
function splitWords(text: string): string[] {
  return text.match(/\S+\s*/g) ?? [];
}

type SequenceOp<T> = { type: "equal" | "insert" | "delete"; value: T };

/**
 * Longest-common-subsequence diff of two sequences.
 *
 * Both inputs here are bounded by one page — paragraphs per page, or words per
 * paragraph — so the quadratic table is cheap and the exact answer is worth
 * more than the approximation a linear-space variant would give.
 */
function diffSequence<T>(before: T[], after: T[], key: (value: T) => string): SequenceOp<T>[] {
  const rows = before.length;
  const columns = after.length;
  const beforeKeys = before.map(key);
  const afterKeys = after.map(key);

  // lengths[i][j] is the LCS length of before[i..] and after[j..], so the walk
  // below can run forward and emit ops in reading order.
  const lengths: number[][] = Array.from({ length: rows + 1 }, () =>
    Array.from({ length: columns + 1 }, () => 0)
  );
  for (let i = rows - 1; i >= 0; i -= 1) {
    for (let j = columns - 1; j >= 0; j -= 1) {
      lengths[i]![j] =
        beforeKeys[i] === afterKeys[j]
          ? lengths[i + 1]![j + 1]! + 1
          : Math.max(lengths[i + 1]![j]!, lengths[i]![j + 1]!);
    }
  }

  const ops: SequenceOp<T>[] = [];
  let i = 0;
  let j = 0;
  while (i < rows && j < columns) {
    if (beforeKeys[i] === afterKeys[j]) {
      ops.push({ type: "equal", value: after[j]! });
      i += 1;
      j += 1;
    } else if (lengths[i + 1]![j]! >= lengths[i]![j + 1]!) {
      ops.push({ type: "delete", value: before[i]! });
      i += 1;
    } else {
      ops.push({ type: "insert", value: after[j]! });
      j += 1;
    }
  }
  while (i < rows) {
    ops.push({ type: "delete", value: before[i]! });
    i += 1;
  }
  while (j < columns) {
    ops.push({ type: "insert", value: after[j]! });
    j += 1;
  }
  return ops;
}

/**
 * Turns a delete run followed by an insert run into rewrites where the
 * paragraphs still resemble each other, and leaves the rest as plain removals
 * and additions.
 */
function pairRewrites(ops: SequenceOp<string>[]): ProseDiffBlock[] {
  const blocks: ProseDiffBlock[] = [];
  let index = 0;
  while (index < ops.length) {
    const op = ops[index]!;
    if (op.type === "equal") {
      blocks.push({ type: "unchanged", runs: [{ type: "equal", text: op.value }] });
      index += 1;
      continue;
    }

    const removed: string[] = [];
    while (index < ops.length && ops[index]!.type === "delete") {
      removed.push(ops[index]!.value);
      index += 1;
    }
    const added: string[] = [];
    while (index < ops.length && ops[index]!.type === "insert") {
      added.push(ops[index]!.value);
      index += 1;
    }

    const paired = Math.min(removed.length, added.length);
    for (let offset = 0; offset < paired; offset += 1) {
      blocks.push(rewriteBlock(removed[offset]!, added[offset]!));
    }
    for (const text of removed.slice(paired)) {
      blocks.push({ type: "removed", runs: [{ type: "delete", text }] });
    }
    for (const text of added.slice(paired)) {
      blocks.push({ type: "added", runs: [{ type: "insert", text }] });
    }
  }
  return blocks;
}

/** A paragraph shown as an inline rewrite, or as a replacement when too little survives. */
function rewriteBlock(before: string, after: string): ProseDiffBlock {
  const beforeWords = splitWords(before);
  const afterWords = splitWords(after);
  if (beforeWords.length * afterWords.length > MAX_WORD_PAIRS) {
    return replacementBlock(before, after);
  }

  const ops = diffSequence(beforeWords, afterWords, (word) => word.trim());
  const kept = ops.filter((op) => op.type === "equal").length;
  const similarity = (2 * kept) / Math.max(1, beforeWords.length + afterWords.length);
  if (similarity < REWRITE_SIMILARITY) {
    return replacementBlock(before, after);
  }

  const runs: ProseDiffRun[] = [];
  for (const op of ops) {
    const type: ProseDiffRunType = op.type === "equal" ? "equal" : op.type;
    const last = runs.at(-1);
    if (last && last.type === type) {
      last.text += op.value;
      continue;
    }
    runs.push({ type, text: op.value });
  }
  return { type: "changed", runs };
}

function replacementBlock(before: string, after: string): ProseDiffBlock {
  return {
    type: "changed",
    runs: [
      { type: "delete", text: before },
      { type: "insert", text: after }
    ]
  };
}
