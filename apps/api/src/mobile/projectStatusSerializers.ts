import { bookPdfNumberingForProject } from "../bookPageNumbering.js";
import { buildProjectStatus, type PipelineStep } from "../projectStatus.js";
import { type GenerationJobType } from "../queue.js";
import { serializeEditProgress } from "./editProgress.js";
import { serializeGenerationProgress } from "./generationProgress.js";
import { generationRecoveryQuote } from "./generationRetryQuote.js";
import { imageSettingsFromMediaSettings } from "./imageSettings.js";
import { serializePlanningProgress } from "./planningProgress.js";
import { findCurrentOwningFailure } from "./generationRecovery.js";
import { serializeExportSet } from "./projectArtifactSerializers.js";
import { qualityWithExportsOnDisk } from "./qualityVerdict.js";
import {
  type MobileExportSetDto,
  type MobilePlanOperationDto,
  type MobileProjectStatusDto,
  type MobileQueuedJobDto,
  type ProjectStatusResult
} from "./dto.js";
import { generationJobControlsProjectStatus, loadConfig, printedPageOffset } from "@book-maker/core";

/**
 * Serializes project status, progress, current actions, failures, and recovery.
 * Job lifecycle ownership stays behind this seam so derivative jobs cannot
 * accidentally change the status of an otherwise healthy book.
 */

/**
 * The reader's cover-skip flag, and only on the status DTO — that is the one
 * the app reads it from, and a second copy on the summary would be a second
 * answer to the same question for surfaces that never ask it.
 *
 * True when printed numbers skip the cover (version-2 maps and cover-numbering
 * stubs, after the CSS page-counter reset). False for a version-1 map whose PDF
 * still numbered the cover. The exact revision + digest travel with it: a
 * revision alone cannot distinguish a same-revision repair, and an EDITING
 * project deliberately keeps an older map while its replacement is built.
 * Legacy maps missing either identity field answer nothing, leaving the app on
 * physical numbering rather than asking it to guess which PDF they describe.
 */
function serializedHasCoverPage(project: {
  pdfPageMap?: unknown;
  contentRevision: number;
  status?: string;
}):
  | {
      hasCoverPage: boolean;
      pdfPageNumbering: { hasCoverPage: boolean; contentRevision: number; pdfDigest: string };
    }
  | Record<string, never> {
  const numbering = bookPdfNumberingForProject(project);
  const contentRevision = numbering?.contentRevision;
  const pdfDigest = numbering?.pdfDigest;
  if (contentRevision === undefined || !pdfDigest) {
    return {};
  }
  const hasCoverPage = printedPageOffset(numbering) > 0;
  return {
    hasCoverPage,
    pdfPageNumbering: { hasCoverPage, contentRevision, pdfDigest }
  };
}

export async function loadSerializedProjectStatus(
  projectId: string,
  appConfig: ReturnType<typeof loadConfig>,
  userId: string
): Promise<MobileProjectStatusDto | null> {
  const status = await buildProjectStatus(projectId);
  if (!status) {
    return null;
  }
  const exports = await serializeExportSet(
    projectId,
    status.project.title,
    appConfig,
    userId,
    status.project.contentRevision
  );
  return serializeProjectStatus(status, exports);
}

