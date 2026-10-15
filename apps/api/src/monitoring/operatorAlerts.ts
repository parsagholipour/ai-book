import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import type { Prisma } from "@book-maker/db";
import type { Mailer, MailMessage } from "../mailer.js";
import type { SpendBreaker } from "../spendBreaker.js";
import {
  ALERT_CONDITIONS,
  diskSource,
  failedJobsSource,
  observeAlertConditions,
  safetyReportsSource,
  type AlertCondition,
  type AlertSources,
  type SpendSnapshot
} from "./alertConditions.js";
import { freshAlertState, newerAlertState, stepAlert, type AlertNotification, type AlertState } from "./alertState.js";
import type { ReadinessProbe } from "./readiness.js";

/**
 * The operator alert sweep: once a minute, observe every condition in
 * `alertConditions.ts`, step each through `alertState.ts`, and email the owner
 * (`OPERATOR_ALERT_EMAIL`) what changed — one email per sweep, however many
 * conditions moved together, so a Redis outage that also silences both
 * heartbeats is one message, not three. With no address configured the same
 * transitions are only logged (`operator_alert.firing` / `.recovered`).
 *
 * **State lives in the `OperatorAlert` table, and the sweep survives losing
 * it.** A restart reads back which conditions were firing and told, so it
 * neither repeats an alert nor forgets the recovery it owes. But the database
 * is one of the things being watched, so a sweep that cannot claim, read or
 * write it carries on from this process's memory — the alert that the database
 * is down still goes out — and the next sweep that reaches the table writes the
 * newer state back (`newerAlertState`).
 *
 * **One process sends.** Each sweep first claims the `sweep` row with a
 * compare-and-set on its `observedAt`; a second API process inside the same
 * interval loses it and does nothing, so two processes never both email. A
 * process that cannot reach the table at all sends alone: a duplicate during a
 * database outage beats silence.
 *
 * **Email is best effort.** A send that fails or hangs is logged and the
 * sweep goes on; the state still records the alert as told, because retrying a
 * broken SMTP every minute would only fill the log the owner falls back to.
 */

export const OPERATOR_ALERT_SWEEP_INTERVAL_MS = 60_000;
export const SWEEP_CLAIM_KEY = "sweep";
/** nodemailer's own socket timeout is ten minutes; a sweep should not wait that long. */
const EMAIL_TIMEOUT_MS = 30_000;

export type AlertStore = {
  /** True when this process sends for this interval. Throws when the store cannot be reached. */
  claim(owner: string, now: Date, minGapMs: number): Promise<boolean>;
  load(keys: readonly string[]): Promise<AlertState[]>;
  save(states: readonly AlertState[]): Promise<void>;
};

export type AlertLogger = {
  info(object: Record<string, unknown>, message: string): void;
  warn(object: Record<string, unknown>, message: string): void;
  error(object: Record<string, unknown>, message: string): void;
};

export type OperatorAlertSweepResult = {
  /** False when another process holds this interval's claim. */
  sender: boolean;
  notifications: AlertNotification[];
  emailed: boolean;
};

export type OperatorAlertSweep = { run(): Promise<OperatorAlertSweepResult> };

