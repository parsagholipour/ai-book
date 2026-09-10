import { randomUUID } from "node:crypto";
import { jsonRecord, messagePolicy, type PlanTier } from "@book-maker/core";
import { prisma } from "./client.ts";
import { type BillingTx, runSerializable } from "./billingInternals.ts";
import { commitReservedCreditsTx, refundCreditLedgerEntryTx, reserveCreditsTx } from "./billingLedger.ts";
import { resolvePlanTierTx } from "./planPeriods.ts";

const MESSAGE_COUNTER = "ordinary_messages";
const MESSAGE_LEASE_MS = 10 * 60_000;

export type MessageUsageLease = { userId: string; requestKey: string; leaseId: string };
type Reservation = {
  id: string; userId: string; requestKey: string; periodKey: string; resetCount: number;
  status: string; ledgerEntryId: string | null; leaseId: string; expiresAt: Date;
};

export type MessageAllowance = {
  tier: PlanTier;
  used: number;
  limit: number;
  remaining: number;
  creditsPerMessage: number;
  resetEnabled: boolean;
  resetCredits: number;
  resetsAt: string;
  resetToken: string;
};

const MESSAGE_ALLOWANCE_ERRORS = {
  MESSAGE_LIMIT_REACHED: "You've reached your daily message limit. Wait for the daily refresh or reset your allowance.",
  MESSAGE_QUOTE_CHANGED: "Your message allowance or reset price changed. Review the updated amount and try again.",
  MESSAGE_RESET_UNAVAILABLE: "A reset is only available when your message allowance is used up.",
  REQUEST_IN_PROGRESS: "That message is already being processed. Try again in a moment."
} as const;

export class MessageAllowanceError extends Error {
  constructor(readonly code: keyof typeof MESSAGE_ALLOWANCE_ERRORS) {
    super(MESSAGE_ALLOWANCE_ERRORS[code]);
    this.name = "MessageAllowanceError";
  }
}

function dayWindow(now: Date) {
  const periodKey = now.toISOString().slice(0, 10);
  return { periodKey, resetsAt: new Date(`${periodKey}T00:00:00.000Z`).getTime() + 86_400_000 };
}

function counterKey(userId: string, periodKey: string) {
  return { userId, kind: MESSAGE_COUNTER, periodKey };
}

function allowance(tier: PlanTier, now: Date, row: { used: number; resetCount: number } | null): MessageAllowance {
  const policy = messagePolicy(tier);
  const day = dayWindow(now);
  const used = row?.used ?? 0;
  return {
    tier, used, limit: policy.dailyLimit,
    remaining: Math.max(0, policy.dailyLimit - used),
    creditsPerMessage: policy.creditsPerMessage,
    resetEnabled: policy.resetEnabled && policy.dailyLimit > 0,
    resetCredits: policy.resetCredits,
    resetsAt: new Date(day.resetsAt).toISOString(),
    resetToken: `${day.periodKey}:${row?.resetCount ?? 0}:${policy.dailyLimit}`
  };
}

/** The user row serializes sends and resets across API processes and devices. */
async function messageTransaction<T>(userId: string, work: (tx: BillingTx) => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await runSerializable(async (tx) => {
        await tx.$queryRaw`SELECT "id" FROM "User" WHERE "id" = ${userId} FOR UPDATE`;
        return work(tx);
      });
    } catch (error) {
      const code = error && typeof error === "object" && "code" in error ? error.code : null;
      if (attempt >= 4 || (code !== "P2034" && code !== "P2002")) throw error;
    }
  }
}

export async function getMessageAllowance(userId: string, now = new Date()): Promise<MessageAllowance> {
  await recoverMessageUsage({ userId, now });
  const [tier, row] = await Promise.all([
    resolvePlanTierTx(prisma, userId, now),
    prisma.usageCounter.findUnique({ where: { userId_kind_periodKey: counterKey(userId, dayWindow(now).periodKey) } })
  ]);
  return allowance(tier, now, row);
}

