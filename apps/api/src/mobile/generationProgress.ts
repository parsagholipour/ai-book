import type { MobileProjectStatusDto, ProjectStatusResult } from "./dto.js";
import { jsonRecord, stringField } from "./support.js";

/**
 * Live progress for the book itself, the way planning already reports itself.
 *
 * The worker writes a lot of true detail while a book is written — which
 * chapter is being outlined, which page is being polished, how far the export
 * has got. None of it can be forwarded verbatim: `GenerationJob.message` is
 * internal text full of queue and provider vocabulary. So this module reads the
 * *step keys* the worker sets and maps them through a curated table, exactly as
 * `serializePlanningProgress` does for planning, and takes every number from
 * counts rather than prose.
 */

type GenerationProgressDto = NonNullable<MobileProjectStatusDto["generationProgress"]>;
type GenerationStep = GenerationProgressDto["steps"][number];
type GenerationStepKey = GenerationStep["key"];
type StepStatus = GenerationStep["status"];
type StatusJob = ProjectStatusResult["project"]["jobs"][number];

const STEP_LABELS: Record<GenerationStepKey, string> = {
  prepare: "Preparing your chapters",
  write: "Writing your pages",
  illustrate: "Creating your illustrations",
  finish: "Building your book"
};

/**
 * A page draft's own output, used only to ease the bar between page
 * completions. Deliberately a single number: the point is a believable rate of
 * travel, not an estimate anyone should act on.
 */
export const EXPECTED_PAGE_OUTPUT_TOKENS = 900;

/** Where the GENERATE_BOOK job's own progress column tops out (its `enqueue` step). */
const PREPARE_PROGRESS_CEILING = 85;

/** Where the COMPILE_EXPORT job's own progress column tops out (its `epub` step). */
const FINISH_PROGRESS_CEILING = 95;

const PREPARE_BAND = { start: 20, end: 28 } as const;
const ILLUSTRATE_BAND = { start: 80, end: 92 } as const;

export function serializeGenerationProgress(
  status: ProjectStatusResult,
  options: { imagesEnabled: boolean }
): MobileProjectStatusDto["generationProgress"] {
  const projectStatus = status.project.status;
  // Planning has its own reporting, and an edit is a different story than
  // writing a book — neither is described by these four steps.
  if (projectStatus === "DRAFT" || projectStatus === "PLANNING" || projectStatus === "PLAN_READY" || projectStatus === "EDITING") {
    return null;
  }

  const keys: GenerationStepKey[] = options.imagesEnabled
    ? ["prepare", "write", "illustrate", "finish"]
    : ["prepare", "write", "finish"];
  const settled = projectStatus === "COMPLETE" || projectStatus === "REVIEW_REQUIRED";
  if (settled) {
    return {
      percent: 100,
      detail: null,
      steps: keys.map((key) => ({ key, label: STEP_LABELS[key], status: "done", detail: settledDetail(key, status) }))
    };
  }

  const phase = readPhase(status);
  const steps = keys.map((key) => ({
    key,
    label: STEP_LABELS[key],
    status: stepStatus(key, phase),
    detail: stepDetail(key, status, phase)
  }));

  return {
    percent: generationProgressPercent(status, phase, options.imagesEnabled),
    detail: liveDetail(status, phase),
    steps
  };
}

type GenerationPhase = {
  bookJob: StatusJob | undefined;
  activeBookStep: string | undefined;
  /** The lowest-numbered page still being written, when we can name one. */
  activePageJob: StatusJob | undefined;
  activeImageJob: StatusJob | undefined;
  compileJob: StatusJob | undefined;
  activeCompileStep: string | undefined;
  writingStarted: boolean;
  pagesDone: boolean;
  imagesDone: boolean;
  failedStep: GenerationStepKey | null;
};

function readPhase(status: ProjectStatusResult): GenerationPhase {
  const jobs = status.project.jobs;
  const pages = status.progress.pages;
  const bookJob = jobs.find((job) => job.type === "GENERATE_BOOK");
  const activeBookStep = activeStepKey(bookJob);
  const openPageJobs = jobs.filter((job) => job.type === "GENERATE_PAGE" && isOpen(job));
  const activePageJob = openPageJobs
    .slice()
    .sort((left, right) => (left.pageIndex ?? Number.MAX_SAFE_INTEGER) - (right.pageIndex ?? Number.MAX_SAFE_INTEGER))[0];
  const activeImageJob = jobs.find((job) => job.type === "GENERATE_IMAGE" && isOpen(job));
  const compileJob = jobs.find((job) => job.type === "COMPILE_EXPORT");
  const pipelineStatus = (key: string) => status.progress.pipeline.find((step) => step.key === key)?.status;

  // Preparing owns the window before any page work exists. Once a page has
  // landed, a page job is open, or the book job has reached its fan-out step,
  // the story is writing — including the direct execution modes, where the book
  // job sits on `setup` for the whole book.
  const writingStarted =
    pages.complete > 0 ||
    openPageJobs.length > 0 ||
    activeBookStep === "enqueue" ||
    bookJob === undefined ||
    bookJob.status === "COMPLETED" ||
    (activeBookStep === "setup" && pages.complete > 0);

  return {
    bookJob,
    activeBookStep,
    activePageJob,
    activeImageJob,
    compileJob,
    activeCompileStep: activeStepKey(compileJob),
    writingStarted,
    pagesDone: pages.target > 0 && pages.complete >= pages.target,
    imagesDone: pipelineStatus("images") === "done",
    failedStep: failedStepFor(jobs, writingStarted)
  };
}

