import { describe, expect, it, vi } from "vitest";

/**
 * The core barrel, replaced wholesale — which is what this module has to
 * survive.
 *
 * This file is the light subpath's own suite, and the subpath exists so the
 * real module loads under a wholesale `vi.mock("@book-maker/db")`. Half of
 * that argument used to be untrue in the other direction: the marker strip is
 * a **value** import, and it came off `@book-maker/core`'s index barrel — the
 * one every bare-object core factory in the repo replaces
 * (`apps/api/src/mobile/editOperations.test.ts`,
 * `apps/worker/src/generation/characterReferences.test.ts`). Any suite holding
 * one that later grew an import path to `routes/characters.ts` or
 * `characterPortrait.ts` would have met "stripLibraryMentionMarkers is not a
 * function" from inside `generationDescription`. The import is
 * `@book-maker/core/libraryMentions` now — a leaf module with no imports of
 * its own, and a specifier this mock does not name — so the empty barrel below
 * costs the tests underneath it nothing. Restore the barrel import and every
 * `generationDescription` case in this file fails.
 */
vi.mock("@book-maker/core", () => ({}));

import {
  generationDescription,
  incomingLibraryMentionOrder,
  libraryMentionCharacterRefs,
  libraryMentionInclude,
  libraryMentionNames,
  libraryMentionOrder,
  libraryMentionOrderArgs,
  type LibraryMentionRow
} from "./libraryMentions.ts";

/** A CHARACTER row as the include hands it over. */
const characterMention = (id: string, name: string): LibraryMentionRow => ({
  targetKind: "CHARACTER",
  targetCharacterId: id,
  targetCharacter: { id, name }
});

/**
 * A LOCATION or OTHER row, spelled the only way the database can store one.
 *
 * `LibraryMention_target_arc` (migration `000058_library_mentions`) requires
 * `targetCharacterId IS NULL` for both kinds, and `targetCharacter` is the
 * include's only join — so neither column can carry anything and the row
 * arrives nameless, holding only the `targetId` no table answers yet.
 */
const nonCharacterMention = (kind: "LOCATION" | "OTHER"): LibraryMentionRow => ({
  targetKind: kind,
  targetCharacterId: null,
  targetCharacter: null
});

/**
 * A row that reaches a reader carrying no kind at all.
 *
 * Nothing produces one honestly. The column is `NOT NULL DEFAULT 'CHARACTER'`,
 * so no stored row lacks it, and `LibraryMentionRow` requires it, so no
 * `select` that drops it compiles — which is what the last test in the first
 * block below pins. The cast is exactly the shape a type cannot reach: a
 * fixture, a row rebuilt from JSON, a JavaScript caller. It is spelled once
 * here because all three readers have to answer for it, and they answer
 * **closed**: reading it as a character is what turns a LOCATION row into a
 * cast member with a reference sheet, and hands the planner a harbour as a
 * person. Read as nobody, what it costs is a link the cast does not get — and
 * no longer an `@marker` in prose, because a row nothing can name is the very
 * condition `generationDescription` strips every marker on.
 */
const kindlessMention = (id: string, name: string): LibraryMentionRow =>
  ({ targetCharacterId: id, targetCharacter: { id, name } }) as unknown as LibraryMentionRow;

