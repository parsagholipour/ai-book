/**
 * Blind pairs. A pair set is a directory of pair-order folders (`p007-o1`, `p007-o2`: the same two texts,
 * labels swapped) that a judge may read, a verdict tree beside it, and a key kept outside the set:
 *
 *   pairs/<set>/folders/<folder>/{A.md, B.md, brief.txt, context.md, rubric.md, instructions.md}
 *   pairs/<set>/verdicts/<judge>/<folder>.json
 *   pairs/<set>/manifest.json            folder list + the exact judge instructions (for dispatching readers)
 *   pairs/_keys/<set>.json               which variant is A in which order — never shown to a judge
 *
 * A pair is a win only when both orders pick the same underlying variant; disagreement is a tie.
 */
import { copyFileSync, existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ensureDir, readJson, REPO_ROOT, writeJson } from "./fixtures.ts";

export const ARTIFACTS = { chapter: "chapter.md", excerpt: "excerpt.md", research: "research-brief.md", seam: "seam.md" } as const;
export type Artifact = keyof typeof ARTIFACTS;
export const RUBRIC_DIR = join(REPO_ROOT, "scripts", "eval", "rubrics");

export type PairInput = {
  /** Stable id inside the set (folder prefix). */
  pairId: string;
  textA: string;
  textB: string;
  labelA: string;
  labelB: string;
  brief: string;
  context?: string;
  fixtureId?: string;
  sample?: number;
  /** Calibration only: the known winner's label, or "tie", and how it is known. */
  known?: { winner: string; class: "clear" | "decided" | "tie" | "synthetic"; source: string };
};

export type KeyPair = {
  pairId: string;
  labelA: string;
  labelB: string;
  identical: boolean;
  fixtureId?: string;
  sample?: number;
  known?: PairInput["known"];
  /** Which label sits in A.md in each order folder. */
  orders: Record<string, { A: string; B: string }>;
};

export type PairKey = { set: string; artifact: Artifact; createdAt: string; evalName?: string; reference?: string; candidate?: string; pairs: KeyPair[] };

export type Verdict = {
  preferred: "A" | "B" | "tie";
  confidence?: string;
  dimensions?: Record<string, string>;
  reason?: string;
  defectsA?: string[];
  defectsB?: string[];
};

export const setDir = (root: string, set: string) => join(root, "pairs", set);
export const keyPath = (root: string, set: string) => join(root, "pairs", "_keys", `${set}.json`);
export const verdictPath = (root: string, set: string, judge: string, folder: string) => join(setDir(root, set), "verdicts", judge, `${folder}.json`);

export function judgeInstructions(artifact: Artifact): string {
  return `${readFileSync(join(RUBRIC_DIR, "judge-instructions.md"), "utf8").trim()}\n\n${readFileSync(join(RUBRIC_DIR, ARTIFACTS[artifact]), "utf8").trim()}\n`;
}

const normalize = (text: string) => text.replace(/\s+/g, " ").trim();

export function buildPairSet(root: string, set: string, artifact: Artifact, pairs: readonly PairInput[], extra: Partial<PairKey> = {}): PairKey {
  const base = setDir(root, set);
  if (existsSync(join(base, "folders")) && readdirSync(join(base, "folders")).length > 0) {
    throw new Error(`Pair set ${set} already exists at ${base}; pick a new --set name (verdicts are tied to folder names).`);
  }
  const keyPairs: KeyPair[] = [];
  const folders: string[] = [];
  for (const pair of pairs) {
    const identical = normalize(pair.textA) === normalize(pair.textB);
    const orders = { o1: { A: pair.labelA, B: pair.labelB }, o2: { A: pair.labelB, B: pair.labelA } };
    keyPairs.push({
      pairId: pair.pairId,
      labelA: pair.labelA,
      labelB: pair.labelB,
      identical,
      ...(pair.fixtureId ? { fixtureId: pair.fixtureId } : {}),
      ...(pair.sample !== undefined ? { sample: pair.sample } : {}),
      ...(pair.known ? { known: pair.known } : {}),
      orders
    });
    // Identical texts are a tie by construction; no reader is asked.
    if (identical) continue;
    for (const [order, labels] of Object.entries(orders)) {
      const folder = `${pair.pairId}-${order}`;
      const dir = ensureDir(join(base, "folders", folder));
      const textFor = (label: string) => (label === pair.labelA ? pair.textA : pair.textB);
      writeFileSync(join(dir, "A.md"), `${textFor(labels.A).trim()}\n`);
      writeFileSync(join(dir, "B.md"), `${textFor(labels.B).trim()}\n`);
      writeFileSync(join(dir, "brief.txt"), `${pair.brief.trim()}\n`);
      writeFileSync(join(dir, "context.md"), `${(pair.context ?? "").trim()}\n`);
      copyFileSync(join(RUBRIC_DIR, ARTIFACTS[artifact]), join(dir, "rubric.md"));
      copyFileSync(join(RUBRIC_DIR, "judge-instructions.md"), join(dir, "instructions.md"));
      folders.push(folder);
    }
  }
  const key: PairKey = { set, artifact, createdAt: new Date().toISOString(), ...extra, pairs: keyPairs };
  writeJson(keyPath(root, set), key);
  writeJson(join(base, "manifest.json"), {
    set,
    artifact,
    folders: folders.map((folder) => ({ folder, path: join(base, "folders", folder) })),
    verdictDir: join(base, "verdicts", "<judge>"),
    instructions: judgeInstructions(artifact)
  });
  return key;
}

