import { loadConfig, safePathPart, type JobStep } from "@book-maker/core";
import { prisma } from "@book-maker/db";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
// The four recovery lists live in one leaf module. This file, `routes/projects.ts`
// and `mobile/schemas.ts` each kept a byte-identical copy with no import between
// them, which is how a new job type becomes recoverable on one surface only.
import { generationFailureJobTypes, retryablePlanningJobTypes } from "./generationJobTypes.js";
// What the app *reports* as recoverable and what a resume route will actually
// requeue have to be the same answer — this file used to carry its own copy of
// the predicate, which is how a book could offer a retry that queued nothing.
import { canRecoverGenerationJob } from "./mobile/generationRecovery.js";
// And for the same reason: an export repair's model-free report is not this
// book's verdict, which the write side already knows and this read used not to.
// Asked of the owning compile directly rather than picked out of `project.jobs`
// below — that list is the newest 25 jobs of any type, so a book with an
// audiobook, a few image retries or a repair loop pushed its own verdict out of
// the window and rendered a blank quality card.
import { loadProjectQualityReport } from "./mobile/qualityVerdict.js";
// How many pages of this book are written — the one read of its pages, and the
// question of whether anything open is still going to redraft one. Split out
// whole: the poll reports the number, `projectPageCounts.ts` decides it.
import { countBookPages, pageRewriteScope, readProjectPageRows } from "./projectPageCounts.js";
import { loadProjectCostSummary } from "./projectCosts.js";
import type { GenerationJobType } from "./queue.js";

export type PipelineStepKey = "plan" | "pages" | "images" | "export";
export type StepStatus = "pending" | "active" | "done" | "failed";

export type PipelineStep = {
  key: PipelineStepKey;
  label: string;
  status: StepStatus;
  detail?: string;
};

type ResumeContext = {
  currentPlanId: string | null;
  currentPlanCreatedAt: Date | null;
  pageIds: Set<string>;
};

export type TokenUsage = {
  promptTokens: number;
  outputTokens: number;
  cacheHitTokens: number;
  cacheWriteTokens: number;
  provisionalPromptTokens: number;
  provisionalOutputTokens: number;
  inFlightCalls: number;
};

type ProviderTokenLogRow = {
  generationJobId: string | null;
  promptTokens: number | null;
  outputTokens: number | null;
  cacheHitTokens: number | null;
  cacheWriteTokens: number | null;
  durationMs: number | null;
  metadata: unknown;
};

export type JobImageFallbackDetails = {
  status: "attempting" | "used" | "failed";
  primary: {
    provider: string;
    model: string;
    error?: string | undefined;
  };
  fallback: {
    provider: string;
    model: string;
    error?: string | undefined;
  };
  result?: {
    provider: string;
    model: string;
  } | undefined;
  occurredAt?: string | undefined;
};

export type ProjectQualityStatus = {
  state: "pending" | "passed" | "review_recommended" | "blocked";
  score: number | null;
  issues: Array<{
    code: string;
    severity: "error" | "warning";
    source: "deterministic" | "model";
    message: string;
    guidance: string;
    affectedPageIndexes: number[];
    metrics?: {
      occurrences?: number;
      affectedPageRatio?: number;
      clusterCount?: number;
      chaptersSpanned?: number;
      sameParagraphRole?: boolean;
      wouldBlock?: boolean;
    };
    evidence?: Array<{
      pageIndex: number;
      excerpt: string;
    }>;
  }>;
  affectedPageIndexes: number[];
  diagnostics?: {
    detectorVersion: string;
    wouldBlock: boolean;
    findings: Array<{
      code: string;
      detectorVersion: string;
      severity: "error" | "warning";
      affectedPageCount: number;
      occurrences: number;
      affectedPageRatio: number;
      clusterCount?: number;
      chaptersSpanned?: number;
      wouldBlock: boolean;
    }>;
  };
};

const config = loadConfig();

