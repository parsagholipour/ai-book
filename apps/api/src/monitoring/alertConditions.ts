import { statfs } from "node:fs/promises";
import { STOPPED_JOB_ERROR, STOPPED_JOB_MESSAGE } from "@book-maker/core";
import type { Prisma } from "@book-maker/db";
import type { AlertObservation, AlertPolicy, AlertState } from "./alertState.js";
import {
  PROVIDER_QUOTA_ACCOUNTS,
  PROVIDER_QUOTA_WINDOW_MS,
  providerQuotaConditionKey,
  providerQuotaLabel,
  providerQuotaObservations,
  type ProviderCallOutcome,
  type ProviderQuotaConditionKey
} from "./providerQuota.js";
import { MONITORED_CHECKS, type MonitoredCheck, type ReadinessReport } from "./readiness.js";

/**
 * What the operator alert sweep watches, how long each must hold before it is
 * an email, and what to look at first when it is. The runbook behind every
 * hint is docs/deployment.md, "Monitoring and alerts".
 */

export type AlertConditionKey =
  | MonitoredCheck
  | "spend_soft"
  | "spend_hard"
  | "spend_monthly"
  | "spend_paid"
  | "failed_jobs"
  | "disk"
  | "safety_reports"
  | ProviderQuotaConditionKey;

export type AlertCondition = {
  key: AlertConditionKey;
  label: string;
  policy: AlertPolicy;
  /** The first thing to check, in one line. */
  hint: string;
};

const HOUR = 60 * 60_000;

/** Three minutes of a failing check at one sweep a minute: past a deploy's restart, short of an afternoon. */
const READINESS_POLICY: AlertPolicy = { confirmSweeps: 3, clearSweeps: 2, repeat: { kind: "cooldown", ms: HOUR } };
/** The breaker's own rhythm: a cap is a state of the UTC day (or month), so at most one email per state per day. */
const SPEND_POLICY: AlertPolicy = { confirmSweeps: 1, clearSweeps: 1, repeat: { kind: "utc-day" } };
const FAILED_JOBS_POLICY: AlertPolicy = { confirmSweeps: 1, clearSweeps: 2, repeat: { kind: "cooldown", ms: HOUR } };
const DISK_POLICY: AlertPolicy = { confirmSweeps: 2, clearSweeps: 2, repeat: { kind: "cooldown", ms: HOUR } };
/**
 * A report is a fact, not a flicker: the first sweep that sees one fires, and
 * the first that sees none clears. Firing stays one email however many more
 * arrive while it lasts; the count in it is what was open when it was sent.
 */
const SAFETY_REPORTS_POLICY: AlertPolicy = { confirmSweeps: 1, clearSweeps: 1, repeat: { kind: "cooldown", ms: HOUR } };
/**
 * An empty account is a fact the provider stated, and it holds until the
 * account answers again (`providerQuota.ts`), so this needs no hysteresis of
 * its own: two sweeps let one misread refusal be answered by the next success,
 * and one answer clears it.
 */
const PROVIDER_QUOTA_POLICY: AlertPolicy = { confirmSweeps: 2, clearSweeps: 1, repeat: { kind: "cooldown", ms: HOUR } };

const COMPOSE = "docker compose --env-file .env -f docker-compose.production.yml";

