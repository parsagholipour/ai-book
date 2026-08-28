import { errorMessage } from "@book-maker/core";
import { isStopRequestedError, type WorkerImageAsset } from "../runtime/jobTypes.js";
import { appendCharacterReferenceRunLog } from "./characterReferenceRunLog.js";
import { ensureCharacterReferenceAssets, type CharacterReferenceRenderOptions } from "./characterReferences.js";

/**
 * Reference sheets for a caller that owns a picture, not a retry ladder.
 *
 * A sheet is an *enhancement*: it keeps a character looking like itself from
 * one page to the next. It is never a precondition for drawing anything, which
 * is the same reading `characterReferenceSetIsSettled` already takes of a
 * refusal — "the book finishes without it". What was missing is that a pass can
 * now fail without answering at all.
 *
 * `ensureCharacterReferenceAssets` used to block on `pg_advisory_xact_lock` for
 * the whole render, so from a caller's side it either answered or the book was
 * already over. Since `characterReferenceRenderLease.ts` split it into claim /
 * render / commit it runs two *interactive* transactions, each with a
 * `maxWait` of `CHARACTER_REFERENCE_POOL_WAIT_MS`, and neither it nor
 * `runCharacterReferenceRenderPass` catches anything. A P2024 pool timeout is
 * therefore an ordinary outcome — `MAX_PARALLEL_IMAGE_JOBS + 1` jobs reach the
 * claim at once by design, and a commit holds a connection while they do — and
 * so are a claim or commit that aborts.
 *
 * That throw has two very different prices, and neither is one a missing sheet
 * is worth:
 *
 *   cover  `generate-cover` runs inside `generate-image`, which has no BullMQ
 *          attempts (`retryJobOptions`) and is not in
 *          `DERIVATIVE_GENERATION_JOBS`, so `markFailed` sets the project
 *          FAILED and refunds `FULL_BOOK_GENERATION`. The cover is the last
 *          thing a book makes: every page is written and charged for. This is
 *          exactly the incident "a cover that cannot be drawn now finishes the
 *          book instead of failing it" was written for, reached ~70 lines above
 *          the `designedCover` fallback that closed it.
 *   page   the interior handler's catch marks `Page.imageFailureReason`, which
 *          is durable and which nothing retries — so a ten-second pool timeout
 *          permanently cost a page the illustration nobody ever tried to draw.
 *
 * Tolerating it here rather than inside `ensureCharacterReferenceAssets` is the
 * point: `generate-book` and the book passes are in `NETWORK_RETRYABLE_JOB_NAMES`,
 * and their retry ladder *is* the right answer to an outage — a whole cast drawn
 * once for a book is worth a retry, one page's consistency aid is not. Only the
 * two callers with no retry budget give the sheets up.
 *
 * A `StopRequestedError` still travels. Swallowing one turns a run the reader
 * cancelled into a book they are charged for, and this sits under the same rule
 * as every other fallback in the worker.
 *
 * The give-up is written down for the reason every other one in this module
 * group is: from the finished book, a page drawn with no sheet looks the same
 * whatever the cause, and this is now the fifth cause. It goes in the same
 * `<run>-character-references.jsonl` as the refusals and the stand-downs, plus
 * a `console.warn` in the shape the interior-image rescue already uses, since a
 * run log is a file inside the project directory and an operator watching the
 * process sees only the line.
 */
export async function characterReferenceAssetsOrNone(
  options: CharacterReferenceRenderOptions,
  drawing: "cover" | "page-illustration"
): Promise<WorkerImageAsset[]> {
  try {
    return await ensureCharacterReferenceAssets(options);
  } catch (error) {
    if (isStopRequestedError(error)) {
      throw error;
    }
    const reason = errorMessage(error);
    console.warn("Character reference sheets are unavailable; drawing without them", {
      event: "generation.consistency_warning",
      warning: "character_references_unavailable",
      projectId: options.projectId,
      planId: options.planId,
      drawing,
      error: reason
    });
    await appendCharacterReferenceRunLog(
      {
        projectId: options.projectId,
        planId: options.planId,
        generationJobId: options.generationJobId
      },
      "character.reference.unavailable",
      { drawing, error: reason }
    );
    return [];
  }
}
