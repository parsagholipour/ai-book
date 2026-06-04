import type { JobStep } from "@book-maker/core";
import { prisma } from "@book-maker/db";
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
  existingPages: number;
  pageIds: Set<string>;
};

export type TokenUsage = {
  promptTokens: number;
  outputTokens: number;
  cacheHitTokens: number;
};

const resumableJobTypes: GenerationJobType[] = ["GENERATE_PAGE", "GENERATE_IMAGE", "COMPILE_EXPORT"];
const restartableJobTypes: GenerationJobType[] = ["GENERATE_BOOK"];
const generationFailureJobTypes = [...resumableJobTypes, ...restartableJobTypes];

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
    existingPages: pages.length,
    pageIds: new Set(pages.map((page) => page.id))
  };
  const failedGenerationJobs = project.currentPlanId
    ? await prisma.generationJob.findMany({
        where: {
          projectId,
          status: "FAILED",
          type: { in: generationFailureJobTypes }
        },
        select: { type: true, payload: true }
      })
    : [];
  const resumableFailedJobs = failedGenerationJobs.filter((job) =>
    canResumeGenerationJob(job.type as GenerationJobType, job.payload, resumeContext)
  ).length;

  const [openImageJobs, compileJobs] = await Promise.all([
    prisma.generationJob.count({
      where: { projectId, type: "GENERATE_IMAGE", status: { in: ["QUEUED", "ACTIVE"] } }
    }),
    prisma.generationJob.count({
      where: { projectId, type: "COMPILE_EXPORT", status: { in: ["QUEUED", "ACTIVE", "COMPLETED"] } }
    })
  ]);
  const visibleImageCount = await prisma.imageAsset.count({
    where: { projectId, type: { not: "CHARACTER_REFERENCE" } }
  });

  const jobIds = project.jobs.map((job) => job.id);
  const [tokenLogs, jobTokenLogs, cost] = await Promise.all([
    prisma.providerCallLog.aggregate({
      where: { projectId },
      _sum: { promptTokens: true, outputTokens: true, cacheHitTokens: true }
    }),
    jobIds.length > 0
      ? prisma.providerCallLog.groupBy({
          by: ["generationJobId"],
          where: { projectId, generationJobId: { in: jobIds } },
          _sum: { promptTokens: true, outputTokens: true, cacheHitTokens: true, durationMs: true }
        })
      : Promise.resolve([]),
    loadProjectCostSummary(projectId)
  ]);
  const tokensByJobId = new Map(
    jobTokenLogs.flatMap((row) =>
      row.generationJobId ? [[row.generationJobId, normalizeTokenUsage(row._sum)] as const] : []
    )
  );
  const providerDurationMsByJobId = new Map(
    jobTokenLogs.flatMap((row) =>
      row.generationJobId && row._sum.durationMs !== null ? [[row.generationJobId, row._sum.durationMs] as const] : []
    )
  );

  const pageProgress = { complete: completePages, target: project.targetPages };
  const pipeline = buildPipelineSteps({
    projectStatus: project.status,
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
      ...(typeof pageIndex === "number" ? { pageIndex } : {})
    };
  });

  return {
    project: { ...project, jobs: jobsWithSteps },
    progress: {
      pages: pageProgress,
      images: visibleImageCount,
      research: project._count.research,
      failedJobs,
      resumableFailedJobs,
      pipeline,
      tokens: normalizeTokenUsage(tokenLogs._sum),
      cost,
      quality: {
        reviewedPages: pages.filter((page) => page.qualityReport !== null).length,
        repairedPages: pages.filter((page) => page.revision > 1).length,
        blockedPages: pages.filter((page) => page.status === "FAILED_QA").length
      }
    }
  };
}

export function normalizeTokenUsage(input?: Partial<Record<keyof TokenUsage, number | null>> | null): TokenUsage {
  return {
    promptTokens: finiteTokenValue(input?.promptTokens),
    outputTokens: finiteTokenValue(input?.outputTokens),
    cacheHitTokens: finiteTokenValue(input?.cacheHitTokens)
  };
}

function emptyTokenUsage(): TokenUsage {
  return { promptTokens: 0, outputTokens: 0, cacheHitTokens: 0 };
}

function finiteTokenValue(value: number | null | undefined): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

export function buildPipelineSteps(input: {
  projectStatus: string;
  jobs: Array<{ type: string; status: string }>;
  pageProgress: { complete: number; target: number };
  imageCount: number;
  openImageJobs: number;
  hasCompileJob: boolean;
}): PipelineStep[] {
  const { projectStatus, jobs, pageProgress, imageCount, openImageJobs, hasCompileJob } = input;
  const planFailed = jobs.some(
    (job) =>
      (job.type === "PLAN_BOOK" || job.type === "REVISE_PLAN") && job.status === "FAILED"
  );
  const planActive = jobs.some(
    (job) =>
      (job.type === "PLAN_BOOK" || job.type === "REVISE_PLAN") &&
      (job.status === "QUEUED" || job.status === "ACTIVE")
  );
  const pagesDone = pageProgress.complete >= pageProgress.target && pageProgress.target > 0;
  const pagesActive =
    projectStatus === "GENERATING" && !pagesDone && pageProgress.target > 0;
  const exportActive = jobs.some(
    (job) => job.type === "COMPILE_EXPORT" && (job.status === "QUEUED" || job.status === "ACTIVE")
  );
  const exportDone = projectStatus === "COMPLETE" || hasCompileJob;
  const imagesActive =
    openImageJobs > 0 || (pagesDone && projectStatus === "GENERATING" && !exportDone && !exportActive);
  const imagesDone =
    exportDone || (pagesDone && openImageJobs === 0 && (imageCount > 0 || projectStatus === "COMPLETE"));

  const planDone = ["PLAN_READY", "GENERATING", "COMPLETE"].includes(projectStatus);

  const planDetail = planActive ? "Planning in progress" : planDone ? "Plan ready" : undefined;
  const exportDetail = exportDone ? "Markdown & PDF ready" : exportActive ? "Compiling export" : undefined;

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
      status: pagesDone ? "done" : pagesActive ? "active" : "pending",
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

function canResumeGenerationJob(type: GenerationJobType, payload: unknown, context: ResumeContext): boolean {
  if (!context.currentPlanId) {
    return false;
  }

  const payloadRecord = jsonPayloadToRecord(payload);
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

  return type === "COMPILE_EXPORT";
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
