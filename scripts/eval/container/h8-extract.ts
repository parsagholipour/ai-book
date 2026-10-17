/**
 * H8 (parallel chapter lanes) — frozen book records. Runs INSIDE the worker container:
 *
 *   docker exec -w /app/apps/worker ai-book-maker-worker-1 pnpm exec tsx /app/scripts/eval/container/h8-extract.ts --projects id,id
 *
 * For each book: the project row, every Chapter row's stored composition (sections, owns, landing) and
 * ledger facts (`report.facts`), and from the generate-book run logs every compose-chapter and
 * extract-chapter-facts call (request messages, reply, latency, usage) plus the per-call timeline the
 * loop-time estimate reads. Writes `.scratch/eval-data/h8/books/<projectId>.json`. Read-only on the
 * database and MinIO.
 */
import { join } from "node:path";
import { prisma } from "../../../packages/db/src/client.ts";
import { objectStore } from "../../../packages/storage/src/index.ts";
import { mapWithConcurrency, parseArgs } from "../lib/args.ts";
import { dataDir, ensureDir, writeJson } from "../lib/fixtures.ts";
import { groupCalls, parseRunLogText, type LoggedCall, type RunEvent } from "../lib/runlog.ts";
import { parseJsonReply } from "../lib/text.ts";

process.umask(0);
const args = parseArgs(process.argv.slice(2));
const root = dataDir(args.get("data"));
const projects = args.list("projects");
const out = ensureDir(join(root, "h8", "books"));

const asRecord = (value: unknown): Record<string, unknown> => (value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {});

async function readGenerateBookLogs(projectId: string): Promise<Array<{ log: string; text: string }>> {
  const store = objectStore();
  const events = await store.list(`books/${projectId}/runs/`);
  const byLog = new Map<string, string[]>();
  for (const event of events) {
    const [logKey] = event.key.split(".events/");
    if (!logKey || logKey === event.key) continue;
    byLog.set(logKey, [...(byLog.get(logKey) ?? []), event.key]);
  }
  const result: Array<{ log: string; text: string }> = [];
  for (const [logKey, keys] of byLog) {
    if (!logKey.endsWith("generate-book.jsonl")) continue;
    keys.sort();
    const parts = await mapWithConcurrency(keys, 6, async (key) => (await store.get(key))?.toString("utf8") ?? "");
    result.push({ log: logKey, text: parts.join("") });
  }
  return result;
}

function payloadOf(call: LoggedCall): Record<string, unknown> {
  const last = [...call.messages].reverse().find((message) => message.role === "user");
  return asRecord(last ? parseJsonReply(last.content) : undefined);
}

const callRecord = (call: LoggedCall) => ({
  callId: call.callId,
  purpose: call.purpose,
  model: call.answeredBy?.model ? call.answeredBy : call.model,
  startedAt: call.startedAt,
  endedAt: call.endedAt,
  durationMs: call.durationMs,
  temperature: call.temperature,
  maxTokens: call.maxTokens,
  messages: call.messages,
  text: call.text ?? "",
  ...(call.data !== undefined ? { data: call.data } : {}),
  usage: call.usage,
  attempts: call.attempts,
  ok: call.ok,
  errors: call.errors
});

for (const projectId of projects) {
  const project = await prisma.project.findUnique({ where: { id: projectId }, select: { id: true, title: true, prompt: true, category: true, targetPages: true, language: true, mediaSettings: true, currentPlanId: true, createdAt: true } });
  if (!project) {
    console.warn(`missing project ${projectId}`);
    continue;
  }
  const plan = project.currentPlanId ? await prisma.planVersion.findUnique({ where: { id: project.currentPlanId }, select: { planningPackage: true } }) : null;
  const pkg = asRecord(plan?.planningPackage);
  const media = asRecord(project.mediaSettings);
  const chapters = await prisma.chapter.findMany({ where: { projectId }, orderBy: { index: "asc" }, select: { index: true, title: true, summary: true, targetPages: true, productionBrief: true } });
  const logs = await readGenerateBookLogs(projectId);
  const runs = logs.map(({ log, text }) => {
    const events = parseRunLogText(text);
    const calls = groupCalls(events);
    const keep = calls.filter((call) => ["compose-chapter", "extract-chapter-facts", "describe-pages", "compose-scene", "edit-chapter", "review-chapter-edit-acceptance"].includes(call.purpose));
    const loopEvents = events.filter((event: RunEvent) => /^generation\.composed_chapters\.(facts|facts_failed|length_retry_failed|degenerate_draft)$/.test(event.event)).map((event) => ({ event: event.event, timestamp: event.timestamp, chapterIndex: event.chapterIndex, ms: event.ms }));
    return {
      log,
      startedAt: events[0]?.timestamp,
      endedAt: events.at(-1)?.timestamp,
      calls: keep.map((call) => {
        const payload = payloadOf(call);
        const chapterIndex = asRecord(payload.chapter).index ?? asRecord(payload.chapterPosition).index ?? payload.chapterIndex;
        return { chapterIndex: typeof chapterIndex === "number" ? chapterIndex : null, ...callRecord(call) };
      }),
      loopEvents
    };
  });
  const record = {
    projectId,
    title: String(pkg.title ?? project.title),
    prompt: project.prompt,
    category: String(project.category),
    targetPages: project.targetPages,
    language: project.language,
    tier: String(media.modelTier ?? "balanced"),
    lane: String(asRecord(asRecord(media.mobile).recipe).lane ?? asRecord(asRecord(media.mobile).brief).intent ?? ""),
    writingMode: String(pkg.writingMode ?? "unknown"),
    premise: pkg.premise,
    audience: pkg.audience,
    exampleCast: pkg.exampleCast,
    characters: pkg.characters,
    chapters: chapters.map((chapter) => {
      const brief = asRecord(chapter.productionBrief);
      return {
        index: chapter.index,
        title: chapter.title,
        summary: chapter.summary,
        targetPages: chapter.targetPages,
        composition: brief.composition ?? null,
        facts: asRecord(brief.report).facts ?? null
      };
    }),
    runs
  };
  writeJson(join(out, `${projectId}.json`), record);
  const composes = runs.flatMap((run) => run.calls.filter((call) => call.purpose === "compose-chapter"));
  console.log(`${projectId} ${record.tier} ${record.writingMode} ch=${chapters.length} runs=${runs.length} compose=${composes.length} facts=${runs.flatMap((run) => run.calls.filter((call) => call.purpose === "extract-chapter-facts")).length}`);
}
await prisma.$disconnect();
