import { STATUS_CODES } from "node:http";
import cors from "@fastify/cors";
import fastifyStatic from "@fastify/static";
import swagger from "@fastify/swagger";
import swaggerUi from "@fastify/swagger-ui";
import Fastify, { type FastifyError } from "fastify";
import { existsSync } from "node:fs";
import { objectStore, sweepTemporaryDirectories } from "@book-maker/storage";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { browserPoolStatus, closeSharedBrowser, enforceProductionConfig, loadConfig, ProductionConfigError } from "@book-maker/core";
import { loadCreditPricing, prisma } from "@book-maker/db";
import { recoverMessageUsage, setWelcomeGrantHold } from "@book-maker/db/billing";
import { runAccountDeletionSweep } from "./accountDeletion.js";
import { sweepExpiredCreationAttachments } from "./attachmentStorage.js";
import { appUpdateRoutes, registerAppUpdateGate } from "./appUpdates.js";
import { registerAuth } from "./auth.js";
import { corsOptionsFor } from "./cors.js";
import { createGooglePlayVerifierFromConfig } from "./googlePlayBilling.js";
import { googlePlayRtdnRoutes } from "./googlePlayRtdn.js";
import { warnAboutUnkeyedSavedRouting } from "./generationTextModelRouting.js";
import { runSubscriptionRenewalSweep } from "./subscriptionRenewal.js";
import { createMailerFromConfig } from "./mailer.js";
import { createBackgroundSweeps } from "./backgroundSweeps.js";
import { runStorageDeletionSweep, STORAGE_DELETION_SWEEP_INTERVAL_MS } from "./storageDeletionSweep.js";
import { PRUNE_INTERVAL_MS, runTablePruneSweep } from "./tablePruneSweep.js";
import { mobileAuthRoutes } from "./mobileAuth.js";
import { mobileGoogleAuthRoutes } from "./mobileGoogleAuth.js";
import { mobileImportRoutes } from "./mobileImports.js";
import { mobilePasswordResetRoutes } from "./mobilePasswordReset.js";
import { mobileEmailVerificationRoutes } from "./mobileEmailVerification.js";
import { mobileProjectRoutes, reconcileRetryablePlanRevisionOperations } from "./mobileProjects.js";
import { sweepStaleVoiceCalls } from "./mobile/voiceCalls.js";
import { startStudioImageSweep, studioImageSweepMode } from "./mobile/studioImageSweep.js";
import { mobileSafetyRoutes } from "./mobileSafety.js";
import { publicShareRoutes } from "./mobile/shares/publicShareRoutes.js";
import {
  createShareRescreener,
  liveShareRescreenModeration,
  SHARE_RESCREEN_SWEEP_INTERVAL_MS
} from "./mobile/shares/shareRescreen.js";
import { closeQueue, reconcileUndispatchedGenerationJobs, redisConnection } from "./queue.js";
import { startOperatorAlerts } from "./monitoring/operatorAlerts.js";
import { createMailHealth, MAIL_VERIFY_INTERVAL_MS, mailerFeedingHealth } from "./monitoring/mailHealth.js";
import { monitoringRoutes } from "./monitoring/monitoringRoutes.js";
import { createReadinessProbe, readinessDeps } from "./monitoring/readiness.js";
import { readinessRoutes } from "./monitoring/readinessRoutes.js";
import { loadSerializedProjectStatus } from "./mobile/projectStatusSerializers.js";
import { BOOK_PUSH_SWEEP_INTERVAL_MS, runBookPushSweep } from "./push/bookPushSweep.js";
import { createPushSenderFromConfig } from "./push/pushSender.js";
import { adminAnalyticsRoutes } from "./routes/adminAnalytics.js";
import { adminGenerationQualityRoutes } from "./routes/adminGenerationQuality.js";
import { adminPricingRoutes } from "./routes/adminPricing.js";
import { adminProjectExportRoutes } from "./routes/adminProjectExports.js";
import { adminSafetyRoutes } from "./routes/adminSafety.js";
import { adminAppUpdateRoutes } from "./routes/adminAppUpdates.js";
import { adminSpendControlRoutes } from "./routes/adminSpendControls.js";
import { spendBreaker } from "./spendBreaker.js";
import { adminShareRoutes } from "./routes/adminShares.js";
import { adminAccountRoutes } from "./routes/adminAccounts.js";
import { projectRoutes } from "./routes/projects.js";

