/**
 * How a library character's outgoing @mentions are read off the database.
 *
 * The include, the two readings of a mention row and the model-facing
 * description live together because **both ends of the queue read the same
 * rows**: the mobile API serializes, rewrites and strips them, and the worker's
 * portrait handler builds an image prompt out of the same description. The
 * worker used to carry its own copy of all of it, minus the `targetKind`
 * filter. Two spellings of one rule is how the description the planner reads
 * and the description a portrait prompt is built from come to differ, and a
 * character whose two descriptions differ reaches the planner and the reference
 * sheet as two different people.
 *
 * **Reached by subpath, deliberately, and not re-exported from `index.ts`.**
 * The mobile API suites mock `@book-maker/db` wholesale with a hand-written
 * factory that may import nothing but `vitest`; a scanner cannot be written
 * there, so a name added to the main entry would take every one of those
 * suites down. Off the subpath the real module loads under those mocks exactly
 * as it does in production, which is the point.
 *
 * **That argument has to hold for both packages this file imports, and only
 * one of them is types.** The Prisma import below is `import type`, so no
 * `PrismaClient` is built and `vi.mock("@book-maker/db")` cannot reach it. The
 * other import is a *value*, and `@book-maker/core`'s index barrel re-exports
 * the provider adapters, the prompts and the PDF pipeline — so a suite that
 * mocks core with a bare object factory
 * (`apps/api/src/mobile/editOperations.test.ts`,
 * `apps/worker/src/generation/characterReferences.test.ts`) replaces the whole
 * barrel, and the day its import graph grows a path to `routes/characters.ts`
 * or `characterPortrait.ts` this module comes up holding an undefined
 * `stripBoundLibraryMentionMarkers` — the breakage the subpath exists to avoid,
 * arriving from the other side. `@book-maker/core/libraryMentions` is that
 * package's own narrow entry, a leaf module with no imports at all, and a
 * specifier a `vi.mock("@book-maker/core")` does not name.
 */
import {
  stripBoundLibraryMentionMarkers,
  stripEveryLibraryMentionMarker
} from "@book-maker/core/libraryMentions";
import type { Prisma } from "./generated/prisma/client.ts";
import type { LibraryMentionTargetKind } from "./generated/prisma/enums.ts";

/**
 * The order one source's mention rows come back in — the kind first, and total.
 *
 * **One declaration, and every read of these rows is ordered by it**, because
 * the sequence is load-bearing rather than cosmetic: it is the order
 * `libraryMentionNames` hands the marker scan, and the order
 * `expandLibraryCharacterGraph` spends its bounded cast budget in — so two rows
 * that can tie make *which* linked character reaches the model a property of
 * the plan Postgres picked rather than of the description.
 *
 * **`sortOrder` is a position inside one write, not inside the description.**
 * The write that puts a source's links back replaces one kind's rows and
 * numbers what it inserts from 0 (`REPLACED_MENTION_KINDS` and the `createMany`
 * beside it, `apps/api/src/mobile/libraryMentionLinks.ts`). Ordered on that column
 * alone, the day a location write lands, a source with two character links and
 * two location links holds 0, 1, 0, 1 — two pairs with equal sort keys, over
 * which Postgres promises nothing, so the same four rows come back in a
 * different interleaving from one query to the next.
 *
 * So the kind is the first key: `sortOrder` is then only ever compared against
 * numbers from the same write, which is exactly the set that write numbered,
 * and each kind's block is in true first-token order. Numbering globally
 * instead is not available and is not merely unimplemented — a LOCATION row has
 * no name (`libraryMentionTargetName` below), so no write can find its span in
 * the prose, and renumbering rows a call was not given is the widening
 * `REPLACED_MENTION_KINDS` exists to forbid. `targetId` closes the order:
 * `sourceCharacterId` is fixed for these rows and `@@id([sourceCharacterId,
 * targetKind, targetId])` is the primary key, so no two of one source's rows
 * can survive all three terms tied.
 *
 * **Exported, because the include is not the only read of these rows.**
 * `incomingSourceSelect` (`apps/api/src/mobile/libraryMentionRewrites.ts`) is
 * a hand-written `select` for the rename and delete paths, and it bypasses the
 * include entirely — it carried no `orderBy` at all, so `claimingNames` built
 * its candidate list in whatever order the plan happened to produce, past the
 * one place this rule is written down. It reads these terms rather than
 * respelling them, for the reason the two readings of a row share a file: a
 * second spelling of an ordering is an ordering that can come to differ from
 * the one argued for here, and the difference shows up as *which* linked
 * character a capped read kept.
 *
 * Nothing writes LOCATION or OTHER rows today, so no read has ever come back
 * shuffled; this is the hole closed before it opens rather than one anything
 * has fallen into. The sort is over at most a source's `LIBRARY_MENTION_LIMIT`
 * rows per kind, which is why it asks nothing of an index.
 */
