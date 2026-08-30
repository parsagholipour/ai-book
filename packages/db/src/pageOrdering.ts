import { bookPdfCoverNumbering, parseStoredBookPdfPageMap, repointBookPdfPageMap } from "@book-maker/core";
import { Prisma } from "./client.ts";
import { PAGE_SCOPE_PREFIX } from "./embeddingScopes.ts";

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
 * `Embedding` carries the same shape of constraint — `@@unique([projectId,
 * scope])`, another plain unique index — over a *text* column that spells the
 * page index out, so {@link pageEmbeddingRepointPasses} runs the identical
 * two passes through a parking namespace instead of a negative range. See
 * {@link EMBEDDING_REPOINT_PARK_PREFIX} for why the namespace is not `page:-N`.
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
 * The namespace a page re-point parks a scope in between its two passes.
 *
 * The negative half of `Page.index` works as a parking range because nothing
 * reads a negative index. Text has no negative half, and `page:-4` is *not* the
 * analogue: every page-scope reader in this repo filters with `LIKE 'page:%'`
 * or Prisma's `startsWith: "page:"` — `retrieveSimilarEmbeddings` and
 * `retrieveHybridEmbeddings` through `scopePrefix`, `repairPageEmbeddings`,
 * {@link deletePageEmbeddings}, the whole-book wipes in `bookPasses`,
 * `bookState` and `generateBook` — and every one of them matches `page:-4`. A
 * prefix that keeps its own colon out of the fifth position is what none of
 * them can match, so a parked row cannot be read, deleted or re-pointed as if
 * it were a live `page:<index>` one.
 *
 * Parked rows exist only between the two statements of one re-point, and both
 * run inside the caller's transaction, so nothing outside it ever observes the
 * prefix and no rollback can leave it behind.
 */
export const EMBEDDING_REPOINT_PARK_PREFIX = "page-repoint:";

/**
 * The scope a row will hold once pass two of a re-point has run, written as SQL
 * over the column that holds it now.
 *
 * One fragment, three uses: pass two's own `SET`, and *both* sides of
 * {@link pageEmbeddingRepointCollisionQuery}'s join. Those were two independent
 * `regexp_replace` literals held equal by a test that compared the two strings
 * — the hazard `lexicalMatchSql` (`src/lexicalRetrieval.ts`) is written against
 * one shape up, because a probe that asks a slightly different question than
 * the statement it guards answers "no collision" to a collision. A function
 * cannot drift from itself.
 *
 * It is deliberately the identity on anything that is not parked: a live
 * `page:5`, a `research:` row and a chapter scope all fail the anchor and come
 * back unchanged. So "the scope this row will hold after pass two" is one
 * expression over *every* row of the project, which is what lets the probe ask
 * its question once rather than once per kind of row it might meet.
 */
export function landedPageScopeSql(scopeColumn: string): string {
  return `regexp_replace(${scopeColumn}, '^${EMBEDDING_REPOINT_PARK_PREFIX}([0-9]+):.*$', '${PAGE_SCOPE_PREFIX}\\1')`;
}

/**
 * The two statements of one re-point, named rather than ordered.
 *
 * They used to come back as a `PageOrderingStatement[]`, which is precisely
 * what {@link runPageOrderingStatements} takes — so "park, then land, with
 * nothing in between" was an assembly the signatures offered rather than one a
 * caller had to mean, and the order of the pair was a convention an array
 * cannot state. Named fields say which is which, and cost the unguarded path
 * its one-argument spelling. See {@link repointPageEmbeddings} for why the raw
 * path is narrowed rather than removed.
 */