export function createOperatorAlertSweep(deps: {
  store: AlertStore;
  sources: AlertSources;
  mailer: Mailer | null;
  recipient: string | undefined;
  publicUrl: string;
  log: AlertLogger;
  conditions?: readonly AlertCondition[];
  intervalMs?: number;
  now?: () => Date;
  owner?: string;
  emailTimeoutMs?: number;
}): OperatorAlertSweep {
  const conditions = deps.conditions ?? ALERT_CONDITIONS;
  const keys = conditions.map((condition) => condition.key);
  const intervalMs = deps.intervalMs ?? OPERATOR_ALERT_SWEEP_INTERVAL_MS;
  const clock = deps.now ?? (() => new Date());
  const owner = deps.owner ?? `${hostname()}:${process.pid}:${randomUUID().slice(0, 8)}`;
  const memory = new Map<string, AlertState>();
  let storeFailing = false;

  const storeFailed = (step: string, error: unknown) => {
    if (storeFailing) return;
    storeFailing = true;
    deps.log.warn(
      { event: "operator_alert.state_unavailable", step, err: error },
      "Operator alert state could not be read or written; alerting from this process's memory until it can"
    );
  };

  return {
    async run() {
      const now = clock();
      let claimed: boolean | "unavailable";
      try {
        claimed = await deps.store.claim(owner, now, intervalMs / 2);
      } catch (error) {
        claimed = "unavailable";
        storeFailed("claim", error);
      }
      if (claimed === false) {
        return { sender: false, notifications: [], emailed: false };
      }

      let stored: AlertState[] = [];
      if (claimed === true) {
        try {
          stored = await deps.store.load(keys);
        } catch (error) {
          claimed = "unavailable";
          storeFailed("load", error);
        }
      }
      const storedByKey = new Map(stored.map((state) => [state.key, state]));
      const previous = new Map<string, AlertState>(
        keys.map((key) => [key, newerAlertState(memory.get(key), storedByKey.get(key)) ?? freshAlertState(key)])
      );

      const observations = await observeAlertConditions(deps.sources, previous, now).catch((error: unknown) => {
        deps.log.error({ event: "operator_alert.observe_failed", err: error }, "Operator alert conditions could not be observed");
        return new Map();
      });

      const next: AlertState[] = [];
      const notifications: AlertNotification[] = [];
      for (const condition of conditions) {
        const step = stepAlert(previous.get(condition.key)!, observations.get(condition.key) ?? null, condition.policy, now);
        next.push(step.state);
        memory.set(condition.key, step.state);
        if (step.notification) notifications.push(step.notification);
      }

      for (const notification of notifications) {
        const fields = {
          event: `operator_alert.${notification.kind}`,
          alert: notification.key,
          detail: notification.detail,
          firingSince: notification.firingSince?.toISOString() ?? null
        };
        if (notification.kind === "firing") deps.log.warn(fields, "Operator alert firing");
        else deps.log.info(fields, "Operator alert recovered");
      }

      let emailed = false;
      if (notifications.length > 0 && deps.recipient && deps.mailer) {
        const message = composeAlertEmail(notifications, conditions, { to: deps.recipient, publicUrl: deps.publicUrl, now });
        try {
          await sendWithin(deps.mailer, message, deps.emailTimeoutMs ?? EMAIL_TIMEOUT_MS);
          emailed = true;
        } catch (error) {
          deps.log.error(
            { event: "operator_alert.email_failed", alerts: notifications.map((notification) => notification.key), err: error },
            "Operator alert email could not be sent; the alert is in this log only"
          );
        }
      }

      // Only the claimant writes: a process that could not claim may be
      // racing one that did. Its memory is written back by the first sweep
      // that reaches the table again.
      if (claimed === true) {
        try {
          await deps.store.save(next);
          if (storeFailing) {
            storeFailing = false;
            deps.log.info({ event: "operator_alert.state_available" }, "Operator alert state is being saved again");
          }
        } catch (error) {
          storeFailed("save", error);
        }
      }
      return { sender: true, notifications, emailed };
    }
  };
}

async function sendWithin(mailer: Mailer, message: MailMessage, timeoutMs: number): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      mailer.send(message),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`email not accepted within ${timeoutMs} ms`)), timeoutMs);
      })
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export function composeAlertEmail(
  notifications: readonly AlertNotification[],
  conditions: readonly AlertCondition[],
  input: { to: string; publicUrl: string; now: Date }
): MailMessage {
  const conditionOf = (key: string) => conditions.find((condition) => condition.key === key);
  const labelOf = (key: string) => conditionOf(key)?.label ?? key;
  const firing = notifications.filter((notification) => notification.kind === "firing");
  const recovered = notifications.filter((notification) => notification.kind === "recovered");
  const subjectParts = [
    ...(firing.length > 0 ? [`ALERT: ${firing.map((n) => labelOf(n.key)).join(", ")}`] : []),
    ...(recovered.length > 0 ? [`${firing.length > 0 ? "recovered" : "Recovered"}: ${recovered.map((n) => labelOf(n.key)).join(", ")}`] : [])
  ];
  const subject = `[Tomeza] ${subjectParts.join("; ")}`;
  const lines = [`Tomeza production, ${utcMinute(input.now)} UTC.`, ""];
  if (firing.length > 0) {
    lines.push("FIRING");
    for (const notification of firing) {
      lines.push(`- ${labelOf(notification.key)}: ${notification.detail ?? "failing"}`);
      const hint = conditionOf(notification.key)?.hint;
      if (hint) lines.push(`  First check: ${hint}`);
    }
    lines.push("");
  }
  if (recovered.length > 0) {
    lines.push("RECOVERED");
    for (const notification of recovered) {
      const since = notification.firingSince ? `failing since ${utcMinute(notification.firingSince)} UTC` : "failing";
      lines.push(`- ${labelOf(notification.key)}: was ${since}${notification.detail ? ` (${notification.detail})` : ""}.`);
    }
    lines.push("");
  }
  lines.push(
    `Readiness right now: ${input.publicUrl.replace(/\/$/, "")}/api/ready`,
    'What each alert means and what to do: docs/deployment.md, "Monitoring and alerts".',
    "You get one email when a condition fires and one when it clears; one that keeps coming back is held for an hour."
  );
  return {
    to: input.to,
    subject: subject.length > 180 ? `${subject.slice(0, 177)}...` : subject,
    text: lines.join("\n")
  };
}

function utcMinute(date: Date): string {
  return date.toISOString().slice(0, 16).replace("T", " ");
}

// ---- the table -------------------------------------------------------------------

