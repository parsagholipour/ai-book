import { describe, expect, it, vi } from "vitest";
import {
  BACKGROUND_JOB_QUEUE,
  COMPILE_JOB_QUEUE,
  IMAGE_JOB_QUEUE,
  INTERACTIVE_JOB_QUEUE,
  JOB_LANE_NAMES,
  JOB_LANES,
  LONG_JOB_QUEUE,
  queueNameForLane,
  workerHeartbeatKey,
  type JobLane,
  type WorkerHeartbeat
} from "@book-maker/core";
import {
  ADVISORY_CHECKS,
  createReadinessProbe,
  failureReason,
  MONITORED_CHECKS,
  publicReadiness,
  QUEUE_WAIT_THRESHOLDS_MS,
  READINESS_CHECKS,
  readinessDeps,
  type ReadinessDeps
} from "./readiness.js";

const NOW = Date.parse("2026-10-13T12:00:00.000Z");
const MINUTE = 60_000;

function beat(lane: JobLane, ageMs = 10_000): WorkerHeartbeat {
  return {
    lane,
    queue: queueNameForLane(lane),
    pid: 1,
    host: "worker",
    startedAt: new Date(NOW - 60 * MINUTE).toISOString(),
    beatAt: new Date(NOW - ageMs).toISOString(),
    running: 0,
    concurrency: 1
  };
}

const everyBeat = (overrides: Partial<Record<JobLane, WorkerHeartbeat | null>> = {}) => ({
  long: beat("long"),
  interactive: beat("interactive"),
  images: beat("images"),
  compile: beat("compile"),
  background: beat("background"),
  ...overrides
});
const NOTHING_WAITING: Record<JobLane, Date | null> = { long: null, interactive: null, images: null, compile: null, background: null };

function healthyDeps(overrides: Partial<ReadinessDeps> = {}): ReadinessDeps {
  return {
    pingDatabase: vi.fn(async () => undefined),
    pingRedis: vi.fn(async () => undefined),
    storageReady: vi.fn(async () => undefined),
    mailReady: vi.fn(async () => undefined),
    readHeartbeats: vi.fn(async () => everyBeat()),
    oldestWaitingJobs: vi.fn(async () => ({ ...NOTHING_WAITING, interactive: new Date(NOW - MINUTE) })),
    ...overrides
  };
}

const probeOf = (deps: ReadinessDeps, now = () => NOW) => createReadinessProbe(deps, { now, timeoutMs: 50 });

