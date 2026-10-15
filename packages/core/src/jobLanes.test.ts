import { describe, expect, it, vi } from "vitest";
import { jobNames } from "./jobDispatch.js";
import {
  GENERATION_JOB_QUEUES,
  GENERATION_JOB_RETENTION,
  INTERACTIVE_JOB_QUEUE,
  JOB_LANES,
  LONG_JOB_QUEUE,
  LONG_LANE_CAPABLE_JOB_TYPES,
  LONG_LANE_EDIT_PAGE_THRESHOLD,
  LONG_LANE_START_PRIORITY,
  PAYLOAD_LANED_JOB_TYPES,
  applyBookEditRewritePageCount,
  booksAheadInLongLane,
  clearLaneJobIdForAdd,
  generationJobPlacement,
  isLaneJobActive,
  laneJobForSweep,
  removeIdleLaneJobs,
  jobLaneClass,
  workerLaneConcurrency,
  type LongLaneRow
} from "./jobLanes.js";
import { COVER_RETYPESET, DETACHED_FROM_PROJECT_LIFECYCLE, PRESENTATION_ONLY_RECOMPILE } from "./jobScope.js";

describe("job lanes", () => {
  it("names a lane for exactly the job types jobNames dispatches", () => {
    expect(Object.keys(JOB_LANES).sort()).toEqual(Object.keys(jobNames).sort());
    for (const type of Object.keys(jobNames)) {
      expect(jobLaneClass(type, {})).not.toBeNull();
    }
    expect(jobLaneClass("RESEARCH", {})).toBeNull();
  });

  it("keeps the old queue's name for the long lane, so a previous release's jobs still drain", () => {
    expect(LONG_JOB_QUEUE).toBe("book-maker");
    expect(GENERATION_JOB_QUEUES).toEqual(["book-maker", INTERACTIVE_JOB_QUEUE]);
    expect(new Set(GENERATION_JOB_QUEUES).size).toBe(2);
  });

  it("puts what a reader waits on in the interactive lane, unprioritized", () => {
    for (const type of [
      "PLAN_BOOK",
      "REVISE_PLAN",
      "APPLY_BOOK_EDIT",
      "REPLAN_BOOK",
      "WRITING_ASSIST",
      "GENERATE_CHARACTER_PORTRAIT",
      "BUILD_CHARACTER_PERSONA",
      "PREPARE_CHARACTER_CANDIDATES"
    ]) {
      expect(generationJobPlacement(type, {})).toEqual({ lane: "interactive", queueName: INTERACTIVE_JOB_QUEUE });
    }
  });

  it("starts long work behind everything already under way, and continues it ahead of every start", () => {
    for (const type of ["GENERATE_BOOK", "IMPORT_BOOK", "CONTINUE_BOOK", "GENERATE_AUDIOBOOK"]) {
      expect(generationJobPlacement(type, {})).toEqual({
        lane: "long",
        queueName: LONG_JOB_QUEUE,
        priority: LONG_LANE_START_PRIORITY
      });
    }
    expect(generationJobPlacement("GENERATE_PAGE", { pageId: "p" })).toEqual({ lane: "long", queueName: LONG_JOB_QUEUE });
  });

  it("sends only a generation's own full-review compile to the long lane", () => {
    const long = { lane: "long", queueName: LONG_JOB_QUEUE };
    const interactive = { lane: "interactive", queueName: INTERACTIVE_JOB_QUEUE };
    expect(generationJobPlacement("COMPILE_EXPORT", { planId: "p", exportPublicationProjectStatus: "GENERATING" })).toEqual(long);
    // A row from before the status was promoted into the payload is a generation's.
    expect(generationJobPlacement("COMPILE_EXPORT", { planId: "p" })).toEqual(long);
    expect(generationJobPlacement("COMPILE_EXPORT", { exportPublicationProjectStatus: "EDITING", skipFinalReview: true })).toEqual(interactive);
    // A structural edit's compile reviews the whole book, and its reader is still in the chat.
    expect(generationJobPlacement("COMPILE_EXPORT", { exportPublicationProjectStatus: "EDITING" })).toEqual(interactive);
    expect(generationJobPlacement("COMPILE_EXPORT", { exportPublicationProjectStatus: "COMPLETE" })).toEqual(interactive);
    expect(
      generationJobPlacement("COMPILE_EXPORT", { skipFinalReview: true, [DETACHED_FROM_PROJECT_LIFECYCLE]: true })
    ).toEqual(interactive);
    expect(
      generationJobPlacement("COMPILE_EXPORT", { skipFinalReview: true, [PRESENTATION_ONLY_RECOMPILE]: true })
    ).toEqual(interactive);
  });

  it("sends a generation's pictures long and a revision's cover or re-typeset interactive", () => {
    expect(generationJobPlacement("GENERATE_IMAGE", { planId: "p", pageId: "x" }).lane).toBe("long");
    expect(generationJobPlacement("GENERATE_IMAGE", { planId: "p", assetType: "COVER" }).lane).toBe("long");
    expect(
      generationJobPlacement("GENERATE_IMAGE", {
        assetType: "COVER",
        contentRevision: 4,
        exportPublicationProjectStatus: "EDITING"
      }).lane
    ).toBe("interactive");
    expect(generationJobPlacement("GENERATE_IMAGE", { assetType: "COVER", [COVER_RETYPESET]: true }).lane).toBe("interactive");
  });

  it("starts a rewrite of a book's worth of pages on the long lane, and keeps every smaller edit interactive", () => {
    const pages = (count: number) => Array.from({ length: count }, (_, index) => index + 1);
    const interactive = { lane: "interactive", queueName: INTERACTIVE_JOB_QUEUE };
    const longStart = { lane: "long", queueName: LONG_JOB_QUEUE, priority: LONG_LANE_START_PRIORITY };
    expect(generationJobPlacement("APPLY_BOOK_EDIT", { affectedPageIndexes: pages(3) })).toEqual(interactive);
    expect(
      generationJobPlacement("APPLY_BOOK_EDIT", { affectedPageIndexes: pages(LONG_LANE_EDIT_PAGE_THRESHOLD) })
    ).toEqual(interactive);
    expect(
      generationJobPlacement("APPLY_BOOK_EDIT", { affectedPageIndexes: pages(LONG_LANE_EDIT_PAGE_THRESHOLD + 1) })
    ).toEqual(longStart);
    expect(generationJobPlacement("APPLY_BOOK_EDIT", { affectedPageIndexes: pages(200) })).toEqual(longStart);
    // A verified find/replace is code, not a model call per page, however many pages it touches.
    expect(generationJobPlacement("APPLY_BOOK_EDIT", { affectedPageIndexes: pages(200), mode: "exact" })).toEqual(
      interactive
    );
    // Structural and image forks name no pages, or the few a picture sits on.
    expect(
      generationJobPlacement("APPLY_BOOK_EDIT", { affectedPageIndexes: [], structuralEdit: { action: "insert" } })
    ).toEqual(interactive);
    // A payload the enqueue never wrote — a row from before the rule, or a malformed one — is the edit it always was.
    expect(generationJobPlacement("APPLY_BOOK_EDIT", {})).toEqual(interactive);
    expect(generationJobPlacement("APPLY_BOOK_EDIT", null)).toEqual(interactive);
    expect(applyBookEditRewritePageCount({ affectedPageIndexes: [4, 4, 5, "6", 7.5] })).toBe(2);
  });

  it("counts a waiting whole-book edit as a start, in line behind the books already under way", () => {
    const edit = (projectId: string, minute: number, status = "QUEUED") => ({
      projectId,
      status,
      laneClass: jobLaneClass("APPLY_BOOK_EDIT", { affectedPageIndexes: Array.from({ length: 120 }, (_, i) => i) })!,
      createdAt: new Date(Date.UTC(2026, 9, 13, 10, minute))
    });
    expect(edit("mine", 0).laneClass).toBe("long-start");
    expect(
      booksAheadInLongLane(
        [
          { projectId: "running", status: "ACTIVE", laneClass: "long-start", createdAt: new Date(Date.UTC(2026, 9, 13, 9, 0)) },
          { projectId: "older", status: "QUEUED", laneClass: "long-start", createdAt: new Date(Date.UTC(2026, 9, 13, 9, 30)) },
          edit("mine", 0),
          { projectId: "newer", status: "QUEUED", laneClass: "long-start", createdAt: new Date(Date.UTC(2026, 9, 13, 10, 5)) }
        ],
        "mine"
      )
    ).toBe(2);
  });

  it("derives the database filters from the record", () => {
    expect([...LONG_LANE_CAPABLE_JOB_TYPES].sort()).toEqual(
      [
        "APPLY_BOOK_EDIT",
        "COMPILE_EXPORT",
        "CONTINUE_BOOK",
        "GENERATE_AUDIOBOOK",
        "GENERATE_BOOK",
        "GENERATE_IMAGE",
        "GENERATE_PAGE",
        "IMPORT_BOOK"
      ]
    );
    expect([...PAYLOAD_LANED_JOB_TYPES].sort()).toEqual(["APPLY_BOOK_EDIT", "COMPILE_EXPORT", "GENERATE_IMAGE"]);
  });

  it("defaults the long lane to the single queue's old concurrency", () => {
    expect(
      workerLaneConcurrency({ MAX_PARALLEL_PAGE_JOBS: 4, MAX_PARALLEL_IMAGE_JOBS: 2, WORKER_INTERACTIVE_CONCURRENCY: 2 })
    ).toEqual({ long: 4, interactive: 2 });
    expect(
      workerLaneConcurrency({
        MAX_PARALLEL_PAGE_JOBS: 4,
        MAX_PARALLEL_IMAGE_JOBS: 2,
        WORKER_LONG_CONCURRENCY: 1,
        WORKER_INTERACTIVE_CONCURRENCY: 3
      })
    ).toEqual({ long: 1, interactive: 3 });
  });

  it("bounds finished jobs by age and by count", () => {
    expect(GENERATION_JOB_RETENTION.removeOnComplete).toEqual({ age: 86_400, count: 1_000 });
    expect(GENERATION_JOB_RETENTION.removeOnFail).toEqual({ age: 604_800, count: 2_000 });
  });
});