export const ALERT_CONDITIONS: readonly AlertCondition[] = [
  {
    key: "db",
    label: "Database (PostgreSQL)",
    policy: READINESS_POLICY,
    hint: `${COMPOSE} ps postgres; ${COMPOSE} logs --tail 100 postgres; df -h /`
  },
  {
    key: "redis",
    label: "Redis (the job queue)",
    policy: READINESS_POLICY,
    hint: `${COMPOSE} logs --tail 100 redis; ${COMPOSE} exec redis redis-cli info memory (a full maxmemory refuses writes)`
  },
  {
    key: "storage",
    label: "Object storage (S3)",
    policy: READINESS_POLICY,
    hint: `${COMPOSE} logs --tail 100 api | grep -i bucket; the instance role, the bucket and S3_REGION`
  },
  {
    // Its own firing email cannot be delivered (the send is logged as
    // operator_alert.email_failed); the recovery email can, and tells the
    // owner which window of alerts and reset codes was lost. /api/ready is
    // what reports it while it lasts.
    key: "mail",
    label: "Outgoing mail (SMTP): password-reset codes and these alerts",
    policy: READINESS_POLICY,
    hint: `${COMPOSE} logs --tail 100 api | grep email.verify_failed; SMTP_URL's host, port, user and password; then POST /api/admin/monitoring/test-alert`
  },
  {
    key: "worker_long",
    label: "Worker, long lane (books, narration, imports)",
    policy: READINESS_POLICY,
    hint: `${COMPOSE} ps worker; ${COMPOSE} logs --tail 200 worker; docker inspect --format '{{.State.OOMKilled}}' book-maker-worker-1`
  },
  {
    key: "worker_interactive",
    label: "Worker, interactive lane (plans, edits, assists)",
    policy: READINESS_POLICY,
    hint: `${COMPOSE} ps worker; ${COMPOSE} logs --tail 200 worker; docker inspect --format '{{.State.OOMKilled}}' book-maker-worker-1`
  },
  {
    key: "worker_images",
    label: "Worker, image lane (a book's pictures and cover)",
    policy: READINESS_POLICY,
    hint: `${COMPOSE} ps worker; ${COMPOSE} logs --tail 200 worker; an older worker image consumes no image lane (docs/deployment.md, "Job lanes")`
  },
  {
    key: "worker_compile",
    label: "Worker, compile lane (a generated book's PDF)",
    policy: READINESS_POLICY,
    hint: `${COMPOSE} ps worker; ${COMPOSE} logs --tail 200 worker; docker inspect --format '{{.State.OOMKilled}}' book-maker-worker-1`
  },
  {
    // Advisory: not an /api/ready check (`ADVISORY_CHECKS` in readiness.ts).
    key: "worker_background",
    label: "Worker, background lane (composition prep while a reader reads the plan; books still start without it)",
    policy: READINESS_POLICY,
    hint: `${COMPOSE} ps worker; ${COMPOSE} logs --tail 200 worker; books meanwhile plan their own stance, episodes and forms, about a minute slower to their first chapter`
  },
  {
    key: "queue_long",
    label: "Long lane backlog",
    policy: READINESS_POLICY,
    hint: `the ACTIVE GenerationJob rows (startedAt) for a hung job; ${COMPOSE} logs --tail 200 worker`
  },
  {
    key: "queue_interactive",
    label: "Interactive lane backlog",
    policy: READINESS_POLICY,
    hint: `the ACTIVE GenerationJob rows (startedAt) for a hung job; ${COMPOSE} logs --tail 200 worker`
  },
  {
    key: "queue_images",
    label: "Image lane backlog",
    policy: READINESS_POLICY,
    hint: `the ACTIVE GENERATE_IMAGE rows (startedAt) for a hung picture, then the image provider's key and quota; ${COMPOSE} logs --tail 200 worker`
  },
  {
    key: "queue_compile",
    label: "Compile lane backlog",
    policy: READINESS_POLICY,
    hint: `the ACTIVE COMPILE_EXPORT rows (startedAt) for a hung render; ${COMPOSE} logs --tail 200 worker`
  },
  {
    // Advisory, like worker_background. A prep older than ten minutes exits unrun, so a backlog is never work owed.
    key: "queue_background",
    label: "Background lane backlog (composition prep; books still start without it)",
    policy: READINESS_POLICY,
    hint: `the ACTIVE PREPARE_COMPOSITION rows (startedAt) for a hung prep, then the text provider's key and quota; ${COMPOSE} logs --tail 200 worker`
  },
  {
    key: "spend_soft",
    label: "Free-account AI spend past the soft daily cap",
    policy: SPEND_POLICY,
    hint: "/admin/spend in the console: today's top spenders, then raise the cap or pause"
  },
  {
    key: "spend_hard",
    label: "Free-account AI spend past the hard daily cap (new AI work refused for free accounts)",
    policy: SPEND_POLICY,
    hint: "/admin/spend in the console: today's top spenders (an account farm?), and every provider's own billing page"
  },
  {
    key: "spend_monthly",
    label: "Free-account AI spend past the monthly ceiling (new AI work refused for free accounts this month)",
    policy: SPEND_POLICY,
    hint: "/admin/spend in the console: the month against the budget, then raise the ceiling or leave it until the 1st"
  },
  {
    key: "spend_paid",
    label: "Paid-plan AI spend past the paid daily cap (new AI work refused for paying readers)",
    policy: SPEND_POLICY,
    hint: "/admin/spend in the console: today's top spenders (a stolen account or a stuck client?), then raise the cap"
  },
  {
    key: "failed_jobs",
    label: "Generation jobs failing",
    policy: FAILED_JOBS_POLICY,
    hint: "the FAILED GenerationJob rows' error column, then that book's run log; a provider key or its credit balance"
  },
  {
    key: "disk",
    label: "Low free disk on the host",
    policy: DISK_POLICY,
    hint: "df -h /; docker system df (the deploy refuses to pull under 4 GiB free)"
  },
  {
    key: "safety_reports",
    label: "Open child-safety or sexual-content reports",
    policy: SAFETY_REPORTS_POLICY,
    hint: "/admin/moderation in the console, child safety first: take the share down, or suspend the account from /admin/users, then settle the report"
  },
  ...PROVIDER_QUOTA_ACCOUNTS.map(
    (account): AlertCondition => ({
      key: providerQuotaConditionKey(account),
      label: providerQuotaLabel(account),
      policy: PROVIDER_QUOTA_POLICY,
      hint: `the provider's billing page (add credit, or raise its spend or quota limit); which calls it refused are the ProviderCallLog rows with metadata.errorClass = provider_quota_exhausted and provider ${account}`
    })
  )
];

