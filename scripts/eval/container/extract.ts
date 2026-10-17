/**
 * Fixture extraction. Runs INSIDE the worker container (run logs are MinIO objects the host cannot
 * read; the repo is bind-mounted at /app, so output lands in the host's .scratch/eval-data):
 *
 *   docker exec -w /app/apps/worker ai-book-maker-worker-1 pnpm exec tsx /app/scripts/eval/container/extract.ts [--since 2026-09-15] [--quota edit-chapter=60] [--per-book compose-chapter=20] [--projects id,id] [--dry-run]
 *
 * (or `pnpm exec tsx scripts/eval/eval.ts extract …` from the host, which runs exactly that).
 *
 * Reads the database for candidate books (tier, writing mode, length, call counts per purpose),
 * visits them in a stratified round-robin (tier × writing mode × length, newest first), reads only
 * the run logs that hold the wanted purposes, and writes compact JSONL per purpose plus each
 * contributing book's plan. Nothing is written to MinIO or the database. Read-only.
 */
import { existsSync, readdirSync, readFileSync, rmSync, statfsSync } from "node:fs";
import { join } from "node:path";
import { prisma } from "../../../packages/db/src/client.ts";
import { objectStore } from "../../../packages/storage/src/index.ts";
import { mapWithConcurrency, parseArgs } from "../lib/args.ts";
import {
  dataDir,
  ensureDir,
  fixturesPath,
  lengthBucket,
  stratumOf,
  writeJson,
  writeJsonl,
  type FixtureContext,
  type Purpose,
  type StoredFixture
} from "../lib/fixtures.ts";
import { groupCalls, parseRunLogText, type LoggedCall } from "../lib/runlog.ts";
import { edges, parseJsonReply, unwrapWholeFence, withoutFences, wordCount, words } from "../lib/text.ts";

process.umask(0);
const args = parseArgs(process.argv.slice(2));
const root = dataDir(args.get("data"));
const since = args.get("since") ?? "2026-09-15";
const concurrency = args.num("concurrency", 6);
const maxBooks = args.num("max-books", 400);
const dryRun = args.flag("dry-run");
const onlyProjects = new Set(args.list("projects"));

/** Quota keys are a purpose, or `purpose@job` where one purpose means two different calls. */
const QUOTAS: Record<string, { total: number; perBook: number }> = {
  "compose-chapter": { total: 40, perBook: 1 },
  "edit-chapter": { total: 60, perBook: 2 },
  "review-chapter-edit-acceptance": { total: 40, perBook: 2 },
  // H1 wants 25–40 Balanced pre-read manuscripts; the per-stratum cap spreads this across Quick Draft too.
  "read-manuscript@generate-book": { total: 60, perBook: 1 },
  "read-manuscript@compile-export": { total: 10, perBook: 1 },
  "cut-chapter": { total: 40, perBook: 3 },
  "extract-chapter-facts": { total: 40, perBook: 2 },
  "final-book-qa": { total: 30, perBook: 1 },
  "patch-page": { total: 30, perBook: 2 },
  "chapter-research": { total: 30, perBook: 2 },
  "case-source-search": { total: 30, perBook: 2 },
  "extract-excerpts": { total: 30, perBook: 2 }
};
for (const override of args.list("quota")) {
  const [key, value] = override.split("=");
  if (key && QUOTAS[key] && value) QUOTAS[key] = { ...QUOTAS[key], total: Number(value) };
}
// `--per-book compose-chapter=20` raises how many calls one book may give a purpose (every chapter of a book, say).
for (const override of args.list("per-book")) {
  const [key, value] = override.split("=");
  if (key && QUOTAS[key] && value) QUOTAS[key] = { ...QUOTAS[key], perBook: Number(value) };
}
const PURPOSES = [...new Set(Object.keys(QUOTAS).map((key) => key.split("@")[0]!))];