describe("libraryMentionCharacterRefs", () => {
  it("holds the cast to characters", () => {
    expect(
      libraryMentionCharacterRefs({
        outgoingMentions: [characterMention("char-2", "Bram"), nonCharacterMention("LOCATION")]
      })
    ).toEqual([{ id: "char-2", name: "Bram" }]);
  });

  it("decides on the kind, not on whether a join came back", () => {
    // The database cannot produce this row — the arc CHECK forbids a LOCATION
    // carrying a `targetCharacterId`, and there is no character it could point
    // at. It is written out anyway because these functions take a row *shape*
    // rather than a query result: fixtures and whatever writes this table next
    // all reach them, and the filter is what keeps a place from becoming
    // somebody the book draws a sheet for.
    expect(
      libraryMentionCharacterRefs({
        outgoingMentions: [
          { targetKind: "LOCATION", targetCharacterId: "loc-1", targetCharacter: { id: "loc-1", name: "Harbor" } }
        ]
      })
    ).toEqual([]);
  });

  it("reads a row that carries no kind as nobody", () => {
    // Fail closed. This used to answer with Bram, on the reasoning that a
    // narrower `select` could only ever have been selecting characters — true
    // while CHARACTER is the only kind anything writes, and false the moment a
    // LOCATION row exists, because the same reading makes that row a cast
    // member too. The column is required now, so the reachable half of this is
    // a compile error; what is left answers nobody.
    expect(
      libraryMentionCharacterRefs({ outgoingMentions: [kindlessMention("char-2", "Bram")] })
    ).toEqual([]);
  });

  it("refuses a select narrow enough to drop the kind, at compile time", () => {
    // The point of requiring the column: a row shape without it is not a row
    // this can read, so the omission is a build failure rather than a cast
    // that quietly gained whatever the table holds. `incomingSourceSelect`
    // (`apps/api/src/mobile/libraryMentionRewrites.ts`) carries `targetKind: true`
    // because a person added it; nothing asked, and this is what asks. The
    // directive itself fails the build the day the field goes optional again.
    const narrowSelect = {
      outgoingMentions: [{ targetCharacterId: "char-2", targetCharacter: { id: "char-2", name: "Bram" } }]
    };

    // @ts-expect-error `targetKind` is missing from the row shape.
    expect(libraryMentionCharacterRefs(narrowSelect)).toEqual([]);
  });

  it("says nobody when the rows were not fetched", () => {
    expect(libraryMentionCharacterRefs({})).toEqual([]);
  });
});

describe("libraryMentionNames", () => {
  it("names the characters, in stored order", () => {
    expect(
      libraryMentionNames({
        outgoingMentions: [characterMention("char-2", "Bram"), characterMention("char-3", "Ada")]
      })
    ).toEqual([
      { id: "char-2", name: "Bram" },
      { id: "char-3", name: "Ada" }
    ]);
  });

  it("cannot name a kind that has no target table, so the scan set is the cast today", () => {
    // The scan set takes every kind and asks `libraryMentionTargetName` what
    // each row is called; CHARACTER is the only kind it can answer for, so a
    // Location contributes nothing and these two readings coincide. When the
    // Location library lands its join goes into `libraryMentionInclude`, that
    // function reads it, and this returns a name the cast still must not have.
    const outgoingMentions = [
      nonCharacterMention("LOCATION"),
      characterMention("char-2", "Bram"),
      nonCharacterMention("OTHER")
    ];

    expect(libraryMentionNames({ outgoingMentions })).toEqual([{ id: "char-2", name: "Bram" }]);
    expect(libraryMentionNames({ outgoingMentions })).toEqual(
      libraryMentionCharacterRefs({ outgoingMentions })
    );
  });

  it("cannot name a row that carries no kind either", () => {
    // The two readings differ in their filter and not in their answer, so the
    // kindless row falls out of both — the scan set through
    // `libraryMentionTargetName`'s default, the cast through the filter.
    expect(libraryMentionNames({ outgoingMentions: [kindlessMention("char-2", "Bram")] })).toEqual([]);
  });

  it("says nobody when the rows were not fetched", () => {
    expect(libraryMentionNames({})).toEqual([]);
  });
});