export async function buildProjectStatus(projectId: string) {
  const project = await prisma.project.findUnique({
    where: { id: projectId },
    include: {
      currentPlan: true,
      jobs: { orderBy: { createdAt: "desc" }, take: 25 },
      _count: { select: { pages: true, images: true, research: true } }
    }
  });
  if (!project) {
    return null;
  }

  // Every page number this status reports is counted off this one read — the
  // complete count, the blocked pages and the reviewed ones, so no pair of them
  // can contradict each other. It is a raw statement because the predicate has
  // to know whether a page holds prose without carrying the prose, and the
  // counting rule it feeds is `countBookPages` below; both live in
  // `projectPageCounts.ts`, with the skew that taught them.
  const pages = await readProjectPageRows(projectId);
  const failedJobs = await prisma.generationJob.count({ where: { projectId, status: "FAILED" } });
  const pageIndexById = new Map(pages.map((page) => [page.id, page.index]));
  const resumeContext: ResumeContext = {
    currentPlanId: project.currentPlanId,
    currentPlanCreatedAt: project.currentPlan?.createdAt ?? null,
    pageIds: new Set(pages.map((page) => page.id))
  };
  const failedGenerationJobs = await prisma.generationJob.findMany({
    where: {
      projectId,
      status: "FAILED",
      type: { in: generationFailureJobTypes }
    },
    orderBy: { createdAt: "asc" },
    select: { type: true, payload: true, createdAt: true, attemptId: true }
  });
  const recoveryCandidates = failedGenerationJobs.filter((job) =>
    canRecoverGenerationJob(job.type as GenerationJobType, job.payload, resumeContext, job.createdAt)
  );
  const planningRecoveryCandidates = recoveryCandidates.filter((job) =>
    retryablePlanningJobTypes.includes(job.type as GenerationJobType)
  );
  const jobsForRecovery = planningRecoveryCandidates.length > 0 ? planningRecoveryCandidates : recoveryCandidates;
  const resumableAttemptIds = [
    ...new Set(jobsForRecovery.flatMap((job) => (job.attemptId ? [job.attemptId] : [])))
  ];
  const generationAttempts = resumableAttemptIds.length
    ? await prisma.generationAttempt.findMany({
        where: { id: { in: resumableAttemptIds } },
        select: {
          id: true,
          commandKey: true,
          status: true,
          // `requiresConfirmation` is false only for PLAN_GENERATION. Dropping
          // this column makes every retry look like a full-book charge and the
          // app keeps the dedicated billing dialog.
          operation: true,
          quotedCredits: true,
          refundPending: true,
          // An attempt that already has a paid retry must never be quoted
          // again: replaying it queues nothing. The retry itself, when it
          // failed, is the quotable attempt.
          retryAttempt: { select: { id: true } }
        }
      })
    : [];

  const [openImageJobs, compileJobs, rewriteScope] = await Promise.all([
    prisma.generationJob.count({
      where: { projectId, type: "GENERATE_IMAGE", status: { in: ["QUEUED", "ACTIVE"] } }
    }),
    prisma.generationJob.count({
      where: { projectId, type: "COMPILE_EXPORT", status: { in: ["QUEUED", "ACTIVE", "COMPLETED"] } }
    }),
    // A page that exhausted its QA budget keeps its best draft and still ships
    // in the export, so once nothing is going to rewrite it, it counts as a page
    // of the book — a finished, readable 200-page book must not report 197/200.
    // Whether anything still will is the pipeline's question rather than the
    // page's, and it is asked here, in the fan-out, because a book still being
    // written answers it from its status alone: the poll that runs every few
    // seconds through a generation sends no read for it.
    pageRewriteScope(projectId, project.status)
  ]);
  const completePages = countBookPages(pages, rewriteScope);
  const visibleImageCount = await prisma.imageAsset.count({
    where: { projectId, type: { notIn: ["CHARACTER_REFERENCE", "CHARACTER_PROFILE"] } }
  });

  const jobIds = project.jobs.map((job) => job.id);
  const [tokenLogRows, cost, imageFallbacksByJobId, qualityReport] = await Promise.all([
    prisma.providerCallLog.findMany({
      where: { projectId },
      select: {
        generationJobId: true,
        promptTokens: true,
        outputTokens: true,
        cacheHitTokens: true,
        cacheWriteTokens: true,
        durationMs: true,
        metadata: true
      }
    }),
    loadProjectCostSummary(projectId),
    loadImageFallbackDetails(projectId, project.jobs),
    loadProjectQualityReport(projectId)
  ]);
  const projectTokens = summarizeTokenLogs(tokenLogRows);
  const visibleJobIds = new Set(jobIds);
  const tokensByJobId = summarizeTokenLogsByJob(tokenLogRows, visibleJobIds);
  const providerDurationMsByJobId = providerDurationsByJob(tokenLogRows, visibleJobIds);

  const pageProgress = { complete: completePages, target: project.targetPages };
  const pipeline = buildPipelineSteps({
    projectStatus: project.status,
    currentPlanCreatedAt: project.currentPlan?.createdAt ?? null,
    jobs: project.jobs,
    pageProgress,
    imageCount: visibleImageCount,
    openImageJobs,
    hasCompileJob: compileJobs > 0
  });

  const jobsWithSteps = project.jobs.map((job) => {
    const payloadRecord = jsonPayloadToRecord(job.payload);
    const pageIndex =
      job.type === "GENERATE_PAGE" && typeof payloadRecord.pageId === "string"
        ? pageIndexById.get(payloadRecord.pageId)
        : undefined;

    return {
      ...job,
      // This mapper is the shared public boundary for the operator's ordinary
      // status response and its SSE stream. Compile rows retain exact page
      // fingerprints so the worker can settle a redelivery safely, but those
      // fingerprints are worker-private and must never ride the public job
      // DTO. Keep the durable report untouched and preserve every public field.
      qualityReport: publicGenerationJobQualityReport(job.qualityReport),
      steps: parseJobSteps(job.steps),
      tokens: tokensByJobId.get(job.id) ?? emptyTokenUsage(),
      providerDurationMs: providerDurationMsByJobId.get(job.id) ?? null,
      imageFallbacks: imageFallbacksByJobId.get(job.id) ?? [],
      ...(typeof pageIndex === "number" ? { pageIndex } : {})
    };
  });
  const latestQuality = normalizeProjectQuality(qualityReport);

  return {
    project: { ...project, jobs: jobsWithSteps, generationAttempts },
    quality: latestQuality,
    progress: {
      pages: pageProgress,
      images: visibleImageCount,
      research: project._count.research,
      failedJobs,
      resumableFailedJobs: recoveryCandidates.length,
      resumableAttemptIds,
      // Image work still owed and whether an export has ever been compiled:
      // both already drive the pipeline steps, and the mobile generation
      // progress needs them to size its illustration and finish bands.
      openImageJobs,
      hasCompileJob: compileJobs > 0,
      pipeline,
      tokens: projectTokens,
      cost,
      quality: {
        reviewedPages: pages.filter((page) => page.hasQualityReport).length,
        repairedPages: pages.filter((page) => page.revision > 1).length,
        blockedPages: pages.filter((page) => page.status === "FAILED_QA").length
      }
    }
  };
}

