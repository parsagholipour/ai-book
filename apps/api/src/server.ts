import cors from "@fastify/cors";
import fastifyStatic from "@fastify/static";
import swagger from "@fastify/swagger";
import swaggerUi from "@fastify/swagger-ui";
import Fastify from "fastify";
import { existsSync } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { browserPoolStatus, closeSharedBrowser, loadConfig } from "@book-maker/core";
import { loadCreditPricing, prisma } from "@book-maker/db";
import { sweepExpiredCreationAttachments } from "./attachmentStorage.js";
import { registerAuth } from "./auth.js";
import { createGooglePlayVerifierFromConfig } from "./googlePlayBilling.js";
import { runSubscriptionRenewalSweep } from "./subscriptionRenewal.js";
import { createMailerFromConfig } from "./mailer.js";
import { mobileAuthRoutes } from "./mobileAuth.js";
import { mobileImportRoutes } from "./mobileImports.js";
import { mobilePasswordResetRoutes } from "./mobilePasswordReset.js";
import { mobileProjectRoutes, reconcileRetryablePlanRevisionOperations } from "./mobileProjects.js";
import { sweepStaleVoiceCalls } from "./mobile/voiceCalls.js";
import { mobileSafetyRoutes } from "./mobileSafety.js";
import { closeQueue, reconcileUndispatchedGenerationJobs } from "./queue.js";
import { adminAnalyticsRoutes } from "./routes/adminAnalytics.js";
import { adminPricingRoutes } from "./routes/adminPricing.js";
import { adminSafetyRoutes } from "./routes/adminSafety.js";
import { projectRoutes } from "./routes/projects.js";

const config = loadConfig();
const app = Fastify({
  logger: {
    redact: [
      "req.headers.authorization",
      "req.headers.cookie",
      "res.headers.set-cookie",
      "body.password",
      "body.newPassword",
      "body.code",
      "body.refreshToken",
      "body.purchaseToken",
      "body.comment",
      "body.reason",
      "body.reviewNotes"
    ]
  }
});

await mkdir(config.BOOK_STORAGE_DIR, { recursive: true });
await mkdir(config.IMAGE_STORAGE_DIR, { recursive: true });
await mkdir(config.VOICE_STORAGE_DIR, { recursive: true });
await mkdir(config.ATTACHMENT_STORAGE_DIR, { recursive: true });
await mkdir(config.AUDIO_STORAGE_DIR, { recursive: true });

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

await app.register(cors, { origin: true, credentials: true });
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
const mailer = createMailerFromConfig(config, app.log);
if (!mailer) {
  app.log.warn(
    { event: "email.unconfigured" },
    "No SMTP_URL configured; password reset will answer 503 EMAIL_UNAVAILABLE"
  );
}
await app.register(mobilePasswordResetRoutes, { mailer });
await app.register(mobileProjectRoutes);
await app.register(mobileImportRoutes);
await app.register(mobileSafetyRoutes);
await app.register(adminPricingRoutes);
await app.register(adminSafetyRoutes);
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
  clearInterval(attachmentSweepTimer);
  clearInterval(voiceCallSweepTimer);
  clearInterval(pricingRefreshTimer);
  clearInterval(queueReconcileTimer);
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
    pathname.startsWith("/assets/images/") ||
    pathname.startsWith("/assets/voice/") ||
    pathname.includes(".")
  );
}
