import { LIBRARY_CHARACTER_STORAGE_SUBDIR } from "@book-maker/core";
import { prisma } from "@book-maker/db";
import { WELCOME_CREDITS_IP_WINDOW_DAYS } from "@book-maker/db/billing";
import { objectKey, objectStore } from "@book-maker/storage";
import { deleteAccountGenerationLogs, markAccountGenerationLogsDeleted, repairDeletedAccountGenerationLogs } from "./accountRunLogDeletion.js";
import {
  type PlaySubscriptionCanceller,
  type SubscriptionCancellationResult,
  cancelAccountSubscriptions,
  retryDeletedAccountSubscriptionCancellations
} from "./accountSubscriptionCancellation.js";
import { creationAttachmentDraftPrefix, deleteCreationAttachmentDraftDir } from "./attachmentStorage.js";
import { deleteProjectStorage } from "./projectStorage.js";
import { stopProjectGenerationJobs } from "./queue.js";
import { recordStorageDeletion } from "./storageDeletionSweep.js";

/**
 * Carrying out an account deletion request.
 *
 * `POST /api/mobile/account/deletion-request` only ever recorded a PENDING row,
 * and nothing completed one: a reader who asked for their account to go kept
 * every book, picture, transcript and upload, while the app and the public
 * deletion page promised it within 30 days — which is also what Google Play
 * requires of an app that has accounts (2026-10-03 launch audit).
 *
 * **What goes, and what stays.** Everything the person made or said is
 * deleted, bytes first-class: every book (through the same stop-jobs, delete
 * and storage cleanup the book's own delete runs), creation drafts and their
 * uploads, imports and their originals, retained source extractions, saved
 * characters and their pictures, voice calls and their transcripts, sessions,
 * the password and the legal acceptances. The user row
 * itself is kept as a tombstone — email replaced, name cleared, DISABLED — so
 * the credit ledger, purchases and subscriptions it owns survive as the
 * financial records the policy pages say are retained, and moderation reports
 * keep their reporter link for abuse handling. A tombstone cannot sign in
 * (DISABLED is refused at auth) and frees the email for a new account.
 * Product analytics events go too. The welcome grant row stays, because the
 * per-address welcome cap counts it, but its address hash is cleared as soon
 * as it no longer counts toward that cap: at once for a grant that never paid
 * out, and once the cap's window has passed for one that did — before that,
 * deleting an account would hand its address a fresh welcome grant.
 *
 * **Google Play.** Every subscription Google may still charge is cancelled
 * (`accountSubscriptionCancellation.ts`), first thing and best effort; the
 * sweep retries what Google did not confirm. A deletion never waits on Google.
 *
 * **When.** A request runs after `ACCOUNT_DELETION_GRACE_MS` — a day for a
 * mistaken tap to be raised with support, far inside the promised 30 — from
 * `runAccountDeletionSweep`, or at once from the operator console.
 */

/** How long a request waits before it is carried out. */
export const ACCOUNT_DELETION_GRACE_MS = 24 * 60 * 60 * 1000;

/** The address a deleted account's row is left with: unique, unroutable and nobody's. */
export function deletedAccountEmail(userId: string): string {
  return `deleted-${userId}@deleted.invalid`;
}

type Logger = { warn: (object: unknown, message: string) => void; info: (object: unknown, message: string) => void };

export type AccountDeletionResult = {
  userId: string;
  projects: number;
  drafts: number;
  characters: number;
  voiceCalls: number;
  storageFailures: number;
  /** Play subscriptions stopped, and those left for the sweep to retry. */
  playSubscriptions: SubscriptionCancellationResult;
};


/**
 * Deletes one pending account's content and tombstones its row. Retries keep
 * storage ownership even after the corresponding content rows are gone.
 */
