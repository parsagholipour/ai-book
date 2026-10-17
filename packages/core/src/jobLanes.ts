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
 * are five lanes, each its own queue and its own `Worker` in the one process
 * (`apps/worker/src/runtime/laneWorkers.ts`), sized separately
 * (`workerLaneConcurrency`):
 *
 * - **long** — a book's text: its run, its pages, narration, imports,
 *   continuations. It keeps the old queue's name, `book-maker`, so a job the
 *   previous release left in Redis at deploy time is still consumed by a worker
 *   of this one.
 * - **images** — a generation's pictures and its cover. They were long-lane
 *   work until 2026-10-15, and at the long lane's production concurrency of one
 *   that meant a book's pictures could not start until its text job let go of
 *   the lane, then drew one at a time (7–10 s each), and another reader's book
 *   waited behind all of it. A picture is a provider call, a few MB of bytes, a
 *   sharp re-encode and a put: network-bound and light, so they run several at
 *   once beside the text.
 * - **compile** — the compile that ends a generation: the memory-heavy job,
 *   a few at a time. It left the long lane with the pictures, because once they
 *   draw elsewhere the long lane goes idle while a book's last pictures land,
 *   the next book's run takes it, and this book's compile — queued by the last
 *   picture — would wait behind that whole run (9–93 minutes). In a lane of its
 *   own it waits only for another book's compile, and the next book's text runs
 *   beside it.
 * - **interactive** — what a reader is waiting on with the app open: planning,
 *   edits, assists, portraits, personas, a revision's cover, and the compiles
 *   that only re-typeset a book that already exists.
 * - **background** — work nobody is waiting on that is not book work either:
 *   the speculative composition prep a plan queues while its reader reads it.
 *   Minutes of provider calls over a plan held in memory, so several run at
 *   once, and never in a slot a reader's plan or edit waits for. Its outage is
 *   an operator alert, never a readiness failure (`apps/worker/CLAUDE.md`).
 *
 * Inside the long lane, work already under way goes first. A job that *starts*
 * long work (a book run, an import, a narration, a continuation) is added with
 * `LONG_LANE_START_PRIORITY`; everything that continues it (its pages) is added
 * with none, and BullMQ hands out unprioritized jobs before any prioritized one.
 * Without that, book A's compile was queued behind books B–E's whole runs the
 * moment A's writing finished, so its reader waited five books instead of one;
 * with it, the lane finishes one book's text before it starts the next, which is
 * also what makes "N books ahead of yours" a number worth showing
 * (`booksAheadInLongLane`). Pictures and the generation's compile still
 * *continue* a book (`JobLaneClass`), which is what the per-account share
 * counts; they simply wait in lanes of their own.
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
/**
 * Only a worker of this release or later consumes the two below — a rollback
 * past them waits for both to empty (docs/deployment.md, "Job lanes"). An
 * older API beside this worker is safe, because this worker still consumes
 * every queue the older one adds to; an older worker beside this API is not,
 * and the deploy never runs that pair (the worker drains first, and the new
 * API and worker start together).
 */
export const IMAGE_JOB_QUEUE = "book-maker-images";
export const COMPILE_JOB_QUEUE = "book-maker-compile";
/**
 * The same holds for this one, a release later. What waits in it is
 * speculative and unbilled, so a rollback past it need not wait for it.
 */
export const BACKGROUND_JOB_QUEUE = "book-maker-background";
/** Every lane's queue, in `JOB_LANE_NAMES` order — the heartbeat keys and the healthcheck read them in it. */
export const GENERATION_JOB_QUEUES = [
  LONG_JOB_QUEUE,
  INTERACTIVE_JOB_QUEUE,
  IMAGE_JOB_QUEUE,
  COMPILE_JOB_QUEUE,
  BACKGROUND_JOB_QUEUE
] as const;
export type GenerationJobQueueName = (typeof GENERATION_JOB_QUEUES)[number];

export const JOB_LANE_NAMES = ["long", "interactive", "images", "compile", "background"] as const;
export type JobLane = (typeof JOB_LANE_NAMES)[number];

const LANE_QUEUES: Readonly<Record<JobLane, GenerationJobQueueName>> = Object.freeze({
  long: LONG_JOB_QUEUE,
  interactive: INTERACTIVE_JOB_QUEUE,
  images: IMAGE_JOB_QUEUE,
  compile: COMPILE_JOB_QUEUE,
  background: BACKGROUND_JOB_QUEUE
});

