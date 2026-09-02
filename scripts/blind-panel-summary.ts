/**
 * Average a blind panel's JSON verdicts (the shape in
 * `.scratch/composed-chapters/blind-rubric.md`) into one table per candidate.
 *
 *   pnpm exec tsx scripts/blind-panel-summary.ts .scratch/composed-chapters/evals/<label> [<label dir>...]
 */
import { readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";

type Verdict = {
  scores: Record<string, number>;
  overall?: number;
  readiness?: string;
  slopSeverity?: string;
  recurringPatterns?: Array<{ pattern: string; instances?: string[] }>;
  summary?: string;
};

const CRITERIA = ["thesis", "structure", "depth", "reasoning", "clarity", "voice", "engagement", "pacing", "craft", "slopResistance"];

function loadPanel(dir: string): Verdict[] {
  return readdirSync(dir)
    .filter((name) => name.endsWith(".json"))
    .map((name) => JSON.parse(readFileSync(join(dir, name), "utf8")) as Verdict);
}

const dirs = process.argv.slice(2);
if (dirs.length === 0) {
  console.error("usage: blind-panel-summary.ts <evals dir>...");
  process.exit(2);
}
const panels = dirs.map((dir) => ({ name: basename(dir), verdicts: loadPanel(dir) }));
console.log(`${"criterion".padEnd(18)}${panels.map((panel) => panel.name.slice(0, 14).padStart(16)).join("")}`);
for (const criterion of CRITERIA) {
  console.log(
    `${criterion.padEnd(18)}${panels
      .map((panel) => {
        const values = panel.verdicts.map((verdict) => verdict.scores[criterion]).filter((value): value is number => typeof value === "number");
        return (values.length ? (values.reduce((sum, value) => sum + value, 0) / values.length).toFixed(2) : "-").padStart(16);
      })
      .join("")}`
  );
}
console.log(
  `${"overall".padEnd(18)}${panels
    .map((panel) => {
      const means = panel.verdicts.map((verdict) => CRITERIA.reduce((sum, criterion) => sum + (verdict.scores[criterion] ?? 0), 0) / CRITERIA.length);
      return (means.length ? (means.reduce((sum, value) => sum + value, 0) / means.length).toFixed(2) : "-").padStart(16);
    })
    .join("")}`
);
console.log(`${"per evaluator".padEnd(18)}${panels.map((panel) => panel.verdicts.map((verdict) => (CRITERIA.reduce((sum, criterion) => sum + (verdict.scores[criterion] ?? 0), 0) / CRITERIA.length).toFixed(1)).join("/").padStart(16)).join("")}`);
console.log(`${"readiness".padEnd(18)}${panels.map((panel) => panel.verdicts.map((verdict) => (verdict.readiness ?? "?").replace("Needs ", "").slice(0, 8)).join("/").padStart(16)).join("")}`);
console.log(`${"slop severity".padEnd(18)}${panels.map((panel) => panel.verdicts.map((verdict) => verdict.slopSeverity ?? "?").join("/").padStart(16)).join("")}`);
for (const panel of panels) {
  console.log(`\n== ${panel.name}: recurring patterns`);
  for (const verdict of panel.verdicts) {
    for (const pattern of verdict.recurringPatterns ?? []) {
      console.log(`- ${pattern.pattern}${pattern.instances?.[0] ? ` — e.g. "${pattern.instances[0].slice(0, 140)}"` : ""}`);
    }
  }
}
