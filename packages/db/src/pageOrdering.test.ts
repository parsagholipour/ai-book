import { describe, expect, it, vi } from "vitest";
import {
  bookPdfCoverNumbering,
  pageIndexMovesForStructuralPlan,
  parseStoredBookPdfNumbering,
  parseStoredBookPdfPageMap,
  printedPageOffset,
  resolveStructuralPageEdit,
  type ExistingPage,
  type StructuralPageEdit
} from "@book-maker/core";
import {
  applyPageOrder,
  deletePageContinuityNotes,
  discardLegacyPageContinuityNotes,
  EMBEDDING_REPOINT_PARK_PREFIX,
  landedPageScopeSql,
  pageContinuityNoteRepointStatements,
  pageEmbeddingRepointCollisionQuery,
  PageEmbeddingRepointCollisionError,
  pageEmbeddingRepointPasses,
  pageOrderStatements,
  pageShiftStatements,
  repointedPageMapUpdate,
  repointPageEmbeddings,
  shiftPageIndexes,
  type PageEmbeddingRepointCollision,
  type PageOrderEntry,
  type PageOrderingStatement,
  type RawExecutor
} from "./pageOrdering.ts";

type Row = { id: string; index: number };

/**
 * Applies the two statement shapes this module emits, the way Postgres would,
 * and refuses any state the `@@unique([projectId, index])` index would refuse.
 *
 * The whole point of the two-pass negate is that no *intermediate* state has a
 * duplicate index, so checking only the final order would pass a version that
 * raises 23505 in production. The uniqueness check therefore runs after every
 * statement.
 */
function runStatements(rows: Row[], statements: readonly PageOrderingStatement[]): Row[] {
  let current = rows.map((row) => ({ ...row }));
  for (const statement of statements) {
    if (statement.sql.includes("FROM (VALUES")) {
      const targets = new Map<string, number>();
      for (let offset = 1; offset < statement.params.length; offset += 2) {
        targets.set(String(statement.params[offset]), Number(statement.params[offset + 1]));
      }
      current = current.map((row) => (targets.has(row.id) ? { ...row, index: -targets.get(row.id)! } : row));
    } else if (statement.sql.includes('"index" = -"index" + $2')) {
      const delta = Number(statement.params[1]);
      current = current.map((row) => (row.index < 0 ? { ...row, index: -row.index + delta } : row));
    } else if (statement.sql.includes('"index" > $2')) {
      const afterIndex = Number(statement.params[1]);
      current = current.map((row) => (row.index > afterIndex ? { ...row, index: -row.index } : row));
    } else {
      current = current.map((row) => (row.index < 0 ? { ...row, index: -row.index } : row));
    }
    const indexes = current.map((row) => row.index);
    expect(new Set(indexes).size, `duplicate index after: ${statement.sql}`).toBe(indexes.length);
  }
  return [...current].sort((a, b) => a.index - b.index);
}

const book = (count: number): Row[] =>
  Array.from({ length: count }, (_value, offset) => ({ id: `page-${offset + 1}`, index: offset + 1 }));

const order = (rows: Row[]): number[] => rows.map((row) => row.index);
const ids = (rows: Row[]): string[] => rows.map((row) => row.id);

describe("shifting page indexes for an insert", () => {
  it("opens a gap in the middle without ever colliding", () => {
    const shifted = runStatements(book(8), pageShiftStatements("project-1", 3, 2));

    // 1-3 stay; 4-8 become 6-10, leaving 4 and 5 free for the new pages.
    expect(order(shifted)).toEqual([1, 2, 3, 6, 7, 8, 9, 10]);
    expect(ids(shifted)).toEqual([
      "page-1",
      "page-2",
      "page-3",
      "page-4",
      "page-5",
      "page-6",
      "page-7",
      "page-8"
    ]);
  });

  it("opens a gap at the very head of the book", () => {
    expect(order(runStatements(book(4), pageShiftStatements("project-1", 0, 1)))).toEqual([2, 3, 4, 5]);
  });

  it("opens a gap before the last page", () => {
    expect(order(runStatements(book(4), pageShiftStatements("project-1", 3, 1)))).toEqual([1, 2, 3, 5]);
  });

  it("touches nothing when the anchor is the last page", () => {
    expect(order(runStatements(book(4), pageShiftStatements("project-1", 4, 3)))).toEqual([1, 2, 3, 4]);
  });
});