export async function executeAccountDeletion(
  userId: string,
  log: Logger,
  options: { play?: PlaySubscriptionCanceller | null } = {}
): Promise<AccountDeletionResult> {
  // First, and never fatal: a storage failure below retries the whole
  // deletion, and the reader must not keep paying while it does.
  const playSubscriptions = await cancelAccountSubscriptions(userId, log, options.play ?? null);
  const result: AccountDeletionResult = {
    userId, projects: 0, drafts: 0, characters: 0, voiceCalls: 0, storageFailures: 0, playSubscriptions
  };

  await deleteAccountGenerationLogs(userId);

  const projects = await prisma.project.findMany({ where: { userId }, select: { id: true } });
  const storageProjectIds = await rememberAccountStorageProjects(userId, projects.map(({ id }) => id));
  for (const { id } of projects) {
    // Keep the stop -> row delete -> storage order. Cleaning bytes while the
    // project still exists lets a worker publish or restore them afterward.
    await stopProjectGenerationJobs(id);
    await prisma.project.delete({ where: { id } });
    result.projects += 1;
  }
  for (const id of storageProjectIds) {
    const cleanup = await deleteProjectStorage(id, { log });
    result.storageFailures += Object.values(cleanup).filter((deleted) => !deleted).length;
  }
  if (result.storageFailures > 0) {
    throw new Error(`Account project storage cleanup failed for ${result.storageFailures} prefixes`);
  }

  const drafts = await prisma.mobileCreationDraft.findMany({ where: { userId }, select: { id: true } });
  const imports = await prisma.bookImport.findMany({ where: { userId }, select: { id: true } });
  const sources = await prisma.sourceDocument.findMany({
    where: { userId }, select: { id: true, storageDraftId: true }
  });
  // Written down before the first delete, as a book's prefixes are
  // (`deleteProjectStorage`): the deletes below still propagate and keep the
  // request pending, and the storage deletion sweep deletes each prefix again
  // for a day, so an upload or a portrait that lands after them is swept too.
  // A source's original lives under its draft's prefix, which is this
  // account's whatever became of the draft.
  await recordStorageDeletion([
    ...new Set([
      ...[...drafts, ...imports].map(({ id }) => creationAttachmentDraftPrefix(id)),
      ...sources.map((source) => creationAttachmentDraftPrefix(source.storageDraftId)),
      libraryCharacterPrefix(userId)
    ].filter((prefix): prefix is string => prefix !== null))
  ]);

  for (const { id } of drafts) {
    // Keep the rows (including their original IDs) until every upload is gone.
    await deleteCreationAttachmentDraftDir("", id);
  }
  result.drafts = (await prisma.mobileCreationDraft.deleteMany({ where: { userId } })).count;

  // Imports store their originals under the import id, not a creation draft.
  // Keep these rows until cleanup succeeds, including imports whose project
  // has already gone, so a storage failure can be retried by the next sweep.
  for (const { id } of imports) {
    await deleteCreationAttachmentDraftDir("", id);
  }

  // Sources outlive their chat (draftId becomes null) and even the feature
  // flag that enabled extraction. Their storageDraftId still locates the
  // original; delete it before dropping the last durable reference to it.
  for (const source of sources) {
    await objectStore().delete(objectKey("attachments", source.storageDraftId, source.id));
  }

  await objectStore().deletePrefix(libraryCharacterPrefix(userId));
  result.characters = (await prisma.libraryCharacter.deleteMany({ where: { userId } })).count;
  result.voiceCalls = (await prisma.voiceCall.deleteMany({ where: { userId } })).count;

  const tombstone = deletedAccountEmail(userId);
  await prisma.$transaction([
    // Projects have already released their ProjectSource references, and
    // drafts can no longer be backfilled. This cascades through every source
    // extraction version and its chunks, including summaries and embeddings.
    prisma.sourceDocument.deleteMany({ where: { userId } }),
    prisma.bookImport.deleteMany({ where: { userId } }),
    prisma.mobileSession.deleteMany({ where: { userId } }),
    prisma.passwordResetRequest.deleteMany({ where: { userId } }),
    prisma.emailVerificationRequest.deleteMany({ where: { userId } }),
    prisma.userPasswordCredential.deleteMany({ where: { userId } }),
    prisma.legalAcceptance.deleteMany({ where: { userId } }),
    // A pen name and a biography are personal; the books that printed them went with the projects.
    prisma.authorProfile.deleteMany({ where: { userId } }),
    // What the reader tapped and when: analytics about a person, not a billing record.
    prisma.productEvent.deleteMany({ where: { userId } }),
    welcomeIpHashRelease({ userId }, new Date()),
    prisma.user.update({
      where: { id: userId },
      // The tombstone's address proves nothing, so neither does its verification.
      data: { email: tombstone, displayName: null, googleSubject: null, emailVerifiedAt: null, status: "DISABLED", disabledAt: new Date() }
    }),
    markAccountGenerationLogsDeleted(userId),
    prisma.accountDeletionRequest.updateMany({
      where: { userId, status: "PENDING" },
      data: { status: "COMPLETED", completedAt: new Date(), email: tombstone, reason: null }
    })
  ]);
  log.info({ event: "account.deleted", ...result }, "Account deleted");
  return result;
}

