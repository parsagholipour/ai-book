import { prisma } from "@book-maker/db";

/**
 * The operator console's sign-in generation (`OperatorSessionEpoch`, migration
 * 000108).
 *
 * The console cookie is a stateless HMAC over its expiry, so logging out only
 * ever cleared the one browser that asked, and a cookie copied off a laptop
 * stayed good for its whole life unless `WEB_PASSWORD` was rotated (launch
 * review, 2026-10-13). Each cookie now also signs the generation it was issued
 * under, and "sign out everywhere" moves the generation on.
 *
 * It is read only for a request that presents a cookie whose signature and
 * expiry already check out, and cached for `OPERATOR_EPOCH_CACHE_MS`, so the
 * mobile surface never pays for it and the console pays one query per window.
 * A read that fails falls back to the last generation this process saw; with
 * none, it answers `null` and the cookie is refused — the hook fails closed.
 */

const EPOCH_KEY = "console";
export const OPERATOR_EPOCH_CACHE_MS = 30_000;

let cached: { epoch: number; readAt: number } | null = null;
let inflight: Promise<number | null> | null = null;

/** The current generation, or `null` when it has never been readable here. */
export async function currentOperatorEpoch(now: number = Date.now()): Promise<number | null> {
  if (cached && now - cached.readAt < OPERATOR_EPOCH_CACHE_MS) {
    return cached.epoch;
  }
  inflight ??= readEpoch(now).finally(() => {
    inflight = null;
  });
  return inflight;
}

async function readEpoch(now: number): Promise<number | null> {
  try {
    const row = await prisma.operatorSessionEpoch.findUnique({ where: { key: EPOCH_KEY }, select: { epoch: true } });
    cached = { epoch: row?.epoch ?? 0, readAt: now };
    return cached.epoch;
  } catch (error) {
    console.error("operator_session.epoch_read_failed", error);
    return cached?.epoch ?? null;
  }
}

/** Moves the generation on; every cookie issued before it is refused from now. */
export async function advanceOperatorEpoch(now: number = Date.now()): Promise<number> {
  const row = await prisma.operatorSessionEpoch.upsert({
    where: { key: EPOCH_KEY },
    create: { key: EPOCH_KEY, epoch: 1 },
    update: { epoch: { increment: 1 } },
    select: { epoch: true }
  });
  cached = { epoch: row.epoch, readAt: now };
  return row.epoch;
}

export function resetOperatorEpochCacheForTests(): void {
  cached = null;
  inflight = null;
}
