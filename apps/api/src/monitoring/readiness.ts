import {
  JOB_LANE_NAMES,
  JOB_LANES,
  PAYLOAD_LANED_JOB_TYPES,
  WORKER_HEARTBEAT_TTL_MS,
  jobLaneClass,
  laneOfClass,
  parseWorkerHeartbeat,
  queueNameForLane,
  workerHeartbeatKey,
  type GenerationJobType,
  type JobLane,
  type WorkerHeartbeat
} from "@book-maker/core";
import type { Prisma } from "@book-maker/db";

/**
 * Readiness: can this deployment do its work right now? `GET /api/ready`
 * answers it for an external uptime monitor, and the operator alert sweep
 * (`operatorAlerts.ts`) reads the same report every minute.
 *
 * It is deliberately not `/api/health`. That one is liveness — "is this Node
 * process answering?" — and touches nothing, because the compose healthcheck
 * polls it and that health gates every deploy (`up --wait`) and the web
 * container's start: wired to this probe, a release would fail over a long
 * queue or a worker that has not beaten yet, and anything that restarts an
 * unhealthy container would restart an API that was fine over a database blip.
 * This one touches everything the product depends on and gates nothing.
 *
 * Each check has its own timeout, all run together, and one report is cached
 * for a few seconds and shared by every caller (single-flight), so a monitor
 * polling every minute — or anyone hammering the public URL — costs at most one
 * `SELECT 1`, one PING, one MGET, one S3 HeadBucket and six small queries per
 * cache window (one per lane with a fixed type, and one bounded scan per
 * payload-laned type, which is all the image and compile lanes hold). The `mail` check opens no connection at all: it reads the SMTP
 * verification `mailHealth.ts` caches every ten minutes.
 *
 * The probe measures one lane more than it answers for: the background lane's
 * pair is `ADVISORY_CHECKS`, read by the alert sweep and never by `ok`.
 */

export const READINESS_CHECKS = [
  "db",
  "redis",
  "storage",
  "mail",
  "worker_long",
  "worker_interactive",
  "worker_images",
  "worker_compile",
  "queue_long",
  "queue_interactive",
  "queue_images",
  "queue_compile"
] as const;
export type ReadinessCheck = (typeof READINESS_CHECKS)[number];

/**
 * Measured with the checks above and alerted on like them
 * (`alertConditions.ts`), but never part of `ok` or the public body. The
 * background lane holds only the speculative composition prep, and while it is
 * down every book still starts: its run plans the stance, episodes and forms
 * itself, as it did before the prep existed, about a minute slower to its first
 * chapter. Readiness is binary — one failing check is a 503 the uptime monitor
 * reports as the deployment down — so, like a provider account out of credit,
 * this is an email and not a check (`apps/worker/CLAUDE.md`, "Work nobody
 * waits on has a lane of its own").
 */
export const ADVISORY_CHECKS = ["worker_background", "queue_background"] as const;
export type AdvisoryCheck = (typeof ADVISORY_CHECKS)[number];

/** Everything the probe measures — what the alert sweep reads. Every lane's pair is in exactly one of the two lists. */
export const MONITORED_CHECKS: readonly MonitoredCheck[] = Object.freeze([...READINESS_CHECKS, ...ADVISORY_CHECKS]);
export type MonitoredCheck = ReadinessCheck | AdvisoryCheck;
type WorkerCheck = `worker_${JobLane}`;
type QueueCheck = `queue_${JobLane}`;

/**
 * `unmeasured` marks a check that failed only because another one did — a
 * heartbeat that cannot be read while Redis is down, a queue that cannot be
 * measured while the database is. The public body still says `fail` (nothing
 * vouches for it); the alert sweep leaves it alone and alerts on the cause.
 */
export type CheckResult = { ok: true } | { ok: false; reason: string; unmeasured?: true };

export type ReadinessReport = {
  /** Every `READINESS_CHECKS` result passes; the advisory ones never decide it. */
  ok: boolean;
  checkedAt: Date;
  results: Record<MonitoredCheck, CheckResult>;
};

/** All the internet sees: no hostnames, no error text, no numbers to probe with. */
export type PublicReadiness = { ok: boolean; checks: Record<ReadinessCheck, "ok" | "fail"> };