describe("booksAheadInLongLane", () => {
  const at = (minute: number) => new Date(Date.UTC(2026, 9, 13, 10, minute));
  const row = (projectId: string, laneClass: LongLaneRow["laneClass"], status: string, minute: number): LongLaneRow => ({
    projectId,
    laneClass,
    status,
    createdAt: at(minute)
  });

  it("is null for a book with nothing waiting or with work already running", () => {
    expect(booksAheadInLongLane([row("a", "long-start", "ACTIVE", 1)], "b")).toBeNull();
    expect(booksAheadInLongLane([row("b", "long-continuation", "ACTIVE", 1), row("b", "long-continuation", "QUEUED", 2)], "b")).toBeNull();
    // Interactive work is not the long lane's to order.
    expect(booksAheadInLongLane([row("b", "interactive", "QUEUED", 2)], "b")).toBeNull();
  });

  it("puts a waiting start behind every book under way and every older start, counted in books", () => {
    const rows = [
      row("running", "long-continuation", "ACTIVE", 5),
      row("running", "long-continuation", "QUEUED", 6),
      row("running", "long-continuation", "QUEUED", 7),
      // Continuations queued after mine still run first: they are a book already started.
      row("started-later", "long-continuation", "QUEUED", 30),
      row("older-start", "long-start", "QUEUED", 8),
      row("mine", "long-start", "QUEUED", 10),
      row("newer-start", "long-start", "QUEUED", 12)
    ];
    expect(booksAheadInLongLane(rows, "mine")).toBe(3);
    expect(booksAheadInLongLane(rows, "older-start")).toBe(2);
    expect(booksAheadInLongLane(rows, "newer-start")).toBe(4);
  });

  it("puts a waiting continuation behind what runs and the continuations before it, never behind a start", () => {
    const rows = [
      row("running", "long-start", "ACTIVE", 1),
      row("earlier", "long-continuation", "QUEUED", 2),
      row("mine", "long-continuation", "QUEUED", 3),
      row("later", "long-continuation", "QUEUED", 4),
      row("fresh", "long-start", "QUEUED", 0)
    ];
    expect(booksAheadInLongLane(rows, "mine")).toBe(2);
  });

  it("answers zero for a book first in line", () => {
    expect(booksAheadInLongLane([row("mine", "long-start", "QUEUED", 1), row("next", "long-start", "QUEUED", 2)], "mine")).toBe(0);
  });
});