type ProjectRow = {
  id: string;
  title: string;
  prompt: string;
  category: string;
  targetPages: number;
  language: string;
  createdAt: Date;
  tier: string;
  lane: string | null;
  writingMode: string;
  planTitle: string | null;
  premise: string | null;
  audience: string | null;
  planId: string | null;
};
type CountRow = { projectId: string; purpose: string; job: string | null; n: number };

function quotaKey(purpose: string, jobName: string): string | undefined {
  if (purpose === "read-manuscript") return jobName === "compile-export" ? "read-manuscript@compile-export" : jobName === "generate-book" ? "read-manuscript@generate-book" : undefined;
  return QUOTAS[purpose] ? purpose : undefined;
}

const JOBS_FOR: Record<string, string[]> = {
  "final-book-qa": ["compile-export"],
  "read-manuscript@compile-export": ["compile-export"],
  "patch-page": ["compile-export", "apply-book-edit"]
};
const jobsFor = (key: string) => JOBS_FOR[key] ?? ["generate-book"];

async function loadCandidates(): Promise<{ projects: ProjectRow[]; counts: Map<string, Map<string, number>> }> {
  const projects = await prisma.$queryRawUnsafe<ProjectRow[]>(
    `select p.id, p.title, p.prompt, p.category::text as category, p."targetPages", p.language, p."createdAt",
       coalesce(p."mediaSettings"->>'modelTier', 'balanced') as tier,
       coalesce(p."mediaSettings"->'mobile'->'recipe'->>'lane', p."mediaSettings"->'mobile'->'brief'->>'intent') as lane,
       coalesce(pv."planningPackage"->>'writingMode', 'unknown') as "writingMode",
       pv."planningPackage"->>'title' as "planTitle", pv."planningPackage"->>'premise' as premise,
       pv."planningPackage"->>'audience' as audience, p."currentPlanId" as "planId"
     from "Project" p left join "PlanVersion" pv on pv.id = p."currentPlanId"
     where p."createdAt" >= $1::timestamptz
     order by p."createdAt" desc`,
    since
  );
  const rows = await prisma.$queryRawUnsafe<CountRow[]>(
    `select c."projectId", c.purpose, lower(replace(j.type::text, '_', '-')) as job, count(*)::int as n
     from "ProviderCallLog" c left join "GenerationJob" j on j.id = c."generationJobId"
     where c."createdAt" >= $1::timestamptz and c.purpose = any($2::text[]) and c."projectId" is not null
     group by 1, 2, 3`,
    since,
    PURPOSES
  );
  const counts = new Map<string, Map<string, number>>();
  for (const row of rows) {
    const key = quotaKey(row.purpose, row.job ?? "");
    if (!key) continue;
    const map = counts.get(row.projectId) ?? new Map<string, number>();
    map.set(key, (map.get(key) ?? 0) + row.n);
    counts.set(row.projectId, map);
  }
  return { projects: projects.filter((project) => counts.has(project.id) && (onlyProjects.size === 0 || onlyProjects.has(project.id))), counts };
}

/** One queue per stratum (tier × writing mode × length), newest book first. */
function strataQueues(projects: ProjectRow[]): ProjectRow[][] {
  const groups = new Map<string, ProjectRow[]>();
  for (const project of projects) {
    const key = stratumOf({ tier: project.tier, writingMode: project.writingMode, lengthBucket: lengthBucket(project.targetPages) });
    groups.set(key, [...(groups.get(key) ?? []), project]);
  }
  return [...groups.keys()].sort().map((key) => groups.get(key)!);
}

