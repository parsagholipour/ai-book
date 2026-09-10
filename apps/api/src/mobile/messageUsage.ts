import { randomUUID } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import type { FastifyReply } from "fastify";
import { prisma, type Prisma } from "@book-maker/db";
import { completeMessageUsage, InsufficientCreditsError, MessageAllowanceError, renewMessageUsage, reserveMessageUsage, settleMessageUsage, type MessageUsageLease } from "@book-maker/db/billing";
import { sendInsufficientCredits, sendMobileError } from "./httpErrors.js";

const currentMessage = new AsyncLocalStorage<MessageUsageLease>();

/** A transcript write closes its charge in the same transaction. Non-chat callers keep their existing behavior. */
export function persistMessageReply<T>(write: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
  const lease = currentMessage.getStore();
  return lease ? completeMessageUsage(lease, write) : write(prisma);
}

export function messageRequestKey(scope: string, requestId?: string): string {
  return `${scope}:${requestId ?? randomUUID()}`;
}

export function sendMessageUsageError(reply: FastifyReply, error: unknown): FastifyReply {
  if (error instanceof InsufficientCreditsError) return sendInsufficientCredits(reply, error);
  if (error instanceof MessageAllowanceError) {
    return sendMobileError(reply, error.code === "MESSAGE_LIMIT_REACHED" ? 429 : 409, error.code, error.message);
  }
  throw error;
}

/** Every accepted user send takes one slot; unsuccessful processing returns its slot and credits. */
export async function withMessageUsage<T>(
  options: { userId: string; requestKey: string; projectId?: string },
  reply: FastifyReply,
  work: () => Promise<T>
): Promise<T | FastifyReply> {
  let leaseId: string;
  try {
    leaseId = await reserveMessageUsage(options);
  } catch (error) {
    return sendMessageUsageError(reply, error);
  }
  const lease = { userId: options.userId, requestKey: options.requestKey, leaseId };
  let renewing = false;
  const heartbeat = setInterval(() => {
    if (renewing) return;
    renewing = true;
    void renewMessageUsage(lease).catch((error: unknown) => {
      reply.log.warn({ err: error }, "Message reservation heartbeat failed");
    }).finally(() => { renewing = false; });
  }, 30_000);
  heartbeat.unref();
  try {
    let result: T;
    try {
      result = await currentMessage.run(lease, work);
    } catch (error) {
      await settleMessageUsage(options.userId, options.requestKey, false, leaseId);
      if (error instanceof MessageAllowanceError) return sendMessageUsageError(reply, error);
      throw error;
    }
    await settleMessageUsage(options.userId, options.requestKey, reply.statusCode < 400, leaseId);
    return result;
  } finally {
    clearInterval(heartbeat);
  }
}