const config = loadConfig();
const app = Fastify({
  ...(config.TRUST_PROXY_HOPS > 0 ? { trustProxy: config.TRUST_PROXY_HOPS } : {}),
  logger: {
    redact: [
      "req.headers.authorization",
      "req.headers.cookie",
      "req.headers.sec-websocket-protocol",
      "res.headers.set-cookie",
      "body.password",
      "body.newPassword",
      "body.code",
      "body.refreshToken",
      "body.idToken",
      "body.purchaseToken",
      "body.comment",
      "body.reason",
      "body.reviewNotes"
    ]
  }
});

// Fastify's default handler answers a 5xx with the thrown error's own message —
// a Prisma or provider error, a file path — straight to the client. In
// production a server fault says only that it happened (the log keeps it all);
// a 4xx keeps its message, which is written for the caller. Route-level
// handlers (the upload parsers' `sendUnreadableBodyError`) still run first.
app.setErrorHandler((error: FastifyError, request, reply) => {
  const statusCode = typeof error.statusCode === "number" && error.statusCode >= 400 ? error.statusCode : 500;
  if (statusCode >= 500) {
    request.log.error({ err: error }, "Request failed");
  }
  const hideMessage = statusCode >= 500 && config.NODE_ENV === "production";
  return reply.code(statusCode).send({
    statusCode,
    ...(error.code && !hideMessage ? { code: error.code } : {}),
    error: STATUS_CODES[statusCode] ?? "Error",
    message: hideMessage ? "Something went wrong on our side. Try again in a moment." : error.message
  });
});

// Production refuses to start without Play billing, refund notices, a strong
// operator password, password-reset mail, its public origin and every provider
// key the default model routing can select (packages/core/src/productionConfig.ts).
// The report goes to stderr as plain lines, every missing setting at once.
try {
  enforceProductionConfig(config, "api", {
    warn: (issue) => app.log.warn({ event: "config.production_warning", variables: issue.variables }, issue.message),
    mockAi: (message) => app.log.error({ event: "config.mock_ai_in_production" }, message)
  });
} catch (error) {
  if (!(error instanceof ProductionConfigError)) throw error;
  console.error(error.message);
  process.exit(1);
}

if (config.NODE_ENV === "production" && config.TRUST_PROXY_HOPS === 0) {
  app.log.warn(
    { event: "trust_proxy.unconfigured" },
    "TRUST_PROXY_HOPS is 0 in production; welcome-credit IP checks will treat forwarded clients as unknown (no grant) until TRUST_PROXY_HOPS matches the Caddy→Nginx hop count (2)"
  );
}

// Every book asset this process serves or stores is a private S3 object, so an
// API that cannot reach its bucket has nothing to offer. Refusing to start is
// what compose's `--wait` and the deployment see; the alternative is a healthy
// container that fails on the first upload. Locally this means MinIO is down.
try {
  await objectStore().ready();
} catch (error) {
  app.log.fatal({ err: error }, "Object storage is not reachable (local development: docker compose up -d minio-init)");
  process.exit(1);
}

// Everything below up to `listen` only *defines* the periodic housekeeping;
// none of it runs until the API is listening (`backgroundSweeps.start()` after
// `app.listen`, src/backgroundSweeps.ts). Awaiting first passes here — an S3
// listing, account deletions, calls to Google — once kept a new release from
// listening until the deploy's health wait gave up on it.
const HOUR_MS = 60 * 60 * 1000;