/** The project's run logs for the wanted jobs, as one text each: MinIO first, the legacy local directory second. */
async function readLogs(projectId: string, jobs: Set<string>): Promise<Array<{ job: string; text: string }>> {
  const store = objectStore();
  const events = await store.list(`books/${projectId}/runs/`);
  const byLog = new Map<string, string[]>();
  for (const event of events) {
    const [logKey] = event.key.split(".events/");
    if (!logKey || logKey === event.key) continue;
    byLog.set(logKey, [...(byLog.get(logKey) ?? []), event.key]);
  }
  const jobOf = (key: string) => key.split("/").pop()!.replace(/\.jsonl$/, "").replace(/^[a-z0-9]+-/, "");
  const out: Array<{ job: string; text: string }> = [];
  for (const [logKey, keys] of byLog) {
    const job = jobOf(logKey);
    if (!jobs.has(job)) continue;
    keys.sort();
    const parts = await mapWithConcurrency(keys, concurrency, async (key) => (await store.get(key))?.toString("utf8") ?? "");
    out.push({ job, text: parts.join("") });
  }
  if (out.length === 0) {
    const legacy = join("/app/storage/books", projectId, "runs");
    if (existsSync(legacy)) {
      for (const file of readdirSync(legacy).sort()) {
        const job = file.replace(/\.jsonl$/, "").replace(/^[a-z0-9]+-/, "");
        if (jobs.has(job)) out.push({ job, text: readFileSync(join(legacy, file), "utf8") });
      }
    }
  }
  return out;
}

const asRecord = (value: unknown): Record<string, unknown> => (value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {});

function payloadOf(call: LoggedCall): Record<string, unknown> {
  const last = [...call.messages].reverse().find((message) => message.role === "user");
  return asRecord(last ? parseJsonReply(last.content) : undefined);
}

function chapterIndexOf(payload: Record<string, unknown>): number | undefined {
  const candidates = [asRecord(payload.chapterPosition).index, payload.chapterIndex, asRecord(payload.chapter).index, asRecord(payload.chapter).chapterIndex];
  const found = candidates.find((value) => typeof value === "number");
  return typeof found === "number" ? found : undefined;
}

const head40 = (text: string) => words(withoutFences(unwrapWholeFence(text))).slice(0, 40).join(" ").toLowerCase();

/** Spread `count` picks across `items` (chapter 1 is not always the one taken). */
function spread<T>(items: readonly T[], count: number): T[] {
  if (items.length <= count) return [...items];
  return Array.from({ length: count }, (_, i) => items[Math.floor(((i + 0.5) * items.length) / count)]!);
}

function acceptanceVerdict(data: unknown): string | undefined {
  const record = asRecord(data);
  if (typeof record.verdict === "string") return record.verdict;
  if (typeof record.meaning === "string" || typeof record.intent === "string") {
    return record.meaning === "pass" && (record.intent === undefined || record.intent === "pass") ? "pass" : "reject";
  }
  return undefined;
}

function editKind(call: LoggedCall, payload: Record<string, unknown>): string {
  const system = call.messages.filter((message) => message.role === "system").map((message) => message.content).join("\n");
  if (payload.factualCorrection) return "factual-correction";
  if (Array.isArray(payload.readerNotes) && payload.readerNotes.length > 0) return "reader-notes";
  if (/This is a final line edit/.test(system)) return "final-line-edit";
  return "line-edit";
}

type BookState = {
  project: ProjectRow;
  calls: LoggedCall[];
  chapterTitles: Map<number, string>;
  ofChapters?: number;
  latestText: Map<number, string>;
  composeText: Map<number, string>;
};

function contextFor(book: BookState, chapterIndex: number | undefined): FixtureContext {
  const project = book.project;
  const brief = [
    `Title: ${project.planTitle ?? project.title}`,
    project.audience ? `Audience: ${project.audience}` : "",
    project.premise ? `Premise: ${project.premise}` : "",
    `Reader's request (first 1,200 characters): ${project.prompt.slice(0, 1200)}`
  ].filter(Boolean).join("\n");
  const context: FixtureContext = { bookTitle: project.planTitle ?? project.title, brief };
  if (chapterIndex !== undefined) {
    const title = book.chapterTitles.get(chapterIndex);
    if (title) context.chapterTitle = title;
    if (book.ofChapters) context.ofChapters = book.ofChapters;
    const previous = book.latestText.get(chapterIndex - 1);
    if (previous) context.prevTail = edges(previous).tail;
    const next = book.composeText.get(chapterIndex + 1);
    if (next) context.nextHead = edges(next).head;
  }
  return context;
}

