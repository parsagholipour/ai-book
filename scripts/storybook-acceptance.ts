/**
 * Live operator acceptance, not a billing/purchasing test.
 *
 * docker compose exec -T api pnpm exec tsx scripts/storybook-acceptance.ts prepare --rounds 1 --max-minutes fast=5,balanced=8,premium=12 --illustration-cadence every-third-page --baseline .scratch/character-story-30-2026-09-23/manifest.json --out .scratch/storybook-acceptance
 * docker compose exec -T api pnpm exec tsx scripts/storybook-acceptance.ts launch --out .scratch/storybook-acceptance
 * docker compose exec -T api pnpm exec tsx scripts/storybook-acceptance.ts watch|capture --out .scratch/storybook-acceptance
 *
 * One to three explicit matched rounds, each with Quick/Balanced/Premium. No generation retry
 * command: terminal failures remain failures. `capture` only reads saved work
 * and can be repeated after a storage/download interruption without spending.
 */
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { prisma } from "../packages/db/src/index.ts";
import { createProjectSchema } from "../packages/core/src/schemas/book.ts";
import { loadConfig } from "../packages/core/src/config.ts";
import { libraryCharacterObjectKey } from "../packages/core/src/generation/libraryCharacters.ts";
import { compiledGenerationTextModelRouting, resolveGenerationTextModelRouting } from "../packages/core/src/adapters/generationTextModelRouting.ts";
import { generationTextModelOptions } from "../packages/core/src/adapters/factory.ts";
import { bookQueue, dispatchGenerationJob, enqueueGenerationJob, redisConnection } from "../apps/api/src/queue.ts";
import { listRunLogs, objectStore, readRunLog } from "../packages/storage/src/index.ts";
import { capturePublishedArtifacts, classifyGenerationCompletion, prepareStorybookIllustrations, sha256, summarizeAcceptance } from "./generation-acceptance.mjs";
import { GENERATION_WATCHDOG_MS, nextBenchmarkRound, parseBenchmarkOptions, summarizeBenchmarkMatrix } from "./generation-performance.mjs";