export const libraryMentionOrder: Prisma.LibraryMentionOrderByWithRelationInput[] = [
  { targetKind: "asc" },
  { sortOrder: "asc" },
  { targetId: "asc" }
];

/**
 * The same terms as an array of the caller's own — never a second spelling.
 *
 * `libraryMentionOrder` mapped, so there is still exactly one place the terms
 * are written down and a term added there reaches every read. The terms are
 * copied too, not just the array — they are flat `{ field: "asc" }` objects, so
 * a spread each is the whole copy.
 *
 * **Two reads outside the include hold them, and they hold them differently.**
 * `incomingSourceSelect` (`apps/api/src/mobile/libraryMentionRewrites.ts`) is a
 * module constant every rename and delete read shares, so it takes its
 * `orderBy` from here per read rather than keeping one array of its own — a
 * shared holder is exactly what the include's identity tests cannot see written
 * into. `storedMentionLinks` (`apps/api/src/mobile/libraryMentionLinks.ts`)
 * builds its whole `findMany` args per call instead, so the copy lives and dies
 * with the one read.
 *
 * **In that second read the order is load-bearing in a way it is nowhere else:
 * the rows are compared positionally.** `mentionLinksAlreadyStored` walks them
 * against the insertion batch the save numbered `0..n-1`, index for index, and
 * a match is what lets an ordinary description save write nothing. Unordered,
 * the same rows come back in whatever sequence the plan produced and that
 * answer is "not identical" at random — every typo fix back on the `deleteMany`
 * plus `createMany` pair the skip exists to avoid, inside the transaction
 * holding the character's row lock, colliding on the primary key with any
 * concurrent save of the same character.
 */
export function libraryMentionOrderArgs(): Prisma.LibraryMentionOrderByWithRelationInput[] {
  return libraryMentionOrder.map((term) => ({ ...term }));
}