describe("generationDescription", () => {
  it("strips a character's marker and keeps their name as prose", () => {
    expect(
      generationDescription({
        description: "Travels with @Bram.",
        outgoingMentions: [characterMention("char-2", "Bram")]
      })
    ).toBe("Travels with Bram.");
  });

  it("strips a marker two nameable rows tie over, without touching the reader's own", () => {
    // Nameable is not the same as claimable. `[userId, name]` is
    // case-sensitive, so "Bram" and "bram" are two legal rows and both name
    // themselves — the test above sends this description down the narrow
    // branch — while `claimAt` refuses `@BRAM` outright, because a wrong owner
    // is the unrecoverable half. That refusal used to leave a UI token standing
    // in the planner brief and in `buildLibraryCharacterPortraitPrompt`, and
    // the unnameable-row fallback could not see it: both rows are nameable.
    // A tie is settled here rather than fallen back on, because every
    // candidate agrees on the deletion — so `bram@example.com` still keeps its
    // `@`, which the broad strip would have taken.
    expect(
      generationDescription({
        description: "@Bram met @bram at @BRAM's place; write to bram@example.com.",
        outgoingMentions: [characterMention("char-2", "Bram"), characterMention("char-3", "bram")]
      })
    ).toBe("Bram met bram at BRAM's place; write to bram@example.com.");
  });

  it("strips a whole run of markers, not only the one the row is bound to", () => {
    // `libraryMentionQueryAt` opens a mention query on an `@` whose left
    // neighbour is an `@` — an `@` is not a name character — so typing `@@` and
    // tapping the suggestion chip stores `@@Bram` with a live CHARACTER row on
    // the span at offset 1. The strip took that one marker and handed `@Bram`
    // to the planner brief (`creationBuild.ts`) and to
    // `buildLibraryCharacterPortraitPrompt`: the UI token this read exists to
    // keep out of a prompt, one deletion later. Neither branch below could see
    // it — every row here names itself, so the unnameable-row fallback never
    // fires — and the reader's own address still keeps its `@`.
    expect(
      generationDescription({
        description: "Travels with @@Bram; write to bram@example.com.",
        outgoingMentions: [characterMention("char-2", "Bram")]
      })
    ).toBe("Travels with Bram; write to bram@example.com.");
    // The contested half of the same leak: a tie is settled by deleting the
    // `@`, so the run in front of it is opening a deletion just the same.
    expect(
      generationDescription({
        description: "Travels with @@BRAM.",
        outgoingMentions: [characterMention("char-2", "Bram"), characterMention("char-3", "bram")]
      })
    ).toBe("Travels with BRAM.");
  });

  it("strips every marker when a row is one nothing can name", () => {
    // The leak this closes: a LOCATION row is a marker the reader bound and no
    // name can be scanned for, so the strip that works by name walked past
    // `@Harbor` and handed it to the planner brief and to
    // `buildLibraryCharacterPortraitPrompt` — the `@` is a UI token, and that
    // is the one place it must never reach. Nothing kept it shut but
    // `REPLACED_MENTION_KINDS` (apps/api/src/mobile/libraryMentionLinks.ts) still
    // being `["CHARACTER"]`, so the first row anything writes of another kind
    // was the leak, with no code change to notice it.
    expect(
      generationDescription({
        description: "Lives at @Harbor with @Bram, and carries @Sunfang.",
        outgoingMentions: [
          nonCharacterMention("LOCATION"),
          characterMention("char-2", "Bram"),
          nonCharacterMention("OTHER")
        ]
      })
    ).toBe("Lives at Harbor with Bram, and carries Sunfang.");
  });

  it("does it for a LOCATION row and for an OTHER row on their own", () => {
    // One kind at a time, because they are two arms of
    // `libraryMentionTargetName` and either one alone is a description bound
    // to a marker with no name behind it.
    expect(
      generationDescription({
        description: "Sails from @Harbor.",
        outgoingMentions: [nonCharacterMention("LOCATION")]
      })
    ).toBe("Sails from Harbor.");
    expect(
      generationDescription({
        description: "Carries @Sunfang everywhere.",
        outgoingMentions: [nonCharacterMention("OTHER")]
      })
    ).toBe("Carries Sunfang everywhere.");
  });

  it("does it for a CHARACTER row whose join a select dropped", () => {
    // Not a kind question at all, which is why the decision is read off the
    // rows rather than off a list of kinds: `targetKind` survives a narrow
    // `select` and `targetCharacter` does not, and a row with no join is the
    // same silence a LOCATION row is — a bound marker nothing can locate.
    expect(
      generationDescription({
        description: "Travels with @Bram.",
        outgoingMentions: [{ targetKind: "CHARACTER", targetCharacterId: "char-2" }]
      })
    ).toBe("Travels with Bram.");
  });

  it("strips the reader's own @ too once a row is unnameable, which is what that costs", () => {
    // Stated rather than discovered: with a marker in the prose that no scan
    // can place, every token-opening `@` goes — including one the reader typed
    // for themselves. Prose losing an `@`, in a description that already holds
    // a marker we cannot find, against a UI token reaching a model.
    expect(
      generationDescription({
        description: "Lives at @Harbor; ask @Ghost, or bram@example.com, or meet @ the docks.",
        outgoingMentions: [nonCharacterMention("LOCATION")]
      })
    ).toBe("Lives at Harbor; ask Ghost, or bram@example.com, or meet @ the docks.");
  });

  it("takes the @ off a digit token too, which is the cost stated to its edge", () => {
    // `isLibraryMentionNameCharacterAt` (`@book-maker/core/libraryMentions`)
    // counts `\p{N}` alongside `\p{L}`, so "@1994" opens a token and loses its
    // marker with the rest. Reading that as too broad and narrowing the strip to
    // letters would not shrink the blast radius of the guarantee, it would put a
    // hole in it: a Location spelled "1994" is exactly a marker no scan can
    // place, which is the condition this branch fires on. Nor can the strip pick
    // out *which* unclaimed token the unnameable row bound — `LibraryMention`
    // stores a kind, a target id and a per-kind position, and no span — so every
    // token-opening `@` in this one description is the smallest set that is
    // still sound.
    expect(
      generationDescription({
        description: "Born @1994, meets Ana @home, ping @lunaverse.",
        outgoingMentions: [nonCharacterMention("LOCATION")]
      })
    ).toBe("Born 1994, meets Ana home, ping lunaverse.");
  });

  it("strips the marker on a row that arrived with no kind, rather than paying for failing closed", () => {
    // Failing closed keeps this row out of the cast — a row nobody can vouch
    // for is not a cast member — and it used to cost an `@Bram` a model reads.
    // It does not any more: a row nothing can name is exactly the condition
    // that strips every marker, so the fail-closed reading is free here.
    expect(
      generationDescription({
        description: "Travels with @Bram.",
        outgoingMentions: [kindlessMention("char-2", "Bram")]
      })
    ).toBe("Travels with Bram.");
  });

  it("refuses a row read without the mentions include, at compile time", () => {
    // The two directives are this function's whole safety property. A row
    // fetched without `libraryMentionInclude` carries no `outgoingMentions`,
    // so the scan set is empty and the strip is a no-op — and the value below
    // is what that silently returns: the stored prose, `@` and all, on its way
    // into a planner brief or `buildLibraryCharacterPortraitPrompt`. Every
    // other reader here may answer an unfetched row with an empty cast, which
    // is why `LibraryMentionRows` stays optional; this one may not, which is
    // why its parameter is not that type. `null` is the same omission spelled
    // differently — Prisma returns no null for a to-many — and is refused with
    // it. Both directives fail the build the day the parameter is widened
    // back.
    const withoutMentions = { description: "Travels with @Bram." };

    // @ts-expect-error the row was not read through `libraryMentionInclude`.
    expect(generationDescription(withoutMentions)).toBe("Travels with @Bram.");
    // @ts-expect-error `null` claims rows that were never fetched.
    expect(generationDescription({ description: "Travels with @Bram.", outgoingMentions: null })).toBe(
      "Travels with @Bram."
    );
  });

  it("leaves an @ no mention row owns exactly where the reader typed it", () => {
    // Every row here is one the scan set holds, so nothing is bound that the
    // strip cannot find and an unclaimed `@` is the reader's own text.
    expect(
      generationDescription({
        description: "Travels with @Bram; writes to bram@example.com about @Ghost.",
        outgoingMentions: [characterMention("char-2", "Bram")]
      })
    ).toBe("Travels with Bram; writes to bram@example.com about @Ghost.");
  });
});

