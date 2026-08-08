import { loadConfig, type JobStep } from "@book-maker/core";
import { prisma } from "@book-maker/db";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
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
  existingPages: number;
  pageIds: Set<string>;
};

export type TokenUsage = {
  promptTokens: number;
  outputTokens: number;
  cacheHitTokens: number;
  provisionalPromptTokens: number;
  provisionalOutputTokens: number;
  inFlightCalls: number;
};

type ProviderTokenLogRow = {
  generationJobId: string | null;
  promptTokens: number | null;
  outputTokens: number | null;
  cacheHitTokens: number | null;
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
  }>;
  affectedPageIndexes: number[];
};

const retryablePlanningJobTypes: GenerationJobType[] = ["PLAN_BOOK", "REVISE_PLAN"];
const resumableJobTypes: GenerationJobType[] = ["GENERATE_PAGE", "GENERATE_IMAGE", "COMPILE_EXPORT", "APPLY_BOOK_EDIT"];
const restartableJobTypes: GenerationJobType[] = ["GENERATE_BOOK", "REPLAN_BOOK"];
const generationFailureJobTypes = [...retryablePlanningJobTypes, ...resumableJobTypes, ...restartableJobTypes];
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

  const completePages = await prisma.page.count({ where: { projectId, status: "COMPLETED" } });
  const failedJobs = await prisma.generationJob.count({ where: { projectId, status: "FAILED" } });
  const pages = await prisma.page.findMany({
    where: { projectId },
    select: { id: true, index: true, status: true, revision: true, qualityReport: true }
  });
  const pageIndexById = new Map(pages.map((page) => [page.id, page.index]));
  const resumeContext: ResumeContext = {
    currentPlanId: project.currentPlanId,
    currentPlanCreatedAt: project.currentPlan?.createdAt ?? null,
    existingPages: pages.length,
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
          quotedCredits: true,
          refundPending: true,
          // An attempt that already has a paid retry must never be quoted
          // again: replaying it queues nothing. The retry itself, when it
          // failed, is the quotable attempt.
          retryAttempt: { select: { id: true } }
        }
      })
    : [];

  const [openImageJobs, compileJobs] = await Promise.all([
    prisma.generationJob.count({
      where: { projectId, type: "GENERATE_IMAGE", status: { in: ["QUEUED", "ACTIVE"] } }
    }),
    prisma.generationJob.count({
      where: { projectId, type: "COMPILE_EXPORT", status: { in: ["QUEUED", "ACTIVE", "COMPLETED"] } }
    })
  ]);
  const visibleImageCount = await prisma.imageAsset.count({
    where: { projectId, type: { notIn: ["CHARACTER_REFERENCE", "CHARACTER_PROFILE"] } }
  });

  const jobIds = project.jobs.map((job) => job.id);
  const [tokenLogRows, cost, imageFallbacksByJobId] = await Promise.all([
    prisma.providerCallLog.findMany({
      where: { projectId },
      select: {
        generationJobId: true,
        promptTokens: true,
        outputTokens: true,
        cacheHitTokens: true,
        durationMs: true,
        metadata: true
      }
    }),
    loadProjectCostSummary(projectId),
    loadImageFallbackDetails(projectId, project.jobs)
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
      steps: parseJobSteps(job.steps),
      tokens: tokensByJobId.get(job.id) ?? emptyTokenUsage(),
      providerDurationMs: providerDurationMsByJobId.get(job.id) ?? null,
      imageFallbacks: imageFallbacksByJobId.get(job.id) ?? [],
      ...(typeof pageIndex === "number" ? { pageIndex } : {})
    };
  });
  const latestQuality = normalizeProjectQuality(
    project.jobs.find((job) => job.type === "COMPILE_EXPORT" && job.qualityReport !== null)?.qualityReport
  );

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
        reviewedPages: pages.filter((page) => page.qualityReport !== null).length,
        repairedPages: pages.filter((page) => page.revision > 1).length,
        blockedPages: pages.filter((page) => page.status === "FAILED_QA").length
      }
    }
  };
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
      affectedPageIndexes
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
    affectedPageIndexes
  };
}

export function normalizeTokenUsage(input?: Partial<Record<keyof TokenUsage, number | null>> | null): TokenUsage {
  return {
    promptTokens: finiteTokenValue(input?.promptTokens),
    outputTokens: finiteTokenValue(input?.outputTokens),
    cacheHitTokens: finiteTokenValue(input?.cacheHitTokens),
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

function safePathPart(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 120) || "unknown";
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

function canRecoverGenerationJob(
  type: GenerationJobType,
  payload: unknown,
  context: ResumeContext,
  jobCreatedAt: Date
): boolean {
  const payloadRecord = jsonPayloadToRecord(payload);

  if (type === "PLAN_BOOK") {
    return !context.currentPlanCreatedAt || jobCreatedAt > context.currentPlanCreatedAt;
  }

  if (type === "REVISE_PLAN") {
    return (
      typeof payloadRecord.planId === "string" &&
      payloadRecord.planId === context.currentPlanId &&
      typeof payloadRecord.message === "string" &&
      payloadRecord.message.trim().length > 0
    );
  }

  if (!context.currentPlanId) {
    return false;
  }

  const planId = payloadPlanId(payloadRecord);
  if (planId && planId !== context.currentPlanId) {
    return false;
  }

  if (type === "GENERATE_BOOK") {
    return planId === context.currentPlanId;
  }

  if (type === "GENERATE_PAGE") {
    return typeof payloadRecord.pageId === "string" && context.pageIds.has(payloadRecord.pageId);
  }

  if (type === "GENERATE_IMAGE") {
    return (
      isCurrentCoverPayload(payloadRecord, context) ||
      (typeof payloadRecord.pageId === "string" &&
        context.pageIds.has(payloadRecord.pageId) &&
        typeof payloadRecord.prompt === "string")
    );
  }

  return type === "COMPILE_EXPORT" || type === "APPLY_BOOK_EDIT" || type === "REPLAN_BOOK";
}

function payloadPlanId(payload: Record<string, unknown>): string | null {
  const value = payload.planId;
  return typeof value === "string" ? value : null;
}

function isCurrentCoverPayload(payload: Record<string, unknown>, context: ResumeContext): boolean {
  return payload.assetType === "COVER" && payloadPlanId(payload) === context.currentPlanId;
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
