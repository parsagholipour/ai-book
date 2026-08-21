import { LIBRARY_MENTION_LIMIT } from "@book-maker/core";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@book-maker/db", async () => (await import("./testing/mobileApiMocks.js")).dbModuleMock());

import { expandLibraryCharacterGraph, generationDescription } from "./libraryMentionGraph.js";
import { mockPrisma } from "./testing/mobileApiMocks.js";

function row(id: string, name: string, links: string[] = [], description = "") {
  return {
    id,
    userId: "user-a",
    name,
    description,
    appearance: null,
    fields: [],
    photoPath: null,
    photoKind: null,
    suggestedDescription: null,
    portraitPath: null,
    portraitSource: null,
    portraitStatus: "NONE",
    portraitError: null,
    portraitJobId: null,
    createdAt: new Date("2026-08-01T00:00:00.000Z"),
    updatedAt: new Date("2026-08-01T00:00:00.000Z"),
    outgoingMentions: links.map((targetCharacterId, sortOrder) => ({
      sourceCharacterId: id,
      targetKind: "CHARACTER",
      targetId: targetCharacterId,
      targetCharacterId,
      otherType: null,
      sortOrder,
      targetCharacter: { id: targetCharacterId, name: targetCharacterId.toUpperCase() }
    }))
  };
}

/**
 * A row that counts every read of its mention list.
 *
 * Reading that list is the expansion's only work that issues no query, so a
 * query log cannot say it was skipped and the returned graph must not change
 * either way. `libraryMentionCharacterRefs` touches the property exactly once
 * per call, which makes the count the number of times a description's links
 * were walked.
 */
function countingMentions(entry: ReturnType<typeof row>, onRead: () => void): ReturnType<typeof row> {
  const { outgoingMentions } = entry;
  return Object.defineProperty(entry, "outgoingMentions", {
    get() {
      onRead();
      return outgoingMentions;
    }
  });
}

/**
 * A library that answers by id, because that is the only way this is read now.
 * Returns the `where` of every call, so a test can say what was *not* asked.
 */
function library(rows: ReturnType<typeof row>[]): Array<{ id?: { in: string[] }; userId: string }> {
  const queries: Array<{ id?: { in: string[] }; userId: string }> = [];
  mockPrisma.libraryCharacter.findMany.mockImplementation(async ({ where }: { where: any }) => {
    queries.push(where);
    const wanted = where?.id?.in as string[] | undefined;
    return rows.filter((entry) => entry.userId === where.userId && (!wanted || wanted.includes(entry.id)));
  });
  return queries;
}

