import { bookPdfCoverNumbering, parseStoredBookPdfPageMap, repointBookPdfPageMap } from "@book-maker/core";
import { Prisma } from "./client.ts";

/**
 * Moving `Page.index` around, which nothing in this project had ever done.
 *
 * Every index write before this was a wipe-and-recreate of `1..N` or an append
 * at the tail, so inserting, deleting or reordering a page in the middle of a
 * finished book is the first thing that has to *shift* the rows after it.
 *
 * `@@unique([projectId, index])` is what makes that non-trivial. It is a plain
 * `CREATE UNIQUE INDEX`, checked per row as the statement runs, so the obvious
 * `UPDATE … SET index = index + 1 WHERE index > n` raises `23505` the moment it
 * reaches a row whose new index is one another row still holds. Postgres cannot
 * defer a unique *index* — only a unique *constraint* — and converting it is not
 * an option either: `reviewAndSaveGeneratedPage` upserts on `projectId_index`,
 * which Prisma compiles to `INSERT … ON CONFLICT DO UPDATE`, and Postgres
 * refuses a deferrable constraint as an `ON CONFLICT` arbiter. Every page save
 * in the app would start failing.
 *
 * So both operations here run in two passes through the **negative half of the
 * range**, which no page ever occupies: park the rows being moved as negatives,
 * then bring them back at their destination. Neither statement can collide,
 * because a negative can only meet other negatives and the positives that
 * survive pass one are all outside the destination window.
 *
 * This lives in `packages/db` because both sides need it: the worker shifts
 * when it applies a structural edit, and the API shifts back when the reader
 * undoes one.
 */

/** One page's place in an explicit ordering. */
export type PageOrderEntry = {
  pageId: string;
  index: number;
};

export type PageOrderingStatement = {
  sql: string;
  params: unknown[];
};

/**
 * Moves every page after `afterIndex` by `delta`, leaving a gap for inserted
 * pages (positive delta) or closing one behind deleted pages (negative delta).
 *
 * For a delete, the rows must already be gone: pass two lands the survivors on
 * indexes the deleted pages held, and a row still sitting on one is a collision
 * the negative parking cannot hide.
 */
export function pageShiftStatements(projectId: string, afterIndex: number, delta: number): PageOrderingStatement[] {
  return [
    {
      sql: 'UPDATE "Page" SET "index" = -"index" WHERE "projectId" = $1 AND "index" > $2',
      params: [projectId, afterIndex]
    },
    {
      sql: 'UPDATE "Page" SET "index" = -"index" + $2 WHERE "projectId" = $1 AND "index" < 0',
      params: [projectId, delta]
    }
  ];
}

/**
 * Rewrites the whole project's page order from an explicit list.
 *
 * The list must name **every** page of the project. Pass two brings every
 * parked row back at once, so a page left out keeps a positive index that a
 * parked row may be about to land on — and the gap that opens is invisible
 * until a compile refuses the book for not being contiguous from 1.
 */
export function pageOrderStatements(
  projectId: string,
  order: readonly PageOrderEntry[]
): PageOrderingStatement[] {
  if (order.length === 0) {
    return [];
  }
  const values = order.map((_entry, offset) => `($${offset * 2 + 2}::text, $${offset * 2 + 3}::int)`).join(", ");
  return [
    {
      sql:
        `UPDATE "Page" AS p SET "index" = -v.idx FROM (VALUES ${values}) AS v(id, idx) ` +
        `WHERE p."id" = v.id AND p."projectId" = $1`,
      params: [projectId, ...order.flatMap((entry) => [entry.pageId, entry.index])]
    },
    {
      sql: 'UPDATE "Page" SET "index" = -"index" WHERE "projectId" = $1 AND "index" < 0',
      params: [projectId]
    }
  ];
}

/**
 * Re-points the semantic-memory rows a moved page owns.
 *
 * `Embedding.scope` is the string `page:<index>`, with no foreign key, so every
 * row of a page that moved now describes a different page. That is worse than
 * losing them: `retrieveSemanticPageMemory` excludes a page's *own* scope, so a
 * stale one makes a page retrieve itself as long-range memory.
 *
 * Keyed on `sourceId`, which `storeEmbedding` always writes as the `Page.id`,
 * rather than by parsing the index back out of the scope string — the id is
 * what survives a renumber. Only rows already shaped `page:%` are touched, so
 * chapter and research scopes are left alone.
 */
export function pageEmbeddingRepointStatements(
  projectId: string,
  order: readonly PageOrderEntry[]
): PageOrderingStatement[] {
  if (order.length === 0) {
    return [];
  }
  const values = order.map((_entry, offset) => `($${offset * 2 + 2}::text, $${offset * 2 + 3}::int)`).join(", ");
  return [
    {
      sql:
        `UPDATE "Embedding" AS e SET "scope" = 'page:' || v.idx::text ` +
        `FROM (VALUES ${values}) AS v(source_id, idx) ` +
        `WHERE e."projectId" = $1 AND e."sourceId" = v.source_id AND e."scope" LIKE 'page:%'`,
      params: [projectId, ...order.flatMap((entry) => [entry.pageId, entry.index])]
    }
  ];
}