/**
 * The order a **target's** mention rows come back in — the whole primary key,
 * and total.
 *
 * A second declaration rather than a second spelling of the one above, because
 * it orders a different axis and the two are not interchangeable.
 * `libraryMentionOrder` sequences one *source's* outgoing rows: it is read
 * under a fixed `sourceCharacterId`, so its three terms close on the rest of
 * the key. The read this one is for — `incomingMentionSources`
 * (`apps/api/src/mobile/libraryMentionRewrites.ts`), the first statement of every
 * rename and every delete — selects on `targetCharacterId` instead, where the
 * source varies and the outgoing order's leading term cannot: only a CHARACTER
 * row can carry that column at all (`LibraryMention_target_arc` forces it null
 * for LOCATION and OTHER), so `targetKind` is constant across every row this
 * read can return and borrowing those terms would sort a set they cannot tell
 * apart. `@@id([sourceCharacterId, targetKind, targetId])` whole is what closes
 * it: no two stored rows survive all three tied, whatever the target.
 *
 * **The source id leads because it is the only term here that sorts anything.**
 * `targetKind` is constant for the reason just given, and `targetId` is
 * constant too — one write stores it equal to `targetCharacterId`, which this
 * read has already fixed — so those two close the key while the source id is
 * what puts these rows, and the sources deduped out of them, in a sequence at
 * all. That is the whole of the argument for the position: no reader below
 * needs *this* order rather than some other stable one.
 *
 * It used to claim more. `claimCharacterRows`
 * (`apps/api/src/mobile/characterWriteConflicts.ts`) takes the whole set in one
 * `SELECT … FOR NO KEY UPDATE` `ORDER BY "id"`, so ascending source id was read
 * as making `rewriteMentioningDescriptions` issue its per-row `UPDATE`s in the
 * sequence their locks had been granted in. There are no per-row `UPDATE`s: it
 * writes one `UPDATE … FROM unnest(…)` — the collapse
 * `CHARACTER_MENTION_TRANSACTION_OPTIONS`' 10 s ceiling was sized on — which
 * takes no lock the claim is not already holding, so the array order is not a
 * lock order, and that function's own docblock says so outright.
 *
 * **The outer read carried no order at all, which is the half the argument
 * above kept missing.** `incomingSourceSelect` has taken
 * `libraryMentionOrderArgs()` on its *nested* rows since the day
 * `claimingNames` was found scanning them in plan order — while the read that
 * produces those sources asked for nothing, so what the rename and delete paths
 * inherited from that fix was an ordered list of mentions inside an unordered
 * list of characters. Two things follow from the sequence, and neither is
 * visible to a suite that mocks Prisma: which sibling a
 * `CHARACTER_MENTION_TOO_LONG` refusal names when a rename is too long for more
 * than one description, and which of a source's duplicate rows wins
 * `incomingMentionSources`' own dedupe — the second the cheaper to state, and
 * the one nothing can observe today for the same reason `targetId` sorts
 * nothing here: a duplicate pair carries the same joined source either way
 * round.
 *
 * The sort asks nothing of an index and cannot be given one:
 * `@@index([targetCharacterId])` serves the filter, and the key's own index
 * cannot serve the ordering because the filtered column is not in the key at
 * all. What it sorts is one row per character that mentions this target — at
 * most `LIBRARY_CHARACTER_LIMIT_PER_USER - 1` of them, the same bound the claim
 * that follows it holds row locks over.
 *
 * **Spliced by the read, unfrozen, exactly as the include below splices the
 * outgoing terms** — `incomingMentionSources` builds a fresh args object per
 * call and names this array in it, so this stays the one place its terms are
 * written down. `libraryMentionInclude`'s docblock is where that choice is
 * argued, against both a freeze and a copy.
 */
export const incomingLibraryMentionOrder: Prisma.LibraryMentionOrderByWithRelationInput[] = [
  { sourceCharacterId: "asc" },
  { targetKind: "asc" },
  { targetId: "asc" }
];

/**
 * The read every route, the graph walk and the portrait handler take these rows
 * through — and the one deliberate holder of the order declared above.
 *
 * **The declaration is spliced by identity: not frozen, and not copied per
 * read.** Both defences were here once — a deep freeze on the terms, and an
 * `orderBy` getter over a fresh `libraryMentionOrderArgs()` per query — against
 * a client extension or `$use` middleware normalising the args object it is
 * handed, which would rewrite what every later read of these rows sorts by at
 * once and raise nothing. That is not a bet anything here is taking: one client
 * construction (`client.ts`, `new PrismaClient({ adapter, log })`, nothing
 * chained), no `$extends` and no `$use` outside the generated client's own
 * declarations, no `prisma-extension*` in the lockfile.
 *
 * The two defences are also not the same price, which is why neither came back
 * when the other went. The getter allocated an array and three objects per
 * query to be exercised only by a test poking the declaration. A freeze costs
 * nothing after load — and buys less than it looks: this include is itself the
 * module constant every read hands over, so a normaliser assigning
 * `args.include.outgoingMentions.orderBy = […]` writes past a frozen array into
 * this object, and only the `push`/index spelling is closed. What the freeze
 * does change is the failure: a client that did normalise in place would throw
 * a `TypeError` out of every character read the app and the worker take, rather
 * than returning a cast in a different order.
 *
 * So the identity **is** the defence, and it is what both measurements are
 * written against. `libraryMentions.test.ts` pins it with a `toBe`, so an
 * equal-but-separate second spelling spliced in here fails; the opt-in
 * `libraryMentions.integration.test.ts` compares the declaration against its own
 * spelling after a burst of every read shape, which is a real measurement of "a
 * real client hands the args back as given" only because the array it inspects
 * is the array the queries carried. Against a per-read copy both statements are
 * about an object nobody shares. `libraryMentionOrderArgs()` exists for the two
 * reads that are not this include — `incomingSourceSelect`
 * (`apps/api/src/mobile/libraryMentionRewrites.ts`), a module constant every
 * rename and delete read shares, and therefore a second holder that neither
 * test would see written into, and `storedMentionLinks`
 * (`apps/api/src/mobile/libraryMentionLinks.ts`), whose rows one save compares
 * positionally against the batch it is about to write.
 */