describe("lookups across lanes", () => {
  const copy = (state: string) => ({ getState: async () => state, remove: vi.fn(async () => undefined), failedReason: state });
  const lane = (job: ReturnType<typeof copy> | undefined) => ({ getJob: vi.fn(async () => job) });

  it("judges a row by its live copy wherever it is, then a failed one, else nothing", async () => {
    const live = copy("prioritized");
    expect(await laneJobForSweep([lane(copy("failed")), lane(live)], "gj")).toBe(live);
    const failed = copy("failed");
    expect(await laneJobForSweep([lane(copy("completed")), lane(failed)], "gj")).toBe(failed);
    // Removed by retention reads the same as lost from Redis: missing.
    expect(await laneJobForSweep([lane(undefined), lane(undefined)], "gj")).toBeNull();
  });

  it("refuses an add while any lane runs the id, and clears finished copies before one", async () => {
    expect(await clearLaneJobIdForAdd([lane(copy("completed")), lane(copy("active"))], "gj")).toBe(false);
    const done = copy("completed");
    const failed = copy("failed");
    expect(await clearLaneJobIdForAdd([lane(done), lane(failed)], "gj")).toBe(true);
    expect(done.remove).toHaveBeenCalled();
    expect(failed.remove).toHaveBeenCalled();
    expect(await clearLaneJobIdForAdd([lane(undefined), lane(undefined)], "gj")).toBe(true);
  });

  it("removes every idle copy and leaves the running one to its delivery", async () => {
    const running = copy("active");
    const waiting = copy("waiting");
    expect(await removeIdleLaneJobs([lane(running), lane(waiting)], "gj")).toBe(1);
    expect(running.remove).not.toHaveBeenCalled();
    expect(waiting.remove).toHaveBeenCalled();
    expect(await isLaneJobActive([lane(undefined), lane(running)], "gj")).toBe(true);
    expect(await isLaneJobActive([lane(waiting)], "gj")).toBe(false);
  });
});
