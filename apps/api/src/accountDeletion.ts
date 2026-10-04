import { LIBRARY_CHARACTER_STORAGE_SUBDIR } from "@book-maker/core";
import { prisma } from "@book-maker/db";
import { objectKey, objectStore } from "@book-maker/storage";
import { deleteCreationAttachmentDraftDir } from "./attachmentStorage.js";
import { deleteProjectStorage } from "./projectStorage.js";
import { stopProjectGenerationJobs } from "./queue.js";

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
};

/**
 * Deletes one account's content and tombstones its row. Safe to run twice: a
 * second pass finds nothing left to delete and rewrites the same tombstone.
 */
export async function executeAccountDeletion(userId: string, log: Logger): Promise<AccountDeletionResult> {
  const result: AccountDeletionResult = { userId, projects: 0, drafts: 0, characters: 0, voiceCalls: 0, storageFailures: 0 };

  const projects = await prisma.project.findMany({ where: { userId }, select: { id: true } });
  for (const { id } of projects) {
    try {
      await stopProjectGenerationJobs(id);
    } catch (error) {
      log.warn({ err: error, projectId: id, userId }, "Could not stop project jobs before account deletion");
    }
    await prisma.project.delete({ where: { id } });
    const cleanup = await deleteProjectStorage(id, { log });
    result.storageFailures += Object.values(cleanup).filter((deleted) => !deleted).length;
    result.projects += 1;
  }

  const drafts = await prisma.mobileCreationDraft.findMany({ where: { userId }, select: { id: true } });
  for (const { id } of drafts) {
    try {
      await deleteCreationAttachmentDraftDir("", id);
    } catch (error) {
      result.storageFailures += 1;
      log.warn({ err: error, draftId: id, userId }, "Could not delete a draft's uploads during account deletion");
    }
  }
  result.drafts = (await prisma.mobileCreationDraft.deleteMany({ where: { userId } })).count;

  // Imports store their originals under the import id, not a creation draft.
  // Keep these rows until cleanup succeeds, including imports whose project
  // has already gone, so a storage failure can be retried by the next sweep.
  const imports = await prisma.bookImport.findMany({ where: { userId }, select: { id: true } });
  for (const { id } of imports) {
    await deleteCreationAttachmentDraftDir("", id);
  }

  // Sources outlive their chat (draftId becomes null) and even the feature
  // flag that enabled extraction. Their storageDraftId still locates the
  // original; delete it before dropping the last durable reference to it.
  const sources = await prisma.sourceDocument.findMany({
    where: { userId }, select: { id: true, storageDraftId: true }
  });
  for (const source of sources) {
    await objectStore().delete(objectKey("attachments", source.storageDraftId, source.id));
  }

  try {
    await objectStore().deletePrefix(`${objectKey("images", LIBRARY_CHARACTER_STORAGE_SUBDIR, userId)}/`);
  } catch (error) {
    result.storageFailures += 1;
    log.warn({ err: error, userId }, "Could not delete saved character pictures during account deletion");
  }
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
    prisma.userPasswordCredential.deleteMany({ where: { userId } }),
    prisma.legalAcceptance.deleteMany({ where: { userId } }),
    prisma.user.update({
      where: { id: userId },
      data: { email: tombstone, displayName: null, googleSubject: null, status: "DISABLED", disabledAt: new Date() }
    }),
    prisma.accountDeletionRequest.updateMany({
      where: { userId, status: "PENDING" },
      data: { status: "COMPLETED", completedAt: new Date(), email: tombstone, reason: null }
    })
  ]);
  log.info({ event: "account.deleted", ...result }, "Account deleted");
  return result;
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
  return completed;
}