export const libraryMentionInclude = {
  outgoingMentions: {
    orderBy: libraryMentionOrder,
    include: { targetCharacter: { select: { id: true, name: true } } }
  }
} as const;

export type LibraryCharacterWithMentions = Prisma.LibraryCharacterGetPayload<{
  include: typeof libraryMentionInclude;
}>;

/**
 * One mention row as every reader of it needs it.
 *
 * **`targetKind` is required, and the compiler is the point of it.** It is the
 * column that says whether a row is a person at all, and every reading below
 * turns on it — so a `select` that leaves it out must fail to compile rather
 * than hand these functions a row they have to guess about. It was optional
 * once, and an absent kind was read as CHARACTER, which is true only while
 * CHARACTER is the only kind anything writes: the first LOCATION row plus one
 * narrower `select` makes a place a cast member — into
 * `expandLibraryCharacterGraph`'s expansion, into a reference sheet, and to the
 * planner as a person. `incomingSourceSelect`
 * (`apps/api/src/mobile/libraryMentionRewrites.ts`) is the proof a hand-written
 * select
 * can miss it: the column was added there by a human, with nothing in the types
 * asking.
 *
 * Nothing *stored* can lack a kind — the column is `NOT NULL DEFAULT
 * 'CHARACTER'` (`prisma/migrations/000058_library_mentions`) — so what is left
 * is the shape a type cannot reach: a cast fixture, a row rebuilt from JSON, a
 * JavaScript caller. One arriving anyway is read as **not a character**, in
 * `libraryMentionTargetName`'s default and in `isCharacterMention`. That way
 * round costs a link the cast does not get; the other way round costs a book
 * drawn about a harbour. It no longer costs an `@marker` in prose as well: a row
 * nothing can name is exactly what makes `generationDescription` strip every
 * marker rather than only the ones it can scan for.
 */
export type LibraryMentionRow = {
  targetKind: LibraryMentionTargetKind;
  targetCharacterId?: string | null | undefined;
  targetCharacter?: { id: string; name: string } | null | undefined;
};

export type LibraryMentionRows = {
  outgoingMentions?: readonly LibraryMentionRow[] | null | undefined;
};

