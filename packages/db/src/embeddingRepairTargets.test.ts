import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  queryRawUnsafe: vi.fn(async (_sql: string, ..._params: unknown[]) => [] as unknown[])
}));

vi.mock("./client.ts", () => ({
  prisma: { $queryRawUnsafe: mocks.queryRawUnsafe },
  PrismaClient: class PrismaClient {},
  Prisma: {}
}));

const { embeddingIsDegraded, findPageEmbeddingRepairTargets } = await import("./embeddingRepairTargets.ts");
const { DEGRADED_EMBEDDING_SHAPES } = await import("./testing/degradedEmbeddingShapes.ts");

beforeEach(() => {
  mocks.queryRawUnsafe.mockReset();
  mocks.queryRawUnsafe.mockResolvedValue([]);
});

/**
 * Shape and parameterisation only. What the predicate actually *selects* — real
 * holes, degraded rows, the backoff window, a parked scope — is measured against
 * a real Postgres in `embeddingRepairTargets.integration.test.ts`, because a
 * hand-written NOT EXISTS anti-join with a JSON metadata predicate is exactly
 * the thing a mock cannot vouch for.
 */
describe("findPageEmbeddingRepairTargets", () => {
  async function capture(options?: { projectId?: string; beforeIndex?: number; limit?: number }) {
    await findPageEmbeddingRepairTargets({
      projectId: options?.projectId ?? "project-1",
      beforeIndex: options?.beforeIndex ?? 232,
      limit: options?.limit ?? 3
    });
    const [sql, ...params] = mocks.queryRawUnsafe.mock.calls[0] ?? [];
    return { sql: String(sql), params };
  }

  it("correlates the page's own scope by equality and never by prefix", async () => {
    const { sql } = await capture();

    // Exact equality is what a scope parked under EMBEDDING_REPOINT_PARK_PREFIX
    // by a renumber can never satisfy.
    expect(sql).toContain(`e."scope" = 'page:' || p."index"::text`);
    expect(sql).not.toContain("LIKE 'page:%'");
  });

  /**
   * An anti-join rather than an outer join, because it is the only shape the
   * `LIMIT` can stop early inside: measured on a 300-page book, `LEFT JOIN …
   * IS NULL` plans as a merge join over both whole sets (two sorts, 2.1 ms)
   * while this walks the page index and stops at the third hole (0.14 ms, and
   * 0.72 ms when the book is intact). It also cannot emit a page twice on a
   * database that predates migration 000056's unique index.
   */
  it("asks for the absence of a usable row rather than joining every row in", async () => {
    const { sql } = await capture();

    expect(sql).toContain("NOT EXISTS");
    expect(sql).not.toContain("LEFT JOIN");
  });

  /**
   * A row with no vector is still a hole — the placeholder keeps the summary
   * lexically recallable but the cosine arm can never return it — so the inner
   * predicate is "not (degraded and waited out)", not bare existence.
   *
   * `IS TRUE` is the load-bearing half. Healthy metadata carries no
   * `vectorStored` key, so `->` yields SQL NULL, and `NOT (NULL AND …)` is NULL
   * — which drops the row from the subquery and declares every healthy page a
   * hole. Measured: without it the query offered all 300 pages of an intact
   * book for re-embedding.
   */
  it("counts a degraded row as a hole, comparing the JSON boolean and never leaving it NULL", async () => {
    const { sql } = await capture();

    expect(sql).toContain(`(e."metadata"->'vectorStored' = 'false'::jsonb) IS TRUE`);
    expect(sql).not.toContain(`->>'vectorStored'`);
  });

  /**
   * The anti-starvation ordering, asserted structurally: the backoff sits in the
   * `WHERE`, so the `LIMIT` cuts what survives it. A limit taken first would hand
   * every slot to the three scopes a provider refuses, on every page job, and the
   * ordinary hole behind them would never be repaired.
   */
  it("puts the backoff predicate in the WHERE clause, ahead of the LIMIT", async () => {
    const { sql } = await capture({ limit: 3 });

    const backoff = sql.indexOf("repairRetryFromIndex");
    const where = sql.indexOf("NOT EXISTS");
    const limit = sql.indexOf("LIMIT 3");
    expect(backoff).toBeGreaterThan(where);
    expect(where).toBeGreaterThan(-1);
    expect(limit).toBeGreaterThan(backoff);
    expect(sql).toContain(`ORDER BY p."index" ASC`);
  });

  /**
   * `jsonb_typeof` inside a `CASE`, never a guard beside the cast in an `AND`:
   * Postgres does not promise to evaluate `AND` left to right, so a corrupt
   * `"repairAttempts": "two"` could otherwise reach `::numeric` and take the
   * whole query down. Same reasoning as `pageScopeIndexSql`'s `substring`.
   */
  it("guards both metadata counters with jsonb_typeof inside a CASE", async () => {
    const { sql } = await capture();

    for (const key of ["repairAttempts", "repairRetryFromIndex"]) {
      expect(sql).toContain(`CASE WHEN jsonb_typeof(e."metadata"->'${key}') = 'number'`);
    }
  });

  it("parameterises the project and the index bound, and clamps the limit", async () => {
    const { sql, params } = await capture({ projectId: "project-9", beforeIndex: 232.7, limit: 0 });

    expect(params).toEqual(["project-9", 232]);
    expect(sql).toContain(`p."projectId" = $1`);
    expect(sql).toContain(`p."index" < $2::int`);
    // The trailing one: the attempt-count subquery carries a `LIMIT 1` of its
    // own, so `toContain` would pass for any outer limit at all.
    expect(sql.trimEnd().endsWith("LIMIT 1")).toBe(true);
  });

  it("only ever offers a settled page with something to embed", async () => {
    const { sql } = await capture();

    expect(sql).toContain(`p."status" = 'COMPLETED'`);
    // The `summary.trim()` guard this replaced: a blank summary must not hold a
    // repair slot. POSIX `[:space:]` covers the newline-only summaries `btrim`
    // with its default space-only set would have let through.
    expect(sql).toContain(`p."summary" ~ '[^[:space:]]'`);
  });

  it("returns the page id, index, summary and attempt count the repair pass needs", async () => {
    mocks.queryRawUnsafe.mockResolvedValueOnce([
      { id: "page-row-7", index: 7, summary: "Page seven summary.", attempts: 2 }
    ]);

    await expect(findPageEmbeddingRepairTargets({ projectId: "project-1", beforeIndex: 30, limit: 3 })).resolves.toEqual(
      [{ pageId: "page-row-7", index: 7, summary: "Page seven summary.", attempts: 2 }]
    );
  });
});

/**
 * The other language the degraded rule is written in, over the same shapes the
 * SQL is judged on.
 *
 * `embeddingIsDegraded` and `degradedEmbeddingSql` sit in one file because they
 * cannot sit in one function: this one tests a value Prisma handed back, that
 * one builds a predicate over a `jsonb` column. `DEGRADED_EMBEDDING_SHAPES` is
 * where the rule is actually *stated* — this pins the function to it with no
 * database, and `embeddingRepairTargets.integration.test.ts` seeds every one of
 * those shapes into Postgres and compares the query's verdict against this
 * function's, so a change to either expression that the other does not follow
 * has somewhere to fail.
 *
 * The string `"false"` is the case that pays for the table: it is what a
 * `metadata->>'vectorStored' = 'false'` would call degraded and this never does.
 */
describe("embeddingIsDegraded", () => {
  it.each([...DEGRADED_EMBEDDING_SHAPES])("answers $degraded for $label", ({ metadata, degraded }) => {
    expect(embeddingIsDegraded(metadata)).toBe(degraded);
  });
});
