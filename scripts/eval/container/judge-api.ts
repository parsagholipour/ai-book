/**
 * Secondary, unattended judge: an API model reads each pair-order folder exactly as an Opus reader
 * would (same instructions, same rubric, same files) and writes its verdict. Runs INSIDE the worker
 * container (provider keys live there):
 *
 *   docker exec -w /app/apps/worker ai-book-maker-worker-1 pnpm exec tsx /app/scripts/eval/container/judge-api.ts \
 *     --set <pair set> [--judge sol] [--model openai:gpt-6-sol] [--effort medium] [--concurrency 4] [--max-usd 1] [--folders a,b]
 *
 * Default: gpt-6-sol at medium reasoning through the OpenAI adapter, as on 2026-10-03.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { mapWithConcurrency, parseArgs } from "../lib/args.ts";
import { dataDir, readJson, writeJson } from "../lib/fixtures.ts";
import { setDir, verdictPath } from "../lib/pairs.ts";
import { anyJsonSchema, config, core, costOf, z } from "./runtime.ts";

process.umask(0);
const args = parseArgs(process.argv.slice(2));
const root = dataDir(args.get("data"));
const set = args.get("set");
if (!set) {
  console.error("usage: judge-api.ts --set <pair set> [--judge sol] [--model openai:gpt-6-sol] [--effort medium]");
  process.exit(2);
}
const judge = args.get("judge") ?? "sol";
const [provider, ...modelParts] = (args.get("model") ?? "openai:gpt-6-sol").split(":");
const selection = { provider: provider!, model: modelParts.join(":"), thinkingEffort: args.get("effort") ?? "medium", thinkingEnabled: (args.get("effort") ?? "medium") !== "none" };
const adapter = core.createTextModelAdapter(config, selection as never, { maxRetries: 1 });
const maxUsd = args.num("max-usd", 1);
const manifest = readJson<{ artifact: string; folders: Array<{ folder: string; path: string }>; instructions: string }>(join(setDir(root, set), "manifest.json"));
const only = new Set(args.list("folders"));

const pick = z.enum(["A", "B", "tie"]);
const verdictSchema = z.object({
  preferred: pick,
  confidence: z.string().optional(),
  dimensions: z.record(z.string(), z.string()).optional(),
  reason: z.string().optional(),
  defectsA: z.array(z.string()).optional(),
  defectsB: z.array(z.string()).optional()
});

let spent = 0;
let stopped = false;
const read = (dir: string, name: string) => (existsSync(join(dir, name)) ? readFileSync(join(dir, name), "utf8") : "");

await mapWithConcurrency(manifest.folders.filter((entry) => only.size === 0 || only.has(entry.folder)), args.num("concurrency", 4), async ({ folder }) => {
  // The manifest's paths are the host's; inside the container the same folder is under the data dir.
  const path = join(setDir(root, set), "folders", folder);
  const out = verdictPath(root, set, judge, folder);
  if (existsSync(out) || stopped) return;
  // The folder is the whole input: the same files an Opus reader is pointed at.
  const user = [
    `brief.txt:\n${read(path, "brief.txt")}`,
    `context.md:\n${read(path, "context.md") || "(empty)"}`,
    `A.md:\n${read(path, "A.md")}`,
    `B.md:\n${read(path, "B.md")}`
  ].join("\n\n-----\n\n");
  if (!read(path, "A.md") || !read(path, "rubric.md")) {
    console.log(JSON.stringify({ folder, error: `folder unreadable at ${path}` }));
    return;
  }
  const started = performance.now();
  try {
    const result = await adapter.generateJson({
      purpose: "eval-blind-pair",
      schema: anyJsonSchema,
      maxTokens: 12_000,
      signal: AbortSignal.timeout(300_000),
      messages: [
        { role: "system", content: `${read(path, "instructions.md")}\n\n${read(path, "rubric.md")}` },
        { role: "user", content: user }
      ]
    });
    const parsed = verdictSchema.safeParse(result.data);
    if (!parsed.success) throw new Error(`not a verdict: ${result.text.slice(0, 400)}`);
    const raw = (result.usage ?? {}) as Record<string, number | undefined>;
    const usage = { promptTokens: raw.promptTokens ?? 0, outputTokens: raw.outputTokens ?? 0, reasoningTokens: raw.reasoningTokens ?? 0, cacheHitTokens: raw.cacheHitTokens ?? 0 };
    const costUsd = costOf({ provider: selection.provider, model: selection.model }, usage);
    spent += costUsd ?? 0;
    writeJson(out, { ...parsed.data, judge, model: selection, usage, costUsd, latencyMs: Math.round(performance.now() - started) });
    console.log(JSON.stringify({ folder, preferred: parsed.data.preferred, s: Math.round((performance.now() - started) / 1000), usd: costUsd, spent: Number(spent.toFixed(4)) }));
  } catch (error) {
    console.log(JSON.stringify({ folder, error: (error instanceof Error ? error.message : String(error)).slice(0, 300) }));
  }
  if (spent > maxUsd && !stopped) {
    stopped = true;
    console.log(JSON.stringify({ stopped: `spent $${spent.toFixed(3)} > --max-usd ${maxUsd}` }));
  }
});
console.log(JSON.stringify({ done: true, judge, spent: Number(spent.toFixed(4)) }));
process.exit(0);
