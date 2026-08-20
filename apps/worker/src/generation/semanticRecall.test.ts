import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * What a page recalls from beyond the recency window, and the lexical terms that
 * shape the query it recalls with. Everything written into the Embedding table
 * lives in `embeddingWrites.test.ts` and `embeddingRepair.test.ts`, and the
 * entity state the same context pack carries in `entityState.test.ts`.
 */
const mocks = await vi.hoisted(async () => ({
  retrieveHybridEmbeddings: vi.fn(),
  /**
   * The shared degrade stand-in from `testing/degradeRetrievalArmFake.ts`. Both
   * of this module's failure paths report through the shared policy rather than
   * a `console.warn` of their own, so what these tests have to check is that
   * the failure reached the policy at all — and that a stop still escapes it.
   */
  degradeRetrievalArm: (await import("./testing/degradeRetrievalArmFake.js")).createDegradeRetrievalArmFake()
}));

vi.mock("@book-maker/db", async () => ({
  retrieveHybridEmbeddings: mocks.retrieveHybridEmbeddings,
  degradeRetrievalArm: mocks.degradeRetrievalArm,
  ...(await import("../testing/dbScopeMocks.js")).dbScopeMocks()
}));

import type { BookPlan } from "@book-maker/core";
import { StopRequestedError } from "../runtime/jobTypes.js";
import { embedSemanticQuery, lexicalTermsForQuery, retrieveSemanticPageMemory } from "./semanticRecall.js";

describe("lexicalTermsForQuery", () => {
  const plan = {
    characters: [
      { name: "Tomas", role: "protagonist", description: "", traits: [] },
      { name: "علی", role: "mentor", description: "", traits: [] }
    ],
    locations: [
      { name: "The Vault of Hours", description: "", rules: [] },
      { name: "Harbor Market", description: "", rules: [] }
    ]
  } as unknown as BookPlan;

  it("returns only the entity names the composed query mentions", () => {
    const terms = lexicalTermsForQuery(
      plan,
      "Tomas descends into the Vault of Hours and confronts the archive."
    );

    expect(terms).toEqual(["Tomas", "The Vault of Hours"]);
  });

  it("does not pick a needle whose only overlap with the query is a consonant skeleton", () => {
    // The needle this returns is what the trigram arm searches on, so folding
    // two Hindi names together did not merely add a term — it sent the *wrong*
    // name to `strict_word_similarity` and recalled pages about someone else.
    const hindiPlan = {
      characters: [
        { name: "मीरा", role: "protagonist", description: "", traits: [] },
        { name: "मारा", role: "rival", description: "", traits: [] }
      ],
      locations: []
    } as unknown as BookPlan;

    expect(lexicalTermsForQuery(hindiPlan, "मारा ने चाबी छिपा दी।")).toEqual(["मारा"]);
  });

  it("matches a name across script variants through the fold", () => {
    // The plan saved "علی" from a Persian keyboard; the brief writes "علي"
    // with an Arabic yeh. The folded mention check still selects the name, and
    // it is emitted in the plan's own spelling: `@book-maker/db` folds the
    // needle *and* the column it is scored against, so the search this feeds
    // matches a summary spelled either way. It did not, for as long as the
    // name went to `strict_word_similarity` raw — see `foldLexicalText`.
    expect(lexicalTermsForQuery(plan, "علي نامه را در بازار می‌خواند.")).toEqual(["علی"]);
  });
});