/** Reserves a slot even when the message is free. AI work runs outside this transaction. */
export async function reserveMessageUsage(options: {
  userId: string; requestKey: string; projectId?: string | undefined; now?: Date | undefined;
}): Promise<string> {
  const now = options.now ?? new Date();
  // Recovery commits separately: a later cap/credit refusal must not roll its
  // refunds back. This also makes a same-request retry recover without a cron.
  await recoverMessageUsage({ userId: options.userId, now });
  return messageTransaction(options.userId, async (tx) => {
    const existing = await tx.messageUsageReservation.findUnique({
      where: { userId_requestKey: { userId: options.userId, requestKey: options.requestKey } }
    });
    if (existing && existing.status !== "REFUNDED") {
      throw new MessageAllowanceError("REQUEST_IN_PROGRESS");
    }
    const tier = await resolvePlanTierTx(tx, options.userId, now);
    const policy = messagePolicy(tier);
    const periodKey = dayWindow(now).periodKey;
    const key = counterKey(options.userId, periodKey);
    const counter = await tx.usageCounter.upsert({
      where: { userId_kind_periodKey: key }, create: key, update: {}
    });
    if (counter.used >= policy.dailyLimit) {
      throw new MessageAllowanceError("MESSAGE_LIMIT_REACHED");
    }
    // A failed send's retry is a new ledger attempt: a refunded ledger key may never be reused.
    const ledger = await reserveCreditsTx(tx, {
      userId: options.userId, projectId: options.projectId,
      operation: "CHAT_MESSAGE", amountCredits: policy.creditsPerMessage,
      idempotencyKey: `chat-message:${options.userId}:${randomUUID()}`, now,
      metadata: { pricingKey: policy.messagePricingKey, quantity: 1, planTier: tier }
    });
    const data = {
      periodKey, resetCount: counter.resetCount, status: "RESERVED", ledgerEntryId: ledger?.id ?? null,
      leaseId: randomUUID(), expiresAt: new Date(now.getTime() + MESSAGE_LEASE_MS)
    };
    const reservation = await tx.messageUsageReservation.upsert({
      where: { userId_requestKey: { userId: options.userId, requestKey: options.requestKey } },
      create: { userId: options.userId, requestKey: options.requestKey, ...data }, update: data
    });
    await tx.usageCounter.update({ where: { id: counter.id }, data: { used: { increment: 1 } } });
    return reservation.leaseId;
  });
}

/** Also called on a durable transcript replay, repairing a crash after the reply was saved. */
export async function settleMessageUsage(userId: string, requestKey: string, succeeded: boolean, leaseId?: string): Promise<void> {
  await messageTransaction(userId, async (tx) => {
    const reservation = await tx.messageUsageReservation.findUnique({ where: { userId_requestKey: { userId, requestKey } } });
    if (!reservation || reservation.status !== "RESERVED" || (leaseId && reservation.leaseId !== leaseId)) return;
    await settleMessageUsageTx(tx, reservation, succeeded);
  });
}

async function settleMessageUsageTx(tx: BillingTx, reservation: Reservation, succeeded: boolean): Promise<void> {
  if (reservation.ledgerEntryId) {
    if (succeeded) await commitReservedCreditsTx(tx, reservation.ledgerEntryId);
    else await refundCreditLedgerEntryTx(tx, reservation.ledgerEntryId, "Chat message could not be completed.");
  }
  if (!succeeded) {
    // A previous cycle's failure must not give a slot to the allowance bought after it.
    await tx.usageCounter.updateMany({
      where: { ...counterKey(reservation.userId, reservation.periodKey), resetCount: reservation.resetCount, used: { gt: 0 } },
      data: { used: { decrement: 1 } }
    });
  }
  await tx.messageUsageReservation.update({
    where: { id: reservation.id }, data: { status: succeeded ? "SETTLED" : "REFUNDED" }
  });
}

/** Renew only the current, still-live attempt; a late heartbeat cannot revive it. */
export async function renewMessageUsage(lease: MessageUsageLease, now = new Date()): Promise<boolean> {
  return messageTransaction(lease.userId, async (tx) => {
    const updated = await tx.messageUsageReservation.updateMany({
      where: { ...lease, status: "RESERVED", expiresAt: { gt: now } },
      data: { expiresAt: new Date(now.getTime() + MESSAGE_LEASE_MS) }
    });
    return updated.count === 1;
  });
}

/** Publish a reply and settle its hold atomically, fenced against expired attempts. */
export async function completeMessageUsage<T>(lease: MessageUsageLease, write: (tx: BillingTx) => Promise<T>): Promise<T> {
  return messageTransaction(lease.userId, async (tx) => {
    const reservation = await tx.messageUsageReservation.findUnique({
      where: { userId_requestKey: { userId: lease.userId, requestKey: lease.requestKey } }
    });
    if (!reservation || reservation.status !== "RESERVED" || reservation.leaseId !== lease.leaseId || reservation.expiresAt <= new Date()) {
      throw new MessageAllowanceError("REQUEST_IN_PROGRESS");
    }
    const result = await write(tx);
    // A lost draft CAS publishes nothing; the wrapper refunds its conflict.
    if (result !== null) await settleMessageUsageTx(tx, reservation, true);
    return result;
  });
}