// Renderers have local scratch space only. Reap stale directories after a process crash.
const sweepTemporaryFiles = async () => {
  try {
    await sweepTemporaryDirectories({ minAgeMs: 24 * HOUR_MS });
  } catch (error) {
    app.log.warn({ err: error }, "Temporary renderer cleanup failed");
  }
};

// Uploaded user files are kept for 6 months; generated books and plans are kept forever.
const sweepAttachments = async () => {
  try {
    const swept = await sweepExpiredCreationAttachments(
      config.ATTACHMENT_STORAGE_DIR,
      config.ATTACHMENT_RETENTION_DAYS
    );
    if (swept.deletedFiles > 0) {
      app.log.info(swept, "Expired chat attachments removed");
    }
  } catch (error) {
    app.log.warn({ err: error }, "Attachment retention sweep failed");
  }
};

// Writing Studio pictures (uploads, uploaded covers, AI Studio illustrations)
// that no row of their book names any more. Paced and bounded per pass; it
// only logs outside production unless STUDIO_IMAGE_SWEEP says otherwise.
const studioImageSweep = startStudioImageSweep({ mode: studioImageSweepMode(config), log: app.log });

// A voice call holds credits while it runs. An app killed mid-call stops
// heartbeating without ever ending the call, so the hold has to be released for
// it — and the time it did use charged — or the credits stay stuck.
const sweepVoiceCalls = async () => {
  try {
    const settled = await sweepStaleVoiceCalls();
    if (settled > 0) {
      app.log.info({ event: "voice.calls_settled", settled }, "Stale voice calls settled");
    }
  } catch (error) {
    app.log.warn({ err: error }, "Voice call settlement sweep failed");
  }
};

// Account deletion requests are carried out once their grace period passes.
// Nothing completed one before: the app and the public page promised deletion
// within 30 days, and Google Play requires it of any app with accounts.
const sweepAccountDeletions = async () => {
  try {
    const completed = await runAccountDeletionSweep(app.log);
    if (completed > 0) {
      app.log.info({ event: "account.deletions_completed", completed }, "Account deletions completed");
    }
  } catch (error) {
    app.log.warn({ err: error }, "Account deletion sweep failed");
  }
};

const recoverMessages = async () => {
  try {
    await recoverMessageUsage();
  } catch (error) {
    app.log.warn({ err: error }, "Message reservation recovery failed");
  }
};

// Credit prices are operator-editable and live in the database. Load them before
// anything can be charged, then re-read on a timer so a second API instance
// picks up a change made through the first. The one load the API waits for.
const refreshPricing = async () => {
  try {
    await loadCreditPricing();
  } catch (error) {
    // The in-memory prices stay as they are — stale beats unpriced.
    app.log.warn({ err: error, event: "pricing.refresh_failed" }, "Credit pricing refresh failed");
  }
};
await refreshPricing();
const pricingRefreshTimer = setInterval(() => void refreshPricing(), 15_000);
pricingRefreshTimer.unref();

// While AI is paused or free accounts' spend is past the breaker's soft cap or
// monthly ceiling, a free account's welcome grant waits for a later balance
// read (src/spendBreaker.ts). Paying readers' spend never holds it.
spendBreaker.useLogger(app.log);
setWelcomeGrantHold(() => spendBreaker.holdsWelcomeGrants());

// Google renews subscriptions on its own schedule and only the app finding out
// used to trigger the next month's credits. This asks Google directly for the
// subscriptions whose period has run out, so a subscriber who does not open the
// app on renewal day still gets what they paid for.
const renewalVerifier = createGooglePlayVerifierFromConfig(config);
const sweepSubscriptionRenewals = async () => {
  try {
    const swept = await runSubscriptionRenewalSweep({
      verifier: renewalVerifier,
      packageName: config.GOOGLE_PLAY_PACKAGE_NAME ?? "",
      log: app.log
    });
    if (swept.granted > 0 || swept.failed > 0) {
      app.log.info({ event: "subscription.renewals_swept", ...swept }, "Subscription renewals swept");
    }
  } catch (error) {
    app.log.warn({ err: error, event: "subscription.renewal_sweep_failed" }, "Subscription renewal sweep failed");
  }
};