function publicGenerationJobQualityReport(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return value;
  }
  const report = { ...(value as Record<string, unknown>) };
  delete report._standDownProvenance;
  return report;
}

export function normalizeProjectQuality(value: unknown): ProjectQualityStatus {
  const record = jsonPayloadToRecord(value);
  const state = ["passed", "review_recommended", "blocked"].includes(String(record.state))
    ? (record.state as ProjectQualityStatus["state"])
    : "pending";
  const rawIssues = Array.isArray(record.issues) ? record.issues : [];
  const issues = rawIssues.flatMap((entry) => {
    const issue = jsonPayloadToRecord(entry);
    if (typeof issue.code !== "string" || typeof issue.message !== "string") return [];
    const severity: ProjectQualityStatus["issues"][number]["severity"] =
      issue.severity === "error" ? "error" : "warning";
    const source: ProjectQualityStatus["issues"][number]["source"] =
      issue.source === "deterministic" ? "deterministic" : "model";
    const affectedPageIndexes = Array.isArray(issue.affectedPageIndexes)
      ? issue.affectedPageIndexes.filter((index): index is number => Number.isInteger(index) && Number(index) > 0)
      : [];
    return [{
      code: issue.code,
      severity,
      source,
      message: issue.message,
      guidance: typeof issue.guidance === "string" ? issue.guidance : "Review the affected pages.",
      affectedPageIndexes,
      ...optionalQualityMetrics(issue.metrics),
      ...optionalQualityEvidence(issue.evidence)
    }];
  });
  const affectedPageIndexes = [
    ...new Set(
      (Array.isArray(record.affectedPageIndexes) ? record.affectedPageIndexes : issues.flatMap((issue) => issue.affectedPageIndexes))
        .filter((index): index is number => Number.isInteger(index) && Number(index) > 0)
    )
  ].sort((left, right) => left - right);
  return {
    state,
    score: typeof record.score === "number" && Number.isFinite(record.score) ? record.score : null,
    issues,
    affectedPageIndexes,
    ...optionalQualityDiagnostics(record.diagnostics)
  };
}

