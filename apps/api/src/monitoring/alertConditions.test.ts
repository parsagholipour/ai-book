import { describe, expect, it, vi } from "vitest";
import { STOPPED_JOB_ERROR, STOPPED_JOB_MESSAGE } from "@book-maker/core";
import {
  ALERT_CONDITIONS,
  DISK_CLEAR_AT,
  DISK_FIRE_BELOW,
  diskObservation,
  diskSource,
  failedJobsSource,
  observeAlertConditions,
  safetyReportsObservation,
  safetyReportsSource,
  type AlertSources,
  type SpendSnapshot
} from "./alertConditions.js";
import { freshAlertState } from "./alertState.js";
import { PROVIDER_QUOTA_ACCOUNTS, providerQuotaConditionKey } from "./providerQuota.js";
import { ADVISORY_CHECKS, MONITORED_CHECKS, READINESS_CHECKS } from "./readiness.js";

const GIB = 1024 ** 3;
const disk = (freeRatio: number, inodeRatio = 0.9) => ({
  freeBytes: freeRatio * 30 * GIB,
  totalBytes: 30 * GIB,
  freeInodes: inodeRatio * 1000,
  totalInodes: 1000
});

/** The breaker's default caps, with today's and the month's spend. */
function spendAt(spend: Partial<SpendSnapshot>): SpendSnapshot {
  return {
    freeSpendUsd: 0,
    monthFreeSpendUsd: 0,
    paidSpendUsd: 0,
    softDailyCapUsd: 5,
    hardDailyCapUsd: 12,
    freeMonthlyCapUsd: 150,
    paidHardDailyCapUsd: 60,
    ...spend
  };
}

describe("the alert conditions", () => {
  it("cover every readiness and advisory check, the spend breaker's four caps, failed jobs, the disk, open safety reports and each provider account, once each", () => {
    expect(ALERT_CONDITIONS.map((condition) => condition.key).sort()).toEqual(
      [
        ...READINESS_CHECKS,
        ...ADVISORY_CHECKS,
        "spend_soft",
        "spend_hard",
        "spend_monthly",
        "spend_paid",
        "failed_jobs",
        "disk",
        "safety_reports",
        ...PROVIDER_QUOTA_ACCOUNTS.map(providerQuotaConditionKey)
      ].sort()
    );
  });

  it("fire on the first sweep that sees an open safety report, and clear on the first that sees none", () => {
    expect(ALERT_CONDITIONS.find((condition) => condition.key === "safety_reports")?.policy).toMatchObject({
      confirmSweeps: 1,
      clearSweeps: 1
    });
  });

  it("send the spend caps at most once per UTC day", () => {
    for (const key of ["spend_soft", "spend_hard", "spend_monthly", "spend_paid"]) {
      expect(ALERT_CONDITIONS.find((condition) => condition.key === key)?.policy.repeat).toEqual({ kind: "utc-day" });
    }
  });
});

describe("diskObservation", () => {
  it("fires under 15% free and clears only at 17%, so a disk at the line is one alert", () => {
    expect(diskObservation(disk(DISK_FIRE_BELOW + 0.005), false)).toEqual({ failing: false });
    expect(diskObservation(disk(DISK_FIRE_BELOW - 0.005), false)).toMatchObject({ failing: true });
    // Back above 15% but under 17%: still low for a disk that was already firing.
    expect(diskObservation(disk(0.16), true)).toMatchObject({ failing: true });
    expect(diskObservation(disk(DISK_CLEAR_AT + 0.005), true)).toEqual({ failing: false });
  });

  it("fires on exhausted inodes with space to spare", () => {
    expect(diskObservation(disk(0.6, 0.05), false)).toEqual({
      failing: true,
      detail: "60.0% free (18.0 GiB of 30.0 GiB), 5.0% of inodes free on the disk that holds Docker, PostgreSQL and Redis"
    });
  });

  it("reads the filesystem this process runs on", async () => {
    const stats = await diskSource()();
    expect(stats.totalBytes).toBeGreaterThan(0);
    expect(stats.freeBytes).toBeLessThanOrEqual(stats.totalBytes);
  });
});