/**
 * The name a row puts into the prose, or null when nothing can name the row.
 *
 * **CHARACTER is the only kind with a name, anywhere.** `targetCharacter` is
 * the include's only join because there is no Location or Other table to join
 * to yet, and the database says so as well: `LibraryMention_target_arc`
 * (`prisma/migrations/000058_library_mentions`) forces `targetCharacterId IS
 * NULL` for LOCATION and OTHER, so a row of either kind reaches every reader
 * here carrying nothing but its `targetId`. The branch below says that out
 * loud rather than letting a null join say it by accident, and the `never` in
 * `unnameableMentionKind` is what makes the kind added alongside those tables
 * answer the question **here** — this is the one place a row becomes a name.
 *
 * **A `null` here is a marker nothing can locate, and `generationDescription`
 * answers it by stripping every marker instead.** An `@marker` bound to a
 * LOCATION or OTHER row sits on a span no name can be scanned for, so the strip
 * that works by name cannot find it and used to hand the planner and
 * `buildLibraryCharacterPortraitPrompt` a raw `@Harbor` — a UI token, in the one
 * place a UI token must never reach. Nothing kept that shut but
 * `REPLACED_MENTION_KINDS` (`apps/api/src/mobile/libraryMentionLinks.ts`) still
 * being `["CHARACTER"]` alone: the first LOCATION row anything writes would have
 * been the leak, with no code change anywhere to notice. So the answer is
 * derived from the rows rather than remembered — see `generationDescription` —
 * and the day those joins go into `libraryMentionInclude` and are read in the
 * branch below, a Location stops being unnameable and the strip by name covers
 * it again.
 *
 * **Exported, because one reader needs the rule a row at a time.**
 * `libraryMentionRefs` (`apps/api/src/mobile/libraryMentionRows.ts`) serializes
 * each row beside the kind that answered for it, so the name and the kind
 * cannot come off different rows — and it reached this rule by wrapping every
 * row in a fresh `{ outgoingMentions: [mention] }` and handing that to
 * `libraryMentionNames`, an object and two arrays per row over the reader's
 * whole library on `GET /api/mobile/characters`. Its instinct was right and
 * only its route was wrong: a second spelling of the naming rule is how the
 * app comes to draw a link the model never saw, so the rule is exported rather
 * than restated. A row this answers `null` for is withheld there exactly as it
 * falls out of `libraryMentionTargets` here — every kind but CHARACTER, today.
 * **That withholding is the app-side half of the same hole, and it is still
 * open**: `generationDescription` below now keeps such a row's marker away from
 * a model whatever it is, but a wire list that drops the row leaves the app
 * unable to draw or unlink it, so a stored `@Harbor` would be a link only the
 * database knows about. Closing that is a decision about the DTO
 * (`MobileLibraryMentionDto` carries a name), not about this rule.
 */
export function libraryMentionTargetName(
  mention: LibraryMentionRow
): { id: string; name: string } | null {
  switch (mention.targetKind) {
    case "CHARACTER": {
      const target = mention.targetCharacter;
      return target ? { id: target.id, name: target.name } : null;
    }
    case "LOCATION":
    case "OTHER":
      // No table, no join, no name — see the docblock. Deliberately not a
      // fallback to `targetCharacter`: the arc CHECK means a row of these
      // kinds cannot carry one, and reading it anyway would name a place with
      // whichever character it was mis-written against.
      return null;
    default:
      return unnameableMentionKind(mention.targetKind);
  }
}

/**
 * The answer for a kind this file has never read.
 *
 * `never` is the compile-time half: a fourth `LibraryMentionTargetKind` stops
 * being assignable and the kind added alongside its table has to answer the
 * naming question above rather than fall through it. `null` is the runtime
 * half, and it is reachable — `LibraryMentionRow` requires the column, but a
 * cast fixture or a JavaScript caller can still arrive without one, and a row
 * whose kind nothing here has read is a row nothing here can name.
 */
function unnameableMentionKind(_kind: never): null {
  return null;
}

/**
 * Whether a row points into the character library.
 *
 * The kind decides, and nothing else answers for it. A row that arrives
 * carrying none — which the type refuses and the database cannot store — is
 * **not** a character: this used to answer `true` for it, so any `select` that
 * forgot the column read every LOCATION and OTHER row as a cast member.
 */
function isCharacterMention(mention: LibraryMentionRow): boolean {
  return mention.targetKind === "CHARACTER";
}

/**
 * One entry per row this keeps and can name, and none for any other row.
 *
 * That one-to-one is what lets `generationDescription` decide whether a marker
 * nothing can locate is in the set by comparing two lengths instead of asking
 * `libraryMentionTargetName` about every row a second time. A row is never
 * expanded into two names — `libraryMentionTargetName` answers with one target
 * or with `null` — so a `keep`-everything read is shorter than the rows exactly
 * when one of them is nameless.
 */
