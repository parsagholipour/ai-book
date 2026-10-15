import { describe, expect, it, vi } from "vitest";
import type { Mailer, MailMessage } from "../mailer.js";
import type { AlertSources, DiskSnapshot } from "./alertConditions.js";
import type { AlertState } from "./alertState.js";
import {
  composeAlertEmail,
  createOperatorAlertSweep,
  prismaAlertStore,
  SWEEP_CLAIM_KEY,
  type AlertStore
} from "./operatorAlerts.js";
import { READINESS_CHECKS, type ReadinessCheck, type ReadinessReport } from "./readiness.js";

const MINUTE = 60_000;
const START = Date.parse("2026-10-13T12:00:00.000Z");

type World = {
  failing: Partial<Record<ReadinessCheck, string>>;
  unmeasured: ReadinessCheck[];
  /** Free-account spend today; the month and paid spend stay quiet. */
  spendUsd: number;
  failedJobs: string[];
  disk: DiskSnapshot;
  childSafetyReports: number;
};

function world(): World {
  return {
    failing: {},
    unmeasured: [],
    spendUsd: 1,
    failedJobs: [],
    disk: { freeBytes: 20 * 1024 ** 3, totalBytes: 30 * 1024 ** 3, freeInodes: 900, totalInodes: 1000 },
    childSafetyReports: 0
  };
}

function sourcesFor(state: World): AlertSources {
  return {
    async readiness(): Promise<ReadinessReport> {
      const results = Object.fromEntries(
        READINESS_CHECKS.map((check) => {
          const reason = state.failing[check];
          if (reason === undefined) return [check, { ok: true }];
          return [check, state.unmeasured.includes(check) ? { ok: false, reason, unmeasured: true } : { ok: false, reason }];
        })
      ) as ReadinessReport["results"];
      return { ok: Object.keys(state.failing).length === 0, checkedAt: new Date(), results };
    },
    spend: async () => ({
      freeSpendUsd: state.spendUsd,
      monthFreeSpendUsd: state.spendUsd,
      paidSpendUsd: 0,
      softDailyCapUsd: 5,
      hardDailyCapUsd: 12,
      freeMonthlyCapUsd: 150,
      paidHardDailyCapUsd: 60
    }),
    failedJobsSince: async () => state.failedJobs.map((type) => ({ type })),
    disk: async () => state.disk,
    openSafetyReports: async () => ({ childSafety: state.childSafetyReports, sexualContent: 0, heldBookText: 0, oldestAt: null })
  };
}

/** The table's semantics, in memory: a claim is a compare-and-set on the `sweep` row. */
function memoryStore() {
  const rows = new Map<string, AlertState>();
  let claimAt: Date | null = null;
  let unavailable = false;
  const guard = () => {
    if (unavailable) throw new Error("Can't reach database server");
  };
  const store: AlertStore & { rows: typeof rows; setUnavailable(value: boolean): void } = {
    rows,
    setUnavailable: (value) => {
      unavailable = value;
    },
    async claim(_owner, now, minGapMs) {
      guard();
      if (claimAt && claimAt.getTime() > now.getTime() - minGapMs) return false;
      claimAt = now;
      return true;
    },
    async load(keys) {
      guard();
      return keys.flatMap((key) => (rows.has(key) ? [{ ...rows.get(key)! }] : []));
    },
    async save(states) {
      guard();
      for (const state of states) rows.set(state.key, { ...state });
    }
  };
  return store;
}

function recordingMailer() {
  const sent: MailMessage[] = [];
  const mailer: Mailer & { sent: MailMessage[] } = {
    sent,
    send: vi.fn(async (message: MailMessage) => {
      sent.push(message);
    })
  };
  return mailer;
}

function quietLog() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

function harness(options: { store?: ReturnType<typeof memoryStore>; recipient?: string | undefined; mailer?: Mailer; state?: World } = {}) {
  const state = options.state ?? world();
  const store = options.store ?? memoryStore();
  const mailer = options.mailer ?? recordingMailer();
  const log = quietLog();
  let now = START;
  const sweep = createOperatorAlertSweep({
    store,
    sources: sourcesFor(state),
    mailer,
    recipient: "recipient" in options ? options.recipient : "owner@ravanix.app",
    publicUrl: "https://tomeza.ravanix.app",
    log,
    now: () => new Date(now),
    emailTimeoutMs: 50
  });
  const minutes = async (count: number) => {
    const results = [];
    for (let index = 0; index < count; index += 1) {
      results.push(await sweep.run());
      now += MINUTE;
    }
    return results;
  };
  return { state, store, mailer, log, sweep, minutes, setNow: (at: number) => (now = at), now: () => now };
}

