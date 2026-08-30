import { UnrecoverableError } from "bullmq";
import { errorMessage } from "@book-maker/core";
import { maybeCompileAfterCompletedJob } from "./runtime/dispatch.js";
import { createRunLogger, providerConfigSnapshot, type RunLogger } from "./providers/runLogging.js";
import {
  STOPPED_JOB_ERROR,
  isStopRequestedError,
  isStructuralRollbackRedeliveryError,
  isUnownedReplanDeliveryError,
  isUnownedStructuralDeliveryError,
  isUnownedTextEditDeliveryError,
  type JobCompletion,
} from "./runtime/jobTypes.js";
import {
  cancelStaleGenerationJob,
  hasStoppedGenerationJob,
  jobMaxAttempts,
  markActive,
  markCompleted,
  markFailed,
  markMalformedJobFailed,
  markRecovering,
  markStopped,
  shouldBypassConfiguredRetries,
  shouldRecoverJobAttempt,
  staleGenerationJobReason
} from "./runtime/jobLifecycle.js";
import { serializeError } from "./runtime/serialization.js";
import { runWithGenerationAttempt } from "./runtime/generationAttemptContext.js";
import { applyBookEdit } from "./handlers/applyBookEdit.js";
import { buildCharacterPersona, prepareCharacterCandidates } from "./handlers/characters.js";
import { compileExport } from "./handlers/compileExport.js";
import { continueBook } from "./handlers/continueBook.js";
import { generateAudiobook } from "./handlers/generateAudiobook.js";
import { generateCharacterPortrait } from "./handlers/characterPortrait.js";
import { generateBook, stagedReplanSuccessorOperationId } from "./handlers/generateBook.js";
import { generateImage } from "./handlers/generateImage.js";
import { generatePage } from "./handlers/generatePage.js";
import { importBook } from "./handlers/importBook.js";
import { planBook, revisePlan } from "./handlers/planning.js";
import { replanBook } from "./handlers/replanBook.js";
import {
  parseWorkerJob,
  workerJobStringField,
  type AnyWorkerJob,
  type RawWorkerJob
} from "./runtime/jobPayloads.js";

export async function processWorkerJob(rawJob: RawWorkerJob): Promise<void> {
  await runWithGenerationAttempt(workerJobStringField(rawJob, "attemptId") ?? null, async () => {
    let job: AnyWorkerJob;
    try {
      job = parseWorkerJob(rawJob);
    } catch (error) {
      // Validation is part of processing rather than Worker construction so a
      // malformed delivery follows the same failed-row/Bull settlement path as
      // a handler error. No lifecycle claim or handler has run at this point.
      const runLogger = createRunLogger(rawJob);
      await runLogger.append("job.failed", { error: serializeError(error), payload: rawJob.data });
      await markMalformedJobFailed(rawJob, error);
      throw new UnrecoverableError(errorMessage(error));
    }

    const runLogger = createRunLogger(job);
    await runLogger.append("job.start", {
      payload: job.data,
      attemptsMade: job.attemptsMade,
      opts: job.opts,
      providerConfig: providerConfigSnapshot()
    });
    await processValidatedWorkerJob(job, runLogger);
  });
}

