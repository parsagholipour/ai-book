import {
  LIBRARY_MENTION_LIMIT,
  canonicalizeLibraryMentions,
  stripLibraryMentionMarkers,
  type LibraryMentionName
} from "@book-maker/core";
import { Prisma, type LibraryMentionTargetKind } from "@book-maker/db";
import {
  libraryMentionCharacterRefs,
  libraryMentionOrderArgs,
  type LibraryCharacterWithMentions
} from "@book-maker/db/libraryMentions";
import type { LibraryMentionTargetOf } from "./characterSchemas.js";
import { LibraryMentionError } from "./httpErrors.js";
import { orderedCharacterRefs, uniqueIds } from "./libraryMentionRows.js";

/**
 * The complete outgoing link set one description owns, written in one pass.
 *
 * A file of its own because it is one transaction with one rule: the kinds it
 * clears and the kind it writes are stated here, together, and every hazard
 * below is a `deleteMany` and a `createMany` disagreeing about them. It is
 * reached only from the two character write routes, through
 * `replaceLibraryMentions`, which is also the only thing that decides what the
 * stored prose becomes — and, since it is holding them anyway, the only thing
 * either route needs in order to answer with the link set
 * (`ReplacedLibraryMentions`).
 *
 * Rewriting *other* characters' descriptions when this one is renamed or
 * deleted is the opposite direction and lives in `libraryMentionRewrites.ts`;
 * the readings of the rows this writes are `libraryMentionRows.ts`.
 */

type CharacterTransaction = Prisma.TransactionClient;

/** One description and one chat message share the existing cast limit. */
export const LIBRARY_DESCRIPTION_MENTION_LIMIT = LIBRARY_MENTION_LIMIT;

/**
 * Every kind this module's write clears before it puts the source's links back.
 *
 * A `deleteMany` wider than the insert destroys links this call was never
 * given: the source clause alone owns *all* of a character's edges, so the
 * first `PATCH /api/mobile/characters/:id` carrying a description would take a
 * LOCATION row with it, silently and for good, with no reader having touched
 * it. Locations land by writing rows of that kind **and** naming that kind
 * here, never by widening one of the two.
 *
 * **Naming a kind here does not decide what the insert writes**, and it used
 * to: `CHARACTER_MENTION_KIND` was this list's first element, so following the
 * paragraph above — prepending `"LOCATION"` so the delete covers it — would
 * have retargeted the insert with it, stamping every character row
 * `targetKind: "LOCATION"` beside the `targetCharacterId` it still sets.
 * `LibraryMention_target_arc` forbids that pairing, so the next description
 * save 500s; relax the arc instead and the whole cast disappears from
 * `libraryMentionCharacterRefs`. The write names its own kind below, and this
 * list only has to keep containing it.
 */
export const REPLACED_MENTION_KINDS = ["CHARACTER"] as const satisfies readonly LibraryMentionTargetKind[];

/** A kind the delete above takes out, which is the only kind the insert may write. */
type ReplacedMentionKind = (typeof REPLACED_MENTION_KINDS)[number];

/**
 * The kind the insert writes — stated, not read off the list above.
 *
 * The relationship that does have to hold runs one way only: a kind written
 * but not cleared leaves the previous save's rows in place behind this one —
 * links the prose no longer holds, and a `createMany` that meets its own
 * primary key (`@@id([sourceCharacterId, targetKind, targetId])`) as soon as
 * the same target is mentioned again. So this must be one of the cleared
 * kinds, and the `satisfies` is the compiler being asked rather than a comment
 * being trusted; widening the delete stays free.
 *
 * Both constants are exported so `libraryMentionLinks.test.ts` can pin the same
 * relationship from outside, where an edit that loosens the annotation here
 * cannot take the check with it.
 */
export const CHARACTER_MENTION_KIND = "CHARACTER" as const satisfies ReplacedMentionKind;

/**
 * One row of the batch below, as `LibraryMention_target_arc` allows it — and as
 * `libraryMentionInclude` reads it back.
 *
 * **The arc arm is imported rather than restated, which is what gives the arc's
 * TypeScript copy a call site.** That a character mention carries
 * `targetCharacterId` equal to its `targetId` and a null `otherType` — true of
 * CHARACTER and of no other kind — is stated in three places: the migration's
 * CHECK, `libraryMentionTargetArms.CHARACTER` (`characterSchemas.ts`) and the
 * `map` below. Nothing routes a request through that union yet, so nothing was
 * checking it against anything; now the two halves that are TypeScript fail to
 * compile apart. Widen the arm and this `map` stops satisfying it; change what
 * the `map` writes and the arm is where the change has to be argued.
 *
 * `sourceCharacterId` and `sortOrder` are the row's own columns and are added
 * here rather than taken from the arm: the arc says nothing about either, and
 * `sortOrder` is a position inside one write rather than a property of the
 * target — see the `createMany` below.
 *
 * **`targetCharacter` is not a column and never reaches `createMany`.** It is
 * the join the include takes, carried so the caller can serialize this batch
 * without reading it back (`ReplacedLibraryMentions`); the write strips it,
 * because a relation key in a `createMany` row is an unknown field to the
 * engine and the `.strict()` arc arms refuse it besides. The name in it is the
 * one `mentionedTargets` read in this transaction, which is the same read the
 * include's join would take.
 */
