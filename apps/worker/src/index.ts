import { Worker } from "bullmq";
import { browserPoolStatus, closeSharedBrowser } from "@book-maker/core";
import { prisma } from "@book-maker/db";
import { reconcileGenerationAttemptRefunds } from "@book-maker/db/billing";
import {
  reconcileStrandedGeneration,
  reconcileUndispatchedWorkerJobs
} from "./runtime/dispatch.js";
import { config } from "./runtime/config.js";
import { startExportTempCleanup } from "./runtime/exportTempCleanup.js";
import { BOOK_QUEUE_NAME, connection, queue } from "./runtime/queue.js";
import { processWorkerJob } from "./processJob.js";


const worker = new Worker(BOOK_QUEUE_NAME, processWorkerJob, {
  connection,
  concurrency: Math.max(config.MAX_PARALLEL_PAGE_JOBS, config.MAX_PARALLEL_IMAGE_JOBS)
});

// The stranded sweep runs on a slower cadence than the dispatch sweep: it is a
// safety net for a worker that died between finishing the last page and
// enqueueing the compile, not a hot path.
const STRANDED_SWEEP_EVERY_TICKS = 12;
let reconcileTick = 0;
const queueReconcileTimer = setInterval(() => {
  void reconcileUndispatchedWorkerJobs().catch((error) => {
    console.error("Generation queue reconciliation failed", error);
  });
  void reconcileGenerationAttemptRefunds().catch((error) => {
    console.error("Generation attempt refund reconciliation failed", error);
  });
  reconcileTick += 1;
  if (reconcileTick % STRANDED_SWEEP_EVERY_TICKS === 0) {
    void reconcileStrandedGeneration().catch((error) => {
      console.error("Stranded generation reconciliation failed", error);
    });
  }
}, 5_000);
queueReconcileTimer.unref();
void reconcileUndispatchedWorkerJobs().catch((error) => {
  console.error("Initial generation queue reconciliation failed", error);
});
void reconcileGenerationAttemptRefunds().catch((error) => {
  console.error("Initial generation attempt refund reconciliation failed", error);
});
void reconcileStrandedGeneration().catch((error) => {
  console.error("Initial stranded generation reconciliation failed", error);
});

// A compile renders beside its destinations and a PDF render writes the
// document Chrome reads; both are removed by a `finally` that a SIGKILL or an
// OOM kill never reaches. Nothing else would ever notice those files, so they
// are collected by age — never by "this process just started", which would
// delete the compile a second worker is running right now.
const exportTempCleanup = startExportTempCleanup({
  bookStorageDir: config.BOOK_STORAGE_DIR,
  imageStorageDir: config.IMAGE_STORAGE_DIR,
  minAgeMs: config.EXPORT_TEMP_RETENTION_HOURS * 60 * 60 * 1000
});
void exportTempCleanup.runNow();

worker.on("ready", () => {
  console.log(`Book worker ready on queue "${BOOK_QUEUE_NAME}"`);
});

worker.on("failed", (job, error) => {
  console.error(`Job ${job?.id ?? "unknown"} failed`, error);
});

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

async function shutdown() {
  clearInterval(queueReconcileTimer);
  // Before the worker, because a scan holds an open directory handle and has no
  // job to finish: it is cancelled between entries and settles immediately,
  // rather than running on into the disconnects below.
  await exportTempCleanup.stop();
  await worker.close();
  // After the worker, so no render is mid-flight; before the database, because
  // a pooled Chromium outlives the job that opened it and would otherwise keep
  // the process alive.
  await closeSharedBrowser();
  // Bounded, so it can be awaited here — which means it can also give up. A
  // browser that answered neither `close()` nor SIGKILL outlives this process,
  // and the only place that is knowable is here.
  const stranded = browserPoolStatus().abandonedProcesses;
  if (stranded.length > 0) {
    console.error("Chromium processes survived shutdown", stranded);
  }
  await queue.close();
  connection.disconnect();
  await prisma.$disconnect();
}