function optionalQualityMetrics(
  value: unknown
): { metrics: NonNullable<ProjectQualityStatus["issues"][number]["metrics"]> } | Record<string, never> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  const record = value as Record<string, unknown>;
  const metrics: NonNullable<ProjectQualityStatus["issues"][number]["metrics"]> = {
    ...(typeof record.occurrences === "number" && Number.isFinite(record.occurrences) ? { occurrences: record.occurrences } : {}),
    ...(typeof record.affectedPageRatio === "number" && Number.isFinite(record.affectedPageRatio)
      ? { affectedPageRatio: record.affectedPageRatio }
      : {}),
    ...(typeof record.clusterCount === "number" && Number.isFinite(record.clusterCount) ? { clusterCount: record.clusterCount } : {}),
    ...(typeof record.chaptersSpanned === "number" && Number.isFinite(record.chaptersSpanned)
      ? { chaptersSpanned: record.chaptersSpanned }
      : {}),
    ...(typeof record.sameParagraphRole === "boolean" ? { sameParagraphRole: record.sameParagraphRole } : {}),
    ...(typeof record.wouldBlock === "boolean" ? { wouldBlock: record.wouldBlock } : {})
  };
  return Object.keys(metrics).length > 0 ? { metrics } : {};
}

function optionalQualityEvidence(
  value: unknown
): { evidence: NonNullable<ProjectQualityStatus["issues"][number]["evidence"]> } | Record<string, never> {
  if (!Array.isArray(value)) {
    return {};
  }
  const evidence = value.flatMap((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      return [];
    }
    const record = entry as Record<string, unknown>;
    if (!Number.isInteger(record.pageIndex) || typeof record.excerpt !== "string") {
      return [];
    }
    return [{ pageIndex: Number(record.pageIndex), excerpt: record.excerpt }];
  });
  return evidence.length > 0 ? { evidence } : {};
}

function optionalQualityDiagnostics(
  value: unknown
): { diagnostics: NonNullable<ProjectQualityStatus["diagnostics"]> } | Record<string, never> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  const record = value as Record<string, unknown>;
  if (typeof record.detectorVersion !== "string" || typeof record.wouldBlock !== "boolean" || !Array.isArray(record.findings)) {
    return {};
  }
  const findings = record.findings.flatMap((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      return [];
    }
    const finding = entry as Record<string, unknown>;
    if (
      typeof finding.code !== "string" ||
      typeof finding.detectorVersion !== "string" ||
      (finding.severity !== "error" && finding.severity !== "warning") ||
      typeof finding.affectedPageCount !== "number" ||
      typeof finding.occurrences !== "number" ||
      typeof finding.affectedPageRatio !== "number" ||
      typeof finding.wouldBlock !== "boolean"
    ) {
      return [];
    }
    return [{
      code: finding.code,
      detectorVersion: finding.detectorVersion,
      severity: finding.severity,
      affectedPageCount: finding.affectedPageCount,
      occurrences: finding.occurrences,
      affectedPageRatio: finding.affectedPageRatio,
      wouldBlock: finding.wouldBlock,
      ...(typeof finding.clusterCount === "number" ? { clusterCount: finding.clusterCount } : {}),
      ...(typeof finding.chaptersSpanned === "number" ? { chaptersSpanned: finding.chaptersSpanned } : {})
    }];
  });
  return {
    diagnostics: {
      detectorVersion: record.detectorVersion,
      wouldBlock: record.wouldBlock,
      findings
    }
  };
}

export function normalizeTokenUsage(input?: Partial<Record<keyof TokenUsage, number | null>> | null): TokenUsage {
  return {
    promptTokens: finiteTokenValue(input?.promptTokens),
    outputTokens: finiteTokenValue(input?.outputTokens),
    cacheHitTokens: finiteTokenValue(input?.cacheHitTokens),
    cacheWriteTokens: finiteTokenValue(input?.cacheWriteTokens),
    provisionalPromptTokens: finiteTokenValue(input?.provisionalPromptTokens),
    provisionalOutputTokens: finiteTokenValue(input?.provisionalOutputTokens),
    inFlightCalls: finiteTokenValue(input?.inFlightCalls)
  };
}

