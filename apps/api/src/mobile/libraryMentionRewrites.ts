import { rewriteLibraryMention, stripLibraryMentionMarkers } from "@book-maker/core";
import { Prisma } from "@book-maker/db";
import { incomingLibraryMentionOrder, libraryMentionOrderArgs } from "@book-maker/db/libraryMentions";
import { LIBRARY_CHARACTER_DESCRIPTION_MAX } from "./characterSchemas.js";
import { CharacterRowMovedError, claimCharacterRows } from "./characterWriteConflicts.js";
import { LibraryMentionError } from "./httpErrors.js";
import { claimingNames } from "./libraryMentionRows.js";

/**
 * Every description that mentions a character, rewritten when that character's
 * name changes or the character goes away.
 *
 * A file of its own because it is the *incoming* direction — one target, up to
 * 99 sources, none of them the row the request is about — and because that is
 * what makes it the lock-ordering module. The target is held with a real
 * `FOR UPDATE` so nobody can begin mentioning it, the sources are claimed as a
 * set and re-read under that claim, and the two public paths differ only in the
 * pure-text rewrite they hand down. The outgoing direction — the links a
 * description owns — is `libraryMentionLinks.ts`.
 */

type CharacterTransaction = Prisma.TransactionClient;

/**
 * Thrown here, defined one module over, and re-exported so no caller has to
 * know which.
 *
 * The class sits in `httpErrors.ts` because this module and
 * `characterWriteConflicts.ts` import each other: the conflict ladder needs the
 * class to answer it, and the helpers below need `claimCharacterRows` to write
 * anything. That cycle survived only while neither module read the other's
 * binding during evaluation, and the first top-level use of either name turns
 * it into a `ReferenceError` at boot — see the class's own docblock. Every
 * refusal this file raises is still `LibraryMentionError`, and every importer
 * still reaches it from here.
 */
export { LibraryMentionError } from "./httpErrors.js";

/**
 * Sources of the incoming links, with everything a claiming scan needs.
 *
 * `targetKind` rides along because the claim set is built through the same
 * filter every other reader of these rows uses, and that filter decides on the
 * kind alone. A Location row cannot smuggle a name in through
 * `targetCharacterId` — `LibraryMention_target_arc` forces that column null for
 * every kind but CHARACTER — so what dropping the column costs is the *kindless*
 * row: it used to read as CHARACTER everywhere, which made this select's
 * narrowness the thing that decided who was in the cast. It is a required field
 * of `LibraryMentionRow` now, so dropping it fails to compile at
 * `claimingNames` (`libraryMentionRows.ts`) rather than quietly widening the
 * scan. It was added
 * here by hand, with nothing asking for it, which is why the type now asks.
 *
 * **The ordering rides along for the same reason, and it is the include's own.**
 * A hand-written `select` is the include's rule bypassed, not inherited: this
 * one asked for no order at all, so the rows `claimingNames` scans arrived in
 * whatever order the plan produced, while the one place that order is argued
 * about — `libraryMentionOrder` in `@book-maker/db` — says why a source's rows
 * must never come back tied. That it happened not to matter is a property of
 * `claimAt`, which reads the whole set and is indifferent to its sequence;
 * nothing states that, and the day a reader of this select is not indifferent
 * the fault would be a scan binding a different span from one query to the
 * next. So the value is imported rather than respelled — a second spelling is
 * exactly how the include's argument comes to be true of one read and not the
 * other.
 *
 * **What is imported is the copy, and it is fetched per read.** Nothing is
 * frozen, and a freeze re-added would land on the include first:
 * `libraryMentionInclude` splices the declaration itself, which is
 * `@book-maker/db`'s one deliberate holder of it — pinned by a `toBe` beside
 * the declaration and measured against a real client by that package's opt-in
 * suite. A second holder here would be neither: this select is a module
 * constant every rename and delete read shares, so a normaliser appending or
 * rewriting a term writes the declaration through an object no db suite reads,
 * and every later request keeps it. Hence the getter over
 * `libraryMentionOrderArgs()`, which survives for exactly this select.
 */
const incomingSourceSelect = {
  id: true,
  userId: true,
  name: true,
  description: true,
  outgoingMentions: {
    get orderBy(): Prisma.LibraryMentionOrderByWithRelationInput[] {
      return libraryMentionOrderArgs();
    },
    select: { targetKind: true, targetCharacter: { select: { id: true, name: true } } }
  }
} as const;

const incomingMentionInclude = {
  sourceCharacter: {
    select: incomingSourceSelect
  }
} as const;

type MentionSource = Prisma.LibraryCharacterGetPayload<{ select: typeof incomingSourceSelect }>;