function toFixture(book: BookState, call: LoggedCall, meta: Record<string, unknown>): StoredFixture {
  const payload = payloadOf(call);
  const chapterIndex = chapterIndexOf(payload) ?? (typeof meta.chapterIndex === "number" ? meta.chapterIndex : undefined);
  const project = book.project;
  const parsedText = call.op === "generateJson" ? parseJsonReply(call.text ?? "") : undefined;
  // `data` is stored only when it is not what the text parses to (a repaired or coerced reply).
  const keepData = call.op === "generateJson" && call.data !== undefined && JSON.stringify(parsedText) !== JSON.stringify(call.data);
  return {
    fixtureId: `${call.purpose}.${project.id}.${call.callId.slice(0, 8)}`,
    projectId: project.id,
    tier: project.tier,
    category: project.category,
    writingMode: project.writingMode,
    ...(project.lane ? { lane: project.lane } : {}),
    targetPages: project.targetPages,
    lengthBucket: lengthBucket(project.targetPages),
    language: project.language,
    purpose: call.purpose as Purpose,
    jobName: call.jobName,
    op: call.op,
    callId: call.callId,
    loggedAt: call.startedAt ?? "",
    ...(chapterIndex !== undefined ? { chapterIndex } : {}),
    model: call.answeredBy?.provider ? call.answeredBy : call.model,
    request: { ...(call.temperature !== undefined ? { temperature: call.temperature } : {}), ...(call.maxTokens !== undefined ? { maxTokens: call.maxTokens } : {}) },
    messages: call.messages,
    ...(call.query ? { query: call.query } : {}),
    response: {
      text: call.text ?? "",
      ...(keepData ? { data: call.data } : {}),
      ...(call.sources ? { sources: call.sources } : {}),
      ...(call.grounding !== undefined ? { grounding: call.grounding } : {}),
      ...(call.truncated ? { truncated: true } : {})
    },
    usage: call.usage,
    durationMs: call.durationMs,
    attempts: call.attempts,
    meta: { ...meta, ...(call.answeredBy && call.answeredBy.provider !== call.model.provider ? { fellBackFrom: call.model } : {}) },
    context: contextFor(book, chapterIndex)
  };
}