function emptyTokenUsage(): TokenUsage {
  return normalizeTokenUsage();
}

function finiteTokenValue(value: number | null | undefined): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function summarizeTokenLogs(rows: ProviderTokenLogRow[]): TokenUsage {
  const totals = emptyTokenUsage();
  for (const row of rows) {
    if (!shouldCountTokenLog(row)) {
      continue;
    }
    const metadata = liveTokenMetadata(row.metadata);
    const promptTokens = finiteTokenValue(row.promptTokens);
    const outputTokens = finiteTokenValue(row.outputTokens);
    totals.promptTokens += promptTokens;
    totals.outputTokens += outputTokens;
    totals.cacheHitTokens += finiteTokenValue(row.cacheHitTokens);
    totals.cacheWriteTokens += finiteTokenValue(row.cacheWriteTokens);
    if (metadata.promptTokensEstimated) {
      totals.provisionalPromptTokens += promptTokens;
    }
    if (metadata.outputTokensEstimated) {
      totals.provisionalOutputTokens += outputTokens;
    }
    if (metadata.liveStatus === "in_progress") {
      totals.inFlightCalls += 1;
    }
  }
  return totals;
}

function summarizeTokenLogsByJob(rows: ProviderTokenLogRow[], jobIds: Set<string>): Map<string, TokenUsage> {
  const grouped = new Map<string, ProviderTokenLogRow[]>();
  for (const row of rows) {
    if (!row.generationJobId || !jobIds.has(row.generationJobId)) {
      continue;
    }
    grouped.set(row.generationJobId, [...(grouped.get(row.generationJobId) ?? []), row]);
  }
  return new Map([...grouped.entries()].map(([jobId, jobRows]) => [jobId, summarizeTokenLogs(jobRows)] as const));
}

function providerDurationsByJob(rows: ProviderTokenLogRow[], jobIds: Set<string>): Map<string, number> {
  const totals = new Map<string, number>();
  for (const row of rows) {
    if (!row.generationJobId || !jobIds.has(row.generationJobId) || row.durationMs === null || !shouldCountTokenLog(row)) {
      continue;
    }
    totals.set(row.generationJobId, (totals.get(row.generationJobId) ?? 0) + row.durationMs);
  }
  return totals;
}

function shouldCountTokenLog(row: ProviderTokenLogRow): boolean {
  return liveTokenMetadata(row.metadata).liveStatus !== "failed";
}

function liveTokenMetadata(metadata: unknown): {
  liveStatus?: string | undefined;
  promptTokensEstimated: boolean;
  outputTokensEstimated: boolean;
} {
  const record = jsonPayloadToRecord(metadata);
  return {
    liveStatus: typeof record.liveStatus === "string" ? record.liveStatus : undefined,
    promptTokensEstimated: record.promptTokensEstimated === true,
    outputTokensEstimated: record.outputTokensEstimated === true
  };
}

async function loadImageFallbackDetails(
  projectId: string,
  jobs: Array<{ id: string; type: string; bullJobId: string | null }>
): Promise<Map<string, JobImageFallbackDetails[]>> {
  const entries = await Promise.all(
    jobs.map(async (job) => {
      const details = await readImageFallbackDetailsForJob(projectId, job);
      return [job.id, details] as const;
    })
  );
  return new Map(entries.filter(([, details]) => details.length > 0));
}

async function readImageFallbackDetailsForJob(
  projectId: string,
  job: { id: string; type: string; bullJobId: string | null }
): Promise<JobImageFallbackDetails[]> {
  const jobName = jobQueueName(job.type);
  if (!jobName) {
    return [];
  }

  const primaryPath = runLogPath(projectId, job.id, jobName);
  const fallbackPath = job.bullJobId ? runLogPath(projectId, `bull-${job.bullJobId}`, jobName) : null;
  const content = (await readOptionalTextFile(primaryPath)) ?? (fallbackPath ? await readOptionalTextFile(fallbackPath) : null);
  if (!content) {
    return [];
  }

  return parseImageFallbackDetails(content);
}