function stepStatus(key: GenerationStepKey, phase: GenerationPhase): StepStatus {
  if (phase.failedStep === key) {
    return "failed";
  }
  switch (key) {
    case "prepare":
      return phase.writingStarted ? "done" : "active";
    case "write":
      if (!phase.writingStarted) return "pending";
      return phase.pagesDone ? "done" : "active";
    case "illustrate":
      if (phase.imagesDone) return "done";
      return phase.activeImageJob || (phase.pagesDone && !phase.compileJob) ? "active" : "pending";
    case "finish":
      if (!phase.compileJob) return "pending";
      return phase.compileJob.status === "COMPLETED" ? "done" : "active";
  }
}

function stepDetail(key: GenerationStepKey, status: ProjectStatusResult, phase: GenerationPhase): string | null {
  const pages = status.progress.pages;
  switch (key) {
    case "prepare": {
      const chapters = chapterCount(status);
      return chapters > 0 ? `${chapters} ${chapters === 1 ? "chapter" : "chapters"}` : null;
    }
    case "write":
      return pages.target > 0 ? `${pages.complete} of ${pages.target} pages` : null;
    case "illustrate": {
      const done = status.progress.images;
      const outstanding = openImageJobCount(status);
      if (phase.imagesDone || outstanding === 0) {
        return done > 0 ? `${done} ${done === 1 ? "illustration" : "illustrations"}` : null;
      }
      return `${done} of ${done + outstanding} illustrations`;
    }
    case "finish":
      return null;
  }
}

function settledDetail(key: GenerationStepKey, status: ProjectStatusResult): string | null {
  const pages = status.progress.pages;
  switch (key) {
    case "prepare": {
      const chapters = chapterCount(status);
      return chapters > 0 ? `${chapters} ${chapters === 1 ? "chapter" : "chapters"}` : null;
    }
    case "write":
      return pages.complete > 0 ? `${pages.complete} ${pages.complete === 1 ? "page" : "pages"}` : null;
    case "illustrate": {
      const done = status.progress.images;
      return done > 0 ? `${done} ${done === 1 ? "illustration" : "illustrations"}` : null;
    }
    case "finish":
      return "PDF and EPUB ready";
  }
}

/**
 * What is happening this second, in the reader's words.
 *
 * Reads the furthest-along open job, because that is the one whose step key
 * describes the frontier of the work.
 */
export function liveDetail(status: ProjectStatusResult, phase: GenerationPhase): string | null {
  if (phase.compileJob && isOpen(phase.compileJob)) {
    return compilePhrase(phase.activeCompileStep);
  }
  if (phase.activeImageJob) {
    return imagePhrase(phase.activeImageJob);
  }
  if (phase.activePageJob) {
    return pagePhrase(phase.activePageJob, status);
  }
  if (phase.writingStarted) {
    const pages = status.progress.pages;
    if (pages.target > 0 && pages.complete < pages.target) {
      return `Writing page ${pages.complete + 1} of ${pages.target}`;
    }
    return null;
  }
  return bookPhrase(phase.activeBookStep, status);
}

function bookPhrase(stepKey: string | undefined, status: ProjectStatusResult): string | null {
  switch (stepKey) {
    case "briefs": {
      const chapters = chapterCount(status);
      return chapters > 0 ? `Mapping out your ${chapters} chapters` : "Mapping out your chapters";
    }
    case "setup":
      return "Setting up your chapters and pages";
    case "enqueue":
      return "Getting the writing started";
    default:
      return "Preparing to write your book";
  }
}

function pagePhrase(job: StatusJob, status: ProjectStatusResult): string | null {
  const index = job.pageIndex ?? status.progress.pages.complete + 1;
  switch (activeStepKey(job)) {
    case "prepare":
      return `Getting ready to write page ${index}`;
    case "draft":
      return `Writing page ${index}`;
    case "qa":
      return `Reading back page ${index}`;
    case "revise":
      return `Polishing page ${index}`;
    case "save":
      return `Saving page ${index}`;
    default:
      return `Writing page ${index}`;
  }
}

function imagePhrase(job: StatusJob): string | null {
  const isCover = stringField(jsonRecord(job.payload), "assetType") === "COVER";
  switch (activeStepKey(job)) {
    case "prompt":
      return isCover ? "Designing your cover" : "Designing your next illustration";
    case "render":
      return isCover ? "Painting your cover" : "Drawing your illustration";
    case "store":
      return isCover ? "Saving your cover" : "Saving your illustration";
    default:
      return isCover ? "Designing your cover" : "Designing your next illustration";
  }
}

