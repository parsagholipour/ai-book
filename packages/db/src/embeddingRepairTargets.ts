import { prisma } from "./client.ts";
import { retrievalRowLimit } from "./retrievalQuery.ts";

/**
 * Which pages have lost their long-range memory — the hole set the worker's
 * per-page repair pass fills. A query over `Page` and `Embedding` rather than
 * anything the retrieval arms do, and it is here because the derivation it
 * replaced pulled both tables across the wire to do the same work in memory.
 *
 * And the marker a lost row carries, in both of the languages that have to read
 * it: {@link embeddingIsDegraded} over a row Prisma handed back, and
 * {@link degradedEmbeddingSql} over the `jsonb` column itself. They cannot share
 * an implementation, so they share a file — the worker's research pass imports
 * the first through the package index rather than restating it, which is what it
 * used to do one package away from the query it had to agree with.
 */

/**
 * A page whose `page:<index>` memory row is missing or unusable, together with
 * the repair bookkeeping already charged to that scope.
 */
export type PageEmbeddingRepairTarget = {
  pageId: string;
  /** `Page.index` — the space every `page:<index>` scope is written in. */
  index: number;
  summary: string;
  /**
   * `metadata.repairAttempts` from the degraded placeholder. Zero when the
   * scope has no row at all, and zero for a placeholder written before the
   * count existed — both read as "never repaired here".
   */
  attempts: number;
};

/**
 * Whether a stored row is a degraded, vectorless placeholder.
 *
 * A row whose embedding call — or whose vector insert — failed is written down
 * rather than dropped (`apps/worker/src/generation/embeddingWrites.ts`): it
 * keeps the text, so it stays lexically recallable, and carries
 * `vectorStored: false` to say it holds no vector. Every pass that asks "is this
 * scope embedded" therefore has to answer *no* for it, or the failure is treated
 * as done forever and nothing ever re-embeds the row.
 *
 * The boolean `false`, never the string `"false"` — and metadata that is not a
 * JSON object at all (an array, a scalar, `null`) is not degraded, which is what
 * the `typeof` / `!Array.isArray` guards say.
 *
 * Kept beside {@link degradedEmbeddingSql} deliberately: the two are one rule
 * written in two languages and adjacency is the whole of what makes them change
 * together. `testing/degradedEmbeddingShapes.ts` is the other half of that —
 * one table of metadata shapes, pinned against this function in
 * `embeddingRepairTargets.test.ts` and against what Postgres does with the SQL
 * in the opt-in `embeddingRepairTargets.integration.test.ts`.
 */
export function embeddingIsDegraded(metadata: unknown): boolean {
  return (
    !!metadata &&
    typeof metadata === "object" &&
    !Array.isArray(metadata) &&
    (metadata as Record<string, unknown>).vectorStored === false
  );
}

/**
 * The same marker as SQL.
 *
 * Compared as **jsonb against the JSON boolean** rather than
 * `metadata->>'vectorStored' = 'false'`, so it means exactly what
 * {@link embeddingIsDegraded} above means: the boolean `false`, not the string
 * `"false"`.
 * Metadata that is not an object at all — an array, a JSON scalar, `null` —
 * yields SQL NULL from `->` and so is *not* degraded, which is the same answer
 * the `!Array.isArray` / `typeof === "object"` guards give.
 *
 * `IS TRUE` is what turns that NULL into `false`, and it is load-bearing rather
 * than defensive: {@link findPageEmbeddingRepairTargets} asks this question
 * *negated*, inside a `NOT EXISTS`, and `NOT (NULL AND …)` is NULL — which
 * excludes the row from the subquery and so declares the page a hole. Written
 * without it, every healthy row (whose metadata carries no `vectorStored` key at
 * all) reads as missing, and the pass re-embeds the whole manuscript.
 */
function degradedEmbeddingSql(metadataColumn: string): string {
  return `(${metadataColumn}->'vectorStored' = 'false'::jsonb) IS TRUE`;
}

/**
 * One of the repair counters as a number, or 0 for anything that is not a JSON
 * number — the mirror of the worker's `Number.isFinite` guard.
 *
 * `jsonb_typeof` inside a `CASE` rather than beside the cast in an `AND` for
 * the reason {@link pageScopeIndexSql} uses `substring`: Postgres does not
 * promise to evaluate `AND` left to right, so a guard-then-cast conjunction may
 * still reach `::numeric` on a string and error the whole query. `CASE` does
 * promise it. `numeric`, not `int`, because a corrupt row must not overflow the
 * comparison. `key` is always one of this module's own literals.
 */
function embeddingRepairCounterSql(metadataColumn: string, key: "repairAttempts" | "repairRetryFromIndex"): string {
  return (
    `CASE WHEN jsonb_typeof(${metadataColumn}->'${key}') = 'number' ` +
    `THEN (${metadataColumn}->>'${key}')::numeric ELSE 0 END`
  );
}

/**
 * The scope a page's own semantic memory is stored under, correlated to `p`.
 *
 * The literal is `PAGE_SCOPE_PREFIX` (`embeddingScopes.ts`) written in SQL,
 * because a query cannot call the builder every writer uses. The two have to
 * stay in step; keep the correlation exact equality on `'page:' || index`
 * rather than a prefix match, for the reason below.
 */