/**
 * How long the oldest waiting job may have waited before its lane counts as
 * stuck. Interactive work (a plan, a chat edit, a portrait, an assist) takes
 * seconds to a few minutes on two slots, and a reader is watching a spinner, so
 * fifteen minutes means both slots are wedged or nothing is consuming the lane.
 * The long lane runs one job at a time and a composed book is a single job of
 * up to ~93 minutes, so a start can legitimately wait behind the running book
 * and one more; three hours is about two maximum-length books ahead, past which
 * the lane is either stuck behind a hung job or short of capacity, and a reader
 * has waited longer for their book to begin than it takes to write two. A
 * picture takes seconds on four slots and only one book's text is written at a
 * time, so half an hour of a waiting picture is a lane nothing consumes or a
 * provider refusing every call. A generation compile takes minutes on one slot
 * and the next one can only come from the book written after it, so an hour is
 * a compile hung or a lane without a consumer. A background prep takes about
 * 90 s on four slots and exits unrun once it is ten minutes old, so a prep
 * waiting fifteen is a lane nothing consumes, and every prep queued since is
 * wasted.
 */
export const QUEUE_WAIT_THRESHOLDS_MS: Readonly<Record<JobLane, number>> = Object.freeze({
  interactive: 15 * 60_000,
  long: 3 * 60 * 60_000,
  images: 30 * 60_000,
  compile: 60 * 60_000,
  background: 15 * 60_000
});

export const READINESS_CACHE_MS = 10_000;
export const READINESS_CHECK_TIMEOUT_MS = 3_000;

export type ReadinessDeps = {
  pingDatabase(): Promise<void>;
  pingRedis(): Promise<void>;
  storageReady(): Promise<void>;
  /** The cached SMTP verification (`mailHealth.ts`); rejects with its reason while mail is failing. */
  mailReady(): Promise<void>;
  /** The stored beat per lane, null where the key is absent (expired). Throws when Redis cannot be read. */
  readHeartbeats(): Promise<Record<JobLane, WorkerHeartbeat | null>>;
  /** When each lane's oldest waiting job started waiting, null when nothing waits. */
  oldestWaitingJobs(): Promise<Record<JobLane, Date | null>>;
};

type ReadinessLog = { warn(object: Record<string, unknown>, message: string): void; info(object: Record<string, unknown>, message: string): void };

export type ReadinessProbe = {
  /** The cached report, or a fresh one once the cache window has passed. Never rejects. */
  check(): Promise<ReadinessReport>;
};

export function createReadinessProbe(
  deps: ReadinessDeps,
  options: { now?: () => number; cacheMs?: number; timeoutMs?: number; log?: ReadinessLog } = {}
): ReadinessProbe {
  const now = options.now ?? Date.now;
  const cacheMs = options.cacheMs ?? READINESS_CACHE_MS;
  const timeoutMs = options.timeoutMs ?? READINESS_CHECK_TIMEOUT_MS;
  let cached: { at: number; report: ReadinessReport } | null = null;
  let inFlight: Promise<ReadinessReport> | null = null;
  // The failing set last logged, so the log says when it changes rather than on every probe.
  let loggedFailing = "";

  const measure = async (): Promise<ReadinessReport> => {
    const bounded = <T>(work: () => Promise<T>) => withTimeout(work, timeoutMs);
    const [db, redis, storage, mail, heartbeats, waiting] = await Promise.allSettled([
      bounded(deps.pingDatabase),
      bounded(deps.pingRedis),
      bounded(deps.storageReady),
      bounded(deps.mailReady),
      bounded(deps.readHeartbeats),
      bounded(deps.oldestWaitingJobs)
    ]);
    const at = now();
    const results = {
      db: settledCheck(db),
      redis: settledCheck(redis),
      storage: settledCheck(storage),
      mail: settledCheck(mail),
      ...heartbeatChecks(heartbeats, redis.status === "fulfilled", at),
      ...queueChecks(waiting, db.status === "fulfilled", at)
    } as Record<MonitoredCheck, CheckResult>;
    const report = { ok: READINESS_CHECKS.every((check) => results[check].ok), checkedAt: new Date(at), results };
    const failing = READINESS_CHECKS.filter((check) => !results[check].ok);
    if (options.log && failing.join(",") !== loggedFailing) {
      loggedFailing = failing.join(",");
      if (failing.length > 0) {
        options.log.warn({ event: "readiness.failing", failing: describeFailures(report) }, "Readiness check failing");
      } else {
        options.log.info({ event: "readiness.ready" }, "Readiness checks all pass");
      }
    }
    return report;
  };

  return {
    check() {
      const at = now();
      if (cached && at - cached.at < cacheMs) return Promise.resolve(cached.report);
      // A failing report is cached too: a sick database is not asked again per request.
      inFlight ??= measure()
        .then((report) => {
          cached = { at: now(), report };
          return report;
        })
        .finally(() => {
          inFlight = null;
        });
      return inFlight;
    }
  };
}