function libraryMentionTargets(
  character: LibraryMentionRows,
  keep: (mention: LibraryMentionRow) => boolean
): Array<{ id: string; name: string }> {
  return (character.outgoingMentions ?? []).flatMap((mention) => {
    if (!keep(mention)) return [];
    const target = libraryMentionTargetName(mention);
    return target ? [target] : [];
  });
}

/**
 * The characters a description links to, in stored order — the **cast**.
 *
 * The kind decides, never the presence of `targetCharacter`: Location and
 * Other share this table, and a reference invented out of one is a place the
 * book would draw a character sheet for. The arc CHECK already keeps a stored
 * row of those kinds from carrying a `targetCharacterId`, so against database
 * rows the filter is a second lock on the same door. It is load-bearing for
 * the row shapes that do not come from a query — and `LibraryMentionRow` now
 * holds the reachable half of those to the same rule: a hand-written `select`
 * that drops the column no longer compiles. What is left is what a type cannot
 * reach, a cast fixture or a JavaScript caller, and this reads such a row as
 * nobody rather than as everybody.
 */
export function libraryMentionCharacterRefs(
  character: LibraryMentionRows
): Array<{ id: string; name: string }> {
  return libraryMentionTargets(character, isCharacterMention);
}

/**
 * Every name a marker in this description is bound to — the **scan set**.
 *
 * Two readings of one row set, and the difference is the filter rather than the
 * answer. A cast answers "who does the book need a reference sheet for", so it
 * is characters and nothing else. A scan set answers "which spans are markers
 * at all", and the `@` is a UI token that must never reach a model — so it
 * takes every kind and lets `libraryMentionTargetName` decide what a row is
 * called.
 *
 * **Today the two return the same rows**, because CHARACTER is the only kind
 * that function can name: a LOCATION or OTHER row falls out of this list too.
 * What that costs is written down in `libraryMentionTargetName` along with what
 * closes it, and `generationDescription` is what keeps the cost bounded in the
 * meantime — a row missing from this list is the reason it stops trusting the
 * list. The two readings stay separate because the day those joins land is the
 * day they diverge: this one starts returning names the cast must never
 * contain, and widening the cast to strip those markers instead would hand the
 * planner a place as a person.
 */
export function libraryMentionNames(
  character: LibraryMentionRows
): Array<{ id: string; name: string }> {
  return libraryMentionTargets(character, () => true);
}

/**
 * The rows as a reader that *needs* them has to be handed them.
 *
 * `LibraryMentionRows` is permissive on purpose: `libraryMentionCharacterRefs`
 * and `libraryMentionNames` are asked about rows that may legitimately not have
 * been fetched, and an unfetched list is honestly an empty cast. Requiring the
 * rows is the same statement `libraryMentionRefs` and `serializeLibraryCharacter`
 * (`apps/api/src/mobile/`) make with their own `Pick` — an absent one is a build
 * failure rather than an empty list — made here against the shared row shape
 * rather than the Prisma payload, because `LibraryMentionRow` is what these
 * readers read and a hand-written `select` that carries it is a legal source.
 * What must fail is the *key* being absent, which is exactly what a read taken
 * without `libraryMentionInclude` produces.
 *
 * `null` is out for the same reason and not merely for tidiness: nothing Prisma
 * returns for a to-many relation is null, so a null here is a shape claiming
 * rows it never fetched — the omission's one remaining spelling.
 */
type IncludedLibraryMentionRows = {
  outgoingMentions: NonNullable<LibraryMentionRows["outgoingMentions"]>;
};

