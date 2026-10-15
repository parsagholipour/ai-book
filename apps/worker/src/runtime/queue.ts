import { Queue } from "bullmq";
import { Redis } from "ioredis";
import {
  GENERATION_JOB_RETENTION,
  INTERACTIVE_JOB_QUEUE,
  LONG_JOB_QUEUE,
  type GenerationJobQueueName,
  type LaneJobLookup
} from "@book-maker/core";
import { config } from "./config.js";

/**
 * The worker's Redis connection and its two lane queues (`jobLanes.ts` in core).
 *
 * Importing this module opens a Redis connection, so only the worker entry
 * point and the dispatch layer should depend on it. Job handlers must not.
 */

/** The long lane keeps the original queue's name; see `LONG_JOB_QUEUE`. */
export const BOOK_QUEUE_NAME = LONG_JOB_QUEUE;

export const connection = new Redis(config.REDIS_URL, { maxRetriesPerRequest: null });

// Retention rides every new job's own options as well as the Workers', so a
// job the stalled checker fails (that path reads the job's options) is bounded too.
const defaultJobOptions = { ...GENERATION_JOB_RETENTION };

/** The long lane, still exported as `queue` because scripts import it by that name. */
export const queue = new Queue(LONG_JOB_QUEUE, { connection, defaultJobOptions });
export const interactiveQueue = new Queue(INTERACTIVE_JOB_QUEUE, { connection, defaultJobOptions });

export function queueNamed(name: GenerationJobQueueName): Queue {
  return name === INTERACTIVE_JOB_QUEUE ? interactiveQueue : queue;
}

/** Every lane, for the lookups that must find a job id wherever an earlier dispatch put it. */
export const allLaneQueues: readonly LaneJobLookup[] = [queue, interactiveQueue];

export async function closeLaneQueues(): Promise<void> {
  await Promise.all([queue.close(), interactiveQueue.close()]);
}
