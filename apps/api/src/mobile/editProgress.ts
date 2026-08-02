import type { MobileProjectStatusDto, ProjectStatusResult } from "./dto.js";
import { jsonRecord } from "./support.js";

/**
 * Live progress for an edit to a finished book, the way `generationProgress`
 * already reports writing one.
 *
 * The worker writes real step progress while an edit runs — which pages are
 * being snapshotted, which are being rewritten, when the exports are rebuilt.
 * Until this module existed none of it reached the app: the status serializer
 * pinned `EDITING` at a constant 92% with the constant phrase "Editing your
 * book.", so the chat's progress card sat frozen for the whole job.
 *
 * Same rules as its sibling: read the *step keys* the worker sets and map them
 * through a curated table, never forward `GenerationJob.message`, and take
 * every number from something the worker already made non-decreasing.
 */

type EditProgressDto = NonNullable<MobileProjectStatusDto["editProgress"]>;
type EditStep = EditProgressDto["steps"][number];
type EditStepKey = EditStep["key"];
type StatusJob = ProjectStatusResult["project"]["jobs"][number];

/**
 * The reader-facing name for each step the two edit jobs report.
 *
 * Keyed by job type because `export` means the same thing in both but the
 * earlier steps do not, and because an unknown key must be droppable — a step
 * template can gain entries in the worker before this table knows about them.
 */
const STEP_LABELS: Record<"APPLY_BOOK_EDIT" | "CONTINUE_BOOK", Record<string, string>> = {
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
  }
};

/** Where an edit job's own progress column tops out (its `export` step). */
const EDIT_PROGRESS_CEILING = 85;

/** A queued job has written nothing yet, and a bar at zero reads as stalled. */
const EDIT_PROGRESS_FLOOR = 5;

export function serializeEditProgress(status: ProjectStatusResult): MobileProjectStatusDto["editProgress"] {
  if (status.project.status !== "EDITING") {
    return null;
  }
  const job = openEditJob(status);
  if (!job) {
    return null;
  }

  const labels = STEP_LABELS[job.type as keyof typeof STEP_LABELS];
  const steps: EditStep[] = [];
  for (const step of job.steps) {
    const label = labels[step.key];
    if (!label || !isEditStepKey(step.key)) {
      continue;
    }
    steps.push({ key: step.key, label, status: step.status, detail: stepDetail(step.key, job) });
  }

  return {
    percent: editProgressPercent(job),
    detail: liveDetail(job),
    steps
  };
}

/**
 * The job doing the editing right now.
 *
 * Only ever one: `hasOpenProjectWork` refuses a second edit while one is open,
 * and the partial unique index on `BookEditOperation` backs that up.
 */
function openEditJob(status: ProjectStatusResult): StatusJob | undefined {
  return status.project.jobs.find(
    (job) => (job.type === "APPLY_BOOK_EDIT" || job.type === "CONTINUE_BOOK") && (job.status === "QUEUED" || job.status === "ACTIVE")
  );
}

function stepDetail(key: EditStepKey, job: StatusJob): string | null {
  if (key !== "apply" && key !== "snapshot") {
    return null;
  }
  const pages = affectedPageCount(job);
  return pages > 0 ? `${pages} ${pages === 1 ? "page" : "pages"}` : null;
}

/**
 * What is happening this second, in the reader's words.
 *
 * The page *count* comes from the payload the API itself wrote, so it is
 * certainly true. There is deliberately no page *number*: the only way to get
 * one would be to invert the worker's progress column back into a loop index,
 * which would go quietly wrong the moment that loop changed.
 */
export function liveDetail(job: StatusJob): string | null {
  const activeKey = job.steps.find((step) => step.status === "active")?.key;
  const pages = affectedPageCount(job);
  if (job.type === "CONTINUE_BOOK") {
    switch (activeKey) {
      case "outline":
        return "Planning the new chapters";
      case "draft":
        return "Writing the new pages";
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
      return pages > 0 ? `Rewriting ${pages} ${pages === 1 ? "page" : "pages"}` : "Making your changes";
    case "export":
      return "Rebuilding your book";
    default:
      return "Getting your edit ready";
  }
}

/**
 * A percent that moves the way the work does.
 *
 * The job's own progress column is the only non-decreasing signal an edit has —
 * there is no page counter to lean on, because the pages being rewritten
 * already exist. Scaled rather than passed through so the bar keeps climbing
 * through the export step and still stops short of 100 until the project
 * itself settles.
 */
export function editProgressPercent(job: StatusJob): number {
  const stored = Number.isFinite(job.progress) ? Math.max(0, job.progress) : 0;
  const ratio = Math.min(1, stored / EDIT_PROGRESS_CEILING);
  return Math.min(99, Math.max(EDIT_PROGRESS_FLOOR, Math.round(EDIT_PROGRESS_FLOOR + (99 - EDIT_PROGRESS_FLOOR) * ratio)));
}

function affectedPageCount(job: StatusJob): number {
  const indexes = jsonRecord(job.payload).affectedPageIndexes;
  return Array.isArray(indexes) ? indexes.filter((index) => typeof index === "number").length : 0;
}

function isEditStepKey(key: string): key is EditStepKey {
  return (
    key === "prepare" ||
    key === "snapshot" ||
    key === "apply" ||
    key === "export" ||
    key === "outline" ||
    key === "draft" ||
    key === "save"
  );
}