describe("the readiness report", () => {
  it("passes when everything answers, and says nothing but ok per check", async () => {
    const report = await probeOf(healthyDeps()).check();
    expect(report.ok).toBe(true);
    expect(publicReadiness(report)).toEqual({
      ok: true,
      checks: {
        db: "ok",
        redis: "ok",
        storage: "ok",
        mail: "ok",
        worker_long: "ok",
        worker_interactive: "ok",
        worker_images: "ok",
        worker_compile: "ok",
        queue_long: "ok",
        queue_interactive: "ok",
        queue_images: "ok",
        queue_compile: "ok"
      }
    });
  });

  it.each([
    ["db", { pingDatabase: async () => Promise.reject(new Error("P1001: Can't reach database server at postgres:5432")) }],
    ["redis", { pingRedis: async () => Promise.reject(new Error("Redis connection is reconnecting")) }],
    ["storage", { storageReady: async () => Promise.reject(new Error("Object storage bucket is not reachable")) }],
    ["mail", { mailReady: async () => Promise.reject(new Error("Error: Invalid login: 535 Authentication failed")) }]
  ] as const)("fails %s alone when only it fails, and keeps the reason out of the public body", async (check, override) => {
    const report = await probeOf(healthyDeps(override as Partial<ReadinessDeps>)).check();
    const body = publicReadiness(report);
    expect(body.ok).toBe(false);
    expect(Object.entries(body.checks).filter(([, status]) => status === "fail").map(([name]) => name)).toEqual([check]);
    expect(report.results[check]).toMatchObject({ ok: false });
    expect(JSON.stringify(body)).not.toMatch(/postgres|reconnecting|bucket|Error|login/);
    expect(Object.keys(body)).toEqual(["ok", "checks"]);
  });

  it("measures and reports a dead or backed-up background lane, but never fails readiness over it", async () => {
    const report = await probeOf(
      healthyDeps({
        readHeartbeats: async () => everyBeat({ background: null }),
        oldestWaitingJobs: async () => ({ ...NOTHING_WAITING, background: new Date(NOW - 16 * MINUTE) })
      })
    ).check();
    expect(report.ok).toBe(true);
    expect(report.results.worker_background).toMatchObject({
      ok: false,
      reason: expect.stringContaining("no heartbeat from the background lane")
    });
    expect(report.results.queue_background).toEqual({
      ok: false,
      reason: "the oldest waiting background-lane job has waited 16 min (limit 15 min)"
    });
    // The public body names only what it answers for.
    const body = publicReadiness(report);
    expect(body.ok).toBe(true);
    expect(Object.keys(body.checks)).toEqual([...READINESS_CHECKS]);
    expect(JSON.stringify(body)).not.toContain("background");
  });

  it("files every lane's pair of checks as readiness or advisory, exactly once", () => {
    const laneChecks = JOB_LANE_NAMES.flatMap((lane) => [`worker_${lane}`, `queue_${lane}`]);
    expect([...MONITORED_CHECKS].sort()).toEqual(["db", "redis", "storage", "mail", ...laneChecks].sort());
    expect(new Set(MONITORED_CHECKS).size).toBe(MONITORED_CHECKS.length);
    expect(ADVISORY_CHECKS).toEqual(["worker_background", "queue_background"]);
  });

  it("fails a check that does not answer in time instead of waiting for it", async () => {
    const report = await probeOf(healthyDeps({ pingDatabase: () => new Promise<void>(() => undefined) })).check();
    expect(report.results.db).toEqual({ ok: false, reason: "timed out after 50 ms" });
  });

  it("fails a lane whose heartbeat expired or went stale, and only that lane", async () => {
    const missing = await probeOf(healthyDeps({ readHeartbeats: async () => everyBeat({ long: null }) })).check();
    expect(missing.results.worker_long).toMatchObject({ ok: false, reason: expect.stringContaining("no heartbeat from the long lane") });
    expect(missing.results.worker_interactive).toEqual({ ok: true });

    const stale = await probeOf(
      healthyDeps({ readHeartbeats: async () => everyBeat({ interactive: beat("interactive", 95_000) }) })
    ).check();
    expect(stale.results.worker_interactive).toMatchObject({ ok: false, reason: expect.stringContaining("95 s ago") });
    expect(stale.results.worker_long).toEqual({ ok: true });

    // A worker of a release before the image lane beats on two lanes only: the pictures have no consumer.
    const older = await probeOf(healthyDeps({ readHeartbeats: async () => everyBeat({ images: null, compile: null }) })).check();
    expect(older.results.worker_images).toMatchObject({ ok: false, reason: expect.stringContaining("no heartbeat from the images lane") });
    expect(older.results.worker_compile).toMatchObject({ ok: false });
    expect(older.results.worker_long).toEqual({ ok: true });
  });

  it("marks what it could not measure as unmeasured when the cause is its own failing check", async () => {
    const down = new Error("Redis connection is reconnecting");
    const report = await probeOf(
      healthyDeps({
        pingRedis: async () => Promise.reject(down),
        readHeartbeats: async () => Promise.reject(down),
        pingDatabase: async () => Promise.reject(new Error("timeout")),
        oldestWaitingJobs: async () => Promise.reject(new Error("timeout"))
      })
    ).check();
    expect(report.results.worker_long).toMatchObject({ ok: false, unmeasured: true });
    expect(report.results.worker_interactive).toMatchObject({ ok: false, unmeasured: true });
    expect(report.results.queue_long).toMatchObject({ ok: false, unmeasured: true });
    expect(report.results.redis).not.toHaveProperty("unmeasured");
    expect(publicReadiness(report).checks.worker_long).toBe("fail");
  });

  it("holds each lane's oldest waiting job to its own limit", async () => {
    const at = (lane: JobLane, waited: number) =>
      probeOf(
        healthyDeps({
          oldestWaitingJobs: async () => ({ ...NOTHING_WAITING, [lane]: new Date(NOW - waited) })
        })
      ).check();
    expect((await at("interactive", QUEUE_WAIT_THRESHOLDS_MS.interactive - MINUTE)).results.queue_interactive.ok).toBe(true);
    const stuck = await at("interactive", QUEUE_WAIT_THRESHOLDS_MS.interactive + MINUTE);
    expect(stuck.results.queue_interactive).toEqual({
      ok: false,
      reason: "the oldest waiting interactive-lane job has waited 16 min (limit 15 min)"
    });
    expect((await at("long", 2 * 60 * MINUTE + 59 * MINUTE)).results.queue_long.ok).toBe(true);
    expect((await at("long", 3 * 60 * MINUTE + 5 * MINUTE)).results.queue_long).toMatchObject({
      ok: false,
      reason: expect.stringContaining("3 h 5 min (limit 3 h)")
    });
    expect((await at("images", 29 * MINUTE)).results.queue_images.ok).toBe(true);
    expect((await at("images", 31 * MINUTE)).results.queue_images).toMatchObject({
      ok: false,
      reason: "the oldest waiting images-lane job has waited 31 min (limit 30 min)"
    });
    expect((await at("compile", 59 * MINUTE)).results.queue_compile.ok).toBe(true);
    expect((await at("compile", 61 * MINUTE)).results.queue_compile).toMatchObject({ ok: false });
    expect((await at("background", 14 * MINUTE)).results.queue_background.ok).toBe(true);
    expect((await at("background", 16 * MINUTE)).results.queue_background).toMatchObject({ ok: false });
  });
});

