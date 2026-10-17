/**
 * H2 helper. For every edit-chapter fixture whose logged whole-chapter acceptance was linked at extraction
 * (`meta.acceptanceCallId`), copy that acceptance call — messages, verdict, usage, latency — into
 * `fixtures/edit-acceptance.jsonl`, so an arm can replay today's acceptance with another candidate swapped in.
 * Runs INSIDE the worker container (run logs are MinIO objects). Read-only on MinIO.
 *
 *   docker exec -w /app/apps/worker ai-book-maker-worker-1 pnpm exec tsx /app/scripts/eval/container/edit-acceptances.ts [--ids a,b]
 */
import { join } from "node:path";
import { objectStore } from "../../../packages/storage/src/index.ts";
import { parseArgs } from "../lib/args.ts";
import { dataDir, loadFixtures, writeJsonl } from "../lib/fixtures.ts";
import { groupCalls, parseRunLogText } from "../lib/runlog.ts";

process.umask(0);
const args = parseArgs(process.argv.slice(2));
const root = dataDir(args.get("data"));
const fixtures = loadFixtures(root, "edit-chapter", args.list("ids").length ? { ids: args.list("ids") } : {}).filter((fixture) => typeof fixture.meta.acceptanceCallId === "string");
const store = objectStore();
const rows: unknown[] = [];
for (const projectId of new Set(fixtures.map((fixture) => fixture.projectId))) {
  const keys = (await store.list(`books/${projectId}/runs/`)).map((entry) => entry.key).filter((key) => /generate-book\.jsonl\.events\//.test(key)).sort();
  const parts = await Promise.all(keys.map(async (key) => (await store.get(key))?.toString("utf8") ?? ""));
  const calls = groupCalls(parseRunLogText(parts.join("")));
  for (const fixture of fixtures.filter((entry) => entry.projectId === projectId)) {
    const call = calls.find((entry) => entry.callId === fixture.meta.acceptanceCallId);
    if (!call) {
      console.log(JSON.stringify({ missing: fixture.fixtureId }));
      continue;
    }
    rows.push({ editFixtureId: fixture.fixtureId, callId: call.callId, model: call.answeredBy ?? call.model, temperature: call.temperature, maxTokens: call.maxTokens, messages: call.messages, response: { text: call.text, data: call.data }, usage: call.usage, durationMs: call.durationMs });
  }
}
writeJsonl(join(root, "fixtures", "edit-acceptance.jsonl"), rows);
console.log(JSON.stringify({ written: rows.length, of: fixtures.length }));
process.exit(0);