export function serializeProjectStatus(status: ProjectStatusResult, exports: MobileExportSetDto): MobileProjectStatusDto {
  const project = status.project;
  const steps = status.progress.pipeline.map(mobileStepFromPipeline);
  // Derivative operations report failure through their own resources. A
  // narration or voice-character failure must not make a healthy book look
  // failed or replace the book's own recovery guidance. The same is true per
  // *job* for the two payload-flagged kinds that settle alone: an export
  // repair rebuilds a file for a book that is already finished and paid for,
  // and a presentation-only reprint restores the settled status it was born
  // under — a Chromium blip on either would leave a COMPLETE book saying
  // "needs attention" forever — `hasFailure` in the app is exactly this field —
  // with nothing the reader could do about it. The repair re-queues itself
  // when a download or status surface next asks; a reprint re-queues when the
  // reader toggles the preference again.
  const failedJob = findCurrentOwningFailure(project.jobs, generationJobControlsProjectStatus);
  const imageSettings = imageSettingsFromMediaSettings(project.mediaSettings);
  const generationProgress = serializeGenerationProgress(status, imageSettings);
  const editProgress = serializeEditProgress(status);
  const progressPercent = statusProgressPercent(status, generationProgress, editProgress);
  const planningProgress = serializePlanningProgress(status);
  // Newest eligible attempt first: `resumableAttemptIds` follows the failed
  // jobs' creation order, so after a paid retry fails the retry's id is the
  // later one — and it, not the original, is what can be retried again. An
  // attempt that already has a retry is excluded outright: confirming its
  // quote would replay that retry and queue nothing, forever.
  const resumableAttempts = [...(status.progress.resumableAttemptIds ?? [])]
    .reverse()
    .flatMap((attemptId) => {
      const attempt = (project.generationAttempts ?? []).find((candidate) => candidate.id === attemptId);
      return attempt ? [attempt] : [];
    });
  const failedAttempt =
    resumableAttempts.find(
      (attempt) =>
        (attempt.status === "FAILED" || attempt.status === "CANCELED") &&
        !attempt.refundPending &&
        !attempt.retryAttempt &&
        attempt.quotedCredits >= 0
    ) ?? null;
  const recoveryQuote = failedAttempt ? generationRecoveryQuote(failedAttempt) : null;

  return {
    projectId: project.id,
    status: normalizeProjectStatus(project.status),
    statusLabel: statusLabel(project.status),
    progressPercent,
    ...imageSettings,
    // The live phrase leads whenever there is one: it is the only part of this
    // payload that says what is happening right now rather than what stage it is.
    currentAction: planningProgress?.steps.find((step) => step.status === "active")?.label ??
      generationProgress?.detail ??
      editProgress?.detail ??
      currentActionFromSteps(project.status, steps, progressPercent),
    planningProgress,
    generationProgress,
    editProgress,
    failureMessage: failedJob ? failureMessageForJob(failedJob.type as GenerationJobType, failedJob.error) : null,
    retryAvailable: status.progress.resumableFailedJobs > 0 && recoveryQuote !== null,
    recoveryQuote,
    steps,
    pageProgress: {
      completed: status.progress.pages.complete,
      target: status.progress.pages.target
    },
    imageCount: status.progress.images,
    quality: qualityWithExportsOnDisk(status.quality, exports),
    exports,
    ...serializedHasCoverPage(project),
    updatedAt: project.updatedAt.toISOString()
  };
}

export function mobileStepFromPipeline(step: PipelineStep): MobileProjectStatusDto["steps"][number] {
  const keyByPipelineKey = {
    plan: "plan",
    pages: "write",
    images: "visuals",
    export: "export"
  } as const satisfies Record<PipelineStep["key"], MobileProjectStatusDto["steps"][number]["key"]>;
  const labelByPipelineKey = {
    plan: "Plan",
    pages: "Write",
    images: "Visuals",
    export: "Export"
  } as const satisfies Record<PipelineStep["key"], string>;

  return {
    key: keyByPipelineKey[step.key],
    label: labelByPipelineKey[step.key],
    status: step.status,
    detail: step.detail ?? null
  };
}

export function statusProgressPercent(
  status: ProjectStatusResult,
  generationProgress?: MobileProjectStatusDto["generationProgress"],
  editProgress?: MobileProjectStatusDto["editProgress"]
): number {
  const projectStatus = status.project.status;
  if (projectStatus === "COMPLETE" || projectStatus === "REVIEW_REQUIRED") {
    return 100;
  }
  if (projectStatus === "DRAFT") {
    return 0;
  }
  if (projectStatus === "PLANNING") {
    return 10;
  }
  if (projectStatus === "PLAN_READY") {
    return 20;
  }
  if (projectStatus === "EDITING") {
    // The flat 92 is the fallback for the window between enqueueing an edit and
    // the worker picking it up, when there is no job progress to report yet.
    return editProgress?.percent ?? 92;
  }
  // One number, one source: the bar the app draws and the bar inside the step
  // list must never disagree about the same book.
  if (generationProgress) {
    return generationProgress.percent;
  }

  const pageTarget = Math.max(1, status.progress.pages.target);
  const pageRatio = Math.max(0, Math.min(1, status.progress.pages.complete / pageTarget));
  const pagesPercent = 20 + Math.round(pageRatio * 60);
  const visualsDone = status.progress.pipeline.find((step) => step.key === "images")?.status === "done";
  const exportDone = status.progress.pipeline.find((step) => step.key === "export")?.status === "done";
  return Math.max(pagesPercent, visualsDone ? 88 : 0, exportDone ? 96 : 0);
}

