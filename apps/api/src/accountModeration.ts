import { prisma, type Prisma } from "@book-maker/db";
import { objectStore } from "@book-maker/storage";
import { DEFAULT_LOCAL_ADMIN_USER_ID } from "./localAdminUser.js";
import { sharePreviewPrefix } from "./mobile/shares/sharePreviewPdf.js";
import { stopProjectGenerationJobs } from "./queue.js";

/**
 * The operator's actions against an account, from the user inspector
 * (`POST /api/admin/users/:id/moderation`, `routes/adminAccounts.ts`). Until
 * now only a deletion changed a user's status, and a takedown blocked one book
 * at a time, while the Terms promise the operator can disable sharing for an
 * account (launch review, 2026-10-13).
 *
 * - **suspend** — `User.status` becomes SUSPENDED, every mobile session is
 *   revoked, every live share is taken down, and every queued or running job
 *   on the account's books is stopped through the reader's own stop path.
 *   Everything that asks for ACTIVE now refuses the account: each request and
 *   refresh (`SESSION_REVOKED`, then `ACCOUNT_DISABLED` at sign-in, both of
 *   which sign the app out), password reset, push, and a connected voice
 *   call's next relay lease. SUSPENDED is not DISABLED, the deleted account's
 *   tombstone, so the deletion, Play-cancellation and welcome-hash sweeps leave
 *   it alone, and the renewal sweep keeps recording what Google charges: **a
 *   suspended subscriber's Play subscription is not cancelled**, and keeps
 *   renewing until they cancel it in Play or the account is deleted.
 * - **unsuspend** — back to ACTIVE. Sessions stay revoked (the reader signs in
 *   again) and stopped books stay stopped (the reader resumes them).
 * - **disable sharing** — `sharingDisabledAt` is set and every live share is
 *   taken down; the share and remix routes then refuse the account
 *   (`SHARING_DISABLED`). **enable sharing** clears it.
 *
 * A share taken down by an account action carries
 * {@link ACCOUNT_SHARE_TAKEDOWN_REASON}, and only those come back when the
 * account is clear again — as REVOKED, never live: the author shares again,
 * and the share's checks run again. A share an operator took down by itself
 * keeps its own reason and stays down.
 *
 * **Ordered on the user row.** The action takes it `FOR NO KEY UPDATE`, and
 * every share write takes it `FOR SHARE` before its own share-row lock
 * (`writeShare`), so a share either commits before the takedown sees it or
 * reads the new state and refuses: none goes live across a suspension.
 *
 * Generation is stopped rather than left to finish, because finishing spends
 * provider money on the account being suspended for what it made. The stop is
 * `stopProjectGenerationJobs`, which settles each paid attempt by the
 * reader's-own-stop rules — what was delivered is kept, the rest refunded
 * (`packages/db/CLAUDE.md`). It runs after the commit, one book at a time, and a
 * stop that fails is logged and counted, never a refused action: the account is
 * already suspended. A library portrait (the one job with no book) runs to its
 * end, and a start already past auth when the suspension commits may still
 * queue one job.
 */

export type AccountModerationActionName = "suspend" | "unsuspend" | "disable_sharing" | "enable_sharing";

export const ACCOUNT_MODERATION_ACTIONS: readonly AccountModerationActionName[] = [
  "suspend",
  "unsuspend",
  "disable_sharing",
  "enable_sharing"
];

/** What the author reads in the app on a share an account action took down. */
export const ACCOUNT_SHARE_TAKEDOWN_REASON = "Sharing was turned off for this account.";

/** The reason a console operator types is read by the next operator, never by the reader. */
export const ACCOUNT_MODERATION_REASON_MAX = 1000;

/** One sentence per refusal, kept with its code. */
export const ACCOUNT_MODERATION_REFUSALS = {
  USER_NOT_FOUND: { status: 404, message: "User not found." },
  ACCOUNT_DELETED: { status: 409, message: "This account was deleted, so there is nothing to suspend or restore." },
  OPERATOR_ACCOUNT: { status: 409, message: "The console's own account can't be suspended or have sharing turned off." },
  ALREADY_SUSPENDED: { status: 409, message: "This account is already suspended." },
  NOT_SUSPENDED: { status: 409, message: "This account is not suspended." },
  SHARING_ALREADY_DISABLED: { status: 409, message: "Sharing is already turned off for this account." },
  SHARING_NOT_DISABLED: { status: 409, message: "Sharing is not turned off for this account." }
} as const;