/**
 * Re-points page-owned continuity notes by the stable Page id.
 *
 * The human-readable scope and the conventional `["page", "<index>", ...]`
 * tags still carry the page's current index because prompts and diagnostics use
 * them. Neither is used to decide ownership: after a delete or move, the same
 * number may belong to a different page. Edit scopes keep their suffix (for
 * example `page:3:edit:op-1`) while only the leading index changes.
 */
export function pageContinuityNoteRepointStatements(
  projectId: string,
  order: readonly PageOrderEntry[]
): PageOrderingStatement[] {
  if (order.length === 0) {
    return [];
  }
  const values = order.map((_entry, offset) => `($${offset * 2 + 2}::text, $${offset * 2 + 3}::int)`).join(", ");
  return [
    {
      sql:
        `UPDATE "ContinuityNote" AS n SET ` +
        `"scope" = CASE WHEN n."scope" LIKE 'page:%' ` +
        `THEN regexp_replace(n."scope", '^page:[0-9]+', 'page:' || v.idx::text) ELSE n."scope" END, ` +
        `"tags" = CASE ` +
        `WHEN cardinality(n."tags") >= 2 AND n."tags"[1] = 'page' AND n."tags"[2] ~ '^[0-9]+$' ` +
        `THEN ARRAY[n."tags"[1], v.idx::text] || ` +
        `COALESCE(n."tags"[3:cardinality(n."tags")], ARRAY[]::text[]) ` +
        `ELSE n."tags" END ` +
        `FROM (VALUES ${values}) AS v(page_id, idx) ` +
        `WHERE n."projectId" = $1 AND n."pageId" = v.page_id`,
      params: [projectId, ...order.flatMap((entry) => [entry.pageId, entry.index])]
    }
  ];
}

/**
 * Drops the semantic-memory rows of pages that are about to stop existing.
 *
 * The same missing foreign key that makes the repoint above necessary makes
 * this necessary: `Embedding` cascades on `Project`, not on `Page`, so deleting
 * a page leaves its `page:<index>` rows sitting on an index the renumber is
 * about to hand to the page that moves up into it. The orphan then answers as
 * long-range memory *for a live page*, quoting text the book no longer
 * contains, and nothing downstream can tell the two apart — the retrieval
 * dedupes by scope and keeps whichever row scored higher, so the survivor's own
 * summary can lose to the deleted page's.
 *
 * Keyed on `sourceId` for the reason {@link pageEmbeddingRepointStatements} is:
 * the id is what survives a renumber, the scope string is what the renumber
 * rewrites. Restricted to `page:%` so a `research:` row is left alone.
 *
 * These rows are not restorable, so an undo brings a page back without its
 * memory. That is the same bargain `PageEditSnapshot` already makes by
 * cascading, and it is the right way round: a page absent from long-range
 * memory until it is next written is a gap, while a page whose embedding
 * describes a different page is a wrong answer nothing detects.
 */
export async function deletePageEmbeddings(
  tx: PageOrderingTransaction,
  projectId: string,
  pageIds: readonly string[]
): Promise<void> {
  if (pageIds.length === 0) {
    return;
  }
  await tx.embedding.deleteMany({
    where: { projectId, sourceId: { in: [...pageIds] }, scope: { startsWith: "page:" } }
  });
}

/** Drops all continuity facts owned by pages that are about to disappear. */
export async function deletePageContinuityNotes(
  tx: PageOrderingTransaction,
  projectId: string,
  pageIds: readonly string[]
): Promise<void> {
  if (pageIds.length === 0) {
    return;
  }
  await tx.continuityNote.deleteMany({
    where: { projectId, pageId: { in: [...pageIds] } }
  });
}

/**
 * Removes page-scoped notes that remain without stable page ownership.
 *
 * Inferring an owner from `page:<index>` is unsafe: a structural edit on an
 * older deployment may already have deleted that page and handed its index to
 * another one. Such rows are excluded from generation context immediately and
 * discarded when either side next changes the book's structure. Losing an
 * ambiguous fact is safer than attributing deleted prose to a surviving page.
 */
export async function discardLegacyPageContinuityNotes(
  tx: PageOrderingTransaction,
  projectId: string
): Promise<void> {
  await tx.continuityNote.deleteMany({
    where: { projectId, pageId: null, scope: { startsWith: "page:" } }
  });
}

