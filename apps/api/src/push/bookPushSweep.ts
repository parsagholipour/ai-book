import { prisma } from "@book-maker/db";
import { mapWithConcurrency, STOPPED_JOB_ERROR } from "@book-maker/core";
import type { FastifyBaseLogger } from "fastify";
import { bookProgressMessage, bookSettledMessage, type BookPushKind, type BookPushMessage, type PushTarget } from "./bookPushMessages.js";
import { forgetPushToken, livePushDeviceWhere, livePushTargets } from "./pushDevices.js";
import type { PushSender } from "./pushSender.js";

/**
 * Book-progress and book-ready push notifications.
 *
 * Driven from the API on a timer rather than from the worker: the percent the
 * app shows is computed only here (`loadSerializedProjectStatus`, from many
 * job rows — the worker never stores it), so this sweep reads exactly the
 * status the app's own status stream would, and the generation code gains no
 * new failure path. The cost is latency: a book's ending reaches the phone up
 * to one interval after it happened.
 *
 * Only a book in GENERATING is followed — a new book, or one whose generation
 * is running again. Edits and continuations are not announced.
 */

export const BOOK_PUSH_SWEEP_INTERVAL_MS = 15_000;
/** A progress push is due once the bar has moved this far… */
export const PROGRESS_STEP_POINTS = 2;
/** …or the phrase under it changed, at most this often… */
export const DETAIL_REFRESH_MS = 60_000;
/**
 * …or this long has passed whatever changed. The app gives each progress
 * notification a timeout well past this, so a notification nobody refreshes
 * (the API went down, the ending push was lost) disappears by itself.
 */
export const PROGRESS_HEARTBEAT_MS = 5 * 60_000;
/**
 * The keep-alive stops once nothing has changed for this long. A book stuck in
 * GENERATING would otherwise refresh a frozen bar every five minutes for as
 * long as it stays stuck; this lets the phone's timeout take it down, and the
 * next real change puts it back.
 */
export const PROGRESS_STALL_MS = 30 * 60_000;

const SWEEP_CONCURRENCY = 4;
const MAX_BOOKS_PER_SWEEP = 200;

export type FollowedBook = {
  projectId: string;
  percent: number;
  detail: string | null;
  version: number;
  lastSentAt: Date;
  changedAt: Date;
};

export type BookProgressSnapshot = { percent: number; detail: string | null };

export type BookStatusLoader = (
  projectId: string,
  userId: string
) => Promise<{ status: string; progressPercent: number; currentAction: string } | null>;

export type BookPushSweepDeps = {
  sender: PushSender;
  loadStatus: BookStatusLoader;
  log: Pick<FastifyBaseLogger, "info" | "warn">;
  now?: () => Date;
};

export type BookPushSweepResult = { progress: number; settled: number; unregistered: number; failed: number };

export function progressPushDue(last: FollowedBook | null, next: BookProgressSnapshot, now: Date): boolean {
  if (!last) {
    return true;
  }
  const elapsed = now.getTime() - last.lastSentAt.getTime();
  if (next.percent >= last.percent + PROGRESS_STEP_POINTS) {
    return true;
  }
  if (next.detail !== last.detail && elapsed >= DETAIL_REFRESH_MS) {
    return true;
  }
  return elapsed >= PROGRESS_HEARTBEAT_MS && now.getTime() - last.changedAt.getTime() < PROGRESS_STALL_MS;
}

/**
 * How a followed book's generation ended, as the phone should hear it. A book
 * its owner stopped is FAILED too, but they pressed the button themselves: the
 * progress notification goes away and nothing alerts.
 */
export function settledBookPushKind(projectStatus: string, stoppedByOwner: boolean): Exclude<BookPushKind, "book_progress"> {
  if (projectStatus === "COMPLETE" || projectStatus === "REVIEW_REQUIRED") {
    return "book_ready";
  }
  if (projectStatus === "FAILED" && !stoppedByOwner) {
    return "book_failed";
  }
  return "book_clear";
}