type CharacterMentionRow = LibraryMentionTargetOf<typeof CHARACTER_MENTION_KIND> & {
  sourceCharacterId: string;
  sortOrder: number;
  targetCharacter: { id: string; name: string };
};

type MentionColumns = Omit<CharacterMentionRow, "targetCharacter">;

/** The row's own columns: what `createMany` takes, and nothing more. */
function mentionColumns({ targetCharacter: _join, ...columns }: CharacterMentionRow): MentionColumns {
  return columns;
}

/**
 * What one call leaves behind: the prose to store, and the rows stored with it.
 *
 * **The rows are handed back rather than read back.** Both write routes used to
 * end their transaction with a `findFirst({ include: libraryMentionInclude })`
 * purely to serialize the link set this call had just computed — one more
 * indexed read plus the nested join, taken while the source's claim (and, on a
 * rename, up to 99 sibling claims) is still held, out of the same client budget
 * `characterRetryTransactionOptions` is rationing.
 *
 * **It is the include's own payload type, in the include's own order.**
 * `libraryMentionOrder` sorts by kind, then `sortOrder`, then `targetId`, and
 * this batch satisfies that by construction: one kind, numbered 0..n-1 in
 * first-token order, with no two rows able to tie. The type is
 * `LibraryCharacterWithMentions["outgoingMentions"]` rather than a local
 * spelling of it, so the day a second join lands in `libraryMentionInclude`
 * this stops compiling here rather than handing a reader rows missing half of
 * what it now expects.
 *
 * **The set is complete because this is the only writer.** What a source holds
 * after this call is the batch below plus any row of a kind the `deleteMany`
 * does not clear — and there is none: `REPLACED_MENTION_KINDS` covers every
 * kind anything writes, and a description's links are stored nowhere else. The
 * skip path returns the same array for the reason it skips: the comparison it
 * just made proves the stored rows equal it on kind, target and position, and
 * the arc determines the two columns that comparison does not read.
 */
export type ReplacedLibraryMentions = {
  description: string;
  mentions: LibraryCharacterWithMentions["outgoingMentions"];
};

/**
 * One stored row as both readings below need it: the comparison, and the name.
 *
 * The join is what the naming reading costs, and it is one join on a read that
 * was already being taken — see `storedMentionLinks`. `targetKind` is the full
 * enum rather than `ReplacedMentionKind`: the `where` narrows it to the kinds
 * the delete clears, but that is a runtime filter, and the reading that decides
 * whether a row is a person has to be handed the column the database stored.
 */
type StoredMentionRow = {
  targetKind: LibraryMentionTargetKind;
  targetId: string;
  sortOrder: number;
  targetCharacter: { id: string; name: string } | null;
};

async function mentionedTargets(
  tx: CharacterTransaction,
  userId: string,
  ids: readonly string[]
): Promise<Array<{ id: string; name: string }>> {
  const orderedIds = uniqueIds(ids);
  if (orderedIds.length > LIBRARY_DESCRIPTION_MENTION_LIMIT) {
    throw new LibraryMentionError(
      "INVALID_CHARACTER_MENTION",
      `A description can mention up to ${LIBRARY_DESCRIPTION_MENTION_LIMIT} characters.`
    );
  }
  const rows = orderedIds.length
    ? await tx.libraryCharacter.findMany({
        where: { id: { in: orderedIds }, userId },
        select: { id: true, name: true }
      })
    : [];
  if (rows.length !== orderedIds.length) {
    throw new LibraryMentionError(
      "CHARACTER_NOT_FOUND",
      "A mentioned character is no longer in your library."
    );
  }
  // The count above is what makes every id resolvable, and the reordering is
  // `orderedCharacterRefs` rather than a second copy of it holding a `!`: the
  // assertion is only true while that check refuses a short read, so narrowing
  // the check — to tolerate a soft-deleted target, say — would put `undefined`
  // straight into `canonicalizeLibraryMentions` and the `createMany` below it,
  // as `{ targetId: undefined }`. The shared helper drops a miss instead.
  return orderedCharacterRefs(orderedIds, rows);
}

