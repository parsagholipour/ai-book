import { describe, expect, it, vi } from "vitest";

vi.mock("@book-maker/db", async () => (await import("./testing/mobileApiMocks.js")).dbModuleMock());

import {
  libraryMentionRefs,
  orderedCharacterRefs,
  survivingMentionIds,
  uniqueIds
} from "./libraryMentionRows.js";
import { libraryMentionNames } from "@book-maker/db/libraryMentions";

/**
 * One stored mention row, as each side of the API reads it.
 *
 * Split out of `libraryMentionLinks.test.ts`, which is the suite about the
 * *write* that puts these rows there — the kinds it clears, the batch it
 * emits — and its sibling `libraryMentionRewrites.test.ts`, which is the claim
 * and the round trips it costs. Nothing here touches a client or a
 * transaction: these are the two readings of a row that is already stored, and
 * the whole hazard is that they must agree with each other and with the write.
 */

function libraryMentionWrite(targetId: string, sortOrder: number) {
  return {
    sourceCharacterId: "char-1",
    targetKind: "CHARACTER" as const,
    targetId,
    targetCharacterId: targetId,
    otherType: null,
    sortOrder
  };
}

/**
 * One source's stored links, as `libraryMentionInclude` hands them over.
 *
 * A LOCATION entry is built the way the arc CHECK forces one — `targetId` and
 * no join at all — because that is the row every reader here has to decide
 * about, and the deciding is on the kind.
 */
function linkedTo(targets: ReadonlyArray<{ id: string; name?: string; kind?: "CHARACTER" | "LOCATION" }>) {
  return {
    outgoingMentions: targets.map(({ id, name, kind }, sortOrder) =>
      kind === "LOCATION"
        ? { ...libraryMentionWrite(id, sortOrder), targetKind: "LOCATION" as const, targetCharacterId: null, targetCharacter: null }
        : { ...libraryMentionWrite(id, sortOrder), targetCharacter: { id, name: name ?? id } }
    )
  };
}

/**
 * The wire reading: one row at a time, so the name and the kind that answered
 * for it cannot come off different rows.
 */
describe("libraryMentionRefs", () => {
  it("takes kind and subtype off the row, and withholds a row nothing can name", () => {
    // Both fixtures are rows the arc CHECK refuses, on purpose: a column only
    // differs from a literal that always agrees with it on a row they disagree
    // about. The location keeps a character join and is withheld anyway.
    const bram = { ...libraryMentionWrite("char-2", 0), targetCharacter: { id: "char-2", name: "Bram" } };
    const thornwood = { ...bram, targetKind: "LOCATION" as const, targetId: "loc-1", sortOrder: 1 };
    expect(
      libraryMentionRefs({ outgoingMentions: [{ ...bram, otherType: "sword" }, thornwood] })
    ).toEqual([{ id: "char-2", name: "Bram", kind: "character", otherType: "sword" }]);
  });

  it("names a row with the same rule the scan set does, because there is only one", () => {
    // The wire DTO calls `libraryMentionTargetName` directly now; it used to
    // reach the same function by wrapping each row in a one-element
    // `{ outgoingMentions: [mention] }` for `libraryMentionNames` to take apart
    // again — one object and two arrays per row, over the reader's whole
    // library on `GET /api/mobile/characters`. What the wrapper was buying is
    // this equality, and it is the thing that must not change: the app locates
    // a mention's span *by* the name it is given, so a second spelling of the
    // rule is a highlight over prose the model was handed differently.
    const outgoingMentions = [
      { ...libraryMentionWrite("char-2", 0), targetCharacter: { id: "char-2", name: "Bram" } },
      {
        ...libraryMentionWrite("loc-1", 1),
        targetKind: "LOCATION" as const,
        targetCharacterId: null,
        targetCharacter: null
      }
    ];

    expect(libraryMentionRefs({ outgoingMentions }).map(({ id, name }) => ({ id, name }))).toEqual(
      libraryMentionNames({ outgoingMentions })
    );
  });

  it("refuses a row whose join a narrow select dropped, and withholds one that arrives anyway", () => {
    // The other half of "a row nothing can name", and the only half a caller
    // here can produce: not a LOCATION row, which has no table to join to yet,
    // but a CHARACTER row read through a `select` that carried `targetKind`
    // and left the join behind. The parameter is `libraryMentionInclude`'s own
    // payload, so that row does not compile — which is the whole reason the
    // parameter is the payload rather than a hand-written row shape, and the
    // directive fails the build the day it widens back into one.
    const withoutJoin: Parameters<typeof libraryMentionRefs>[0] = {
      // @ts-expect-error a row read without the include's join carries no `targetCharacter`.
      outgoingMentions: [libraryMentionWrite("char-2", 0)]
    };

    // Past the type — a fixture, a row rebuilt from JSON, an arc relaxed to
    // allow a CHARACTER row with no target — the rule that answers is
    // nameability and not kind, so this row is withheld exactly as a LOCATION
    // one is. Never shipped with an empty `name`: the app locates a mention's
    // span *by* the name it is given, so an unnamed link would highlight
    // nothing and hand the next save a link it cannot find in the prose, and
    // `survivingMentionIds` drops the same row for the same reason — the one
    // candidate set the write, the rename and the delete all bind.
    expect(libraryMentionRefs(withoutJoin)).toEqual([]);
    expect(survivingMentionIds("Still knows @Bram.", withoutJoin)).toEqual([]);
  });

  it("refuses a character read without the include, at compile time", () => {
    // The parameter was `Partial<…>` with a `?? []` behind it, so a row fetched
    // without `libraryMentionInclude` answered "no links" — and nothing here
    // treats that as degraded. `serializeLibraryCharacter` ships this array as
    // the state the editor sheet seeds from and PATCHes back, so an empty one
    // is a PATCH whose `mentionedCharacterIds` is empty, and the `deleteMany`
    // behind that takes every CHARACTER row the source owns while the `@Name`
    // tokens stay in the prose with nothing behind them. The same door on the
    // server's side is `survivingMentionIds`, which requires the include on its
    // own parameter. `serializeLibraryCharacter`'s own
    // `Pick` was tightened against exactly that; this is the same door one
    // level down, and the directive fails the build the day it reopens.
    // Written against the parameter itself, and `{}` rather than a row missing
    // one field, so the directive is a two-way pin: the day the type goes back
    // to `Partial<…>` this becomes assignable, the directive goes unused, and
    // the build fails on *that* instead.
    // @ts-expect-error a row read without `libraryMentionInclude` carries no `outgoingMentions`.
    const withoutInclude: Parameters<typeof libraryMentionRefs>[0] = {};

    // Loud rather than empty. What the `?? []` did with this row was answer
    // "no links" to the reader of a complete link set.
    expect(() => libraryMentionRefs(withoutInclude)).toThrow(TypeError);
  });
});