/** A burst, not a bad book: one book's run fails once, a provider outage fails every one. */
export const FAILED_JOBS_THRESHOLD = 5;
export const FAILED_JOBS_WINDOW_MS = HOUR;
const FAILED_JOBS_SCAN = 100;

/**
 * Free space on the disk that holds Docker, PostgreSQL and Redis. 15% of the
 * 30 GiB volume is 4.5 GiB, just above the 4 GiB the deploy needs to pull a
 * release (`scripts/deploy-production.sh`), so the email arrives before the
 * next deploy is refused rather than with it. It clears two points higher, so
 * a disk hovering at the line is one alert.
 */
export const DISK_FIRE_BELOW = 0.15;
export const DISK_CLEAR_AT = 0.17;
const INODES_FIRE_BELOW = 0.1;
const INODES_CLEAR_AT = 0.12;

/** The breaker's view, as the spend conditions compare it (`../spendBreaker.ts`). */
export type SpendSnapshot = {
  /** Free readers and unattributed calls today. */
  freeSpendUsd: number;
  /** The same over the UTC month so far. */
  monthFreeSpendUsd: number;
  paidSpendUsd: number;
  softDailyCapUsd: number;
  hardDailyCapUsd: number;
  freeMonthlyCapUsd: number;
  paidHardDailyCapUsd: number;
};
export type DiskSnapshot = { freeBytes: number; totalBytes: number; freeInodes: number; totalInodes: number };

/** PENDING reports that a person must look at soon (`safetyReportsSource`). */
export type SafetyReportCounts = {
  childSafety: number;
  sexualContent: number;
  /** Live shares the sexual-content screen held because it had no verdict on part of the text. */
  heldBookText: number;
  oldestAt: Date | null;
};

export type AlertSources = {
  readiness(): Promise<ReadinessReport>;
  spend(): Promise<SpendSnapshot>;
  /** Failed jobs since a moment, a user's own stop excluded, at most `limit` of them. */
  failedJobsSince(since: Date, limit: number): Promise<Array<{ type: string }>>;
  disk(): Promise<DiskSnapshot>;
  openSafetyReports(): Promise<SafetyReportCounts>;
  /** Each provider spelling's last empty-account refusal and last answered call since a moment (`providerQuota.ts`). */
  providerCallOutcomesSince(since: Date): Promise<ProviderCallOutcome[]>;
};

/**
 * This sweep's observation of every condition. A source that cannot be read
 * leaves its conditions unmeasured (`null`) rather than failing them: the one
 * thing that is down is reported once, by the check for it.
 */
export async function observeAlertConditions(
  sources: AlertSources,
  previous: ReadonlyMap<string, AlertState>,
  now: Date
): Promise<Map<AlertConditionKey, AlertObservation>> {
  const [readiness, spend, failed, disk, safety, providerCalls] = await Promise.allSettled([
    sources.readiness(),
    sources.spend(),
    sources.failedJobsSince(new Date(now.getTime() - FAILED_JOBS_WINDOW_MS), FAILED_JOBS_SCAN),
    sources.disk(),
    sources.openSafetyReports(),
    sources.providerCallOutcomesSince(new Date(now.getTime() - PROVIDER_QUOTA_WINDOW_MS))
  ]);
  const observations = new Map<AlertConditionKey, AlertObservation>();

  // Every check the probe measured, the advisory ones included: an email is how those are told.
  for (const check of MONITORED_CHECKS) {
    const result = readiness.status === "fulfilled" ? readiness.value.results[check] : null;
    observations.set(
      check,
      result === null ? null : result.ok ? { failing: false } : result.unmeasured ? null : { failing: true, detail: result.reason }
    );
  }

  if (spend.status === "fulfilled") {
    for (const [key, observation] of spendObservations(spend.value)) observations.set(key, observation);
  } else {
    for (const key of SPEND_CONDITIONS) observations.set(key, null);
  }

  observations.set("failed_jobs", failed.status === "fulfilled" ? failedJobsObservation(failed.value) : null);
  observations.set(
    "disk",
    disk.status === "fulfilled" ? diskObservation(disk.value, previous.get("disk")?.firing ?? false) : null
  );
  observations.set("safety_reports", safety.status === "fulfilled" ? safetyReportsObservation(safety.value) : null);
  if (providerCalls.status === "fulfilled") {
    for (const [key, observation] of providerQuotaObservations(providerCalls.value, previous)) observations.set(key, observation);
  } else {
    for (const account of PROVIDER_QUOTA_ACCOUNTS) observations.set(providerQuotaConditionKey(account), null);
  }
  return observations;
}