/**
 * Canonicalizes selected @tokens and writes the complete outgoing link set.
 * Returns the prose that must be stored beside those links, and the links —
 * see `ReplacedLibraryMentions` for why the caller is handed them.
 *
 * `sourceCreatedInThisTransaction` is `POST /api/mobile/characters` saying the
 * source row was `create`d a statement ago and is visible to nobody, so it can
 * hold no stored links — see `storedMentionLinks`, the read it skips.
 * Absent is the safe reading, and the one a caller gets by forgetting.
 */
export async function replaceLibraryMentions(
  tx: CharacterTransaction,
  options: {
    sourceCharacterId: string;
    userId: string;
    description: string;
    mentionedCharacterIds: readonly string[];
    sourceCreatedInThisTransaction?: boolean;
  }
): Promise<ReplacedLibraryMentions> {
  const targets = await mentionedTargets(tx, options.userId, options.mentionedCharacterIds);
  if (targets.some((target) => target.id === options.sourceCharacterId)) {
    throw new LibraryMentionError(
      "INVALID_CHARACTER_MENTION",
      "A character cannot mention themselves in their own description."
    );
  }

  // What this source holds *now*, which is two questions off one read: which
  // targets the save is giving up, and whether it is giving up anything at all
  // (`mentionLinksAlreadyStored`). It is taken before the scan rather than
  // after it, because the first of those decides what the scan is handed — so a
  // save the validation below refuses pays for it, one indexed read of at most
  // `LIBRARY_MENTION_LIMIT` rows per kind, inside a transaction that is about
  // to roll back anyway.
  const stored: StoredMentionRow[] = options.sourceCreatedInThisTransaction
    ? []
    : await storedMentionLinks(tx, options.sourceCharacterId);
  const dropped = droppedMentionTargets(stored, targets);

  // **Every target this save gives up takes its `@` with it.** The rows are the
  // only record of which span a marker sits on, so a `deleteMany` that clears
  // them over prose that keeps the token leaves an `@Mina` naming nobody —
  // permanently, because every later scan is driven by the rows this statement
  // is about to remove. `generationDescription` (`@book-maker/db`) then finds
  // its name list and the surviving rows the same length, takes the strip *by
  // name*, and hands the raw `@Mina` to the planner brief (`creationBuild.ts`)
  // and to `buildLibraryCharacterPortraitPrompt` — the one place a UI token
  // must never reach. Deleting a character strips its markers out of every
  // other description for exactly this reason
  // (`unlinkIncomingLibraryMentions`); dropping one out of your own description
  // is the same event from the other end and gets the same answer — the marker
  // goes, the reader's own spelling stays as ordinary prose. Nothing upstream
  // can stand in for it either: `{mentionedCharacterIds: []}` carries no
  // description at all, so there is no edit to have taken the tokens out.
  //
  // **It runs before the canonicalizing scan and is handed the survivors**, so
  // the two passes cannot disagree about a span. The strip's own scan is one
  // pass over dropped ∪ kept — that is what the `siblings` parameter is — so
  // "@Luna Vega" stays Vega's and only the "@Luna" beside it goes, where a scan
  // of the dropped name alone would eat the prefix of the longer token.
  // Afterwards a dropped name has no `@` left to claim anything with, which is
  // what makes the kept set below the whole candidate set for the prose that
  // remains. Canonicalizing first and stripping after is the same two scans
  // asking different questions of one span: a longer dropped name would then
  // strip the marker off a link this write is *storing*.
  //
  // The other end of that is the refusal below rather than a third reading. A
  // kept target whose only token is the prefix of a name this save gives up —
  // "@Luna Vega" kept as Vega, sent as Luna — is claimed by the dropped name
  // and comes out of the scan below `missing`, which is what this module
  // already answers for a set its scan cannot account for; storing the link on
  // that span instead is the nested-token bug the whole-set scan exists to
  // prevent. The derived path cannot reach it: `survivingMentionIds` selects
  // from these same rows with these same names, so a set it produced is one
  // this scan binds the same way.
  const prose = dropped.length
    ? stripLibraryMentionMarkers(options.description, dropped, targets)
    : options.description;

  // One scan settles the whole set: every token is claimed by exactly one of
  // the selected characters, and each claim is respelled to its owner's own
  // name. Canonicalizing one target at a time meant one unconditional
  // case-insensitive rewrite each, so "@Bram met @bram." with both rows
  // selected converted both tokens to "@Bram" and then both back to "@bram" —
  // the validation below then found one id, and on create the 400 rolled the
  // whole transaction back and lost the character with it.
  //
  // The candidate set is exactly the ids being written, never the wider
  // library: the app resolves its picks against the whole library and longest
  // name first, so it sends the same set this would compute — while an old
  // client that under-reports gets its links written rather than a 400 for a
  // token it never claimed to own. It is also what keeps this,
  // `survivingMentionIds` (which has no library to read) and `claimingNames`
  // on the rename and delete paths answering alike: a span this scan binds is
  // one those two can still find, and one they cannot find is an `@marker`
  // nothing will ever rewrite or strip again.
  const claims = canonicalizeLibraryMentions(prose, targets);
  const firstPosition = new Map<string, number>();
  for (const range of claims.ranges) {
    if (!firstPosition.has(range.id)) firstPosition.set(range.id, range.start);
  }
  const missing = targets.find((target) => !firstPosition.has(target.id));
  if (missing) {
    throw new LibraryMentionError(
      "INVALID_CHARACTER_MENTION",
      `The description no longer contains @${missing.name}.`
    );
  }
  const description = claims.description;
  const ordered = [...targets].sort(
    (left, right) => firstPosition.get(left.id)! - firstPosition.get(right.id)!
  );

  // `sortOrder` restarts at 0 on every call, so it records where a target's
  // first token falls **among the rows this write owns** rather than in the
  // description as a whole — a location write would land its own 0 beside this
  // one's. One arrangement makes that exact instead of merely tolerable, and it
  // has two halves. The reader's half is `libraryMentionInclude`
  // (`@book-maker/db`), which orders `targetKind`, then this column, then
  // `targetId`, so these numbers are only ever compared against numbers from
  // the same write. This is the writer's half: one kind for the whole batch,
  // numbered 0..n-1 inside it. Nothing in the types holds it — the kind is a
  // column, so a later `map` could derive it per row and number two kinds from
  // 0 against a reader that has just been told they are comparable — and it
  // cannot be lifted into a signature either, because a batch taking its kind
  // as a parameter would write the `targetCharacterId` below onto a LOCATION
  // row, which `LibraryMention_target_arc` refuses. `libraryMentionLinks.test.ts`
  // asks the emitted batch instead.
  const insertion: CharacterMentionRow[] = ordered.map((target, sortOrder) => ({
    sourceCharacterId: options.sourceCharacterId,
    targetKind: CHARACTER_MENTION_KIND,
    targetId: target.id,
    targetCharacterId: target.id,
    otherType: null,
    sortOrder,
    targetCharacter: { id: target.id, name: target.name }
  }));
  // Only the *read* is skipped. A flag that arrived wrongly still gets the full
  // replace below, because the delete is what makes the insert safe: cleared,
  // this is a save with nothing to do; kept, the `createMany` meets its own
  // primary key. The cheap statement is the one allowed to trust the caller.
  if (!options.sourceCreatedInThisTransaction && mentionLinksAlreadyStored(stored, insertion)) {
    return { description, mentions: insertion };
  }
  // Everything a previous save of this description can have left behind. The
  // insert below writes one of these kinds and may not write one this misses —
  // see `REPLACED_MENTION_KINDS`.
  await tx.libraryMention.deleteMany({
    where: {
      sourceCharacterId: options.sourceCharacterId,
      targetKind: { in: [...REPLACED_MENTION_KINDS] }
    }
  });
  if (insertion.length > 0) {
    await tx.libraryMention.createMany({ data: insertion.map(mentionColumns) });
  }
  return { description, mentions: insertion };
}