/**
 * Every character whose description mentions this target, one entry each.
 *
 * Deduplicated by source, because `targetCharacterId` is a column rather than a
 * kind: any row carrying the FK is an incoming row here, so one character could
 * arrive twice and be rewritten twice — and, once the claim below is a set, be
 * counted twice against its own `count`. The order these sources come back in,
 * and which duplicate survives it, is `incomingLibraryMentionOrder`'s answer.
 */
async function incomingMentionSources(
  tx: CharacterTransaction,
  targetCharacterId: string
): Promise<MentionSource[]> {
  const incoming = await tx.libraryMention.findMany({
    where: { targetCharacterId },
    orderBy: incomingLibraryMentionOrder,
    include: incomingMentionInclude
  });
  const bySource = new Map<string, MentionSource>();
  for (const mention of incoming) {
    if (!bySource.has(mention.sourceCharacter.id)) {
      bySource.set(mention.sourceCharacter.id, mention.sourceCharacter);
    }
  }
  return [...bySource.values()];
}

/**
 * Holds the target's row against everyone who might come to mention it, for
 * the rest of the transaction.
 *
 * **A claim is not this lock, and the difference is invisible in the claim.**
 * Postgres escalates an `UPDATE` to `FOR UPDATE` only when a key column's value
 * actually *moves* — `heap_update` compares the old tuple against the new one,
 * so naming the column in the `SET` list is not enough. Both claims in
 * `characterWriteConflicts.ts` are deliberate no-ops for reasons of their own:
 * `claimCharacterRow` writes the row's own name back, `claimCharacterRows`
 * writes its own `userId` back. A no-op write of a key column takes
 * `FOR NO KEY UPDATE`, which is the exact mode `FOR KEY SHARE` exists not to
 * conflict with — and `FOR KEY SHARE` is what an FK insert takes on the row it
 * references. So the claim holds the row against everyone who would *write* it
 * and against nobody who merely comes to *point at* it. Measured on Postgres
 * 16: hold `SET name = name` or `SET "userId" = "userId"` open and a concurrent
 * `LibraryMention` insert naming that row goes straight through; hold
 * `SET name = 'Anita'` or the statement below and it waits.
 *
 * Raw, because Prisma has no `FOR UPDATE` and the only Prisma write that takes
 * one is a write that changes the row — the one thing a lock must not do here,
 * `updatedAt` being the portrait cache-buster `claimCharacterRows` argues at
 * length about not moving.
 */
async function lockMentionTarget(tx: CharacterTransaction, targetCharacterId: string): Promise<void> {
  await tx.$queryRaw`SELECT "id" FROM "LibraryCharacter" WHERE "id" = ${targetCharacterId} FOR UPDATE`;
}

/**
 * The mentioning characters as they are now, under the same claim PATCH/DELETE
 * take on the character they were built from.
 *
 * The mention list's `sourceCharacter` is a snapshot from before this
 * transaction touched anyone. A concurrent PATCH of that source can commit
 * while we wait for its row lock; rewriting the snapshot would then overwrite
 * the new description with a strip of the old one. Claiming first, then
 * reading, is what makes the rewrite a function of what the claim found.
 *
 * **The target is locked before it is asked who mentions it.** The source set
 * is derived from that first read, and an empty one returns without claiming
 * anything at all — so unless nobody can *become* a source while this runs,
 * "nobody mentions this target" means only "nobody had committed one yet". A
 * `DELETE /characters/A` read no incoming rows; a `PATCH /characters/B` then
 * committed `Best friends with @Ana.` together with its `LibraryMention` row
 * B → A; and the delete's own `deleteMany` — which waits for that insert's key
 * share and then cascades the row away — left B's prose holding an `@Ana` with
 * nothing behind it. Permanent, because the row the cascade removed was the
 * only record of who `@Ana` named: no later scan can rebuild the link or strip
 * the marker. The rename path loses the same window more quietly, which is why
 * both are fixed here rather than twice — the row survives spelled at the old
 * name, and the app locates a mention's span *by* the target's current name, so
 * the link is stored and unfindable. This is the dangling marker
 * `claimCharacterRow`'s own docblock says its re-read exists to prevent, and
 * the re-read cannot: the marker is written by a transaction the claim never
 * touched.
 *
 * **A further read is not a substitute for the lock.** The window does not end
 * at the last read — a mention committed after it is still taken by the cascade
 * — so a delete would need a read it can never place late enough, and a rename
 * would have missed its rewrite either way.
 *
 * **What it costs is a deadlock, and Postgres names it.** The order here is
 * target first, then every source, while a PATCH of a source claims *itself*
 * first and only then inserts the row that points back here — so two writes
 * over the same pair can meet head-on. Measured, that is `40P01`, which
 * `isRetryableTransactionConflict` already answers as the 409 saying *retry*: a
 * detected, retryable collision between two edits of the same two characters,
 * in exchange for an `@Name` nothing in the system can ever repair.
 *
 * **Four statements, whatever the library holds** — five with the set update
 * below. Lock the target, read the set, claim the set, read it again under the
 * claim. Done one source at a time it was three each, so a rename of a
 * character 99 others name was ~300 trips inside one
 * interactive transaction, holding a row lock on all 99 of them for its whole
 * length — every concurrent character write on that account queued behind a
 * window measured in tens of seconds. The claim is the same assertion either
 * way (`claimCharacterRows`); only the number of statements changed.
 *
 * The second read is the *same query*, not a read by id, and that is what makes
 * it a re-read of the set rather than of the rows: a source's own links can only
 * move under its own claim — PATCH claims the row before it touches a mention —
 * so once claimed, who mentions the target and what they now say come back
 * together. The two lists are then intersected on purpose:
 *
 * - in the first only — the source still exists, the claim proved that, but it
 *   no longer links here, so there is no link for this rename to follow;
 * - in the second only — a mention written between the two reads, on a row this
 *   transaction never claimed. The lock above makes that arm unreachable rather
 *   than merely rare, since nobody can insert a row naming this target while we
 *   hold it; it stays written because skipping an unclaimed source is the right
 *   answer whatever produced it, and is the reading left standing on the day
 *   the lock is weakened.
 *
 * A source that is *gone* is neither: the claim comes back short and this throws,
 * which is what the `null` re-read used to say.
 */
