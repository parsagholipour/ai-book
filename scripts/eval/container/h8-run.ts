/**
 * H8 arm runner. Runs INSIDE the worker container:
 *
 *   docker exec -w /app/apps/worker ai-book-maker-worker-1 pnpm exec tsx /app/scripts/eval/container/h8-run.ts \
 *     --arms S,P0,P1 --samples 0 [--pairs p01,p02] [--concurrency 4] [--max-usd 2] [--force]
 *   … --arms PR --samples 0          (after P1: PR is built on P1's sample)
 *
 * Arms are pre-registered in `.scratch/eval-data/h8/preregistration.md`. Every call is built on the tier's live
 * route (`runtime.ts`): compose-chapter, extract-chapter-facts, and the reconciliation on the edit-chapter route.
 * Writes `h8/results/<arm>/<pairId>__s<n>.json`; resumable unless --force.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { mapWithConcurrency, parseArgs } from "../lib/args.ts";
import { dataDir, readJson, writeJson } from "../lib/fixtures.ts";
import { unwrapWholeFence } from "../lib/text.ts";
import { parallelMessages, transformAudit } from "../variants/h8/arms.ts";
import { detectConflicts } from "../variants/h8/factConflicts.ts";
import { parseReconcileReply, reconcileMessages, RECONCILE_PURPOSE_ROUTE } from "../variants/h8/reconcile.ts";
import type { ArmCall, Fact, H8Pair, H8Result } from "../variants/h8/types.ts";
import { callModel, core, type CallRecord } from "./runtime.ts";

process.umask(0);
const args = parseArgs(process.argv.slice(2));
const root = dataDir(args.get("data"));
const arms = args.list("arms") as Array<H8Result["arm"]>;
const samples = args.list("samples").map(Number);
const onlyPairs = new Set(args.list("pairs"));
const concurrency = args.num("concurrency", 4);
const maxUsd = args.num("max-usd", 2);
const force = args.flag("force");
/** `--dir h8b`: another eval's pairs and results. `--no-facts`: skip the fact read (no rule of that eval reads it). */
const evalDir = args.get("dir") ?? "h8";
const readFacts = !args.flag("no-facts");
const pairs = readJson<H8Pair[]>(join(root, evalDir, "pairs.json")).filter((pair) => onlyPairs.size === 0 || onlyPairs.has(pair.pairId));
const resultPath = (arm: string, pairId: string, sample: number) => join(root, evalDir, "results", arm, `${pairId}__s${sample}.json`);

let spentUsd = 0;
let stopped = false;

const armCall = (purpose: string, record: CallRecord, role: "product" | "measure"): ArmCall & { role: string } => ({
  purpose, role, latencyMs: record.latencyMs, usage: record.usage, costUsd: record.costUsd, model: record.model
});

/** A TextModelAdapter over the live route that records every call (product functions take one). */
function recordingModel(tier: string, sink: ArmCall[], role: "product" | "measure"): core.TextModelAdapter {
  const run = async (options: { purpose?: string; messages: Array<{ role: string; content: string }>; temperature?: number; maxTokens?: number }, json: boolean) => {
    const record = await callModel(tier, {
      purpose: options.purpose ?? "unknown",
      messages: options.messages as never,
      json,
      ...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
      ...(options.maxTokens !== undefined ? { maxTokens: options.maxTokens } : {})
    });
    spentUsd += record.costUsd ?? 0;
    sink.push(armCall(options.purpose ?? "unknown", record, role));
    return record;
  };
  return {
    async generateText(options: never) {
      const record = await run(options, false);
      return { text: record.text, model: record.model.model, provider: record.model.provider, usage: record.usage };
    },
    async generateJson(options: { schema: { safeParse(value: unknown): { success: boolean; data?: unknown; error?: unknown } } } & Record<string, unknown>) {
      const record = await run(options as never, true);
      const parsed = options.schema.safeParse(record.data);
      if (!parsed.success) throw new Error(`schema: ${String(parsed.error).slice(0, 200)}`);
      return { text: record.text, model: record.model.model, provider: record.model.provider, usage: record.usage, data: parsed.data };
    },
    streamText() {
      throw new Error("not used");
    },
    generateWithTools() {
      throw new Error("not used");
    }
  } as unknown as core.TextModelAdapter;
}

const normalize = (pair: H8Pair, text: string) =>
  core.normalizeChapterMarkdown(unwrapWholeFence(text), { chapterTitle: pair.n1Title, ...(pair.writingMode === "instructional" ? { keepSubheadings: true } : {}) });

async function factsOf(pair: H8Pair, text: string, sink: ArmCall[], role: "product" | "measure"): Promise<Fact[] | undefined> {
  try {
    const { facts } = await core.extractChapterFacts({ title: pair.bookTitle, chapterIndex: pair.n1, markdown: text, known: pair.ledgerBeforeN, textModel: recordingModel(pair.tier, sink, role), language: pair.language });
    return facts;
  } catch (error) {
    console.log(JSON.stringify({ pair: pair.pairId, factsError: error instanceof Error ? error.message.slice(0, 200) : String(error) }));
    return undefined;
  }
}