describe("the readiness cache", () => {
  it("answers every caller inside the window from one probe, a failing one included", async () => {
    let now = NOW;
    const deps = healthyDeps({ pingDatabase: vi.fn(async () => Promise.reject(new Error("down"))) });
    const probe = probeOf(deps, () => now);
    const [first, second] = await Promise.all([probe.check(), probe.check()]);
    expect(first).toBe(second);
    now += 9_000;
    expect(await probe.check()).toBe(first);
    expect(deps.pingDatabase).toHaveBeenCalledTimes(1);
    expect(deps.storageReady).toHaveBeenCalledTimes(1);

    now += 2_000;
    await probe.check();
    expect(deps.pingDatabase).toHaveBeenCalledTimes(2);
  });

  it("logs when the failing set changes, not on every probe", async () => {
    let now = NOW;
    let databaseUp = false;
    const log = { warn: vi.fn(), info: vi.fn() };
    const probe = createReadinessProbe(
      healthyDeps({ pingDatabase: async () => (databaseUp ? undefined : Promise.reject(new Error("down"))) }),
      { now: () => now, log }
    );
    for (let index = 0; index < 3; index += 1) {
      await probe.check();
      now += 20_000;
    }
    expect(log.warn).toHaveBeenCalledTimes(1);
    databaseUp = true;
    await probe.check();
    expect(log.info).toHaveBeenCalledTimes(1);
  });
});

describe("failureReason", () => {
  it("strips credentials out of a URL and bounds the length", () => {
    const reason = failureReason(new Error("connect ECONNREFUSED redis://:s3cret-password@redis:6379 " + "x".repeat(400)));
    expect(reason).not.toContain("s3cret-password");
    expect(reason.startsWith("Error: connect ECONNREFUSED redis://redis:6379")).toBe(true);
    expect(reason.length).toBeLessThanOrEqual(200);
  });
});