export function publicReadiness(report: ReadinessReport): PublicReadiness {
  const checks = Object.fromEntries(
    READINESS_CHECKS.map((check) => [check, report.results[check].ok ? "ok" : "fail"])
  ) as Record<ReadinessCheck, "ok" | "fail">;
  return { ok: report.ok, checks };
}

/** `check: reason` for each failing check — for the operator's log and email, never a client. */
export function describeFailures(report: ReadinessReport): Partial<Record<ReadinessCheck, string>> {
  return Object.fromEntries(
    READINESS_CHECKS.flatMap((check) => {
      const result = report.results[check];
      return result.ok ? [] : [[check, result.reason]];
    })
  );
}

function settledCheck(result: PromiseSettledResult<unknown>): CheckResult {
  return result.status === "fulfilled" ? { ok: true } : { ok: false, reason: failureReason(result.reason) };
}

function heartbeatChecks(
  result: PromiseSettledResult<Record<JobLane, WorkerHeartbeat | null>>,
  redisAnswered: boolean,
  at: number
): Record<WorkerCheck, CheckResult> {
  const lane = (name: JobLane): CheckResult => {
    if (result.status === "rejected") {
      const reason = `heartbeat unreadable: ${failureReason(result.reason)}`;
      return redisAnswered ? { ok: false, reason } : { ok: false, reason, unmeasured: true };
    }
    const beat = result.value[name];
    if (!beat) {
      return { ok: false, reason: `no heartbeat from the ${name} lane for over ${seconds(WORKER_HEARTBEAT_TTL_MS)}` };
    }
    const age = at - Date.parse(beat.beatAt);
    if (age > WORKER_HEARTBEAT_TTL_MS) {
      return { ok: false, reason: `last heartbeat from the ${name} lane was ${seconds(age)} ago` };
    }
    return { ok: true };
  };
  return Object.fromEntries(JOB_LANE_NAMES.map((name) => [`worker_${name}`, lane(name)])) as Record<WorkerCheck, CheckResult>;
}

function queueChecks(
  result: PromiseSettledResult<Record<JobLane, Date | null>>,
  databaseAnswered: boolean,
  at: number
): Record<QueueCheck, CheckResult> {
  const lane = (name: JobLane): CheckResult => {
    if (result.status === "rejected") {
      const reason = `waiting jobs unreadable: ${failureReason(result.reason)}`;
      return databaseAnswered ? { ok: false, reason } : { ok: false, reason, unmeasured: true };
    }
    const since = result.value[name];
    if (!since) return { ok: true };
    const waited = at - since.getTime();
    const threshold = QUEUE_WAIT_THRESHOLDS_MS[name];
    return waited > threshold
      ? { ok: false, reason: `the oldest waiting ${name}-lane job has waited ${duration(waited)} (limit ${duration(threshold)})` }
      : { ok: true };
  };
  return Object.fromEntries(JOB_LANE_NAMES.map((name) => [`queue_${name}`, lane(name)])) as Record<QueueCheck, CheckResult>;
}

class ReadinessTimeoutError extends Error {}

