/**
 * The pieces every retrieval query in this package is assembled from: the row
 * cap each one is cut to, the top-K each arm resolves, the scope filter the two
 * arms of a hybrid retrieval share, and the candidate row shape they come back
 * as. Nothing here reaches the database — it builds SQL fragments, numbers the
 * parameters they refer to and maps what a query already returned, which is
 * what lets the arms be compared against each other in a plain unit test
 * (`retrievalQuery.test.ts`) rather than only through two mocked query
 * builders.
 *
 * A module of its own rather than a corner of `embeddingRetrieval.ts`, because
 * `embeddingRepairTargets.ts` needs the row cap and is deliberately not one of
 * the arms — it queries `Page`, and importing the cosine arm to borrow a bound
 * would be the wrong edge.
 */

/**
 * The number of rows one retrieval query may return: at least one, at most 50,
 * whole. The ceiling is a cost bound — every row is prose that a prompt then
 * carries — and the floor keeps a caller that computed a zero or a negative
 * from emitting `LIMIT 0` and reading it as "nothing is relevant".
 *
 * Applied to the *requested* number, never to a default: a caller that has no
 * number of its own names the default it wants (see
 * {@link DEFAULT_RETRIEVAL_TOP_K}), because the repair pass's batch size is not
 * the memory arms' top-K and neither is anyone else's.
 */
export function retrievalRowLimit(requested: number): number {
  return Math.max(1, Math.min(50, Math.floor(requested)));
}

/**
 * How many rows a retrieval returns when its caller named no `topK`. Shared by
 * the cosine arm, the trigram arm, the fusion over both and the continuity-note
 * search, which want the same answer and only ever agreed by coincidence
 * before. Not the repair pass's `limit`, which is required and whose caller
 * supplies its own batch size.
 */
export const DEFAULT_RETRIEVAL_TOP_K = 8;

/**
 * {@link retrievalRowLimit} over a `topK` a caller may not have named — the one
 * spelling of "how many rows does this retrieval return" every arm, the fusion
 * over them and the continuity-note search use. It exists so
 * {@link DEFAULT_RETRIEVAL_TOP_K} is applied in one place rather than in four
 * copies of `options.topK ?? DEFAULT_RETRIEVAL_TOP_K`: those copies are what
 * let the arms disagree about a default before the constant had a name, and a
 * hybrid whose arms cut at a different depth than the fusion does is a
 * comparison over two differently-sized candidate sets.
 *
 * Not what `embeddingRepairTargets.ts` calls: its `limit` is required and
 * carries its caller's own batch size, so it clamps through
 * {@link retrievalRowLimit} directly and no default is ever folded into it.
 */
export function retrievalTopK(requested: number | undefined): number {
  return retrievalRowLimit(requested ?? DEFAULT_RETRIEVAL_TOP_K);
}

/**
 * The numeric index of a `page:<index>` scope, or NULL for any other shape —
 * `research:...`, an edit scope, {@link EMBEDDING_REPOINT_PARK_PREFIX}. Used as
 * `<expr> < $n`, so a NULL row is simply not returned.
 *
 * `substring(text from pattern)` is what makes the cast safe: it yields NULL
 * when the pattern misses, so `::int` never sees a non-numeric string. The
 * obvious `"scope" ~ '^page:[0-9]+$' AND substring(...)::int < $n` is not
 * safe — Postgres does not promise to evaluate `AND` left to right, and may
 * reach the cast on a `research:` row and error the whole retrieval. Digits are
 * capped at nine so no scope can overflow int4 either.
 */
export function pageScopeIndexSql(scopeColumn: string): string {
  return `substring(${scopeColumn} from '^page:([0-9]{1,9})$')::int`;
}

/**
 * The scope narrowing every embedding retrieval accepts, spelled once. Both
 * arms of {@link retrieveHybridEmbeddings} take these fields and hand them
 * straight to {@link embeddingScopeConditions}, which is the only reason a
 * fusion is over one candidate set rather than two.
 */
export type EmbeddingScopeFilter = {
  /** Restrict to embeddings whose scope starts with this prefix (e.g. "page:" or "research:"). */
  scopePrefix?: string | undefined;
  /** Exact scopes to exclude (e.g. pages already present in the recency window). */
  excludeScopes?: string[] | undefined;
  /**
   * Exclusive upper bound on a page scope's index: only `page:<index>` rows
   * with a smaller index survive. Belongs with `scopePrefix: "page:"` — see
   * {@link pageScopeIndexSql}, which resolves every other scope shape to NULL
   * and therefore drops it. Applied in SQL, ahead of each arm's own `LIMIT`,
   * so the bound narrows what the top-K is cut from rather than shrinking an
   * already-cut result.
   */
  beforePageIndex?: number | undefined;
};