/** Every saved character's pictures, drawn, uploaded and retained. */
function libraryCharacterPrefix(userId: string): string {
  return `${objectKey("images", LIBRARY_CHARACTER_STORAGE_SUBDIR, userId)}/`;
}

/** Transfer cleanup ownership before deleting the rows that identify a book. */
async function rememberAccountStorageProjects(userId: string, projectIds: string[]): Promise<string[]> {
  // Merge under the request's row lock instead of reading/replacing metadata:
  // overlapping sweeps must preserve earlier IDs and unrelated metadata. Keep
  // this journal through completion; a crash anywhere after the write can
  // safely repeat the idempotent storage cleanup on the next pending sweep.
  const additions = JSON.stringify(Object.fromEntries(projectIds.map((id) => [id, true])));
  const requests = await prisma.$queryRaw<Array<{ projects: Record<string, boolean> }>>`
    UPDATE "AccountDeletionRequest"
       SET "metadata" = (CASE WHEN jsonb_typeof("metadata") = 'object'
                              THEN "metadata" ELSE '{}'::jsonb END)
                        || jsonb_build_object('accountStorageProjects',
                             (CASE WHEN jsonb_typeof("metadata" -> 'accountStorageProjects') = 'object'
                                   THEN "metadata" -> 'accountStorageProjects' ELSE '{}'::jsonb END)
                             || ${additions}::jsonb)
     WHERE "userId" = ${userId} AND "status" = 'PENDING'
     RETURNING "metadata" -> 'accountStorageProjects' AS "projects"
  `;
  if (requests.length === 0) {
    throw new Error("Account storage cleanup requires a pending deletion request");
  }
  return [...new Set(requests.flatMap(({ projects }) => Object.keys(projects)))];
}

/**
 * Carries out every request older than the grace period, oldest first. A
 * request whose user row is already gone is closed; one that fails stays
 * PENDING and is tried again on the next pass.
 */
export async function runAccountDeletionSweep(log: Logger, now = new Date()): Promise<number> {
  const due = await prisma.accountDeletionRequest.findMany({
    where: { status: "PENDING", requestedAt: { lte: new Date(now.getTime() - ACCOUNT_DELETION_GRACE_MS) } },
    orderBy: { requestedAt: "asc" },
    take: 20,
    select: { id: true, userId: true }
  });
  let completed = 0;
  for (const request of due) {
    if (!request.userId) {
      await prisma.accountDeletionRequest.update({
        where: { id: request.id },
        data: { status: "COMPLETED", completedAt: new Date() }
      });
      completed += 1;
      continue;
    }
    try {
      await executeAccountDeletion(request.userId, log);
      completed += 1;
    } catch (error) {
      log.warn({ err: error, requestId: request.id }, "Account deletion failed; it will be retried");
    }
  }
  await repairDeletedAccountGenerationLogs(log);
  await retryDeletedAccountSubscriptionCancellations(log);
  // A welcome grant's address hash outlives its account only while the
  // per-address cap still counts it.
  await welcomeIpHashRelease({ user: deletedAccount }, now).catch((error: unknown) =>
    log.warn({ err: error, event: "account.welcome_ip_release_failed" }, "Deleted accounts' welcome address hashes were not cleared")
  );
  return completed;
}

/** A tombstone: an account whose deletion request has been carried out. */
const deletedAccount = { status: "DISABLED", accountDeletionRequests: { some: { status: "COMPLETED" } } } as const;

/**
 * Clears welcome-grant address hashes that no longer count toward the
 * per-address cap (`welcomeCredits.ts` counts GRANTED rows settled inside the
 * window): a grant that never paid out at once, a paid one once its window has
 * passed. Clearing a counted hash early would let the same address be welcomed
 * again by deleting an account, which is what the cap exists to stop.
 */
function welcomeIpHashRelease(scope: { userId: string } | { user: typeof deletedAccount }, now: Date) {
  // Read here rather than at load: suites that mock the billing facade and
  // never delete an account need not know the constant exists.
  const windowStart = new Date(now.getTime() - WELCOME_CREDITS_IP_WINDOW_DAYS * 24 * 60 * 60 * 1000);
  return prisma.welcomeCreditGrant.updateMany({
    where: {
      ...scope,
      ipHash: { not: null },
      OR: [{ outcome: { not: "GRANTED" } }, { settledAt: { lt: windowStart } }]
    },
    data: { ipHash: null }
  });
}