async function withTimeout<T>(work: () => Promise<T>, timeoutMs: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new ReadinessTimeoutError(`timed out after ${timeoutMs} ms`)), timeoutMs);
    timer.unref?.();
  });
  try {
    return await Promise.race([work(), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * A short reason for the operator. Credentials in a URL are stripped and the
 * length is bounded; it still never reaches the public body.
 */
export function failureReason(error: unknown): string {
  if (error instanceof ReadinessTimeoutError) return error.message;
  const name = error instanceof Error ? error.name : "Error";
  const message = error instanceof Error ? error.message : String(error);
  const cleaned = message.replace(/\/\/[^/\s@]*@/g, "//").replace(/\s+/g, " ").trim();
  const text = `${name}: ${cleaned}`;
  return text.length > 200 ? `${text.slice(0, 197)}...` : text;
}

function seconds(ms: number): string {
  return `${Math.round(ms / 1000)} s`;
}

function duration(ms: number): string {
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `${hours} h` : `${hours} h ${rest} min`;
}

// ---- the production dependencies ------------------------------------------------

type ReadinessRedis = {
  status: string;
  ping(): Promise<unknown>;
  mget(...keys: string[]): Promise<Array<string | null>>;
};

type ReadinessDatabase = {
  $queryRaw: (query: TemplateStringsArray) => Promise<unknown>;
  generationJob: Pick<Prisma.TransactionClient["generationJob"], "findFirst" | "findMany">;
};

/** The types each lane holds whatever their payload says; the rest are classified row by row. */
const FIXED_LANE_TYPES: Readonly<Record<JobLane, readonly GenerationJobType[]>> = (() => {
  const lanes: Record<JobLane, GenerationJobType[]> = { long: [], interactive: [], images: [], compile: [], background: [] };
  for (const [type, rule] of Object.entries(JOB_LANES) as Array<[GenerationJobType, (typeof JOB_LANES)[GenerationJobType]]>) {
    if (typeof rule !== "function") lanes[laneOfClass(rule)].push(type);
  }
  return Object.freeze(lanes);
})();
/**
 * A memory bound on each read that has to classify rows by payload. One scan
 * per type, never one over them all: the scan is oldest-first, so a shared one
 * filled by 200 older rows of another type — a burst of pictures, a queue of
 * edits — never reached the compile behind them, and `queue_compile` read ok.
 * Within one type the 200 oldest still decide, so a compile or picture can hide
 * only behind 200 older interactive rows of its own type, which have then
 * waited past the interactive lane's shorter threshold and fail it first.
 */
const PAYLOAD_LANED_SCAN = 200;

/**
 * The checks against the real Postgres, Redis and bucket.
 *
 * A job is waiting while its durable row is QUEUED — dispatched to BullMQ or
 * not, since an undispatched row is waiting just the same — and it has waited
 * since the row last changed: a dispatch, or the worker putting a retry back.
 * Measured from the rows rather than BullMQ's lists because a prioritized long
 * start sits in a sorted set ordered by priority, not age, and a retried Bull
 * job keeps its original timestamp. Its lane is core's `jobLaneClass`, the rule
 * both enqueue sides place it by.
 */
export function readinessDeps(input: {
  db: ReadinessDatabase;
  redis: ReadinessRedis;
  storageReady: () => Promise<void>;
  mailReady: () => Promise<void>;
}): ReadinessDeps {
  const { db, redis } = input;
  const redisReady = () => {
    // ioredis queues commands while it reconnects, so a PING to a dead Redis
    // would wait out the timeout and leave one more command queued behind it.
    if (redis.status !== "ready") throw new Error(`Redis connection is ${redis.status}`);
  };
  const oldestOf = async (types: readonly GenerationJobType[]): Promise<Date | null> => {
    if (types.length === 0) return null;
    const row = await db.generationJob.findFirst({
      where: { status: "QUEUED", type: { in: [...types] } },
      orderBy: { updatedAt: "asc" },
      select: { updatedAt: true }
    });
    return row?.updatedAt ?? null;
  };
  return {
    async pingDatabase() {
      await db.$queryRaw`SELECT 1`;
    },
    async pingRedis() {
      redisReady();
      await redis.ping();
    },
    storageReady: input.storageReady,
    mailReady: input.mailReady,
    async readHeartbeats() {
      redisReady();
      const beats = await redis.mget(...JOB_LANE_NAMES.map((lane) => workerHeartbeatKey(queueNameForLane(lane))));
      return Object.fromEntries(JOB_LANE_NAMES.map((lane, index) => [lane, parseWorkerHeartbeat(beats[index])])) as Record<
        JobLane,
        WorkerHeartbeat | null
      >;
    },
    async oldestWaitingJobs() {
      const [fixed, laned] = await Promise.all([
        // A lane with no fixed type (the image and compile lanes) costs no query here.
        Promise.all(JOB_LANE_NAMES.map((lane) => oldestOf(FIXED_LANE_TYPES[lane]))),
        Promise.all(PAYLOAD_LANED_JOB_TYPES.map((type) => db.generationJob.findMany({
          where: { status: "QUEUED", type: { in: [type] } },
          orderBy: { updatedAt: "asc" },
          take: PAYLOAD_LANED_SCAN,
          select: { type: true, payload: true, updatedAt: true }
        })))
      ]);
      const oldest = Object.fromEntries(JOB_LANE_NAMES.map((lane, index) => [lane, fixed[index] ?? null])) as Record<
        JobLane,
        Date | null
      >;
      for (const row of laned.flat()) {
        const lane = laneOfClass(jobLaneClass(row.type, row.payload) ?? "long-start");
        const current = oldest[lane];
        if (!current || row.updatedAt < current) oldest[lane] = row.updatedAt;
      }
      return oldest;
    }
  };
}