/**
 * The description models see: a name a mention row is bound to stays as
 * ordinary prose with its `@` removed.
 *
 * An `@` no row claims is the reader's own text and is left where they put it —
 * **unless a row in the set is one nothing can name**, and then every marker
 * goes, claimed or not. The two strips differ in what they trust: the narrow one
 * (`stripLibraryMentionMarkers`) finds a marker by scanning for its owner's
 * name, which is exact and is only as complete as the name list. A row
 * `libraryMentionTargetName` answers `null` for — a LOCATION or OTHER row, whose
 * table does not exist yet; a CHARACTER row whose join a `select` dropped — is a
 * marker the reader bound, standing somewhere in this prose, that no scan can
 * locate. Leaving it is handing `@Harbor` to the planner brief
 * (`creationBuild.ts`) and to `buildLibraryCharacterPortraitPrompt`, and the `@`
 * is a UI token that must never reach a model.
 *
 * So the answer is read off the rows every time rather than remembered: nothing
 * has to be changed here on the day something writes a LOCATION row, and nothing
 * has to be changed back on the day that library lands and the row becomes
 * nameable. What the broad strip costs is a reader's own `@handle` elsewhere in
 * *that* description losing its `@` — prose, in a description that already holds
 * a marker we cannot place. What it buys is that no marker survives by being
 * unnameable.
 *
 * **Whether such a row is in the set is read off the scan set's own length.**
 * `libraryMentionNames` emits one entry per row it can name and none for the
 * rest, so a list shorter than the rows *is* a marker no scan can locate — the
 * question answered out of the pass already taken rather than by walking the
 * rows a second time to re-ask `libraryMentionTargetName` the identical
 * question. It is a property of the rows rather than of a kind list because the
 * kinds are not the only way a row arrives nameless: a CHARACTER row read
 * through a `select` that carried `targetKind` and dropped `targetCharacter` is
 * the same silence, and so is a row rebuilt from JSON with no kind at all.
 *
 * **Naming every row is not the same as claiming every marker, so the narrow
 * branch is the *bound* strip rather than the plain one.** `@BRAM` standing
 * between the rows "Bram" and "bram" — two legal rows, since `[userId, name]`
 * is case-sensitive — is claimed by neither: `claimAt` refuses a tie it cannot
 * settle, because a wrong owner is unrecoverable. Both rows are perfectly
 * nameable, so the test above sends that description down this branch, and
 * `stripLibraryMentionMarkers` leaves an `@` no name claimed exactly where the
 * reader put it. It has no way not to: it takes `siblings` whose tokens must
 * survive, so a tie may belong to one of them. Nothing here has a surviving
 * sibling — every name in the set is one whose marker is going — which is the
 * whole of what `stripBoundLibraryMentionMarkers` asks for, and a tie costs it
 * nothing to settle since every candidate agrees on the deletion. The broad
 * strip is not the answer to this: it takes the reader's own `@handle` with it,
 * a price only an unnameable row is worth paying.
 *
 * **This is the reader the rows are required for.** Every other function here
 * answers a question a caller can act on — an empty cast is a visible answer —
 * while this one hands prose to a model, so an empty scan set is not "no
 * mentions" but "strip nothing", and the difference between the two is an
 * `@Bram` in a planner brief and in `buildLibraryCharacterPortraitPrompt`. It
 * took `LibraryMentionRows` for a while and a row read without the include
 * therefore typechecked, returning the stored prose with its markers standing
 * and nothing raised anywhere. All five call sites — the worker's portrait
 * handler, `creationBuild.ts` and the two creation/chat routes — read through
 * `libraryMentionInclude` already; what the requirement buys is the sixth, and
 * the day one of those five is narrowed.
 */
export function generationDescription(
  character: IncludedLibraryMentionRows & { description: string }
): string {
  const names = libraryMentionNames(character);
  // `?.length ?? 0` rather than `.length`: the type requires the rows, and the
  // reachable half of that requirement is a caller a type cannot reach — the
  // same shape every reader here answers closed for.
  return names.length === (character.outgoingMentions?.length ?? 0)
    ? stripBoundLibraryMentionMarkers(character.description, names)
    : stripEveryLibraryMentionMarker(character.description, names);
}
