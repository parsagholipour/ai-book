import { libraryMentionRanges, type LibraryMentionName } from "@book-maker/core";
import type { LibraryMentionTargetKind } from "@book-maker/db";
import {
  libraryMentionCharacterRefs,
  libraryMentionTargetName,
  type LibraryCharacterWithMentions,
  type LibraryMentionRows
} from "@book-maker/db/libraryMentions";
import type { MobileLibraryMentionDto, MobileLibraryMentionKind } from "./characterDto.js";

/**
 * One stored `LibraryMention` row, as each side of the API reads it.
 *
 * A file of its own because the three readings below are the thing that has to
 * agree, and they agree with each other rather than with any one caller.
 * `libraryMentionRefs` is the wire list the editor sheet seeds from and PATCHes
 * back; `claimingNames` is who may claim a span of prose on the rename and
 * delete paths; `survivingMentionIds` is what an old client's edit leaves
 * behind. All three read the rows through `libraryMentionCharacterRefs`, and a
 * fourth reading that did not is how a span one of them binds becomes invisible
 * to the others — see the one-candidate-set rule below.
 *
 * Nothing here touches a client or a transaction. The write that puts these
 * rows there is `libraryMentionLinks.ts`, the descriptions around them are
 * rewritten by `libraryMentionRewrites.ts`, and the library they are followed
 * across is `libraryMentionGraph.ts`.
 *
 * **Which is why the two id helpers at the bottom live here rather than beside
 * the graph walk they are also used by.** `orderedCharacterRefs` and
 * `uniqueIds` are pure array functions every lane wants — the write lanes, the
 * two chat surfaces, and `expandLibraryCharacterGraph` itself — and
 * `libraryMentionGraph.ts` opens a Prisma client at import. Reaching into it
 * for them put the client and the whole graph walk in the import graph of every
 * write lane and every suite that touches one, which is the same edge
 * `routes/characters.ts` was moved off that module to drop. The module with no
 * client is the one a helper with no client belongs in.
 */

/**
 * What the app calls each stored kind. Exhaustive by type, deliberately: the
 * kind added alongside its library has to name itself here rather than reach a
 * client as somebody else's, and a `Record` is what asks it to.
 */
const MENTION_KIND_WIRE = {
  CHARACTER: "character",
  LOCATION: "location",
  OTHER: "other"
} as const satisfies Record<LibraryMentionTargetKind, MobileLibraryMentionKind>;

/**
 * The links an `@Name` token in this description is bound to, as the app reads
 * them — the **scan set**, so this list is what the editor sheet writes back.
 *
 * **Kind and subtype are read off the row, never stamped.** They used to be the
 * literals `"character"` and `null`, over a list the cast filter had already
 * narrowed to characters — which made the discriminator a property of this
 * function rather than of `LibraryMention.targetKind`: the wire advertised
 * three kinds the producer could not vary, and the app's location and other
 * arms were unreachable by construction. The parameter is
 * `libraryMentionInclude`'s own payload rather than a local spelling of it, so
 * both columns are the row's by construction — there is no `select` narrow
 * enough to lose one and still reach here. That is the *other* half of "a row
 * nothing can name", and the only half a caller can produce: a LOCATION row has
 * no table to join to, but a CHARACTER row read through a `select` carrying
 * `targetKind` and not the join arrives just as nameless. It is pinned with a
 * `@ts-expect-error` in `libraryMentionRows.test.ts`, because a payload
 * parameter is load-bearing in a way nothing about it says out loud — widen it
 * back into a hand-written row shape and the build fails there rather than the
 * wire quietly losing a link.
 *
 * **A row nothing can name is withheld, and today that is every kind but
 * CHARACTER — this is the one place that fact is stated.** The naming rule is
 * `libraryMentionTargetName` in `@book-maker/db`, and it has no Location or
 * Other table to join to: `LibraryMention_target_arc` forces
 * `targetCharacterId IS NULL` for both kinds, so a row of either arrives
 * carrying its `targetId` and nothing to print. Serializing one with an empty
 * `name` is worse than leaving it out — the app locates a mention's span *by*
 * that name, so it would highlight nothing and hand the next save a link it
 * cannot find in the prose. So both fields can vary and today do not, and the
 * day they do is the day those joins land in `libraryMentionInclude`; nothing
 * here changes with them. **Nothing reads this list as a set of characters, and
 * that is now structural rather than a warning here.** `routes/characters.ts`
 * did — its `survivingMentionIds` feeds `replaceLibraryMentions`, which accepts
 * character ids alone — and it was exact only while the two lists agree, which
 * is to say only while CHARACTER is the only nameable kind. `survivingMentionIds`
 * takes the rows and runs `libraryMentionCharacterRefs` over them itself now, so
 * there is no list to hand it and no reading of this one left to get wrong.
 *
 * **The include is required, and an absent one is a build failure rather than
 * an empty list.** This parameter was `Partial<…>` with a `?? []` behind it, so
 * a row read without `libraryMentionInclude` answered "no links" — which is not
 * a degraded answer here, it is a destructive one. `serializeLibraryCharacter`
 * ships this array as the state the editor sheet seeds from and PATCHes back,
 * so empty in is a PATCH whose `mentionedCharacterIds` is empty, and the
 * `deleteMany` behind that takes every CHARACTER row the source owns while the
 * `@Name` tokens stay in the prose with nothing behind them — links no later
 * scan can rebuild, because the scan is driven by the rows that were just
 * deleted. `serializeLibraryCharacter`'s own `Pick` was tightened for exactly
 * that reason and this is the same door one level down; `survivingMentionIds`
 * carries the same requirement on its own parameter, for the same door reached
 * from the server's side.
 */
