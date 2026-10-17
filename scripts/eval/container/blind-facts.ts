/**
 * Blind fact extraction over replayed compose outputs (E1c's approximate ledger-contradiction check). Runs INSIDE
 * the worker container:
 *
 *   docker exec -w /app/apps/worker ai-book-maker-worker-1 pnpm exec tsx /app/scripts/eval/container/blind-facts.ts \
 *     --data /app/.scratch/eval-data/e1c/data --eval e1c-gemini-fiction --templates /app/.scratch/eval-data/e1c/facts-data \
 *     --ids a,b --variants v1,v2 [--samples 2] [--concurrency 6] [--max-usd 0.2]
 *
 * For each compose result it takes a logged `extract-chapter-facts` request of the same book as the template, swaps in
 * the result's chapter text and chapter index, and empties `knownFacts`: the product's extractor is told to leave out
 * a value that merely differs from the ledger, so a blind read is the one that reports what the chapter states. The
 * reply is written to results/<eval>/_facts/<variant>/<fixtureId>__s<n>.json; comparing it with the ledger the writer
 * was shown is the host analysis's job.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { mapWithConcurrency, parseArgs } from "../lib/args.ts";
import { dataDir, loadFixtures, readJson, writeJson, type ReplayResult } from "../lib/fixtures.ts";
import { callModel } from "./runtime.ts";

process.umask(0);
const args = parseArgs(process.argv.slice(2));
const root = dataDir(args.get("data"));
const evalName = args.get("eval") ?? "e1c-gemini-fiction";
const templatesRoot = dataDir(args.get("templates"));
const ids = new Set(args.list("ids"));
const variants = args.list("variants");
const samples = args.num("samples", 2);
const maxUsd = args.num("max-usd", 0.2);

const compose = loadFixtures(root, "compose-chapter").filter((fixture) => ids.size === 0 || ids.has(fixture.fixtureId));
const templates = loadFixtures(templatesRoot, "extract-chapter-facts");
const templateFor = (projectId: string) => templates.filter((fixture) => fixture.projectId === projectId).sort((a, b) => (a.chapterIndex ?? 0) - (b.chapterIndex ?? 0))[0];

let spent = 0;
const jobs = compose.flatMap((fixture) => variants.flatMap((variant) => Array.from({ length: samples }, (_, sample) => ({ fixture, variant, sample }))));
await mapWithConcurrency(jobs, args.num("concurrency", 6), async ({ fixture, variant, sample }) => {
  const out = join(root, "results", evalName, "_facts", variant, `${fixture.fixtureId}__s${sample}.json`);
  const source = join(root, "results", evalName, variant, `${fixture.fixtureId}__s${sample}.json`);
  const template = templateFor(fixture.projectId);
  if (existsSync(out) || !existsSync(source) || !template || spent > maxUsd) return;
  const result = readJson<ReplayResult>(source);
  const payload = { ...template.payload } as Record<string, unknown>;
  payload.chapter = { ...(payload.chapter as Record<string, unknown>), index: fixture.chapterIndex, markdown: result.finalText ?? result.output };
  payload.knownFacts = [];
  const messages = template.messages.map((message, index) => (index === template.messages.length - 1 && message.role === "user" ? { ...message, content: JSON.stringify(payload, null, 2) } : message));
  try {
    const record = await callModel(fixture.tier, { purpose: "extract-chapter-facts", json: true, messages, ...(template.request.maxTokens ? { maxTokens: template.request.maxTokens } : {}), temperature: 0 });
    spent += record.costUsd ?? 0;
    writeJson(out, { fixtureId: fixture.fixtureId, variant, sample, template: template.fixtureId, model: record.model, usage: record.usage, costUsd: record.costUsd, data: record.data ?? null, text: record.text });
    console.log(JSON.stringify({ fixture: fixture.fixtureId, variant, sample, usd: record.costUsd, spent: Number(spent.toFixed(4)) }));
  } catch (error) {
    console.log(JSON.stringify({ fixture: fixture.fixtureId, variant, sample, error: String(error).slice(0, 200) }));
  }
});
console.log(JSON.stringify({ done: true, spent }));
process.exit(0);