/**
 * Where a row waits and what it is to the book. A long job either starts a
 * unit of long work or continues one already started; a generation's pictures
 * (`image`) and its own compile (`compile`) continue that book too, in lanes
 * of their own. Everything but `interactive` and `background` is a book being made.
 */
export type JobLaneClass = "interactive" | "background" | "long-start" | "long-continuation" | "image" | "compile";

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
 * and still takes the interactive lane, because its reader is in the chat. The
 * generation's own compile takes the compile lane: it is the memory-heavy job,
 * and in the long lane it would queue behind the next book.
 */
function compileLane(payload: unknown): JobLaneClass {
  if (skipsFinalReview(payload)) return "interactive";
  const expected = exportPublicationProjectStatusFromPayload(payload);
  return expected === null || expected === "GENERATING" ? "compile" : "interactive";
}

/**
 * Pictures a generation draws — its pages' and its cover — are bulk and
 * continue that book, in the image lane, several at once. A cover queued
 * for one revision of a book that already exists — a Studio publish, a cover
 * change — is one render its author is waiting on, and a re-typeset makes no
 * model call at all.
 */
function imageLane(payload: unknown): JobLaneClass {
  return isRevisionOwnedCoverPayload(payload) || isCoverRetypesetPayload(payload) ? "interactive" : "image";
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
  /**
   * One page of a run that is already under way. It stays with the run rather
   * than moving beside the pictures: a story's pages are drafted one after
   * another anyway (`parallelPageWaveSize`), so a lane of their own would buy
   * this book nothing and only let the next book's text start beside it.
   */
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
  WRITING_ASSIST: "interactive",
  /**
   * Nobody is waiting on it — it plans a composed book's stance, episodes and
   * forms while its reader reads the plan — but it is not book work either:
   * no charge, no slot in the per-account share, and the long lane would put
   * it behind whole books. About 90 s of provider calls, and a burst of plans
   * queues one each, so it gets a lane of its own, several at once, where it
   * holds no slot a reader's plan or edit waits for.
   */
  PREPARE_COMPOSITION: "background"
});

/** Null for a type `jobNames` does not know — such a row is never dispatched anyway. */
export function jobLaneClass(type: string, payload: unknown): JobLaneClass | null {
  const rule = (JOB_LANES as Record<string, JobLaneRule | undefined>)[type];
  if (rule === undefined) return null;
  return typeof rule === "function" ? rule(payload) : rule;
}

export function laneOfClass(laneClass: JobLaneClass): JobLane {
  switch (laneClass) {
    case "interactive":
      return "interactive";
    case "background":
      return "background";
    case "image":
      return "images";
    case "compile":
      return "compile";
    case "long-start":
    case "long-continuation":
      return "long";
  }
}

/** Whether a row is part of a book being made — what the per-account share counts. */
export function isBookWork(laneClass: JobLaneClass): boolean {
  return laneClass !== "interactive" && laneClass !== "background";
}

export function queueNameForLane(lane: JobLane): GenerationJobQueueName {
  return LANE_QUEUES[lane];
}

