import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  queryRawUnsafe: vi.fn(async (_sql: string, ..._params: unknown[]) => [] as unknown[])
}));

vi.mock("./client.ts", () => ({
  prisma: { $queryRawUnsafe: mocks.queryRawUnsafe },
  PrismaClient: class PrismaClient {},
  Prisma: {}
}));

const { fuseHybridEmbeddingRanks, retrieveHybridEmbeddings } = await import("./hybridRetrieval.ts");

/** Matches `1 / (RRF_K + rank + 1)` with RRF_K = 60 in `fuseHybridEmbeddingRanks`. */
function rrfScore(rank: number): number {
  return 1 / (60 + rank + 1);
}

function similar(id: string, similarity: number) {
  return {
    id,
    scope: `page:${id}`,
    sourceId: id,
    text: `${id} text`,
    similarity
  };
}

beforeEach(() => {
  mocks.queryRawUnsafe.mockReset();
  mocks.queryRawUnsafe.mockResolvedValue([]);
});

describe("fuseHybridEmbeddingRanks", () => {
  it("adds RRF contributions when both arms rank the same id at 0", () => {
    const vector = similar("both", 0.7);
    const lexical = similar("both", 0.9);
    const [row] = fuseHybridEmbeddingRanks([vector], [lexical], 8);

    expect(row?.id).toBe("both");
    expect(row?.fusedScore).toBe(rrfScore(0) + rrfScore(0));
    expect(row?.similarity).toBe(0.7);
    expect(row?.cosineSimilarity).toBe(0.7);
    expect(row?.lexicalSimilarity).toBe(0.9);
  });

  it("scores a vector-only rank 0 as 1/61", () => {
    const [row] = fuseHybridEmbeddingRanks([similar("vec", 0.8)], [], 8);

    expect(row?.id).toBe("vec");
    expect(row?.fusedScore).toBe(rrfScore(0));
    expect(row?.similarity).toBe(0.8);
    expect(row?.cosineSimilarity).toBe(0.8);
    expect(row?.lexicalSimilarity).toBe(0);
  });

  it("scores a lexical-only rank 0 as 1/61 with cosine fields zeroed", () => {
    const [row] = fuseHybridEmbeddingRanks([], [similar("lex", 0.91)], 8);

    expect(row?.id).toBe("lex");
    expect(row?.fusedScore).toBe(rrfScore(0));
    expect(row?.similarity).toBe(0);
    expect(row?.cosineSimilarity).toBe(0);
    expect(row?.lexicalSimilarity).toBe(0.91);
  });

  it("lets a dual-arm row outrank a stronger single-arm neighbor", () => {
    const fused = fuseHybridEmbeddingRanks(
      [similar("strong", 0.99), similar("dual", 0.4)],
      [similar("dual", 0.9)],
      8
    );

    expect(fused.map((row) => row.id)).toEqual(["dual", "strong"]);
    expect(fused[0]?.fusedScore).toBe(rrfScore(1) + rrfScore(0));
    expect(fused[1]?.fusedScore).toBe(rrfScore(0));
    expect(fused[0]?.fusedScore).toBeGreaterThan(fused[1]?.fusedScore ?? 0);
  });

  it("cuts to topK after sorting by fusedScore descending", () => {
    const fused = fuseHybridEmbeddingRanks(
      [similar("a", 0.9), similar("b", 0.8), similar("c", 0.7)],
      [],
      2
    );

    expect(fused.map((row) => row.id)).toEqual(["a", "b"]);
  });

  /**
   * What a degraded arm costs: nothing but its own rows. Fusing over one empty
   * ranking must not reorder the survivor, shorten it below `topK`, or move any
   * score — a row's RRF score is a sum over the rankings it appears in, so the
   * absent arm contributes zero rather than a penalty. Asserted for both arms
   * because either one is the one that can go missing.
   */
  it.each([
    { failed: "lexical", fuse: (rows: ReturnType<typeof similar>[]) => fuseHybridEmbeddingRanks(rows, [], 8) },
    { failed: "vector", fuse: (rows: ReturnType<typeof similar>[]) => fuseHybridEmbeddingRanks([], rows, 8) }
  ])("leaves the surviving arm's order, length and scores alone when the $failed arm is empty", ({ fuse }) => {
    const rows = [similar("a", 0.9), similar("b", 0.8), similar("c", 0.7), similar("d", 0.6)];

    const fused = fuse(rows);

    expect(fused.map((row) => row.id)).toEqual(["a", "b", "c", "d"]);
    expect(fused.map((row) => row.fusedScore)).toEqual([rrfScore(0), rrfScore(1), rrfScore(2), rrfScore(3)]);
  });
});