const PAGE_OWN_SCOPE_SQL = `'page:' || p."index"::text`;

/**
 * The pages whose long-range memory needs re-embedding, lowest index first.
 *
 * The hole set is derived **in the database**. The worker used to load every
 * COMPLETED page below `beforeIndex` — summaries and all — plus every `page:`
 * embedding row of the project, build two maps and discard them: on a 300-page
 * book that is ~85 KB of manuscript and ~230 rows pulled across the wire on
 * *each* of the 280 page jobs past the recency window, almost always to
 * conclude that nothing is broken. The answer is at most `limit` rows now, and
 * the scan that produces it never leaves Postgres.
 *
 * A page is a hole when it has no `page:<index>` row, or when the row it has is
 * a degraded placeholder ({@link degradedEmbeddingSql}) whose backoff has
 * expired. Degraded rows are deliberately still holes: the placeholder carries
 * the page's summary as `text` and stays lexically recallable, but it holds no
 * vector, so the cosine arm can never return it — a plain `LEFT JOIN ... IS
 * NULL` would call it repaired forever.
 *
 * **The backoff is a `WHERE` predicate, so the `LIMIT` is applied after it.**
 * That ordering is the anti-starvation property, not an incidental one: three
 * pages a provider refuses sit at the front of the index order, and a limit
 * taken before the backoff filter would hand them every slot on every page job
 * while the ordinary hole behind them was never repaired. See
 * `apps/worker/src/generation/embeddingRepair.ts` for the failure that bought
 * the rule.
 *
 * **`NOT EXISTS`, not `LEFT JOIN … IS NULL`, and the reason is the plan.** The
 * two are equivalent here, but the outer join is planned as a merge join over
 * both whole sets — measured on a 300-page book, two sorts and 2.1 ms, with the
 * `LIMIT` reached only after everything has been joined. The anti-join walks
 * `Page_projectId_index_key` in index order, probes `(projectId, scope)` once
 * per page and **stops at the third hole**: 0.72 ms when the book is intact and
 * 0.14 ms when the holes are near the front. It is also the shape that survives
 * a database predating migration `000056` — two rows on one scope would have
 * the outer join emit the page twice.
 *
 * The correlation is exact equality on `'page:' || index`, never a
 * `LIKE 'page:%'` prefix, so a scope parked under
 * {@link EMBEDDING_REPOINT_PARK_PREFIX} by a renumber cannot be read as this
 * page's row — as it also cannot be under the prefix filters, by that prefix's
 * design. (Parked rows live only between the two statements of one re-point,
 * inside the caller's transaction, so no reader outside it observes them at
 * all.)
 *
 * `beforeIndex` is a cost/race-reduction heuristic the caller sets a recency
 * window behind the page being drafted, not a uniqueness guarantee: a page
 * marked COMPLETED has not necessarily reached its own embedding write. The
 * `(projectId, scope)` unique index plus upsert is what settles a second write.
 */
export async function findPageEmbeddingRepairTargets(options: {
  projectId: string;
  /** Exclusive upper bound on `Page.index`, and the clock the backoff is measured on. */
  beforeIndex: number;
  limit: number;
}): Promise<PageEmbeddingRepairTarget[]> {
  // No default: `limit` is required here and its caller sets its own batch size,
  // which is not the retrieval arms' top-K.
  const limit = retrievalRowLimit(options.limit);
  const rows = await prisma.$queryRawUnsafe<
    Array<{ id: string; index: number; summary: string; attempts: number | string }>
  >(
    // The attempt count is a scalar subquery rather than a join column so the
    // anti-join above stays a plain anti-join; it runs only for the rows that
    // survive the LIMIT, and `LIMIT 1` keeps it total on a database that has
    // not yet taken migration 000056's unique index.
    `SELECT p."id", p."index", p."summary",
            COALESCE((
              SELECT LEAST(GREATEST(trunc(${embeddingRepairCounterSql('e."metadata"', "repairAttempts")}), 0), 1000000)::int
              FROM "Embedding" AS e
              WHERE e."projectId" = p."projectId" AND e."scope" = ${PAGE_OWN_SCOPE_SQL}
              LIMIT 1
            ), 0) AS "attempts"
     FROM "Page" AS p
     WHERE p."projectId" = $1
       AND p."status" = 'COMPLETED'
       AND p."index" < $2::int
       AND p."summary" ~ '[^[:space:]]'
       AND NOT EXISTS (
         SELECT 1
         FROM "Embedding" AS e
         WHERE e."projectId" = p."projectId"
           AND e."scope" = ${PAGE_OWN_SCOPE_SQL}
           AND NOT (${degradedEmbeddingSql('e."metadata"')}
                    AND $2::int >= ${embeddingRepairCounterSql('e."metadata"', "repairRetryFromIndex")})
       )
     ORDER BY p."index" ASC
     LIMIT ${limit}`,
    options.projectId,
    Math.floor(options.beforeIndex)
  );

  return rows.map((row) => ({
    pageId: row.id,
    index: Number(row.index),
    summary: row.summary,
    attempts: Number(row.attempts)
  }));
}
