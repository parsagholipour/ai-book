import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@book-maker/db", async () => (await import("./testing/mobileApiMocks.js")).dbModuleMock());

import {
  expandLibraryCharacterGraph,
  generationDescription,
  orderedCharacterRefs
} from "./characterMentions.js";
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
      targetCharacterId,
      sortOrder,
      targetCharacter: { id: targetCharacterId, name: targetCharacterId.toUpperCase() }
    }))
  };
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

  it("deduplicates cycles, skips deleted roots, and stops at ten", async () => {
    const rows = Array.from({ length: 12 }, (_, index) => {
      const id = String(index);
      return row(id, `Character ${id}`, index < 11 ? [String(index + 1)] : ["0"]);
    });
    library(rows);

    const graph = await expandLibraryCharacterGraph("user-a", ["deleted", "0"], 99);

    expect(graph.characters.map((character) => character.id)).toEqual(
      Array.from({ length: 10 }, (_, index) => String(index))
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

  it("restores explicit order after an unordered ownership query", () => {
    expect(orderedCharacterRefs(["b", "a"], [{ id: "a", name: "A" }, { id: "b", name: "B" }])).toEqual([
      { id: "b", name: "B" },
      { id: "a", name: "A" }
    ]);
  });
});
