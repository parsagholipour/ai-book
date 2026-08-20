import { beforeEach, describe, expect, it, vi } from "vitest";
import type { EmbeddingScopeFilter } from "./retrievalQuery.ts";

const mocks = vi.hoisted(() => ({
  queryRawUnsafe: vi.fn(async (_sql: string, ..._params: unknown[]) => [] as unknown[])
}));

vi.mock("./client.ts", () => ({
  prisma: { $queryRawUnsafe: mocks.queryRawUnsafe },
  PrismaClient: class PrismaClient {},
  Prisma: {}
}));

const { DEFAULT_RETRIEVAL_TOP_K, embeddingScopeConditions, retrievalRowLimit, pageScopeIndexSql } = await import(
  "./retrievalQuery.ts"
);
const { retrieveSimilarEmbeddings } = await import("./embeddingRetrieval.ts");
const { LEXICAL_SIMILARITY_FLOOR, retrieveLexicalEmbeddings } = await import("./lexicalRetrieval.ts");

beforeEach(() => {
  mocks.queryRawUnsafe.mockReset();
  mocks.queryRawUnsafe.mockResolvedValue([]);
});

describe("retrievalRowLimit", () => {
  it("clamps a request into 1..50 and drops the fraction", () => {
    expect(retrievalRowLimit(0)).toBe(1);
    expect(retrievalRowLimit(-5)).toBe(1);
    expect(retrievalRowLimit(0.9)).toBe(1);
    expect(retrievalRowLimit(3.7)).toBe(3);
    expect(retrievalRowLimit(50)).toBe(50);
    expect(retrievalRowLimit(200)).toBe(50);
  });

  /**
   * The clamp takes a number, never `undefined`: `findPageEmbeddingRepairTargets`
   * clamps a *required* `limit` whose caller sets its own batch size, so a
   * default folded in here would hand the repair pass the memory arms' top-K.
   * The default is named beside it instead, and pinned to the value the four
   * arms each spelled inline before it had a name.
   */
  it("has no default of its own, and the arms' default is 8", () => {
    expect(DEFAULT_RETRIEVAL_TOP_K).toBe(8);
    expect(retrievalRowLimit(DEFAULT_RETRIEVAL_TOP_K)).toBe(DEFAULT_RETRIEVAL_TOP_K);
  });
});

describe("embeddingScopeConditions", () => {
  it("numbers its placeholders from one past the parameters already bound", () => {
    const built = embeddingScopeConditions({
      filter: { scopePrefix: "page:", excludeScopes: ["page:5", "page:6"], beforePageIndex: 12 },
      scopeColumn: `"scope"`,
      precedingParams: ["project-1", "[0.5]"]
    });

    expect(built.conditions).toEqual([
      `"scope" LIKE $3`,
      `NOT ("scope" = ANY($4::text[]))`,
      `${pageScopeIndexSql('"scope"')} < $5::int`
    ]);
    expect(built.params).toEqual(["project-1", "[0.5]", "page:%", ["page:5", "page:6"], 12]);
  });

  it("closes the gap when a filter is absent, so a placeholder always has its value", () => {
    const built = embeddingScopeConditions({
      filter: { excludeScopes: ["page:5"], beforePageIndex: 12 },
      scopeColumn: `e."scope"`,
      precedingParams: ["project-1", ["needle"]]
    });

    expect(built.conditions).toEqual([
      `NOT (e."scope" = ANY($3::text[]))`,
      `${pageScopeIndexSql('e."scope"')} < $4::int`
    ]);
    expect(built.params).toEqual(["project-1", ["needle"], ["page:5"], 12]);
  });

  it("skips an empty prefix and an empty exclusion list, but not a zero page bound", () => {
    const empty = embeddingScopeConditions({
      filter: { scopePrefix: "", excludeScopes: [], beforePageIndex: undefined },
      scopeColumn: `"scope"`,
      precedingParams: ["project-1"]
    });
    expect(empty.conditions).toEqual([]);
    expect(empty.params).toEqual(["project-1"]);

    // `0` is a real bound — "nothing before page 0" — not an absent one.
    const zero = embeddingScopeConditions({
      filter: { beforePageIndex: 0 },
      scopeColumn: `"scope"`,
      precedingParams: ["project-1"]
    });
    expect(zero.conditions).toEqual([`${pageScopeIndexSql('"scope"')} < $2::int`]);
    expect(zero.params).toEqual(["project-1", 0]);
  });

  it("floors a fractional page bound rather than letting ::int round it", () => {
    const built = embeddingScopeConditions({
      filter: { beforePageIndex: 30.7 },
      scopeColumn: `"scope"`,
      precedingParams: []
    });
    expect(built.params).toEqual([30]);
  });

  it("leaves the caller's parameter array alone", () => {
    const preceding: unknown[] = ["project-1"];
    embeddingScopeConditions({ filter: { scopePrefix: "page:" }, scopeColumn: `"scope"`, precedingParams: preceding });
    expect(preceding).toEqual(["project-1"]);
  });
});

/**
 * Reciprocal-rank fusion is only meaningful over **one** candidate set. The two
 * arms used to build this filter from two transcriptions of the same three
 * blocks — same order, same casts, a `let nextParam = 3` counted by hand on each
 * side — so a condition added to one and not the other would have made the
 * fusion a comparison between two different books, and nothing would have
 * failed. This is that missing failure.
 */