describe("libraryMentionInclude", () => {
  /** The three columns the read order is allowed to look at. */
  type OrderedMentionRow = { targetKind: string; sortOrder: number; targetId: string };

  /**
   * One source's rows after two writes, which is the only shape that can tie.
   *
   * Each write replaces one kind and numbers what it inserts from 0
   * (`REPLACED_MENTION_KINDS`, apps/api/src/mobile/libraryMentionLinks.ts), so the
   * two blocks below both start there. Nothing writes LOCATION rows yet —
   * that is why this is a shape rather than a regression.
   */
  const afterTwoWrites: OrderedMentionRow[] = [
    { targetKind: "CHARACTER", sortOrder: 0, targetId: "char-2" },
    { targetKind: "CHARACTER", sortOrder: 1, targetId: "char-3" },
    { targetKind: "LOCATION", sortOrder: 0, targetId: "loc-1" },
    { targetKind: "LOCATION", sortOrder: 1, targetId: "loc-2" }
  ];

  /** The declared terms, restated so a rewrite of the export is a failure here. */
  const declaredOrder = [{ targetKind: "asc" }, { sortOrder: "asc" }, { targetId: "asc" }];

  /** Everything the declared order can tell two rows apart by. */
  const readOrderKey = (row: OrderedMentionRow): string =>
    libraryMentionInclude.outgoingMentions.orderBy
      .flatMap((term) => Object.keys(term))
      .map((field) => `${field}=${row[field as keyof OrderedMentionRow]}`)
      .join("|");

  it("reads the kind before the position, then closes on the key", () => {
    // Kind first because `sortOrder` counts inside one write and a write owns
    // one kind, so comparing across kinds compares two counts of different
    // things. `targetId` last because `sourceCharacterId` is fixed for these
    // rows and `@@id([sourceCharacterId, targetKind, targetId])` is the key.
    expect(libraryMentionInclude.outgoingMentions.orderBy).toEqual([
      { targetKind: "asc" },
      { sortOrder: "asc" },
      { targetId: "asc" }
    ]);
  });

  it("leaves no two of one source's rows tied", () => {
    // The property the tuple above exists for, asked of the order itself
    // rather than of its spelling: equal sort keys are an order Postgres may
    // return either way round, and the winner would decide which linked
    // character `expandLibraryCharacterGraph` spends its last budget slot on.
    expect(new Set(afterTwoWrites.map(readOrderKey)).size).toBe(afterTwoWrites.length);
  });

  it("serves every read of these rows from one declaration", () => {
    // The property the export exists for, and the one a second spelling of the
    // terms would break: the API list route, the PATCH re-read,
    // `expandLibraryCharacterGraph` and the worker's portrait prompt all order
    // by this array, so a term added here is a term all four read by. Asserted
    // as identity and not merely as equality — an equal copy spliced into the
    // include is exactly the second spelling that can come to differ.
    expect(libraryMentionInclude.outgoingMentions.orderBy).toBe(libraryMentionOrder);
    expect(libraryMentionOrder).toEqual(declaredOrder);
  });

  it("splices both declarations unfrozen, because the identity is the defence", () => {
    // The statement `libraryMentionInclude`'s docblock makes, as a check, so
    // "just freeze the exports" arrives as a failure with the argument attached
    // rather than as a quiet one-liner. Both arrays were deep-frozen once,
    // against a client extension or `$use` middleware writing into the args it
    // is handed — a bet nothing here takes: one `new PrismaClient` with nothing
    // chained, no `$extends`, no `$use`, no `prisma-extension*` in the lockfile.
    // A freeze closes only half of that anyway, since the include is itself the
    // shared object a read hands over and `orderBy = [...]` on it writes past a
    // frozen array; and it turns the diff the two tests above and the opt-in
    // integration suite would show into a `TypeError` thrown out of every
    // character read the app and the worker take. The disposable-copy shape
    // belongs to `incomingSourceSelect` alone — see `libraryMentionOrderArgs`.
    expect(Object.isFrozen(libraryMentionOrder)).toBe(false);
    expect(libraryMentionOrder.every((term) => !Object.isFrozen(term))).toBe(true);
    expect(Object.isFrozen(incomingLibraryMentionOrder)).toBe(false);
    expect(incomingLibraryMentionOrder.every((term) => !Object.isFrozen(term))).toBe(true);
  });

  it("spells the hand-written selects' ordering, as an array of their own", () => {
    // `incomingSourceSelect` (`apps/api/src/mobile/libraryMentionRewrites.ts`) does
    // not go through the include, and carried no `orderBy` at all until it read
    // this export — so the rename and delete paths built their claim set in
    // whatever order the plan produced. Exported so that read can be this one
    // rather than a second spelling of it; `libraryMentionOrderArgs` is the
    // same terms as an array that select can hold without holding the
    // declaration, which is what it takes its `orderBy` from per read.
    expect(libraryMentionOrderArgs()).toEqual(declaredOrder);
    // Its own array, and its own terms: a spread of the array alone would hand
    // back a list still pointing at the declaration's objects.
    const first = libraryMentionOrderArgs();
    const second = libraryMentionOrderArgs();

    expect(first).toEqual(second);
    expect(first).not.toBe(second);
    expect(first[0]).not.toBe(libraryMentionOrder[0]);
  });
});