/** Read every verdict file of one judge; malformed files are reported, not silently dropped. */
export function readVerdicts(root: string, set: string, judge: string): { verdicts: Map<string, Verdict>; problems: string[] } {
  const dir = join(setDir(root, set), "verdicts", judge);
  const verdicts = new Map<string, Verdict>();
  const problems: string[] = [];
  if (!existsSync(dir)) return { verdicts, problems: [`no verdicts for judge ${judge}`] };
  for (const file of readdirSync(dir).filter((name) => name.endsWith(".json"))) {
    try {
      const raw = readJson<Record<string, unknown>>(join(dir, file));
      const verdict = (raw.verdict ?? raw) as Verdict;
      if (!["A", "B", "tie"].includes(String(verdict.preferred))) throw new Error(`preferred=${String(verdict.preferred)}`);
      verdicts.set(file.replace(/\.json$/, ""), verdict);
    } catch (error) {
      problems.push(`${file}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return { verdicts, problems };
}

export type PairOutcome = {
  pairId: string;
  fixtureId?: string;
  /** The label both orders agreed on, or "tie" (disagreement, an order judged tie, or identical texts), or "missing". */
  winner: string;
  orders: Record<string, string>;
  identical: boolean;
  known?: PairInput["known"];
  labelA: string;
  labelB: string;
};

/**
 * Combine one or more judges (e.g. three Opus readers, or one API judge). Per order the readers'
 * mapped choices are combined by majority (no majority → tie); per pair both orders must agree.
 */
export function pairOutcomes(root: string, set: string, judges: readonly string[]): { outcomes: PairOutcome[]; problems: string[] } {
  const key = readJson<PairKey>(keyPath(root, set));
  const all = judges.map((judge) => readVerdicts(root, set, judge));
  const problems = all.flatMap((entry, index) => entry.problems.map((problem) => `${judges[index]}: ${problem}`));
  const outcomes = key.pairs.map((pair): PairOutcome => {
    const base = { pairId: pair.pairId, ...(pair.fixtureId ? { fixtureId: pair.fixtureId } : {}), identical: pair.identical, ...(pair.known ? { known: pair.known } : {}), labelA: pair.labelA, labelB: pair.labelB };
    if (pair.identical) return { ...base, winner: "tie", orders: {} };
    const orders: Record<string, string> = {};
    for (const [order, labels] of Object.entries(pair.orders)) {
      const folder = `${pair.pairId}-${order}`;
      const picks = all.map((entry) => entry.verdicts.get(folder)).filter((verdict): verdict is Verdict => Boolean(verdict)).map((verdict) => (verdict.preferred === "tie" ? "tie" : labels[verdict.preferred]));
      if (picks.length === 0) {
        orders[order] = "missing";
        continue;
      }
      const counts = new Map<string, number>();
      for (const pick of picks) counts.set(pick, (counts.get(pick) ?? 0) + 1);
      const [top, topCount] = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]!;
      orders[order] = topCount * 2 > picks.length ? top : "tie";
    }
    const values = Object.values(orders);
    const winner = values.includes("missing") ? "missing" : values.every((value) => value === values[0]) && values[0] !== "tie" ? values[0]! : "tie";
    return { ...base, winner, orders };
  });
  return { outcomes, problems };
}

/** Outcomes from `candidate`'s side against `reference`. */
export function asWinTieLoss(outcomes: readonly PairOutcome[], candidate: string): Array<"win" | "tie" | "loss"> {
  return outcomes
    .filter((outcome) => outcome.winner !== "missing")
    .map((outcome) => (outcome.winner === candidate ? "win" : outcome.winner === "tie" ? "tie" : "loss"));
}