const reconcileQueue = async () => {
  try {
    const [dispatched, retried] = await Promise.all([
      reconcileUndispatchedGenerationJobs(),
      reconcileRetryablePlanRevisionOperations({ log: app.log })
    ]);
    if (dispatched > 0 || retried > 0) {
      app.log.info(
        { event: "generation.consistency_reconciled", dispatched, planRevisionRetries: retried },
        "Generation consistency reconciliation completed"
      );
    }
  } catch (error) {
    app.log.warn({ err: error, event: "generation.consistency_warning" }, "Generation queue reconciliation failed");
  }
};

// Book-progress and book-ready notifications (src/push/bookPushSweep.ts). With
// no FCM key configured the sender is null, a warning is logged once, and the
// sweep never runs. A sweep still running when the next tick comes is not
// doubled (the scheduler is single-flight): each one reads a dozen queries per
// followed book.
const pushSender = await createPushSenderFromConfig(config, app.log);
const sweepBookPushes = async () => {
  if (!pushSender) {
    return;
  }
  try {
    const swept = await runBookPushSweep({
      sender: pushSender,
      loadStatus: (projectId) => loadSerializedProjectStatus(projectId, config),
      log: app.log
    });
    if (swept.settled > 0 || swept.unregistered > 0 || swept.failed > 0) {
      app.log.info({ event: "push.book_sweep", ...swept }, "Book pushes swept");
    }
  } catch (error) {
    app.log.warn({ err: error, event: "push.book_sweep_failed" }, "Book push sweep failed");
  }
};

// A deleted book's prefixes are deleted again until they stay empty
// (src/storageDeletionSweep.ts): a failed delete is retried, and what a
// stopping job wrote afterwards is swept up.
const sweepStorageDeletions = async () => {
  const swept = await runStorageDeletionSweep({ log: app.log });
  if (swept.objectsDeleted > 0 || swept.completed > 0 || swept.failed > 0) {
    app.log.info({ event: "storage.deletions_swept", ...swept }, "Deleted books' storage swept");
  }
};

// A public share serves only text screened at its book's current revision
// (src/mobile/shares/shareRescreen.ts). This re-screens a bounded batch of live
// shares whose book has moved; the public routes ask the same rescreener for
// a share someone opens, at most once per share and revision.
const shareRescreener = createShareRescreener({ moderation: liveShareRescreenModeration(config), log: app.log });
const sweepShareRescreens = async () => {
  const swept = await shareRescreener.sweep();
  if (swept.checked > 0) {
    app.log.info({ event: "share.rescreens_swept", ...swept }, "Shared books re-screened");
  }
};

// Provider call logs no book names, product events and dead sessions, past
// their retention (src/tablePruneSweep.ts).
const pruneTables = async () => {
  const pruned = await runTablePruneSweep();
  if (pruned.providerCallLogs > 0 || pruned.productEvents > 0 || pruned.sessions > 0) {
    app.log.info({ event: "retention.tables_pruned", ...pruned }, "Rows past retention pruned");
  }
};

// Password-reset codes and operator alerts share one transport. Its connection
// and credentials are verified after listen and every ten minutes
// (src/monitoring/mailHealth.ts); /api/ready's `mail` check reads that answer.
const mailer = createMailerFromConfig(config, app.log);
if (!mailer) {
  app.log.warn(
    { event: "email.unconfigured" },
    "No SMTP_URL configured; password reset will answer 503 EMAIL_UNAVAILABLE"
  );
}
const mailHealth = createMailHealth({ mailer, log: app.log });
// The reader-facing sends report each outcome into that answer too, so a
// mailer that breaks between verifications fails readiness at its first failed
// code rather than at the next ten-minute verify.
const readerMailer = mailerFeedingHealth(mailer, mailHealth);

