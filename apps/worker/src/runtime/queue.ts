import { Queue } from "bullmq";
import { Redis } from "ioredis";
import {
  BACKGROUND_JOB_QUEUE,
  COMPILE_JOB_QUEUE,
  GENERATION_JOB_RETENTION,
  IMAGE_JOB_QUEUE,
  INTERACTIVE_JOB_QUEUE,
  LONG_JOB_QUEUE,
  type GenerationJobQueueName,
  type LaneJobLookup
} from "@book-maker/core";
import { config } from "./config.js";

/**
 * The worker's Redis connection and its five lane queues (`jobLanes.ts` in core).
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
export const imageQueue = new Queue(IMAGE_JOB_QUEUE, { connection, defaultJobOptions });
export const compileQueue = new Queue(COMPILE_JOB_QUEUE, { connection, defaultJobOptions });
export const backgroundQueue = new Queue(BACKGROUND_JOB_QUEUE, { connection, defaultJobOptions });

const QUEUES_BY_NAME: Readonly<Record<GenerationJobQueueName, Queue>> = {
  [LONG_JOB_QUEUE]: queue,
  [INTERACTIVE_JOB_QUEUE]: interactiveQueue,
  [IMAGE_JOB_QUEUE]: imageQueue,
  [COMPILE_JOB_QUEUE]: compileQueue,
  [BACKGROUND_JOB_QUEUE]: backgroundQueue
};

export function queueNamed(name: GenerationJobQueueName): Queue {
  return QUEUES_BY_NAME[name];
}

/** Every lane, for the lookups that must find a job id wherever an earlier dispatch put it. */
export const allLaneQueues: readonly LaneJobLookup[] = Object.values(QUEUES_BY_NAME);

export async function closeLaneQueues(): Promise<void> {
  await Promise.all(Object.values(QUEUES_BY_NAME).map((laneQueue) => laneQueue.close()));
}