describe("retrieveSemanticPageMemory", () => {
  beforeEach(() => vi.clearAllMocks());

  it("hands the needles to the trigram arm and keeps a row it vouched for past the cosine floor", async () => {
    mocks.retrieveHybridEmbeddings.mockResolvedValue([
      // Vector-only hit above the cosine floor: kept.
      { id: "e1", scope: "page:4", sourceId: "p4", text: "Summary four.", similarity: 0.4, fusedScore: 0.03, cosineSimilarity: 0.4, lexicalSimilarity: 0 },
      // Lexical-only hit — its needle cleared the word_similarity floor: kept.
      { id: "e2", scope: "page:9", sourceId: "p9", text: "The brass key summary.", similarity: 0, fusedScore: 0.02, cosineSimilarity: 0, lexicalSimilarity: 1 },
      // Weak vector hit nothing vouched for: dropped.
      { id: "e3", scope: "page:12", sourceId: "p12", text: "Unrelated.", similarity: 0.1, fusedScore: 0.01, cosineSimilarity: 0.1, lexicalSimilarity: 0 }
    ]);

    const memory = await retrieveSemanticPageMemory({
      projectId: "project-1",
      queryText: "Tomas opens the vault",
      lexicalTerms: ["Tomas"],
      embedding: { embed: async () => [0.1] },
      excludePageIndexes: [20, 21],
      beforePageIndex: 22,
      vector: [0.1]
    });

    expect(memory).toEqual(["Page 4: Summary four.", "Page 9: The brass key summary."]);
    expect(mocks.retrieveHybridEmbeddings).toHaveBeenCalledWith(
      expect.objectContaining({
        queryTerms: ["Tomas"],
        excludeScopes: ["page:20", "page:21"],
        beforePageIndex: 22
      })
    );
  });

  /**
   * The page being drafted is not the end of the embedded manuscript: pages
   * generate in waves, and a FAILED_QA retry redrafts a page whose successors
   * are COMPLETED and embedded. `search_memory("the vault")` from page 30 must
   * not come back with page 41, so the bound goes to the retrieval itself —
   * both arms filter before their own top-K, which a post-filter here could
   * not do without silently shrinking the result.
   */
  it("bounds the retrieval to pages before the one being drafted", async () => {
    mocks.retrieveHybridEmbeddings.mockResolvedValue([]);

    await retrieveSemanticPageMemory({
      projectId: "project-1",
      queryText: "the vault",
      lexicalTerms: ["the vault"],
      embedding: { embed: async () => [0.1] },
      excludePageIndexes: [29],
      beforePageIndex: 30,
      vector: [0.1]
    });

    expect(mocks.retrieveHybridEmbeddings).toHaveBeenCalledWith(
      expect.objectContaining({ scopePrefix: "page:", beforePageIndex: 30 })
    );
  });

  /**
   * A degraded arm reads as success: `retrieveHybridEmbeddings` answers a
   * failed arm with the other arm's rows, so a page job stopped mid-query would
   * come back with half a memory and the `catch` below would never see the
   * stop. The predicate is handed down rather than inferred, and it has to be
   * the worker's own — the db package cannot import it.
   */
  it("hands the retrieval a predicate that recognises a stop and nothing else", async () => {
    mocks.retrieveHybridEmbeddings.mockResolvedValue([]);

    await retrieveSemanticPageMemory({
      projectId: "project-1",
      queryText: "the vault",
      lexicalTerms: ["the vault"],
      embedding: { embed: async () => [0.1] },
      excludePageIndexes: [29],
      beforePageIndex: 30,
      vector: [0.1]
    });

    const passed = mocks.retrieveHybridEmbeddings.mock.calls[0]?.[0] as {
      rethrowIf?: ((error: unknown) => boolean) | null;
    };
    expect(passed.rethrowIf?.(new StopRequestedError())).toBe(true);
    expect(passed.rethrowIf?.(new Error("function strict_word_similarity(text, text) does not exist"))).toBe(false);
  });

  it("returns [] without retrieving when the query is empty", async () => {
    const memory = await retrieveSemanticPageMemory({
      projectId: "project-1",
      queryText: "   ",
      lexicalTerms: ["Tomas"],
      embedding: {
        embed: async () => {
          throw new Error("embed should not run");
        }
      },
      excludePageIndexes: [20],
      beforePageIndex: 22
    });

    expect(memory).toEqual([]);
    expect(mocks.retrieveHybridEmbeddings).not.toHaveBeenCalled();
  });

  it("runs lexical-only hybrid retrieval when embedding is down", async () => {
    mocks.retrieveHybridEmbeddings.mockResolvedValue([
      {
        id: "e2",
        scope: "page:9",
        sourceId: "p9",
        text: "The brass key summary.",
        similarity: 0,
        fusedScore: 0.02,
        cosineSimilarity: 0,
        lexicalSimilarity: 1
      }
    ]);
    const embed = vi.fn(async () => {
      throw new Error("provider down");
    });

    const memory = await retrieveSemanticPageMemory({
      projectId: "project-1",
      queryText: "Tomas opens the vault",
      lexicalTerms: ["Tomas", "the vault"],
      embedding: { embed },
      excludePageIndexes: [20, 21],
      beforePageIndex: 22
    });

    expect(embed).toHaveBeenCalled();
    expect(mocks.retrieveHybridEmbeddings).toHaveBeenCalledWith(
      expect.objectContaining({
        vector: [],
        queryTerms: ["Tomas", "the vault"]
      })
    );
    expect(memory).toEqual(["Page 9: The brass key summary."]);
    expect(mocks.degradeRetrievalArm).toHaveBeenCalledWith({
      arm: "Semantic query embedding",
      projectId: "project-1",
      error: expect.any(Error),
      fallback: undefined,
      // Not this arm's to swallow: the same embedding call raises the stop, and
      // a stopped run degraded to a lexical-only query would keep drafting.
      rethrowIf: expect.any(Function)
    });
  });

  /**
   * The degrade *looks* like success from here — an undefined vector is what a
   * provider outage leaves too — so the one thing separating a stopped run from
   * a narrowed one is the predicate handed to the shared policy. This asserts
   * the predicate rather than the option: a `rethrowIf` that recognised nothing
   * would satisfy `expect.any(Function)` above and swallow every stop.
   */
  it("lets a stopped run out of the query embedding instead of degrading it", async () => {
    const stop = new StopRequestedError();

    await expect(
      embedSemanticQuery(
        {
          embed: async () => {
            throw stop;
          }
        },
        "Tomas opens the vault",
        "project-1"
      )
    ).rejects.toBe(stop);
  });

  /**
   * The far end of the degradation ladder. One arm of the hybrid retrieval
   * failing never reaches here — `retrieveHybridEmbeddings` answers from the
   * other arm — so a rejection means *no* arm answered, and the page is written
   * from its recency window alone rather than not written at all. The degrade
   * is the only trace: a book generated against a database with neither
   * pg_trgm nor pgvector looks entirely healthy from the app, and the shared
   * policy is what stops that one fact printing once per page job.
   */
  it("writes the page from the recency window alone when the whole retrieval fails", async () => {
    mocks.retrieveHybridEmbeddings.mockRejectedValue(
      new AggregateError(
        [new Error("vector arm down"), new Error("function strict_word_similarity(text, text) does not exist")],
        "Hybrid embedding retrieval failed for project project-1"
      )
    );

    const memory = await retrieveSemanticPageMemory({
      projectId: "project-1",
      queryText: "Tomas opens the vault",
      lexicalTerms: ["Tomas"],
      embedding: { embed: async () => [0.1] },
      excludePageIndexes: [20, 21],
      beforePageIndex: 22,
      vector: [0.1]
    });

    expect(memory).toEqual([]);
    expect(mocks.degradeRetrievalArm).toHaveBeenCalledWith({
      arm: "Semantic memory retrieval",
      projectId: "project-1",
      error: expect.any(AggregateError),
      fallback: [],
      rethrowIf: expect.any(Function)
    });
  });

  /**
   * `retrieveHybridEmbeddings` re-raises a stop rather than degrading to one
   * arm's rows, so it arrives at the catch below as an ordinary rejection. It
   * has to leave the same way: an empty memory is what a real retrieval failure
   * returns, and a page written from its recency window alone is indis-
   * tinguishable downstream from a page that was never written at all.
   */
  it("lets a stopped run out of the retrieval instead of returning empty memory", async () => {
    const stop = new StopRequestedError();
    mocks.retrieveHybridEmbeddings.mockRejectedValue(stop);

    await expect(
      retrieveSemanticPageMemory({
        projectId: "project-1",
        queryText: "Tomas opens the vault",
        lexicalTerms: ["Tomas"],
        embedding: { embed: async () => [0.1] },
        excludePageIndexes: [20],
        beforePageIndex: 22,
        vector: [0.1]
      })
    ).rejects.toBe(stop);
  });
});