export type PageEmbeddingRepointPasses = {
  park: PageOrderingStatement;
  land: PageOrderingStatement;
};

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
 *
 * **Two passes, for the same reason {@link pageShiftStatements} is two passes.**
 * `Embedding` carries `@@unique([projectId, scope])`, which is a plain
 * `CREATE UNIQUE INDEX` and therefore checked row by row as the statement runs
 * — the same non-deferrable check `Page.index` has. A renumber is overlapping
 * by construction: inserting one page after page 3 of a ten-page book maps
 * `page:4` to `page:5` while the row holding `page:5` is still live, so the
 * single statement this used to be raised `23505` on the first row it reached
 * and rolled back the whole restructure transaction — every insert, delete and
 * move of a page, and every Undo of one. Pass one parks every named row under
 * {@link EMBEDDING_REPOINT_PARK_PREFIX}, keyed by the destination index **and
 * the scope it came from**; pass two brings all of them back at once, through
 * {@link landedPageScopeSql}.
 *
 * Pass two is unconditional over the project rather than re-joining the same
 * `VALUES`, so it cannot leave a parked row behind the way a second join could
 * if it failed to match.
 *
 * **The second half of that park key is what keeps pass one from colliding with
 * itself.** `sourceId -> page:%` is one-to-many — {@link deletePageEmbeddings}
 * matches it with `startsWith` for exactly that reason — because a row is
 * upserted on `(projectId, scope)` and nothing holds a page to one of them:
 * `repairPageEmbeddings` resolves the page sitting at an index and only then
 * spends a provider call, so an edit committing inside that window has it
 * insert `page:<old index>` for a page that by now holds `page:<new index>`,
 * and a page job lagging in BullMQ backoff — the race
 * `000056_embedding_project_scope_unique` was written for — writes its own
 * stale index the same way. Keyed on the destination alone, one statement set
 * *both* of that page's rows to the one `page-repoint:<index>` value: `23505`
 * from **pass one**, which is the failure the split exists to prevent, and
 * before 000056 a silent collapse of two rows into one. With the row's own
 * scope in the key the parked values are as distinct as the rows are, because
 * `(projectId, scope)` is unique — so pass one can collide with neither a live
 * scope (the namespace holds none) nor another parked one.
 *
 * What that leaves is pass two, where both of those rows do still want the one
 * `page:<destination>` — and that is the probe's existing question rather than
 * a new one, because it joins on the scope each row *lands* on: two parked rows
 * headed for one index read there exactly like a parked row headed at a live
 * one.
 *
 * **The order must name every page that currently holds one of its destination
 * indexes** — the same shape of precondition {@link pageOrderStatements} has,
 * and for the same reason. Pass two lands every parked row at once, so a page
 * the order leaves out keeps a live `page:<index>` that a parked row is about
 * to be written onto: `23505`, on the statement the two passes exist to make
 * safe. Unlike `pageOrderStatements` this does *not* require the whole book —
 * an order may be partial as long as it is closed over its own destinations,
 * and one caller depends on that: an insert names only the tail it shifted,
 * whose destinations all sit past the untouched head.
 *
 * Neither that precondition nor the one-scope-per-page one above is a fact
 * about the argument, so neither can be checked here.
 * {@link repointPageEmbeddings} asserts them between the two passes, where they
 * are one join and need no argument at all.
 */
export function pageEmbeddingRepointPasses(
  projectId: string,
  order: readonly PageOrderEntry[]
): PageEmbeddingRepointPasses | null {
  if (order.length === 0) {
    return null;
  }
  const values = order.map((_entry, offset) => `($${offset * 2 + 2}::text, $${offset * 2 + 3}::int)`).join(", ");
  return {
    park: {
      sql:
        `UPDATE "Embedding" AS e SET ` +
        `"scope" = '${EMBEDDING_REPOINT_PARK_PREFIX}' || v.idx::text || ':' || e."scope" ` +
        `FROM (VALUES ${values}) AS v(source_id, idx) ` +
        `WHERE e."projectId" = $1 AND e."sourceId" = v.source_id AND e."scope" LIKE '${PAGE_SCOPE_PREFIX}%'`,
      params: [projectId, ...order.flatMap((entry) => [entry.pageId, entry.index])]
    },
    land: {
      sql:
        `UPDATE "Embedding" SET "scope" = ${landedPageScopeSql('"scope"')} ` +
        `WHERE "projectId" = $1 AND "scope" LIKE '${EMBEDDING_REPOINT_PARK_PREFIX}%'`,
      params: [projectId]
    }
  };
}

/**
 * Two rows pass two of a re-point would leave holding one scope: a parked row,
 * and whatever else claims the scope it lands on.
 *
 * "Whatever else" is two things, which is why the fields do not say `live`.
 * Usually it is a live `page:<n>` no parked row is about to vacate — the
 * ordering left its page out. It can also be a *second parked row of the same
 * page*, since `sourceId -> page:%` is one-to-many and one page's two rows
 * cannot both become its one new index.
 */
export type PageEmbeddingRepointCollision = {
  /** The parked row, as `<prefix><destination>:<the scope it came from>`. */
  parkedScope: string;
  /** What pass two would write that row to. */
  landingScope: string;
  /** The scope the other claimant holds *now* — live, or parked alongside it. */
  heldScope: string;
  /** The page that other row belongs to, where it has one. */
  heldSourceId: string | null;
};

