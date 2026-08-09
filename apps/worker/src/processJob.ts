import { UnrecoverableError, type Job } from "bullmq";
import { maybeCompileAfterCompletedJob } from "./runtime/dispatch.js";
import { createRunLogger, providerConfigSnapshot } from "./providers/runLogging.js";
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
import {
  errorMessage,
  serializeError
} from "./runtime/serialization.js";
import { runWithGenerationAttempt } from "./runtime/generationAttemptContext.js";
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

export async function processWorkerJob(job: Job): Promise<void> {
  await runWithGenerationAttempt(
    typeof job.data.attemptId === "string" ? job.data.attemptId : null,
    async () => {
      const runLogger = createRunLogger(job);
      await runLogger.append("job.start", {
        payload: job.data,
        attemptsMade: job.attemptsMade,
        opts: job.opts,
        providerConfig: providerConfigSnapshot()
      });
      let completion: JobCompletion | undefined;
      let completed = false;
      try {
        // The stale check runs before the row is claimed. A CANCELED row is a
        // settled, refunded verdict; flipping it ACTIVE first (as the old
        // entry point did) overwrote the status this check reads and let
        // refunded work run.
        const staleReason = await staleGenerationJobReason(job);
        if (staleReason) {
          await cancelStaleGenerationJob(job, staleReason);
          await runLogger.append("job.canceled", { reason: staleReason });
          return;
        }
        if (!(await markActive(job))) {
          // The row is already COMPLETED: a stalled delivery brought back a
          // finished job. The work must not run twice, but the fan-in
          // follow-up is idempotent and may be what the crash lost.
          await runLogger.append("job.already_completed", {});
          await maybeCompileAfterCompletedJob(job);
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
        completed = await markCompleted(job);
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
      if (!completed) {
        // A stop or settlement reached the row between the handler finishing
        // and the terminal write; their verdict stands.
        await runLogger.append("job.superseded", {});
        return;
      }
      // Post-completion follow-ups run outside the failure path: the work is
      // delivered and the row is COMPLETED, so a throw here must not reach
      // markFailed — that used to fail the project and refund a finished run.
      // A lost compile fan-in is replayed by a redelivery (above) or the
      // stranded-generation sweeper; a lost plan-book afterJobCompleted leaves
      // the project PLANNING until a redelivery replays it, which is the
      // accepted residual of never refunding delivered work.
      try {
        await completion?.afterJobCompleted?.();
        await runLogger.append("job.completed", {});
        await maybeCompileAfterCompletedJob(job);
      } catch (error) {
        console.error(`Post-completion follow-up failed for ${job.name} job ${job.id ?? "?"}`, error);
        await runLogger
          .append("job.follow_up_failed", { error: serializeError(error) })
          .catch(() => undefined);
      }
    }
  );
}
