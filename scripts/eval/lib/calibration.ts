/**
 * Judge calibration set: pairs whose winner is known before any judge reads them.
 *
 * - decided: the 2026-09-03/04 same-sitting pairwise panels (docs/composed-chapters/evals/pairwise-*),
 *   chapter excerpts from docs/composed-chapters/human-packets; one Opus reader per order, both orders
 *   and both questions (engagement, pacing) agreeing.
 * - tie: the one pairwise comparison whose two orders disagreed (composed-7 vs rung 8A, chapter 8).
 * - clear: the 2026-09-05 same-sitting Opus panel (experiments/2026-09-05-opus): development-fixes-1d
 *   read 5.90, the three rung-5 books 7.80–7.87, and every reader put it below every reader of every
 *   rung-5 book. Same plan, so chapter N against chapter N; the book-level winner is the known winner.
 * - synthetic: a rung-5 chapter against a copy with planted reader-visible defects (production notes and
 *   notes-language; a duplicated passage and a truncated ending; padding hedges). Clear by construction.
 *
 * Acceptance rule (plan §F0): a judge is usable only if it never prefers the known loser on a clear or
 * synthetic pair. Agreement on decided pairs and the tie rate are reported beside it.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { REPO_ROOT } from "./fixtures.ts";
import type { PairInput, PairOutcome } from "./pairs.ts";
import { paragraphs } from "./text.ts";

const ARCHIVE = join(REPO_ROOT, "docs", "composed-chapters");
const PACKETS = join(ARCHIVE, "human-packets");
const OPUS = join(ARCHIVE, "experiments", "2026-09-05-opus", "blind");

const BOOK_BRIEF =
  "Title: Aggression Through Time\nA 120-page English nonfiction history for general readers: human aggression and organized violence from small pre-state communities to the present, weighing what the historical record can and cannot explain. Balanced tier, fifteen chapters.";

function packet(name: string): string {
  return readFileSync(join(PACKETS, `${name}.md`), "utf8");
}

function chapterOf(code: string, index: number): string {
  const text = readFileSync(join(OPUS, code, "manuscript.txt"), "utf8");
  const parts = text.split(/^(?=## Chapter \d+:)/m);
  const found = parts.find((part) => part.startsWith(`## Chapter ${index}:`));
  if (!found) throw new Error(`chapter ${index} not in ${code}`);
  return found.trim();
}

function titleOf(chapter: string): string {
  return chapter.split("\n")[0]!.replace(/^## /, "");
}

function briefFor(chapter: string): string {
  return `${BOOK_BRIEF}\n\nThis piece: ${titleOf(chapter)}.`;
}

/** Plant reader-visible defects in a copy of `chapter`. */
export function plantDefects(chapter: string, kind: "leak" | "dup-trunc" | "hedge"): string {
  const list = paragraphs(chapter);
  const head = list[0]!.startsWith("## ") ? [list.shift()!] : [];
  if (kind === "leak") {
    const notes = [
      "[Note to editor: the chapter needs about 3,990 words; this draft is ~3,400, so develop the next section.]",
      "According to the research brief supplied for this chapter, the figures supplied above should be treated as provisional.",
      "TODO: add a second example here from the dossier before the final pass."
    ];
    const step = Math.max(2, Math.floor(list.length / 4));
    notes.forEach((note, i) => list.splice(Math.min(list.length, (i + 1) * step + i), 0, note));
  } else if (kind === "dup-trunc") {
    // Two early paragraphs repeated verbatim past the middle, then the last fifth gone and the ending cut mid-sentence.
    list.splice(Math.floor(list.length * 0.55), 0, list[2]!, list[3]!);
    list.length = Math.max(5, Math.floor(list.length * 0.8));
    const tail = list[list.length - 1]!.split(/\s+/);
    list[list.length - 1] = tail.slice(0, Math.max(6, Math.floor(tail.length / 2))).join(" ");
  } else {
    const hedges = [
      "It is important to remember, however, that history rarely offers simple answers, and any conclusion drawn here must remain provisional, contested and open to revision.",
      "At the same time, we should be careful not to overstate the case: the evidence is complex, the sources are partial, and reasonable historians continue to disagree.",
      "Ultimately, then, the picture is nuanced. Aggression was neither wholly natural nor wholly cultural, but rather a complex interplay of many factors that resist easy summary."
    ];
    for (let i = list.length - 1, n = 0; i > 1; i -= 3, n += 1) list.splice(i, 0, hedges[n % hedges.length]!);
  }
  return [...head, ...list].join("\n\n");
}