/** Recover even when the client never reconnects. Each row is rechecked under its user's lock. */
export async function recoverMessageUsage(options: { userId?: string; now?: Date } = {}): Promise<number> {
  const now = options.now ?? new Date();
  const expired = await prisma.messageUsageReservation.findMany({
    where: { ...(options.userId ? { userId: options.userId } : {}), status: "RESERVED", expiresAt: { lte: now } },
    orderBy: { expiresAt: "asc" }, take: 100,
    select: { userId: true, requestKey: true }
  });
  let recovered = 0;
  for (const key of expired) {
    recovered += await messageTransaction(key.userId, async (tx) => {
      const row = await tx.messageUsageReservation.findUnique({ where: { userId_requestKey: key } });
      if (!row || row.status !== "RESERVED" || row.expiresAt > now) return 0;
      await settleMessageUsageTx(tx, row, await hasSavedMessageReply(tx, row));
      return 1;
    });
  }
  return recovered;
}

// Legacy holds may predate atomic publication. A saved transcript is proof of
// delivery even if the process died before the old wrapper committed its hold.
async function hasSavedMessageReply(tx: BillingTx, row: Reservation): Promise<boolean> {
  const [scope, id, ...rest] = row.requestKey.split(":");
  if (!id) return false;
  if (scope === "creation-start") {
    return Boolean(await tx.mobileCreationDraft.findFirst({
      where: { userId: row.userId, requestId: [id, ...rest].join(":") }, select: { id: true }
    }));
  }
  if (scope === "creation") {
    const draft = await tx.mobileCreationDraft.findFirst({ where: { id, userId: row.userId }, select: { payload: true } });
    const messages = jsonRecord(draft?.payload).messages;
    return Array.isArray(messages) && messages.some((message) => {
      const stored = jsonRecord(message);
      return stored.role === "user" && stored.requestId === rest.join(":");
    });
  }
  if (scope === "project") {
    const message = await tx.projectChatMessage.findUnique({
      where: { projectId_requestId: { projectId: id, requestId: rest.join(":") } }, select: { id: true }
    });
    return Boolean(message && await tx.projectChatMessage.findFirst({
      where: { projectId: id, parentId: message.id, role: "ASSISTANT" }, select: { id: true }
    }));
  }
  return false;
}

/** The token names the exhausted cycle, so retries and double taps cannot buy a second reset. */
export async function resetMessageAllowance(options: {
  userId: string; resetToken: string; expectedCredits: number; now?: Date | undefined;
}): Promise<void> {
  const now = options.now ?? new Date();
  await recoverMessageUsage({ userId: options.userId, now });
  await messageTransaction(options.userId, async (tx) => {
    const tier = await resolvePlanTierTx(tx, options.userId, now);
    const key = counterKey(options.userId, dayWindow(now).periodKey);
    const counter = await tx.usageCounter.findUnique({ where: { userId_kind_periodKey: key } });
    const current = allowance(tier, now, counter);
    const [day, count] = options.resetToken.split(":");
    const version = Number(count);
    if (day === key.periodKey && Number.isInteger(version) && version >= 0 && version < (counter?.resetCount ?? 0)) return;
    if (options.resetToken !== current.resetToken || options.expectedCredits !== current.resetCredits) {
      throw new MessageAllowanceError("MESSAGE_QUOTE_CHANGED");
    }
    if (!current.resetEnabled || current.remaining > 0 || !counter) {
      throw new MessageAllowanceError("MESSAGE_RESET_UNAVAILABLE");
    }
    const policy = messagePolicy(tier);
    const ledger = await reserveCreditsTx(tx, {
      userId: options.userId, operation: "MESSAGE_LIMIT_RESET", amountCredits: current.resetCredits,
      idempotencyKey: `message-reset:${options.userId}:${current.resetToken}`, now,
      metadata: { pricingKey: policy.resetPricingKey, quantity: 1, planTier: tier }
    });
    if (ledger) await commitReservedCreditsTx(tx, ledger.id);
    await tx.usageCounter.update({
      where: { id: counter.id }, data: { used: 0, resetCount: { increment: 1 } }
    });
  });
}