async function claimedMentionSources(
  tx: CharacterTransaction,
  targetCharacterId: string
): Promise<MentionSource[]> {
  await lockMentionTarget(tx, targetCharacterId);
  const snapshot = await incomingMentionSources(tx, targetCharacterId);
  if (snapshot.length === 0) {
    return [];
  }
  if (!(await claimCharacterRows(tx, snapshot))) {
    throw new CharacterRowMovedError();
  }
  const live = new Map(
    (await incomingMentionSources(tx, targetCharacterId)).map((source) => [source.id, source])
  );
  return snapshot.flatMap((source) => {
    const claimed = live.get(source.id);
    return claimed ? [claimed] : [];
  });
}

/**
 * Applies one pure-text rewrite to every character that mentions the target,
 * and writes the ones that moved in a single statement.
 *
 * The rewrite is computed for the whole claimed set before anything is written,
 * which does two things. Rows whose description does not move are **not
 * written**: a character can hold a link whose token an earlier edit already
 * took out of the prose, and a delete strips nothing from a description whose
 * only `@Name` is a longer character's. And a rewrite that refuses (a name too
 * long for somebody else's description) refuses before the first write rather
 * than halfway through them — which is why the refusal still names whichever
 * sibling the read order reached first, and why the write below cannot be
 * reached by a half-rewritten set.
 *
 * **The write is one statement for the reason the claim is.** It used to be an
 * `update` per changed row, on the stated grounds that Prisma has no way to
 * give one statement a different value per row. That is true of the model API
 * and answered sixty lines away: `claimCharacterRows` already matches a row
 * constructor against parallel `unnest(…)::text[]` arrays, and the same idiom
 * joins ids to descriptions here. At the cap that is one round trip instead of
 * 99 serial awaits taken while every one of those rows is locked — inside
 * `CHARACTER_MENTION_TRANSACTION_OPTIONS`' 10 s window, which is a lock window
 * before it is a budget, and which every other character write on that account
 * queues behind. Two arrays and not the claim's three: ownership and the name
 * were asserted by the claim, and re-asserting them here would be a second
 * spelling of a predicate that has already been re-evaluated under the lock.
 *
 * **Nothing here takes a lock the transaction is not already holding.**
 * `description` is in no unique index and no foreign key, so `heap_update`
 * modifies no key column and the row stays at `FOR NO KEY UPDATE` — the exact
 * mode `claimCharacterRows` took over this same set. So the statement cannot
 * wait on these rows, cannot deadlock over them, and the order the arrays
 * happen to be in is not a lock order. `UPDATE … FROM` picks one arbitrary
 * matching tuple per row, which is only well-defined over distinct ids:
 * `incomingMentionSources` deduplicates by source, the same property
 * `claimCharacterRows` already asks its caller for.
 *
 * **`updatedAt` is stamped here because Prisma stamped it there**, and it is
 * not bookkeeping — `serializeLibraryCharacter` ships it and
 * `character_avatar.dart` spends it as the portrait URL's `v=` cache-buster, so
 * a sibling whose prose this rewrote and whose stamp did not move is a device
 * holding the old description. It is bound from the client's clock rather than
 * written as `CURRENT_TIMESTAMP`, and both halves of that are deliberate. Every
 * other write of this column is a Prisma statement stamped from the same clock,
 * so a database-side `now()` would introduce a second clock to a column whose
 * ordering matters; and `CURRENT_TIMESTAMP` is the *transaction's* start time,
 * which is before this transaction locked the target, read the set and waited
 * for the claim — the stamp-from-before-the-wait that `claimCharacterRows`
 * stopped taking. A `Date` bound here reaches Postgres as UTC, exactly as
 * Prisma's own `@updatedAt` does.
 *
 * Every value is a bound parameter — two text arrays and a timestamp — so no
 * description is ever interpolated into SQL. What bounds the statement is the
 * library: at most `LIBRARY_CHARACTER_LIMIT_PER_USER - 1` rows, each
 * description at most `LIBRARY_CHARACTER_DESCRIPTION_MAX` characters.
 *
 * **`$executeRaw`, and the count it hands back is read.** `$queryRaw` is
 * specified for statements that return rows, and this one returns none; it
 * worked only because `@prisma/adapter-pg` happens to answer a `RETURNING`-less
 * command with an empty `ResultSet`, so an adapter that started checking the
 * statement kind would fail every rename and every delete of a mentioned
 * character at runtime, with nothing in the type system to have said so. The
 * same tagged template on `$executeRaw` also answers the one thing this
 * statement is the only place to learn: **how many rows it moved.** Every id in
 * it came out of the re-read taken under `claimCharacterRows`' own
 * `FOR NO KEY UPDATE`, so this transaction is holding all of them and a
 * concurrent delete cannot take one — the count can only come back short if the
 * set was not what the claim proved, which is a duplicate id
 * (`incomingMentionSources` deduplicates), a binding that lost a row, or an
 * `unnest` that stopped meaning what it means. Committing on a short count
 * would leave the rows it missed holding an `@Name` for a character that has
 * been renamed or deleted, in prose no later scan reaches — the permanent
 * dangling marker this whole module exists to prevent — so it is refused with
 * the error the claim itself raises, which unwinds the transaction and answers
 * the retryable 409. A set of none never reaches the statement: it returned
 * two lines above, so "no rows to write" cannot be read as "no rows moved".
 */