/**
 * The `WHERE` conditions an {@link EmbeddingScopeFilter} contributes, together
 * with the full parameter list they are numbered against.
 *
 * **Both arms build their filter here, and that is the point.** Reciprocal-rank
 * fusion is only meaningful over one candidate set: an arm filtering by a
 * condition the other does not apply makes the fusion a comparison between two
 * different books. The two used to be two transcriptions of the same three
 * blocks — same order, same casts, and a `let nextParam = 3` counted by hand on
 * each side — with nothing but care keeping them equal.
 *
 * The conditions and the parameters come back together, and the numbering is
 * read off `params.length` rather than tracked in a counter, so a placeholder
 * cannot come to name a value that is not there. `precedingParams` is whatever
 * the surrounding query already bound (`$1`, `$2`, …); this filter numbers its
 * own from the next index up, and the caller passes the returned `params` to
 * `$queryRawUnsafe` whole.
 *
 * `scopeColumn` is how the scope is spelled in *this* query — `"scope"` in the
 * cosine arm's single-table select, `e."scope"` where the trigram arm aliases
 * it. It is a module constant at both call sites, never anything a request can
 * reach; the values are the only user input here and every one of them is
 * bound, not interpolated.
 */
export function embeddingScopeConditions(options: {
  filter: EmbeddingScopeFilter;
  scopeColumn: string;
  precedingParams: unknown[];
}): { conditions: string[]; params: unknown[] } {
  const { filter, scopeColumn } = options;
  const conditions: string[] = [];
  const params = [...options.precedingParams];
  if (filter.scopePrefix) {
    conditions.push(`${scopeColumn} LIKE $${params.length + 1}`);
    params.push(`${filter.scopePrefix}%`);
  }
  if (filter.excludeScopes && filter.excludeScopes.length > 0) {
    conditions.push(`NOT (${scopeColumn} = ANY($${params.length + 1}::text[]))`);
    params.push(filter.excludeScopes);
  }
  if (filter.beforePageIndex !== undefined) {
    conditions.push(`${pageScopeIndexSql(scopeColumn)} < $${params.length + 1}::int`);
    params.push(Math.floor(filter.beforePageIndex));
  }
  return { conditions, params };
}

/**
 * The candidate row **both arms of a hybrid retrieval must produce**, spelled
 * once. `similarity` is whatever that arm ranks by — cosine distance turned
 * into a similarity in `embeddingRetrieval.ts`, a best-needle
 * `strict_word_similarity` in `lexicalRetrieval.ts` — and is comparable only
 * within one arm.
 *
 * **The fusion in `hybridRetrieval.ts` depends on the agreement.**
 * `fuseHybridEmbeddingRanks` merges the two rankings by `id` and spreads a row
 * of either arm into one `HybridEmbedding`, so a field one arm selects and the
 * other does not is a field that is present or absent depending on which arm
 * happened to rank the page first — and nothing about an RRF score reveals it.
 * The shape was two hand-maintained transcriptions before, next to the `WHERE`
 * blocks that were two transcriptions until {@link embeddingScopeConditions}
 * was extracted; this closes the same hazard for the rows.
 */
export type RetrievalCandidate = {
  id: string;
  scope: string;
  sourceId: string | null;
  text: string;
  similarity: number;
};

/**
 * A {@link RetrievalCandidate} as `$queryRawUnsafe` hands it back, before
 * {@link mapRetrievalCandidates}. Only `similarity` differs: the driver may
 * decode a computed numeric as a string, which is why the coercion exists at
 * all — an un-coerced row sorts and sums as text, and `fuseHybridEmbeddingRanks`
 * would carry it into `cosineSimilarity`/`lexicalSimilarity` for a caller that
 * compares it against a floor.
 */
export type RetrievalCandidateSqlRow = Omit<RetrievalCandidate, "similarity"> & {
  similarity: number | string;
};

/** Maps an arm's raw rows into {@link RetrievalCandidate}s, coercing `similarity`. */
export function mapRetrievalCandidates(rows: RetrievalCandidateSqlRow[]): RetrievalCandidate[] {
  return rows.map((row) => ({
    id: row.id,
    scope: row.scope,
    sourceId: row.sourceId,
    text: row.text,
    similarity: Number(row.similarity)
  }));
}