export type AccountModerationRefusal = keyof typeof ACCOUNT_MODERATION_REFUSALS;

export class AccountModerationRefusedError extends Error {
  constructor(readonly code: AccountModerationRefusal) {
    super(ACCOUNT_MODERATION_REFUSALS[code].message);
    this.name = "AccountModerationRefusedError";
  }
}

export type AccountModerationEffects = {
  sessionsRevoked: number;
  /** Share ids taken down by this action. */
  sharesTakenDown: string[];
  /** Share ids an earlier account action took down, put back to REVOKED. */
  sharesRestored: string[];
  projectsStopped: number;
  jobsStopped: number;
  stopFailures: number;
};

export type AccountModerationOutcome = {
  actionId: string;
  status: string;
  sharingDisabledAt: Date | null;
  effects: AccountModerationEffects;
};

type Logger = {
  info(object: Record<string, unknown>, message: string): void;
  warn(object: Record<string, unknown>, message: string): void;
};

type StopProject = (projectId: string) => Promise<{ stoppedJobs: number }>;

const ACTION_KIND = {
  suspend: "SUSPEND",
  unsuspend: "UNSUSPEND",
  disable_sharing: "DISABLE_SHARING",
  enable_sharing: "ENABLE_SHARING"
} as const satisfies Record<AccountModerationActionName, string>;

type LockedUser = { status: string; sharingDisabledAt: Date | null };

export async function moderateAccount(input: {
  userId: string;
  action: AccountModerationActionName;
  reason: string;
  operatorUserId: string | null;
  log: Logger;
  now?: Date;
  /** The reader's own stop; replaced in tests. */
  stopProject?: StopProject;
}): Promise<AccountModerationOutcome> {
  if (input.userId === DEFAULT_LOCAL_ADMIN_USER_ID) {
    throw new AccountModerationRefusedError("OPERATOR_ACCOUNT");
  }
  const now = input.now ?? new Date();
  const effects: AccountModerationEffects = {
    sessionsRevoked: 0,
    sharesTakenDown: [],
    sharesRestored: [],
    projectsStopped: 0,
    jobsStopped: 0,
    stopFailures: 0
  };

  const committed = await prisma.$transaction(async (tx) => {
    const [user] = await tx.$queryRaw<LockedUser[]>`
      SELECT "status"::text AS "status", "sharingDisabledAt" FROM "User" WHERE "id" = ${input.userId} FOR NO KEY UPDATE
    `;
    if (!user) throw new AccountModerationRefusedError("USER_NOT_FOUND");
    if (user.status === "DISABLED") throw new AccountModerationRefusedError("ACCOUNT_DELETED");

    let status = user.status;
    let sharingDisabledAt = user.sharingDisabledAt;
    switch (input.action) {
      case "suspend":
        if (status === "SUSPENDED") throw new AccountModerationRefusedError("ALREADY_SUSPENDED");
        status = "SUSPENDED";
        break;
      case "unsuspend":
        if (status !== "SUSPENDED") throw new AccountModerationRefusedError("NOT_SUSPENDED");
        status = "ACTIVE";
        break;
      case "disable_sharing":
        if (sharingDisabledAt) throw new AccountModerationRefusedError("SHARING_ALREADY_DISABLED");
        sharingDisabledAt = now;
        break;
      case "enable_sharing":
        if (!sharingDisabledAt) throw new AccountModerationRefusedError("SHARING_NOT_DISABLED");
        sharingDisabledAt = null;
        break;
    }
    await tx.user.update({
      where: { id: input.userId },
      data: { status: status as "ACTIVE" | "SUSPENDED", sharingDisabledAt }
    });

    if (input.action === "suspend") {
      effects.sessionsRevoked = (
        await tx.mobileSession.updateMany({ where: { userId: input.userId, revokedAt: null }, data: { revokedAt: now } })
      ).count;
    }
    if (input.action === "suspend" || input.action === "disable_sharing") {
      effects.sharesTakenDown = await takeDownLiveShares(tx, input.userId);
    } else if (status === "ACTIVE" && sharingDisabledAt === null) {
      // Clear on both counts only now: lifting one of two account actions
      // leaves the shares down for the other.
      effects.sharesRestored = await restoreAccountTakedowns(tx, input.userId);
    }

    const row = await tx.accountModerationAction.create({
      data: {
        userId: input.userId,
        action: ACTION_KIND[input.action],
        reason: input.reason,
        operatorUserId: input.operatorUserId,
        effects: effects as unknown as Prisma.InputJsonValue,
        createdAt: now
      },
      select: { id: true }
    });
    return { actionId: row.id, status, sharingDisabledAt };
  });

  if (effects.sharesTakenDown.length > 0) {
    await dropSharePreviews(input.userId, effects.sharesTakenDown, input.log);
  }
  if (input.action === "suspend") {
    await stopAccountGeneration(input.userId, effects, input.stopProject ?? stopProjectGenerationJobs, input.log);
    if (effects.projectsStopped > 0 || effects.stopFailures > 0) {
      await prisma.accountModerationAction
        .update({ where: { id: committed.actionId }, data: { effects: effects as unknown as Prisma.InputJsonValue } })
        .catch((error: unknown) =>
          input.log.warn({ err: error, userId: input.userId, event: "account.moderation_effects_unrecorded" }, "Stopped jobs were not added to the moderation record")
        );
    }
  }

  input.log.info(
    {
      event: `account.${input.action}`,
      userId: input.userId,
      sessionsRevoked: effects.sessionsRevoked,
      sharesTakenDown: effects.sharesTakenDown.length,
      sharesRestored: effects.sharesRestored.length,
      projectsStopped: effects.projectsStopped,
      stopFailures: effects.stopFailures
    },
    "Operator moderated an account"
  );
  return { ...committed, effects };
}

