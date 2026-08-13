import type { GenerationJobRow, JobStep, JobStepStatus, PipelineStep, ProjectStatus } from "./api.js";

/*
 * Fallback step labels for rows the API sent with no steps — a job that has not
 * gone ACTIVE yet, so `buildStepTemplate` has not written any.
 *
 * The authored table is `JOB_STEP_TEMPLATES` in `packages/core/src/jobSteps.ts`,
 * exhaustive over `GenerationJobType`, and this should be derived from it rather
 * than restated. **It cannot be, today**: `apps/web` declares no dependency on
 * `@book-maker/core` (there is no `node_modules/@book-maker` link under it and
 * no file here imports it), a relative import into `packages/core/src` fails
 * this project's `rootDir: "src"`, and `@book-maker/core`'s only export is a
 * barrel that pulls in puppeteer, sharp and `node:fs` — none of which survive a
 * browser build. Unblocking it needs two `package.json` edits this change was
 * not allowed to make: a `workspace:*` dependency here, and a `"./jobSteps"`
 * subpath export on core so the barrel stays out of the bundle. Until then this
 * is a hand-copy and the copying is the risk: `GENERATE_CHARACTER_PORTRAIT` was
 * already missing from it, which renders as a silently empty step list.
 */
const JOB_STEP_LABELS: Record<string, string[]> = {
  PLAN_BOOK: ["Research", "Create plan", "Save plan"],
  REVISE_PLAN: ["Revise plan", "Save revision"],
  GENERATE_BOOK: ["Prepare book", "Create pages", "Queue follow-ups"],
  GENERATE_PAGE: ["Prepare context", "Draft page", "Quality review", "Revise draft", "Save page"],
  GENERATE_IMAGE: ["Build prompt", "Render image", "Store asset"],
  COMPILE_EXPORT: ["Final review", "Compile markdown", "Write Markdown", "Generate PDF", "Generate EPUB"],
  APPLY_BOOK_EDIT: ["Prepare edit", "Snapshot pages", "Apply edits", "Refresh exports"],
  REPLAN_BOOK: ["Revise plan", "Save approved plan", "Queue regeneration"],
  PREPARE_CHARACTER_CANDIDATES: ["Detect characters", "Save candidates"],
  BUILD_CHARACTER_PERSONA: ["Build persona", "Create profile picture", "Save character"],
  IMPORT_BOOK: ["Read manuscript", "Split into chapters", "Learn writing style", "Save your book"],
  CONTINUE_BOOK: ["Outline new chapters", "Write new pages", "Save chapters", "Refresh exports"],
  GENERATE_AUDIOBOOK: ["Prepare narration", "Narrate chapters", "Finish audiobook"],
  GENERATE_CHARACTER_PORTRAIT: ["Prepare portrait", "Draw portrait", "Save portrait"]
};

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

  const labels = JOB_STEP_LABELS[job.type];
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
