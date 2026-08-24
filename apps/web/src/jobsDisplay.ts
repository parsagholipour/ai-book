import { JOB_STEP_TEMPLATES } from "@book-maker/core/jobSteps";
import type { GenerationJobRow, JobStep, JobStepStatus, PipelineStep, ProjectStatus } from "./api.js";

/**
 * Fallback step labels for rows the API sent with no steps — a job that has not
 * gone ACTIVE yet, so `buildStepTemplate` has not written any.
 *
 * Derived from core's authored `JOB_STEP_TEMPLATES`, which is exhaustive over
 * `GenerationJobType` by type, rather than restated: this was the last hand-kept
 * per-job-type list in the console. The templates carry a `key` the worker
 * advances through and the mobile serializers translate; only the `label` is
 * console vocabulary, so only the label is taken. Keyed as a `Map` because
 * `job.type` arrives from the API as a `string` — a type this build has no
 * template for gets no steps, the way core's own `generationJobTypeForWorkerName`
 * answers an unrecognised name, and the row still renders its type, progress
 * and message.
 *
 * Never the barrel: `scripts/check-core-subpaths.mjs` refuses it here, and
 * puppeteer, sharp and `node:fs` are why.
 */
const JOB_STEP_LABELS = new Map<string, readonly string[]>(
  Object.entries(JOB_STEP_TEMPLATES).map(([type, steps]) => [type, steps.map((step) => step.label)])
);

export function parseJobSteps(value: unknown): JobStep[] {
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

export function resolveJobDisplaySteps(job: GenerationJobRow): JobStep[] {
  const fromApi = parseJobSteps(job.steps);
  if (fromApi.length) {
    return fromApi;
  }

  const labels = JOB_STEP_LABELS.get(job.type);
  if (!labels?.length) {
    return [];
  }

  if (job.status === "COMPLETED") {
    return labels.map((label, index) => ({
      key: `step-${index}`,
      label,
      status: "done" as const
    }));
  }

  if (job.status === "FAILED") {
    return labels.map((label, index) => ({
      key: `step-${index}`,
      label,
      status: (index === 0 ? "failed" : "pending") as JobStepStatus
    }));
  }

  if (job.status === "ACTIVE") {
    const activeIndex = Math.min(
      labels.length - 1,
      Math.max(0, Math.floor((job.progress / 100) * labels.length))
    );
    return labels.map((label, index) => ({
      key: `step-${index}`,
      label,
      status: (index < activeIndex ? "done" : index === activeIndex ? "active" : "pending") as JobStepStatus
    }));
  }

  return labels.map((label, index) => ({
    key: `step-${index}`,
    label,
    status: "pending" as const
  }));
}

export function resolvePipelineSteps(status: ProjectStatus | null): PipelineStep[] {
  if (status?.progress.pipeline?.length) {
    return status.progress.pipeline;
  }

  if (!status) {
    return defaultPipeline();
  }

  const { project, progress } = status;
  const pages = progress.pages;
  const planDone = ["PLAN_READY", "GENERATING", "COMPLETE"].includes(project.status);
  const pagesDone = pages.complete >= pages.target && pages.target > 0;
  const exportDone = project.status === "COMPLETE";

  return [
    {
      key: "plan",
      label: "Plan",
      status: project.status === "PLANNING" ? "active" : planDone ? "done" : "pending",
      ...(planDone ? { detail: "Plan ready" } : {})
    },
    {
      key: "pages",
      label: "Pages",
      status: pagesDone ? "done" : project.status === "GENERATING" ? "active" : planDone ? "pending" : "pending",
      detail: `${pages.complete}/${pages.target} pages`
    },
    {
      key: "images",
      label: "Images",
      status: exportDone ? "done" : pagesDone ? "active" : "pending",
      detail: `${progress.images} images`
    },
    {
      key: "export",
      label: "Export",
      status: exportDone ? "done" : "pending",
      ...(exportDone ? { detail: "Markdown, PDF & EPUB ready" } : {})
    }
  ];
}

function defaultPipeline(): PipelineStep[] {
  return [
    { key: "plan", label: "Plan", status: "pending" },
    { key: "pages", label: "Pages", status: "pending", detail: "0/0 pages" },
    { key: "images", label: "Images", status: "pending", detail: "0 images" },
    { key: "export", label: "Export", status: "pending" }
  ];
}

export function normalizeProjectStatus(status: ProjectStatus): ProjectStatus {
  return {
    ...status,
    project: {
      ...status.project,
      jobs: status.project.jobs.map((job) => ({
        ...job,
        steps: resolveJobDisplaySteps(job)
      }))
    },
    progress: {
      ...status.progress,
      pipeline: resolvePipelineSteps(status)
    }
  };
}