async function rewriteMentioningDescriptions(
  tx: CharacterTransaction,
  targetCharacterId: string,
  rewrite: (source: MentionSource) => string
): Promise<void> {
  const ids: string[] = [];
  const descriptions: string[] = [];
  for (const source of await claimedMentionSources(tx, targetCharacterId)) {
    const description = rewrite(source);
    if (description !== source.description) {
      ids.push(source.id);
      descriptions.push(description);
    }
  }
  if (ids.length === 0) {
    return;
  }
  const rewritten = await tx.$executeRaw`
    UPDATE "LibraryCharacter" AS c
    SET "description" = v."description", "updatedAt" = ${new Date()}
    FROM unnest(${ids}::text[], ${descriptions}::text[]) AS v("id", "description")
    WHERE c."id" = v."id"
  `;
  if (rewritten !== ids.length) {
    throw new CharacterRowMovedError();
  }
}

/** Rewrite every incoming description before a target's name changes. */
export async function rewriteIncomingLibraryMentions(
  tx: CharacterTransaction,
  targetCharacterId: string,
  oldName: string,
  newName: string
): Promise<void> {
  if (oldName === newName) return;
  await rewriteMentioningDescriptions(tx, targetCharacterId, (source) => {
    // The old name is passed rather than read back, because the target's row
    // may already carry the new one; the siblings decide which spans are the
    // target's at all, so renaming Luna cannot eat the "@Luna Vega" beside her.
    const description = rewriteLibraryMention(
      source.description,
      { id: targetCharacterId, name: oldName },
      newName,
      claimingNames(source)
    );
    if (description !== source.description && description.length > LIBRARY_CHARACTER_DESCRIPTION_MAX) {
      // The blocker is somebody else's description, so the message has to name
      // them: the reader is renaming this character and cannot act on a cuid.
      throw new LibraryMentionError(
        "CHARACTER_MENTION_TOO_LONG",
        `That name is too long for ${source.name}'s description, which mentions this character. ` +
          `Shorten ${source.name}'s description first, or pick a shorter name.`
      );
    }
    return description;
  });
}

/** Turn incoming @Name tokens into ordinary names before the target is deleted. */
export async function unlinkIncomingLibraryMentions(
  tx: CharacterTransaction,
  targetCharacterId: string,
  name: string
): Promise<void> {
  await rewriteMentioningDescriptions(tx, targetCharacterId, (source) =>
    stripLibraryMentionMarkers(source.description, [{ id: targetCharacterId, name }], claimingNames(source))
  );
}