/**
 * Raised when a re-point ordering does not name the page holding one of its
 * own destination indexes, or when one page holds two page scopes that would
 * have to become the same one.
 *
 * The alternative is the `23505` that {@link pageEmbeddingRepointPasses}
 * exists to prevent, arriving from pass two with nothing on it but a constraint
 * name — inside a transaction that has already deleted pages, renumbered the
 * book, archived undo history and written a `PlanVersion`, all of which roll
 * back with it. This names both faults as what they are, and carries the scopes
 * that prove them.
 */
export class PageEmbeddingRepointCollisionError extends Error {
  readonly code = "PAGE_EMBEDDING_REPOINT_COLLISION";
  readonly projectId: string;
  readonly collisions: PageEmbeddingRepointCollision[];

  constructor(projectId: string, collisions: readonly PageEmbeddingRepointCollision[]) {
    super(
      `A page embedding re-point in project ${projectId} would leave ${collisions
        .map(
          (collision) =>
            `"${collision.parkedScope}" and "${collision.heldScope}" both holding "${collision.landingScope}"`
        )
        .join(", ")}. ` +
        "The ordering must name every page that currently holds one of its destination indexes, " +
        "and a page holding two page scopes has no one index to re-point them to."
    );
    this.name = "PageEmbeddingRepointCollisionError";
    this.projectId = projectId;
    this.collisions = [...collisions];
  }
}

/**
 * The rows pass two of a re-point cannot be allowed to leave holding one scope:
 * a live `page:<n>` that no parked row is about to vacate, and a second parked
 * row of the same page headed for the same index.
 *
 * Read **between** the two passes, which is what makes it exact rather than
 * conservative. Before pass one, "a destination index some other page holds"
 * over-reports — a destination whose named page owns no `page:%` row at all is
 * never written to, so nothing lands on the row sitting there. After pass one,
 * the parked rows *are* the set pass two will write, so joining them against
 * the scopes they are about to become answers exactly the question, with no
 * reference to the ordering and no array of ids to ship.
 *
 * Both sides of that join are written with {@link landedPageScopeSql}, which is
 * the fragment pass two's own `SET` is written with, so the probe cannot drift
 * away from the statement it guards — it is one function rather than two
 * literals a test compares. Applying it to the *other* side as well is what
 * makes one join cover both hazards: the fragment is the identity on a scope
 * that is not parked, so a live `page:5` compares as itself while a second
 * parked row of the same page compares as the index it is headed for.
 *
 * That costs the live side its index probe, deliberately. `live."scope" = <the
 * parked row's landing>` was a lookup on `(projectId, scope)` — the unique
 * index both passes are fighting — and a function applied to both sides is not.
 * What is left is a range scan over one project's own embedding rows, once per
 * structural edit, which is the right price for a hazard the indexed spelling
 * could not see at all. `LIMIT` because the message wants an example, not an
 * inventory.
 */
