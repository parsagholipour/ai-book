import type { GenerationJobType } from "./jobDispatch.js";
import {
  exportPublicationProjectStatusFromPayload,
  isCoverRetypesetPayload,
  isRevisionOwnedCoverPayload,
  skipsFinalReview
} from "./jobScope.js";

/*
 * Which BullMQ queue a job waits in, and where in it.
 *
 * The worker used to consume one queue at one concurrency — 1 in production —
 * so a composed-chapter book (one `generate-book` job, 9–93 minutes measured)
 * held the whole product: a plan, a chat edit, a portrait, a writing assist all
 * waited behind it, and behind every other book queued before them. Now there
 * are two lanes, each its own queue and its own `Worker` in the one process
 * (`apps/worker/src/index.ts`), sized separately (`workerLaneConcurrency`):
 *
 * - **long** — the minutes-long and bulk work: a book's run, its pages and
 *   pictures, the compile that ends a generation, narration, imports. It keeps
 *   the old queue's name, `book-maker`, so a job the previous release left in
 *   Redis at deploy time is still consumed by a worker of this one.
 * - **interactive** — what a reader is waiting on with the app open: planning,
 *   edits, assists, portraits, personas, and the compiles that only re-typeset
 *   a book that already exists.
 *
 * Inside the long lane, work already under way goes first. A job that *starts*
 * long work (a book run, an import, a narration, a continuation) is added with
 * `LONG_LANE_START_PRIORITY`; everything that continues it (pages, pictures, the
 * generation's own compile) is added with none, and BullMQ hands out unprioritized
 * jobs before any prioritized one. Without that, book A's compile was queued
 * behind books B–E's whole runs the moment A's writing finished, so its reader
 * waited five books instead of one; with it, the lane finishes one book before
 * it starts the next, which is also what makes "N books ahead of yours" a number
 * worth showing (`booksAheadInLongLane`).
 *
 * Both enqueue sides — the API's `dispatchGenerationJob` and the worker's
 * `dispatchWorkerGenerationJob` — are the only two `queue.add` calls in the repo,
 * and both route by `generationJobPlacement`. Placement depends only on the
 * durable row's type and payload, so the two sides cannot put one row in two
 * lanes, and BullMQ's own job-id dedupe keeps holding within a lane.
 */

/** The long lane keeps the original queue's name, which is what drains the previous release. */
export const LONG_JOB_QUEUE = "book-maker";
export const INTERACTIVE_JOB_QUEUE = "book-maker-interactive";
export const GENERATION_JOB_QUEUES = [LONG_JOB_QUEUE, INTERACTIVE_JOB_QUEUE] as const;
export type GenerationJobQueueName = (typeof GENERATION_JOB_QUEUES)[number];

export type JobLane = "long" | "interactive";

/** A long job either starts a unit of long work or continues one already started. */
export type JobLaneClass = "interactive" | "long-start" | "long-continuation";

/** Any positive BullMQ priority sorts after every unprioritized job; all starts share one, so they stay FIFO. */
export const LONG_LANE_START_PRIORITY = 1;

type JobLaneRule = JobLaneClass | ((payload: unknown) => JobLaneClass);

/**
 * A compile is two jobs wearing one name. The one that ends a generation runs
 * the final review and its repair over the whole book — minutes of model calls
 * — and continues that book's long work. Every other compile is a reader
 * waiting on a book that already exists: an edit's recompile (EDITING), a
 * presentation reprint, an export repair, a Studio publish or an import
 * (COMPLETE / REVIEW_REQUIRED), and none of those may wait behind someone
 * else's 90-minute book. A structural edit's compile runs the final review too
 * and still takes the interactive lane, because its reader is in the chat.
 */
function compileLane(payload: unknown): JobLaneClass {
  if (skipsFinalReview(payload)) return "interactive";
  const expected = exportPublicationProjectStatusFromPayload(payload);
  return expected === null || expected === "GENERATING" ? "long-continuation" : "interactive";
}

/**
 * Pictures a generation draws are bulk and continue that book. A cover queued
 * for one revision of a book that already exists — a Studio publish, a cover
 * change — is one render its author is waiting on, and a re-typeset makes no
 * model call at all.
 */
function imageLane(payload: unknown): JobLaneClass {
  return isRevisionOwnedCoverPayload(payload) || isCoverRetypesetPayload(payload)
    ? "interactive"
    : "long-continuation";
}

