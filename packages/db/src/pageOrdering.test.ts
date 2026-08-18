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
  pageContinuityNoteRepointStatements,
  pageEmbeddingRepointStatements,
  pageOrderStatements,
  pageShiftStatements,
  repointedPageMapUpdate,
  shiftPageIndexes,
  type PageOrderEntry,
  type PageOrderingStatement
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

describe("re-pointing semantic memory at moved pages", () => {
  it("keys on the page id and leaves other scopes alone", () => {
    const [statement] = pageEmbeddingRepointStatements("project-1", [
      { pageId: "page-4", index: 6 },
      { pageId: "page-5", index: 7 }
    ]);

    // The id survives a renumber; the index parsed out of the scope string is
    // the very thing that just became wrong.
    expect(statement?.params).toEqual(["project-1", "page-4", 6, "page-5", 7]);
    expect(statement?.sql).toContain(`"scope" LIKE 'page:%'`);
    expect(statement?.sql).toContain('e."projectId" = $1');
  });

  it("emits nothing for an empty order", () => {
    expect(pageEmbeddingRepointStatements("project-1", [])).toEqual([]);
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
      }
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