export function projectProgressPercent(status: string, completePages: number, targetPages: number): number {
  if (status === "COMPLETE" || status === "REVIEW_REQUIRED") {
    return 100;
  }
  if (status === "DRAFT") {
    return 0;
  }
  if (status === "PLANNING") {
    return 10;
  }
  if (status === "PLAN_READY") {
    return 20;
  }
  if (status === "EDITING") {
    return 92;
  }
  const pageRatio = Math.max(0, Math.min(1, completePages / Math.max(targetPages, 1)));
  return status === "GENERATING" ? 20 + Math.round(pageRatio * 60) : Math.round(pageRatio * 80);
}

export function currentActionFromSteps(
  status: string,
  steps: MobileProjectStatusDto["steps"],
  progressPercent: number
): string {
  const activeStep = steps.find((step) => step.status === "active");
  if (activeStep?.key === "plan") {
    return "Creating your book plan.";
  }
  if (activeStep?.key === "write") {
    return "Writing your book pages.";
  }
  if (activeStep?.key === "visuals") {
    return "Creating visuals.";
  }
  if (activeStep?.key === "export") {
    return "Preparing downloads.";
  }
  return currentActionForProject(status, progressPercent);
}

export function currentActionForProject(
  status: string,
  progressPercent: number,
  options: { hasExistingPlan?: boolean } = {}
): string {
  switch (status) {
    case "DRAFT":
      return "Ready to create a book plan.";
    case "PLANNING":
      return options.hasExistingPlan ? "Revising your book plan." : "Creating your book plan.";
    case "PLAN_READY":
      return "Ready for review.";
    case "GENERATING":
      return progressPercent >= 90 ? "Preparing downloads." : "Writing your book.";
    case "EDITING":
      return "Editing your book.";
    case "COMPLETE":
      return "Ready to download.";
    case "REVIEW_REQUIRED":
      return "Ready to download - some pages are flagged for review.";
    case "FAILED":
      return "Needs attention.";
    default:
      return "Working on your book.";
  }
}

export function statusLabel(status: string): string {
  switch (status) {
    case "DRAFT":
      return "Draft saved";
    case "PLANNING":
      return "Building your outline";
    case "PLAN_READY":
      return "Review your book plan";
    case "GENERATING":
      return "Generating your book";
    case "EDITING":
      return "Editing your book";
    case "COMPLETE":
      return "Ready to export";
    case "REVIEW_REQUIRED":
      return "Review required";
    case "FAILED":
      return "Needs attention";
    default:
      return "Working";
  }
}

export function failureMessageForJob(type: GenerationJobType, rawError: string | null): string {
  const phase = {
    PLAN_BOOK: "creating your plan",
    REVISE_PLAN: "revising your plan",
    GENERATE_BOOK: "starting book generation",
    GENERATE_PAGE: "writing a page",
    GENERATE_IMAGE: "creating a visual",
    COMPILE_EXPORT: "preparing downloads",
    APPLY_BOOK_EDIT: "editing your book",
    REPLAN_BOOK: "rebuilding your book plan",
    PREPARE_CHARACTER_CANDIDATES: "preparing voice characters",
    BUILD_CHARACTER_PERSONA: "building a voice character",
    IMPORT_BOOK: "importing your book",
    CONTINUE_BOOK: "writing new chapters",
    GENERATE_AUDIOBOOK: "narrating your book",
    GENERATE_CHARACTER_PORTRAIT: "drawing a character portrait"
  } satisfies Record<GenerationJobType, string>;
  const detail = rawError?.replace(/\s+/g, " ").trim();
  return detail ? `We hit a problem while ${phase[type]}: ${detail.slice(0, 240)}` : `We hit a problem while ${phase[type]}.`;
}

export function planOperation(
  status: MobilePlanOperationDto["status"],
  projectId: string,
  planId: string | null,
  job: { id: string; status: string },
  currentAction: string
): MobilePlanOperationDto {
  return {
    projectId,
    planId,
    status,
    currentAction,
    job: {
      id: job.id,
      status: normalizeJobStatus(job.status),
      currentAction
    }
  };
}

export function normalizeProjectStatus(status: string): string {
  return status.toLowerCase();
}

export function isLiveProjectStatus(status: string): boolean {
  return status === "planning" || status === "generating" || status === "editing";
}

export function normalizeJobStatus(status: string): MobileQueuedJobDto["status"] {
  if (status === "ACTIVE") {
    return "active";
  }
  if (status === "COMPLETED") {
    return "completed";
  }
  if (status === "FAILED") {
    return "failed";
  }
  if (status === "CANCELED") {
    return "canceled";
  }
  return "queued";
}
