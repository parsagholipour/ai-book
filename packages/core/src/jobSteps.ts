import { type GenerationJobType } from "./jobDispatch.js";

export type JobStepStatus = "pending" | "active" | "done" | "failed";

/**
 * One milestone of a running job.
 *
 * `label` is worker vocabulary and never reaches a reader — the mobile
 * serializers map `key` through their own copy table instead. The optional
 * fields below are what lets that rule hold while the app still shows real
 * detail: they are numbers and enum-ish tokens rather than prose, so the API
 * can spend them on reader-facing text ("3 of 7 pages", "Checking page 12")
 * without the worker ever choosing the words.
 */
export type JobStep = {
  key: string;
  label: string;
  status: JobStepStatus;
  /** Units of work finished inside this step, when it counts units at all. */
  done?: number;
  /** How many units this step will finish in total. */
  total?: number;
  /** Which part of the current unit is running, e.g. "draft" | "review" | "save". */
  phase?: string;
  /** The book page the current unit is working on. */
  pageIndex?: number;
};

/** One authored milestone, before a run gives it a status. */
export type JobStepTemplate = { key: string; label: string };

/**
 * The milestones every job type reports, in order.
 *
 * Exhaustive over `GenerationJobType` by type, which is the point: this table
 * used to live in the worker as a `Record<string, …>` keyed by the kebab BullMQ
 * name, hand-mirrored in `apps/web/src/jobsDisplay.ts` as a second
 * `Record<string, …>` keyed by the SCREAMING type. Neither was exhaustive and
 * the mirror had already drifted — `GENERATE_CHARACTER_PORTRAIT` was missing
 * from the console's copy, which is a silently empty progress list rather than
 * an error. Keyed by type here so a new entry in `jobNames` is a compile error
 * until its steps are written down; the worker translates its `job.name` back
 * through `generationJobTypeForWorkerName`.
 *
 * `key` is what handlers pass to `advanceJobStep` and what the mobile
 * serializers map through their own copy table; `label` is worker vocabulary
 * that only ever reaches the operator console.
 */
export const JOB_STEP_TEMPLATES: Record<GenerationJobType, readonly JobStepTemplate[]> = {
  PLAN_BOOK: [
    { key: "research", label: "Research" },
    { key: "plan", label: "Create plan" },
    { key: "save", label: "Save plan" }
  ],
  REVISE_PLAN: [
    { key: "revise", label: "Revise plan" },
    { key: "save", label: "Save revision" }
  ],
  GENERATE_BOOK: [
    { key: "briefs", label: "Prepare book" },
    { key: "setup", label: "Create pages" },
    { key: "enqueue", label: "Queue follow-ups" }
  ],
  GENERATE_PAGE: [
    { key: "prepare", label: "Prepare context" },
    { key: "draft", label: "Draft page" },
    { key: "qa", label: "Quality review" },
    { key: "revise", label: "Revise draft" },
    { key: "save", label: "Save page" }
  ],
  GENERATE_IMAGE: [
    { key: "prompt", label: "Build prompt" },
    { key: "render", label: "Render image" },
    { key: "store", label: "Store asset" }
  ],
  COMPILE_EXPORT: [
    { key: "qa", label: "Final review" },
    { key: "compile", label: "Compile markdown" },
    { key: "write", label: "Write Markdown" },
    { key: "pdf", label: "Generate PDF" },
    { key: "epub", label: "Generate EPUB" }
  ],
  APPLY_BOOK_EDIT: [
    { key: "prepare", label: "Prepare edit" },
    { key: "snapshot", label: "Snapshot pages" },
    { key: "apply", label: "Apply edits" },
    { key: "export", label: "Refresh exports" }
  ],
  REPLAN_BOOK: [
    { key: "revise", label: "Revise plan" },
    { key: "save", label: "Save approved plan" },
    { key: "generate", label: "Queue regeneration" }
  ],
  PREPARE_CHARACTER_CANDIDATES: [
    { key: "detect", label: "Detect characters" },
    { key: "save", label: "Save candidates" }
  ],
  BUILD_CHARACTER_PERSONA: [
    { key: "persona", label: "Build persona" },
    { key: "portrait", label: "Create profile picture" },
    { key: "save", label: "Save character" }
  ],
  IMPORT_BOOK: [
    { key: "read", label: "Read manuscript" },
    { key: "segment", label: "Split into chapters" },
    { key: "analyze", label: "Learn writing style" },
    { key: "save", label: "Save your book" }
  ],
  CONTINUE_BOOK: [
    { key: "outline", label: "Outline new chapters" },
    { key: "draft", label: "Write new pages" },
    { key: "save", label: "Save chapters" },
    { key: "export", label: "Refresh exports" }
  ],
  GENERATE_AUDIOBOOK: [
    { key: "prepare", label: "Prepare narration" },
    { key: "synthesize", label: "Narrate chapters" },
    { key: "finalize", label: "Finish audiobook" }
  ],
  // Account-scoped rather than project-scoped — the one job whose
  // `GenerationJob.projectId` is null — so this row never appears in a
  // project's progress UI. The steps are still written down and still real:
  // `handlers/characterPortrait.ts` advances through exactly these three keys,
  // and the library character sheet reads the row directly.
  GENERATE_CHARACTER_PORTRAIT: [
    { key: "prompt", label: "Prepare portrait" },
    { key: "render", label: "Draw portrait" },
    { key: "store", label: "Save portrait" }
  ]
};