/**
 * An edit that rewrites more pages than this runs on the long lane.
 *
 * The text fork of `apply-book-edit` drafts, reviews and saves its pages one
 * after another (`textEditCandidates.ts`), and a whole-book request has no page
 * cap: on a 200-page book it held one of the interactive lane's two slots for
 * tens of minutes, and every reader's plan queued behind it (pre-launch review,
 * 2026-10-13). Above the free tier's 30-page books, so a free book's
 * whole-book edit never waits behind someone's book run. Unmeasured per page;
 * move it with a measurement, not a guess.
 */
export const LONG_LANE_EDIT_PAGE_THRESHOLD = 40;

/**
 * How many pages an `apply-book-edit` payload has a model rewrite: its target
 * pages, or none when the Apply verified every one as an exact find/replace
 * (`mode: "exact"`, which the worker may never turn into a rewrite). Read off
 * the payload the enqueue wrote and nothing rewrites, so every reader of the
 * row answers the same.
 */
export function applyBookEditRewritePageCount(payload: unknown): number {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return 0;
  const record = payload as Record<string, unknown>;
  if (record.mode === "exact" || !Array.isArray(record.affectedPageIndexes)) return 0;
  return new Set(record.affectedPageIndexes.filter((index) => Number.isInteger(index))).size;
}

/**
 * An edit is what a reader waits on in the chat — until it is a book's worth of
 * model calls. Then it *starts* long work the way a continuation does, and waits
 * its turn behind the books already under way. The structural and image forks
 * never name more than a few pages (`MAX_INSERTED_PAGES`, one picture), so they
 * stay interactive by the same count.
 */
function applyBookEditLane(payload: unknown): JobLaneClass {
  return applyBookEditRewritePageCount(payload) > LONG_LANE_EDIT_PAGE_THRESHOLD ? "long-start" : "interactive";
}

/**
 * Every job type's lane, exhaustively over `GenerationJobType`: a new entry in
 * `jobNames` is a compile error until someone decides whether a reader is
 * waiting on it. Answer for the row as it is queued, not for the happy path.
 */
export const JOB_LANES: Readonly<Record<GenerationJobType, JobLaneRule>> = Object.freeze({
  /** The reader watches the plan appear after Build: one planner call. */
  PLAN_BOOK: "interactive",
  /** A reader asked for a different plan and is waiting to approve it. */
  REVISE_PLAN: "interactive",
  /** The book run itself — composed chapters run inside this one job. */
  GENERATE_BOOK: "long-start",
  /** One page of a run that is already under way. */
  GENERATE_PAGE: "long-continuation",
  GENERATE_IMAGE: imageLane,
  COMPILE_EXPORT: compileLane,
  /** A chat edit the reader just applied: interactive, unless it rewrites a book's worth of pages. */
  APPLY_BOOK_EDIT: applyBookEditLane,
  /** Stages the replacement plan; the regeneration it hands off to is a GENERATE_BOOK. */
  REPLAN_BOOK: "interactive",
  /** One short model call over a finished book's cast. */
  PREPARE_CHARACTER_CANDIDATES: "interactive",
  /** One short model call; the reader is waiting to talk to the character. */
  BUILD_CHARACTER_PERSONA: "interactive",
  /** Reads, splits and embeds a whole manuscript. */
  IMPORT_BOOK: "long-start",
  /** Drafts and reviews new chapters onto a finished book. */
  CONTINUE_BOOK: "long-start",
  /** Dozens of speech calls in a row. */
  GENERATE_AUDIOBOOK: "long-start",
  /** One drawing the reader asked for on the character screen. */
  GENERATE_CHARACTER_PORTRAIT: "interactive",
  /** A Writing Studio suggestion the author is waiting to apply. */
  WRITING_ASSIST: "interactive"
});

/** Null for a type `jobNames` does not know — such a row is never dispatched anyway. */
export function jobLaneClass(type: string, payload: unknown): JobLaneClass | null {
  const rule = (JOB_LANES as Record<string, JobLaneRule | undefined>)[type];
  if (rule === undefined) return null;
  return typeof rule === "function" ? rule(payload) : rule;
}

export function laneOfClass(laneClass: JobLaneClass): JobLane {
  return laneClass === "interactive" ? "interactive" : "long";
}

export function queueNameForLane(lane: JobLane): GenerationJobQueueName {
  return lane === "long" ? LONG_JOB_QUEUE : INTERACTIVE_JOB_QUEUE;
}

export type GenerationJobPlacement = {
  lane: JobLane;
  queueName: GenerationJobQueueName;
  /** Present only for a long-lane start; absent means "before every start". */
  priority?: number;
};

