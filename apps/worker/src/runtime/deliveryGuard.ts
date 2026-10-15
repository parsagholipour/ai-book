import { DelayedError } from "bullmq";

/**
 * Refuses a second, concurrent delivery of a GenerationJob this process is
 * already running, by putting it back until the first has finished.
 *
 * BullMQ reclaims a job whose lock was not renewed for `lockDuration` — an
 * event loop held past it, or Redis unreachable for that long — and hands it
 * out again while the first execution is still running. `markActive` accepts
 * an ACTIVE row on purpose (a crashed worker's job must be resumable), so
 * nothing below this line could tell the two deliveries apart. While the
 * worker ran one job at a time, the reclaimed copy could only start after the
 * first ended, and every handler's redelivery path is written for exactly that
 * order: a COMPLETED row replays its tail, a settled attempt is refused before
 * the claim. Two lanes and a concurrency above one would let the copy start
 * beside the original, in this same process. Deferring it restores that order
 * rather than inventing a new one: the copy runs when the original is gone —
 * never refused, so a delivery the original lost its Bull lock to (it cannot
 * finish its own Bull job any more) is still the one that settles it.
 *
 * Keyed by the durable row id, so a copy of the same row in the other lane —
 * a previous release queued it in `book-maker`, this one in
 * `book-maker-interactive` — is held too. It is one process's guard and makes
 * no claim about a second worker process: that duplicate needs a lock lost the
 * same way, as before, and the handlers' own fences (delivery tokens, revision
 * claims, the attempt state machine) are what answer it.
 */

/** Long enough not to spin a lane slot, short enough that a resumed job waits little after the original ends. */
export const DUPLICATE_DELIVERY_DEFER_MS = 30_000;

type GuardableJob = {
  id?: string | undefined;
  name: string;
  data: unknown;
  moveToDelayed(timestamp: number, token?: string): Promise<void>;
};

export type DeliveryGuard = {
  wrap<J extends GuardableJob>(processor: (job: J, token?: string) => Promise<void>): (job: J, token?: string) => Promise<void>;
  /** Row ids running in this process right now (for tests and diagnostics). */
  running(): ReadonlySet<string>;
};

export function createDeliveryGuard(options: { deferMs?: number; now?: () => number } = {}): DeliveryGuard {
  const deferMs = options.deferMs ?? DUPLICATE_DELIVERY_DEFER_MS;
  const now = options.now ?? Date.now;
  const inFlight = new Set<string>();
  return {
    running: () => inFlight,
    wrap(processor) {
      return async (job, token) => {
        const key = deliveryKey(job);
        if (key === null) {
          await processor(job, token);
          return;
        }
        if (inFlight.has(key)) {
          console.warn("Deferring a second concurrent delivery of a running job", {
            event: "generation.duplicate_delivery_deferred",
            generationJobId: key,
            bullJobId: job.id ?? null,
            name: job.name,
            deferMs
          });
          await job.moveToDelayed(now() + deferMs, token);
          // BullMQ's signal that the processor moved its own job: no failure,
          // no attempt spent, and the job comes back from `delayed`.
          throw new DelayedError();
        }
        inFlight.add(key);
        try {
          await processor(job, token);
        } finally {
          inFlight.delete(key);
        }
      };
    }
  };
}

/** The durable row id the delivery names, else the Bull id (a legacy job); null when neither is readable. */
function deliveryKey(job: GuardableJob): string | null {
  const data = job.data;
  if (data && typeof data === "object" && !Array.isArray(data)) {
    const id = (data as Record<string, unknown>).generationJobId;
    if (typeof id === "string" && id) return id;
  }
  return job.id ? job.id : null;
}