/** Shared with `editProgress`: an edit ends in the same compile job. */
export function compilePhrase(stepKey: string | undefined): string | null {
  switch (stepKey) {
    case "qa":
      return "Doing a final read-through";
    case "compile":
      return "Putting the chapters together";
    case "write":
      return "Laying out your book";
    case "pdf":
      return "Making your PDF";
    case "epub":
      return "Making your EPUB";
    default:
      return "Building your book";
  }
}

/**
 * A percent that moves the way the work does.
 *
 * Each band is fed by something independently non-decreasing — a job's own
 * progress column, completed page count, settled images — so taking the maximum
 * across bands is what keeps the whole number monotonic without storing a
 * floor. It stops below 100 until the project itself settles.
 */
export function generationProgressPercent(
  status: ProjectStatusResult,
  phase: GenerationPhase,
  imagesEnabled: boolean
): number {
  const pages = status.progress.pages;
  const writeEnd = imagesEnabled ? 80 : 86;
  const finishStart = imagesEnabled ? ILLUSTRATE_BAND.end : writeEnd;

  const prepare = PREPARE_BAND.start + band(PREPARE_BAND) * clamp01((phase.bookJob?.progress ?? 0) / PREPARE_PROGRESS_CEILING);

  // The nudge is capped at a single page's worth of the bar, so a long-running
  // draft keeps the bar alive without ever overtaking the pages actually saved.
  const pageRatio = clamp01(pages.complete / Math.max(1, pages.target));
  const pageSlice = 1 / Math.max(1, pages.target);
  const nudge = pageSlice * (1 - Math.exp((-1.6 * activeWriteTokens(phase)) / EXPECTED_PAGE_OUTPUT_TOKENS));
  const write = phase.writingStarted
    ? PREPARE_BAND.end + (writeEnd - PREPARE_BAND.end) * Math.min(1, pageRatio + nudge)
    : 0;

  // Gated behind finished pages: a newly enqueued image job grows the
  // denominator, and without the gate that would walk the bar backwards.
  const imageRatio = phase.imagesDone
    ? 1
    : clamp01(status.progress.images / Math.max(1, status.progress.images + openImageJobCount(status)));
  const illustrate =
    imagesEnabled && phase.pagesDone ? ILLUSTRATE_BAND.start + band(ILLUSTRATE_BAND) * imageRatio : 0;

  const finish = phase.compileJob
    ? finishStart + (99 - finishStart) * clamp01(phase.compileJob.progress / FINISH_PROGRESS_CEILING)
    : 0;

  return Math.min(99, Math.round(Math.max(PREPARE_BAND.start, prepare, write, illustrate, finish)));
}

function activeWriteTokens(phase: GenerationPhase): number {
  const pageTokens = phase.activePageJob?.tokens?.outputTokens ?? 0;
  // In the direct execution modes there is no page job: the book job writes the
  // pages itself, and its token total is cumulative, so the exponential
  // saturates and the nudge settles at a steady one-page lead.
  const bookTokens = phase.activePageJob ? 0 : (phase.bookJob?.tokens?.outputTokens ?? 0);
  const tokens = Math.max(pageTokens, bookTokens);
  return Number.isFinite(tokens) ? Math.max(0, tokens) : 0;
}

function failedStepFor(jobs: readonly StatusJob[], writingStarted: boolean): GenerationStepKey | null {
  const failed = jobs.find(
    (job) =>
      job.status === "FAILED" &&
      (job.type === "GENERATE_BOOK" || job.type === "GENERATE_PAGE" || job.type === "GENERATE_IMAGE" || job.type === "COMPILE_EXPORT")
  );
  if (!failed) {
    return null;
  }
  if (failed.type === "COMPILE_EXPORT") return "finish";
  if (failed.type === "GENERATE_IMAGE") return "illustrate";
  if (failed.type === "GENERATE_PAGE") return "write";
  return writingStarted ? "write" : "prepare";
}

function chapterCount(status: ProjectStatusResult): number {
  const chapters = jsonRecord(status.project.currentPlan?.planningPackage).chapters;
  return Array.isArray(chapters) ? chapters.length : 0;
}

function activeStepKey(job: StatusJob | undefined): string | undefined {
  return job?.steps?.find((step) => step.status === "active")?.key;
}

/** A job that has been created but never started carries no steps yet. */
function openImageJobCount(status: ProjectStatusResult): number {
  const count = status.progress.openImageJobs;
  return typeof count === "number" && Number.isFinite(count) ? Math.max(0, count) : 0;
}

function isOpen(job: StatusJob): boolean {
  return job.status === "QUEUED" || job.status === "ACTIVE";
}

function band(range: { start: number; end: number }): number {
  return range.end - range.start;
}

function clamp01(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0;
}
