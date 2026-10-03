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
import { browserPoolStatus, closeSharedBrowser, loadConfig } from "@book-maker/core";
import { loadCreditPricing, prisma } from "@book-maker/db";
import { recoverMessageUsage } from "@book-maker/db/billing";
import { runAccountDeletionSweep } from "./accountDeletion.js";
import { sweepExpiredCreationAttachments } from "./attachmentStorage.js";
import { appUpdateRoutes, registerAppUpdateGate } from "./appUpdates.js";
import { registerAuth } from "./auth.js";
import { corsOptionsFor } from "./cors.js";
import { createGooglePlayVerifierFromConfig } from "./googlePlayBilling.js";
import { googlePlayRtdnRoutes } from "./googlePlayRtdn.js";
import { runSubscriptionRenewalSweep } from "./subscriptionRenewal.js";
import { createMailerFromConfig } from "./mailer.js";
import { mobileAuthRoutes } from "./mobileAuth.js";
import { mobileGoogleAuthRoutes } from "./mobileGoogleAuth.js";
import { mobileImportRoutes } from "./mobileImports.js";
import { mobilePasswordResetRoutes } from "./mobilePasswordReset.js";
import { mobileProjectRoutes, reconcileRetryablePlanRevisionOperations } from "./mobileProjects.js";
import { sweepStaleVoiceCalls } from "./mobile/voiceCalls.js";
import { startStudioImageSweep, studioImageSweepMode } from "./mobile/studioImageSweep.js";
import { mobileSafetyRoutes } from "./mobileSafety.js";
import { publicShareRoutes } from "./mobile/shares/publicShareRoutes.js";
import { closeQueue, reconcileUndispatchedGenerationJobs } from "./queue.js";
import { loadSerializedProjectStatus } from "./mobile/projectStatusSerializers.js";
import { BOOK_PUSH_SWEEP_INTERVAL_MS, runBookPushSweep } from "./push/bookPushSweep.js";
import { createPushSenderFromConfig } from "./push/pushSender.js";
import { adminAnalyticsRoutes } from "./routes/adminAnalytics.js";
import { adminGenerationQualityRoutes } from "./routes/adminGenerationQuality.js";
import { adminPricingRoutes } from "./routes/adminPricing.js";
import { adminProjectExportRoutes } from "./routes/adminProjectExports.js";
import { adminSafetyRoutes } from "./routes/adminSafety.js";
import { adminAppUpdateRoutes } from "./routes/adminAppUpdates.js";
import { adminShareRoutes } from "./routes/adminShares.js";
import { projectRoutes } from "./routes/projects.js";

const config = loadConfig();
const app = Fastify({
  ...(config.TRUST_PROXY_HOPS > 0 ? { trustProxy: config.TRUST_PROXY_HOPS } : {}),
  logger: {
    redact: [
      "req.headers.authorization",
      "req.headers.cookie",
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

// Renderers have local scratch space only. Reap stale directories after a process crash.
const sweepTemporaryFiles = async () => {
  try {
    await sweepTemporaryDirectories({ minAgeMs: 24 * 60 * 60 * 1000 });
  } catch (error) {
    app.log.warn({ err: error }, "Temporary renderer cleanup failed");
  }
};
await sweepTemporaryFiles();
const temporarySweepTimer = setInterval(() => void sweepTemporaryFiles(), 60 * 60 * 1000);
temporarySweepTimer.unref();

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
await sweepAttachments();
const attachmentSweepTimer = setInterval(() => void sweepAttachments(), 24 * 60 * 60 * 1000);
attachmentSweepTimer.unref();

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
await sweepVoiceCalls();
const voiceCallSweepTimer = setInterval(() => void sweepVoiceCalls(), 30_000);
voiceCallSweepTimer.unref();

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
await sweepAccountDeletions();
const accountDeletionSweepTimer = setInterval(() => void sweepAccountDeletions(), 60 * 60 * 1000);
accountDeletionSweepTimer.unref();

let recoveringMessages = false;
const recoverMessages = async () => {
  if (recoveringMessages) return;
  recoveringMessages = true;
  try {
    await recoverMessageUsage();
  } catch (error) {
    app.log.warn({ err: error }, "Message reservation recovery failed");
  } finally {
    recoveringMessages = false;
  }
};
await recoverMessages();
const messageRecoveryTimer = setInterval(() => void recoverMessages(), 30_000);
messageRecoveryTimer.unref();

// Credit prices are operator-editable and live in the database. Load them before
// anything can be charged, then re-read on a timer so a second API instance
// picks up a change made through the first.
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
await sweepSubscriptionRenewals();
const subscriptionRenewalTimer = setInterval(() => void sweepSubscriptionRenewals(), 60 * 60 * 1000);
subscriptionRenewalTimer.unref();

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
await reconcileQueue();
const queueReconcileTimer = setInterval(() => void reconcileQueue(), 5_000);
queueReconcileTimer.unref();

// Book-progress and book-ready notifications (src/push/bookPushSweep.ts). With
// no FCM key configured the sender is null, a warning is logged once, and the
// sweep never runs. A sweep still running when the next tick comes is not
// doubled: each one reads a dozen queries per followed book.
const pushSender = await createPushSenderFromConfig(config, app.log);
let bookPushSweepRunning = false;
const sweepBookPushes = async () => {
  if (!pushSender || bookPushSweepRunning) {
    return;
  }
  bookPushSweepRunning = true;
  try {
    const swept = await runBookPushSweep({
      sender: pushSender,
      loadStatus: (projectId, userId) => loadSerializedProjectStatus(projectId, config, userId),
      log: app.log
    });
    if (swept.settled > 0 || swept.unregistered > 0 || swept.failed > 0) {
      app.log.info({ event: "push.book_sweep", ...swept }, "Book pushes swept");
    }
  } catch (error) {
    app.log.warn({ err: error, event: "push.book_sweep_failed" }, "Book push sweep failed");
  } finally {
    bookPushSweepRunning = false;
  }
};
const bookPushTimer = pushSender ? setInterval(() => void sweepBookPushes(), BOOK_PUSH_SWEEP_INTERVAL_MS) : null;
bookPushTimer?.unref();

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
await app.register(mobileAuthRoutes);
await app.register(mobileGoogleAuthRoutes);
const mailer = createMailerFromConfig(config, app.log);
if (!mailer) {
  app.log.warn(
    { event: "email.unconfigured" },
    "No SMTP_URL configured; password reset will answer 503 EMAIL_UNAVAILABLE"
  );
}
await app.register(mobilePasswordResetRoutes, { mailer });
await app.register(mobileProjectRoutes);
await app.register(googlePlayRtdnRoutes, { config });
await app.register(mobileImportRoutes);
await app.register(mobileSafetyRoutes);
await app.register(appUpdateRoutes);
// Outside /api/ and outside the auth surface; also named in deploy/nginx.conf.
await app.register(publicShareRoutes);
await app.register(adminPricingRoutes);
await app.register(adminSafetyRoutes);
await app.register(adminAppUpdateRoutes);
await app.register(adminShareRoutes);
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
  clearInterval(temporarySweepTimer);
  clearInterval(attachmentSweepTimer);
  clearInterval(voiceCallSweepTimer);
  clearInterval(messageRecoveryTimer);
  clearInterval(pricingRefreshTimer);
  clearInterval(queueReconcileTimer);
  if (bookPushTimer) clearInterval(bookPushTimer);
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
