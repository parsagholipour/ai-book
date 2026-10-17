/**
 * H2 prototype of `packages/core/src/generation/chapterEditHunks.ts`: split a line edit into hunks, merge
 * a chosen subset back onto the draft, and the Quick Draft protected-token test. Pure and self-contained
 * (no product or toolkit imports) so it can move into core unchanged.
 *
 * Units. A chapter is a sequence of units with a paragraph break between paragraphs:
 * - a fenced block (```…```), and a `[Figure: …]` stand-in line, is one `block` unit (never edited);
 * - a paragraph any of whose lines is a list item, table row, heading or quote is cut into `line` units;
 * - any other paragraph is cut into `sentence` units.
 * Units compare after folding whitespace, quotes and dashes (blocks compare byte for byte).
 *
 * Hunks. An LCS diff of the two unit sequences; a hunk is a maximal run of non-equal units between two
 * equal ones (so a merged or split paragraph is one hunk). When a draft paragraph has 60% or more of its
 * sentences inside hunks, every hunk touching it becomes one hunk spanning it (a rewritten paragraph is one
 * decision, and re-merging it sentence by sentence would leave seams).
 */

export type UnitKind = "sentence" | "line" | "block" | "break";
export type Unit = { kind: UnitKind; text: string; key: string };
type Op = { type: "equal" | "delete" | "insert"; a?: Unit; b?: Unit; para: number };
export type Hunk = {
  id: string;
  kind: "replace" | "delete" | "insert";
  /** Draft text of the span (units joined as they print). */
  before: string;
  after: string;
  /** Index of the draft paragraph the hunk starts in. */
  paragraph: number;
  /** Touches a fenced block or a figure stand-in: always reverted. */
  touchesBlock: boolean;
  start: number;
  end: number;
};
export type HunkDiff = { draft: string; edit: string; ops: Op[]; hunks: Hunk[]; paragraphs: string[] };

