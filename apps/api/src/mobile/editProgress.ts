import type { MobileProjectStatusDto, ProjectStatusResult } from "./dto.js";
import { compilePhrase } from "./generationProgress.js";
import { jsonRecord } from "./support.js";

/**
 * Live progress for an edit to a finished book, the way `generationProgress`
 * already reports writing one.
 *
 * The worker writes real step progress while an edit runs — which pages are
 * being snapshotted, which page is being rewritten and whether it is being
 * drafted or read back, when the exports are rebuilt. Until this module existed
 * none of it reached the app: the status serializer pinned `EDITING` at a
 * constant 92% with the constant phrase "Editing your book.", so the chat's
 * progress card sat frozen for the whole job.
 *
 * Same rules as its sibling: read the *step keys and counters* the worker sets
 * and phrase them here, never forward `GenerationJob.message`, and take every
 * number from something the worker already made non-decreasing.
 */

type EditProgressDto = NonNullable<MobileProjectStatusDto["editProgress"]>;
type EditStep = EditProgressDto["steps"][number];
type EditStepKey = EditStep["key"];
type StatusJob = ProjectStatusResult["project"]["jobs"][number];
type EditJobType = "APPLY_BOOK_EDIT" | "CONTINUE_BOOK" | "REPLAN_BOOK";

/**
 * The reader-facing name for each step the edit jobs report.
 *
 * Keyed by job type because `export` means the same thing in all of them but the
 * earlier steps do not, and because an unknown key must be droppable — a step
 * template can gain entries in the worker before this table knows about them.
 */
const STEP_LABELS: Record<EditJobType, Partial<Record<EditStepKey, string>>> = {
  APPLY_BOOK_EDIT: {
    prepare: "Reading your book",
    snapshot: "Saving a version to undo",
    apply: "Making your changes",
    export: "Rebuilding your book"
  },
  CONTINUE_BOOK: {
    outline: "Planning the new chapters",
    draft: "Writing the new pages",
    save: "Saving the new chapters",
    export: "Rebuilding your book"
  },
  REPLAN_BOOK: {
    revise: "Planning your new book",
    save: "Saving the new plan",
    generate: "Starting the rewrite"
  }
};

/**
 * The milestones each edit job walks, in order.
 *
 * Needed on top of the labels because the app has to be able to draw the list
 * when the job itself carries no steps: while it is still queued, and again
 * after it has finished and handed the rebuild to the compile job.
 */
const STEP_ORDER: Record<EditJobType, EditStepKey[]> = {
  APPLY_BOOK_EDIT: ["prepare", "snapshot", "apply", "export"],
  CONTINUE_BOOK: ["outline", "draft", "save", "export"],
  REPLAN_BOOK: ["revise", "save", "generate"]
};

/** Where an edit job's own progress column tops out (its `export` step). */
const EDIT_PROGRESS_CEILING = 85;

/** Where the COMPILE_EXPORT job's own progress column tops out (its `epub` step). */
const COMPILE_PROGRESS_CEILING = 95;

/**
 * The two bands, end to end.
 *
 * The edit job stops where the rebuild starts: an edit that ran the bar to 99
 * before handing off left nothing for the slowest part of the job, so the bar
 * sat at 99 for as long as the PDF took. 92 is where they meet because that is
 * the flat number `statusProgressPercent` still falls back to for an edit with
 * nothing to report — an edit that has finished its own work and no more.
 * The floor is not zero: a queued job has written nothing yet, and a bar at
 * zero reads as stalled.
 */
const EDIT_BAND = { start: 5, end: 92 } as const;
const REBUILD_BAND = { start: EDIT_BAND.end, end: 99 } as const;

/**
 * A replan gets its own, much narrower band, because it is not an edit to this
 * book — it is the *plan* for a new one, and a whole book still has to be
 * written after it.
 *
 * It reports through this module only because it runs while the project sits at
 * `EDITING`, but it hands straight over to `generationProgress`, whose
 * `PREPARE_BAND` opens the writing at 20. Running a replan up the ordinary edit
 * band would put the bar at 92 and then drop it to 20 the moment the real work
 * started. Ending below 20 is what makes that handover move forwards — the same
 * reason `statusProgressPercent` answers 10 for `PLANNING` and 20 for
 * `PLAN_READY`.
 */
const REPLAN_BAND = { start: 2, end: 18 } as const;

export function serializeEditProgress(status: ProjectStatusResult): MobileProjectStatusDto["editProgress"] {
  if (status.project.status !== "EDITING") {
    return null;
  }
  const job = openEditJob(status);
  if (job) {
    return fromEditJob(job);
  }
  // Nothing is editing, but the book is being rebuilt: either the edit job just
  // handed off, or the reader made the change themselves (a manual edit, an
  // undo, dropping the sources list) and only the recompile runs. Both are the
  // same piece of work to the reader — and the slowest part of it, since it
  // re-renders the PDF — so this keeps reporting rather than dropping the step
  // list and freezing the bar where the edit left it.
  const rebuild = openCompileJob(status);
  return rebuild ? fromRebuild(rebuild, editBehindRebuild(status, rebuild)) : null;
}

