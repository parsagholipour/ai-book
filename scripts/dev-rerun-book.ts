/**
 * Re-run a finished book's exact creation input through the real pipeline and
 * collect everything needed to judge the result: the text, a step-by-step
 * trace of the run, and the structural scorecard.
 *
 *   pnpm exec tsx scripts/dev-rerun-book.ts run --source <projectId> --label <name> [--reuse-plan <projectId>] [--tier fast|balanced|premium|ultra] [--baseline <text file>]...
 *   pnpm exec tsx scripts/dev-rerun-book.ts resume --project <projectId> --label <name> [--baseline <file>]...
 *   pnpm exec tsx scripts/dev-rerun-book.ts retry --project <projectId> --label <name> [--baseline <file>]...
 *   pnpm exec tsx scripts/dev-rerun-book.ts export --project <projectId> --label <name> [--baseline <file>]...
 *
 * `run` clones the source project row, enqueues PLAN_BOOK with the source
 * plan's own `inputSnapshot` (what the mobile creation chat built), waits,
 * approves the plan the way `POST /api/plans/:id/approve` does, waits for the
 * compile, then exports. It goes through `enqueueGenerationJob` and
 * `dispatchGenerationJob` from the API, so the durable job rows, dedupe keys
 * and BullMQ payloads are the ones production writes; nothing is charged
 * because the operator path reserves no credits. Development only: it needs
 * the Docker stack (or a host stack) on the default ports and talks to the
 * worker container for run logs.
 *
 * Output lands under `.scratch/composed-chapters/runs/<label>/`: `book.md`,
 * `pages.json`, `trace.md`, `trace.json`, `scorecard.txt`.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { Prisma, prisma } from "../packages/db/src/index.ts";
import { bookQueue, dispatchGenerationJob, enqueueGenerationJob, redisConnection } from "../apps/api/src/queue.ts";
import { scorecardFor } from "./structural-scorecard.ts";

type Args = {
  command: "run" | "resume" | "retry" | "export";
  source?: string | undefined;
  reusePlan?: string | undefined;
  tier?: string | undefined;
  stancePositions?: string | undefined;
  project?: string | undefined;
  label: string;
  baselines: string[];
  outDir: string;
};

const WORKER_CONTAINER = process.env.BOOK_MAKER_WORKER_CONTAINER ?? "ai-book-maker-worker-1";

function parseArgs(argv: string[]): Args {
  const command = argv[0];
  if (command !== "run" && command !== "resume" && command !== "retry" && command !== "export") {
    throw new Error("usage: dev-rerun-book.ts <run|resume|retry|export> --source <id> | --project <id> --label <name> [--baseline <file>]...");
  }
  const args: Args = { command, label: "", baselines: [], outDir: ".scratch/composed-chapters/runs" };
  for (let index = 1; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (flag === "--source") args.source = value;
    else if (flag === "--reuse-plan") args.reusePlan = value;
    else if (flag === "--tier") args.tier = value;
    else if (flag === "--stance-positions") args.stancePositions = value;
    else if (flag === "--project") args.project = value;
    else if (flag === "--label") args.label = value ?? "";
    else if (flag === "--baseline" && value) args.baselines.push(value);
    else if (flag === "--out" && value) args.outDir = value;
    else continue;
    index += 1;
  }
  if (!args.label) throw new Error("--label is required");
  return args;
}

function stablePayloadHash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 24);
}

function log(message: string): void {
  console.log(`[${new Date().toISOString().slice(11, 19)}] ${message}`);
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function cloneProject(sourceId: string, label: string, tier?: string): Promise<{ projectId: string; inputSnapshot: Prisma.JsonValue }> {
  const source = await prisma.project.findUnique({ where: { id: sourceId } });
  if (!source) throw new Error(`Source project ${sourceId} not found`);
  const sourcePlan = await prisma.planVersion.findFirst({ where: { projectId: sourceId }, orderBy: { version: "desc" } });
  if (!sourcePlan || sourcePlan.inputSnapshot === null) throw new Error(`Source project ${sourceId} has no plan snapshot`);
  const project = await prisma.project.create({
    data: {
      userId: source.userId,
      title: `${source.title} [${label}]`,
      ...(source.subtitle ? { subtitle: source.subtitle } : {}),
      ...(source.authorName ? { authorName: source.authorName } : {}),
      ...(source.coverTagline ? { coverTagline: source.coverTagline } : {}),
      prompt: source.prompt,
      category: source.category,
      ...(source.subcategory ? { subcategory: source.subcategory } : {}),
      targetPages: source.targetPages,
      complexity: source.complexity,
      temperature: source.temperature,
      language: source.language,
      // A tier override rewrites modelTier, which is what routes the models (→ modelTierForInput).
      mediaSettings: (tier
        ? { ...((source.mediaSettings ?? {}) as Record<string, unknown>), modelTier: tier }
        : source.mediaSettings) as Prisma.InputJsonValue,
      ...(source.templateId ? { templateId: source.templateId } : {})
    }
  });
  log(`cloned ${sourceId} → ${project.id} ("${project.title}")`);
  return { projectId: project.id, inputSnapshot: sourcePlan.inputSnapshot };
}

async function queuePlan(projectId: string, inputSnapshot: Prisma.JsonValue): Promise<void> {
  const snapshot = inputSnapshot as Record<string, unknown>;
  const job = await prisma.$transaction(async (tx) => {
    await tx.project.update({ where: { id: projectId }, data: { status: "PLANNING" } });
    return enqueueGenerationJob({
      projectId,
      type: "PLAN_BOOK",
      dedupeKey: `plan-book:${projectId}:${stablePayloadHash(snapshot)}`,
      payload: { inputSnapshot: snapshot },
      transaction: tx,
      dispatch: false
    });
  });
  await dispatchGenerationJob(job.id);
  log(`PLAN_BOOK queued (${job.id})`);
}

async function waitForJobs(projectId: string, types: string[], timeoutMs: number): Promise<void> {
  const started = Date.now();
  let lastLine = "";
  while (Date.now() - started < timeoutMs) {
    const jobs = await prisma.generationJob.findMany({
      where: { projectId, type: { in: types } },
      orderBy: { createdAt: "asc" },
      select: { type: true, status: true, progress: true, message: true }
    });
    const project = await prisma.project.findUnique({ where: { id: projectId }, select: { status: true } });
    const line = `${project?.status} | ${jobs.map((job) => `${job.type}:${job.status}@${job.progress} ${job.message ?? ""}`).join(" | ")}`;
    if (line !== lastLine) {
      log(line.slice(0, 220));
      lastLine = line;
    }
    const terminal = jobs.length > 0 && jobs.every((job) => ["COMPLETED", "FAILED", "CANCELED"].includes(job.status));
    if (terminal) return;
    await sleep(15_000);
  }
  throw new Error(`Timed out waiting for ${types.join(",")} on ${projectId}`);
}

async function copyPlan(fromProjectId: string, projectId: string, tier?: string, stancePositions?: string): Promise<void> {
  const source = await prisma.planVersion.findFirst({
    where: { projectId: fromProjectId, status: "APPROVED" },
    orderBy: { version: "desc" }
  });
  if (!source) throw new Error(`Project ${fromProjectId} has no approved plan to reuse`);
  const copy = await prisma.planVersion.create({
    data: {
      projectId,
      version: 1,
      status: "DRAFT",
      planningPackage: (stancePositions
        ? (() => {
            const pkg = structuredClone(source.planningPackage) as { authorStance?: { positions?: string[] } };
            const positions = JSON.parse(readFileSync(stancePositions, "utf8")) as string[];
            if (pkg.authorStance) pkg.authorStance.positions = positions;
            log(`stance positions replaced (${positions.length})`);
            return pkg;
          })()
        : source.planningPackage) as Prisma.InputJsonValue,
      // The worker builds its input from this snapshot, not from the project
      // row, so a tier override has to be written here too or the copied
      // plan's tier routes the models (composed-12-fast ran on the balanced writer).
      inputSnapshot: (tier && source.inputSnapshot && typeof source.inputSnapshot === "object"
        ? {
            ...(source.inputSnapshot as Record<string, unknown>),
            mediaSettings: {
              ...(((source.inputSnapshot as Record<string, unknown>).mediaSettings ?? {}) as Record<string, unknown>),
              modelTier: tier
            }
          }
        : source.inputSnapshot) as Prisma.InputJsonValue,
      messages: source.messages as Prisma.InputJsonValue
    }
  });
  await prisma.project.update({ where: { id: projectId }, data: { currentPlanId: copy.id, status: "PLAN_READY" } });
  log(`plan ${source.id} of ${fromProjectId} copied as ${copy.id}`);
}

async function approveLatestPlan(projectId: string): Promise<string> {
  const plan = await prisma.planVersion.findFirst({ where: { projectId }, orderBy: { version: "desc" } });
  if (!plan) throw new Error(`No plan version on ${projectId}`);
  const dedupeKey = `generate-book:${projectId}:${plan.id}`;
  const job = await prisma.$transaction(async (tx) => {
    await tx.planVersion.updateMany({ where: { projectId, id: { not: plan.id } }, data: { status: "SUPERSEDED" } });
    await tx.planVersion.update({ where: { id: plan.id }, data: { status: "APPROVED", approvedAt: new Date() } });
    await tx.project.update({ where: { id: projectId }, data: { currentPlanId: plan.id, status: "GENERATING" } });
    return enqueueGenerationJob({ projectId, type: "GENERATE_BOOK", dedupeKey, payload: { planId: plan.id }, transaction: tx, dispatch: false });
  });
  await dispatchGenerationJob(job.id);
  log(`plan ${plan.id} approved; GENERATE_BOOK queued (${job.id})`);
  return plan.id;
}

async function waitForBook(projectId: string, timeoutMs: number): Promise<void> {
  const started = Date.now();
  let lastLine = "";
  while (Date.now() - started < timeoutMs) {
    const [project, jobs] = await Promise.all([
      prisma.project.findUnique({ where: { id: projectId }, select: { status: true } }),
      prisma.generationJob.findMany({
        where: { projectId, type: { in: ["GENERATE_BOOK", "COMPILE_EXPORT", "GENERATE_IMAGE"] } },
        orderBy: { createdAt: "asc" },
        select: { type: true, status: true, progress: true, message: true }
      })
    ]);
    const line = `${project?.status} | ${jobs.map((job) => `${job.type}:${job.status}@${job.progress} ${(job.message ?? "").slice(0, 80)}`).join(" | ")}`;
    if (line !== lastLine) {
      log(line);
      lastLine = line;
    }
    // The newest row of each type: a retried book leaves its FAILED row behind.
    const compile = jobs.findLast((job) => job.type === "COMPILE_EXPORT");
    const book = jobs.findLast((job) => job.type === "GENERATE_BOOK");
    if (book?.status === "FAILED" || book?.status === "CANCELED") throw new Error(`GENERATE_BOOK ${book.status}`);
    if (compile && ["COMPLETED", "FAILED", "CANCELED"].includes(compile.status) && project && ["COMPLETE", "REVIEW_REQUIRED", "FAILED"].includes(project.status)) {
      return;
    }
    await sleep(20_000);
  }
  throw new Error(`Timed out waiting for the book on ${projectId}`);
}

type RunLogEvent = { event?: string; callId?: string; request?: { purpose?: string; messages?: Array<{ role: string; content: string }> }; result?: { text?: string; data?: unknown; usage?: Record<string, number> }; error?: unknown; timestamp?: string };

function readRunLog(projectId: string, suffix: string): RunLogEvent[] {
  try {
    const text = execFileSync(
      "docker",
      ["exec", WORKER_CONTAINER, "sh", "-c", `cat /app/storage/books/${projectId}/runs/*-${suffix}.jsonl 2>/dev/null`],
      { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }
    );
    return text
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        try {
          return JSON.parse(line) as RunLogEvent;
        } catch {
          return null;
        }
      })
      .filter((event): event is RunLogEvent => event !== null);
  } catch {
    return [];
  }
}

function words(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

async function exportRun(projectId: string, label: string, outDir: string, baselines: string[]): Promise<void> {
  const dir = join(outDir, label);
  mkdirSync(dir, { recursive: true });
  const project = await prisma.project.findUnique({ where: { id: projectId } });
  if (!project) throw new Error(`Project ${projectId} not found`);
  const plan = await prisma.planVersion.findFirst({ where: { projectId }, orderBy: { version: "desc" } });
  const chapters = await prisma.chapter.findMany({ where: { projectId }, orderBy: { index: "asc" } });
  const pages = await prisma.page.findMany({ where: { projectId }, orderBy: { index: "asc" } });
  const compile = await prisma.generationJob.findFirst({ where: { projectId, type: "COMPILE_EXPORT" }, orderBy: { createdAt: "desc" } });
  const calls = await prisma.providerCallLog.groupBy({
    by: ["purpose"],
    where: { projectId },
    _count: { _all: true },
    _sum: { promptTokens: true, outputTokens: true, costHint: true },
    _avg: { durationMs: true }
  });
  const span = await prisma.providerCallLog.aggregate({ where: { projectId }, _min: { createdAt: true }, _max: { createdAt: true }, _sum: { costHint: true }, _count: { _all: true } });

  // The text: chapter headings plus pages joined, the way the compile joins them.
  const bookMarkdown = chapters
    .map((chapter) => {
      const chapterPages = pages.filter((page) => page.chapterId === chapter.id);
      return `## Chapter ${chapter.index}: ${chapter.title}\n\n${chapterPages.map((page) => page.markdown).join("\n\n")}`;
    })
    .join("\n\n");
  writeFileSync(join(dir, "book.md"), bookMarkdown);
  writeFileSync(join(dir, "pages.json"), JSON.stringify(pages.map((page) => ({ index: page.index, title: page.title, markdown: page.markdown, summary: page.summary, status: page.status })), null, 2));

  // The trace.
  const planning = (plan?.planningPackage ?? {}) as Record<string, unknown>;
  const stance = planning.authorStance as { thesis?: string; positions?: string[]; refusals?: string[]; voiceSample?: string } | undefined;
  const bookLog = readRunLog(projectId, "generate-book");
  const requests = new Map<string, RunLogEvent["request"]>();
  const traceCalls: Array<Record<string, unknown>> = [];
  let readVerdict: unknown;
  let generatedStance: unknown;
  for (const event of bookLog) {
    if (event.event?.endsWith(".request") && event.callId) requests.set(event.callId, event.request);
    if (event.event?.endsWith(".response") && event.callId) {
      const request = requests.get(event.callId);
      const purpose = request?.purpose;
      let payload: Record<string, unknown> = {};
      try {
        payload = JSON.parse(request?.messages?.[1]?.content ?? "{}") as Record<string, unknown>;
      } catch {
        // not JSON
      }
      const chapter = (payload.chapter as { index?: number } | undefined)?.index ?? (payload.chapterPosition as { index?: number } | undefined)?.index;
      const measurementNotes = Array.isArray(payload.measurementNotes) ? (payload.measurementNotes as string[]) : undefined;
      const readerNotes = Array.isArray(payload.readerNotes) ? (payload.readerNotes as string[]) : undefined;
      traceCalls.push({
        purpose,
        chapter,
        outputWords: event.result?.text ? words(String(event.result.text)) : undefined,
        outputTokens: event.result?.usage?.outputTokens,
        ...(measurementNotes ? { measurementNotes } : {}),
        ...(readerNotes ? { readerNotes } : {})
      });
      if (purpose === "read-manuscript") readVerdict = event.result?.data ?? event.result?.text;
      if (purpose === "author-stance") generatedStance = event.result?.data;
    }
    if (event.event?.endsWith(".error")) {
      traceCalls.push({ purpose: requests.get(event.callId ?? "")?.purpose, error: String((event.error as { message?: string } | undefined)?.message ?? event.error).slice(0, 300) });
    }
  }
  const chapterTrace = chapters.map((chapter) => {
    const brief = (chapter.productionBrief ?? {}) as Record<string, unknown>;
    const composition = brief.composition as { sections?: Array<{ form: string; subject: string }>; landing?: string } | undefined;
    const report = brief.report as Record<string, unknown> | undefined;
    const chapterPages = pages.filter((page) => page.chapterId === chapter.id);
    return {
      index: chapter.index,
      title: chapter.title,
      targetPages: chapter.targetPages,
      pages: chapterPages.length,
      words: chapterPages.reduce((sum, page) => sum + words(page.markdown), 0),
      statuses: [...new Set(chapterPages.map((page) => page.status))],
      forms: composition?.sections?.map((section) => section.form) ?? [],
      landing: composition?.landing,
      report,
      calls: traceCalls.filter((call) => call.chapter === chapter.index)
    };
  });
  const qualityReport = (compile?.qualityReport ?? null) as Record<string, unknown> | null;
  const pdfPages = (project.pdfPageMap as { totalPdfPages?: number } | null)?.totalPdfPages;
  const trace = {
    projectId,
    label,
    status: project.status,
    targetPages: project.targetPages,
    pages: pages.length,
    words: pages.reduce((sum, page) => sum + words(page.markdown), 0),
    pdfPages,
    stance: stance ? { positions: stance.positions?.length ?? 0, refusals: stance.refusals?.length ?? 0, sampleWords: words(stance.voiceSample ?? ""), thesis: stance.thesis, sample: stance.voiceSample } : null,
    generatedStance,
    chapters: chapterTrace,
    read: readVerdict,
    qualityReport: qualityReport ? { state: qualityReport.state, issues: (qualityReport.issues as Array<{ code?: string; severity?: string }> | undefined)?.map((issue) => `${issue.severity}:${issue.code}`) } : null,
    calls: calls.map((row) => ({ purpose: row.purpose, count: row._count._all, promptTokens: row._sum.promptTokens, outputTokens: row._sum.outputTokens, cost: row._sum.costHint, avgSeconds: row._avg.durationMs ? Math.round(row._avg.durationMs / 100) / 10 : null })),
    totals: { calls: span._count._all, cost: span._sum.costHint, minutes: span._min.createdAt && span._max.createdAt ? Math.round((span._max.createdAt.getTime() - span._min.createdAt.getTime()) / 60000) : null }
  };
  writeFileSync(join(dir, "trace.json"), JSON.stringify(trace, null, 2));

  const lines: string[] = [];
  lines.push(`# Run ${label} — ${projectId}`, "", `status ${project.status} · ${pages.length}/${project.targetPages} pages · ${trace.words} words · PDF pages ${pdfPages ?? "?"} · ${trace.totals.calls} calls · $${trace.totals.cost?.toFixed(2)} · ${trace.totals.minutes} min`, "");
  lines.push(`## Stance`, "", stance ? `positions ${stance.positions?.length ?? 0}, refusals ${stance.refusals?.length ?? 0}, sample ${words(stance.voiceSample ?? "")} words${generatedStance ? " (regenerated in the pass)" : ""}` : "none on plan", "", `thesis: ${stance?.thesis ?? (generatedStance as { thesis?: string } | undefined)?.thesis ?? ""}`, "");
  lines.push(`## Chapters`, "");
  for (const chapter of chapterTrace) {
    const report = chapter.report ?? {};
    lines.push(`### ${chapter.index}. ${chapter.title} — ${chapter.words} words / ${chapter.pages} pages (${chapter.statuses.join(",")})`);
    lines.push(`forms: ${chapter.forms.join(" > ")}`);
    lines.push(`landing: ${chapter.landing ?? ""}`);
    lines.push(`report: draft ${String(report.draftWords)} → edited ${String(report.editedWords)} words; editorChanged ${String(report.editorChanged)}; shapePass ${String(report.shapePassApplied)}; secondEdit ${String(report.secondEditApplied)}; paragraphCv ${Number(report.paragraphCv ?? 0).toFixed(2)}; formPlan ${String(report.formPlanSource)} (${(report.formPlanIssues as string[] | undefined)?.length ?? 0} issues)`);
    const scene = report.scene as { words: number; episodeTitle: string } | undefined;
    const dossierReport = report.dossier as { episodes: number; documents: number; excerpts: number } | undefined;
    const quotes = report.quotes as { checked: number; verbatim: number; misattributed: number; stripped: number } | undefined;
    const couplets = report.couplets as { found: number; rewritten: number } | undefined;
    if (couplets) lines.push(`couplets: ${couplets.rewritten}/${couplets.found} rewritten`);
    if (report.epigraph) lines.push("epigraph: set from the dossier");
    if (report.contract || scene || dossierReport || quotes) {
      lines.push(
        `material: contract ${String(report.contract ?? "grounded")}${scene ? `; scene ${scene.words} words ("${scene.episodeTitle}")` : ""}${
          dossierReport ? `; episodes ${dossierReport.episodes}, documents ${dossierReport.documents}, excerpts ${dossierReport.excerpts}` : ""
        }${quotes ? `; quotes ${quotes.verbatim}/${quotes.checked} verbatim, ${quotes.misattributed} misattributed, ${quotes.stripped} stripped` : ""}`
      );
    }
    for (const call of chapter.calls) {
      const notes = (call.measurementNotes as string[] | undefined) ?? [];
      const reader = (call.readerNotes as string[] | undefined) ?? [];
      lines.push(`- ${String(call.purpose)} → ${String(call.outputWords ?? "")} words${notes.length ? `; ${notes.length} measured notes` : ""}${reader.length ? `; ${reader.length} reader notes` : ""}${call.error ? `; ERROR ${String(call.error)}` : ""}`);
      for (const note of notes) lines.push(`    · ${note.slice(0, 220)}`);
    }
    lines.push("");
  }
  lines.push(`## Read`, "", "```json", JSON.stringify(readVerdict ?? null, null, 1).slice(0, 6000), "```", "");
  lines.push(`## Quality report`, "", JSON.stringify(trace.qualityReport), "");
  lines.push(`## Calls`, "", ...trace.calls.map((row) => `- ${row.purpose}: ${row.count} calls, ${row.promptTokens} in / ${row.outputTokens} out, $${(row.cost ?? 0).toFixed(2)}, avg ${row.avgSeconds}s`), "");
  writeFileSync(join(dir, "trace.md"), lines.join("\n"));

  // The scorecard against the baselines.
  const cards = [{ name: label, card: scorecardFor(pages.map((page) => ({ index: page.index, markdown: page.markdown }))) }];
  for (const baseline of baselines) {
    const text = execFileSync("cat", [baseline], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
    cards.push({ name: baseline.split("/").at(-1) ?? baseline, card: scorecardFor(text.split(/\n\s*\n/).reduce<Array<{ index: number; markdown: string }>>((acc, paragraph) => {
      const last = acc.at(-1);
      if (last && words(last.markdown) < 450) last.markdown += `\n\n${paragraph}`;
      else acc.push({ index: acc.length + 1, markdown: paragraph });
      return acc;
    }, [])) });
  }
  const keys = Object.keys(cards[0]!.card) as Array<keyof (typeof cards)[0]["card"]>;
  const table = [
    `${"".padEnd(34)}${cards.map((entry) => entry.name.slice(0, 16).padStart(18)).join("")}`,
    ...keys.map((key) => `${String(key).padEnd(34)}${cards.map((entry) => String(typeof entry.card[key] === "number" ? Number(entry.card[key]).toFixed(3) : entry.card[key]).slice(0, 17).padStart(18)).join("")}`)
  ].join("\n");
  writeFileSync(join(dir, "scorecard.txt"), table);
  console.log(table);
  log(`exported to ${dir}`);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  let projectId = args.project;
  if (args.command === "run") {
    if (!args.source) throw new Error("--source is required for run");
    const cloned = await cloneProject(args.source, args.label, args.tier);
    projectId = cloned.projectId;
    if (args.reusePlan) {
      // The same plan as an earlier run, so a comparison measures the writing
      // pipeline rather than a fresh planner's thesis.
      await copyPlan(args.reusePlan, projectId, args.tier, args.stancePositions);
    } else {
      await queuePlan(projectId, cloned.inputSnapshot);
      await waitForJobs(projectId, ["PLAN_BOOK"], 20 * 60_000);
    }
    await approveLatestPlan(projectId);
    await waitForBook(projectId, 120 * 60_000);
  } else if (args.command === "retry") {
    // A FAILED book re-enqueued on its approved plan; the composed pass
    // resumes from the chapters it already staged.
    if (!projectId) throw new Error("--project is required for retry");
    const approved = await prisma.planVersion.findFirst({ where: { projectId, status: "APPROVED" } });
    if (!approved) throw new Error(`No approved plan on ${projectId}`);
    const job = await prisma.$transaction(async (tx) => {
      await tx.project.update({ where: { id: projectId }, data: { status: "GENERATING" } });
      return enqueueGenerationJob({
        projectId,
        type: "GENERATE_BOOK",
        dedupeKey: `generate-book:${projectId}:${approved.id}:retry-${Date.now()}`,
        payload: { planId: approved.id },
        transaction: tx,
        dispatch: false
      });
    });
    await dispatchGenerationJob(job.id);
    log(`GENERATE_BOOK re-queued (${job.id}) on plan ${approved.id}`);
    await waitForBook(projectId, 120 * 60_000);
  } else if (args.command === "resume") {
    if (!projectId) throw new Error("--project is required for resume");
    const plan = await prisma.planVersion.findFirst({ where: { projectId }, orderBy: { version: "desc" } });
    if (!plan) {
      await waitForJobs(projectId, ["PLAN_BOOK"], 20 * 60_000);
    }
    const approved = await prisma.planVersion.findFirst({ where: { projectId, status: "APPROVED" } });
    if (!approved) await approveLatestPlan(projectId);
    await waitForBook(projectId, 120 * 60_000);
  }
  if (!projectId) throw new Error("--project is required for export");
  await exportRun(projectId, args.label, args.outDir, args.baselines);
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await bookQueue.close().catch(() => undefined);
    await redisConnection.quit().catch(() => undefined);
    await prisma.$disconnect().catch(() => undefined);
  });