async function takeDownLiveShares(tx: Prisma.TransactionClient, userId: string): Promise<string[]> {
  const live = await tx.bookShare.findMany({ where: { userId, status: "ACTIVE" }, select: { id: true } });
  if (live.length === 0) return [];
  const ids = live.map((share) => share.id);
  await tx.bookShare.updateMany({
    where: { id: { in: ids }, status: "ACTIVE" },
    data: { status: "TAKEN_DOWN", takedownReason: ACCOUNT_SHARE_TAKEDOWN_REASON }
  });
  return ids;
}

async function restoreAccountTakedowns(tx: Prisma.TransactionClient, userId: string): Promise<string[]> {
  const down = await tx.bookShare.findMany({
    where: { userId, status: "TAKEN_DOWN", takedownReason: ACCOUNT_SHARE_TAKEDOWN_REASON },
    select: { id: true }
  });
  if (down.length === 0) return [];
  const ids = down.map((share) => share.id);
  await tx.bookShare.updateMany({
    where: { id: { in: ids }, status: "TAKEN_DOWN", takedownReason: ACCOUNT_SHARE_TAKEDOWN_REASON },
    data: { status: "REVOKED", takedownReason: null }
  });
  return ids;
}

/** The cached preview slices, as a single share's take-down drops them (`adminShares.ts`). Best effort. */
async function dropSharePreviews(userId: string, shareIds: readonly string[], log: Logger): Promise<void> {
  const shares = await prisma.bookShare.findMany({ where: { id: { in: [...shareIds] } }, select: { projectId: true } });
  for (const { projectId } of shares) {
    await objectStore()
      .deletePrefix(sharePreviewPrefix(projectId))
      .catch((error: unknown) => log.warn({ err: error, userId, projectId }, "share preview cleanup failed"));
  }
}

async function stopAccountGeneration(userId: string, effects: AccountModerationEffects, stop: StopProject, log: Logger): Promise<void> {
  const open = await prisma.generationJob.findMany({
    where: { status: { in: ["QUEUED", "ACTIVE"] }, project: { userId } },
    select: { projectId: true },
    distinct: ["projectId"]
  });
  for (const { projectId } of open) {
    if (!projectId) continue;
    try {
      const stopped = await stop(projectId);
      effects.projectsStopped += 1;
      effects.jobsStopped += stopped.stoppedJobs;
    } catch (error) {
      effects.stopFailures += 1;
      log.warn({ err: error, userId, projectId, event: "account.suspend_stop_failed" }, "A suspended account's book could not be stopped");
    }
  }
}