function parseImageFallbackDetails(content: string): JobImageFallbackDetails[] {
  const details: JobImageFallbackDetails[] = [];
  let pending: JobImageFallbackDetails | null = null;

  for (const line of content.split(/\r?\n/)) {
    if (!line.trim()) {
      continue;
    }
    const entry = safeJsonParseRecord(line);
    if (!entry) {
      continue;
    }
    const event = stringField(entry, "event");
    if (event === "image.generate.fallback.start") {
      if (pending) {
        details.push(pending);
      }
      const primary = fallbackAttemptFromRecord(recordField(entry, "primary"));
      const fallback = fallbackAttemptFromRecord(recordField(entry, "fallback"));
      if (!primary || !fallback) {
        pending = null;
        continue;
      }
      pending = {
        status: "attempting",
        primary,
        fallback,
        ...(typeof entry.timestamp === "string" ? { occurredAt: entry.timestamp } : {})
      };
      continue;
    }

    if (event === "image.generate.fallback.success" && pending) {
      const result = fallbackProviderFromRecord(recordField(entry, "result"));
      details.push({
        ...pending,
        status: "used",
        ...(result ? { result } : {}),
        ...(typeof entry.timestamp === "string" ? { occurredAt: entry.timestamp } : {})
      });
      pending = null;
      continue;
    }

    if (event === "image.generate.fallback.error" && pending) {
      const fallback = fallbackAttemptFromRecord(recordField(entry, "fallback"));
      details.push({
        ...pending,
        status: "failed",
        ...(fallback ? { fallback } : {}),
        ...(typeof entry.timestamp === "string" ? { occurredAt: entry.timestamp } : {})
      });
      pending = null;
    }
  }

  if (pending) {
    details.push(pending);
  }
  return details;
}

async function readOptionalTextFile(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return null;
  }
}

function runLogPath(projectId: string, runId: string, jobName: string): string {
  return join(config.BOOK_STORAGE_DIR, projectId, "runs", `${safePathPart(runId)}-${safePathPart(jobName)}.jsonl`);
}

function jobQueueName(type: string): string | null {
  return (
    {
      PLAN_BOOK: "plan-book",
      REVISE_PLAN: "revise-plan",
      GENERATE_BOOK: "generate-book",
      GENERATE_PAGE: "generate-page",
      GENERATE_IMAGE: "generate-image",
      COMPILE_EXPORT: "compile-export",
      APPLY_BOOK_EDIT: "apply-book-edit",
      REPLAN_BOOK: "replan-book",
      PREPARE_CHARACTER_CANDIDATES: "prepare-character-candidates",
      BUILD_CHARACTER_PERSONA: "build-character-persona",
      IMPORT_BOOK: "import-book",
      CONTINUE_BOOK: "continue-book",
      GENERATE_AUDIOBOOK: "generate-audiobook"
    } satisfies Record<string, string>
  )[type] ?? null;
}

function fallbackAttemptFromRecord(value: Record<string, unknown> | null): JobImageFallbackDetails["primary"] | null {
  const provider = stringField(value, "provider");
  const model = stringField(value, "model");
  if (!provider || !model) {
    return null;
  }
  const error = fallbackErrorMessage(recordField(value, "error"));
  return {
    provider,
    model,
    ...(error ? { error } : {})
  };
}

function fallbackProviderFromRecord(value: Record<string, unknown> | null): JobImageFallbackDetails["result"] | null {
  const provider = stringField(value, "provider");
  const model = stringField(value, "model");
  return provider && model ? { provider, model } : null;
}

function fallbackErrorMessage(error: Record<string, unknown> | null): string | null {
  const message = stringField(error, "message");
  if (message) {
    return truncateJobDetail(message, 360);
  }
  const value = stringField(error, "value");
  return value ? truncateJobDetail(value, 360) : null;
}

function truncateJobDetail(value: string, maxLength: number): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length > maxLength ? `${normalized.slice(0, maxLength - 3)}...` : normalized;
}

function safeJsonParseRecord(line: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(line) as unknown;
    return jsonPayloadToRecord(parsed);
  } catch {
    return null;
  }
}

function recordField(value: Record<string, unknown> | null, key: string): Record<string, unknown> | null {
  const field = value?.[key];
  return field && typeof field === "object" && !Array.isArray(field) ? (field as Record<string, unknown>) : null;
}

