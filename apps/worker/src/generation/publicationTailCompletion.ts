import type { JobCompletion } from "../runtime/jobTypes.js";

type PublicationTailHeartbeat = {
  assertHeld: () => Promise<void>;
  stop: () => Promise<void>;
};

/**
 * The protocol-local actions needed by a delivered publication tail. The
 * protocol keeps ownership predicates and lease/barrier implementations; this
 * seam owns the ordering that makes their cleanup safe.
 */
export interface PublicationTail {
  startHeartbeat: () => PublicationTailHeartbeat;
  run: (assertHeld: () => Promise<void>) => Promise<void>;
  completeLease: () => Promise<void>;
  invalidateExports: () => Promise<void>;
  releaseLease: () => Promise<boolean>;
  abandonExportBarrier: () => Promise<void>;
  reportFailure?: ((phase: "follow-up" | "release", error: unknown) => void) | undefined;
}

export type PublicationTailLeaseWait = "completed" | "abandoned";

/**
 * Completes this delivery's publication-tail lease, or waits for the owner
 * that already holds it.
 *
 * A completion that *failed* may not be swallowed. Returning normally is how
 * `afterJobCompleted` reports success, so Bull marked the job done over a row
 * still holding this delivery's token with `structuralLeaseCompletedAt` NULL:
 * nothing completes it, and nothing releases it either — the catch that hands
 * the lease back only fires on a rejection. Every later delivery then waits
 * out the lease before it can take over a tail whose steps are already
 * checkpointed. Letting a thrown complete travel puts the delivery on that
 * replay lane after the catch has handed the lease back.
 *
 * A false compare-and-set is a different fact — somebody else owns this —
 * and is still not an error. Only an abandoned wait means nobody will write
 * the marker, which is the one case this delivery must not report success.
 */
export async function completeOrWaitPublicationTailLease(options: {
  complete: () => Promise<boolean>;
  wait: () => Promise<PublicationTailLeaseWait>;
  unowned: Error;
}): Promise<void> {
  const completed = await options.complete();
  if (!completed && (await options.wait()) === "abandoned") {
    throw options.unowned;
  }
}

/**
 * Builds the replayable JobCompletion shared by publication protocols.
 *
 * Invalidation is retried before the exact lease is released. Only a
 * successful release proves that no successor is inside the tail, so only
 * then may this delivery abandon its export barrier.
 */
export function publicationTailCompletion(
  tail: PublicationTail,
  options?: { durableCompletionCommitted?: boolean | undefined }
): JobCompletion {
  return {
    ...(options?.durableCompletionCommitted === false
      ? {}
      : { durableCompletionCommitted: true, lifecycleCompletionCommitted: true }),
    retryFollowUpOnRedelivery: true,
    afterJobCompleted: async () => {
      const heartbeat = tail.startHeartbeat();
      try {
        await tail.run(heartbeat.assertHeld);
        await tail.completeLease();
      } catch (error) {
        tail.reportFailure?.("follow-up", error);
        await tail.invalidateExports().catch(() => undefined);
        const released = await tail.releaseLease().catch((releaseError: unknown) => {
          tail.reportFailure?.("release", releaseError);
          return false;
        });
        if (released) {
          await tail.abandonExportBarrier().catch(() => undefined);
        }
        throw error;
      } finally {
        await heartbeat.stop();
      }
    }
  };
}
