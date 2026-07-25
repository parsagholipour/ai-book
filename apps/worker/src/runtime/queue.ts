import { Queue } from "bullmq";
import { Redis } from "ioredis";
import { config } from "./config.js";

/**
 * The worker's Redis connection and BullMQ queue handle.
 *
 * Importing this module opens a Redis connection, so only the worker entry
 * point and the dispatch layer should depend on it. Job handlers must not.
 */

export const BOOK_QUEUE_NAME = "book-maker";

export const connection = new Redis(config.REDIS_URL, { maxRetriesPerRequest: null });

export const queue = new Queue(BOOK_QUEUE_NAME, { connection });
