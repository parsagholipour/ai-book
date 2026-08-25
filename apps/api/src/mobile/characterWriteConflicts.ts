import { Prisma } from "@book-maker/db";
import type { FastifyReply } from "fastify";
import { ContentRestrictedError, sendContentRestricted } from "../contentRestrictions.js";
import { LibraryMentionError, sendMobileError } from "./httpErrors.js";
import { CharacterRowMovedError } from "./characterRowClaims.js";
import { isRetryableTransactionConflict, isTransactionTimeout } from "./characterWriteBudget.js";
import {
  namesMentionCharacterForeignKey,
  namesMentionCheckConstraint,
  namesMentionPrimaryKey
} from "./libraryMentionConstraintErrors.js";

/** The one answer a direct library-character lookup gives when it misses. */
export function sendCharacterNotFound(reply: FastifyReply): FastifyReply {
  return sendMobileError(reply, 404, "CHARACTER_NOT_FOUND", "That character is not in your library.");
}

/** The response for a character row or transaction conflict worth retrying. */
export function sendCharacterEditConflict(reply: FastifyReply): FastifyReply {
  return sendMobileError(
    reply,
    409,
    "CHARACTER_EDIT_CONFLICT",
    "This character was changed somewhere else a moment ago. Open it again and retry."
  );
}

/** The shared response while a portrait job owns a character row. */
export function sendPortraitInProgress(reply: FastifyReply): FastifyReply {
  return sendMobileError(
    reply,
    409,
    "PORTRAIT_IN_PROGRESS",
    "This character's illustration is still being drawn. Try again when it finishes."
  );
}

/** The shared response when a picture-pointer compare-and-set loses its claim. */
export function sendCharacterImageChanged(reply: FastifyReply): FastifyReply {
  return sendMobileError(
    reply,
    409,
    "CHARACTER_IMAGE_CHANGED",
    "This character's pictures just changed. Have another look and try again."
  );
}

/** The response for a transaction that ran out of time rather than lost a race. */
export function sendCharacterWriteBusy(reply: FastifyReply): FastifyReply {
  return sendMobileError(
    reply,
    503,
    "CHARACTER_EDIT_BUSY",
    "That change is taking longer than expected. Try again in a moment."
  );
}

/**
 * The ordered response ladder shared by POST, PATCH, and DELETE character writes.
 *
 * Order is behavior:
 *
 * 1. A content refusal is what the reader typed and must retain its 422 reason.
 * 2. Typed LibraryMention errors know their exact status and, for a missing
 *    target, are more specific than a later constraint-name fallback.
 * 3. A timeout is busy work, not a race; it returns 503 before conflict handling.
 * 4. Row moves, deadlocks, and serialization failures are retryable 409s.
 * 5. LibraryMention CHECK failures map to invalid input.
 * 6. A LibraryMention FK race maps to the same missing-character 404 as the
 *    typed check that lost that race.
 * 7. `P2002` is last: a mention primary-key collision is a write conflict,
 *    while the remaining reachable unique is a genuinely taken character name.
 *
 * The bottom constraint rungs are disjoint by SQLSTATE (23514, 23503, 23505),
 * but every rung above them has deliberate precedence. Returns whether it sent
 * a response so callers can rethrow unknown failures with their stack intact.
 */
export function sendCharacterWriteError(reply: FastifyReply, error: unknown): boolean {
  if (error instanceof ContentRestrictedError) {
    sendContentRestricted(reply, error.refusal);
    return true;
  }
  if (error instanceof LibraryMentionError) {
    const status = error.code === "CHARACTER_NOT_FOUND" ? 404 : error.code === "CHARACTER_MENTION_TOO_LONG" ? 409 : 400;
    sendMobileError(reply, status, error.code, error.message);
    return true;
  }
  if (isTransactionTimeout(error)) {
    sendCharacterWriteBusy(reply);
    return true;
  }
  if (error instanceof CharacterRowMovedError || isRetryableTransactionConflict(error)) {
    sendCharacterEditConflict(reply);
    return true;
  }
  if (namesMentionCheckConstraint(error)) {
    sendMobileError(
      reply,
      400,
      "INVALID_CHARACTER_MENTION",
      "That mention could not be saved. Remove it from the description and try again."
    );
    return true;
  }
  if (namesMentionCharacterForeignKey(error)) {
    sendMobileError(reply, 404, "CHARACTER_NOT_FOUND", "A mentioned character is no longer in your library.");
    return true;
  }
  if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
    if (namesMentionPrimaryKey(error)) {
      sendCharacterEditConflict(reply);
      return true;
    }
    sendMobileError(reply, 409, "CHARACTER_NAME_TAKEN", "You already have a character with that name.");
    return true;
  }
  return false;
}