/**
 * The `Project.pdfPageMap` half of the same renumber, as the fields to merge
 * into the project write that is already happening.
 *
 * The column used to be nulled by both sides of a structural edit, on the
 * grounds that the map describes a pagination the book no longer has. It does —
 * but the *file* it describes is still the one on screen, because the exports
 * are rebuilt asynchronously and `bookPageMapForProject` deliberately keeps a
 * behind map in force while the project is EDITING. Nulling it there is what
 * made a typed "page 12" fall back to a model index while printed page 12 was
 * still in front of the reader. So the map is carried across the renumber
 * instead, with its indexes moved to where those pages now live.
 *
 * Three answers, and the empty one is not the boring case:
 * - no translatable map stored — a blank column, or the cover-skip stub a
 *   failed measurement leaves — is **left alone**, because chrome still reads
 *   `hasCoverPage` off that stub and this edit did not invalidate it;
 * - a map every one of whose ranges survives the move is rewritten. A measured
 *   map carrying **no** ranges survives it vacuously and is rewritten
 *   unchanged: it names no model page, so this renumber moved nothing it says,
 *   while its totals, cover flag and furniture starts are still true of the
 *   same file. "Holds no ranges" is not "lost a range", and only the second may
 *   degrade — reading both off `pages.length` is what retired a row
 *   {@link parseStoredBookPdfPageMap} deliberately keeps as live data;
 * - a map that loses a range keeps only its cover numbering, which is what
 *   {@link repointBookPdfPageMap} refusing a hole means in practice: a delete
 *   as it is applied, and an insert as it is undone.
 *
 * That last case is a *degrade*, not a clear, and the difference is a sheet the
 * reader is looking at. The **ranges** genuinely have to go — a hole in them has
 * `pdfPageZone` calling a page the reader can still read the Sources list — but
 * the cover-skip fact underneath them was never about the pages that moved: the
 * file is unchanged, and its first sheet still is or is not an unnumbered cover.
 * Nulling the column took that with it, so `serializedHasCoverPage` dropped
 * `hasCoverPage` off the status DTO and the app fell back to numbering the cover
 * as page 1 — chrome, Contents and scroll handle all saying "Page 2" over a
 * sheet whose own footer prints "Page 1", on **every** applied page delete. So
 * the ranges are replaced by the same `bookPdfCoverNumbering` stub
 * `persistablePdfPageMapAfterRender` writes for an unmeasurable render, keeping
 * the version (a version-1 PDF numbers its cover) and the publication stamp (the
 * stub describes that compile's file, and must expire with it exactly as the
 * re-pointed map would). The stub's own `kind` marker is what keeps it out of
 * chat — {@link parseStoredBookPdfPageMap} refuses it by that, not by its empty
 * `pages` — so page numbers fall back to model indexes the way a cleared column
 * made them.
 */
export function repointedPageMapUpdate(
  storedPageMap: unknown,
  moves: ReadonlyMap<number, number>
): { pdfPageMap?: Prisma.InputJsonValue } {
  const stored = parseStoredBookPdfPageMap(storedPageMap);
  if (!stored) {
    return {};
  }
  const repointed = repointBookPdfPageMap(stored, moves) ?? {
    ...bookPdfCoverNumbering(stored.hasCoverPage, stored.version),
    ...(stored.contentRevision === undefined ? {} : { contentRevision: stored.contentRevision }),
    ...(stored.pdfDigest === undefined ? {} : { pdfDigest: stored.pdfDigest })
  };
  return { pdfPageMap: repointed as unknown as Prisma.InputJsonValue };
}

export async function repointPageEmbeddings(
  executor: RawExecutor,
  projectId: string,
  order: readonly PageOrderEntry[]
): Promise<void> {
  await runPageOrderingStatements(executor, pageEmbeddingRepointStatements(projectId, order));
}

export async function repointPageContinuityNotes(
  executor: RawExecutor,
  projectId: string,
  order: readonly PageOrderEntry[]
): Promise<void> {
  await runPageOrderingStatements(executor, pageContinuityNoteRepointStatements(projectId, order));
}

/** A transaction client, or the client itself — both can run raw statements. */
export type RawExecutor = {
  $executeRawUnsafe: (sql: string, ...params: unknown[]) => Promise<number>;
};

export async function runPageOrderingStatements(
  executor: RawExecutor,
  statements: readonly PageOrderingStatement[]
): Promise<void> {
  for (const statement of statements) {
    await executor.$executeRawUnsafe(statement.sql, ...statement.params);
  }
}

/** See {@link pageShiftStatements}. A zero delta is a no-op, not two statements. */
export async function shiftPageIndexes(
  executor: RawExecutor,
  projectId: string,
  options: { afterIndex: number; delta: number }
): Promise<void> {
  if (options.delta === 0) {
    return;
  }
  await runPageOrderingStatements(executor, pageShiftStatements(projectId, options.afterIndex, options.delta));
}

/** See {@link pageOrderStatements}. */
export async function applyPageOrder(
  executor: RawExecutor,
  projectId: string,
  order: readonly PageOrderEntry[]
): Promise<void> {
  await runPageOrderingStatements(executor, pageOrderStatements(projectId, order));
}

/**
 * Interactive transactions here run well past Prisma's 5 s default: two raw
 * updates across every page after the anchor, a `createMany`, two `PlanVersion`
 * writes carrying the whole plan JSON, and the project and chapter rows. No
 * call site in this repo passes transaction options, so this is the one place
 * that names them.
 */
export const PAGE_RESTRUCTURE_TRANSACTION_OPTIONS = {
  timeout: 30_000,
  maxWait: 10_000
} satisfies { timeout: number; maxWait: number };

/** Re-exported so callers do not have to import Prisma just to type a tx. */
export type PageOrderingTransaction = Prisma.TransactionClient;