const SPEND_CONDITIONS = ["spend_soft", "spend_hard", "spend_monthly", "spend_paid"] as const;

/**
 * Spend against each cap, compared here rather than read off the breaker's
 * state, so a pause the operator chose is not an alert.
 */
function spendObservations(spend: SpendSnapshot): Array<[(typeof SPEND_CONDITIONS)[number], AlertObservation]> {
  const free = `$${spend.freeSpendUsd.toFixed(2)} of free-account and unattributed provider spend today (UTC)`;
  const paid = `$${spend.paidSpendUsd.toFixed(2)} of paid-plan provider spend today (UTC)`;
  const month = `$${spend.monthFreeSpendUsd.toFixed(2)} of free-account and unattributed provider spend this month (UTC)`;
  const past = (spent: number, cap: number, detail: string): AlertObservation =>
    spent >= cap ? { failing: true, detail } : { failing: false };
  return [
    [
      "spend_soft",
      past(
        spend.freeSpendUsd,
        spend.softDailyCapUsd,
        `${free} is past the $${spend.softDailyCapUsd.toFixed(2)} soft cap: free accounts are held to the cheap paths and welcome credits wait`
      )
    ],
    [
      "spend_hard",
      past(
        spend.freeSpendUsd,
        spend.hardDailyCapUsd,
        `${free} is past the $${spend.hardDailyCapUsd.toFixed(2)} hard cap: free accounts start no new AI work until 00:00 UTC; paid plans are unaffected`
      )
    ],
    [
      "spend_monthly",
      past(
        spend.monthFreeSpendUsd,
        spend.freeMonthlyCapUsd,
        `${month} is past the $${spend.freeMonthlyCapUsd.toFixed(2)} monthly ceiling: free accounts start no new AI work until the month ends or the ceiling is raised; paid plans are unaffected`
      )
    ],
    [
      "spend_paid",
      past(
        spend.paidSpendUsd,
        spend.paidHardDailyCapUsd,
        `${paid} is past the $${spend.paidHardDailyCapUsd.toFixed(2)} paid cap: paying readers start no new AI work until 00:00 UTC`
      )
    ]
  ];
}

function failedJobsObservation(rows: ReadonlyArray<{ type: string }>): AlertObservation {
  if (rows.length < FAILED_JOBS_THRESHOLD) return { failing: false };
  const byType = new Map<string, number>();
  for (const { type } of rows) byType.set(type, (byType.get(type) ?? 0) + 1);
  const breakdown = [...byType.entries()]
    .sort((left, right) => right[1] - left[1])
    .map(([type, count]) => `${count} ${type}`)
    .join(", ");
  const count = rows.length >= FAILED_JOBS_SCAN ? `${FAILED_JOBS_SCAN}+` : String(rows.length);
  return {
    failing: true,
    detail: `${count} generation jobs failed in the last hour (alert at ${FAILED_JOBS_THRESHOLD}): ${breakdown}`
  };
}

export function safetyReportsObservation(counts: SafetyReportCounts): AlertObservation {
  const total = counts.childSafety + counts.sexualContent + counts.heldBookText;
  if (total === 0) return { failing: false };
  const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;
  const parts = [
    ...(counts.childSafety > 0 ? [plural(counts.childSafety, "child-safety report", "child-safety reports")] : []),
    ...(counts.sexualContent > 0 ? [plural(counts.sexualContent, "sexual-content report", "sexual-content reports")] : []),
    ...(counts.heldBookText > 0
      ? [plural(counts.heldBookText, "shared book held for review of its text", "shared books held for review of their text")]
      : [])
  ];
  const oldest = counts.oldestAt ? `; the oldest arrived ${counts.oldestAt.toISOString().slice(0, 16).replace("T", " ")} UTC` : "";
  return { failing: true, detail: `${total} open: ${parts.join(", ")}${oldest}` };
}