describe("observeAlertConditions", () => {
  const healthy: AlertSources = {
    readiness: async () => ({
      ok: true,
      checkedAt: new Date(),
      results: Object.fromEntries(MONITORED_CHECKS.map((check) => [check, { ok: true }])) as never
    }),
    spend: async () => spendAt({ freeSpendUsd: 4.99, monthFreeSpendUsd: 149.99, paidSpendUsd: 59.99 }),
    failedJobsSince: async () => [{ type: "GENERATE_BOOK" }],
    disk: async () => disk(0.5),
    openSafetyReports: async () => ({ childSafety: 0, sexualContent: 0, heldBookText: 0, oldestAt: null }),
    providerCallOutcomesSince: async () => [
      { provider: "openai", exhaustedAt: null, refusals: 0, answeredAt: new Date() },
      { provider: "deepseek", exhaustedAt: null, refusals: 0, answeredAt: new Date() }
    ]
  };

  it("passes everything on a quiet day", async () => {
    const observations = await observeAlertConditions(healthy, new Map(), new Date());
    expect([...observations.values()].every((observation) => observation?.failing === false)).toBe(true);
    expect(observations.size).toBe(ALERT_CONDITIONS.length);
  });

  it("leaves a condition unmeasured when its source cannot be read, rather than failing it", async () => {
    const broken: AlertSources = {
      readiness: async () => Promise.reject(new Error("probe crashed")),
      spend: async () => Promise.reject(new Error("db")),
      failedJobsSince: async () => Promise.reject(new Error("db")),
      disk: async () => Promise.reject(new Error("EACCES")),
      openSafetyReports: async () => Promise.reject(new Error("db")),
      providerCallOutcomesSince: async () => Promise.reject(new Error("db"))
    };
    const observations = await observeAlertConditions(broken, new Map(), new Date());
    expect([...observations.values()].every((observation) => observation === null)).toBe(true);
  });

  it("compares free spend to the free caps and paid spend to the paid cap, each on its own", async () => {
    const observe = async (spend: Partial<SpendSnapshot>) =>
      observeAlertConditions({ ...healthy, spend: async () => spendAt(spend) }, new Map(), new Date());

    // A paying reader's heavy day trips no free cap.
    const paidDay = await observe({ freeSpendUsd: 1, paidSpendUsd: 45 });
    expect(["spend_soft", "spend_hard", "spend_monthly", "spend_paid"].map((key) => paidDay.get(key as never)?.failing)).toEqual([
      false,
      false,
      false,
      false
    ]);

    const freeDay = await observe({ freeSpendUsd: 12 });
    expect(freeDay.get("spend_soft")).toMatchObject({ failing: true });
    expect(freeDay.get("spend_hard")).toEqual({
      failing: true,
      detail:
        "$12.00 of free-account and unattributed provider spend today (UTC) is past the $12.00 hard cap: free accounts start no new AI work until 00:00 UTC; paid plans are unaffected"
    });
    expect(freeDay.get("spend_paid")).toEqual({ failing: false });

    const month = await observe({ freeSpendUsd: 2, monthFreeSpendUsd: 151 });
    expect(month.get("spend_monthly")).toMatchObject({ failing: true, detail: expect.stringContaining("$150.00 monthly ceiling") });
    expect(month.get("spend_soft")).toEqual({ failing: false });

    const runaway = await observe({ paidSpendUsd: 60 });
    expect(runaway.get("spend_paid")).toMatchObject({ failing: true, detail: expect.stringContaining("$60.00 paid cap") });
    expect(runaway.get("spend_hard")).toEqual({ failing: false });
  });

  it("alerts on a failing advisory check while readiness itself still passes", async () => {
    const reason = "no heartbeat from the background lane for over 90 s";
    const observations = await observeAlertConditions(
      {
        ...healthy,
        readiness: async () => ({
          ok: true,
          checkedAt: new Date(),
          results: {
            ...Object.fromEntries(MONITORED_CHECKS.map((check) => [check, { ok: true }])),
            worker_background: { ok: false, reason }
          } as never
        })
      },
      new Map(),
      new Date()
    );
    expect(observations.get("worker_background")).toEqual({ failing: true, detail: reason });
    expect(observations.get("worker_long")).toEqual({ failing: false });
  });

  it("reads the disk's hysteresis off the previous state", async () => {
    const sources = { ...healthy, disk: async () => disk(0.16) };
    const firing = new Map([["disk", { ...freshAlertState("disk"), firing: true }]]);
    expect((await observeAlertConditions(sources, new Map(), new Date())).get("disk")).toEqual({ failing: false });
    expect((await observeAlertConditions(sources, firing, new Date())).get("disk")).toMatchObject({ failing: true });
  });
});