async function processValidatedWorkerJob(job: AnyWorkerJob, runLogger: RunLogger): Promise<void> {
  let completion: JobCompletion | undefined;
  let completed = false;
  let replayCompletedDurableTail = false;
  let stagedReplanDelivery = false;
  try {
    // The stale check runs before the row is claimed. A CANCELED row is a
    // settled, refunded verdict; flipping it ACTIVE first (as the old entry
    // point did) overwrote the status this check reads and let refunded work run.
    const staleReason = await staleGenerationJobReason(job);
    if (staleReason) {
      await cancelStaleGenerationJob(job, staleReason);
      await runLogger.append("job.canceled", { reason: staleReason });
      return;
    }
    // The handler's own fork gate, asked here so the two cannot disagree: a
    // pre-staging replan successor is regenerated through the ordinary book
    // path, and that path is destructive, so it may never be handed a replay.
    stagedReplanDelivery = job.name === "generate-book" && (await stagedReplanSuccessorOperationId(job)) !== null;
    if (!(await markActive(job))) {
      // The row is already COMPLETED: a stalled delivery brought back a
      // finished job. The work must not run twice, but publication may have
      // committed the row immediately before this process died, before the
      // attempt/edit-operation success settlement ran. `markCompleted` is
      // idempotent over COMPLETED and closes that crash window; the fan-in
      // follow-up is idempotent too and may be the other thing the crash lost.
      await runLogger.append("job.already_completed", {});
      completed = true;
      // Every replay kind takes that settlement, not only the replan. An image
      // apply publishes outside `claimDurableEditCompletionTx` and returns
      // void, so `markCompleted` here is the only thing that ever marks its
      // paid attempt SUCCEEDED — and its two statements are not one
      // transaction, which is precisely the crash this branch replays.
      await markCompleted(job);
      if (stagedReplanDelivery || job.name === "apply-book-edit" || job.name === "continue-book") {
        // Replan publication terminalizes this row in the manuscript
        // transaction. A Bull retry after a tail outage must still reach the
        // APPLIED operation's checkpointed follow-up, without reopening the
        // row or entering the failure/refund boundary.
        replayCompletedDurableTail = true;
      } else {
        await maybeCompileAfterCompletedJob(job);
        return;
      }
    }
    if (!replayCompletedDurableTail) {
      switch (job.name) {
        case "plan-book":
          completion = await planBook(job);
          break;
        case "revise-plan":
          await revisePlan(job);
          break;
        case "generate-book":
          completion = (await generateBook(job)) ?? undefined;
          break;
        case "generate-page":
          await generatePage(job);
          break;
        case "generate-image":
          await generateImage(job);
          break;
        case "compile-export":
          completion = await compileExport(job);
          break;
        case "apply-book-edit":
          completion = (await applyBookEdit(job)) ?? undefined;
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
          completion = await continueBook(job);
          break;
        case "generate-audiobook":
          await generateAudiobook(job);
          break;
        case "generate-character-portrait":
          await generateCharacterPortrait(job);
          break;
        default:
          unreachableWorkerJob(job);
      }
    } else if (job.name === "generate-book") {
      completion = (await generateBook(job)) ?? undefined;
    } else if (job.name === "apply-book-edit") {
      completion = (await applyBookEdit(job)) ?? undefined;
    } else if (job.name === "continue-book") {
      completion = await continueBook(job);
    }
    if (!replayCompletedDurableTail) {
      if (completion?.lifecycleCompletionCommitted) {
        completed = true;
      } else {
        try {
          completed = await markCompleted(job, completion?.lifecycleSettlement);
        } catch (error) {
          if (!completion?.durableCompletionCommitted) throw error;
          completed = true;
          await runLogger
            .append("job.completion_bookkeeping_failed", { error: serializeError(error) })
            .catch(() => undefined);
        }
      }
    }
  } catch (error) {
    if (isStructuralRollbackRedeliveryError(error)) {
      // Before stop and markFailed: both of those refund the ACTIVE operation
      // and restore COMPLETE, and the revert did not land.
      await runLogger.append("job.structural_rollback_redelivery", { error: serializeError(error) });
      throw new UnrecoverableError(errorMessage(error));
    }

    if (isUnownedReplanDeliveryError(error)) {
      // Lease loss is a supersession verdict even if cancellation or a failure
      // reached the shared job while this stale provider call was returning.
      await runLogger.append("job.unowned_replan_delivery", { error: serializeError(error) });
      throw new UnrecoverableError(errorMessage(error));
    }

    if (isStopRequestedError(error)) {
      await runLogger.append("job.stopped", {});
      await markStopped(job);
      throw new UnrecoverableError(STOPPED_JOB_ERROR);
    }

    if (await hasStoppedGenerationJob(job.data.generationJobId)) {
      await runLogger.append("job.stopped", { interruptedError: serializeError(error) });
      await markStopped(job);
      throw new UnrecoverableError(STOPPED_JOB_ERROR);
    }

    if (isUnownedStructuralDeliveryError(error)) {
      // A waiter that never acquired the lease. Completing would block the
      // owner's later markFailed; failing would refund a live insert.
      await runLogger.append("job.unowned_structural_delivery", { error: serializeError(error) });
      throw new UnrecoverableError(errorMessage(error));
    }

    if (isUnownedTextEditDeliveryError(error)) {
      // Same ownership answer as the structural waiter: the live delivery owns
      // the shared job and its charge, so this loser settles neither.
      await runLogger.append("job.unowned_text_edit_delivery", { error: serializeError(error) });
      throw new UnrecoverableError(errorMessage(error));
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
    // A stop or settlement reached the row between the handler finishing and
    // the terminal write; their verdict stands.
    await runLogger.append("job.superseded", {});
    return;
  }
  // Post-completion follow-ups run outside the failure path: the work is
  // delivered and the row is COMPLETED, so a throw here must not reach
  // markFailed — that used to fail the project and refund a finished run.
  // Compile-export's optional character-candidate fan-out belongs here too:
  // publication terminalizes its row before the handler returns, and an
  // enqueue outage must not make Bull report a failed export whose files are
  // already downloadable or strand the attempt/edit settlement above.
  try {
    await completion?.afterJobCompleted?.();
    await runLogger.append("job.completed", {});
    if (stagedReplanDelivery) {
      await markCompleted(job);
    } else if (
      !completion?.retryFollowUpOnRedelivery &&
      !(replayCompletedDurableTail && job.name === "continue-book")
    ) {
      // A replayable completion owns its own checkpointed enqueue. Running
      // generic fan-in here would attach a second, optionless compile policy
      // after the continuation tail has already durably selected its owner.
      await maybeCompileAfterCompletedJob(job);
    }
  } catch (error) {
    console.error(`Post-completion follow-up failed for ${job.name} job ${job.id ?? "?"}`, error);
    await runLogger
      .append("job.follow_up_failed", { error: serializeError(error) })
      .catch(() => undefined);
    if (replayCompletedDurableTail || completion?.retryFollowUpOnRedelivery) {
      // Outside the handler failure boundary: Bull retries the missing tail,
      // while the durable COMPLETED/APPLIED verdicts remain intact. Every job
      // name that can reach this line therefore needs an attempt budget in
      // `retryJobOptions` — without one the throw is only a failed Bull job
      // over work nothing will replay.
      throw error;
    }
  }
}

function unreachableWorkerJob(job: never): never {
  throw new Error(`Validated worker job has no handler: ${String(job)}`);
}