describe("the operator alert sweep", () => {
  it("emails once, naming the check and what to look at, after three failing minutes", async () => {
    const { state, mailer, minutes } = harness();
    state.failing.worker_long = "no heartbeat from the long lane for over 90 s";

    await minutes(2);
    expect((mailer as ReturnType<typeof recordingMailer>).sent).toHaveLength(0);
    await minutes(10);

    const sent = (mailer as ReturnType<typeof recordingMailer>).sent;
    expect(sent).toHaveLength(1);
    expect(sent[0]!.to).toBe("owner@ravanix.app");
    expect(sent[0]!.subject).toBe("[Tomeza] ALERT: Worker, long lane (books, narration, imports)");
    expect(sent[0]!.text).toContain("no heartbeat from the long lane for over 90 s");
    expect(sent[0]!.text).toContain("First check: docker compose");
    expect(sent[0]!.text).toContain("https://tomeza.ravanix.app/api/ready");
  });

  it("sends one email for conditions that move together, and none for checks only their cause broke", async () => {
    const { state, mailer, minutes } = harness();
    state.failing = { redis: "Redis connection is reconnecting", worker_long: "unreadable", worker_interactive: "unreadable" };
    state.unmeasured = ["worker_long", "worker_interactive"];
    state.spendUsd = 13;

    await minutes(3);
    const sent = (mailer as ReturnType<typeof recordingMailer>).sent;
    expect(sent.map((message) => message.subject)).toEqual([
      "[Tomeza] ALERT: Free-account AI spend past the soft daily cap, Free-account AI spend past the hard daily cap (new AI work refused for free accounts)",
      "[Tomeza] ALERT: Redis (the job queue)"
    ]);
    expect(sent.every((message) => !message.text.includes("Worker,"))).toBe(true);
  });

  it("emails the recovery once the check has passed twice, saying since when it failed", async () => {
    const { state, mailer, minutes } = harness();
    state.failing.db = "timed out after 3000 ms";
    await minutes(4);
    delete state.failing.db;
    await minutes(1);
    expect((mailer as ReturnType<typeof recordingMailer>).sent).toHaveLength(1);
    await minutes(5);

    const sent = (mailer as ReturnType<typeof recordingMailer>).sent;
    expect(sent).toHaveLength(2);
    expect(sent[1]!.subject).toBe("[Tomeza] Recovered: Database (PostgreSQL)");
    expect(sent[1]!.text).toContain("was failing since 2026-10-13 12:02 UTC (timed out after 3000 ms)");
  });

  it("does not spam a check that flaps: one alert and one recovery an hour at most", async () => {
    const { state, mailer, minutes } = harness();
    for (let cycle = 0; cycle < 12; cycle += 1) {
      state.failing.storage = "HeadBucket timed out";
      await minutes(3);
      delete state.failing.storage;
      await minutes(2);
    }
    // An hour of fail-for-three, pass-for-two.
    expect((mailer as ReturnType<typeof recordingMailer>).sent.map((message) => message.subject.split(":")[0])).toEqual([
      "[Tomeza] ALERT",
      "[Tomeza] Recovered"
    ]);
  });

  it("remembers across a restart what it already told the owner, and still owes the recovery", async () => {
    const store = memoryStore();
    const mailer = recordingMailer();
    const state = world();
    state.failing.queue_interactive = "the oldest waiting interactive-lane job has waited 20 min (limit 15 min)";
    const first = harness({ store, mailer, state });
    await first.minutes(5);
    expect(mailer.sent).toHaveLength(1);

    // A new process: empty memory, the same table.
    const second = harness({ store, mailer, state });
    second.setNow(first.now() + MINUTE);
    await second.minutes(10);
    expect(mailer.sent).toHaveLength(1);

    delete state.failing.queue_interactive;
    await second.minutes(2);
    expect(mailer.sent.map((message) => message.subject)).toEqual([
      "[Tomeza] ALERT: Interactive lane backlog",
      "[Tomeza] Recovered: Interactive lane backlog"
    ]);
  });

  it("lets only the process holding the claim send, however many sweep", async () => {
    const store = memoryStore();
    const mailer = recordingMailer();
    const state = world();
    state.failing.db = "down";
    const a = harness({ store, mailer, state });
    const b = harness({ store, mailer, state });
    for (let minute = 0; minute < 6; minute += 1) {
      const at = START + minute * MINUTE;
      a.setNow(at);
      b.setNow(at + 10_000);
      const [ra] = await a.minutes(1);
      const [rb] = await b.minutes(1);
      expect(ra!.sender).toBe(true);
      expect(rb!.sender).toBe(false);
    }
    expect(mailer.sent).toHaveLength(1);
  });

  it("logs a failed email and carries on, without retrying it every minute", async () => {
    const mailer: Mailer = { send: vi.fn(async () => Promise.reject(new Error("SMTP 535 authentication failed"))) };
    const { state, log, minutes, store } = harness({ mailer });
    state.failing.redis = "down";

    const results = await minutes(6);
    expect(results.every((result) => result.sender)).toBe(true);
    expect(mailer.send).toHaveBeenCalledTimes(1);
    expect(log.error).toHaveBeenCalledWith(
      expect.objectContaining({ event: "operator_alert.email_failed", alerts: ["redis"] }),
      expect.any(String)
    );
    expect(store.rows.get("redis")).toMatchObject({ firing: true, notified: true });
  });

  it("gives up on an email the server never answers, and the next sweep still runs", async () => {
    const mailer: Mailer = { send: vi.fn(() => new Promise<void>(() => undefined)) };
    const { state, log, minutes } = harness({ mailer });
    state.failing.redis = "down";
    const results = await minutes(4);
    expect(results).toHaveLength(4);
    expect(log.error).toHaveBeenCalledWith(expect.objectContaining({ event: "operator_alert.email_failed" }), expect.any(String));
  });

  it("only logs when no address is configured", async () => {
    const mailer = recordingMailer();
    const { state, log, minutes } = harness({ mailer, recipient: undefined });
    state.failing.worker_interactive = "no heartbeat";
    const results = await minutes(4);

    expect(mailer.send).not.toHaveBeenCalled();
    expect(results.some((result) => result.notifications.length > 0 && !result.emailed)).toBe(true);
    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ event: "operator_alert.firing", alert: "worker_interactive", detail: "no heartbeat" }),
      "Operator alert firing"
    );
  });

  it("still alerts while its own table is unreachable, and writes its memory back when it returns", async () => {
    const store = memoryStore();
    const mailer = recordingMailer();
    const { state, log, minutes } = harness({ store, mailer });
    store.setUnavailable(true);
    state.failing.db = "Can't reach database server";

    await minutes(4);
    expect(mailer.sent.map((message) => message.subject)).toEqual(["[Tomeza] ALERT: Database (PostgreSQL)"]);
    expect(log.warn).toHaveBeenCalledWith(expect.objectContaining({ event: "operator_alert.state_unavailable" }), expect.any(String));
    expect(store.rows.size).toBe(0);

    store.setUnavailable(false);
    delete state.failing.db;
    await minutes(3);
    expect(mailer.sent.map((message) => message.subject)).toEqual([
      "[Tomeza] ALERT: Database (PostgreSQL)",
      "[Tomeza] Recovered: Database (PostgreSQL)"
    ]);
    expect(store.rows.get("db")).toMatchObject({ firing: false, notified: false });
  });

  it("emails a burst of failed jobs with what failed, and the disk running out", async () => {
    const { state, mailer, minutes } = harness();
    state.failedJobs = ["GENERATE_BOOK", "GENERATE_IMAGE", "GENERATE_IMAGE", "PLAN_BOOK", "GENERATE_IMAGE"];
    state.disk = { freeBytes: 3 * 1024 ** 3, totalBytes: 30 * 1024 ** 3, freeInodes: 900, totalInodes: 1000 };
    await minutes(2);

    const text = (mailer as ReturnType<typeof recordingMailer>).sent.map((message) => message.text).join("\n");
    expect(text).toContain("5 generation jobs failed in the last hour (alert at 5): 3 GENERATE_IMAGE, 1 GENERATE_BOOK, 1 PLAN_BOOK");
    expect(text).toContain("10.0% free (3.0 GiB of 30.0 GiB)");
  });

  it("emails the first open child-safety report on the sweep that sees it, once, and the all-clear when it is settled", async () => {
    const { state, mailer, minutes } = harness();
    state.childSafetyReports = 1;
    await minutes(1);

    const sent = (mailer as ReturnType<typeof recordingMailer>).sent;
    expect(sent).toHaveLength(1);
    expect(sent[0]!.subject).toBe("[Tomeza] ALERT: Open child-safety or sexual-content reports");
    expect(sent[0]!.text).toContain("1 open: 1 child-safety report");
    expect(sent[0]!.text).toContain("First check: /admin/moderation");

    // A second report while it fires is the same alert, not a second email.
    state.childSafetyReports = 2;
    await minutes(5);
    expect(sent).toHaveLength(1);

    state.childSafetyReports = 0;
    await minutes(1);
    expect(sent).toHaveLength(2);
    expect(sent[1]!.subject).toBe("[Tomeza] Recovered: Open child-safety or sexual-content reports");
  });
});