describe("retrieveHybridEmbeddings", () => {
  /** Everything one `$queryRawUnsafe` call bound — its arguments after the SQL. */
  function paramsOf(call: unknown[]): unknown[] {
    return call.slice(1);
  }

  it("skips the cosine arm when vector is empty and still runs lexical search", async () => {
    await retrieveHybridEmbeddings({
      projectId: "project-1",
      vector: [],
      queryTerms: ["brass key"],
      rethrowIf: null
    });

    expect(mocks.queryRawUnsafe).toHaveBeenCalledTimes(1);
    const sql = String(mocks.queryRawUnsafe.mock.calls[0]?.[0]);
    expect(sql).toContain("strict_word_similarity");
    expect(sql).not.toContain("<=>");
  });

  it("bounds both arms when beforePageIndex is set", async () => {
    await retrieveHybridEmbeddings({
      projectId: "project-1",
      vector: [0.1, 0.2],
      queryTerms: ["the vault"],
      scopePrefix: "page:",
      beforePageIndex: 30,
      rethrowIf: null
    });

    const calls = mocks.queryRawUnsafe.mock.calls;
    expect(calls).toHaveLength(2);
    // Both arms, or a page the cosine arm alone found could still be fused in.
    expect(calls.every((call) => String(call[0]).includes(`from '^page:([0-9]{1,9})$')::int <`))).toBe(true);
    expect(calls.every((call) => call.includes(30))).toBe(true);
  });

  /**
   * The rest of the scope filter, asserted the same way and for the same
   * reason. Every field of an `EmbeddingScopeFilter` is optional, so a field
   * that reaches one arm and not the other compiles, runs, and quietly makes
   * the fusion a comparison between two different candidate sets — a fused
   * score is a sum over ranks, and a rank carries no trace of the population it
   * was drawn from. That is why the filter is derived once in
   * `retrieveHybridEmbeddings` and spread into both calls, and why each field
   * is measured on *both* arms' emitted SQL rather than on whichever arm was
   * convenient to look at.
   */
  it("narrows both arms when scopePrefix is set", async () => {
    await retrieveHybridEmbeddings({
      projectId: "project-1",
      vector: [0.1, 0.2],
      queryTerms: ["the vault"],
      scopePrefix: "research:",
      rethrowIf: null
    });

    const calls = mocks.queryRawUnsafe.mock.calls;
    expect(calls).toHaveLength(2);
    expect(calls.every((call) => /"scope" LIKE \$\d+/.test(String(call[0])))).toBe(true);
    expect(calls.every((call) => call.includes("research:%"))).toBe(true);
  });

  it("excludes from both arms when excludeScopes is set", async () => {
    const excludeScopes = ["page:11", "page:12"];

    await retrieveHybridEmbeddings({
      projectId: "project-1",
      vector: [0.1, 0.2],
      queryTerms: ["the vault"],
      scopePrefix: "page:",
      excludeScopes,
      rethrowIf: null
    });

    const calls = mocks.queryRawUnsafe.mock.calls;
    expect(calls).toHaveLength(2);
    expect(calls.every((call) => /"scope" = ANY\(\$\d+::text\[\]\)/.test(String(call[0])))).toBe(true);
    expect(calls.map((call) => paramsOf(call))).toEqual([
      expect.arrayContaining([excludeScopes]),
      expect.arrayContaining([excludeScopes])
    ]);
  });

  /**
   * The falsy bound that means something. `beforePageIndex` is tested against
   * `undefined` rather than for truthiness — unlike the two above — because 0
   * is a real bound: the book's first page, whose long-range memory may reach
   * no earlier page at all. A truthiness test would drop it on both arms at
   * once and hand that page the whole book.
   */
  it("bounds both arms when beforePageIndex is 0", async () => {
    await retrieveHybridEmbeddings({
      projectId: "project-1",
      vector: [0.1, 0.2],
      queryTerms: ["the vault"],
      scopePrefix: "page:",
      beforePageIndex: 0,
      rethrowIf: null
    });

    const calls = mocks.queryRawUnsafe.mock.calls;
    expect(calls).toHaveLength(2);
    expect(calls.every((call) => String(call[0]).includes(`from '^page:([0-9]{1,9})$')::int <`))).toBe(true);
    expect(calls.every((call) => call.includes(0))).toBe(true);
  });

  /**
   * And the emptiness that means nothing, which is why those two are truthiness
   * tests: an empty prefix and an empty exclusion list narrow no candidate set,
   * so neither arm may bind one. `LIKE '%'` and `= ANY('{}')` are not the same
   * query — the second returns nothing at all.
   */
  it("filters neither arm when scopePrefix and excludeScopes are empty", async () => {
    await retrieveHybridEmbeddings({
      projectId: "project-1",
      vector: [0.1, 0.2],
      queryTerms: ["the vault"],
      scopePrefix: "",
      excludeScopes: [],
      rethrowIf: null
    });

    const calls = mocks.queryRawUnsafe.mock.calls;
    expect(calls).toHaveLength(2);
    expect(calls.every((call) => !String(call[0]).includes("LIKE"))).toBe(true);
    expect(calls.every((call) => !String(call[0]).includes("ANY("))).toBe(true);
    // Each arm bound its own two parameters and nothing else.
    expect(calls.map((call) => paramsOf(call).length)).toEqual([2, 2]);
  });

  /**
   * The cross-arm comparison `retrievalQuery.test.ts` makes of the builder,
   * made here of the hybrid that feeds it. The four tests above each name a
   * field, so each of them is a field somebody remembered; this one names none
   * — it isolates whatever the filter contributed to each arm's `WHERE` and
   * compares the two whole. A scope condition is identifiable by the column it
   * names, since `"scope"` appears in neither arm's own conditions, and the two
   * spellings of that column are the only thing normalised away. Both arms bind
   * two parameters of their own, so the filter numbers itself from `$3` in
   * each and the placeholders have to match too.
   *
   * So a fourth field added to `EmbeddingScopeFilter` and forwarded to one arm
   * fails here without anyone having to remember this file exists.
   */
  it("hands both arms the same scope conditions, numbered against the same parameters", async () => {
    await retrieveHybridEmbeddings({
      projectId: "project-1",
      vector: [0.1, 0.2],
      queryTerms: ["the vault"],
      scopePrefix: "page:",
      excludeScopes: ["page:11"],
      beforePageIndex: 30,
      rethrowIf: null
    });

    const scopeConditions = mocks.queryRawUnsafe.mock.calls.map(
      (call) =>
        String(call[0])
          .split(/\bWHERE\b/)[1]
          ?.split(/\bORDER BY\b/)[0]
          ?.split(" AND ")
          .map((condition) => condition.trim().replaceAll(`e."scope"`, `"scope"`))
          .filter((condition) => condition.includes(`"scope"`)) ?? []
    );

    expect(scopeConditions).toHaveLength(2);
    // Not vacuous: all three fields were set, so three conditions are expected.
    expect(scopeConditions[0]).toHaveLength(3);
    expect(scopeConditions[1]).toEqual(scopeConditions[0]);
  });

  it.each([
    { topK: 8, limit: 24 },
    { topK: 1, limit: 20 },
    { topK: 50, limit: 50 }
  ])("pools each arm to LIMIT $limit when topK is $topK", async ({ topK, limit }) => {
    await retrieveHybridEmbeddings({
      projectId: "project-1",
      vector: [0.1, 0.2],
      queryTerms: ["Tomas"],
      topK,
      rethrowIf: null
    });

    const sqls = mocks.queryRawUnsafe.mock.calls.map((call) => String(call[0]));
    expect(sqls).toHaveLength(2);
    expect(sqls.some((sql) => sql.includes("<=>"))).toBe(true);
    expect(sqls.some((sql) => sql.includes("strict_word_similarity"))).toBe(true);
    expect(sqls.every((sql) => sql.includes(`LIMIT ${limit}`))).toBe(true);
  });
});

