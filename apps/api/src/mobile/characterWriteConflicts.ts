import type { Prisma } from "@book-maker/db";
import type { FastifyReply } from "fastify";
import { sendMobileError } from "./httpErrors.js";

/**
 * What the character write paths do about a row that moved under them.
 *
 * `PATCH /:id` and `DELETE /:id` both read the character before their
 * transaction opens and then rewrite *other* characters' descriptions. That
 * makes them the two routes in this group with a concurrency story, and it is
 * one story: claim the row first, drive the token work from what the claim
 * found — including each mentioning character, whose description may have
 * moved under the same window — and answer the residual collision as
 * something the app can retry. This module is that story; the routes and the
 * mention helpers are the callers.
 */

/** Thrown inside a write transaction when the row is no longer the one the request was built from. */
export class CharacterRowMovedError extends Error {
  constructor() {
    super("This character changed while the request was in flight.");
    this.name = "CharacterRowMovedError";
  }
}

/** Thrown inside the delete transaction when its compare-and-set found nothing to claim. */
export class CharacterDeleteClaimLostError extends Error {
  constructor() {
    super("The character delete claim was lost.");
    this.name = "CharacterDeleteClaimLostError";
  }
}

/**
 * The one answer both write paths give when the row moved under them.
 *
 * Deliberately not `CHARACTER_NAME_TAKEN`: nothing the reader typed is wrong and
 * the edit is worth re-sending exactly as it stands, so the sentence says
 * *retry* rather than *fix your input*. The editor sheet snackbars the message
 * of every code but that one, which is the right shape for this.
 */
export function sendCharacterEditConflict(reply: FastifyReply): FastifyReply {
  return sendMobileError(
    reply,
    409,
    "CHARACTER_EDIT_CONFLICT",
    "This character was changed somewhere else a moment ago. Open it again and retry."
  );
}

/**
 * Claims the character row inside the transaction, on the values the request was
 * built from. Two jobs, and both are load-bearing.
 *
 * The **re-read**: every strip and rewrite these transactions perform is an
 * exact-token match on `@name`, and the name read before the transaction opened
 * is a claim about a row another device may have renamed since. A delete driven
 * by the stale name strips nothing, and the cascade then takes the mention rows
 * that were the only way back to the `@NewName` markers left behind in other
 * characters' prose — dangling permanently, in text nothing will scan again.
 *
 * The **lock**: Prisma has no `SELECT … FOR UPDATE`, so it comes from writing
 * the row's own name back onto it, a no-op to the reader and not to Postgres.
 * Taking it before any sibling description is written gives PATCH and DELETE a
 * shared first statement; the mention helpers then take the same claim on
 * each source they rewrite, and re-read that source under the lock, so a
 * concurrent PATCH of a mentioning character is merged rather than overwritten.
 * `updateMany` rather than `update` for the reason `REFERENCE_CLAIMABLE` is
 * one: the predicate is re-evaluated once the row lock is granted, so a rename
 * that commits while this statement waits is *seen* rather than overwritten.
 */
export async function claimCharacterRow(
  tx: Prisma.TransactionClient,
  options: { id: string; userId: string; name: string; where?: Prisma.LibraryCharacterWhereInput }
): Promise<boolean> {
  const claimed = await tx.libraryCharacter.updateMany({
    where: { ...options.where, id: options.id, userId: options.userId, name: options.name },
    data: { name: options.name }
  });
  return claimed.count === 1;
}

/**
 * A deadlock or serialization failure, in whichever shape the driver reported it.
 *
 * Both write paths update rows other than the one they claimed — the two mention
 * helpers write every description that mentions this character — so two renames
 * of mutually mentioning characters can still meet head-on however the route
 * orders its own statements. Postgres picks a victim and aborts it with `40P01`,
 * which is neither a `CharacterMentionError` nor a `P2002`: it fell through the
 * catch as a raw 500, for an edit that is valid and worth re-sending.
 *
 * Read off `code` and `message` rather than through `instanceof`, the way
 * `isPlanVersionNumberConflict` reads a `P2002` in the worker's
 * `pageRestructure.ts`: Prisma raises `P2034` for the write conflicts it models,
 * but one raised by a statement it does not arrives as a
 * `PrismaClientUnknownRequestError` carrying the SQLSTATE in its message and
 * nothing else. This sits on the failure path of a transaction that can hand
 * back anything at all, so it has to answer "no" for all of those without
 * depending on the class it was given.
 */
export function isRetryableTransactionConflict(error: unknown): boolean {
  if (!error || typeof error !== "object") {
    return false;
  }
  const known = error as { code?: unknown; message?: unknown };
  if (known.code === "P2034" || known.code === "40P01" || known.code === "40001") {
    return true;
  }
  const message = typeof known.message === "string" ? known.message : "";
  return /40P01|deadlock detected|could not serialize access/i.test(message);
}

/**
 * Whether a `P2002` names `LibraryCharacterMention`'s primary key rather than
 * the library's own `[userId, name]`.
 *
 * `replaceCharacterMentions` writes the link set as a `deleteMany` followed by a
 * `createMany`, and two PATCHes of one character that are not serialized by the
 * claim above can collide on `[sourceCharacterId, targetCharacterId]`: under
 * READ COMMITTED the loser's `deleteMany` removes nothing and its `createMany`
 * lands on rows that are already there. Mapped as every other `P2002` was, that
 * answered "You already have a character with that name" to an edit that changed
 * no name at all. Discriminated by `meta`, and defaulting to the name unique —
 * the only other one these transactions can violate, and the one an older engine
 * reports by constraint name rather than by column list.
 */
export function namesMentionPrimaryKey(error: unknown): boolean {
  if (!error || typeof error !== "object") {
    return false;
  }
  const known = error as { code?: unknown; meta?: { modelName?: unknown; target?: unknown } | undefined };
  if (known.code !== "P2002") {
    return false;
  }
  if (known.meta?.modelName === "LibraryCharacterMention") {
    return true;
  }
  const target = known.meta?.target;
  const named = Array.isArray(target) ? target.join(",") : typeof target === "string" ? target : "";
  return /sourceCharacterId|targetCharacterId|LibraryCharacterMention/.test(named);
}