describe("failedJobsSource", () => {
  it("counts failures in the window and leaves out a reader's own stops, null columns included", async () => {
    const findMany = vi.fn(async () => [{ type: "GENERATE_BOOK" }]);
    const since = new Date("2026-10-13T11:00:00.000Z");
    expect(await failedJobsSource({ generationJob: { findMany } } as never)(since, 100)).toEqual([{ type: "GENERATE_BOOK" }]);
    expect(findMany).toHaveBeenCalledWith({
      where: {
        status: "FAILED",
        finishedAt: { gte: since },
        AND: [
          { OR: [{ error: null }, { error: { not: STOPPED_JOB_ERROR } }] },
          { OR: [{ message: null }, { message: { not: STOPPED_JOB_MESSAGE } }] }
        ]
      },
      select: { type: true },
      take: 100
    });
  });
});

describe("safetyReportsObservation", () => {
  it("passes with nothing open and says how many of each are open otherwise", () => {
    expect(safetyReportsObservation({ childSafety: 0, sexualContent: 0, heldBookText: 0, oldestAt: null })).toEqual({ failing: false });
    expect(
      safetyReportsObservation({ childSafety: 1, sexualContent: 2, heldBookText: 0, oldestAt: new Date("2026-10-13T09:41:30.000Z") })
    ).toEqual({
      failing: true,
      detail: "3 open: 1 child-safety report, 2 sexual-content reports; the oldest arrived 2026-10-13 09:41 UTC"
    });
    expect(safetyReportsObservation({ childSafety: 0, sexualContent: 0, heldBookText: 1, oldestAt: null })).toEqual({
      failing: true,
      detail: "1 open: 1 shared book held for review of its text"
    });
  });
});

describe("safetyReportsSource", () => {
  it("counts PENDING child-safety and sexual-content reports and held book texts, and finds the oldest", async () => {
    const count = vi.fn(async ({ where }: { where: Record<string, unknown> }) =>
      where.reason === "CHILD_SAFETY" ? 2 : where.reason === "SEXUAL_CONTENT" ? 1 : 4
    );
    const oldestAt = new Date("2026-10-12T22:00:00.000Z");
    const findFirst = vi.fn(async () => ({ createdAt: oldestAt }));

    const counts = await safetyReportsSource({ moderationReport: { count, findFirst } } as never)();

    expect(counts).toEqual({ childSafety: 2, sexualContent: 1, heldBookText: 4, oldestAt });
    const heldBookText = { reporterUserId: null, targetSnapshot: { path: ["kind"], equals: "book_text_review" } };
    expect(count.mock.calls.map(([args]) => args)).toEqual([
      { where: { status: "PENDING", reason: "CHILD_SAFETY" } },
      { where: { status: "PENDING", reason: "SEXUAL_CONTENT" } },
      { where: { status: "PENDING", ...heldBookText } }
    ]);
    expect(findFirst).toHaveBeenCalledWith({
      where: { status: "PENDING", OR: [{ reason: { in: ["CHILD_SAFETY", "SEXUAL_CONTENT"] } }, heldBookText] },
      orderBy: { createdAt: "asc" },
      select: { createdAt: true }
    });
  });
});