/**
 * Arm isolation. A database where `CREATE EXTENSION pg_trgm` never applied
 * fails the trigram arm on every call, and under `Promise.all` that took the
 * *cosine* arm down with it: `retrieveSemanticPageMemory` caught the rejection
 * and returned `[]`, so every page past the recency window lost all long-range
 * continuity — strictly worse than the vector-only behaviour the lexical arm
 * was added to improve on.
 *
 * The failure census inside `degradeRetrievalArm` is process-wide and keyed by
 * (arm, message), so each case below uses a message of its own. That is also
 * the point being asserted in "reports a chronic arm failure on a ladder": the
 * key is the failure, not the arm, so a new fault still speaks up. The ladder it
 * reports on — the first occurrence, then every power of ten — is measured in
 * that helper's own suite.
 */
describe("retrieveHybridEmbeddings arm isolation", () => {
  const vectorRow = { id: "v1", scope: "page:4", sourceId: "p4", text: "Vector row.", similarity: 0.7 };
  const lexicalRow = { id: "l1", scope: "page:9", sourceId: "p9", text: "Lexical row.", similarity: 0.9 };

  /** Stands in for the worker's `StopRequestedError` and `isStopRequestedError`. */
  class StopRequestedError extends Error {
    constructor() {
      super("Generation stopped");
      this.name = "StopRequestedError";
    }
  }
  const isStop = (error: unknown): boolean => error instanceof StopRequestedError;

  /**
   * Answers by which arm's SQL arrived rather than by call order — the arms are
   * started together and only the fusion afterwards is ordered.
   */
  function answerArms(answers: { vector: unknown[] | Error; lexical: unknown[] | Error }) {
    mocks.queryRawUnsafe.mockImplementation(async (sql: string) => {
      const answer = String(sql).includes("strict_word_similarity") ? answers.lexical : answers.vector;
      if (answer instanceof Error) {
        throw answer;
      }
      return answer;
    });
  }

  const hybrid = (overrides: { vector?: number[]; queryTerms?: string[]; rethrowIf?: (error: unknown) => boolean } = {}) =>
    retrieveHybridEmbeddings({
      projectId: "project-1",
      vector: overrides.vector ?? [0.1, 0.2],
      queryTerms: overrides.queryTerms ?? ["the vault"],
      scopePrefix: "page:",
      beforePageIndex: 30,
      rethrowIf: overrides.rethrowIf ?? null
    });

  it("returns the vector arm's rows when the lexical arm rejects", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    answerArms({
      vector: [vectorRow],
      lexical: new Error("function strict_word_similarity(text, text) does not exist")
    });

    const rows = await hybrid();

    expect(rows).toEqual([
      expect.objectContaining({
        id: "v1",
        scope: "page:4",
        fusedScore: rrfScore(0),
        similarity: 0.7,
        cosineSimilarity: 0.7,
        lexicalSimilarity: 0
      })
    ]);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      "Lexical embedding retrieval failed for project project-1",
      expect.objectContaining({ message: "function strict_word_similarity(text, text) does not exist" })
    );
    warn.mockRestore();
  });

  it("returns the lexical arm's rows when the vector arm rejects", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    answerArms({
      vector: new Error("operator does not exist: vector <=> vector"),
      lexical: [lexicalRow]
    });

    const rows = await hybrid();

    expect(rows).toEqual([
      expect.objectContaining({
        id: "l1",
        scope: "page:9",
        fusedScore: rrfScore(0),
        similarity: 0,
        cosineSimilarity: 0,
        lexicalSimilarity: 0.9
      })
    ]);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      "Vector embedding retrieval failed for project project-1",
      expect.objectContaining({ message: "operator does not exist: vector <=> vector" })
    );
    warn.mockRestore();
  });

  it("reports a chronic arm failure on a ladder, and a new failure on its own line", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    answerArms({ vector: [vectorRow], lexical: new Error("pg_trgm is not installed in this database") });

    await expect(hybrid()).resolves.toHaveLength(1);
    await expect(hybrid()).resolves.toHaveLength(1);
    // Two occurrences, one line, for a fault that repeats on every page of
    // every book — the ladder's next rung is the 10th...
    expect(warn).toHaveBeenCalledTimes(1);

    answerArms({ vector: [vectorRow], lexical: new Error('syntax error at or near "FROM"') });
    await expect(hybrid()).resolves.toHaveLength(1);
    // ...and still a line for the one nobody has seen before.
    expect(warn).toHaveBeenCalledTimes(2);
    warn.mockRestore();
  });

  it("throws both reasons when both engaged arms fail, rather than reporting an empty result", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    answerArms({
      vector: new Error("vector arm connection reset"),
      lexical: new Error("lexical arm connection reset")
    });

    const error = await hybrid().catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(AggregateError);
    expect((error as AggregateError).message).toContain("project-1");
    expect((error as AggregateError).errors.map((reason: Error) => reason.message).sort()).toEqual([
      "lexical arm connection reset",
      "vector arm connection reset"
    ]);
    // Nothing was degraded, so nothing is reported here — the caller logs it.
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  /**
   * An arm the caller never engaged is not a survivor to fall back on: with no
   * vector there is only the trigram arm, and swallowing its failure would hand
   * back an empty result that looks like "no page matched".
   */
  it("propagates the lexical failure in lexical-only mode", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    answerArms({ vector: [vectorRow], lexical: new Error("lexical-only outage") });

    await expect(hybrid({ vector: [] })).rejects.toThrow("lexical-only outage");
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it("propagates the vector failure in vector-only mode", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    answerArms({ vector: new Error("vector-only outage"), lexical: [lexicalRow] });

    await expect(hybrid({ queryTerms: ["  "] })).rejects.toThrow("vector-only outage");
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  /**
   * A stop is not a retrieval fault, and a degrade is what a caller reads as
   * success. `rethrowIf` is how the arm policy is told which errors it may not
   * swallow — the worker passes its stop predicate — and both arms carry it,
   * because either one is the one whose query was cancelled.
   */
  it.each([
    { failing: "lexical", vector: () => [vectorRow] as unknown[], lexical: () => new StopRequestedError() },
    { failing: "vector", vector: () => new StopRequestedError(), lexical: () => [lexicalRow] as unknown[] }
  ])("propagates a stop from the $failing arm instead of degrading to the other arm's rows", async ({ vector, lexical }) => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    answerArms({ vector: vector(), lexical: lexical() });

    await expect(hybrid({ rethrowIf: isStop })).rejects.toBeInstanceOf(StopRequestedError);
    // Nothing degraded, so nothing was reported as a degrade either.
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it("throws the stop itself, not an AggregateError, when both arms fail and one is a stop", async () => {
    answerArms({ vector: new Error("vector arm reset beside a stop"), lexical: new StopRequestedError() });

    const error = await hybrid({ rethrowIf: isStop }).catch((thrown: unknown) => thrown);

    // `isStopRequestedError` does not look inside an `AggregateError`, so a
    // wrapped stop reaches the page job as an ordinary retrieval failure —
    // warned about, and answered with an empty memory.
    expect(error).toBeInstanceOf(StopRequestedError);
  });

  it("still degrades an ordinary failure while a rethrow predicate is set", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    answerArms({ vector: [vectorRow], lexical: new Error("ordinary lexical outage") });

    await expect(hybrid({ rethrowIf: isStop })).resolves.toHaveLength(1);
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it("queries nothing when neither arm has anything to search", async () => {
    await expect(
      retrieveHybridEmbeddings({ projectId: "project-1", vector: [], queryTerms: [" "], rethrowIf: null })
    ).resolves.toEqual([]);
    expect(mocks.queryRawUnsafe).not.toHaveBeenCalled();
  });
});

/**
 * The needles are cleaned — folded, trimmed, deduped, cut to the term limit —
 * exactly once per retrieval. They used to be cleaned twice: once here to read
 * how many survive, which is how the lexical arm's engagement is decided, and
 * again inside the arm itself. That is the same per-character fold run twice
 * over every needle, and — the part that is not merely wasteful — two
 * independent derivations of an answer the failure policy above settles a whole
 * call on, since an arm nobody engaged is not a survivor to degrade to.
 *
 * Counted through `trim()`, which `cleanLexicalTerms` calls exactly once per
 * term it is handed.
 */
describe("retrieveHybridEmbeddings needle cleaning", () => {
  function countingTerm(value: string): { term: string; trims: () => number } {
    let trims = 0;
    const counting = {
      trim: () => {
        trims += 1;
        return value;
      }
    };
    return { term: counting as unknown as string, trims: () => trims };
  }

  it("cleans each needle once, not once per arm that reads it", async () => {
    const key = countingTerm("brass key");
    const vault = countingTerm("the vault");

    await retrieveHybridEmbeddings({
      projectId: "project-1",
      vector: [0.1, 0.2],
      queryTerms: [key.term, vault.term],
      rethrowIf: null
    });

    expect([key.trims(), vault.trims()]).toEqual([1, 1]);
    // And the arm searched with what that one cleaning produced.
    const lexicalCall = mocks.queryRawUnsafe.mock.calls.find((call) =>
      String(call[0]).includes("strict_word_similarity")
    );
    expect(lexicalCall?.[2]).toEqual(["brass key", "the vault"]);
  });
});