const LINE_PARAGRAPH = /^\s*(?:[-*+]\s|\d+[.)]\s|>|\||#)/m;
const FIGURE_LINE = /^\s*\[Figure:[^\]]*\]\s*$/;
const SENTENCE_SPLIT = /(?<=[.!?…]["”’)\]]?)\s+(?=["“‘([]?[\p{Lu}\p{N}])/u;

export function fold(text: string): string {
  return text
    .normalize("NFC")
    .replace(/[‘’‚‛′]/g, "'")
    .replace(/[“”„‟″«»]/g, "\"")
    .replace(/[‐‑‒–—―]/g, "-")
    .replace(/…/g, "...")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

/** Paragraphs, with fenced blocks kept whole even when they contain blank lines. */
export function splitParagraphs(markdown: string): string[] {
  const out: string[] = [];
  let current: string[] = [];
  let inFence = false;
  const flush = () => {
    const text = current.join("\n").trim();
    if (text) out.push(text);
    current = [];
  };
  for (const line of markdown.replace(/\r\n?/g, "\n").split("\n")) {
    if (line.trim().startsWith("```")) {
      if (!inFence) flush();
      current.push(line);
      inFence = !inFence;
      if (!inFence) flush();
      continue;
    }
    if (inFence) current.push(line);
    else if (line.trim() === "") flush();
    else if (FIGURE_LINE.test(line)) {
      flush();
      out.push(line.trim());
    } else current.push(line);
  }
  flush();
  return out;
}

function unitsOf(paragraph: string): Unit[] {
  if (paragraph.startsWith("```") || FIGURE_LINE.test(paragraph)) return [{ kind: "block", text: paragraph, key: `block:${paragraph}` }];
  if (LINE_PARAGRAPH.test(paragraph)) return paragraph.split("\n").filter((line) => line.trim()).map((line) => ({ kind: "line", text: line.trimEnd(), key: `line:${fold(line)}` }));
  return paragraph.replace(/\s+/g, " ").split(SENTENCE_SPLIT).map((piece) => piece.trim()).filter(Boolean).map((text) => ({ kind: "sentence", text, key: `s:${fold(text)}` }));
}

const BREAK: Unit = { kind: "break", text: "\n\n", key: "¶" };

function sequence(markdown: string): { units: Unit[]; paraOf: number[]; paragraphs: string[] } {
  const paragraphs = splitParagraphs(markdown);
  const units: Unit[] = [];
  const paraOf: number[] = [];
  paragraphs.forEach((paragraph, index) => {
    if (index > 0) {
      units.push(BREAK);
      paraOf.push(index);
    }
    for (const unit of unitsOf(paragraph)) {
      units.push(unit);
      paraOf.push(index);
    }
  });
  return { units, paraOf, paragraphs };
}

function lcsOps(a: Unit[], b: Unit[], paraOf: number[]): Op[] {
  const n = a.length;
  const m = b.length;
  const table: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      table[i]![j] = a[i]!.key === b[j]!.key ? table[i + 1]![j + 1]! + 1 : Math.max(table[i + 1]![j]!, table[i]![j + 1]!);
    }
  }
  const ops: Op[] = [];
  let i = 0;
  let j = 0;
  // An insertion belongs to the paragraph of the draft unit before it.
  let para = 0;
  while (i < n || j < m) {
    if (i < n && j < m && a[i]!.key === b[j]!.key) para = paraOf[i]!;
    else if (i < n && (j >= m || table[i + 1]![j]! >= table[i]![j + 1]!)) para = paraOf[i]!;
    if (i < n && j < m && a[i]!.key === b[j]!.key) {
      ops.push({ type: "equal", a: a[i]!, b: b[j]!, para });
      i += 1;
      j += 1;
    } else if (i < n && (j >= m || table[i + 1]![j]! >= table[i]![j + 1]!)) {
      ops.push({ type: "delete", a: a[i]!, para });
      i += 1;
    } else {
      ops.push({ type: "insert", b: b[j]!, para });
      j += 1;
    }
  }
  return ops;
}

/** Units → Markdown: sentences joined by a space, lines by a newline, paragraphs by a blank line. */
export function render(units: readonly Unit[]): string {
  let out = "";
  let previous: Unit | undefined;
  for (const unit of units) {
    if (unit.kind === "break") {
      if (previous && previous.kind !== "break") out += "\n\n";
    } else {
      if (previous && previous.kind !== "break") out += unit.kind === "sentence" && previous.kind === "sentence" ? " " : "\n";
      out += unit.text;
    }
    previous = unit;
  }
  return out.replace(/\n{3,}/g, "\n\n").trim();
}

function spanText(ops: readonly Op[], start: number, end: number, side: "a" | "b"): string {
  const units = ops.slice(start, end + 1).filter((op) => (side === "a" ? op.type !== "insert" : op.type !== "delete")).map((op) => (side === "a" ? op.a! : op.b!));
  return render(units);
}

export function diffChapter(draft: string, edit: string, rewriteShare = 0.6): HunkDiff {
  const a = sequence(draft);
  const b = sequence(edit);
  const ops = lcsOps(a.units, b.units, a.paraOf);
  // Raw runs of non-equal ops.
  let runs: Array<{ start: number; end: number }> = [];
  for (let k = 0; k < ops.length; k += 1) {
    if (ops[k]!.type === "equal") continue;
    const last = runs.at(-1);
    if (last && last.end === k - 1) last.end = k;
    else runs.push({ start: k, end: k });
  }
  // A run that only moves a paragraph break (two paragraphs joined, or one split) takes the unit on each
  // side, so the hunk shows the join; runs that then touch are one hunk.
  runs = runs.map((run) => (ops.slice(run.start, run.end + 1).every((op) => op.type === "equal" || (op.a ?? op.b)!.kind === "break")
    ? { start: Math.max(0, run.start - 1), end: Math.min(ops.length - 1, run.end + 1) }
    : run));
  runs = runs.reduce<Array<{ start: number; end: number }>>((out, run) => {
    const last = out.at(-1);
    if (last && run.start <= last.end + 1) last.end = Math.max(last.end, run.end);
    else out.push({ ...run });
    return out;
  }, []);
  // A paragraph mostly rewritten is one hunk.
  const sentencesIn = new Map<number, number>();
  const changedIn = new Map<number, number>();
  for (const op of ops) {
    if (op.a && op.a.kind !== "break") {
      sentencesIn.set(op.para, (sentencesIn.get(op.para) ?? 0) + 1);
      if (op.type === "delete") changedIn.set(op.para, (changedIn.get(op.para) ?? 0) + 1);
    }
  }
  const rewritten = new Set([...changedIn].filter(([para, changed]) => changed / (sentencesIn.get(para) ?? 1) >= rewriteShare).map(([para]) => para));
  const merged: Array<{ start: number; end: number }> = [];
  for (const run of runs) {
    const last = merged.at(-1);
    const para = ops[run.start]!.para;
    if (last && rewritten.has(para) && ops[last.end]!.para === para) last.end = run.end;
    else merged.push({ ...run });
  }
  runs = merged;
  const hunks = runs.map((run, index): Hunk => {
    const slice = ops.slice(run.start, run.end + 1);
    const deletes = slice.some((op) => op.type === "delete");
    const inserts = slice.some((op) => op.type === "insert");
    return {
      id: `h${index + 1}`,
      kind: deletes && inserts ? "replace" : deletes ? "delete" : "insert",
      before: spanText(ops, run.start, run.end, "a"),
      after: spanText(ops, run.start, run.end, "b"),
      paragraph: ops[run.start]!.para,
      touchesBlock: slice.some((op) => op.type !== "equal" && (op.a?.kind === "block" || op.b?.kind === "block")),
      start: run.start,
      end: run.end
    };
  });
  return { draft, edit, ops, hunks, paragraphs: a.paragraphs };
}

/** The draft with exactly the `accepted` hunks applied. All accepted → the edit; none → the draft. */
export function mergeHunks(diff: HunkDiff, accepted: ReadonlySet<string>): string {
  const live = diff.hunks.filter((hunk) => accepted.has(hunk.id) && !hunk.touchesBlock);
  if (live.length === 0) return diff.draft;
  if (live.length === diff.hunks.length) return diff.edit;
  const units: Unit[] = [];
  diff.ops.forEach((op, index) => {
    const hunk = diff.hunks.find((entry) => index >= entry.start && index <= entry.end);
    const takeEdit = hunk ? live.includes(hunk) : true;
    if (op.type === "equal") units.push(op.a!);
    else if (op.type === "delete" && !takeEdit) units.push(op.a!);
    else if (op.type === "insert" && takeEdit) units.push(op.b!);
  });
  return render(units);
}

const STOP = new Set("the a an and or of to in on for with by at from as is was were be been it its that this these those he she they his her their there".split(" "));
const contentWords = (text: string) => new Set(fold(text).match(/[\p{L}\p{N}]+/gu)?.filter((word) => !STOP.has(word)) ?? []);

/** For a deletion: the draft sentence outside the hunk that shares ≥ `share` of the deleted sentence's content words. */
export function retainedTwin(diff: HunkDiff, hunk: Hunk, share = 0.6): string | undefined {
  if (hunk.kind === "insert") return undefined;
  const deleted = diff.ops.slice(hunk.start, hunk.end + 1).filter((op) => op.type === "delete" && op.a?.kind === "sentence").map((op) => op.a!.text);
  const others = diff.ops.filter((op, index) => (index < hunk.start || index > hunk.end) && op.type === "equal" && op.a?.kind === "sentence").map((op) => op.a!.text);
  let best: { text: string; score: number } | undefined;
  for (const sentence of deleted) {
    const words = contentWords(sentence);
    if (words.size < 5) continue;
    for (const other of others) {
      const otherWords = contentWords(other);
      const overlap = [...words].filter((word) => otherWords.has(word)).length / words.size;
      if (overlap >= share && (!best || overlap > best.score)) best = { text: other, score: overlap };
    }
  }
  return best?.text;
}

// ---- Protected tokens (the Quick Draft refusal) -------------------------------------------------------

const NUMBER_WORDS: Record<string, string> = { two: "2", three: "3", four: "4", five: "5", six: "6", seven: "7", eight: "8", nine: "9", ten: "10", eleven: "11", twelve: "12", thirteen: "13", fourteen: "14", fifteen: "15", sixteen: "16", seventeen: "17", eighteen: "18", nineteen: "19", twenty: "20", thirty: "30", forty: "40", fifty: "50", sixty: "60", seventy: "70", eighty: "80", ninety: "90", hundred: "100", thousand: "1000", million: "1000000", billion: "1000000000", half: "0.5", dozen: "12" };
const NEGATION = /^(?:not|no|never|none|nobody|nothing|neither|nor|without|cannot|nowhere|unable)$|n['’]t$/i;
const QUANTIFIER = /^(?:all|every|each|some|most|many|few|several|always|often|rarely|sometimes|only|any|usually|seldom)$/i;

function numbersOf(text: string): string[] {
  const out: string[] = [];
  for (const match of text.matchAll(/\d[\d,.]*\d%?|\d%?|\b[a-z]+\b/gi)) {
    const token = match[0].toLowerCase();
    if (/\d/.test(token)) out.push(token.replace(/,/g, "").replace(/\.$/, ""));
    else if (NUMBER_WORDS[token]) out.push(NUMBER_WORDS[token]!);
  }
  return out;
}

/** Capitalised words that are not sentence-initial, plus sentence-initial ones the chapter capitalises mid-sentence elsewhere. */
function namesOf(text: string, knownNames: ReadonlySet<string>): string[] {
  const out: string[] = [];
  for (const sentence of text.replace(/\s+/g, " ").split(SENTENCE_SPLIT)) {
    sentence.split(" ").forEach((token, index) => {
      const bare = token.replace(/^[^\p{L}]+|[^\p{L}\p{M}'’-]+$/gu, "").replace(/['’]s$/u, "");
      if (!/^\p{Lu}[\p{Ll}\p{M}]/u.test(bare) || bare === "I") return;
      if (index > 0 || knownNames.has(bare.toLowerCase())) out.push(bare.toLowerCase());
    });
  }
  return out;
}

export function knownNamesOf(markdown: string): Set<string> {
  return new Set(namesOf(markdown, new Set()));
}

const words = (text: string) => text.match(/[\p{L}\p{M}'’]+/gu) ?? [];
const multisetDelta = (before: string[], after: string[]) => {
  const counts = new Map<string, number>();
  for (const item of before) counts.set(item, (counts.get(item) ?? 0) + 1);
  for (const item of after) counts.set(item, (counts.get(item) ?? 0) - 1);
  return { added: [...counts].filter(([, n]) => n < 0).map(([item]) => item), removed: [...counts].filter(([, n]) => n > 0).map(([item]) => item) };
};

export type ProtectedVerdict = {
  protected: boolean;
  reasons: string[];
  /** Diagnostic only: quantifier count changed (not a reason to revert in this rule). */
  quantifierChange: boolean;
  /** The change was licensed by the fact ledger. */
  ledger: boolean;
};

/**
 * A hunk changes protected tokens when its before/after differ in the multiset of numbers or names, or in the
 * count of negations. A change whose every added number/name is in an `establishedFacts` line (the ledger's
 * sanctioned continuity correction) and which removes no number/name and no negation is allowed.
 */
export function protectedChange(hunk: Hunk, knownNames: ReadonlySet<string>, establishedFacts: readonly string[] = []): ProtectedVerdict {
  const numbers = multisetDelta(numbersOf(hunk.before), numbersOf(hunk.after));
  const names = multisetDelta(namesOf(hunk.before, knownNames), namesOf(hunk.after, knownNames));
  const negations = words(hunk.after).filter((word) => NEGATION.test(word)).length - words(hunk.before).filter((word) => NEGATION.test(word)).length;
  const quantifiers = words(hunk.after).filter((word) => QUANTIFIER.test(word)).length - words(hunk.before).filter((word) => QUANTIFIER.test(word)).length;
  const reasons: string[] = [];
  if (numbers.added.length || numbers.removed.length) reasons.push(`numbers +[${numbers.added.join(",")}] -[${numbers.removed.join(",")}]`);
  if (names.added.length || names.removed.length) reasons.push(`names +[${names.added.join(",")}] -[${names.removed.join(",")}]`);
  if (negations !== 0) reasons.push(`negations ${negations > 0 ? "+" : ""}${negations}`);
  const ledgerText = fold(establishedFacts.join(" \n "));
  const ledgerNumbers = new Set(numbersOf(ledgerText));
  const ledger = reasons.length > 0 && negations === 0 && numbers.removed.length === 0 && names.removed.length === 0 && ledgerText.length > 0 &&
    numbers.added.every((number) => ledgerNumbers.has(number)) && names.added.every((name) => ledgerText.includes(name));
  return { protected: reasons.length > 0 && !ledger, reasons, quantifierChange: quantifiers !== 0, ledger };
}

// ---- Moves and near-duplicates (seams a partial merge can create) ---------------------------------------

const overlap = (a: ReadonlySet<string>, b: ReadonlySet<string>) => (a.size === 0 ? 0 : [...a].filter((word) => b.has(word)).length / a.size);
const sideSentences = (diff: HunkDiff, hunk: Hunk, type: "delete" | "insert") =>
  diff.ops.slice(hunk.start, hunk.end + 1).filter((op) => op.type === type && (op.a ?? op.b)!.kind === "sentence").map((op) => (op.a ?? op.b)!.text);

/**
 * Hunks that must be decided together: one inserts a sentence another deletes (≥ `share` of its content words),
 * i.e. the editor moved or re-placed text across hunks. Applying one without the other prints it twice or not at all.
 */
export function moveGroups(diff: HunkDiff, share = 0.6): string[][] {
  const parent = new Map(diff.hunks.map((hunk) => [hunk.id, hunk.id]));
  const find = (id: string): string => (parent.get(id) === id ? id : find(parent.get(id)!));
  const inserted = diff.hunks.map((hunk) => sideSentences(diff, hunk, "insert").map(contentWords).filter((words) => words.size >= 5));
  const deleted = diff.hunks.map((hunk) => sideSentences(diff, hunk, "delete").map(contentWords).filter((words) => words.size >= 5));
  diff.hunks.forEach((a, i) => diff.hunks.forEach((b, j) => {
    if (i !== j && inserted[i]!.some((words) => deleted[j]!.some((other) => overlap(words, other) >= share && overlap(other, words) >= share))) parent.set(find(a.id), find(b.id));
  }));
  const groups = new Map<string, string[]>();
  for (const hunk of diff.hunks) groups.set(find(hunk.id), [...(groups.get(find(hunk.id)) ?? []), hunk.id]);
  return [...groups.values()].filter((group) => group.length > 1);
}

/** Accepted hunks, closed over move groups: a group goes in only if every member was accepted. */
export function closeOverMoves(diff: HunkDiff, accepted: ReadonlySet<string>): Set<string> {
  const out = new Set(accepted);
  for (const group of moveGroups(diff)) if (!group.every((id) => accepted.has(id))) for (const id of group) out.delete(id);
  return out;
}

/** Pairs of sentences (≥ 8 content words) sharing ≥ 80% of their content words: a restatement printed twice. */
export function nearDuplicatePairs(markdown: string, share = 0.8): number {
  const list = splitParagraphs(markdown).flatMap(unitsOf).filter((unit) => unit.kind === "sentence").map((unit) => contentWords(unit.text)).filter((words) => words.size >= 8);
  let pairs = 0;
  for (let i = 0; i < list.length; i += 1) for (let j = i + 1; j < list.length; j += 1) if (overlap(list[i]!, list[j]!) >= share && overlap(list[j]!, list[i]!) >= share) pairs += 1;
  return pairs;
}

/** The merge printed a near-duplicate that neither the draft nor the edit has: the partial merge is refused. */
export function mergeIntroducesDuplicate(diff: HunkDiff, merged: string): boolean {
  return nearDuplicatePairs(merged) > Math.max(nearDuplicatePairs(diff.draft), nearDuplicatePairs(diff.edit));
}