function fromEditJob(job: StatusJob): EditProgressDto {
  const type = job.type as EditJobType;
  return {
    percent: editProgressPercent(job),
    detail: liveDetail(job),
    steps: readSteps(job, type)
  };
}

function fromRebuild(compile: StatusJob, finished: StatusJob | undefined): EditProgressDto {
  const rebuildStep: EditStep = { key: "export", label: "Rebuilding your book", status: "active", detail: null };
  const labels = finished ? STEP_LABELS[finished.type as EditJobType] : null;
  const total = finished ? affectedPageCount(finished) : 0;
  return {
    percent: rebuildPercent(compile),
    detail: compilePhrase(activeStepKey(compile)) ?? rebuildStep.label,
    // The edit's own milestones stay on screen, all done, so the list the
    // reader has been watching does not shrink at the last step. A rebuild with
    // no edit job behind it — the reader's own change — has only this step.
    steps: !finished || !labels
      ? [rebuildStep]
      : STEP_ORDER[finished.type as EditJobType].flatMap((key) => {
          const label = labels[key];
          if (!label) {
            return [];
          }
          return key === "export"
            ? [rebuildStep]
            : [{ key, label, status: "done" as const, detail: settledStepDetail(key, total) }];
        })
  };
}

/**
 * The edit this rebuild is finishing, when there is one.
 *
 * `skipFinalReview` is set by exactly one caller: the recompile the API queues
 * for a change the reader made themselves. Those never ran an edit job, so an
 * older completed one sitting in the job list is somebody else's history and
 * must not be dressed up as the steps this rebuild just walked.
 */
function editBehindRebuild(status: ProjectStatusResult, compile: StatusJob): StatusJob | undefined {
  if (jsonRecord(compile.payload).skipFinalReview === true) {
    return undefined;
  }
  return status.project.jobs.find((job) => isRebuildableEditJob(job) && job.status === "COMPLETED");
}

/**
 * The job doing the editing right now.
 *
 * Only ever one: `hasOpenProjectWork` refuses a second edit while one is open,
 * and the partial unique index on `BookEditOperation` backs that up.
 */
function openEditJob(status: ProjectStatusResult): StatusJob | undefined {
  return status.project.jobs.find((job) => isEditJob(job) && isOpen(job));
}

function openCompileJob(status: ProjectStatusResult): StatusJob | undefined {
  return status.project.jobs.find((job) => job.type === "COMPILE_EXPORT" && isOpen(job));
}

/**
 * The step list to draw, whether or not the worker has written one.
 *
 * A queued job has no steps at all — they are stamped on when it starts — and a
 * card that opens as a bare bar tells the reader nothing about what is coming.
 */
function readSteps(job: StatusJob, type: EditJobType): EditStep[] {
  const labels = STEP_LABELS[type];
  if (job.steps.length === 0) {
    return STEP_ORDER[type].flatMap((key, index) => {
      const label = labels[key];
      return label ? [{ key, label, status: index === 0 ? ("active" as const) : ("pending" as const), detail: null }] : [];
    });
  }
  const steps: EditStep[] = [];
  for (const step of job.steps) {
    if (!isEditStepKey(step.key)) {
      continue;
    }
    const label = labels[step.key];
    if (!label) {
      continue;
    }
    steps.push({ key: step.key, label, status: step.status, detail: stepDetail(step.key, step, job) });
  }
  return steps;
}

/**
 * The second line under a step: how much of it is behind us.
 *
 * The counters come from the worker, the words from here. A step that has not
 * started yet says nothing rather than "0 of 7" — a zero reads as a stall.
 */
function stepDetail(key: EditStepKey, step: StatusJob["steps"][number], job: StatusJob): string | null {
  const total = typeof step.total === "number" && step.total > 0 ? step.total : affectedPageCount(job);
  if (total <= 0) {
    return null;
  }
  if (key === "apply" || key === "snapshot") {
    return step.status === "active" && typeof step.done === "number" && step.done > 0
      ? `${step.done} of ${total} pages`
      : settledStepDetail(key, total);
  }
  if (key === "draft") {
    return step.status === "active" && typeof step.done === "number" && step.done > 0
      ? `${step.done} of ${total} new pages`
      : settledStepDetail(key, total);
  }
  return null;
}

function settledStepDetail(key: EditStepKey, total: number): string | null {
  if (total <= 0 || (key !== "apply" && key !== "snapshot" && key !== "draft")) {
    return null;
  }
  const noun = key === "draft" ? "new page" : "page";
  return `${total} ${noun}${total === 1 ? "" : "s"}`;
}