function stringField(value: Record<string, unknown> | null, key: string): string | null {
  const field = value?.[key];
  return typeof field === "string" && field.trim() ? field.trim() : null;
}

export function buildPipelineSteps(input: {
  projectStatus: string;
  currentPlanCreatedAt?: Date | null;
  jobs: Array<{ type: string; status: string; createdAt?: Date }>;
  pageProgress: { complete: number; target: number };
  imageCount: number;
  openImageJobs: number;
  hasCompileJob: boolean;
}): PipelineStep[] {
  const { projectStatus, currentPlanCreatedAt, jobs, pageProgress, imageCount, openImageJobs, hasCompileJob } = input;
  const planFailed = jobs.some(
    (job) =>
      (job.type === "PLAN_BOOK" || job.type === "REVISE_PLAN") &&
      job.status === "FAILED" &&
      isCurrentPlanningFailure(job.createdAt, currentPlanCreatedAt ?? null)
  );
  const planActive = jobs.some(
    (job) =>
      (job.type === "PLAN_BOOK" || job.type === "REVISE_PLAN") &&
      (job.status === "QUEUED" || job.status === "ACTIVE")
  );
  const pagesDone = pageProgress.complete >= pageProgress.target && pageProgress.target > 0;
  const editActive = jobs.some(
    (job) =>
      (job.type === "APPLY_BOOK_EDIT" || job.type === "REPLAN_BOOK") &&
      (job.status === "QUEUED" || job.status === "ACTIVE")
  );
  const pagesActive =
    (projectStatus === "GENERATING" && !pagesDone && pageProgress.target > 0) ||
    (projectStatus === "EDITING" && editActive);
  const exportActive = jobs.some(
    (job) => job.type === "COMPILE_EXPORT" && (job.status === "QUEUED" || job.status === "ACTIVE")
  );
  const exportDone = projectStatus === "COMPLETE" || projectStatus === "REVIEW_REQUIRED" || hasCompileJob;
  const imagesActive =
    openImageJobs > 0 || (pagesDone && projectStatus === "GENERATING" && !exportDone && !exportActive);
  const imagesDone =
    exportDone || (pagesDone && openImageJobs === 0 && (imageCount > 0 || ["COMPLETE", "REVIEW_REQUIRED"].includes(projectStatus)));

  const planDone = ["PLAN_READY", "GENERATING", "EDITING", "COMPLETE", "REVIEW_REQUIRED"].includes(projectStatus);

  const planDetail = planActive ? "Planning in progress" : planDone ? "Plan ready" : undefined;
  const exportDetail = exportDone ? "Markdown & PDF ready" : exportActive ? "Compiling export" : editActive ? "Waiting for edits" : undefined;

  return [
    {
      key: "plan",
      label: "Plan",
      status: planFailed ? "failed" : planActive || projectStatus === "PLANNING" ? "active" : planDone ? "done" : "pending",
      ...(planDetail ? { detail: planDetail } : {})
    },
    {
      key: "pages",
      label: "Pages",
      status: pagesActive ? "active" : pagesDone ? "done" : "pending",
      detail: `${pageProgress.complete}/${pageProgress.target} pages`
    },
    {
      key: "images",
      label: "Images",
      status: imagesDone ? "done" : imagesActive ? "active" : "pending",
      detail: imagesActive && openImageJobs > 0 ? `${openImageJobs} in queue` : `${imageCount} images`
    },
    {
      key: "export",
      label: "Export",
      status: exportDone ? "done" : exportActive ? "active" : "pending",
      ...(exportDetail ? { detail: exportDetail } : {})
    }
  ];
}

function isCurrentPlanningFailure(jobCreatedAt: Date | undefined, currentPlanCreatedAt: Date | null): boolean {
  return !currentPlanCreatedAt || (jobCreatedAt ? jobCreatedAt > currentPlanCreatedAt : true);
}

function jsonPayloadToRecord(payload: unknown): Record<string, unknown> {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return {};
  }
  return payload as Record<string, unknown>;
}

function parseJobSteps(value: unknown): JobStep[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter(
    (step): step is JobStep =>
      typeof step === "object" &&
      step !== null &&
      typeof (step as JobStep).key === "string" &&
      typeof (step as JobStep).label === "string" &&
      ["pending", "active", "done", "failed"].includes((step as JobStep).status)
  );
}