type AlertDatabase = {
  operatorAlert: Pick<Prisma.TransactionClient["operatorAlert"], "updateMany" | "createMany" | "findMany" | "upsert">;
};

export function prismaAlertStore(db: AlertDatabase): AlertStore {
  return {
    async claim(owner, now, minGapMs) {
      // Postgres re-checks the WHERE after waiting on the row lock, so of two
      // processes racing for one interval exactly one updates the row.
      const claimed = await db.operatorAlert.updateMany({
        where: {
          key: SWEEP_CLAIM_KEY,
          OR: [{ observedAt: null }, { observedAt: { lte: new Date(now.getTime() - minGapMs) } }]
        },
        data: { observedAt: now, claimedBy: owner }
      });
      if (claimed.count === 1) return true;
      // The first sweep ever: whoever inserts the row holds the claim.
      const created = await db.operatorAlert.createMany({
        data: [{ key: SWEEP_CLAIM_KEY, observedAt: now, claimedBy: owner }],
        skipDuplicates: true
      });
      return created.count === 1;
    },
    async load(keys) {
      const rows = await db.operatorAlert.findMany({ where: { key: { in: [...keys] } } });
      return rows.map((row) => ({
        key: row.key,
        firing: row.firing,
        notified: row.notified,
        failingSweeps: row.failingSweeps,
        passingSweeps: row.passingSweeps,
        detail: row.detail,
        firingSince: row.firingSince,
        lastFiredAt: row.lastFiredAt,
        lastRecoveredAt: row.lastRecoveredAt,
        observedAt: row.observedAt
      }));
    },
    async save(states) {
      await Promise.all(
        states.map((state) => {
          const { key, ...fields } = state;
          return db.operatorAlert.upsert({ where: { key }, create: state, update: fields });
        })
      );
    }
  };
}

// ---- wiring ----------------------------------------------------------------------

type MonitoredDatabase = AlertDatabase & Parameters<typeof failedJobsSource>[0] & Parameters<typeof safetyReportsSource>[0];

export function spendSource(breaker: Pick<SpendBreaker, "globalView">, log: AlertLogger): AlertSources["spend"] {
  return async (): Promise<SpendSnapshot> => {
    const view = await breaker.globalView(log);
    return {
      freeSpendUsd: view.freeSpendUsd,
      monthFreeSpendUsd: view.monthFreeSpendUsd,
      paidSpendUsd: view.today.paidUsd,
      softDailyCapUsd: view.controls.softDailyCapUsd,
      hardDailyCapUsd: view.controls.hardDailyCapUsd,
      freeMonthlyCapUsd: view.controls.freeMonthlyCapUsd,
      paidHardDailyCapUsd: view.controls.paidHardDailyCapUsd
    };
  };
}

/** Starts the minute sweep in `server.ts`. A sweep still running when the next is due is not doubled. */
export function startOperatorAlerts(input: {
  db: MonitoredDatabase;
  probe: ReadinessProbe;
  spendBreaker: Pick<SpendBreaker, "globalView">;
  mailer: Mailer | null;
  recipient: string | undefined;
  publicUrl: string;
  log: AlertLogger;
  intervalMs?: number;
}): { stop(): void } {
  const intervalMs = input.intervalMs ?? OPERATOR_ALERT_SWEEP_INTERVAL_MS;
  if (input.recipient && !input.mailer) {
    input.log.warn(
      { event: "operator_alert.no_mailer" },
      "OPERATOR_ALERT_EMAIL is set but no mail transport is configured (SMTP_URL); operator alerts are only logged"
    );
  }
  input.log.info(
    { event: "operator_alert.started", emailing: Boolean(input.recipient && input.mailer) },
    input.recipient ? "Operator alert sweep started" : "Operator alert sweep started; OPERATOR_ALERT_EMAIL is not set, so alerts are only logged"
  );
  const sweep = createOperatorAlertSweep({
    store: prismaAlertStore(input.db),
    sources: {
      readiness: () => input.probe.check(),
      spend: spendSource(input.spendBreaker, input.log),
      failedJobsSince: failedJobsSource(input.db),
      disk: diskSource(),
      openSafetyReports: safetyReportsSource(input.db)
    },
    mailer: input.mailer,
    recipient: input.recipient,
    publicUrl: input.publicUrl,
    log: input.log,
    intervalMs
  });
  let running = false;
  const tick = () => {
    if (running) return;
    running = true;
    void sweep
      .run()
      .catch((error: unknown) => input.log.error({ event: "operator_alert.sweep_failed", err: error }, "Operator alert sweep failed"))
      .finally(() => {
        running = false;
      });
  };
  const timer = setInterval(tick, intervalMs);
  timer.unref();
  tick();
  // Not awaited on shutdown: a sweep can be waiting on SMTP, and the database
  // it would write to is about to close anyway.
  return { stop: () => clearInterval(timer) };
}