// Readiness (src/monitoring/readiness.ts): Postgres, Redis, the bucket, mail,
// both worker lanes' heartbeats and their oldest waiting job. Served at
// /api/ready for an uptime monitor and read by the operator alert sweep below;
// never by the compose healthcheck, which polls the shallow /api/health.
const readinessProbe = createReadinessProbe(
  readinessDeps({
    db: prisma,
    redis: redisConnection,
    storageReady: () => objectStore().ready(),
    mailReady: () => mailHealth.readinessCheck()
  }),
  { log: app.log }
);

const backgroundSweeps = createBackgroundSweeps(
  [
    { name: "temporary_files", intervalMs: HOUR_MS, run: sweepTemporaryFiles },
    { name: "attachment_retention", intervalMs: 24 * HOUR_MS, run: sweepAttachments },
    { name: "voice_call_settlement", intervalMs: 30_000, run: sweepVoiceCalls },
    { name: "account_deletions", intervalMs: HOUR_MS, run: sweepAccountDeletions },
    { name: "message_recovery", intervalMs: 30_000, run: recoverMessages },
    { name: "subscription_renewals", intervalMs: HOUR_MS, run: sweepSubscriptionRenewals },
    { name: "queue_reconcile", intervalMs: 5_000, run: reconcileQueue },
    ...(pushSender
      ? [{ name: "book_pushes", intervalMs: BOOK_PUSH_SWEEP_INTERVAL_MS, initialDelayMs: BOOK_PUSH_SWEEP_INTERVAL_MS, run: sweepBookPushes }]
      : []),
    { name: "mail_verify", intervalMs: MAIL_VERIFY_INTERVAL_MS, run: () => mailHealth.verify() },
    { name: "storage_deletions", intervalMs: STORAGE_DELETION_SWEEP_INTERVAL_MS, initialDelayMs: 60_000, run: sweepStorageDeletions },
    { name: "share_rescreen", intervalMs: SHARE_RESCREEN_SWEEP_INTERVAL_MS, initialDelayMs: 30_000, run: sweepShareRescreens },
    { name: "table_prune", intervalMs: PRUNE_INTERVAL_MS, initialDelayMs: 10 * 60_000, run: pruneTables }
  ],
  app.log
);

await app.register(cors, corsOptionsFor(config));
// Ahead of auth, so a build the operator has retired is told to update before
// it is told anything else — including that its session expired.
registerAppUpdateGate(app);
await registerAuth(app, config);
await app.register(swagger, {
  openapi: {
    info: {
      title: "AI Book Maker API",
      version: "0.1.0"
    }
  }
});
await app.register(swaggerUi, { routePrefix: "/docs" });
// Sign-up mails the first email-verification code; the welcome grant waits
// for a confirmed one (src/mobileEmailVerification.ts).
await app.register(mobileAuthRoutes, { mailer: readerMailer });
await app.register(mobileGoogleAuthRoutes);
await app.register(mobilePasswordResetRoutes, { mailer: readerMailer });
await app.register(mobileEmailVerificationRoutes, { mailer: readerMailer });
// Emails OPERATOR_ALERT_EMAIL when production is down or degraded, once per
// firing and once on recovery (src/monitoring/operatorAlerts.ts); only logs
// without it. Through the same transport as the password-reset mail.
const operatorAlerts = startOperatorAlerts({
  db: prisma,
  probe: readinessProbe,
  spendBreaker,
  mailer,
  recipient: config.OPERATOR_ALERT_EMAIL,
  publicUrl: config.PUBLIC_API_URL,
  log: app.log
});
await app.register(readinessRoutes, { probe: readinessProbe });
// POST /api/admin/monitoring/test-alert: the owner's check that alert mail arrives.
await app.register(monitoringRoutes, {
  mailer,
  mailHealth,
  recipient: config.OPERATOR_ALERT_EMAIL,
  publicUrl: config.PUBLIC_API_URL
});
await app.register(mobileProjectRoutes);
await app.register(googlePlayRtdnRoutes, { config });
await app.register(mobileImportRoutes);
await app.register(mobileSafetyRoutes);
await app.register(appUpdateRoutes);
// Outside /api/ and outside the auth surface; also named in deploy/nginx.conf.
await app.register(publicShareRoutes, { rescreener: shareRescreener });
await app.register(adminPricingRoutes);
await app.register(adminSafetyRoutes);
await app.register(adminAppUpdateRoutes);
await app.register(adminSpendControlRoutes);
await app.register(adminShareRoutes);
// Suspend an account or turn its sharing off (src/accountModeration.ts).
await app.register(adminAccountRoutes);
await app.register(adminGenerationQualityRoutes);
await app.register(adminProjectExportRoutes);
await app.register(adminAnalyticsRoutes);
await app.register(projectRoutes);