/**
 * The set an old client's prose-only PATCH keeps, which is a *cast* question
 * asked of rows that are not all cast.
 */
describe("survivingMentionIds", () => {
  it("reads the rows through the cast filter, and refuses the wire list at compile time", () => {
    const source = linkedTo([
      { id: "char-2", name: "Bram" },
      { id: "loc-1", kind: "LOCATION" }
    ]);

    expect(survivingMentionIds("Still knows @Bram.", source)).toEqual(["char-2"]);

    // The route used to pass `libraryMentionRefs(live)` here — the wire list,
    // which is every kind the rows hold — while the result goes on to
    // `replaceLibraryMentions`, which takes character ids alone. The two agree
    // only while CHARACTER is the only kind `libraryMentionTargetName` can name,
    // so the runtime assertion above cannot tell them apart today and this is
    // what does: there is no list parameter left to hand the wrong reading to.
    // Written against the parameter itself, so the directive is a two-way pin —
    // the day the signature takes a mention list again it becomes assignable,
    // goes unused, and the build fails on *that* instead.
    // @ts-expect-error the surviving set is derived from the rows, not from a serialized list.
    const wire: Parameters<typeof survivingMentionIds>[1] = libraryMentionRefs(source);
    expect(wire).toEqual([{ id: "char-2", name: "Bram", kind: "character", otherType: null }]);
  });
});

/**
 * The two id helpers every lane shares.
 *
 * They were declared beside the graph walk, which opens a Prisma client at
 * import, so `libraryMentionLinks.ts` reaching for two array functions pulled
 * that client and the whole walk into the write lanes' import graph. They are
 * measured here because this is the module they belong to: pure readings that
 * touch no client.
 */
describe("the id helpers the mention lanes share", () => {
  it("restores explicit order after an unordered ownership query", () => {
    expect(
      orderedCharacterRefs(["b", "a"], [
        { id: "a", name: "A" },
        { id: "b", name: "B" }
      ])
    ).toEqual([
      { id: "b", name: "B" },
      { id: "a", name: "A" }
    ]);
  });

  it("drops an id the read did not answer for rather than inventing a name", () => {
    // A character deleted between the request and the query. The caller's next
    // move is to put these names in front of a model, so a placeholder is the
    // one answer that cannot be given.
    expect(orderedCharacterRefs(["a", "gone"], [{ id: "a", name: "A" }])).toEqual([{ id: "a", name: "A" }]);
  });

  it("dedupes ids in the order they first arrive", () => {
    // The cap both lanes count against: the link write's cast limit and the
    // graph's expansion budget are the same "ten characters" only while this is
    // one function.
    expect(uniqueIds(["b", "a", "b", "c", "a"])).toEqual(["b", "a", "c"]);
  });
});