async function main() {
  const free = statfsSync(root.startsWith("/app") ? "/app" : root);
  const freeGb = (free.bavail * free.bsize) / 1e9;
  if (freeGb < 1.5) throw new Error(`Only ${freeGb.toFixed(2)} GB free; refusing to extract (MinIO stops writing near 1%).`);
  const { projects, counts } = await loadCandidates();
  const stratumKey = (project: ProjectRow) => stratumOf({ tier: project.tier, writingMode: project.writingMode, lengthBucket: lengthBucket(project.targetPages) });
  // Per-purpose stratification: on the first pass a purpose takes at most quota ÷ (strata that have its calls)
  // from any one stratum, so a large stratum cannot fill a quota before a small one is reached.
  const strataFor = new Map<string, Set<string>>();
  for (const project of projects) for (const key of counts.get(project.id)!.keys()) strataFor.set(key, (strataFor.get(key) ?? new Set()).add(stratumKey(project)));
  const cap = (key: string) => Math.ceil(QUOTAS[key]!.total / Math.max(1, strataFor.get(key)?.size ?? 1));
  const filledBy = new Map<string, number>();
  let capped = true;
  const roomIn = (key: string, stratum: string) => Math.min(QUOTAS[key]!.total - filled[key]!, capped ? cap(key) - (filledBy.get(`${key}|${stratum}`) ?? 0) : Number.POSITIVE_INFINITY);
  const available: Record<string, number> = {};
  for (const map of counts.values()) for (const [key, n] of map) available[key] = (available[key] ?? 0) + n;
  console.log(JSON.stringify({ since, candidates: projects.length, callsAvailable: available }));
  if (dryRun) return;
  // Plans are rewritten for the books this run picks; a stale plan from an earlier run would mislead.
  rmSync(join(root, "plans"), { recursive: true, force: true });

  const picked: Record<string, StoredFixture[]> = Object.fromEntries(PURPOSES.map((purpose) => [purpose, []]));
  const filled: Record<string, number> = Object.fromEntries(Object.keys(QUOTAS).map((key) => [key, 0]));
  const manuscripts: unknown[] = [];
  const manuscriptIds = new Set<string>();
  const contributing = new Set<string>();
  let booksRead = 0;

  const visit = async (project: ProjectRow): Promise<boolean | "skip"> => {
    const projectCounts = counts.get(project.id)!;
    const stratum = stratumKey(project);
    const needed = Object.keys(QUOTAS).filter((key) => roomIn(key, stratum) > 0 && (projectCounts.get(key) ?? 0) > 0);
    if (needed.length === 0) return "skip";
    booksRead += 1;
    const logs = await readLogs(project.id, new Set(needed.flatMap(jobsFor)));
    if (logs.length === 0) return false;
    const calls = logs.flatMap((log) => groupCalls(parseRunLogText(log.text)).map((call) => ({ ...call, jobName: call.jobName || log.job }))).filter((call) => call.ok);
    const plan = project.planId
      ? await prisma.planVersion.findUnique({ where: { id: project.planId }, select: { id: true, version: true, planningPackage: true, inputSnapshot: true } })
      : null;
    const planChapters = Array.isArray(asRecord(plan?.planningPackage).chapters) ? (asRecord(plan?.planningPackage).chapters as unknown[]).map(asRecord) : [];
    const book: BookState = {
      project,
      calls,
      chapterTitles: new Map(planChapters.filter((chapter) => typeof chapter.index === "number").map((chapter) => [chapter.index as number, String(chapter.title ?? "")])),
      ...(planChapters.length ? { ofChapters: planChapters.length } : {}),
      latestText: new Map(),
      composeText: new Map()
    };
    for (const call of calls) {
      const payload = payloadOf(call);
      const index = chapterIndexOf(payload);
      if (index === undefined || !call.text) continue;
      if (call.purpose === "compose-chapter") {
        book.composeText.set(index, call.text);
        if (!book.latestText.has(index)) book.latestText.set(index, call.text);
      }
      if (call.purpose === "edit-chapter") book.latestText.set(index, call.text);
    }
    const reads = calls.filter((call) => call.purpose === "read-manuscript" && call.jobName === "generate-book");
    for (const read of reads) {
      for (const chapter of (payloadOf(read).chapters as unknown[] | undefined) ?? []) {
        const record = asRecord(chapter);
        const text = record.text ?? record.markdown;
        if (typeof record.chapterIndex === "number" && typeof text === "string") book.latestText.set(record.chapterIndex, text);
      }
    }
    const acceptances = calls.filter((call) => call.purpose === "review-chapter-edit-acceptance");
    const acceptanceFor = (chapterIndex: number | undefined, candidate: string) => {
      const target = head40(candidate);
      return acceptances.find((call) => {
        const payload = payloadOf(call);
        return (chapterIndex === undefined || payload.chapterIndex === chapterIndex) && typeof payload.candidate === "string" && head40(payload.candidate) === target;
      });
    };
    const chapterOfDraft = (draft: string) => {
      const target = head40(draft);
      for (const [index, text] of book.latestText) if (head40(text) === target) return index;
      return undefined;
    };

    let contributed = false;
    const take = (key: string, call: LoggedCall, meta: Record<string, unknown>, force = false) => {
      if (!force && roomIn(key, stratum) <= 0) return undefined;
      const fixture = toFixture(book, call, meta);
      if (picked[call.purpose]!.some((existing) => existing.fixtureId === fixture.fixtureId)) return fixture;
      picked[call.purpose]!.push(fixture);
      if (!force || filled[key]! < QUOTAS[key]!.total) {
        filled[key] = filled[key]! + 1;
        filledBy.set(`${key}|${stratum}`, (filledBy.get(`${key}|${stratum}`) ?? 0) + 1);
      }
      contributed = true;
      return fixture;
    };

    for (const key of needed) {
      const [purpose] = key.split("@") as [string];
      let pool = calls.filter((call) => quotaKey(call.purpose, call.jobName) === key);
      if (purpose === "edit-chapter") {
        const lineEdits = pool.filter((call) => editKind(call, payloadOf(call)) === "line-edit");
        if (lineEdits.length >= QUOTAS[key]!.perBook) pool = lineEdits;
      }
      if (purpose === "read-manuscript" && key.endsWith("generate-book")) pool = pool.filter((call) => Array.isArray(payloadOf(call).chapters));
      const room = Math.min(QUOTAS[key]!.perBook, roomIn(key, stratum));
      for (const call of spread(pool, room)) {
        const payload = payloadOf(call);
        const meta: Record<string, unknown> = {};
        if (purpose === "edit-chapter") {
          const system = call.messages.filter((message) => message.role === "system").map((message) => message.content).join("\n");
          meta.kind = editKind(call, payload);
          meta.extend = /develop the existing sections/.test(system);
          meta.draftWords = wordCount(withoutFences(String(payload.draft ?? "")));
          meta.editedWords = wordCount(withoutFences(unwrapWholeFence(call.text ?? "")));
          const acceptance = acceptanceFor(chapterIndexOf(payload), call.text ?? "");
          if (acceptance) {
            meta.acceptanceCallId = acceptance.callId;
            meta.acceptanceVerdict = acceptanceVerdict(acceptance.data ?? parseJsonReply(acceptance.text ?? ""));
          }
        }
        if (purpose === "review-chapter-edit-acceptance") {
          meta.operation = payload.operation;
          meta.verdict = acceptanceVerdict(call.data ?? parseJsonReply(call.text ?? ""));
        }
        if (purpose === "read-manuscript") {
          meta.readKind = Array.isArray(payload.chapters) ? "manuscript-read" : Array.isArray(payload.requirements) || /requirement/i.test(JSON.stringify(payload.outputContract ?? "")) ? "coverage" : "other";
          if (Array.isArray(payload.chapters)) {
            meta.chapters = payload.chapters.length;
            meta.words = (payload.chapters as unknown[]).reduce<number>((sum, chapter) => sum + wordCount(String(asRecord(chapter).text ?? asRecord(chapter).markdown ?? "")), 0);
          }
        }
        if (purpose === "cut-chapter") {
          const index = chapterOfDraft(String(payload.draft ?? ""));
          if (index !== undefined) meta.chapterIndex = index;
          meta.draftWords = wordCount(withoutFences(String(payload.draft ?? "")));
          meta.cutWords = wordCount(withoutFences(unwrapWholeFence(call.text ?? "")));
          const acceptance = acceptanceFor(undefined, call.text ?? "");
          if (acceptance) meta.acceptanceVerdict = acceptanceVerdict(acceptance.data ?? parseJsonReply(acceptance.text ?? ""));
        }
        if (purpose === "final-book-qa") meta.pages = Array.isArray(payload.pages) ? payload.pages.length : undefined;
        const fixture = take(key, call, meta);
        if (fixture && purpose === "read-manuscript" && key.endsWith("generate-book") && !manuscriptIds.has(fixture.fixtureId)) {
          manuscriptIds.add(fixture.fixtureId);
          // H1 needs the whole tail of this book: every cut and every cut acceptance, beyond quota.
          const cutFixtures = calls.filter((other) => other.purpose === "cut-chapter").map((other) => {
            const otherPayload = payloadOf(other);
            const index = chapterOfDraft(String(otherPayload.draft ?? ""));
            const acceptance = acceptanceFor(index, other.text ?? "");
            const verdict = acceptance ? acceptanceVerdict(acceptance.data ?? parseJsonReply(acceptance.text ?? "")) : undefined;
            const cut = take("cut-chapter", other, { ...(index !== undefined ? { chapterIndex: index } : {}), forManuscript: fixture.fixtureId, ...(verdict ? { acceptanceVerdict: verdict } : {}) }, true);
            const accepted = acceptance ? take("review-chapter-edit-acceptance", acceptance, { operation: payloadOf(acceptance).operation, verdict, forManuscript: fixture.fixtureId }, true) : undefined;
            return { chapterIndex: index, cutFixtureId: cut?.fixtureId, acceptanceFixtureId: accepted?.fixtureId, verdict };
          });
          manuscripts.push({
            manuscriptId: fixture.fixtureId,
            projectId: project.id,
            tier: project.tier,
            writingMode: project.writingMode,
            lengthBucket: lengthBucket(project.targetPages),
            chapters: fixture.meta.chapters,
            words: fixture.meta.words,
            cuts: cutFixtures,
            cutsAccepted: cutFixtures.filter((cut) => cut.verdict === "pass").length
          });
        }
      }
    }
    if (contributed) {
      contributing.add(project.id);
      if (plan) writeJson(join(root, "plans", `${project.id}.json`), { projectId: project.id, planVersionId: plan.id, version: plan.version, planningPackage: plan.planningPackage, inputSnapshot: plan.inputSnapshot });
    }
    console.log(JSON.stringify({ book: booksRead, projectId: project.id, stratum: stratumOf({ tier: project.tier, writingMode: project.writingMode, lengthBucket: lengthBucket(project.targetPages) }), calls: calls.length, contributed, filled }));
    return contributed;
  };

  const done = () => Object.keys(QUOTAS).every((key) => filled[key]! >= QUOTAS[key]!.total);
  // Round-robin over strata. A stratum keeps drawing (up to six books a turn) until one contributes, so books
  // whose run logs were lost or truncated (the 2026-10-01 MinIO disk incident) do not cost it its turn.
  // Second pass, uncapped, tops up quotas the small strata could not fill.
  for (const pass of [1, 2]) {
    capped = pass === 1;
    const queues = strataQueues(projects);
    while (!done() && booksRead < maxBooks && queues.some((queue) => queue.length > 0)) {
      for (const queue of queues) {
        let attempts = 0;
        while (attempts < 6 && queue.length > 0 && !done() && booksRead < maxBooks) {
          const outcome = await visit(queue.shift()!);
          if (outcome === "skip") continue;
          attempts += 1;
          if (outcome) break;
        }
      }
    }
  }

  ensureDir(join(root, "fixtures"));
  const strata: Record<string, Record<string, number>> = {};
  for (const [purpose, rows] of Object.entries(picked)) {
    writeJsonl(fixturesPath(root, purpose), rows);
    for (const row of rows) {
      const key = stratumOf(row);
      strata[purpose] = { ...strata[purpose], [key]: (strata[purpose]?.[key] ?? 0) + 1 };
    }
  }
  writeJsonl(join(root, "fixtures", "manuscripts.jsonl"), manuscripts);
  writeJson(join(root, "fixtures", "index.json"), {
    extractedAt: new Date().toISOString(),
    since,
    quotas: QUOTAS,
    booksRead,
    plans: contributing.size,
    counts: Object.fromEntries(Object.entries(picked).map(([purpose, rows]) => [purpose, rows.length])),
    manuscripts: manuscripts.length,
    strata
  });
  console.log(JSON.stringify({ done: true, booksRead, plans: contributing.size, counts: Object.fromEntries(Object.entries(picked).map(([purpose, rows]) => [purpose, rows.length])), manuscripts: manuscripts.length }));
}

try {
  await main();
} finally {
  await prisma.$disconnect();
}
process.exit(0);