export type GenerationJobPlacement = {
  lane: JobLane;
  queueName: GenerationJobQueueName;
  /** Present only for a long-lane start; absent means "before every prioritized job". */
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

/**
 * Types a row of which can be book work (`isBookWork`) — in the long, image or
 * compile lane — and so the set a database read of the share or the line filters on.
 */
export const BOOK_WORK_JOB_TYPES: readonly GenerationJobType[] = Object.freeze(
  (Object.entries(JOB_LANES) as Array<[GenerationJobType, JobLaneRule]>)
    .filter(([, rule]) => typeof rule === "function" || isBookWork(rule))
    .map(([type]) => type)
);

/** Types whose lane depends on the payload, so a read that classifies them must select it. */
export const PAYLOAD_LANED_JOB_TYPES: readonly GenerationJobType[] = Object.freeze(
  (Object.entries(JOB_LANES) as Array<[GenerationJobType, JobLaneRule]>)
    .filter(([, rule]) => typeof rule === "function")
    .map(([type]) => type)
);

/**
 * The compile lane runs one generation compile at a time unless told otherwise:
 * it is the job that typesets a whole illustrated book. Production runs three
 * (docs/deployment.md, "Job lanes"): most of a compile is the defect screen's
 * model call, and Chromium renders two books at most whatever the lanes add up
 * to (`RENDER_CONCURRENCY` in `browserPool.ts`), so a compile beside it adds a
 * manuscript's worth of memory, not a renderer. Measured on 2026-10-17, thirty
 * books finishing together drained in 7 minutes at three against about 16 at one.
 */
export const DEFAULT_COMPILE_LANE_CONCURRENCY = 1;

/**
 * The background lane runs four preps at once unless told otherwise. A prep is
 * about 90 s of provider calls over a plan held in memory (a few MB) and a
 * handful of short writes, so one at a time handled some 40 plans an hour and
 * left most of a burst's preps to start after their readers had approved; four
 * handle about 160, for well under 0.1 GiB and at most eight requests at once
 * at the text provider, since a prep's stance and inventory run side by side
 * (docs/deployment.md, "Job lanes").
 */
export const DEFAULT_BACKGROUND_LANE_CONCURRENCY = 4;

/**
 * How many of each lane's jobs one worker process runs at once.
 *
 * Unset, the long lane runs `MAX_PARALLEL_PAGE_JOBS` and the image lane
 * `MAX_PARALLEL_IMAGE_JOBS`, because those two settings size the page and
 * picture waves a book fans out, and a lane narrower than its wave would queue
 * what they say may run together. Production sets every lane outright
 * (docker-compose.production.yml).
 */
export function workerLaneConcurrency(config: {
  MAX_PARALLEL_PAGE_JOBS: number;
  MAX_PARALLEL_IMAGE_JOBS: number;
  WORKER_LONG_CONCURRENCY?: number | undefined;
  WORKER_INTERACTIVE_CONCURRENCY: number;
  WORKER_IMAGE_CONCURRENCY?: number | undefined;
  WORKER_COMPILE_CONCURRENCY?: number | undefined;
  WORKER_BACKGROUND_CONCURRENCY?: number | undefined;
}): Record<JobLane, number> {
  return {
    long: config.WORKER_LONG_CONCURRENCY ?? config.MAX_PARALLEL_PAGE_JOBS,
    interactive: config.WORKER_INTERACTIVE_CONCURRENCY,
    images: config.WORKER_IMAGE_CONCURRENCY ?? config.MAX_PARALLEL_IMAGE_JOBS,
    compile: config.WORKER_COMPILE_CONCURRENCY ?? DEFAULT_COMPILE_LANE_CONCURRENCY,
    background: config.WORKER_BACKGROUND_CONCURRENCY ?? DEFAULT_BACKGROUND_LANE_CONCURRENCY
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
 * a lookup that read one lane could miss the copy still running in another.
 * That is exactly what a deploy of the image and compile lanes leaves behind:
 * a picture the previous release queued in `book-maker` whose row a sweep
 * now places in `book-maker-images`.
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
 *
 * Only long-lane rows take part. A book whose pictures or compile are all it
 * has left holds nothing of the long lane, so it is ahead of nobody, and a book
 * waiting only on those is not waiting in this line at all: both lanes run
 * beside the long one and drain in seconds to minutes.
 *
 * `slots` is the lane's concurrency (`workerLaneConcurrency`). A waiting book
 * is behind every book queued before it, but the books already running hold it
 * up only once every slot is taken, and then only until one of them lets a slot
 * go: they count as `running − (slots − 1)`, never below zero. At one slot that
 * is every running book, which is how the count read before the lane ran wider.
 */
export function booksAheadInLongLane(rows: readonly LongLaneRow[], projectId: string, slots = 1): number | null {
  const open = rows.filter(
    (row) => laneOfClass(row.laneClass) === "long" && (row.status === "QUEUED" || row.status === "ACTIVE")
  );
  const own = open.filter((row) => row.projectId === projectId);
  if (own.length === 0 || own.some((row) => row.status === "ACTIVE")) return null;
  const waiting = own.reduce((oldest, row) => (row.createdAt < oldest.createdAt ? row : oldest));
  const running = new Set<string>();
  const queuedAhead = new Set<string>();
  for (const row of open) {
    if (!row.projectId || row.projectId === projectId) continue;
    if (row.status === "ACTIVE") {
      running.add(row.projectId);
      continue;
    }
    const before =
      (row.laneClass === "long-continuation" && (waiting.laneClass === "long-start" || row.createdAt < waiting.createdAt)) ||
      (row.laneClass === "long-start" && waiting.laneClass === "long-start" && row.createdAt < waiting.createdAt);
    if (before) queuedAhead.add(row.projectId);
  }
  // A running book with more work queued is one book under way, counted with the running ones.
  for (const book of running) queuedAhead.delete(book);
  return queuedAhead.size + Math.max(0, running.size - (Math.max(1, Math.floor(slots)) - 1));
}
