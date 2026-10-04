import { randomUUID } from "node:crypto";
import type { FastifyReply } from "fastify";
import { runWithMessageUsage, sendMessageUsageError } from "./messageUsage.js";

/** Count attempts before AI starts; failed work refunds credits, never its slot. */
export function withAiProcessingUsage<T>(userId: string, description: string, work: () => Promise<T>, reply?: FastifyReply): Promise<T> {
  return runWithMessageUsage(
    { userId, requestKey: `processing:${randomUUID()}`, description },
    work,
    () => !reply || reply.statusCode < 400
  );
}

/** Admission errors must escape advisor/provider fallback catches. */
export async function sendProcessingOutcome<T>(reply: FastifyReply, work: () => Promise<T>): Promise<T | FastifyReply> {
  try {
    return await work();
  } catch (error) {
    return sendMessageUsageError(reply, error);
  }
}