export function diskObservation(disk: DiskSnapshot, wasFiring: boolean): AlertObservation {
  const free = disk.totalBytes > 0 ? disk.freeBytes / disk.totalBytes : 1;
  const inodes = disk.totalInodes > 0 ? disk.freeInodes / disk.totalInodes : 1;
  const spaceLow = free < (wasFiring ? DISK_CLEAR_AT : DISK_FIRE_BELOW);
  const inodesLow = inodes < (wasFiring ? INODES_CLEAR_AT : INODES_FIRE_BELOW);
  if (!spaceLow && !inodesLow) return { failing: false };
  const parts = [`${percent(free)} free (${gib(disk.freeBytes)} of ${gib(disk.totalBytes)})`];
  if (inodesLow) parts.push(`${percent(inodes)} of inodes free`);
  return { failing: true, detail: `${parts.join(", ")} on the disk that holds Docker, PostgreSQL and Redis` };
}

function percent(ratio: number): string {
  return `${(ratio * 100).toFixed(1)}%`;
}

function gib(bytes: number): string {
  return `${(bytes / 1024 ** 3).toFixed(1)} GiB`;
}

// ---- the production sources ---------------------------------------------------

type FailedJobsDatabase = { generationJob: Pick<Prisma.TransactionClient["generationJob"], "findMany"> };

/**
 * Jobs that failed, not jobs a reader stopped: the API's stop writes FAILED
 * with the stop markers (`STOPPED_JOB_MESSAGE` / `STOPPED_JOB_ERROR`, the pair
 * the worker's `isStoppedGenerationJob` reads), and a reader pressing Stop five
 * times in an hour is not an incident. Written with explicit nulls, because a
 * SQL `<>` drops the rows whose column is null.
 */
export function failedJobsSource(db: FailedJobsDatabase): AlertSources["failedJobsSince"] {
  return (since, limit) =>
    db.generationJob.findMany({
      where: {
        status: "FAILED",
        finishedAt: { gte: since },
        AND: [
          { OR: [{ error: null }, { error: { not: STOPPED_JOB_ERROR } }] },
          { OR: [{ message: null }, { message: { not: STOPPED_JOB_MESSAGE } }] }
        ]
      },
      select: { type: true },
      take: limit
    });
}

type SafetyReportsDatabase = { moderationReport: Pick<Prisma.TransactionClient["moderationReport"], "count" | "findFirst"> };

/**
 * Open reports a person has to read soon: a reader's child-safety or
 * sexual-content report from any surface — a live share's page, a book, a
 * picture, a voice call, a chat reply, any AI output (`moderationReports.ts`) —
 * and the system review the sexual-content screen files when it shares a book
 * it could not decide (`book_text_review`). Open is PENDING: an operator's
 * "Mark reviewed" is an answer. Four counts on the `(status, createdAt)` index.
 */
export function safetyReportsSource(db: SafetyReportsDatabase): AlertSources["openSafetyReports"] {
  const heldBookText = { reporterUserId: null, targetSnapshot: { path: ["kind"], equals: "book_text_review" } };
  return async () => {
    const [childSafety, sexualContent, held, oldest] = await Promise.all([
      db.moderationReport.count({ where: { status: "PENDING", reason: "CHILD_SAFETY" } }),
      db.moderationReport.count({ where: { status: "PENDING", reason: "SEXUAL_CONTENT" } }),
      db.moderationReport.count({ where: { status: "PENDING", ...heldBookText } }),
      db.moderationReport.findFirst({
        where: { status: "PENDING", OR: [{ reason: { in: ["CHILD_SAFETY", "SEXUAL_CONTENT"] } }, heldBookText] },
        orderBy: { createdAt: "asc" },
        select: { createdAt: true }
      })
    ]);
    return { childSafety, sexualContent, heldBookText: held, oldestAt: oldest?.createdAt ?? null };
  };
}

/**
 * Inside the api container `/` is the overlay filesystem Docker built the
 * container on, and an overlay reports its upper directory's filesystem — the
 * host disk that holds DockerRootDir, the containerd image store and the
 * PostgreSQL and Redis volumes (one disk on this host, docs/deployment.md). So
 * no bind mount is needed; locally it is the developer's own disk.
 */
export function diskSource(path = "/"): AlertSources["disk"] {
  return async () => {
    const stats = await statfs(path);
    return {
      freeBytes: stats.bavail * stats.bsize,
      totalBytes: stats.blocks * stats.bsize,
      freeInodes: stats.ffree,
      totalInodes: stats.files
    };
  };
}
