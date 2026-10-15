import { prisma } from "@book-maker/db";
import type { AccountModerationActionName } from "./accountModeration.js";

/**
 * The read half of account moderation, for the user inspector
 * (`admin/inspection.ts`). Its own module because `accountModeration.ts`
 * reaches `queue.js` to stop books, and importing that opens a Redis
 * connection: a dashboard read must not.
 */

/** The inspector's view of an account's moderation: its two switches and every action taken. */
export type AccountModerationDto = {
  suspended: boolean;
  sharingDisabled: boolean;
  sharingDisabledAt: string | null;
  liveShares: number;
  actions: Array<{
    id: string;
    action: AccountModerationActionName;
    reason: string;
    operatorUserId: string | null;
    effects: unknown;
    createdAt: string;
  }>;
};

export async function loadAccountModeration(user: { id: string; status: string; sharingDisabledAt: Date | null }): Promise<AccountModerationDto> {
  const [actions, liveShares] = await Promise.all([
    prisma.accountModerationAction.findMany({
      where: { userId: user.id },
      orderBy: { createdAt: "desc" },
      take: 20,
      select: { id: true, action: true, reason: true, operatorUserId: true, effects: true, createdAt: true }
    }),
    prisma.bookShare.count({ where: { userId: user.id, status: "ACTIVE" } })
  ]);
  return {
    suspended: user.status === "SUSPENDED",
    sharingDisabled: user.sharingDisabledAt !== null,
    sharingDisabledAt: user.sharingDisabledAt?.toISOString() ?? null,
    liveShares,
    actions: actions.map((row) => ({
      id: row.id,
      action: row.action.toLowerCase() as AccountModerationActionName,
      reason: row.reason,
      operatorUserId: row.operatorUserId,
      effects: row.effects,
      createdAt: row.createdAt.toISOString()
    }))
  };
}
