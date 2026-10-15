import { startSourceProcessing } from "./runtime/sourceProcessing.js";
import { tmpdir } from "node:os";
import {
  browserPoolStatus,
  closeSharedBrowser,
  enforceProductionConfig,
  laneJobForSweep,
  ProductionConfigError,
  unkeyedRoutedProviderMessage,
  workerLaneConcurrency
} from "@book-maker/core";
import { prisma } from "@book-maker/db";
import { reconcileGenerationAttemptRefunds } from "@book-maker/db/billing";
import { objectStore } from "@book-maker/storage";
import {
  reconcileStrandedGeneration,
  reconcileUndispatchedWorkerJobs
} from "./runtime/dispatch.js";
import { config } from "./runtime/config.js";
import { startExportTempCleanup } from "./runtime/exportTempCleanup.js";
import { reconcileLostQueueDeliveries } from "./runtime/lostDeliveries.js";
import { allLaneQueues, closeLaneQueues, connection } from "./runtime/queue.js";
import { startLaneWorkers } from "./runtime/laneWorkers.js";
import { startWorkerHeartbeat } from "./runtime/workerHeartbeat.js";
import { processWorkerJob } from "./processJob.js";
import { savedRoutingProvidersWithoutCredentials } from "./providers/generationTextRouting.js";

// Production refuses to start without its public origin (stored asset URLs are
// built from it) and every provider key the default model routing can select
// (packages/core/src/productionConfig.ts). Every missing setting at once.
try {
  enforceProductionConfig(config, "worker", {
    warn: (issue) => console.warn(issue.message),
    mockAi: (message) => console.error(message)
  });
} catch (error) {
  if (!(error instanceof ProductionConfigError)) throw error;
  console.error(error.message);
  process.exit(1);
}

// Every job here ends in a put to the private bucket, so a worker that cannot
// reach it would claim jobs only to fail them. Refuse before the first claim —
// the deployment's health wait sees a container that will not start, rather
// than a book that failed at its first illustration.
try {
  await objectStore().ready();
} catch (error) {
  console.error("Object storage is not reachable; refusing to take jobs (local development: docker compose up -d minio-init)", error);
  process.exit(1);
}

// A saved Quality-tab route outlives a removed key, and its calls fail here.
void savedRoutingProvidersWithoutCredentials()
  .then((gaps) => {
    for (const gap of gaps) console.warn(unkeyedRoutedProviderMessage(gap));
  })
  .catch((error) => {
    console.warn("Could not check the saved model routing for providers without a key", error);
  });

const sourceProcessing = startSourceProcessing();

const laneConcurrency = workerLaneConcurrency(config);
const laneWorkers = startLaneWorkers({
  connection,
  processor: processWorkerJob,
  concurrency: laneConcurrency
});
// Each lane's proof of life for the API's readiness probe and alert sweep
// (`runtime/workerHeartbeat.ts`): a timer on this event loop, so a wedged
// process stops vouching for itself as surely as a dead one.
const heartbeat = startWorkerHeartbeat({
  store: connection,
  lanes: laneWorkers.workers.map(({ lane, queueName, worker, running }) => ({
    lane,
    queueName,
    concurrency: laneConcurrency[lane],
    isRunning: () => worker.isRunning(),
    running
  }))
});
// A lost-delivery sweep must find a row's job in whichever lane holds it.
const bullLookupAcrossLanes = { getJob: (id: string) => laneJobForSweep(allLaneQueues, id) };

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
    void reconcileLostQueueDeliveries(bullLookupAcrossLanes).catch((error) => {
      console.error("Lost queue delivery reconciliation failed", error);
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
void reconcileLostQueueDeliveries(bullLookupAcrossLanes).catch((error) => {
  console.error("Initial lost queue delivery reconciliation failed", error);
});

// Local render scratch and S3 predecessor objects survive an abrupt exit.
// Collect by age; active local directories carry a heartbeat.
const exportTempCleanup = startExportTempCleanup({
  bookStorageDir: tmpdir(),
  imageStorageDir: tmpdir(),
  minAgeMs: config.EXPORT_TEMP_RETENTION_HOURS * 60 * 60 * 1000
});
void exportTempCleanup.runNow();

for (const { lane, worker } of laneWorkers.workers) {
  worker.on("ready", () => {
    console.log(`Book worker ready on queue "${worker.name}" (${lane} lane)`);
  });
  worker.on("failed", (job, error) => {
    console.error(`Job ${job?.id ?? "unknown"} failed`, error);
  });
  // Where a delivery that lost its lock says so ("Missing lock for job …" when
  // it tries to finish) — the case `deliveryGuard.ts` defers its copy for.
  worker.on("error", (error) => {
    console.error(`Book worker error on queue "${worker.name}"`, error);
  });
}

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
  await sourceProcessing.stop();
  await laneWorkers.close();
  // After the drain: a worker finishing its last job is alive and still says
  // so. The keys then expire on their own rather than being deleted, so a
  // restart that is back within ninety seconds never reads as an outage.
  heartbeat.stop();
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
  await closeLaneQueues();
  connection.disconnect();
  await prisma.$disconnect();
}