describe("shifting page indexes for a delete", () => {
  it("closes the gap the deleted pages left", () => {
    // The rows are already gone: pass two lands survivors on indexes the
    // deleted pages held, so one still sitting there would collide.
    const survivors = book(8).filter((row) => row.index !== 4 && row.index !== 5);

    expect(order(runStatements(survivors, pageShiftStatements("project-1", 5, -2)))).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it("closes a gap left by the first page", () => {
    const survivors = book(4).filter((row) => row.index !== 1);

    expect(order(runStatements(survivors, pageShiftStatements("project-1", 1, -1)))).toEqual([1, 2, 3]);
  });
});

describe("rewriting the whole page order", () => {
  it("moves one page backwards and renumbers everything around it", () => {
    // "Move page 5 to after page 1": 1, 5, 2, 3, 4, 6.
    const target: PageOrderEntry[] = [
      { pageId: "page-1", index: 1 },
      { pageId: "page-5", index: 2 },
      { pageId: "page-2", index: 3 },
      { pageId: "page-3", index: 4 },
      { pageId: "page-4", index: 5 },
      { pageId: "page-6", index: 6 }
    ];
    const moved = runStatements(book(6), pageOrderStatements("project-1", target));

    expect(ids(moved)).toEqual(["page-1", "page-5", "page-2", "page-3", "page-4", "page-6"]);
    expect(order(moved)).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it("moves one page forwards", () => {
    const target: PageOrderEntry[] = [
      { pageId: "page-1", index: 1 },
      { pageId: "page-3", index: 2 },
      { pageId: "page-4", index: 3 },
      { pageId: "page-2", index: 4 }
    ];
    const moved = runStatements(book(4), pageOrderStatements("project-1", target));

    expect(ids(moved)).toEqual(["page-1", "page-3", "page-4", "page-2"]);
  });

  it("reverses a whole book, which is the worst case for collisions", () => {
    const target = book(6).map((row, offset) => ({ pageId: row.id, index: 6 - offset }));
    const reversed = runStatements(book(6), pageOrderStatements("project-1", target));

    expect(ids(reversed)).toEqual(["page-6", "page-5", "page-4", "page-3", "page-2", "page-1"]);
  });

  it("emits nothing for an empty order rather than a statement that matches every row", () => {
    expect(pageOrderStatements("project-1", [])).toEqual([]);
  });
});

type ScopeRow = { sourceId: string | null; scope: string };

/**
 * `landedPageScopeSql` as JavaScript: the scope a row holds once pass two has
 * run. Identity on anything that is not parked, exactly as the anchored
 * `regexp_replace` is, which is what lets the probe compare a live row and a
 * parked one with one expression.
 */
const PARKED_SCOPE_PATTERN = new RegExp(`^${EMBEDDING_REPOINT_PARK_PREFIX}([0-9]+):`);

const landedScope = (scope: string): string => {
  const parked = PARKED_SCOPE_PATTERN.exec(scope);
  return parked ? `page:${parked[1]}` : scope;
};

/** What one emitted statement writes, read out of its own SQL and parameters. */
function applyScopeStatement(rows: readonly ScopeRow[], statement: PageOrderingStatement): ScopeRow[] {
  if (statement.sql.includes("FROM (VALUES")) {
    const written = /SET "scope" = '([^']*)' \|\| v\.idx::text \|\| ':' \|\| e\."scope"/.exec(statement.sql)?.[1];
    expect(written, `no recognisable SET in: ${statement.sql}`).toBeTypeOf("string");
    const targets = new Map<string, number>();
    for (let offset = 1; offset < statement.params.length; offset += 2) {
      targets.set(String(statement.params[offset]), Number(statement.params[offset + 1]));
    }
    return rows.map((row) =>
      row.sourceId !== null && targets.has(row.sourceId) && row.scope.startsWith("page:")
        ? { ...row, scope: `${written!}${targets.get(row.sourceId)!}:${row.scope}` }
        : { ...row }
    );
  }
  // Pass two is checked against the exported fragment rather than parsed out of
  // the SQL, because the fragment is the thing the probe shares: a pass two
  // that spelled its own `regexp_replace` would be the drift this asserts away,
  // and modelling it here would hide that.
  expect(statement.sql, `no recognisable SET in: ${statement.sql}`).toContain(landedPageScopeSql('"scope"'));
  return rows.map((row) => ({ ...row, scope: landedScope(row.scope) }));
}

/**
 * Applies the scope statements this module emits, the way Postgres would, and
 * refuses any state the `@@unique([projectId, scope])` index would refuse.
 *
 * The `SET` expression is read out of the SQL rather than assumed, so a version
 * that collapses back to one statement is executed as the one statement it is,
 * rather than as the two-pass shape the caller hoped for.
 *
 * The check that matters is *per statement*, not on the final scopes: a plain
 * unique index is verified as each row is written, and nothing pins the order
 * a statement writes its rows in. So a statement is safe only when every value
 * it writes is free of every **other** row's value at the moment the statement
 * begins — one that lands on a value another row still holds raises `23505` the
 * moment the two are visited in the wrong order, which is exactly what the
 * single statement this re-point used to be did. Checking only the end state
 * would pass that version, because its end state is perfectly unique.
 */
function runScopeStatements(rows: readonly ScopeRow[], statements: readonly PageOrderingStatement[]): ScopeRow[] {
  let current = rows.map((row) => ({ ...row }));
  for (const statement of statements) {
    const before = current.map((row) => row.scope);
    const next = applyScopeStatement(current, statement);
    next.forEach((row, offset) => {
      if (row.scope === before[offset]) {
        return;
      }
      const held = before.findIndex((scope, other) => other !== offset && scope === row.scope);
      expect(held, `writing "${row.scope}" while row ${held} still holds it, in: ${statement.sql}`).toBe(-1);
    });
    current = next;
    const scopes = current.map((row) => row.scope);
    expect(new Set(scopes).size, `duplicate scope after: ${statement.sql}`).toBe(scopes.length);
  }
  return current;
}

/**
 * Both passes as the list this model runs, which is deliberately *not* what
 * {@link pageEmbeddingRepointPasses} hands back. The pair is named rather than
 * ordered because an array of statements is exactly what
 * `runPageOrderingStatements` takes, so park-then-land with no probe between
 * them can no longer be spelled by passing one builder's result along.
 */
const repointPasses = (projectId: string, entries: readonly PageOrderEntry[]): PageOrderingStatement[] => {
  const passes = pageEmbeddingRepointPasses(projectId, entries);
  return passes ? [passes.park, passes.land] : [];
};

/** One `page:<index>` embedding per page, the way `storeEmbedding` writes them. */
const pageScopes = (count: number): ScopeRow[] =>
  Array.from({ length: count }, (_value, offset) => ({
    sourceId: `page-${offset + 1}`,
    scope: `page:${offset + 1}`
  }));

const scopeOf = (rows: readonly ScopeRow[], sourceId: string): string | undefined =>
  rows.find((row) => row.sourceId === sourceId)?.scope;

describe("re-pointing semantic memory at moved pages", () => {
  it("keys on the page id and leaves other scopes alone", () => {
    const passes = pageEmbeddingRepointPasses("project-1", [
      { pageId: "page-4", index: 6 },
      { pageId: "page-5", index: 7 }
    ]);

    // The id survives a renumber; the index parsed out of the scope string is
    // the very thing that just became wrong.
    expect(passes?.park.params).toEqual(["project-1", "page-4", 6, "page-5", 7]);
    expect(passes?.park.sql).toContain(`"scope" LIKE 'page:%'`);
    expect(passes?.park.sql).toContain('e."projectId" = $1');
  });

  it("parks and then lands, because the scope index is not deferrable either", () => {
    const passes = pageEmbeddingRepointPasses("project-1", [{ pageId: "page-4", index: 5 }]);

    // Two statements, not one. `@@unique([projectId, scope])` is a plain unique
    // index, so a single overlapping UPDATE raises 23505 mid-statement and takes
    // the whole restructure transaction — and every page insert, delete, move
    // and Undo — down with it. They are a named pair rather than an array,
    // because an array is what `runPageOrderingStatements` takes.
    expect(passes?.park.sql).toContain(
      `SET "scope" = '${EMBEDDING_REPOINT_PARK_PREFIX}' || v.idx::text || ':' || e."scope"`
    );
    // Pass two is unconditional over the project rather than a second join, so
    // it cannot leave a parked row behind, and it is still scoped to one book.
    expect(passes?.land.params).toEqual(["project-1"]);
    expect(passes?.land.sql).toContain('"projectId" = $1');
    expect(passes?.land.sql).toContain(`"scope" LIKE '${EMBEDDING_REPOINT_PARK_PREFIX}%'`);
  });

  it("parks one page's two page scopes apart, because a page id names more than one", () => {
    // `sourceId -> page:%` is one-to-many — `deletePageEmbeddings` matches it
    // with `startsWith` for that reason. `repairPageEmbeddings` resolves the
    // page at an index and only then spends a provider call, so an edit
    // committing inside that window has it insert `page:4` for a page that by
    // now holds `page:6`; a page job lagging in BullMQ backoff writes its stale
    // index the same way. Keyed on the destination alone, one statement set
    // both of those rows to one `page-repoint:9`: `23505` from pass one, which
    // is the failure the split exists to prevent.
    const rows: ScopeRow[] = [
      { sourceId: "page-4", scope: "page:4" },
      { sourceId: "page-4", scope: "page:6" },
      { sourceId: "page-5", scope: "page:5" }
    ];
    const passes = pageEmbeddingRepointPasses("project-1", [{ pageId: "page-4", index: 9 }]);

    // Pass one alone: pass two is where those two rows genuinely meet, and the
    // probe between the passes is what answers for that.
    const parked = runScopeStatements(rows, [passes!.park]);

    expect(parked.map((row) => row.scope)).toEqual([
      `${EMBEDDING_REPOINT_PARK_PREFIX}9:page:4`,
      `${EMBEDDING_REPOINT_PARK_PREFIX}9:page:6`,
      "page:5"
    ]);
  });

  it("parks outside every filter that reads a page scope", () => {
    // `page:-4` would be the literal analogue of the negative half `Page.index`
    // parks in, and it is the wrong answer: `LIKE 'page:%'` and Prisma's
    // `startsWith: "page:"` both match it, so retrieval, repair and the
    // whole-book wipes would all read a parked row as a live page.
    const parked = `${EMBEDDING_REPOINT_PARK_PREFIX}4:page:2`;

    expect(parked.startsWith("page:")).toBe(false);
    expect(parked).not.toMatch(/^page:/);
  });

  it("shifts every scope up by one without ever colliding", () => {
    // One page inserted after page 3 of a ten-page book: the tail moves to
    // 5..11, so page:4 is written to 'page:5' while the row holding 'page:5' is
    // still live. This is the case that failed every structural page edit.
    const rows: ScopeRow[] = [
      ...pageScopes(10),
      { sourceId: "source-1", scope: "research:source-1" },
      { sourceId: null, scope: "chapter:1" }
    ];
    const order: PageOrderEntry[] = Array.from({ length: 7 }, (_value, offset) => ({
      pageId: `page-${offset + 4}`,
      index: offset + 5
    }));

    const moved = runScopeStatements(rows, repointPasses("project-1", order));

    expect(scopeOf(moved, "page-4")).toBe("page:5");
    expect(scopeOf(moved, "page-10")).toBe("page:11");
    // The head of the book is not named by an insert's order and keeps its own
    // numbers; nothing outside `page:%` is touched at all.
    expect(scopeOf(moved, "page-1")).toBe("page:1");
    expect(scopeOf(moved, "page-3")).toBe("page:3");
    expect(scopeOf(moved, "source-1")).toBe("research:source-1");
    expect(moved.some((row) => row.scope === "chapter:1")).toBe(true);
    expect(moved.every((row) => !row.scope.startsWith(EMBEDDING_REPOINT_PARK_PREFIX))).toBe(true);
  });

  it("closes a delete's gap, which shifts the other way", () => {
    // Page 4 of eight is gone and `deletePageEmbeddings` took its row first, so
    // 5..8 come down onto 4..7 — 'page:5' lands on the live 'page:4'... except
    // that row is already gone, and 'page:6' lands on the row this statement is
    // still holding at 'page:5'.
    const rows = pageScopes(8).filter((row) => row.sourceId !== "page-4");
    const order: PageOrderEntry[] = [
      { pageId: "page-1", index: 1 },
      { pageId: "page-2", index: 2 },
      { pageId: "page-3", index: 3 },
      { pageId: "page-5", index: 4 },
      { pageId: "page-6", index: 5 },
      { pageId: "page-7", index: 6 },
      { pageId: "page-8", index: 7 }
    ];

    const moved = runScopeStatements(rows, repointPasses("project-1", order));

    expect(moved.map((row) => row.scope)).toEqual([
      "page:1",
      "page:2",
      "page:3",
      "page:4",
      "page:5",
      "page:6",
      "page:7"
    ]);
  });

  it("reverses a whole book, which is the worst case for collisions", () => {
    const order: PageOrderEntry[] = Array.from({ length: 6 }, (_value, offset) => ({
      pageId: `page-${offset + 1}`,
      index: 6 - offset
    }));

    const moved = runScopeStatements(pageScopes(6), repointPasses("project-1", order));

    expect(moved.map((row) => row.scope)).toEqual(["page:6", "page:5", "page:4", "page:3", "page:2", "page:1"]);
  });

  it("emits nothing for an empty order", () => {
    expect(pageEmbeddingRepointPasses("project-1", [])).toBeNull();
  });
});

/**
 * An `Embedding` table one statement at a time, refusing exactly what
 * `@@unique([projectId, scope])` refuses and answering the collision probe out
 * of the same rows.
 *
 * The refusal is what makes the guard's test mean something: with the check
 * taken out, the partial order below reaches pass two and this stand-in raises
 * the `23505` Postgres would, so the case fails either way — but only one of
 * the two failures is a diagnosis.
 */
function scopeExecutor(rows: readonly ScopeRow[]) {
  let state = rows.map((row) => ({ ...row }));
  const collisions = () =>
    state.flatMap((parked) => {
      if (!parked.scope.startsWith(EMBEDDING_REPOINT_PARK_PREFIX)) {
        return [];
      }
      // The probe's own question, in the probe's own terms: not "is the live
      // scope taken" but "does any other row of this project land where this
      // one does" — which is one comparison for a live `page:5` and for a
      // second parked row of the same page.
      const landing = landedScope(parked.scope);
      return state
        .filter((other) => other !== parked && landedScope(other.scope) === landing)
        .map((other) => ({
          parkedScope: parked.scope,
          landingScope: landing,
          heldScope: other.scope,
          heldSourceId: other.sourceId
        }));
    });
  return {
    scopeOf: (sourceId: string) => state.find((row) => row.sourceId === sourceId)?.scope,
    $executeRawUnsafe: async (sql: string, ...params: unknown[]) => {
      const before = state.map((row) => row.scope);
      const next = applyScopeStatement(state, { sql, params });
      next.forEach((row, offset) => {
        if (row.scope === before[offset]) {
          return;
        }
        if (before.some((scope, other) => other !== offset && scope === row.scope)) {
          throw new Error(`duplicate key value violates unique constraint "Embedding_projectId_scope_key"`);
        }
      });
      state = next;
      return next.length;
    },
    $queryRawUnsafe: async <T,>(_sql: string, ..._params: unknown[]): Promise<T> => collisions() as T
  };
}

/**
 * The statements and the probe in the order they reached the database, for the
 * cases about *when* the check runs rather than what it finds.
 *
 * `regexp_replace` is what tells the two statements apart: pass one writes the
 * parking prefix, pass two is the one that rewrites it away.
 */
function repointTrace(collisions: readonly PageEmbeddingRepointCollision[]) {
  const steps: string[] = [];
  return {
    steps,
    $executeRawUnsafe: async (sql: string, ..._params: unknown[]) => {
      steps.push(sql.includes("regexp_replace") ? "land" : "park");
      return 0;
    },
    $queryRawUnsafe: async <T,>(_sql: string, ..._params: unknown[]): Promise<T> => {
      steps.push("probe");
      return collisions as T;
    }
  };
}

describe("guarding a re-point ordering that does not name every page it lands on", () => {
  it("names the ordering rather than letting pass two raise 23505", async () => {
    // A single-entry order on a book where page 5 is still page 5: pass one
    // parks page-4's row at the destination, and pass two would write it onto
    // the live 'page:5' — the collision the two passes exist to prevent, from
    // inside a transaction that has already renumbered the book.
    const executor = scopeExecutor(pageScopes(6));

    await expect(repointPageEmbeddings(executor, "project-1", [{ pageId: "page-4", index: 5 }])).rejects.toThrow(
      PageEmbeddingRepointCollisionError
    );
  });

  it("carries the scopes that prove it, and the page still holding the destination", async () => {
    const executor = scopeExecutor(pageScopes(6));
    const failure = await repointPageEmbeddings(executor, "project-1", [{ pageId: "page-4", index: 5 }]).catch(
      (error: unknown) => error
    );

    expect(failure).toBeInstanceOf(PageEmbeddingRepointCollisionError);
    expect((failure as PageEmbeddingRepointCollisionError).collisions).toEqual([
      {
        parkedScope: `${EMBEDDING_REPOINT_PARK_PREFIX}5:page:4`,
        landingScope: "page:5",
        heldScope: "page:5",
        heldSourceId: "page-5"
      }
    ]);
    expect((failure as PageEmbeddingRepointCollisionError).message).toContain("page:5");
  });

  it("names a page holding two page scopes, which no ordering can repair", async () => {
    // The other half of the same question, and the one pass one used to raise
    // `23505` over on its own: a repair that landed `page:4` for a page already
    // holding `page:6` leaves both rows keyed on one `sourceId`, and a re-point
    // to 9 would have to make both of them `page:9`. Pass one now parks them
    // apart, so what answers is the probe rather than the constraint.
    const executor = scopeExecutor([
      { sourceId: "page-4", scope: "page:4" },
      { sourceId: "page-4", scope: "page:6" }
    ]);
    const failure = await repointPageEmbeddings(executor, "project-1", [{ pageId: "page-4", index: 9 }]).catch(
      (error: unknown) => error
    );

    expect(failure).toBeInstanceOf(PageEmbeddingRepointCollisionError);
    expect((failure as PageEmbeddingRepointCollisionError).collisions).toEqual([
      {
        parkedScope: `${EMBEDDING_REPOINT_PARK_PREFIX}9:page:4`,
        landingScope: "page:9",
        heldScope: `${EMBEDDING_REPOINT_PARK_PREFIX}9:page:6`,
        heldSourceId: "page-4"
      },
      {
        parkedScope: `${EMBEDDING_REPOINT_PARK_PREFIX}9:page:6`,
        landingScope: "page:9",
        heldScope: `${EMBEDDING_REPOINT_PARK_PREFIX}9:page:4`,
        heldSourceId: "page-4"
      }
    ]);
  });

  it("also catches a row whose page is long gone, which no ordering can name", async () => {
    // `Embedding` has no foreign key to `Page`, so a book edited on a build
    // that predates `deletePageEmbeddings` can hold a `page:%` row belonging to
    // nothing. Pass one keys on `sourceId` and cannot park it.
    const rows: ScopeRow[] = [...pageScopes(3), { sourceId: "page-gone", scope: "page:4" }];
    const executor = scopeExecutor(rows);
    const order: PageOrderEntry[] = [
      { pageId: "page-1", index: 1 },
      { pageId: "page-2", index: 2 },
      { pageId: "page-3", index: 4 }
    ];

    await expect(repointPageEmbeddings(executor, "project-1", order)).rejects.toThrow(
      PageEmbeddingRepointCollisionError
    );
  });

  it("lets the same partial order through when nothing holds the destination", async () => {
    // The precondition is about the rows, not about the order's length: page 5
    // is gone from memory, so there is nothing for the parked row to land on.
    const executor = scopeExecutor(pageScopes(6).filter((row) => row.sourceId !== "page-5"));

    await repointPageEmbeddings(executor, "project-1", [{ pageId: "page-4", index: 5 }]);

    expect(executor.scopeOf("page-4")).toBe("page:5");
  });

  it("lets an insert's tail-only ordering through, which is the caller that is partial", async () => {
    // `movedPageOrder` names only the pages an insert shifted. Their
    // destinations all sit past the head it leaves out, so the head holds none
    // of them — that is what makes a partial ordering legal here.
    const executor = scopeExecutor(pageScopes(10));
    const order: PageOrderEntry[] = Array.from({ length: 7 }, (_value, offset) => ({
      pageId: `page-${offset + 4}`,
      index: offset + 5
    }));

    await repointPageEmbeddings(executor, "project-1", order);

    expect(executor.scopeOf("page-1")).toBe("page:1");
    expect(executor.scopeOf("page-4")).toBe("page:5");
    expect(executor.scopeOf("page-10")).toBe("page:11");
  });

  it("lets a whole-book permutation through, which is every other caller", async () => {
    const executor = scopeExecutor(pageScopes(6));
    const order: PageOrderEntry[] = Array.from({ length: 6 }, (_value, offset) => ({
      pageId: `page-${offset + 1}`,
      index: 6 - offset
    }));

    await repointPageEmbeddings(executor, "project-1", order);

    expect(executor.scopeOf("page-1")).toBe("page:6");
    expect(executor.scopeOf("page-6")).toBe("page:1");
  });

  it("emits no statements at all for an empty order", async () => {
    const executor = scopeExecutor(pageScopes(2));
    const executed = vi.spyOn(executor, "$executeRawUnsafe");

    await repointPageEmbeddings(executor, "project-1", []);

    expect(executed).not.toHaveBeenCalled();
  });

  it("probes between the two passes on every re-point, not only the ones that collide", async () => {
    const executor = repointTrace([]);

    await repointPageEmbeddings(executor, "project-1", [{ pageId: "page-4", index: 5 }]);

    // Not park-then-land with a check somewhere near it: the probe is a step of
    // the re-point, and after pass one is the only place it can be exact.
    expect(executor.steps).toEqual(["park", "probe", "land"]);
  });

  it("stops at the probe that answers, so the statement it guards never runs", async () => {
    const executor = repointTrace([
      {
        parkedScope: `${EMBEDDING_REPOINT_PARK_PREFIX}5:page:4`,
        landingScope: "page:5",
        heldScope: "page:5",
        heldSourceId: "page-5"
      }
    ]);

    await expect(repointPageEmbeddings(executor, "project-1", [{ pageId: "page-4", index: 5 }])).rejects.toThrow(
      PageEmbeddingRepointCollisionError
    );

    expect(executor.steps).toEqual(["park", "probe"]);
  });

  it("cannot be handed an executor that would skip the probe", async () => {
    // `RawExecutor` requires the read, so a cast is the only way left to write
    // the executor this used to accept — and what it used to do with one was
    // park the rows, skip the assertion and land them unguarded, silently. The
    // rows are parked here too; what differs is that the run does not survive
    // it. An executor that cannot be asked cannot re-point.
    const deaf = { $executeRawUnsafe: async () => 0 } as unknown as RawExecutor;

    await expect(repointPageEmbeddings(deaf, "project-1", [{ pageId: "page-4", index: 5 }])).rejects.toThrow(
      TypeError
    );
  });

  it("asks the question pass two answers, with pass two's own fragment", () => {
    const probe = pageEmbeddingRepointCollisionQuery("project-1");
    const passes = pageEmbeddingRepointPasses("project-1", [{ pageId: "page-4", index: 5 }]);

    // Not two `regexp_replace` literals a test holds equal: one exported
    // fragment, written into pass two's SET and into *both* sides of the
    // probe's join, so the check cannot come to ask a question the statement it
    // guards does not answer.
    expect(passes?.land.sql).toContain(landedPageScopeSql('"scope"'));
    expect(probe.sql).toContain(landedPageScopeSql('parked."scope"'));
    expect(probe.sql).toContain(landedPageScopeSql('other."scope"'));
    // One book, and no row is ever its own collision.
    expect(probe.params).toEqual(["project-1"]);
    expect(probe.sql).toContain('parked."projectId" = $1');
    expect(probe.sql).toContain('other."projectId" = parked."projectId"');
    expect(probe.sql).toContain('other."id" <> parked."id"');
  });

  it("cannot be run past the probe by handing the pair to the statement runner", () => {
    // The hole this closes was reachability, not the guard: while the passes
    // came back as a `PageOrderingStatement[]`, `runPageOrderingStatements`
    // accepted the builder's result outright — park and land, no probe, one
    // call. A named pair is not that array.
    expect(Array.isArray(pageEmbeddingRepointPasses("project-1", [{ pageId: "page-4", index: 5 }]))).toBe(false);
  });
});

describe("maintaining page-owned continuity notes", () => {
  it("re-points scopes and numeric tags by page id while preserving edit suffixes", () => {
    const [statement] = pageContinuityNoteRepointStatements("project-1", [
      { pageId: "page-4", index: 2 },
      { pageId: "page-2", index: 4 }
    ]);

    expect(statement?.params).toEqual(["project-1", "page-4", 2, "page-2", 4]);
    expect(statement?.sql).toContain('n."pageId" = v.page_id');
    expect(statement?.sql).toContain("regexp_replace(n.\"scope\", '^page:[0-9]+'");
    expect(statement?.sql).toContain('n."tags"[1] = \'page\'');
    expect(statement?.sql).toContain('n."tags"[2]');
    expect(statement?.sql).toContain('n."projectId" = $1');
  });

  it("deletes owned rows by stable page id and retires ambiguous legacy page scopes", async () => {
    const deleteMany = vi.fn(async () => ({ count: 0 }));
    const tx = { continuityNote: { deleteMany } } as never;

    await deletePageContinuityNotes(tx, "project-1", ["page-deleted"]);
    await discardLegacyPageContinuityNotes(tx, "project-1");

    expect(deleteMany).toHaveBeenNthCalledWith(1, {
      where: { projectId: "project-1", pageId: { in: ["page-deleted"] } }
    });
    expect(deleteMany).toHaveBeenNthCalledWith(2, {
      where: { projectId: "project-1", pageId: null, scope: { startsWith: "page:" } }
    });
  });
});

describe("running the statements", () => {
  const recorder = () => {
    const calls: { sql: string; params: unknown[] }[] = [];
    return {
      calls,
      $executeRawUnsafe: async (sql: string, ...params: unknown[]) => {
        calls.push({ sql, params });
        return 0;
      },
      /** Neither statement pair below parks a scope, so the probe has nothing to find. */
      $queryRawUnsafe: async <T,>(): Promise<T> => [] as T
    };
  };

  it("passes the project id and the numbers as bound parameters", async () => {
    const executor = recorder();
    await shiftPageIndexes(executor, "project-1", { afterIndex: 3, delta: 2 });

    expect(executor.calls).toHaveLength(2);
    expect(executor.calls[0]?.params).toEqual(["project-1", 3]);
    expect(executor.calls[1]?.params).toEqual(["project-1", 2]);
    // Both statements are scoped to the project: an unscoped one would renumber
    // every book in the database.
    for (const call of executor.calls) {
      expect(call.sql).toContain('"projectId" = $1');
    }
  });

  it("does nothing at all for a zero shift", async () => {
    const executor = recorder();
    await shiftPageIndexes(executor, "project-1", { afterIndex: 3, delta: 0 });

    expect(executor.calls).toEqual([]);
  });

  it("scopes an explicit reorder to the project too", async () => {
    const executor = recorder();
    await applyPageOrder(executor, "project-1", [{ pageId: "page-1", index: 1 }]);

    expect(executor.calls).toHaveLength(2);
    expect(executor.calls[0]?.params).toEqual(["project-1", "page-1", 1]);
    for (const call of executor.calls) {
      expect(call.sql).toContain('"projectId" = $1');
    }
  });
});

/**
 * The apply side of a structural edit, end to end: the plan says where the
 * pages go, and the map the reader is still reading has to follow them there.
 * The worker's transaction is only the wiring between these two.
 */
describe("the page map a structural edit leaves in force", () => {
  const pages: ExistingPage[] = Array.from({ length: 4 }, (_value, offset) => ({
    id: `page-${offset + 1}`,
    index: offset + 1
  }));
  // Cover, Contents, then one PDF sheet per model page.
  const stored = {
    version: 2,
    totalPdfPages: 7,
    hasCoverPage: true,
    contentsStartPdfPage: 2,
    pages: [
      { index: 1, startPdfPage: 3, endPdfPage: 3 },
      { index: 2, startPdfPage: 4, endPdfPage: 4 },
      { index: 3, startPdfPage: 5, endPdfPage: 5 },
      { index: 4, startPdfPage: 6, endPdfPage: 7 }
    ],
    contentRevision: 12
  };

  const applied = (edit: Parameters<typeof resolveStructuralPageEdit>[0], pageMap: unknown = stored) => {
    const resolved = resolveStructuralPageEdit(edit, pages);
    if (!resolved.ok) {
      throw new Error(`expected a plan, got ${resolved.reason}`);
    }
    return repointedPageMapUpdate(pageMap, pageIndexMovesForStructuralPlan(resolved.plan, pages));
  };

  it("keeps an insert's map, with the tail pages pointed at their new indexes", () => {
    // Two pages go in after page 2. The compiled PDF has not changed, so
    // printed page 5 still shows what is now model page 5 — and that is the
    // whole point: without this the chat would read a typed "page 5" as model
    // page 5 in the *new* numbering, which is a page with nothing on it yet.
    expect(applied({ action: "insert", anchorPageIndex: 2, pageIndexes: [], pageCount: 2 })).toEqual({
      pdfPageMap: {
        ...stored,
        pages: [
          { index: 1, startPdfPage: 3, endPdfPage: 3 },
          { index: 2, startPdfPage: 4, endPdfPage: 4 },
          { index: 5, startPdfPage: 5, endPdfPage: 5 },
          { index: 6, startPdfPage: 6, endPdfPage: 7 }
        ]
      }
    });
  });

  it("keeps a move's map, because every sheet still belongs to a page", () => {
    expect(applied({ action: "move", anchorPageIndex: 0, pageIndexes: [3], pageCount: 0 })).toEqual({
      pdfPageMap: {
        ...stored,
        pages: [
          { index: 2, startPdfPage: 3, endPdfPage: 3 },
          { index: 3, startPdfPage: 4, endPdfPage: 4 },
          { index: 1, startPdfPage: 5, endPdfPage: 5 },
          { index: 4, startPdfPage: 6, endPdfPage: 7 }
        ]
      }
    });
  });

  it("drops a delete's ranges rather than leaving a sheet uncovered", () => {
    // The deleted page's sheet belongs to nothing now, and a hole would have
    // `pdfPageZone` call a readable page front or back matter.
    expect(applied({ action: "delete", anchorPageIndex: null, pageIndexes: [2], pageCount: 0 })).toEqual({
      pdfPageMap: { ...bookPdfCoverNumbering(true), contentRevision: 12 }
    });
  });

  it("keeps the cover numbering the ranges were sitting on, and its stamp", () => {
    // Nulling the column instead is what dropped `hasCoverPage` off the status
    // DTO on every applied delete: the PDF on screen is unchanged, so its first
    // sheet is still an unnumbered cover, and the app that stops being told so
    // labels it page 1 while the sheet's own footer prints nothing.
    const degraded = applied(
      { action: "delete", anchorPageIndex: null, pageIndexes: [2], pageCount: 0 },
      { ...stored, pdfDigest: "sha-1" }
    ).pdfPageMap;

    // Chat sees no map at all — a stub has no ranges to translate through, which
    // is exactly the model-index fallback a cleared column produced.
    expect(parseStoredBookPdfPageMap(degraded)).toBeUndefined();
    // Chrome sees the cover skip, which is what `serializedHasCoverPage` reads.
    const numbering = parseStoredBookPdfNumbering(degraded);
    expect(numbering && printedPageOffset(numbering) > 0).toBe(true);
    // Stamped as the map it replaces was: it describes that compile's file, so
    // it has to expire with it exactly as a re-pointed map would.
    expect(numbering).toMatchObject({ contentRevision: 12, pdfDigest: "sha-1" });
  });

  it("keeps a version-1 map on physical numbering when it degrades", () => {
    // Those PDFs numbered their own cover. A version-2 stub over one would have
    // chrome skip a sheet the footer counts — the same off-by-one, reversed.
    const degraded = applied(
      { action: "delete", anchorPageIndex: null, pageIndexes: [2], pageCount: 0 },
      { ...stored, version: 1 }
    ).pdfPageMap;
    const numbering = parseStoredBookPdfNumbering(degraded);

    expect(numbering).toMatchObject({ version: 1, hasCoverPage: true });
    expect(numbering && printedPageOffset(numbering)).toBe(0);
  });

  it("carries a measured map with no ranges through, rather than stubbing it", () => {
    // The other emptiness, and not the same one. This row names no model page,
    // so the renumber moved nothing it says and took no sheet out from under
    // it — while it is still the only record of how many sheets the file on
    // screen has and where its furniture starts. Degrading it to a stub retired
    // a row `parseStoredBookPdfPageMap` deliberately accepts, so a typed
    // "page 12" fell back to a model index over a file that had not changed.
    const rangeless = { ...stored, pages: [], backMatterStartPdfPage: 7 };
    const move: StructuralPageEdit = { action: "move", anchorPageIndex: 0, pageIndexes: [3], pageCount: 0 };
    const deletion: StructuralPageEdit = { action: "delete", anchorPageIndex: null, pageIndexes: [2], pageCount: 0 };

    expect(applied(move, rangeless)).toEqual({ pdfPageMap: rangeless });
    // A delete does not change that: no range can lose its page when the map
    // holds none, so the totals and the furniture come through whole.
    expect(parseStoredBookPdfPageMap(applied(deletion, rangeless).pdfPageMap)).toEqual({
      version: 2,
      totalPdfPages: 7,
      hasCoverPage: true,
      contentsStartPdfPage: 2,
      backMatterStartPdfPage: 7,
      pages: [],
      contentRevision: 12
    });
    // The condition that genuinely degrades is a *named* page going away: the
    // same delete over the same map holding ranges still comes back a stub.
    expect(parseStoredBookPdfPageMap(applied(deletion).pdfPageMap)).toBeUndefined();
  });

  it("leaves a cover-skip stub and a blank column alone", () => {
    // A stub carries no ranges to re-point, but chrome still reads
    // `hasCoverPage` off it — clearing it would put the footer and the reader's
    // page indicator back out of step.
    const move: StructuralPageEdit = { action: "move", anchorPageIndex: 0, pageIndexes: [3], pageCount: 0 };

    expect(applied(move, { version: 2, hasCoverPage: true, pages: [] })).toEqual({});
    expect(applied(move, null)).toEqual({});
  });
});