export async function runBookPushSweep(deps: BookPushSweepDeps): Promise<BookPushSweepResult> {
  const now = deps.now?.() ?? new Date();
  const result: BookPushSweepResult = { progress: 0, settled: 0, unregistered: 0, failed: 0 };
  const [generating, followed] = await Promise.all([
    prisma.project.findMany({
      where: { status: "GENERATING", user: { pushDevices: { some: livePushDeviceWhere(now) } } },
      select: { id: true },
      orderBy: { updatedAt: "desc" },
      take: MAX_BOOKS_PER_SWEEP
    }),
    prisma.projectPushState.findMany({ orderBy: { lastSentAt: "asc" }, take: MAX_BOOKS_PER_SWEEP })
  ]);
  const states = new Map<string, FollowedBook>(followed.map((state) => [state.projectId, state]));
  const projectIds = [...new Set([...generating.map((project) => project.id), ...states.keys()])];
  await mapWithConcurrency(projectIds, SWEEP_CONCURRENCY, async (projectId) => {
    try {
      await followBook(projectId, states.get(projectId) ?? null, now, deps, result);
    } catch (error) {
      deps.log.warn({ err: error, event: "push.book_sweep_failed", projectId }, "Book push sweep failed for one book");
    }
  });
  return result;
}

async function followBook(
  projectId: string,
  state: FollowedBook | null,
  now: Date,
  deps: BookPushSweepDeps,
  result: BookPushSweepResult
): Promise<void> {
  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: { id: true, userId: true, title: true, status: true }
  });
  if (!project) {
    return;
  }

  if (project.status === "GENERATING") {
    const targets = await livePushTargets(project.userId, now);
    if (targets.length === 0) {
      return;
    }
    const status = await deps.loadStatus(project.id, project.userId);
    if (!status || status.status !== "generating") {
      return;
    }
    const snapshot: BookProgressSnapshot = {
      // The in-app bubble never moves backwards, and neither does this.
      percent: Math.max(state?.percent ?? 0, status.progressPercent),
      detail: status.currentAction.trim() || null
    };
    if (!progressPushDue(state, snapshot, now) || !(await claimProgressPush(project.id, state, snapshot, now))) {
      return;
    }
    result.progress += 1;
    await deliver(
      targets,
      bookProgressMessage({ projectId: project.id, title: project.title, ...snapshot, sentAt: now.getTime() }),
      deps,
      result
    );
    return;
  }

  if (!state) {
    return;
  }
  // The generation ended since the last sweep. Deleting the row is the claim:
  // only the sweep whose delete matched this version says how it ended.
  const claimed = await prisma.projectPushState.deleteMany({ where: { projectId: project.id, version: state.version } });
  if (claimed.count !== 1) {
    return;
  }
  result.settled += 1;
  const kind = settledBookPushKind(project.status, project.status === "FAILED" && (await stoppedByOwner(project.id)));
  await deliver(
    await livePushTargets(project.userId, now),
    bookSettledMessage({
      kind,
      projectId: project.id,
      title: project.title,
      needsReview: project.status === "REVIEW_REQUIRED",
      sentAt: now.getTime()
    }),
    deps,
    result
  );
}

async function claimProgressPush(
  projectId: string,
  state: FollowedBook | null,
  snapshot: BookProgressSnapshot,
  now: Date
): Promise<boolean> {
  if (!state) {
    const created = await prisma.projectPushState.createMany({
      data: [{ projectId, percent: snapshot.percent, detail: snapshot.detail, lastSentAt: now, changedAt: now }],
      skipDuplicates: true
    });
    return created.count === 1;
  }
  const changed = snapshot.percent !== state.percent || snapshot.detail !== state.detail;
  const updated = await prisma.projectPushState.updateMany({
    where: { projectId, version: state.version },
    data: {
      percent: snapshot.percent,
      detail: snapshot.detail,
      lastSentAt: now,
      changedAt: changed ? now : state.changedAt,
      version: { increment: 1 }
    }
  });
  return updated.count === 1;
}

/** The newest settled job carries the stop's own error; a real failure carries something else. */
async function stoppedByOwner(projectId: string): Promise<boolean> {
  const last = await prisma.generationJob.findFirst({
    where: { projectId, status: { in: ["FAILED", "CANCELED"] } },
    orderBy: { updatedAt: "desc" },
    select: { error: true }
  });
  return last?.error === STOPPED_JOB_ERROR;
}

async function deliver(
  targets: PushTarget[],
  message: BookPushMessage,
  deps: BookPushSweepDeps,
  result: BookPushSweepResult
): Promise<void> {
  for (const target of targets) {
    const outcome = await deps.sender.send(target, message);
    if (outcome === "unregistered") {
      result.unregistered += 1;
      await forgetPushToken(target.token);
    } else if (outcome === "failed") {
      result.failed += 1;
    }
  }
}