describe("incomingLibraryMentionOrder", () => {
  /** Everything the incoming order can tell two rows apart by. */
  type IncomingMentionRow = { sourceCharacterId: string; targetKind: string; targetId: string };

  /**
   * Two sources naming one target, which is the shape the incoming read is for.
   *
   * `targetKind` is CHARACTER on every one of them and cannot be anything else:
   * `LibraryMention_target_arc` forces `targetCharacterId IS NULL` for LOCATION
   * and OTHER, so a row selected by that column is a character row by
   * construction — which is exactly why the outgoing order's leading term
   * cannot sort this set, and why the whole key has to.
   */
  const incomingToOneTarget: IncomingMentionRow[] = [
    { sourceCharacterId: "char-1", targetKind: "CHARACTER", targetId: "char-9" },
    { sourceCharacterId: "char-2", targetKind: "CHARACTER", targetId: "char-9" }
  ];

  it("orders by the whole primary key, source first", () => {
    // Source first because it is the only one of the three that tells two rows
    // of this read apart: `targetKind` is CHARACTER on all of them and
    // `targetId` equals the `targetCharacterId` the read already filtered on.
    // The remaining two terms are the rest of
    // `@@id([sourceCharacterId, targetKind, targetId])`, which is what makes
    // the order total. Nothing downstream needs this sequence rather than another
    // stable one — the rewrite that follows is a single set `UPDATE`, so the
    // sequence is not a lock order (`libraryMentions.ts`).
    expect(incomingLibraryMentionOrder).toEqual([
      { sourceCharacterId: "asc" },
      { targetKind: "asc" },
      { targetId: "asc" }
    ]);
  });

  it("is a different axis from the outgoing order, not a second spelling of it", () => {
    // `libraryMentionOrder` is read under a fixed `sourceCharacterId` and
    // closes on the rest of the key; this one is read under a fixed
    // `targetCharacterId`, where `targetKind` is the constant instead. Borrowed
    // whole, its terms leave every row of the fixture tied — which is the
    // nondeterminism this declaration exists to remove.
    const keyBy = (terms: readonly Record<string, unknown>[]) => (row: IncomingMentionRow) =>
      terms
        .flatMap((term) => Object.keys(term))
        .map((field) => `${field}=${row[field as keyof IncomingMentionRow] ?? ""}`)
        .join("|");

    expect(new Set(incomingToOneTarget.map(keyBy(libraryMentionOrder))).size).toBe(1);
    expect(new Set(incomingToOneTarget.map(keyBy(incomingLibraryMentionOrder))).size).toBe(
      incomingToOneTarget.length
    );
  });

  it("is spliced by the read rather than copied, exactly as the include is", () => {
    // `incomingMentionSources` (`apps/api/src/mobile/libraryMentionRewrites.ts`) builds
    // a fresh args object per call and names this array in it, so there is one
    // place the terms are written down. The disposable-copy shape belongs to
    // `incomingSourceSelect`, which is a module constant every rename and delete
    // read shares; this read is not one.
    expect(incomingLibraryMentionOrder).not.toBe(libraryMentionOrder);
    expect(incomingLibraryMentionOrder).not.toEqual(libraryMentionOrder);
  });
});