export function calibrationPairs(): PairInput[] {
  if (!existsSync(PACKETS) || !existsSync(OPUS)) throw new Error(`Calibration sources missing: ${PACKETS} and ${OPUS}`);
  const pairs: PairInput[] = [];
  const pairwise = (id: string, a: string, b: string, winner: string, cls: "decided" | "tie", source: string) => {
    const textA = packet(a);
    pairs.push({ pairId: id, textA, textB: packet(b), labelA: a, labelB: b, brief: briefFor(textA), known: { winner, class: cls, source } });
  };
  pairwise("c01", "baseline-chapter-1", "best-chapter-1", "best-chapter-1", "decided", "evals/pairwise-baseline-vs-5b ch1 (B in AB, A in BA, both questions)");
  pairwise("c02", "baseline-chapter-8", "best-chapter-8", "best-chapter-8", "decided", "evals/pairwise-baseline-vs-5b ch8");
  pairwise("c03", "best-chapter-1", "rung6-chapter-1", "rung6-chapter-1", "decided", "evals/pairwise-5b-vs-6b ch1");
  pairwise("c04", "best-chapter-8", "rung6-chapter-8", "best-chapter-8", "decided", "evals/pairwise-5b-vs-6b ch8");
  pairwise("c05", "best-chapter-1", "rung7-chapter-1", "rung7-chapter-1", "decided", "evals/pairwise-5b-vs-7b ch1");
  pairwise("c06", "best-chapter-8", "rung7-chapter-8", "best-chapter-8", "decided", "evals/pairwise-5b-vs-7b ch8");
  pairwise("c07", "rung8A-chapter-6", "rung8B-chapter-6", "rung8B-chapter-6", "decided", "evals/pairwise-8A-vs-8B ch6");
  pairwise("c08", "rung8A-chapter-9", "rung8B-chapter-9", "rung8A-chapter-9", "decided", "evals/pairwise-8A-vs-8B ch9");
  pairwise("c09", "composed7-chapter-1", "rung8A-chapter-1", "rung8A-chapter-1", "decided", "evals/pairwise-composed7-vs-8A ch1");
  pairwise("c10", "composed7-chapter-8", "rung8A-chapter-8", "tie", "tie", "evals/pairwise-composed7-vs-8A ch8 (orders disagreed)");
  const clear = (id: string, index: number, reference: string) => {
    const weak = chapterOf("P7", index);
    const strong = chapterOf(reference, index);
    pairs.push({ pairId: id, textA: weak, textB: strong, labelA: `P7-ch${index}`, labelB: `${reference}-ch${index}`, brief: briefFor(strong), known: { winner: `${reference}-ch${index}`, class: "clear", source: `experiments/2026-09-05-opus: P7 5.90 vs ${reference} ~7.8, every reader` } });
  };
  clear("c11", 3, "V8");
  clear("c12", 6, "V2");
  clear("c13", 10, "L7");
  clear("c14", 13, "V8");
  const synthetic = (id: string, index: number, kind: "leak" | "dup-trunc" | "hedge") => {
    const original = chapterOf("L7", index);
    pairs.push({ pairId: id, textA: original, textB: plantDefects(original, kind), labelA: `L7-ch${index}`, labelB: `L7-ch${index}-${kind}`, brief: briefFor(original), known: { winner: `L7-ch${index}`, class: "synthetic", source: `planted ${kind}` } });
  };
  synthetic("c15", 2, "leak");
  synthetic("c16", 7, "dup-trunc");
  synthetic("c17", 11, "hedge");
  return pairs;
}

export type CalibrationScore = {
  judge: string;
  pairs: number;
  byClass: Record<string, { n: number; agree: number; tie: number; wrong: number; missing: number }>;
  /** Known loser preferred on a clear or synthetic pair: must be 0 to accept the judge. */
  clearViolations: string[];
  accepted: boolean;
};

export function scoreCalibration(judge: string, outcomes: readonly PairOutcome[]): CalibrationScore {
  const byClass: CalibrationScore["byClass"] = {};
  const clearViolations: string[] = [];
  for (const outcome of outcomes) {
    if (!outcome.known) continue;
    const entry = (byClass[outcome.known.class] ??= { n: 0, agree: 0, tie: 0, wrong: 0, missing: 0 });
    entry.n += 1;
    if (outcome.winner === "missing") entry.missing += 1;
    else if (outcome.winner === outcome.known.winner) entry.agree += 1;
    else if (outcome.winner === "tie") entry.tie += 1;
    else {
      entry.wrong += 1;
      if (outcome.known.class === "clear" || outcome.known.class === "synthetic") clearViolations.push(`${outcome.pairId} (${outcome.known.source})`);
    }
  }
  const complete = Object.values(byClass).every((entry) => entry.missing === 0);
  return { judge, pairs: outcomes.length, byClass, clearViolations, accepted: complete && clearViolations.length === 0 };
}