const webDistDir = findWebDistDir();
if (webDistDir) {
  await app.register(fastifyStatic, {
    root: webDistDir,
    prefix: "/",
    decorateReply: false
  });
  app.setNotFoundHandler(async (request, reply) => {
    if (shouldReturnNotFound(request.url)) {
      return reply.code(404).send({ error: "Not found" });
    }
    const indexHtml = await readFile(resolve(webDistDir, "index.html"), "utf8");
    return reply.type("text/html; charset=utf-8").send(indexHtml);
  });
}

const shutdown = async () => {
  backgroundSweeps.stop();
  clearInterval(pricingRefreshTimer);
  operatorAlerts.stop();
  await studioImageSweep.stop();
  await app.close();
  // The lazy export rebuild renders in this process too, so the API holds a
  // pooled Chromium of its own — budget two browsers in production, one per
  // process.
  await closeSharedBrowser();
  // Bounded, so it can be awaited in a signal handler — which means it can also
  // give up. A browser that answered neither `close()` nor SIGKILL outlives this
  // process, and the only place that is knowable is here.
  const stranded = browserPoolStatus().abandonedProcesses;
  if (stranded.length > 0) {
    app.log.error({ stranded }, "Chromium processes survived shutdown");
  }
  await closeQueue();
  await prisma.$disconnect();
};

/**
 * SIGHUP belongs here with the other two. Puppeteer's own signal handlers are
 * off (`browserPool.ts`) because they race this shutdown, and its unconditional
 * `process.on("exit")` hook only runs on a *normal* exit — so a signal Node does
 * not trap kills this process outright and leaves the pooled Chromium running,
 * reparented to init. A terminal hangup, an `ssh` disconnect and systemd's
 * reload all send it.
 */
const TERMINATION_SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"] as const;

let shuttingDown = false;
for (const signal of TERMINATION_SIGNALS) {
  process.on(signal, () => {
    // A hangup is routinely followed by a TERM from the same supervisor; the
    // second one must not start a concurrent close of the same resources.
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    void shutdown();
  });
}

await app.listen({ host: config.API_HOST, port: config.API_PORT });
// Only now: the first pass of every sweep runs on a later tick and is never awaited.
backgroundSweeps.start();
// The Quality tab's saved routing outlives a removed key; say so once at boot.
void warnAboutUnkeyedSavedRouting(config, app.log);

function findWebDistDir(start = process.cwd()): string | undefined {
  let current = start;
  while (true) {
    const candidate = resolve(current, "apps/web/dist");
    if (existsSync(resolve(candidate, "index.html"))) {
      return candidate;
    }
    const parent = dirname(current);
    if (parent === current) {
      return undefined;
    }
    current = parent;
  }
}

function shouldReturnNotFound(requestUrl: string): boolean {
  const pathname = new URL(requestUrl, "http://localhost").pathname;
  return (
    pathname.startsWith("/api") ||
    pathname.startsWith("/docs") ||
    // The share surface never falls through to the console's index.html.
    pathname === "/s" ||
    pathname.startsWith("/s/") ||
    pathname.startsWith("/assets/images/") ||
    pathname.startsWith("/assets/voice/") ||
    pathname.includes(".")
  );
}
