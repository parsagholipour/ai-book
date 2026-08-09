import { Worker } from "bullmq";
import { prisma } from "@book-maker/db";
import { reconcileGenerationAttemptRefunds } from "@book-maker/db/billing";
import {
  reconcileStrandedGeneration,
  reconcileUndispatchedWorkerJobs
} from "./runtime/dispatch.js";
import { config } from "./runtime/config.js";
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

worker.on("ready", () => {
  console.log(`Book worker ready on queue "${BOOK_QUEUE_NAME}"`);
});

worker.on("failed", (job, error) => {
  console.error(`Job ${job?.id ?? "unknown"} failed`, error);
});

process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());

async function shutdown() {
  clearInterval(queueReconcileTimer);
  await worker.close();
  await queue.close();
  connection.disconnect();
  await prisma.$disconnect();
}
