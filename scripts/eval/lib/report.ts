/**
 * One Markdown report per eval: a variant table (win share ± Wilson CI against the reference from each
 * judged pair set, all-gates pass rate, mean tokens in/out/reasoning, mean and p90 latency, $ at the
 * recorded rate card), the per-check matrix, and the pair tallies per judge.
 */
import { existsSync } from "node:fs";
import { loadResults, readJson, type ReplayResult } from "./fixtures.ts";
import { asWinTieLoss, keyPath, pairOutcomes, type PairKey } from "./pairs.ts";
import { formatShare, mean, percentile, tallyPairs, type PairTally } from "./stats.ts";

export type JudgedSet = { set: string; judges: string[] };

const fmt = (value: number, digits = 0) => (Number.isFinite(value) ? value.toFixed(digits) : "–");
const pct = (value: number) => (Number.isFinite(value) ? `${(value * 100).toFixed(0)}%` : "–");

function variantRows(results: ReplayResult[]) {
  const byVariant = new Map<string, ReplayResult[]>();
  for (const result of results) byVariant.set(result.variant, [...(byVariant.get(result.variant) ?? []), result]);
  return [...byVariant.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([variant, rows]) => {
    const ok = rows.filter((row) => !row.error);
    const gated = ok.map((row) => row.checks.filter((check) => check.pass !== null));
    const priced = ok.filter((row) => row.costUsd !== null);
    return {
      variant,
      n: rows.length,
      errors: rows.length - ok.length,
      fixtures: new Set(rows.map((row) => row.fixtureId)).size,
      allGates: ok.length ? gated.filter((checks) => checks.every((check) => check.pass)).length / ok.length : Number.NaN,
      tokensIn: mean(ok.map((row) => row.usage.promptTokens)),
      tokensOut: mean(ok.map((row) => row.usage.outputTokens)),
      reasoning: mean(ok.map((row) => row.usage.reasoningTokens)),
      latencyMean: mean(ok.map((row) => row.latencyMs)) / 1000,
      latencyP90: percentile(ok.map((row) => row.latencyMs), 90) / 1000,
      usdTotal: priced.reduce((sum, row) => sum + (row.costUsd ?? 0), 0),
      usdMean: mean(priced.map((row) => row.costUsd ?? 0)),
      unpriced: ok.length - priced.length,
      rows: ok
    };
  });
}

export function tallyFor(root: string, judged: JudgedSet): { key: PairKey; tally: PairTally; identical: number; missing: number; problems: string[] } | undefined {
  if (!existsSync(keyPath(root, judged.set))) return undefined;
  const key = readJson<PairKey>(keyPath(root, judged.set));
  const { outcomes, problems } = pairOutcomes(root, judged.set, judged.judges);
  const candidate = key.candidate ?? key.pairs[0]?.labelB ?? "";
  return {
    key,
    tally: tallyPairs(asWinTieLoss(outcomes, candidate)),
    identical: outcomes.filter((outcome) => outcome.identical).length,
    missing: outcomes.filter((outcome) => outcome.winner === "missing").length,
    problems
  };
}

export function buildReport(root: string, evalName: string, judgedSets: readonly JudgedSet[] = []): string {
  const results = loadResults(root, evalName);
  if (results.length === 0) return `# ${evalName}\n\nNo results under results/${evalName}.\n`;
  const rows = variantRows(results);
  const tallies = judgedSets.map((judged) => ({ judged, entry: tallyFor(root, judged) })).filter((item) => item.entry);
  const lines: string[] = [];
  lines.push(`# Eval: ${evalName}`, "", `Purpose: ${results[0]!.purpose}. Results: ${results.length}. Generated ${new Date().toISOString()}.`, "");
  lines.push("## Variants", "");
  lines.push("| variant | n (fixtures) | errors | win vs reference [95% CI] | all gates pass | mean tokens in / out / reasoning | latency mean / p90 (s) | $ total | $ per run |");
  lines.push("|---|---|---|---|---|---|---|---|---|");
  for (const row of rows) {
    const wins = tallies
      .filter(({ entry }) => entry!.key.candidate === row.variant)
      .map(({ judged, entry }) => `${formatShare(entry!.tally.winShare)} vs ${entry!.key.reference} (${judged.judges.join("+")}; W/T/L ${entry!.tally.wins}/${entry!.tally.ties}/${entry!.tally.losses})`);
    lines.push(
      `| ${row.variant} | ${row.n} (${row.fixtures}) | ${row.errors} | ${wins.join("<br>") || "–"} | ${pct(row.allGates)} | ${fmt(row.tokensIn)} / ${fmt(row.tokensOut)} / ${fmt(row.reasoning)} | ${fmt(row.latencyMean, 1)} / ${fmt(row.latencyP90, 1)} | ${fmt(row.usdTotal, 4)}${row.unpriced ? ` (+${row.unpriced} unpriced)` : ""} | ${fmt(row.usdMean, 5)} |`
    );
  }
  const checkIds = [...new Set(results.flatMap((result) => result.checks.map((check) => check.id)))];
  lines.push("", "## Deterministic checks", "", "Gates show the pass rate where the check applied (n in parentheses); measures show the mean value.", "");
  lines.push(`| check | ${rows.map((row) => row.variant).join(" | ")} |`, `|---|${rows.map(() => "---").join("|")}|`);
  for (const id of checkIds) {
    const cells = rows.map((row) => {
      const checks = row.rows.flatMap((result) => result.checks.filter((check) => check.id === id));
      const gated = checks.filter((check) => check.pass !== null);
      const values = checks.map((check) => check.value).filter((value): value is number => typeof value === "number");
      if (gated.length > 0) return `${pct(gated.filter((check) => check.pass).length / gated.length)} (${gated.length})`;
      return values.length ? `μ ${fmt(mean(values), 3)}` : "–";
    });
    lines.push(`| ${id} | ${cells.join(" | ")} |`);
  }
  if (tallies.length > 0) {
    lines.push("", "## Blind pairs", "", "A pair is a win only when both position-swapped orders agree; otherwise a tie. Win share is over decided pairs; win+tie over all judged pairs; sign test two-sided on decided pairs.", "");
    lines.push("| pair set | judges | candidate vs reference | W / T / L | identical | decided win share [95% CI] | win+tie share [95% CI] | sign p | missing |");
    lines.push("|---|---|---|---|---|---|---|---|---|");
    for (const { judged, entry } of tallies) {
      const { key, tally, identical, missing } = entry!;
      lines.push(`| ${judged.set} | ${judged.judges.join("+")} | ${key.candidate} vs ${key.reference} | ${tally.wins} / ${tally.ties} / ${tally.losses} | ${identical} | ${formatShare(tally.winShare)} | ${formatShare(tally.winOrTie)} | ${fmt(tally.signP, 3)} | ${missing} |`);
    }
    const problems = tallies.flatMap(({ entry }) => entry!.problems);
    if (problems.length) lines.push("", `Verdict problems: ${problems.slice(0, 10).join("; ")}`);
  }
  const errors = results.filter((result) => result.error);
  if (errors.length) lines.push("", "## Errors", "", ...errors.slice(0, 10).map((result) => `- ${result.variant} ${result.fixtureId}: ${result.error!.slice(0, 200)}`));
  return `${lines.join("\n")}\n`;
}