describe("composeAlertEmail", () => {
  it("puts alerts and recoveries in one message", () => {
    const message = composeAlertEmail(
      [
        { key: "disk", kind: "firing", detail: "12.0% free", firingSince: new Date(START) },
        { key: "db", kind: "recovered", detail: null, firingSince: null }
      ],
      [
        { key: "disk", label: "Low free disk on the host", policy: { confirmSweeps: 1, clearSweeps: 1, repeat: { kind: "utc-day" } }, hint: "df -h /" },
        { key: "db", label: "Database (PostgreSQL)", policy: { confirmSweeps: 1, clearSweeps: 1, repeat: { kind: "utc-day" } }, hint: "ps" }
      ],
      { to: "owner@ravanix.app", publicUrl: "https://tomeza.ravanix.app/", now: new Date(START) }
    );
    expect(message.subject).toBe("[Tomeza] ALERT: Low free disk on the host; recovered: Database (PostgreSQL)");
    expect(message.text).toContain("FIRING\n- Low free disk on the host: 12.0% free\n  First check: df -h /");
    expect(message.text).toContain("RECOVERED\n- Database (PostgreSQL): was failing.");
    expect(message.text).toContain("Readiness right now: https://tomeza.ravanix.app/api/ready");
  });
});

describe("prismaAlertStore", () => {
  /** `updateMany`'s WHERE re-checked against the row, as Postgres does after the row lock. */
  function fakeTable() {
    const rows = new Map<string, Record<string, unknown>>();
    const matchesClaim = (row: Record<string, unknown>, where: { OR: Array<{ observedAt: null | { lte: Date } }> }) =>
      where.OR.some((clause) =>
        clause.observedAt === null ? row.observedAt == null : (row.observedAt as Date) <= clause.observedAt.lte
      );
    return {
      rows,
      operatorAlert: {
        updateMany: vi.fn(async ({ where, data }: { where: { key: string; OR: never }; data: Record<string, unknown> }) => {
          const row = rows.get(where.key);
          if (!row || !matchesClaim(row, where)) return { count: 0 };
          Object.assign(row, data);
          return { count: 1 };
        }),
        createMany: vi.fn(async ({ data }: { data: Array<Record<string, unknown>> }) => {
          let count = 0;
          for (const row of data) {
            if (rows.has(row.key as string)) continue;
            rows.set(row.key as string, { ...row });
            count += 1;
          }
          return { count };
        }),
        findMany: vi.fn(async ({ where }: { where: { key: { in: string[] } } }) =>
          where.key.in.flatMap((key) => (rows.has(key) ? [rows.get(key)] : []))
        ),
        upsert: vi.fn(async ({ where, create, update }: { where: { key: string }; create: Record<string, unknown>; update: Record<string, unknown> }) => {
          const row = rows.get(where.key);
          rows.set(where.key, row ? { ...row, ...update } : { ...create });
        })
      }
    };
  }

  it("hands the interval to one claimant, the first one ever included, and frees it after half an interval", async () => {
    const table = fakeTable();
    const store = prismaAlertStore(table as never);
    const at = (offset: number) => new Date(START + offset);

    expect(await store.claim("a", at(0), 30_000)).toBe(true);
    expect(await store.claim("b", at(0), 30_000)).toBe(false);
    expect(await store.claim("b", at(10_000), 30_000)).toBe(false);
    expect(table.rows.get(SWEEP_CLAIM_KEY)).toMatchObject({ claimedBy: "a" });
    expect(await store.claim("b", at(30_000), 30_000)).toBe(true);
    expect(table.rows.get(SWEEP_CLAIM_KEY)).toMatchObject({ claimedBy: "b", observedAt: at(30_000) });
  });

  it("writes every condition and reads back only the ones asked for", async () => {
    const table = fakeTable();
    const store = prismaAlertStore(table as never);
    const state: AlertState = {
      key: "db",
      firing: true,
      notified: true,
      failingSweeps: 4,
      passingSweeps: 0,
      detail: "down",
      firingSince: new Date(START),
      lastFiredAt: new Date(START),
      lastRecoveredAt: null,
      observedAt: new Date(START)
    };
    await store.claim("a", new Date(START), 30_000);
    await store.save([state]);
    await store.save([{ ...state, failingSweeps: 5 }]);
    expect(await store.load(["db", "redis"])).toEqual([{ ...state, failingSweeps: 5 }]);
  });
});
