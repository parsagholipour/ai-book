import {
  LONG_LANE_CAPABLE_JOB_TYPES,
  PAYLOAD_LANED_JOB_TYPES,
  booksAheadInLongLane,
  jobLaneClass,
  type LongLaneRow
} from "@book-maker/core";
import { prisma } from "@book-maker/db";

/**
 * How many books the worker's long lane will run before this one's waiting
 * work — the reader's "2 books ahead of yours".
 *
 * Counted from the durable `GenerationJob` rows rather than from BullMQ's
 * lists: the rows are already what every status read is built from, the API
 * reads Redis nowhere on that path, and a row is open from the moment it is
 * written — including one whose dispatch to Redis is still deferred, which
 * Bull's lists would not show yet but the lane will still run in order. The
 * order itself is core's (`booksAheadInLongLane`, beside the placement rule that
 * makes it true), so the number cannot drift from what the worker does.
 *
 * Every waiting book's poll would read the same global set, so it is read once
 * per few seconds per process and shared; only the asking book's own rows are
 * taken fresh, from the status read that already loaded them. The read is two
 * small queries over open rows of the long-capable types — payload only for
 * the two types whose lane depends on it — and the status index's leading
 * `status` column serves both.
 */

const SNAPSHOT_TTL_MS = 3_000;

let snapshot: { at: number; rows: Promise<LongLaneRow[]> } | null = null;

const payloadLaned = new Set<string>(PAYLOAD_LANED_JOB_TYPES);
const plainLongTypes = LONG_LANE_CAPABLE_JOB_TYPES.filter((type) => !payloadLaned.has(type));

type OpenJobRow = { projectId: string | null; type: string; status: string; createdAt: Date; payload?: unknown };

function longLaneRow(row: OpenJobRow): LongLaneRow | null {
  const laneClass = jobLaneClass(row.type, row.payload ?? null);
  if (!laneClass || laneClass === "interactive") return null;
  return { projectId: row.projectId, status: row.status, laneClass, createdAt: row.createdAt };
}

async function readSnapshot(): Promise<LongLaneRow[]> {
  const open = { status: { in: ["QUEUED" as const, "ACTIVE" as const] } };
  const [plain, laned] = await Promise.all([
    prisma.generationJob.findMany({
      where: { ...open, type: { in: [...plainLongTypes] } },
      select: { projectId: true, type: true, status: true, createdAt: true }
    }),
    prisma.generationJob.findMany({
      where: { ...open, type: { in: [...PAYLOAD_LANED_JOB_TYPES] } },
      select: { projectId: true, type: true, status: true, createdAt: true, payload: true }
    })
  ]);
  return [...plain, ...laned].flatMap((row) => longLaneRow(row) ?? []);
}

async function longLaneSnapshot(now: number): Promise<LongLaneRow[]> {
  if (snapshot && now - snapshot.at < SNAPSHOT_TTL_MS) return snapshot.rows;
  const rows = readSnapshot();
  const entry = { at: now, rows };
  snapshot = entry;
  // A failed read is not cached: the next poll asks again.
  rows.catch(() => {
    if (snapshot === entry) snapshot = null;
  });
  return rows;
}

/**
 * The queue position for a project whose own open rows are `ownJobs`, or null
 * when none of its long-lane work is waiting (nothing queued, or some running).
 * A read that fails answers null: the line is a courtesy, never a reason to
 * fail the status the app polls.
 */
export async function longLaneQueuePosition(
  projectId: string,
  ownJobs: ReadonlyArray<OpenJobRow>,
  now = Date.now()
): Promise<{ booksAhead: number } | null> {
  const own = ownJobs.flatMap((job) =>
    job.status === "QUEUED" || job.status === "ACTIVE" ? (longLaneRow({ ...job, projectId }) ?? []) : []
  );
  if (own.length === 0 || own.some((row) => row.status === "ACTIVE")) return null;
  let others: LongLaneRow[];
  try {
    others = (await longLaneSnapshot(now)).filter((row) => row.projectId !== projectId);
  } catch (error) {
    console.error("Could not read the long lane for a queue position", error);
    return null;
  }
  const booksAhead = booksAheadInLongLane([...others, ...own], projectId);
  return booksAhead === null ? null : { booksAhead };
}

export function resetLongLaneSnapshotForTests(): void {
  snapshot = null;
}