describe("readinessDeps", () => {
  function fakeRedis(status = "ready", values: Array<string | null> = [null, null, null, null, null]) {
    return { status, ping: vi.fn(async () => "PONG"), mget: vi.fn(async (..._keys: string[]) => values) };
  }
  function fakeDb(
    rows: {
      long?: Date | null;
      interactive?: Date | null;
      background?: Date | null;
      laned?: Array<{ type: string; payload: unknown; updatedAt: Date }>;
    } = {}
  ) {
    const findFirst = vi.fn(async ({ where }: { where: { type: { in: string[] } } }) => {
      const at = where.type.in.includes("GENERATE_BOOK")
        ? rows.long
        : where.type.in.includes("PREPARE_COMPOSITION")
          ? rows.background
          : rows.interactive;
      return at ? { updatedAt: at } : null;
    });
    // Oldest first and bounded, as Postgres answers the scan.
    const findMany = vi.fn(async ({ where, take }: { where: { type: { in: string[] } }; take: number }) =>
      (rows.laned ?? []).filter((row) => where.type.in.includes(row.type))
        .sort((left, right) => left.updatedAt.getTime() - right.updatedAt.getTime()).slice(0, take));
    return { $queryRaw: vi.fn(async () => [{ "?column?": 1 }]), generationJob: { findFirst, findMany } };
  }

  it("refuses to queue a PING behind a Redis that is not connected", async () => {
    const redis = fakeRedis("reconnecting");
    const deps = readinessDeps({ db: fakeDb() as never, redis, storageReady: async () => undefined, mailReady: async () => undefined });
    await expect(deps.pingRedis()).rejects.toThrow("Redis connection is reconnecting");
    await expect(deps.readHeartbeats()).rejects.toThrow("reconnecting");
    expect(redis.ping).not.toHaveBeenCalled();
    expect(redis.mget).not.toHaveBeenCalled();
  });

  it("reads every lane's heartbeat key in one MGET", async () => {
    const redis = fakeRedis("ready", [JSON.stringify(beat("long")), null, JSON.stringify(beat("images")), null, JSON.stringify(beat("background"))]);
    const deps = readinessDeps({ db: fakeDb() as never, redis, storageReady: async () => undefined, mailReady: async () => undefined });
    expect(await deps.readHeartbeats()).toEqual({
      long: beat("long"),
      interactive: null,
      images: beat("images"),
      compile: null,
      background: beat("background")
    });
    expect(redis.mget).toHaveBeenCalledWith(
      workerHeartbeatKey(LONG_JOB_QUEUE),
      workerHeartbeatKey(INTERACTIVE_JOB_QUEUE),
      workerHeartbeatKey(IMAGE_JOB_QUEUE),
      workerHeartbeatKey(COMPILE_JOB_QUEUE),
      workerHeartbeatKey(BACKGROUND_JOB_QUEUE)
    );
  });

  it("places a payload-laned waiting row in the lane its payload names", async () => {
    const old = new Date(NOW - 50 * MINUTE);
    const db = fakeDb({
      long: new Date(NOW - 5 * MINUTE),
      interactive: null,
      laned: [
        // An edit's recompile skips the final review: a reader is waiting on it.
        { type: "COMPILE_EXPORT", payload: { skipFinalReview: true }, updatedAt: old },
        // A generation's own compile waits in the compile lane, and its pictures in the image lane.
        { type: "COMPILE_EXPORT", payload: {}, updatedAt: new Date(NOW - 2 * MINUTE) },
        { type: "GENERATE_IMAGE", payload: { planId: "p", pageId: "x" }, updatedAt: new Date(NOW - 7 * MINUTE) }
      ]
    });
    const deps = readinessDeps({ db: db as never, redis: fakeRedis(), storageReady: async () => undefined, mailReady: async () => undefined });
    expect(await deps.oldestWaitingJobs()).toEqual({
      long: new Date(NOW - 5 * MINUTE),
      interactive: old,
      images: new Date(NOW - 7 * MINUTE),
      compile: new Date(NOW - 2 * MINUTE),
      background: null
    });
    for (const call of db.generationJob.findFirst.mock.calls) {
      expect(call[0]).toMatchObject({ where: { status: "QUEUED" }, orderBy: { updatedAt: "asc" } });
    }
  });

  it("reads the background lane's oldest waiting prep apart from the interactive lane's", async () => {
    const prep = new Date(NOW - 4 * MINUTE);
    const db = fakeDb({ interactive: new Date(NOW - MINUTE), background: prep });
    const deps = readinessDeps({ db: db as never, redis: fakeRedis(), storageReady: async () => undefined, mailReady: async () => undefined });
    expect(await deps.oldestWaitingJobs()).toEqual({ ...NOTHING_WAITING, interactive: new Date(NOW - MINUTE), background: prep });
    const background = db.generationJob.findFirst.mock.calls.find((call) => call[0].where.type.in.includes("PREPARE_COMPOSITION"));
    expect(background?.[0].where.type.in).toEqual(["PREPARE_COMPOSITION"]);
  });

  it("counts a waiting whole-book edit against the long lane and a short edit against the interactive one", async () => {
    const wholeBook = new Date(NOW - 40 * MINUTE);
    const shortEdit = new Date(NOW - 3 * MINUTE);
    const db = fakeDb({
      laned: [
        { type: "APPLY_BOOK_EDIT", payload: { affectedPageIndexes: Array.from({ length: 120 }, (_, i) => i + 1) }, updatedAt: wholeBook },
        { type: "APPLY_BOOK_EDIT", payload: { affectedPageIndexes: [3, 4] }, updatedAt: shortEdit }
      ]
    });
    const deps = readinessDeps({ db: db as never, redis: fakeRedis(), storageReady: async () => undefined, mailReady: async () => undefined });
    expect(await deps.oldestWaitingJobs()).toEqual({ ...NOTHING_WAITING, long: wholeBook, interactive: shortEdit });
  });

  it("never lets another type's backlog fill the scan in front of the oldest waiting compile", async () => {
    // 250 pictures waiting longer than the compile: one shared oldest-first scan
    // of 200 rows held only pictures, and `queue_compile` read "nothing waiting".
    const pictures = Array.from({ length: 250 }, (_, i) => ({
      type: "GENERATE_IMAGE", payload: { planId: "p", pageId: `page-${i}` }, updatedAt: new Date(NOW - 90 * MINUTE + i)
    }));
    const compile = new Date(NOW - 70 * MINUTE);
    const db = fakeDb({ laned: [...pictures, { type: "COMPILE_EXPORT", payload: {}, updatedAt: compile }] });
    const deps = readinessDeps({ db: db as never, redis: fakeRedis(), storageReady: async () => undefined, mailReady: async () => undefined });
    expect(await deps.oldestWaitingJobs()).toEqual({ ...NOTHING_WAITING, images: pictures[0]!.updatedAt, compile });
  });

  it("asks about every job type in exactly one of its reads", async () => {
    const db = fakeDb();
    const deps = readinessDeps({ db: db as never, redis: fakeRedis(), storageReady: async () => undefined, mailReady: async () => undefined });
    await deps.oldestWaitingJobs();
    const asked = [
      ...db.generationJob.findFirst.mock.calls.flatMap((call) => call[0].where.type.in),
      ...(db.generationJob.findMany.mock.calls as unknown as Array<[{ where: { type: { in: string[] } } }]>).flatMap(
        (call) => call[0].where.type.in
      )
    ];
    expect([...asked].sort()).toEqual(Object.keys(JOB_LANES).sort());
  });
});