export function pageEmbeddingRepointCollisionQuery(projectId: string): PageOrderingStatement {
  const landing = landedPageScopeSql('parked."scope"');
  return {
    sql:
      `SELECT parked."scope" AS "parkedScope", ${landing} AS "landingScope", ` +
      `other."scope" AS "heldScope", other."sourceId" AS "heldSourceId" ` +
      `FROM "Embedding" AS parked JOIN "Embedding" AS other ON other."projectId" = parked."projectId" ` +
      `AND other."id" <> parked."id" AND ${landedPageScopeSql('other."scope"')} = ${landing} ` +
      `WHERE parked."projectId" = $1 AND parked."scope" LIKE '${EMBEDDING_REPOINT_PARK_PREFIX}%' ` +
      `ORDER BY parked."scope", other."scope" LIMIT 5`,
    params: [projectId]
  };
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
 * Keyed on `sourceId` for the reason {@link pageEmbeddingRepointPasses} is:
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
    where: { projectId, sourceId: { in: [...pageIds] }, scope: { startsWith: PAGE_SCOPE_PREFIX } }
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
    where: { projectId, pageId: null, scope: { startsWith: PAGE_SCOPE_PREFIX } }
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

/**
 * Parks, checks, lands. See {@link pageEmbeddingRepointPasses} for the two
 * passes and the preconditions, and {@link pageEmbeddingRepointCollisionQuery}
 * for why the check sits between them rather than in front of them.
 *
 * There is no path through this function that parks without checking, and that
 * is a property of {@link RawExecutor} rather than of the code below: the
 * executor is required to be able to read, so "cannot answer the probe" is not
 * a state a caller can hand in. It used to be one — the read was an optional
 * property and the check returned early without it — so every stand-in that
 * carried only `$executeRawUnsafe` ran a re-point with the guard silently off,
 * and the suite went green over the one thing this function exists to do.
 *
 * **This is not the only path to the two statements, and the pair's type is
 * what says so.** Both {@link pageEmbeddingRepointPasses} and
 * {@link runPageOrderingStatements} are surface this package offers, and while
 * the passes came back as a `PageOrderingStatement[]` the second took the
 * first's result directly: park-then-land with no probe between them, spelled
 * as one call, which is what `pageOrdering.integration.test.ts` was doing.
 * Naming the two passes cannot make that path unreachable — that suite is where
 * the `23505` itself is measured against a real Postgres, so it has to stay
 * reachable — but it does mean nothing arrives there by handing one builder's
 * result to a runner that happened to accept it. Running the passes raw is now
 * a caller naming both of them.
 */
export async function repointPageEmbeddings(
  executor: RawExecutor,
  projectId: string,
  order: readonly PageOrderEntry[]
): Promise<void> {
  const passes = pageEmbeddingRepointPasses(projectId, order);
  if (!passes) {
    return;
  }
  await executor.$executeRawUnsafe(passes.park.sql, ...passes.park.params);
  await assertNoDisplacedPageEmbeddingScopes(executor, projectId);
  await executor.$executeRawUnsafe(passes.land.sql, ...passes.land.params);
}

/**
 * Throws rather than letting pass two raise `23505` from inside the
 * restructure.
 *
 * Runs on every re-point that parked a row, unconditionally. It has no arm that
 * declines to look: {@link RawExecutor} requires the read, so an executor that
 * cannot answer the probe fails at the call — loudly, in a test — instead of
 * turning the assertion into a no-op nothing reports.
 */
async function assertNoDisplacedPageEmbeddingScopes(executor: RawExecutor, projectId: string): Promise<void> {
  const probe = pageEmbeddingRepointCollisionQuery(projectId);
  const collisions = await executor.$queryRawUnsafe<PageEmbeddingRepointCollision[]>(probe.sql, ...probe.params);
  if (collisions.length > 0) {
    throw new PageEmbeddingRepointCollisionError(projectId, collisions);
  }
}

export async function repointPageContinuityNotes(
  executor: RawExecutor,
  projectId: string,
  order: readonly PageOrderEntry[]
): Promise<void> {
  await runPageOrderingStatements(executor, pageContinuityNoteRepointStatements(projectId, order));
}

/**
 * A transaction client, or the client itself — both can run a raw statement and
 * both can read one back.
 *
 * The read is required, and it is required for a safety reason rather than a
 * tidiness one. {@link repointPageEmbeddings} parks rows and then asks this
 * executor whether pass two is about to land one of them on a live scope; an
 * executor that cannot be asked cannot be guarded. The property was optional
 * once, purely so a hand-written stand-in stayed a legal executor — and the
 * cost was that the assertion disabled itself for exactly those stand-ins, so a
 * suite could cover the re-point and cover none of its guard. Every production
 * executor is a `PrismaClient` or one of its transaction clients and carries
 * both methods, so the optionality described nothing production ever did.
 * A stand-in that runs a re-point now has to say what the probe returns, which
 * is the question its test was pretending to ask.
 */
export type RawExecutor = {
  $executeRawUnsafe: (sql: string, ...params: unknown[]) => Promise<number>;
  $queryRawUnsafe: <T = unknown>(sql: string, ...params: unknown[]) => Promise<T>;
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
 * Final manuscript publications can legitimately touch every page while they
 * hold the Project-first delivery fence. Keep that atomic window bounded, but
 * give bulk page replacement and the accompanying plan writes room beyond
 * Prisma's 5 s interactive-transaction default.
 */
export const MANUSCRIPT_PUBLICATION_TRANSACTION_OPTIONS = {
  timeout: 30_000,
  maxWait: 10_000
} satisfies { timeout: number; maxWait: number };

/** Structural publication uses the shared manuscript-wide transaction budget. */
export const PAGE_RESTRUCTURE_TRANSACTION_OPTIONS = MANUSCRIPT_PUBLICATION_TRANSACTION_OPTIONS;

/** Re-exported so callers do not have to import Prisma just to type a tx. */
export type PageOrderingTransaction = Prisma.TransactionClient;