/**
 * The links this source holds before the write, as the two readings below need
 * them.
 *
 * **The kinds read are the kinds the delete clears**, so both readings are
 * about exactly the rows this write is going to remove: a row of some other
 * kind survives the save untouched, is not a link being given up, and belongs
 * in neither answer. The day `REPLACED_MENTION_KINDS` grows, both follow it
 * here for free — a source holding a row this batch does not write is unequal
 * and gets the full replace, and a row it does not put back is a marker to
 * strip.
 *
 * **The join is what the second reading costs**, and it is one join rather than
 * a second statement: the ids alone say which targets are being dropped and say
 * nothing about which span each one's marker sits on, and the name is the only
 * handle on that — `libraryMentionCharacterRefs` and `stripLibraryMentionMarkers`
 * both work by name. Looking those names up afterwards would be a second read
 * of rows this one already has.
 *
 * **Create does not ask, because create knows.** Both readings are PATCH
 * properties. On `POST /api/mobile/characters` the source row was `create`d in
 * the same transaction, so it is visible to nothing and no `LibraryMention` can
 * name it: this read came back empty every time, and the round trip was spent
 * inside the transaction holding the new row's own lock. The caller is what
 * knows which case it is in, so the caller says
 * (`sourceCreatedInThisTransaction`) rather than this re-reading the source row
 * to find out.
 */
