/**
 * The statistics every eval report uses: Wilson intervals on a decided-pair win share, an exact
 * two-sided sign test, and the small descriptive helpers (mean, percentile). Pure; no I/O.
 */

export type Interval = { share: number; low: number; high: number };

/** Wilson score interval for `wins` out of `n` decided trials (95% by default). */
export function wilson(wins: number, n: number, z = 1.959964): Interval {
  if (n <= 0) return { share: Number.NaN, low: 0, high: 1 };
  const p = wins / n;
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const centre = (p + z2 / (2 * n)) / denom;
  const half = (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / denom;
  return { share: p, low: Math.max(0, centre - half), high: Math.min(1, centre + half) };
}

function logChoose(n: number, k: number): number {
  let total = 0;
  for (let i = 1; i <= k; i += 1) total += Math.log(n - k + i) - Math.log(i);
  return total;
}

/** Exact two-sided sign test on decided pairs: P(at least as extreme | p = 0.5). Ties are excluded by the caller. */
export function signTest(wins: number, losses: number): number {
  const n = wins + losses;
  if (n === 0) return 1;
  const k = Math.min(wins, losses);
  let tail = 0;
  for (let i = 0; i <= k; i += 1) tail += Math.exp(logChoose(n, i) - n * Math.LN2);
  return Math.min(1, 2 * tail);
}

export function mean(values: readonly number[]): number {
  return values.length === 0 ? Number.NaN : values.reduce((sum, value) => sum + value, 0) / values.length;
}

/** Nearest-rank percentile (p in 0..100). */
export function percentile(values: readonly number[], p: number): number {
  if (values.length === 0) return Number.NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.max(1, Math.ceil((p / 100) * sorted.length));
  return sorted[Math.min(sorted.length, rank) - 1]!;
}

export type PairTally = {
  wins: number;
  ties: number;
  losses: number;
  decided: number;
  winShare: Interval;
  /** win + tie share over all pairs: the plan's "win+tie ≥ 50%" gates read this. */
  winOrTie: Interval;
  signP: number;
};

/** Tally pair outcomes from the candidate's side: "win" means the candidate (B) beat the reference (A). */
export function tallyPairs(outcomes: ReadonlyArray<"win" | "tie" | "loss">): PairTally {
  const wins = outcomes.filter((outcome) => outcome === "win").length;
  const losses = outcomes.filter((outcome) => outcome === "loss").length;
  const ties = outcomes.length - wins - losses;
  return {
    wins,
    ties,
    losses,
    decided: wins + losses,
    winShare: wilson(wins, wins + losses),
    winOrTie: wilson(wins + ties, outcomes.length),
    signP: signTest(wins, losses)
  };
}

export function formatShare(interval: Interval): string {
  if (!Number.isFinite(interval.share)) return "–";
  return `${(interval.share * 100).toFixed(0)}% [${(interval.low * 100).toFixed(0)}–${(interval.high * 100).toFixed(0)}]`;
}
