import { prisma, type Prisma } from "@book-maker/db";
import type { PushPlatformName, PushTarget } from "./bookPushMessages.js";

/**
 * A device is sent pushes only through the session that registered it, and
 * only while that session could still be refreshed — which is how signing out
 * (the app's logout revokes the session) stops them without a second request
 * the app could fail to make. An account disabled or deleted is covered too:
 * a deletion deletes the sessions, and the device rows cascade with them.
 */
export function livePushDeviceWhere(now: Date): Prisma.PushDeviceWhereInput {
  return {
    session: { revokedAt: null, refreshTokenExpiresAt: { gt: now } },
    user: { status: "ACTIVE", disabledAt: null }
  };
}

/**
 * The install's token now belongs to this user and session, whoever held it
 * before: one phone signed into a second account must stop hearing about the
 * first account's books.
 */
export async function registerPushDevice(input: {
  token: string;
  platform: PushPlatformName;
  userId: string;
  sessionId: string;
}): Promise<void> {
  await prisma.pushDevice.upsert({
    where: { token: input.token },
    create: { token: input.token, platform: input.platform, userId: input.userId, sessionId: input.sessionId },
    update: { platform: input.platform, userId: input.userId, sessionId: input.sessionId }
  });
}

/** Scoped to the caller, so one account cannot silence another's phone by naming its token. */
export async function unregisterPushDevice(input: { token: string; userId: string }): Promise<void> {
  await prisma.pushDevice.deleteMany({ where: { token: input.token, userId: input.userId } });
}

export async function livePushTargets(userId: string, now: Date): Promise<PushTarget[]> {
  return prisma.pushDevice.findMany({
    where: { userId, ...livePushDeviceWhere(now) },
    select: { token: true, platform: true }
  });
}

export async function forgetPushToken(token: string): Promise<void> {
  await prisma.pushDevice.deleteMany({ where: { token } });
}