/** Where a durable row is added. Both enqueue sides call this and nothing else decides it. */
export function generationJobPlacement(type: string, payload: unknown): GenerationJobPlacement {
  // An unknown type never reaches here (the job-name lookup refuses it first);
  // the long lane is the old behaviour if one ever does.
  const laneClass = jobLaneClass(type, payload) ?? "long-start";
  const lane = laneOfClass(laneClass);
  return {
    lane,
    queueName: queueNameForLane(lane),
    ...(laneClass === "long-start" ? { priority: LONG_LANE_START_PRIORITY } : {})
  };
}

/** Types a row of which can sit in the long lane — the set a database read filters on. */
export const LONG_LANE_CAPABLE_JOB_TYPES: readonly GenerationJobType[] = Object.freeze(
  (Object.entries(JOB_LANES) as Array<[GenerationJobType, JobLaneRule]>)
    .filter(([, rule]) => rule !== "interactive")
    .map(([type]) => type)
);

/** Types whose lane depends on the payload, so a read that classifies them must select it. */
export const PAYLOAD_LANED_JOB_TYPES: readonly GenerationJobType[] = Object.freeze(
  (Object.entries(JOB_LANES) as Array<[GenerationJobType, JobLaneRule]>)
    .filter(([, rule]) => typeof rule === "function")
    .map(([type]) => type)
);

/**
 * How many of each lane's jobs one worker process runs at once.
 *
 * The long lane defaults to `max(MAX_PARALLEL_PAGE_JOBS, MAX_PARALLEL_IMAGE_JOBS)`
 * — exactly the single queue's old concurrency — because those two settings
 * size the page and picture waves a book fans out, and a lane narrower than
 * the wave would queue what they say may run together. Production sets it
 * outright (docker-compose.production.yml).
 */
export function workerLaneConcurrency(config: {
  MAX_PARALLEL_PAGE_JOBS: number;
  MAX_PARALLEL_IMAGE_JOBS: number;
  WORKER_LONG_CONCURRENCY?: number | undefined;
  WORKER_INTERACTIVE_CONCURRENCY: number;
}): Record<JobLane, number> {
  return {
    long: config.WORKER_LONG_CONCURRENCY ?? Math.max(config.MAX_PARALLEL_PAGE_JOBS, config.MAX_PARALLEL_IMAGE_JOBS),
    interactive: config.WORKER_INTERACTIVE_CONCURRENCY
  };
}

/*
 * How long a finished BullMQ job stays in Redis.
 *
 * Nothing was ever removed, and production Redis runs `--maxmemory 256mb` with
 * `noeviction`, so it would eventually refuse every write — every enqueue, every
 * lock renewal. Nothing reads a finished job back: the GenerationJob row is the
 * record (status, error, steps), the run log is the debugging artifact, and the
 * three places that look a Bull job up by id (`prepareDurableJobId`,
 * `requeueGenerationJob`, the stop) treat a missing job exactly as a finished
 * one — they would remove it anyway. The lost-delivery sweep counts `missing`
 * and `failed` alike, and a completed Bull job always sits under a terminal row
 * the sweep never selects. Dedupe is the row's `dedupeKey` and the
 * QUEUED-without-`bullJobId` claim, never the Bull id; that id only collapses
 * an add that races a live copy, and a copy kept for hours still does that. A
 * late add after the first delivery left Redis was always possible (a failed
 * job is removed before a requeue) and is refused by `markActive` on the
 * COMPLETED row. Age first, count as the memory bound: the count is per queue.
 */
export const GENERATION_JOB_RETENTION = Object.freeze({
  removeOnComplete: Object.freeze({ age: 24 * 60 * 60, count: 1_000 }),
  removeOnFail: Object.freeze({ age: 7 * 24 * 60 * 60, count: 2_000 })
});

/**
 * The part of a BullMQ queue a lookup across lanes reads. The handles stay each
 * side's own (`apps/api/src/queue.ts`, `apps/worker/src/runtime/queue.ts`); what
 * lives here is only the rule for which copy of a job id counts.
 */
export type LaneJobLookup = {
  getJob(id: string): Promise<LaneJob | undefined | null>;
};

export type LaneJob = { getState(): Promise<string>; remove(): Promise<void>; failedReason?: string };

/** States in which a Bull job will still run, or is running. */
const LIVE_BULL_STATES = new Set(["active", "waiting", "delayed", "prioritized", "waiting-children"]);