async function storedMentionLinks(
  tx: CharacterTransaction,
  sourceCharacterId: string
): Promise<StoredMentionRow[]> {
  return tx.libraryMention.findMany({
    where: { sourceCharacterId, targetKind: { in: [...REPLACED_MENTION_KINDS] } },
    orderBy: libraryMentionOrderArgs(),
    select: {
      targetKind: true,
      targetId: true,
      sortOrder: true,
      targetCharacter: { select: { id: true, name: true } }
    }
  });
}

/**
 * The targets this save gives up, named — every stored link the batch is not
 * putting back.
 *
 * Read through `libraryMentionCharacterRefs` (`@book-maker/db`) rather than off
 * `targetCharacter` directly, because that is the one-candidate-set rule
 * (`libraryMentionRows.ts`): the names that may claim a span of this
 * description have to be one set, and a fourth spelling of the filter is how a
 * span the write binds becomes one the strip cannot find. It also decides on
 * the kind, so a stored row of a kind that has no name yet falls out here
 * rather than reaching the strip as an empty-named candidate.
 *
 * A row that reading cannot name is a marker this write cannot locate — a
 * LOCATION or OTHER row the day `REPLACED_MENTION_KINDS` covers one, or a
 * CHARACTER row whose target went away under a concurrent delete, which strips
 * this description's marker itself on its way past. The broad strip
 * (`stripEveryLibraryMentionMarker`) is not the answer here the way it is in
 * `generationDescription`: this prose is what the reader sees in the editor
 * sheet, so taking the `@` off their own untouched `@handle` is a visible edit
 * of their text rather than a model-facing copy of it.
 */
function droppedMentionTargets(
  stored: readonly StoredMentionRow[],
  targets: readonly LibraryMentionName[]
): LibraryMentionName[] {
  const kept = new Set(targets.map((target) => target.id));
  return libraryMentionCharacterRefs({ outgoingMentions: stored }).filter(
    (target) => !kept.has(target.id)
  );
}

/**
 * Whether the rows the write is holding are the rows already stored, in which
 * case it has nothing to do.
 *
 * **The common save changes prose and no links at all.** The editor sheet sends
 * `description` and `mentionedCharacterIds` together on every description save,
 * so every typo fix re-sent the same cast — and the write above was a
 * `deleteMany` plus a `createMany` regardless, two statements against
 * `LibraryMention` inside the transaction that holds the character's row lock.
 * That pair is also the exact shape `namesMentionPrimaryKey`
 * (`characterWriteConflicts.ts`) exists to translate: two writes of one
 * character that the row claim does not serialize collide on
 * `[sourceCharacterId, targetKind, targetId]`, the loser's delete removing
 * nothing and its insert landing on rows that are already there — surfacing to
 * the reader as a 409 they have to retry, for a save that asked for no link
 * change whatever. A save with nothing to write cannot lose that race.
 *
 * **Identical means the same rows in the same order, not the same set.**
 * `sortOrder` is where a target's first token falls in the prose, so a reader
 * who swaps two names round keeps the cast and changes every row this write
 * owns; compared as a set, that edit would be skipped and the stored order
 * would go on describing a sentence the book no longer has —
 * `expandLibraryCharacterGraph` spends its cast budget in exactly that order.
 * So the comparison is the emitted batch against the stored rows read back in
 * `libraryMentionOrder`, column for column: this is a *rows* question and
 * answering it through the cast filter would compare two readings instead.
 *
 * What it costs is one indexed read (the primary key's leading column, at most
 * `LIBRARY_MENTION_LIMIT` rows per kind, taken by `storedMentionLinks` for the
 * drop as well) in place of two writes on the ordinary save, and beside two
 * writes on the save that really moves the links.
 */
function mentionLinksAlreadyStored(
  stored: readonly { targetKind: LibraryMentionTargetKind; targetId: string; sortOrder: number }[],
  insertion: readonly { targetKind: ReplacedMentionKind; targetId: string; sortOrder: number }[]
): boolean {
  return (
    stored.length === insertion.length &&
    stored.every((row, index) => {
      const wanted = insertion[index];
      return (
        wanted !== undefined &&
        row.targetKind === wanted.targetKind &&
        row.targetId === wanted.targetId &&
        row.sortOrder === wanted.sortOrder
      );
    })
  );
}