describe("library character graph expansion", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("keeps explicit roots first, then follows description order breadth-first", async () => {
    const queries = library([
      row("a", "A", ["b", "c"]),
      row("b", "B", ["f"]),
      row("c", "C", ["a"]),
      row("d", "D", ["c", "e"]),
      row("e", "E"),
      row("f", "F")
    ]);

    const graph = await expandLibraryCharacterGraph("user-a", ["d", "a", "d"]);

    expect(graph.characters.map((character) => character.id)).toEqual(["d", "a", "c", "e", "b", "f"]);
    expect(graph.missingIds).toEqual([]);
    // One query per level, each naming only the ids that level had not seen —
    // never the account library. It used to read all 100 rows of it (three
    // queries, through the include) on every message, start and build.
    expect(queries.map((where) => where.id?.in)).toEqual([["d", "a"], ["c", "e", "b"], ["f"]]);
  });

  it("reads nothing beyond the mentioned character when nothing links to it", async () => {
    const queries = library([row("a", "A"), row("b", "B"), row("c", "C")]);

    const graph = await expandLibraryCharacterGraph("user-a", ["a"]);

    expect(graph.characters.map((character) => character.id)).toEqual(["a"]);
    expect(queries).toEqual([{ id: { in: ["a"] }, userId: "user-a" }]);
  });

  it("deduplicates cycles, skips deleted roots, and stops at the default cap", async () => {
    const length = LIBRARY_MENTION_LIMIT + 2;
    const rows = Array.from({ length }, (_, index) => {
      const id = String(index);
      return row(id, `Character ${id}`, index < length - 1 ? [String(index + 1)] : ["0"]);
    });
    library(rows);

    // Ten is what the *default* buys. This used to ask for 99 and assert ten,
    // which pinned the clamp below rather than the cap above it.
    const graph = await expandLibraryCharacterGraph("user-a", ["deleted", "0"]);

    expect(graph.characters.map((character) => character.id)).toEqual(
      Array.from({ length: LIBRARY_MENTION_LIMIT }, (_, index) => String(index))
    );
    // A root the caller named and the library does not hold is reported rather
    // than silently skipped: it is the whole 404 the mention routes send.
    expect(graph.missingIds).toEqual(["deleted"]);
  });

  it("hands back every tapped character when the cast is bigger than the cap", async () => {
    // The cap bounds the expansion, never the roots. Filling it with roots
    // first dropped the eleventh character a branch had tapped, while the
    // turn's system prompt promises the model every selected sheet — and a
    // missing sheet is a book written about a stranger with the same name.
    const tapped = Array.from({ length: 12 }, (_, index) => `tapped-${index}`);
    const queries = library([
      ...tapped.map((id, index) => row(id, `Tapped ${index}`, [`linked-${index}`])),
      ...tapped.map((_, index) => row(`linked-${index}`, `Linked ${index}`))
    ]);

    const graph = await expandLibraryCharacterGraph("user-a", tapped);

    expect(graph.characters.map((character) => character.id)).toEqual(tapped);
    // No room left, so no expansion query at all.
    expect(queries).toHaveLength(1);
  });

  it("walks no mention list once the roots have taken the whole cap", async () => {
    // Ten roots is the boundary the loop already refuses: budget is exactly 0,
    // which buys as little as the negative budget above. Seeding it anyway read
    // every root's links to fill a queue nothing would ever fetch — invisible
    // in the query log, and in the graph, because the candidates it queues are
    // reachable from nowhere else.
    let mentionReads = 0;
    const tapped = Array.from({ length: 10 }, (_, index) => `tapped-${index}`);
    const queries = library([
      ...tapped.map((id, index) =>
        countingMentions(row(id, `Tapped ${index}`, [`linked-${index}`]), () => {
          mentionReads += 1;
        })
      ),
      ...tapped.map((_, index) => row(`linked-${index}`, `Linked ${index}`))
    ]);

    const graph = await expandLibraryCharacterGraph("user-a", tapped);

    expect(graph.characters.map((character) => character.id)).toEqual(tapped);
    expect(queries).toHaveLength(1);
    expect(mentionReads).toBe(0);
  });

  it("walks no mention list once a level has spent the last of the cap", async () => {
    // The same rule as the seeding sweep above, one level down, and it was
    // written in only one of the two places: the loop subtracted the level it
    // had just fetched and then walked every one of its descriptions anyway,
    // pushing up to `LIBRARY_MENTION_LIMIT` ids per character into a queue the
    // `while` was about to stop reading. Nothing says so from the outside — the
    // query log is identical and so is the graph — which is why the guard has
    // to be asserted where the walking happens rather than inferred from the
    // result.
    let levelMentionReads = 0;
    const queries = library([
      row("a", "A", ["x", "y"]),
      ...["x", "y"].map((id) =>
        countingMentions(row(id, id.toUpperCase(), [`${id}-linked`]), () => {
          levelMentionReads += 1;
        })
      ),
      row("x-linked", "X linked"),
      row("y-linked", "Y linked")
    ]);

    // One root against a cap of three leaves exactly the two the root names.
    const graph = await expandLibraryCharacterGraph("user-a", ["a"], 3);

    expect(graph.characters.map((character) => character.id)).toEqual(["a", "x", "y"]);
    expect(queries.map((where) => where.id?.in)).toEqual([["a"], ["x", "y"]]);
    expect(levelMentionReads).toBe(0);
  });

  it("spends what the cap leaves after the roots, in description order", async () => {
    const queries = library([
      row("a", "A", ["a1", "a2"]),
      row("b", "B", ["b1"]),
      row("a1", "A1"),
      row("a2", "A2"),
      row("b1", "B1")
    ]);

    const graph = await expandLibraryCharacterGraph("user-a", ["a", "b"], 3);

    // Two roots against a cap of three buys exactly one linked character, and
    // the level is trimmed before it is fetched rather than after.
    expect(graph.characters.map((character) => character.id)).toEqual(["a", "b", "a1"]);
    expect(queries.map((where) => where.id?.in)).toEqual([["a", "b"], ["a1"]]);
  });

  it("spends a slot a deleted candidate handed back on the next one in line", async () => {
    // Trimming a level to the budget before the fetch is right; marking the
    // whole level seen while doing it is not. A candidate sliced off is
    // reachable from no later level, so a row deleted between the mention read
    // and the fetch returned its slot to a budget nothing could spend, and a
    // cast entitled to ten came back with nine — one linked character the
    // reader's prose names missing from the model's sheet set.
    const roots = Array.from({ length: 8 }, (_, index) => `root-${index}`);
    const queries = library([
      row("root-0", "Root 0", ["c1", "c2", "c3", "c4", "c5"]),
      ...roots.slice(1).map((id, index) => row(id, `Root ${index + 1}`)),
      // c1 is gone: the mention row still names it, the library no longer has it.
      row("c2", "C2"),
      row("c3", "C3"),
      row("c4", "C4"),
      row("c5", "C5")
    ]);

    const graph = await expandLibraryCharacterGraph("user-a", roots);

    expect(graph.characters.map((character) => character.id)).toEqual([...roots, "c2", "c3"]);
    expect(queries.map((where) => where.id?.in)).toEqual([roots, ["c1", "c2"], ["c3"]]);
  });

  it("hands a caller asking past the mention cap what it asked for, never ten", async () => {
    // `limit` is the caller's own total. It used to be clamped to
    // `LIBRARY_MENTION_LIMIT` on the way in, so the one caller that names its
    // own — the build sweep, with `BUILD_CHARACTER_SNAPSHOT_LIMIT` — could only
    // ever narrow the default. The two constants are equal today, so the clamp
    // was invisible: raise the build's and the sweep would still have been
    // handed ten, with the extra sheets missing from the book and nothing at
    // the call site saying the argument had been ignored.
    const linked = Array.from({ length: LIBRARY_MENTION_LIMIT + 4 }, (_, index) => `linked-${index}`);
    const queries = library([row("a", "A", linked), ...linked.map((id) => row(id, id.toUpperCase()))]);

    const wanted = LIBRARY_MENTION_LIMIT + 3;
    const graph = await expandLibraryCharacterGraph("user-a", ["a"], wanted);

    expect(graph.characters).toHaveLength(wanted);
    expect(graph.characters.map((character) => character.id)).toEqual(["a", ...linked.slice(0, wanted - 1)]);
    // And the level is still trimmed before the fetch — to the caller's budget
    // now, rather than to a cap it never named.
    expect(queries.map((where) => where.id?.in)).toEqual([["a"], linked.slice(0, wanted - 1)]);
  });

  it("asks for nothing when nobody was mentioned", async () => {
    const queries = library([row("a", "A")]);

    expect(await expandLibraryCharacterGraph("user-a", [])).toEqual({ characters: [], missingIds: [] });
    expect(queries).toEqual([]);
  });

  it("strips only durable @markers from model-facing descriptions", () => {
    const character = row("a", "A", ["b"], "Travels with @B and @Ghost.");
    character.outgoingMentions[0]!.targetCharacter.name = "B";

    expect(generationDescription(character as never)).toBe("Travels with B and @Ghost.");
  });

  it("does not expand location or other mention targets into the cast", async () => {
    const queries = library([
      {
        ...row("a", "A"),
        outgoingMentions: [
          {
            sourceCharacterId: "a",
            targetKind: "LOCATION",
            targetId: "loc-1",
            targetCharacterId: null,
            otherType: null,
            sortOrder: 0,
            targetCharacter: null
          },
          {
            sourceCharacterId: "a",
            targetKind: "OTHER",
            targetId: "thing-1",
            targetCharacterId: null,
            otherType: "sword",
            sortOrder: 1,
            targetCharacter: null
          },
          {
            sourceCharacterId: "a",
            targetKind: "CHARACTER",
            targetId: "b",
            targetCharacterId: "b",
            otherType: null,
            sortOrder: 2,
            targetCharacter: { id: "b", name: "B" }
          }
        ]
      } as never,
      row("b", "B")
    ]);

    const graph = await expandLibraryCharacterGraph("user-a", ["a"]);

    expect(graph.characters.map((character) => character.id)).toEqual(["a", "b"]);
    expect(queries.map((where) => where.id?.in)).toEqual([["a"], ["b"]]);
  });

  it("does not expand a mention that carries no targetKind at all", async () => {
    // A row with no kind is not a character. Nothing can produce one — the
    // column is `NOT NULL DEFAULT 'CHARACTER'` and `LibraryMentionRow` requires
    // it, which is why this fixture needs the cast — and both readers used to
    // disagree about it anyway: `libraryMentionCharacterRefs` read it as a
    // character, the expansion read it as neither. They agree now, and they
    // agree on the closed answer, because the two mistakes do not cost the
    // same. Refused, a character the prose links to is missing from the cast.
    // Accepted, the same reading takes a LOCATION row whose kind was dropped on
    // the way here: it enters the expansion, a reference sheet is built for it,
    // and the planner is handed a harbour as a person.
    const queries = library([
      {
        ...row("a", "A"),
        outgoingMentions: [
          {
            sourceCharacterId: "a",
            targetId: "b",
            targetCharacterId: "b",
            otherType: null,
            sortOrder: 0,
            targetCharacter: { id: "b", name: "B" }
          }
        ]
      } as never,
      row("b", "B")
    ]);

    const graph = await expandLibraryCharacterGraph("user-a", ["a"]);

    expect(graph.characters.map((character) => character.id)).toEqual(["a"]);
    expect(queries.map((where) => where.id?.in)).toEqual([["a"]]);
  });

});
