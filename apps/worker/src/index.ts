import { UnrecoverableError, Worker } from "bullmq";
import { prisma } from "@book-maker/db";
import { reconcileGenerationAttemptRefunds } from "@book-maker/db/billing";
import {
  maybeCompileAfterCompletedJob,
  reconcileUndispatchedWorkerJobs
} from "./runtime/dispatch.js";
import { createRunLogger, providerConfigSnapshot } from "./providers/runLogging.js";
import { config } from "./runtime/config.js";
import {
  STOPPED_JOB_ERROR,
  isStopRequestedError,
  type JobCompletion,
} from "./runtime/jobTypes.js";
import {
  cancelStaleGenerationJob,
  hasStoppedGenerationJob,
  jobMaxAttempts,
  markActive,
  markCompleted,
  markFailed,
  markRecovering,
  markStopped,
  shouldBypassConfiguredRetries,
  shouldRecoverJobAttempt,
  staleGenerationJobReason
} from "./runtime/jobLifecycle.js";
import { BOOK_QUEUE_NAME, connection, queue } from "./runtime/queue.js";
import {
  errorMessage,
  serializeError
} from "./runtime/serialization.js";
import { applyBookEdit } from "./handlers/applyBookEdit.js";
import { buildCharacterPersona, prepareCharacterCandidates } from "./handlers/characters.js";
import { compileExport } from "./handlers/compileExport.js";
import { continueBook } from "./handlers/continueBook.js";
import { generateAudiobook } from "./handlers/generateAudiobook.js";
import { generateBook } from "./handlers/generateBook.js";
import { generateImage } from "./handlers/generateImage.js";
import { generatePage } from "./handlers/generatePage.js";
import { importBook } from "./handlers/importBook.js";
import { planBook, revisePlan } from "./handlers/planning.js";
import { replanBook } from "./handlers/replanBook.js";
import { runWithGenerationAttempt } from "./runtime/generationAttemptContext.js";


const worker = new Worker(
  BOOK_QUEUE_NAME,
  async (job) => runWithGenerationAttempt(
    typeof job.data.attemptId === "string" ? job.data.attemptId : null,
    async () => {
    const runLogger = createRunLogger(job);
    await runLogger.append("job.start", {
      payload: job.data,
      attemptsMade: job.attemptsMade,
      opts: job.opts,
      providerConfig: providerConfigSnapshot()
    });
    await markActive(job);
    let completion: JobCompletion | undefined;
    try {
      const staleReason = await staleGenerationJobReason(job);
      if (staleReason) {
        await cancelStaleGenerationJob(job, staleReason);
        await runLogger.append("job.canceled", { reason: staleReason });
        return;
      }
      switch (job.name) {
        case "plan-book":
          completion = await planBook(job);
          break;
        case "revise-plan":
          await revisePlan(job);
          break;
        case "generate-book":
          await generateBook(job);
          break;
        case "generate-page":
          await generatePage(job);
          break;
        case "generate-image":
          await generateImage(job);
          break;
        case "compile-export":
          await compileExport(job);
          break;
        case "apply-book-edit":
          await applyBookEdit(job);
          break;
        case "replan-book":
          await replanBook(job);
          break;
        case "prepare-character-candidates":
          await prepareCharacterCandidates(job);
          break;
        case "build-character-persona":
          await buildCharacterPersona(job);
          break;
        case "import-book":
          await importBook(job);
          break;
        case "continue-book":
          await continueBook(job);
          break;
        case "generate-audiobook":
          await generateAudiobook(job);
          break;
        default:
          throw new Error(`Unknown worker job: ${job.name}`);
      }
      await markCompleted(job);
      await completion?.afterJobCompleted?.();
      await runLogger.append("job.completed", {});
      await maybeCompileAfterCompletedJob(job);
    } catch (error) {
      if (isStopRequestedError(error)) {
        await runLogger.append("job.stopped", {});
        await markStopped(job);
        throw new UnrecoverableError(STOPPED_JOB_ERROR);
      }

      if (await hasStoppedGenerationJob(job.data.generationJobId as string | undefined)) {
        await runLogger.append("job.stopped", { interruptedError: serializeError(error) });
        await markStopped(job);
        throw new UnrecoverableError(STOPPED_JOB_ERROR);
      }

      if (shouldRecoverJobAttempt(job, error)) {
        await runLogger.append("job.recovering", {
          error: serializeError(error),
          attempt: job.attemptsMade + 1,
          maxAttempts: jobMaxAttempts(job)
        });
        await markRecovering(job, error);
        throw error;
      }

      await runLogger.append("job.failed", { error: serializeError(error) });
      await markFailed(job, error);
      if (shouldBypassConfiguredRetries(job, error)) {
        throw new UnrecoverableError(errorMessage(error));
      }
      throw error;
    }
    }
  ),
  {
    connection,
    concurrency: Math.max(config.MAX_PARALLEL_PAGE_JOBS, config.MAX_PARALLEL_IMAGE_JOBS)
  }
);

const queueReconcileTimer = setInterval(() => {
  void reconcileUndispatchedWorkerJobs().catch((error) => {
    console.error("Generation queue reconciliation failed", error);
  });
  void reconcileGenerationAttemptRefunds().catch((error) => {
    console.error("Generation attempt refund reconciliation failed", error);
  });
}, 5_000);
queueReconcileTimer.unref();
void reconcileUndispatchedWorkerJobs().catch((error) => {
  console.error("Initial generation queue reconciliation failed", error);
});
void reconcileGenerationAttemptRefunds().catch((error) => {
  console.error("Initial generation attempt refund reconciliation failed", error);
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