async function composeArm(pair: H8Pair, arm: "S" | "P0" | "P1", sample: number): Promise<H8Result> {
  const options = { withPlan: arm === "P1", establishedFactsWriterRule: core.ESTABLISHED_FACTS_WRITER_RULE };
  const messages = arm === "S" ? pair.n1Request.messages : parallelMessages(pair, options);
  const calls: ArmCall[] = [];
  const record = await callModel(pair.tier, {
    purpose: "compose-chapter",
    messages,
    ...(pair.n1Request.temperature !== undefined ? { temperature: pair.n1Request.temperature } : {}),
    ...(pair.n1Request.maxTokens !== undefined ? { maxTokens: pair.n1Request.maxTokens } : {}),
    timeoutMs: 420_000
  });
  spentUsd += record.costUsd ?? 0;
  calls.push(armCall("compose-chapter", record, "product"));
  const text = normalize(pair, record.text);
  // The parallel product reads N+1's facts against the ledger before N; for S the read is measurement only.
  const factsN1 = readFacts ? await factsOf(pair, text, calls, arm === "S" ? "measure" : "product") : undefined;
  return {
    pairId: pair.pairId, arm, sample, text, calls,
    ...(factsN1 ? { factsN1, conflicts: detectConflicts(pair.factsN, factsN1) } : {}),
    ...(arm === "S" ? {} : { audit: transformAudit(pair, messages, options) })
  } as H8Result;
}

async function reconcileArm(pair: H8Pair, sample: number): Promise<H8Result | undefined> {
  const p1Path = resultPath("P1", pair.pairId, sample);
  if (!existsSync(p1Path)) return undefined;
  const p1 = readJson<H8Result>(p1Path);
  if (p1.error || !p1.conflicts) return { pairId: pair.pairId, arm: "PR", sample, text: p1.text, calls: [], error: p1.error ?? "P1 has no facts read" };
  if (p1.conflicts.length === 0) {
    return { pairId: pair.pairId, arm: "PR", sample, text: p1.text, calls: [], factsN1: p1.factsN1 ?? [], conflicts: [], repair: { fired: false, conflicts: 0, patches: 0, applied: 0, failures: 0, skipped: 0, changed: false } };
  }
  const calls: ArmCall[] = [];
  const ledgerThroughN = core.chapterFactLines([...pair.ledgerBeforeN, ...pair.factsN]);
  const record = await callModel(pair.tier, { purpose: RECONCILE_PURPOSE_ROUTE, json: true, temperature: 0, maxTokens: 4000, messages: reconcileMessages(pair, p1.text, p1.conflicts, ledgerThroughN) });
  spentUsd += record.costUsd ?? 0;
  calls.push(armCall("reconcile-chapter-facts", record, "product"));
  const reply = parseReconcileReply(record.data);
  const application = core.applyPagePatches(p1.text, reply.patches);
  const text = application.markdown;
  const changed = text !== p1.text;
  const factsN1 = changed ? await factsOf(pair, text, calls, "measure") : p1.factsN1;
  return {
    pairId: pair.pairId, arm: "PR", sample, text, calls,
    ...(factsN1 ? { factsN1, conflicts: detectConflicts(pair.factsN, factsN1) } : {}),
    repair: { fired: true, conflicts: p1.conflicts.length, patches: reply.patches.length, applied: application.applied, failures: application.failures.length, skipped: reply.skipped.length, changed, latencyMs: record.latencyMs },
    reconcile: { patches: reply.patches, skipped: reply.skipped, failures: application.failures }
  } as H8Result;
}

async function runOne(pair: H8Pair, arm: H8Result["arm"], sample: number): Promise<void> {
  const path = resultPath(arm, pair.pairId, sample);
  if ((!force && existsSync(path)) || stopped) return;
  const started = performance.now();
  try {
    const result = arm === "PR" ? await reconcileArm(pair, sample) : await composeArm(pair, arm, sample);
    if (!result) return;
    writeJson(path, result);
    console.log(JSON.stringify({ pair: pair.pairId, arm, sample, ms: Math.round(performance.now() - started), words: result.text.split(/\s+/).length, conflicts: result.conflicts?.length, repair: result.repair, spentUsd: Number(spentUsd.toFixed(4)) }));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.log(JSON.stringify({ pair: pair.pairId, arm, sample, error: message.slice(0, 300) }));
  }
  if (spentUsd > maxUsd && !stopped) {
    stopped = true;
    console.log(JSON.stringify({ stopped: `spent $${spentUsd.toFixed(3)} > --max-usd ${maxUsd}` }));
  }
}

const jobs = samples.flatMap((sample) => pairs.flatMap((pair) => arms.map((arm) => ({ pair, arm, sample }))));
console.log(JSON.stringify({ pairs: pairs.length, arms, samples, jobs: jobs.length }));
await mapWithConcurrency(jobs, concurrency, (job) => runOne(job.pair, job.arm, job.sample));
console.log(JSON.stringify({ done: true, spentUsd: Number(spentUsd.toFixed(4)) }));
process.exit(0);