/**
 * What is happening this second, in the reader's words.
 *
 * The page number is the worker's own — it stamps the page it is holding onto
 * the active step — rather than anything inverted back out of the progress
 * column, which would go quietly wrong the moment that loop changed. When the
 * worker has not named one (an older job row mid-upgrade), the phrase falls
 * back to the page *count*, which the payload the API itself wrote guarantees.
 */
export function liveDetail(job: StatusJob): string | null {
  const active = job.steps.find((step) => step.status === "active");
  const activeKey = active?.key;
  const page = typeof active?.pageIndex === "number" ? active.pageIndex : null;
  const pages = affectedPageCount(job);
  if (job.type === "REPLAN_BOOK") {
    switch (activeKey) {
      case "revise":
        return "Planning your new book";
      case "save":
        return "Saving the new plan";
      case "generate":
        return "Starting the rewrite";
      default:
        return "Getting ready to rewrite your book";
    }
  }
  if (job.type === "CONTINUE_BOOK") {
    switch (activeKey) {
      case "outline":
        return "Planning the new chapters";
      case "draft":
        return page === null ? "Writing the new pages" : `Writing page ${page}`;
      case "save":
        return "Saving the new chapters";
      case "export":
        return "Rebuilding your book";
      default:
        return "Getting ready to continue your book";
    }
  }
  switch (activeKey) {
    case "prepare":
      return "Reading your book";
    case "snapshot":
      return "Saving a version you can undo to";
    case "apply":
      return page === null
        ? pages > 0
          ? `Rewriting ${pages} ${pages === 1 ? "page" : "pages"}`
          : "Making your changes"
        : applyPhrase(active?.phase, page);
    case "export":
      return "Rebuilding your book";
    default:
      return "Getting your edit ready";
  }
}

/** Rewriting a page is two model calls and a save; each one is worth naming. */
function applyPhrase(phase: string | undefined, page: number): string {
  switch (phase) {
    case "review":
      return `Reading back page ${page}`;
    case "save":
      return `Saving page ${page}`;
    default:
      return `Rewriting page ${page}`;
  }
}

/**
 * A percent that moves the way the work does.
 *
 * The job's own progress column is the only non-decreasing signal an edit has —
 * there is no page counter to lean on, because the pages being rewritten
 * already exist. It is worth reading now that the worker writes it three times
 * per page rather than once: the same column that used to step is now a climb.
 */
export function editProgressPercent(job: StatusJob): number {
  const stored = Number.isFinite(job.progress) ? Math.max(0, job.progress) : 0;
  const ratio = Math.min(1, stored / EDIT_PROGRESS_CEILING);
  const band = job.type === "REPLAN_BOOK" ? REPLAN_BAND : EDIT_BAND;
  return Math.round(band.start + (band.end - band.start) * ratio);
}

/**
 * The rebuild's band, which starts above where the edit job's own bar stopped.
 *
 * Held apart from `editProgressPercent` so the handover between the two jobs
 * can only ever move the bar forwards.
 */
export function rebuildPercent(compile: StatusJob): number {
  const stored = Number.isFinite(compile.progress) ? Math.max(0, compile.progress) : 0;
  const ratio = Math.min(1, stored / COMPILE_PROGRESS_CEILING);
  return Math.round(REBUILD_BAND.start + (REBUILD_BAND.end - REBUILD_BAND.start) * ratio);
}

function affectedPageCount(job: StatusJob): number {
  const indexes = jsonRecord(job.payload).affectedPageIndexes;
  return Array.isArray(indexes) ? indexes.filter((index) => typeof index === "number").length : 0;
}

function activeStepKey(job: StatusJob): string | undefined {
  return job.steps.find((step) => step.status === "active")?.key;
}

function isEditJob(job: StatusJob): boolean {
  return isRebuildableEditJob(job) || job.type === "REPLAN_BOOK";
}

/**
 * The edit jobs that finish by handing a rebuild to `COMPILE_EXPORT`.
 *
 * A replan is deliberately not one of them: it hands off to `GENERATE_BOOK` and
 * the project leaves `EDITING` at the same moment, so it is never the edit
 * behind an open compile. Letting it match would mean that a *later* recompile
 * of the revised book — a heading or sources toggle, which writes no edit job of
 * its own — found the replan sitting completed in the job list and dressed the
 * rebuild up as "Planning your new book".
 */
function isRebuildableEditJob(job: StatusJob): boolean {
  return job.type === "APPLY_BOOK_EDIT" || job.type === "CONTINUE_BOOK";
}

function isOpen(job: StatusJob): boolean {
  return job.status === "QUEUED" || job.status === "ACTIVE";
}

function isEditStepKey(key: string): key is EditStepKey {
  return (
    key === "prepare" ||
    key === "snapshot" ||
    key === "apply" ||
    key === "export" ||
    key === "outline" ||
    key === "draft" ||
    key === "save" ||
    key === "revise" ||
    key === "generate"
  );
}