export function isLiveBullState(state: string): boolean {
  return LIVE_BULL_STATES.has(state);
}

/**
 * Every lane's copy of one job id. A row is one Bull id (`jobId` is the row's
 * id), but a requeue can place it in a different lane than its last delivery —
 * a payload rewrite, or a row the previous release queued in `book-maker` — so
 * a lookup that read one lane could miss the copy still running in the other.
 */
async function laneJobCopies(lanes: readonly LaneJobLookup[], id: string) {
  const copies: Array<{ job: LaneJob; state: string }> = [];
  for (const lane of lanes) {
    const job = await lane.getJob(id);
    if (job) copies.push({ job, state: await job.getState() });
  }
  return copies;
}

/** The copy a sweep should judge: a live one if any lane has it, else a failed one, else any; null when no lane has it. */
export async function laneJobForSweep(lanes: readonly LaneJobLookup[], id: string): Promise<LaneJob | null> {
  const copies = await laneJobCopies(lanes, id);
  const pick =
    copies.find((copy) => isLiveBullState(copy.state)) ?? copies.find((copy) => copy.state === "failed") ?? copies[0];
  return pick?.job ?? null;
}

/** Whether any lane holds this id in the `active` state. */
export async function isLaneJobActive(lanes: readonly LaneJobLookup[], id: string): Promise<boolean> {
  return (await laneJobCopies(lanes, id)).some((copy) => copy.state === "active");
}

/**
 * Makes a job id addable: false while any lane still holds a live copy (that
 * push waits for reconciliation, or one row would run in two lanes at once);
 * otherwise every finished copy is removed first, because an add over a
 * finished copy in its own lane is silently a no-op that leaves the row
 * "dispatched" with nothing in Redis to run it.
 */
export async function clearLaneJobIdForAdd(lanes: readonly LaneJobLookup[], id: string): Promise<boolean> {
  const copies = await laneJobCopies(lanes, id);
  if (copies.some((copy) => isLiveBullState(copy.state))) return false;
  for (const copy of copies) {
    try {
      await copy.job.remove();
    } catch {
      // A remove racing another dispatcher is fine; the add says if the id is still taken.
    }
  }
  return true;
}

/**
 * Removes every copy of a job id that is not running right now, in any lane,
 * and answers how many it removed — the stop's and the requeue's cleanup. An
 * active copy is its delivery's to finish: its own stale check refuses it.
 */
export async function removeIdleLaneJobs(lanes: readonly LaneJobLookup[], id: string): Promise<number> {
  let removed = 0;
  for (const copy of await laneJobCopies(lanes, id)) {
    if (copy.state === "active") continue;
    try {
      await copy.job.remove();
      removed += 1;
    } catch {
      // A worker may have claimed the job between the state check and remove.
    }
  }
  return removed;
}

export type LongLaneRow = {
  projectId: string | null;
  status: string;
  laneClass: JobLaneClass;
  createdAt: Date;
};

/**
 * How many other books the long lane will run before this project's waiting
 * work, or null when it has none waiting (or is already running).
 *
 * It follows the order BullMQ hands the lane out in: every continuation (FIFO)
 * before any start (FIFO), and whatever is running now first of all. So a book
 * whose oldest waiting job is a start is behind every book with work running
 * or continuing, and behind the starts queued before it; one whose oldest
 * waiting job continues its own run is behind what is running and the
 * continuations queued before it. Counted in books, not jobs: a book ahead of
 * yours is one book however many pages it has left.
 */
export function booksAheadInLongLane(rows: readonly LongLaneRow[], projectId: string): number | null {
  const open = rows.filter((row) => row.laneClass !== "interactive" && (row.status === "QUEUED" || row.status === "ACTIVE"));
  const own = open.filter((row) => row.projectId === projectId);
  if (own.length === 0 || own.some((row) => row.status === "ACTIVE")) return null;
  const waiting = own.reduce((oldest, row) => (row.createdAt < oldest.createdAt ? row : oldest));
  const ahead = new Set<string>();
  for (const row of open) {
    if (!row.projectId || row.projectId === projectId) continue;
    const before =
      row.status === "ACTIVE" ||
      (row.laneClass === "long-continuation" && (waiting.laneClass === "long-start" || row.createdAt < waiting.createdAt)) ||
      (row.laneClass === "long-start" && waiting.laneClass === "long-start" && row.createdAt < waiting.createdAt);
    if (before) ahead.add(row.projectId);
  }
  return ahead.size;
}
