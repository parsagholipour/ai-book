/**
 * Stage replay. Runs INSIDE the worker container:
 *
 *   docker exec -w /app/apps/worker ai-book-maker-worker-1 pnpm exec tsx /app/scripts/eval/container/replay.ts \
 *     --eval h2-demo --purpose edit-chapter --variants baseline,no-extend --limit 5 [--samples 2] [--concurrency 2] \
 *     [--tier fast] [--mode narrative] [--meta kind=line-edit] [--ids a,b] [--max-usd 0.5] [--force]
 *
 * Writes results/<eval>/<variant>/<fixtureId>__s<n>.json and results/<eval>/eval.json (the spec).
 * Existing results are kept (resumable) unless --force. --max-usd stops new calls once the summed
 * provider $ of this invocation passes it.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { mapWithConcurrency, parseArgs } from "../lib/args.ts";
import { dataDir, loadFixtures, readJson, resultPath, writeJson, type Fixture, type ReplayResult } from "../lib/fixtures.ts";
import { describeVariants, parseVariant, type ParsedVariant } from "../variants/index.ts";
import type { VariantContext } from "../variants/types.ts";
import { runChecks } from "./purposeChecks.ts";
import { callModel, callSearch } from "./runtime.ts";

process.umask(0);
const args = parseArgs(process.argv.slice(2));
const root = dataDir(args.get("data"));
const evalName = args.get("eval");
const purpose = args.get("purpose");
if (!evalName || !purpose || args.list("variants").length === 0) {
  console.error(`usage: replay.ts --eval <name> --purpose <purpose> --variants <spec,spec> [--limit N] [--samples N]\n\nvariants:\n${describeVariants()}`);
  process.exit(2);
}
const variants = args.list("variants").map(parseVariant);
for (const variant of variants) {
  if (variant.base.purposes && !variant.base.purposes.includes(purpose)) throw new Error(`Variant ${variant.spec} does not apply to ${purpose}`);
}
const samples = args.num("samples", 1);
const concurrency = args.num("concurrency", 2);
const maxUsd = args.num("max-usd", 1);
const force = args.flag("force");
const meta = Object.fromEntries(args.list("meta").map((pair) => pair.split("=") as [string, string]));
const limit = args.num("limit", 0);
const fixtures = loadFixtures(root, purpose, {
  ...(args.get("tier") ? { tier: args.get("tier")! } : {}),
  ...(args.get("mode") ? { writingMode: args.get("mode")! } : {}),
  ...(args.get("length") ? { lengthBucket: args.get("length")! } : {}),
  ...(args.get("job") ? { jobName: args.get("job")! } : {}),
  ...(args.list("ids").length ? { ids: args.list("ids") } : {}),
  meta,
  ...(limit > 0 ? { limit } : {})
});
if (fixtures.length === 0) throw new Error(`No ${purpose} fixtures match; run extract first or loosen the filter.`);

const specPath = join(root, "results", evalName, "eval.json");
const previous = existsSync(specPath) ? readJson<{ variants: string[]; fixtureIds: string[] }>(specPath) : { variants: [], fixtureIds: [] };
writeJson(specPath, {
  evalName,
  purpose,
  variants: [...new Set([...previous.variants, ...variants.map((variant) => variant.label)])],
  fixtureIds: [...new Set([...previous.fixtureIds, ...fixtures.map((fixture) => fixture.fixtureId)])],
  samples,
  updatedAt: new Date().toISOString()
});

let spentUsd = 0;
let stopped = false;
const jobs = fixtures.flatMap((fixture) => variants.flatMap((variant) => Array.from({ length: samples }, (_, sample) => ({ fixture, variant, sample }))));

async function runOne(fixture: Fixture, variant: ParsedVariant, sample: number): Promise<void> {
  const path = resultPath(root, evalName!, variant.label, fixture.fixtureId, sample);
  if (!force && existsSync(path)) return;
  if (stopped) return;
  const context: VariantContext = {
    fixture,
    route: variant.route,
    call: (options) => callModel(fixture.tier, { ...options, route: { ...variant.route, ...options.route } }),
    search: (query) => callSearch(query),
    sample,
    peer: (label) => {
      const peerPath = resultPath(root, evalName!, label, fixture.fixtureId, sample);
      return existsSync(peerPath) ? readJson<ReplayResult>(peerPath) : undefined;
    }
  };
  const startedAt = new Date().toISOString();
  const started = performance.now();
  const base = { evalName: evalName!, fixtureId: fixture.fixtureId, purpose: fixture.purpose, variant: variant.label, sample, startedAt };
  try {
    const run = await variant.base.run(context);
    const latencyMs = run.reported?.latencyMs ?? Math.round(performance.now() - started);
    const usage = run.reported?.usage ?? run.calls.reduce(
      (sum, call) => ({
        promptTokens: sum.promptTokens + call.usage.promptTokens,
        outputTokens: sum.outputTokens + call.usage.outputTokens,
        reasoningTokens: sum.reasoningTokens + call.usage.reasoningTokens,
        cacheHitTokens: sum.cacheHitTokens + call.usage.cacheHitTokens
      }),
      { promptTokens: 0, outputTokens: 0, reasoningTokens: 0, cacheHitTokens: 0 }
    );
    const costs = run.calls.map((call) => call.costUsd);
    const costUsd = run.reported ? run.reported.costUsd : costs.some((cost) => cost === null) ? null : costs.reduce<number>((sum, cost) => sum + (cost ?? 0), 0);
    if (!run.reported) spentUsd += costUsd ?? 0;
    const model = run.reported?.model ?? run.calls[0]?.model ?? { provider: "none", model: "none" };
    const maxTokens = run.calls.length > 0 ? fixture.request.maxTokens : undefined;
    const result: ReplayResult = {
      ...base,
      latencyMs,
      model,
      usage,
      costUsd,
      calls: run.calls.length,
      output: run.output,
      ...(run.finalText !== undefined ? { finalText: run.finalText } : {}),
      ...(run.data !== undefined ? { data: run.data } : {}),
      checks: runChecks(fixture, run, maxTokens),
      ...(run.extra ? { extra: run.extra } : {})
    };
    writeJson(path, result);
    const failed = result.checks.filter((check) => check.pass === false).map((check) => check.id);
    console.log(JSON.stringify({ fixture: fixture.fixtureId, variant: variant.label, sample, ms: latencyMs, out: usage.outputTokens, usd: costUsd, failed, spentUsd: Number(spentUsd.toFixed(4)) }));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    writeJson(path, { ...base, latencyMs: Math.round(performance.now() - started), model: { provider: "", model: "" }, usage: { promptTokens: 0, outputTokens: 0, reasoningTokens: 0, cacheHitTokens: 0 }, costUsd: null, calls: 0, output: "", checks: [], error: message } satisfies ReplayResult);
    console.log(JSON.stringify({ fixture: fixture.fixtureId, variant: variant.label, sample, error: message.slice(0, 200) }));
  }
  if (spentUsd > maxUsd && !stopped) {
    stopped = true;
    console.log(JSON.stringify({ stopped: `spent $${spentUsd.toFixed(3)} > --max-usd ${maxUsd}` }));
  }
}

console.log(JSON.stringify({ evalName, purpose, fixtures: fixtures.length, variants: variants.map((variant) => variant.spec), samples, jobs: jobs.length }));
await mapWithConcurrency(jobs, concurrency, (job) => runOne(job.fixture, job.variant, job.sample));
console.log(JSON.stringify({ done: true, spentUsd: Number(spentUsd.toFixed(4)) }));
process.exit(0);
