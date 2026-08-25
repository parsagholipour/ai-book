import { Prisma, prisma } from "@book-maker/db";

/** Thrown when a claimed character or one of its mentioning rows moved. */
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
 * Claims one character on the values the request was built from.
 *
 * The predicate is re-evaluated after any row-lock wait, so a concurrent rename
 * is observed rather than overwritten. The no-op update takes PostgreSQL's
 * `FOR NO KEY UPDATE` lock; both PATCH and DELETE go on to write or remove this
 * row, so neither leaves an `updatedAt` change as the claim's only effect.
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
 * The pre-transaction read a PATCH claim is built from. It deliberately exposes
 * no prose that a caller could accidentally write back after the claim.
 */
export async function characterClaimSubject(
  id: string,
  userId: string
): Promise<{ id: string; name: string } | null> {
  return prisma.libraryCharacter.findFirst({ where: { id, userId }, select: { id: true, name: true } });
}

/**
 * Claims a set of mentioning character rows in one locking statement.
 *
 * This is a `SELECT`, not a no-op `UPDATE`: Prisma stamps `@updatedAt` when it
 * builds an update, before a lock wait, which can move the avatar cache-buster
 * backwards. `FOR NO KEY UPDATE` preserves the lock mode of the old update and
 * does not block the `FOR KEY SHARE` taken by a LibraryMention foreign-key
 * check. `ORDER BY "id"` gives overlapping claims a stable lock order.
 *
 * The comparison must remain row-wise. Matching the three columns separately
 * could claim a character under a sibling's borrowed name after two concurrent
 * renames. Parallel `unnest` arrays keep each id, owner, and name positional.
 */
export async function claimCharacterRows(
  tx: Prisma.TransactionClient,
  rows: readonly { id: string; userId: string; name: string }[]
): Promise<boolean> {
  if (rows.length === 0) {
    return true;
  }
  const claimed = await tx.$queryRaw<Array<{ id: string }>>`
    SELECT "id" FROM "LibraryCharacter"
    WHERE ("id", "userId", "name") IN (
      SELECT * FROM unnest(
        ${rows.map((row) => row.id)}::text[],
        ${rows.map((row) => row.userId)}::text[],
        ${rows.map((row) => row.name)}::text[]
      )
    )
    ORDER BY "id"
    FOR NO KEY UPDATE
  `;
  return claimed.length === rows.length;
}