type Input = ReturnType<typeof createProjectSchema.parse>;
type Character = { id: string; name: string; portraitFile: string };
type Benchmark = { rounds: number; maxElapsedMs: Record<Run["tier"], number>; targetKind: "experimental"; profile?: "text-only-30" };
type PdfLayoutPolicy = { mode: "one-physical-page-per-story"; expectedStoryPages: number };
type Run = {
  round: number; tier: "fast" | "balanced" | "premium"; projectId: string; input: Input;
  state: "prepared" | "running" | "published" | "failed";
  startedAt?: string; finishedAt?: string; planJobId?: string; planId?: string; bookJobId?: string;
  failure?: string;
  acceptancePassed?: boolean;
};
type Manifest = {
  version: 1 | 2 | 3 | 4; matrixId: string; preparedAt: string; baseline: string; userId: string;
  characters: Character[]; portraitChecks: unknown[]; runs: Run[];
  benchmark?: Benchmark;
  illustrationPolicy?: ReturnType<typeof prepareStorybookIllustrations>["policy"] & { inputFingerprint: string };
  pdfLayoutPolicy?: PdfLayoutPolicy;
  provenance?: Awaited<ReturnType<typeof runtimeProvenance>>;
};
const config = loadConfig();
const command = process.argv[2];
const value = (flag: string) => process.argv[process.argv.indexOf(flag) + 1];
const dir = process.argv.includes("--out") ? value("--out")! : ".scratch/storybook-acceptance";
const manifestPath = join(dir, "manifest.json");
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const record = (input: unknown) => input && typeof input === "object" && !Array.isArray(input) ? input as Record<string, unknown> : {};
const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);
const log = (input: unknown) => console.log(new Date().toISOString(), typeof input === "string" ? input : JSON.stringify(input));
function save(path: string, value: unknown) {
  mkdirSync(dir, { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, JSON.stringify(value, null, 2));
  renameSync(temporary, path);
}

function sourceSnapshot() {
  const paths = ["apps", "packages", "scripts", "package.json", "pnpm-lock.yaml", "tsconfig.base.json"];
  const files = execFileSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard", "--", ...paths], { encoding: "utf8", maxBuffer: 20 * 1024 * 1024 })
    .split("\0").filter((path) => /\.(?:ts|tsx|js|mjs|json|prisma|yaml|yml)$/.test(path)).sort();
  const hashes = files.map((path) => [path, existsSync(path) ? sha256(readFileSync(path)) : "deleted"]);
  return { gitHead: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(), sourceHash: sha256(JSON.stringify(hashes)), files: hashes };
}

async function runtimeProvenance(benchmark?: Benchmark, illustrationPolicy?: Manifest["illustrationPolicy"], pdfLayoutPolicy?: PdfLayoutPolicy) {
  const quality = await prisma.generationQualityRevision.findFirst({ orderBy: { version: "desc" } });
  const routing = resolveGenerationTextModelRouting(quality?.settings, compiledGenerationTextModelRouting(config, generationTextModelOptions(config)));
  return {
    ...sourceSnapshot(), qualityRevision: quality ? { id: quality.id, version: quality.version, settings: quality.settings } : null,
    routing, concurrency: { pages: config.MAX_PARALLEL_PAGE_JOBS, images: config.MAX_PARALLEL_IMAGE_JOBS },
    mockAi: config.MOCK_AI, objectStorageEndpoint: process.env.S3_ENDPOINT ?? null,
    benchmarkFingerprint: benchmark ? sha256(JSON.stringify(benchmark)) : null,
    inputPolicyFingerprint: illustrationPolicy ? sha256(JSON.stringify(illustrationPolicy)) : null,
    pdfLayoutPolicyFingerprint: pdfLayoutPolicy ? sha256(JSON.stringify(pdfLayoutPolicy)) : null,
    fingerprint: sha256(JSON.stringify({ routing, quality: quality?.settings ?? null, pages: config.MAX_PARALLEL_PAGE_JOBS, images: config.MAX_PARALLEL_IMAGE_JOBS }))
  };
}

async function localPreflight(allowedProjects: string[] = []) {
  if (config.NODE_ENV === "production" || config.MOCK_AI) throw new Error("This acceptance run requires a local stack with MOCK_AI=false");
  const endpoint = process.env.S3_ENDPOINT;
  if (!endpoint || !["minio", "localhost", "127.0.0.1"].includes(new URL(endpoint).hostname)) throw new Error("A local MinIO endpoint is required");
  await objectStore().ready();
  execFileSync("pdfinfo", ["-v"], { stdio: "pipe", timeout: 5000 });
  const workers = await bookQueue.getWorkers();
  if (workers.length !== 1) throw new Error(`Expected exactly one book worker; found ${workers.length}`);
  const queueJobs = await bookQueue.getJobs(["active", "wait", "delayed", "paused", "prioritized", "waiting-children"], 0, -1);
  const unrelatedQueueJobs = queueJobs.filter((job) => !allowedProjects.includes(job.data.projectId));
  if (unrelatedQueueJobs.length) throw new Error(`${unrelatedQueueJobs.length} unrelated Redis jobs are still queued or active; drain them before acceptance`);
  const unrelated = await prisma.generationJob.findMany({ where: {
    status: { in: ["QUEUED", "ACTIVE"] }, ...(allowedProjects.length ? { OR: [{ projectId: null }, { projectId: { notIn: allowedProjects } }] } : {})
  }, select: { id: true, projectId: true, status: true, bullJobId: true, updatedAt: true } });
  // Two historical local rows were audited against Redis before this matrix.
  // Never settle or delete them here; tolerate only these exact old rows after
  // freshly proving there is no corresponding Redis work.
  const auditedStaleIds = new Set(["cmpynlilm000chtp9kxffajt8", "cmq7eaern000f1npdnuoymnya"]);
  const staleRows = [];
  for (const row of unrelated) {
    const queued = await bookQueue.getJob(row.bullJobId ?? row.id);
    if (!auditedStaleIds.has(row.id) || Date.now() - row.updatedAt.getTime() < 7 * 24 * 60 * 60_000 || queued) {
      throw new Error(`Unrelated open database job ${row.id} requires inspection before acceptance`);
    }
    staleRows.push({ ...row, redisJobPresent: false });
  }
  return { workerCount: workers.length, checkedAt: new Date().toISOString(), auditedStaleRows: staleRows };
}

async function verifyPortraits(characters: Character[], userId: string) {
  const checks = [];
  for (const character of characters) {
    if (!character.portraitFile.startsWith(`${userId}/`)) throw new Error(`Portrait owner mismatch for ${character.name}`);
    const key = libraryCharacterObjectKey(character.portraitFile);
    const bytes = key ? await objectStore().get(key) : null;
    if (!bytes?.length) throw new Error(`Saved portrait is unavailable for ${character.name}`);
    checks.push({ id: character.id, name: character.name, key, bytes: bytes.length, digest: sha256(bytes) });
  }
  return checks;
}

async function prepare() {
  if (existsSync(manifestPath)) throw new Error("Manifest already exists; use launch, watch or capture");
  const benchmark = parseBenchmarkOptions({
    profile: process.argv.includes("--benchmark-profile") ? value("--benchmark-profile") : undefined,
    rounds: process.argv.includes("--rounds") ? value("--rounds") : "1",
    maxMinutes: process.argv.includes("--max-minutes") ? value("--max-minutes") : undefined
  });
  const baseline = process.argv.includes("--baseline") ? value("--baseline")! : ".scratch/character-story-30-2026-09-23/manifest.json";
  const sourceRuns = JSON.parse(readFileSync(baseline, "utf8")) as Array<{ projectId: string; input: unknown }>;
  const source = sourceRuns[0];
  if (!source) throw new Error("Baseline has no runs");
  const owner = await prisma.project.findUniqueOrThrow({ where: { id: source.projectId }, select: { userId: true } });
  const baselineInput = createProjectSchema.parse({ ...record(source.input), title: "The Lantern Path" });
  if (baselineInput.category !== "KIDS" || baselineInput.targetPages !== 30 || !baselineInput.mediaSettings.fullIllustrations || !baselineInput.mediaSettings.finalReview) throw new Error("Baseline must be an illustrated 30-page KIDS book with final review");
  const variant = prepareStorybookIllustrations(baselineInput, process.argv.includes("--illustration-cadence") ? value("--illustration-cadence") : "baseline");
  const input = createProjectSchema.parse(variant.input);
  if (benchmark.profile === "text-only-30" && variant.policy.cadence !== "none") throw new Error("The text-only-30 benchmark profile requires --illustration-cadence none");
  const characters = record(input.mediaSettings.mobile).characters as Character[] | undefined;
  if (!Array.isArray(characters) || characters.length !== 2 || !["Rabbit", "Wise Turtle"].every((name) => characters.some((entry) => entry.name === name && entry.portraitFile))) throw new Error("Baseline must contain Rabbit and Wise Turtle with saved portraits");
  const portraitChecks = await verifyPortraits(characters, owner.userId);
  const runs: Run[] = [];
  for (const round of Array.from({ length: benchmark.rounds }, (_, index) => index + 1)) for (const tier of ["fast", "balanced", "premium"] as const) {
    runs.push({ round, tier, projectId: `acceptance-${randomUUID()}`, state: "prepared", input: createProjectSchema.parse({
      ...input, mediaSettings: { ...input.mediaSettings, modelTier: tier, coverArtSource: variant.policy.cadence === "none" ? "none" : "design" }
    }) });
  }
  const illustrationPolicy = { ...variant.policy, inputFingerprint: sha256(JSON.stringify(runs.map((run) => run.input))) };
  const pdfLayoutPolicy: PdfLayoutPolicy = { mode: "one-physical-page-per-story", expectedStoryPages: input.targetPages };
  const manifest: Manifest = { version: 4, matrixId: randomUUID(), preparedAt: new Date().toISOString(), baseline, userId: owner.userId, characters, portraitChecks, runs, benchmark, illustrationPolicy, pdfLayoutPolicy };
  save(manifestPath, manifest);
  log({ prepared: runs.length, output: dir, portraitChecks, illustrationPolicy, pdfLayoutPolicy });
}

async function startRun(manifest: Manifest, run: Run) {
  // The predetermined project ID and queue dedupe key survive a harness crash
  // between the transaction and the local manifest write.
  const startedAt = new Date().toISOString();
  const plan = await prisma.$transaction(async (tx) => {
    const { templateSlug: _templateSlug, ...input } = run.input;
    await tx.project.upsert({ where: { id: run.projectId }, create: { ...input, id: run.projectId, userId: manifest.userId, status: "PLANNING" }, update: {} });
    return enqueueGenerationJob({ projectId: run.projectId, type: "PLAN_BOOK", dedupeKey: `acceptance-plan:${manifest.matrixId}:${run.projectId}`,
      payload: { inputSnapshot: run.input }, transaction: tx, dispatch: false });
  });
  Object.assign(run, { state: "running", startedAt: plan.createdAt?.toISOString() ?? startedAt, planJobId: plan.id });
  save(manifestPath, manifest);
  await dispatchGenerationJob(plan.id);
  log({ round: run.round, tier: run.tier, projectId: run.projectId, planJobId: plan.id });
}

async function approveReadyPlan(manifest: Manifest, run: Run) {
  const plan = await prisma.planVersion.findFirstOrThrow({ where: { projectId: run.projectId }, orderBy: { version: "desc" } });
  const job = await prisma.$transaction(async (tx) => {
    await tx.planVersion.update({ where: { id: plan.id }, data: { status: "APPROVED", approvedAt: new Date() } });
    await tx.project.update({ where: { id: run.projectId }, data: { status: "GENERATING", currentPlanId: plan.id } });
    return enqueueGenerationJob({ projectId: run.projectId, type: "GENERATE_BOOK", dedupeKey: `generate-book:${run.projectId}:${plan.id}`,
      payload: { planId: plan.id }, transaction: tx, dispatch: false });
  });
  Object.assign(run, { planId: plan.id, bookJobId: job.id });
  save(manifestPath, manifest);
  await dispatchGenerationJob(job.id);
}

async function captureRun(manifest: Manifest, run: Run) {
  const outputDir = join(dir, `round-${run.round}-${run.tier}`);
  mkdirSync(join(outputDir, "logs"), { recursive: true });
  const where = { projectId: run.projectId };
  const [project, plans, chapters, pages, jobs, images, calls] = await Promise.all([
    prisma.project.findUnique({ where: { id: run.projectId } }),
    prisma.planVersion.findMany({ where, orderBy: { version: "asc" } }),
    prisma.chapter.findMany({ where, orderBy: { index: "asc" } }),
    prisma.page.findMany({ where, orderBy: { index: "asc" } }),
    prisma.generationJob.findMany({ where, orderBy: { createdAt: "asc" } }),
    prisma.imageAsset.findMany({ where, orderBy: { createdAt: "asc" } }),
    prisma.providerCallLog.findMany({ where, orderBy: { createdAt: "asc" } })
  ]);
  // This capture exists even if storage or artifact validation fails afterwards.
  save(join(outputDir, "captured.json"), { capturedAt: new Date().toISOString(), project, plans, chapters, pages, jobs, images, calls });
  writeFileSync(join(outputDir, "book.md"), chapters.map((chapter) => `## ${chapter.index}. ${chapter.title}\n\n${pages.filter((page) => page.chapterId === chapter.id).map((page) => `<!-- Page ${page.index} -->\n${page.markdown}`).join("\n\n")}`).join("\n\n"));
  const captureErrors: string[] = [];
  const events: Array<Record<string, unknown>> = [];
  try {
    for (const entry of await listRunLogs(run.projectId)) {
      const raw = await readRunLog(entry.key);
      writeFileSync(join(outputDir, "logs", entry.key.split("/").at(-1)!), raw);
      for (const line of raw.split("\n").filter((line) => line.trim())) events.push(record(JSON.parse(line)));
    }
  } catch (error) { captureErrors.push(`Run logs: ${errorText(error)}`); }
  let artifacts: unknown[] = [];
  if (project && classifyGenerationCompletion(project, jobs).state === "published") {
    try { artifacts = await capturePublishedArtifacts({ project, pages, qualityReport: jobs.findLast((job) => job.type === "COMPILE_EXPORT")?.qualityReport,
      expectedIllustrationPageIndexes: manifest.illustrationPolicy?.expectedPageIndexes, pdfLayoutPolicy: manifest.pdfLayoutPolicy,
      outputDir, getObject: (key: string) => objectStore().get(key) }); }
    catch (error) { captureErrors.push(`Artifacts: ${errorText(error)}`); }
  }
  const report = summarizeAcceptance({ project, pages, jobs, images, calls, characters: manifest.characters, artifacts,
    startedAt: run.startedAt ?? null, events, tier: run.tier, maxElapsedMs: manifest.benchmark?.maxElapsedMs[run.tier],
    expectedIllustrationPageIndexes: manifest.illustrationPolicy?.expectedPageIndexes, illustrationCadence: manifest.illustrationPolicy?.cadence,
    pdfLayoutPolicy: manifest.pdfLayoutPolicy });
  if (captureErrors.length) { report.automatedPassed = false; report.acceptanceStatus = "failed"; report.functionalPassed = false; report.issues.push(...captureErrors); }
  save(join(outputDir, "summary.json"), report);
  log({ round: run.round, tier: run.tier, acceptanceStatus: report.acceptanceStatus, automatedPassed: report.automatedPassed, functionalPassed: report.functionalPassed,
    semantic: report.semantic.status, quality: report.quality.state, humanReview: report.humanReview.state,
    performance: report.performance.status, elapsedMs: report.elapsedMs, providerCalls: calls.length,
    issues: [...report.issues, ...report.performance.issues] });
  return report;
}

async function checkFrozenInputs(manifest: Manifest) {
  checkPreparedInputs(manifest);
  const current = await runtimeProvenance(manifest.benchmark, manifest.illustrationPolicy, manifest.pdfLayoutPolicy);
  if (!manifest.provenance || current.sourceHash !== manifest.provenance.sourceHash || current.fingerprint !== manifest.provenance.fingerprint) throw new Error("Code or routing changed during acceptance; do not mix these samples with a new revision");
  if (manifest.version >= 2 && current.benchmarkFingerprint !== manifest.provenance.benchmarkFingerprint) throw new Error("Experimental benchmark limits changed after launch; prepare a fresh manifest");
  if (manifest.version >= 3 && current.inputPolicyFingerprint !== manifest.provenance.inputPolicyFingerprint) throw new Error("Illustration policy changed after launch; prepare a fresh manifest");
  if (manifest.version >= 4 && current.pdfLayoutPolicyFingerprint !== manifest.provenance.pdfLayoutPolicyFingerprint) throw new Error("PDF story-page layout policy changed after launch; prepare a fresh manifest");
  const portraits = await verifyPortraits(manifest.characters, manifest.userId);
  if (JSON.stringify(portraits) !== JSON.stringify(manifest.portraitChecks)) throw new Error("Portrait bytes changed during acceptance");
}

function checkPreparedInputs(manifest: Manifest) {
  if (manifest.version < 3) return;
  if (manifest.version >= 4 && (manifest.pdfLayoutPolicy?.mode !== "one-physical-page-per-story" || manifest.pdfLayoutPolicy.expectedStoryPages !== 30)) throw new Error("Prepared storybook requires 30 distinct physical story pages");
  const policy = manifest.illustrationPolicy;
  if (!policy || policy.inputFingerprint !== sha256(JSON.stringify(manifest.runs.map((run) => run.input)))) throw new Error("Prepared storybook input changed; use a fresh manifest");
  for (const run of manifest.runs) {
    if (policy.cadence === "none") {
      if (run.input.mediaSettings.fullIllustrations || run.input.mediaSettings.illustrationCadence !== "manual" || run.input.mediaSettings.coverArtSource !== "none" || run.input.prompt !== policy.preparedPrompt || policy.expectedPageIndexes.length !== 0) throw new Error("Prepared text-only policy differs from run inputs");
      continue;
    }
    const actual = prepareStorybookIllustrations(run.input).policy;
    if (actual.cadence !== policy.cadence || JSON.stringify(actual.expectedPageIndexes) !== JSON.stringify(policy.expectedPageIndexes) || run.input.prompt !== policy.preparedPrompt) throw new Error("Prepared illustration policy differs from run inputs");
  }
}

async function watch(manifest: Manifest) {
  const deadline = Date.now() + 12 * 60 * 60_000;
  let lastLine = "";
  while (Date.now() < deadline) {
    await checkFrozenInputs(manifest);
    await localPreflight(manifest.runs.map((run) => run.projectId));
    const running = manifest.runs.filter((run) => run.state === "running");
    if (!running.length) {
      // Fail fast after the current matched round: preserve defects instead of
      // buying another six books with the same regression.
      const nextRound = nextBenchmarkRound(manifest.runs);
      if (nextRound === null) break;
      for (const run of manifest.runs.filter((run) => run.round === nextRound)) await startRun(manifest, run);
    }
    const status = [];
    for (const run of manifest.runs.filter((entry) => entry.state === "running")) {
      const project = await prisma.project.findUniqueOrThrow({ where: { id: run.projectId } });
      if (project.status === "PLAN_READY" && !run.bookJobId) await approveReadyPlan(manifest, run);
      const jobs = await prisma.generationJob.findMany({ where: { projectId: run.projectId }, orderBy: { createdAt: "asc" } });
      const completion = classifyGenerationCompletion(project, jobs);
      const active = jobs.filter((job) => job.status === "ACTIVE" || job.status === "QUEUED");
      status.push({ round: run.round, tier: run.tier, projectId: run.projectId, status: project.status,
        jobs: active.map((job) => ({ id: job.id, type: job.type, status: job.status, progress: job.progress, message: job.message, finalization: record(job.payload).finalizationProgress })) });
      if (completion.state !== "pending") {
        run.state = completion.state === "published" ? "published" : "failed";
        run.finishedAt = new Date().toISOString();
        if (completion.reason) run.failure = completion.reason;
        const report = await captureRun(manifest, run);
        run.acceptancePassed = report.automatedPassed;
        if (!report.automatedPassed) run.failure = [...report.issues, ...report.performance.issues,
          `Quality: ${report.quality.state}; coverage: ${report.semantic.status}; acceptance: ${report.acceptanceStatus}`].join("; ");
        save(manifestPath, manifest);
      }
      if (run.startedAt && Date.now() - Date.parse(run.startedAt) > GENERATION_WATCHDOG_MS) throw new Error(`Run ${run.round}/${run.tier} exceeded four hours; jobs remain available for inspection`);
    }
    save(join(dir, "status.json"), { at: new Date().toISOString(), status });
    const line = JSON.stringify(status);
    if (line !== lastLine) { log(status); lastLine = line; }
    await sleep(15_000);
  }
  const summaries = [];
  for (const run of manifest.runs.filter((run) => run.state !== "prepared")) summaries.push(await captureRun(manifest, run));
  const summary = summarizeBenchmarkMatrix(summaries, manifest.runs.length);
  save(join(dir, "summary.json"), { ...summary, benchmark: manifest.benchmark ?? null, completedAt: new Date().toISOString() });
  if (!summary.automatedPassed) throw new Error("Automated acceptance did not pass delivery, quality, coverage and performance checks; see summary.json. Human review is separate.");
}

try {
  if (command === "prepare") await prepare();
  else if (["launch", "watch", "capture", "preflight"].includes(command ?? "")) {
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as Manifest;
    checkPreparedInputs(manifest);
    if (command === "preflight") {
      log(await localPreflight(manifest.runs.filter((run) => run.state !== "prepared").map((run) => run.projectId)));
      log({ portraits: await verifyPortraits(manifest.characters, manifest.userId) });
    } else if (command === "capture") {
      const summaries = [];
      for (const run of manifest.runs.filter((run) => run.state !== "prepared")) summaries.push(await captureRun(manifest, run));
      const summary = summarizeBenchmarkMatrix(summaries, manifest.runs.length);
      save(join(dir, "summary.json"), { ...summary, benchmark: manifest.benchmark ?? null });
      if (!summary.automatedPassed) process.exitCode = 1;
    } else {
      if (command === "launch") {
        if (manifest.provenance || manifest.runs.some((run) => run.state !== "prepared")) throw new Error("Matrix was already launched; use watch");
        if (!manifest.benchmark) throw new Error("Prepare a fresh manifest with explicit experimental performance ceilings before launch");
        checkPreparedInputs(manifest);
        const preflight = await localPreflight();
        manifest.provenance = await runtimeProvenance(manifest.benchmark, manifest.illustrationPolicy, manifest.pdfLayoutPolicy);
        save(manifestPath, manifest);
        save(join(dir, "preflight.json"), preflight);
        writeFileSync(join(dir, "source.patch"), execFileSync("git", ["diff", "--binary", "HEAD", "--", "apps", "packages", "scripts", "package.json", "pnpm-lock.yaml"], { maxBuffer: 32 * 1024 * 1024 }));
        save(join(dir, "untracked-source.json"), Object.fromEntries(execFileSync("git", ["ls-files", "--others", "--exclude-standard", "-z", "--", "apps", "packages", "scripts"], { encoding: "utf8" }).split("\0").filter((path) => /\.(?:ts|tsx|js|mjs|json)$/.test(path)).map((path) => [path, readFileSync(path, "utf8")])));
      }
      await watch(manifest);
    }
  } else throw new Error("usage: storybook-acceptance.ts prepare|preflight|launch|watch|capture [--baseline path] [--out path] [--rounds 1|2|3] [--benchmark-profile text-only-30 | --max-minutes fast=5,balanced=8,premium=12] [--illustration-cadence baseline|every-page|every-third-page|none]");
} catch (error) {
  log({ error: errorText(error), output: dir });
  if (existsSync(dir)) save(join(dir, "harness-error.json"), { at: new Date().toISOString(), error: errorText(error) });
  process.exitCode = 1;
} finally {
  await bookQueue.close();
  await redisConnection.quit();
  await prisma.$disconnect();
}