describe("the two hybrid arms filter scope identically", () => {
  const FILTERS: Array<{ name: string; filter: EmbeddingScopeFilter }> = [
    { name: "no filter", filter: {} },
    { name: "prefix only", filter: { scopePrefix: "page:" } },
    { name: "research prefix", filter: { scopePrefix: "research:" } },
    { name: "empty prefix", filter: { scopePrefix: "" } },
    { name: "exclusions only", filter: { excludeScopes: ["page:1", "page:2"] } },
    { name: "empty exclusions", filter: { excludeScopes: [] } },
    { name: "page bound only", filter: { beforePageIndex: 30 } },
    { name: "page bound of zero", filter: { beforePageIndex: 0 } },
    { name: "fractional page bound", filter: { beforePageIndex: 30.7 } },
    { name: "prefix and exclusions", filter: { scopePrefix: "page:", excludeScopes: ["page:5"] } },
    { name: "exclusions and page bound", filter: { excludeScopes: ["page:5"], beforePageIndex: 12 } },
    { name: "all three", filter: { scopePrefix: "page:", excludeScopes: ["page:5", "page:6"], beforePageIndex: 12 } }
  ];

  /**
   * The conditions each arm contributes that are *not* the scope filter. Named
   * exhaustively so the rest of the WHERE can be compared as a set: an extra
   * condition on one arm alone is the divergence this suite exists to catch, and
   * a test that only checked the shared conditions were *present* would pass
   * over it.
   */
  const VECTOR_ARM_OWN = [`"projectId" = $1`, `"vector" IS NOT NULL`];
  const LEXICAL_ARM_OWN = [
    `e."projectId" = $1`,
    `e."text" <> ''`,
    `match."similarity" > ${LEXICAL_SIMILARITY_FLOOR}`
  ];

  /**
   * Everything in an arm's WHERE but its own conditions, with the arm's spelling
   * of the scope column normalised away.
   */
  function scopeFilterOf(where: string, own: string[]): string[] {
    const parts = where.split(" AND ").map((part) => part.trim());
    for (const condition of own) {
      expect(parts).toContain(condition);
    }
    return parts.filter((part) => !own.includes(part)).map((part) => part.replace(/e\."scope"/g, `"scope"`));
  }

  /** The WHERE of the one query the arm emitted, and the parameters it bound. */
  async function armQuery(run: () => Promise<unknown>): Promise<{ sql: string; where: string; params: unknown[] }> {
    mocks.queryRawUnsafe.mockReset();
    mocks.queryRawUnsafe.mockResolvedValue([]);
    await run();
    const [sql, ...params] = mocks.queryRawUnsafe.mock.calls[0] ?? [];
    const where = /WHERE ([\s\S]*?)\n\s*ORDER BY/.exec(String(sql))?.[1];
    expect(where).toBeDefined();
    return { sql: String(sql), where: String(where), params };
  }

  for (const { name, filter } of FILTERS) {
    it(`applies the same conditions and values with ${name}`, async () => {
      const vectorArm = await armQuery(() =>
        retrieveSimilarEmbeddings({ projectId: "project-1", vector: [0.5, -0.25], ...filter })
      );
      const lexicalArm = await armQuery(() =>
        retrieveLexicalEmbeddings({ projectId: "project-1", queryTerms: ["brass key"], ...filter })
      );

      // What each arm's WHERE must literally contain, built once from the shared
      // builder in each arm's own spelling of the scope column.
      const vectorScope = embeddingScopeConditions({
        filter,
        scopeColumn: `"scope"`,
        precedingParams: ["project-1", "[0.5000000,-0.2500000]"]
      });
      const lexicalScope = embeddingScopeConditions({
        filter,
        scopeColumn: `e."scope"`,
        precedingParams: ["project-1", ["brass key"]]
      });

      // Neither arm filters scope by anything the other does not, and neither
      // filters by anything the shared builder did not put there.
      const vectorFilterInSql = scopeFilterOf(vectorArm.where, VECTOR_ARM_OWN);
      const lexicalFilterInSql = scopeFilterOf(lexicalArm.where, LEXICAL_ARM_OWN);
      expect(vectorFilterInSql).toEqual(lexicalFilterInSql);
      expect(vectorFilterInSql).toEqual(vectorScope.conditions);
      expect(lexicalFilterInSql).toEqual(
        lexicalScope.conditions.map((condition) => condition.replace(/e\."scope"/g, `"scope"`))
      );

      // And the values are the same values, bound at the same numbers.
      expect(vectorScope.params.slice(2)).toEqual(lexicalScope.params.slice(2));
      expect(vectorArm.params).toEqual(vectorScope.params);
      expect(lexicalArm.params).toEqual(lexicalScope.params);
    });
  }

  it("cuts both arms to the same default row count", async () => {
    const vectorArm = await armQuery(() => retrieveSimilarEmbeddings({ projectId: "project-1", vector: [0.5] }));
    const lexicalArm = await armQuery(() =>
      retrieveLexicalEmbeddings({ projectId: "project-1", queryTerms: ["brass key"] })
    );
    for (const arm of [vectorArm, lexicalArm]) {
      // Only the arm's own two parameters: an absent filter binds nothing.
      expect(arm.params).toHaveLength(2);
      expect(arm.sql).toContain(`LIMIT ${DEFAULT_RETRIEVAL_TOP_K}`);
    }
  });
});