export function libraryMentionRefs(
  character: Pick<LibraryCharacterWithMentions, "outgoingMentions">
): MobileLibraryMentionDto[] {
  return character.outgoingMentions.flatMap((mention) => {
    // Asked one row at a time, so the name and the kind that answered for it
    // stay on the same row. The naming rule is `libraryMentionTargetName` in
    // `@book-maker/db` and it is called rather than restated: a second spelling
    // of it is how the app comes to draw a link the model never saw. Reaching
    // it used to mean wrapping each row in a one-element
    // `{ outgoingMentions: [mention] }` for `libraryMentionNames` to unwrap —
    // the same single rule, at an object and two arrays per row of the reader's
    // whole library, which is what `GET /api/mobile/characters` runs this over.
    const target = libraryMentionTargetName(mention);
    return target
      ? [
          {
            id: target.id,
            name: target.name,
            kind: MENTION_KIND_WIRE[mention.targetKind],
            otherType: mention.otherType
          }
        ]
      : [];
  });
}

/**
 * Every name entitled to claim a span in one source's description, on the
 * rename and delete paths.
 *
 * A name of its own because it is a question of its own: `discover`
 * (`libraryMentionGraph.ts`) asks who is in the cast, this asks who owns a span
 * of prose. **One candidate set
 * decides that** — a description is scanned whole and the longest name wins a
 * nested token, so `replaceLibraryMentions`, `survivingMentionIds` and this
 * have to name one set, or a span bound by one is invisible to the others. The
 * cast is that set only for as long as the write binds the cast; the day
 * `REPLACED_MENTION_KINDS` grows, this is the call that has to follow the write
 * there.
 *
 * **The source's own name is not in it.** The editor resolves a description
 * against the library minus the character being edited (`excludeCharacterId` in
 * `library_mentions.dart`), and the write stores what that resolution produced
 * — so in "Luna Vega"'s own "@Luna Vega is my hero and @Luna is my friend."
 * both spans are Luna's. Claiming the first one back here left an `@Luna Vega`
 * naming somebody who no longer exists once Luna was renamed away or deleted,
 * inside text no later scan can reach.
 *
 * The parameter is the shared `LibraryMentionRows` rather than a local spelling
 * of it: a second, laxer copy of that shape would accept an
 * `incomingSourceSelect` the reader cannot actually read.
 */
export function claimingNames(source: LibraryMentionRows): LibraryMentionName[] {
  return libraryMentionCharacterRefs(source);
}

/**
 * Old clients preserve only the links whose canonical tokens survive their edit.
 *
 * Whole-set, for the same reason everything else here is: asked one link at a
 * time, a short name "survived" on the occurrence nested inside a longer linked
 * name — "Only @Luna Vega appears now." kept Luna — and the id set that came
 * back then failed `replaceLibraryMentions`, so an ordinary prose edit could
 * not be saved at all.
 *
 * **The rows come in and the cast filter is applied here, because the caller
 * had two lists to choose from and picked the wrong one.** This took the
 * mention list as a parameter, and its one caller — the PATCH — handed it
 * `libraryMentionRefs(live)`, the wire list, which is every kind the row set
 * holds and not the characters this answers about. The two agree only while
 * CHARACTER is the only kind `libraryMentionTargetName` can name: the day a
 * LOCATION row has one, a plain `PATCH {description}` over prose still holding
 * `@Harbor` returns `loc-1` in the surviving set, and `replaceLibraryMentions`
 * answers 404 for a character nobody mentioned — or, past that, writes
 * `targetKind: "CHARACTER"` against a `targetId` that
 * `LibraryMention_target_arc` refuses. The choice is gone: this reads the rows
 * through `libraryMentionCharacterRefs`, the same filter `claimingNames` and
 * the write bind their spans with, which is what the one-candidate-set rule
 * above asks of all three.
 *
 * The include is required for the reason `libraryMentionRefs`' is: what comes
 * back is the **complete** surviving set, so a row read without
 * `libraryMentionInclude` would answer "no links" and the `deleteMany` behind
 * it would take every CHARACTER row the source owns while the `@Name` tokens
 * stayed in the prose with nothing behind them.
 */
export function survivingMentionIds(
  description: string,
  source: Pick<LibraryCharacterWithMentions, "outgoingMentions">
): string[] {
  const mentions = libraryMentionCharacterRefs(source);
  const claimed = new Set(
    libraryMentionRanges(description, mentions).map((range) => range.id)
  );
  return mentions.filter((mention) => claimed.has(mention.id)).map((mention) => mention.id);
}

/**
 * Restores caller order after a database `IN` query.
 *
 * A read by id comes back in whatever order the plan produced, and every caller
 * of one here has an order that means something: the ids the reader tapped, in
 * the sequence they tapped them. A row the read did not return simply drops —
 * a character deleted between the request and the query is one the caller
 * cannot name, and inventing a placeholder for it would put a name nobody owns
 * in front of a model.
 */
export function orderedCharacterRefs(
  ids: readonly string[],
  characters: readonly { id: string; name: string }[]
): Array<{ id: string; name: string }> {
  const byId = new Map(characters.map((character) => [character.id, character]));
  return ids.flatMap((id) => {
    const character = byId.get(id);
    return character ? [{ id: character.id, name: character.name }] : [];
  });
}

/**
 * The caller's ids, deduplicated, in the order they first arrive.
 *
 * One spelling, because two lanes count against a cap with it: the link write
 * dedupes before it counts against the cast limit (`mentionedTargets`,
 * `libraryMentionLinks.ts`) and `expandLibraryCharacterGraph` dedupes its roots
 * before it spends its expansion budget. A second spelling would let one lane's
 * "ten characters" mean something the other's does not.
 */
export function uniqueIds(ids: readonly string[]): string[] {
  return [...new Set(ids)];
}
