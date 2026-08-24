import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * What goes into the Embedding table under a **page** scope: the composed
 * `storeEmbedding`, and the placeholder `writePreparedEmbedding` falls back to
 * when there is no vector to store. `embeddingRepair.test.ts` drives the same
 * statements from the backfill pass, `researchMemory.test.ts` covers the
 * `research:` scope and `semanticRecall.test.ts` the reading half; none of them
 * shares a fixture with these beyond `testing/embeddingRowStore.ts`, and each
 * mocks a different corner of the client.
 */
const mocks = await vi.hoisted(async () => ({
  prisma: {
    embedding: { create: vi.fn() },
    $executeRawUnsafe: vi.fn()
  },
  /**
   * The shared degrade stand-in — `testing/degradeRetrievalArmFake.ts` holds it
   * and says why the suites that mock this client share one, and why it is
   * reached by `await import` from inside this factory rather than statically.
   * What this file has to prove is that the degraded write is handed to the
   * policy at all, and that its `rethrowIf` still lets a stop out.
   */
  degradeRetrievalArm: (await import("./testing/degradeRetrievalArmFake.js")).createDegradeRetrievalArmFake()
}));

vi.mock("@book-maker/db", () => ({
  prisma: mocks.prisma,
  degradeRetrievalArm: mocks.degradeRetrievalArm
}));

import { StopRequestedError } from "../runtime/jobTypes.js";
import { storeEmbedding, writePreparedEmbedding } from "./embeddingWrites.js";
import { installEmbeddingRowStore } from "./testing/embeddingRowStore.js";

/**
 * `storeEmbedding` is the provider call and the insert composed, and the two
 * halves are separately callable so a caller publishing under an ownership
 * fence can put the fence between them (`generation/pageReview.ts`). These
 * assertions are on the composed call, because that is what every other caller
 * still uses and what the split must not have changed.
 */
describe("storeEmbedding", () => {
  beforeEach(() => vi.clearAllMocks());

  it("writes the vector row when the provider answers", async () => {
    mocks.prisma.$executeRawUnsafe.mockResolvedValue(1);

    await storeEmbedding({ projectId: "project-1", scope: "page:3", sourceId: "page-row-1", text: "Summary." }, { embed: async () => [0.5, -0.25] });

    const sql = String(mocks.prisma.$executeRawUnsafe.mock.calls[0]?.[0]);
    expect(sql).toContain('ON CONFLICT ("projectId", "scope")');
    expect(sql).toContain("DO UPDATE");
    expect(mocks.prisma.embedding.create).not.toHaveBeenCalled();
    expect(mocks.prisma.$executeRawUnsafe.mock.calls[0]?.[6]).toBe("[0.5000000,-0.2500000]");
  });

  it("settles a unique (projectId, scope) conflict on the vector insert without falling back to embedding.create", async () => {
    mocks.prisma.$executeRawUnsafe.mockResolvedValue(1);

    await storeEmbedding({ projectId: "project-1", scope: "page:3", sourceId: "page-row-1", text: "Summary." }, { embed: async () => [0.5] });

    const sql = String(mocks.prisma.$executeRawUnsafe.mock.calls[0]?.[0]);
    expect(sql).toContain('ON CONFLICT ("projectId", "scope")');
    expect(sql).toContain("DO UPDATE SET");
    expect(sql).toContain('EXCLUDED."vector"');
    expect(sql).not.toMatch(/"createdAt"\s*=/);
    expect(mocks.prisma.$executeRawUnsafe).toHaveBeenCalledTimes(1);
    expect(mocks.prisma.embedding.create).not.toHaveBeenCalled();
  });

  /**
   * The shared write is deliberately unguarded for everyone but the repair
   * pass. `storeEmbedding` here and `writePreparedEmbedding` in
   * `pageReview.ts` both run *after* the page they describe has been written,
   * so the row under `page:<index>` is theirs to replace whatever it holds and
   * whatever `sourceId` it carries — a page that was rewritten must not keep a
   * stale summary as its long-range memory. The `"same-page"` guard the repair
   * pass asks for would do exactly that, which is why it is opt-in.
   */
  it("replaces the page's own row whatever it holds, with no sourceId guard", async () => {
    const rows = installEmbeddingRowStore(mocks.prisma.$executeRawUnsafe, [
      { scope: "page:3", sourceId: "some-other-page", text: "Stale summary.", vector: "[0.9000000]", metadata: { provider: "fake" } }
    ]);

    await storeEmbedding({ projectId: "project-1", scope: "page:3", sourceId: "page-row-1", text: "Fresh summary." }, { embed: async () => [0.5] });

    expect(String(mocks.prisma.$executeRawUnsafe.mock.calls[0]?.[0])).not.toContain('WHERE "Embedding"."sourceId"');
    expect(rows.get("page:3")).toMatchObject({
      sourceId: "page-row-1",
      text: "Fresh summary.",
      vector: "[0.5000000]"
    });
  });

  it("degrades to a vectorless row when the provider call fails", async () => {
    mocks.prisma.$executeRawUnsafe.mockResolvedValue(1);

    await storeEmbedding({ projectId: "project-1", scope: "page:3", sourceId: "page-row-1", text: "Summary." }, {
      embed: async () => {
        throw new Error("provider down");
      }
    });

    expect(mocks.prisma.embedding.create).not.toHaveBeenCalled();
    expect(mocks.prisma.$executeRawUnsafe).toHaveBeenCalledTimes(1);
    const sql = String(mocks.prisma.$executeRawUnsafe.mock.calls[0]?.[0]);
    expect(sql).toContain('WHERE "Embedding"."vector" IS NULL');
    expect(sql).not.toContain("::vector");
    expect(sql).not.toContain('"vector" = ');
    expect(JSON.parse(String(mocks.prisma.$executeRawUnsafe.mock.calls[0]?.[6]))).toEqual({
      vectorStored: false,
      error: "provider down"
    });
  });

  it("degrades to a vectorless row when the vector insert itself fails", async () => {
    mocks.prisma.$executeRawUnsafe
      .mockRejectedValueOnce(new Error("type vector does not exist"))
      .mockResolvedValueOnce(1);

    await storeEmbedding({ projectId: "project-1", scope: "page:3", sourceId: "page-row-1", text: "Summary." }, { embed: async () => [0.5] });

    expect(mocks.prisma.embedding.create).not.toHaveBeenCalled();
    expect(mocks.prisma.$executeRawUnsafe).toHaveBeenCalledTimes(2);
    expect(String(mocks.prisma.$executeRawUnsafe.mock.calls[0]?.[0])).toContain("::vector");
    const degradedSql = String(mocks.prisma.$executeRawUnsafe.mock.calls[1]?.[0]);
    expect(degradedSql).toContain('WHERE "Embedding"."vector" IS NULL');
    expect(degradedSql).not.toContain("::vector");
    expect(JSON.parse(String(mocks.prisma.$executeRawUnsafe.mock.calls[1]?.[6]))).toEqual({
      vectorStored: false,
      error: "type vector does not exist"
    });
  });

  /**
   * The hazard both `ON CONFLICT` clauses carry. They need the unique index
   * `000056_embedding_project_scope_unique` creates, and a database where
   * `000055_trigram_memory_search` could not `CREATE EXTENSION pg_trgm` halts
   * `prisma migrate deploy` before it — so *both* statements raise, the vector
   * insert and the fallback it degrades to. `storeEmbedding` is the last
   * statement of a page job before `enqueueNextPageIfReady`, so an error
   * leaving here would stop the fan-out of every book on that deployment,
   * page after page, over a memory row.
   */
  it("does not throw when the fallback write cannot land either", async () => {
    const missingConstraint = new Error(
      "there is no unique or exclusion constraint matching the ON CONFLICT specification"
    );
    mocks.prisma.$executeRawUnsafe.mockRejectedValue(missingConstraint);
    let calledAfter = false;

    await expect(
      (async () => {
        await storeEmbedding({ projectId: "project-1", scope: "page:3", sourceId: "page-row-1", text: "Summary." }, { embed: async () => [0.5] });
        calledAfter = true;
      })()
    ).resolves.toBeUndefined();

    expect(calledAfter).toBe(true);
    // Both statements were attempted, and the second one's failure went to the
    // shared degrade policy rather than to the caller.
    expect(mocks.prisma.$executeRawUnsafe).toHaveBeenCalledTimes(2);
    expect(mocks.degradeRetrievalArm).toHaveBeenCalledTimes(1);
    expect(mocks.degradeRetrievalArm.mock.calls[0]?.[0]).toMatchObject({
      projectId: "project-1",
      error: missingConstraint
    });
  });

  /**
   * The one error that must not be degraded: a stopped run whose write is
   * swallowed keeps drafting. `rethrowIf` is the escape hatch, the same one
   * `loadContinuityNotes` hands the lexical arm.
   */
  it("lets a stop request out of the fallback write", async () => {
    mocks.prisma.$executeRawUnsafe
      .mockRejectedValueOnce(new Error("type vector does not exist"))
      .mockRejectedValueOnce(new StopRequestedError());

    await expect(
      storeEmbedding({ projectId: "project-1", scope: "page:3", sourceId: "page-row-1", text: "Summary." }, { embed: async () => [0.5] })
    ).rejects.toBeInstanceOf(StopRequestedError);
    // Reached through the fallback, not short-circuited by the vector insert.
    expect(mocks.prisma.$executeRawUnsafe).toHaveBeenCalledTimes(2);
  });

  /**
   * The same rule one call earlier. `LoggingEmbeddingAdapter.embed` raises
   * `StopRequestedError` the moment the reader stops the run, and
   * `prepareEmbedding` used to fold it into `{ vectorLiteral: null, error }` —
   * so a cancellation was persisted as a provider that would not embed the
   * text, and the caller carried on as though the memory row were merely
   * degraded. Nothing is written now, and the stop reaches the job.
   */
  it("lets a stop request out of the provider call without writing a placeholder", async () => {
    mocks.prisma.$executeRawUnsafe.mockResolvedValue(1);

    await expect(
      storeEmbedding({ projectId: "project-1", scope: "page:3", sourceId: "page-row-1", text: "Summary." }, {
        embed: async () => {
          throw new StopRequestedError();
        }
      })
    ).rejects.toBeInstanceOf(StopRequestedError);

    expect(mocks.prisma.$executeRawUnsafe).not.toHaveBeenCalled();
    expect(mocks.prisma.embedding.create).not.toHaveBeenCalled();
  });

  it("does not throw when a second degraded write hits the same scope", async () => {
    mocks.prisma.$executeRawUnsafe.mockResolvedValue(0);
    const failing = {
      embed: async () => {
        throw new Error("provider down");
      }
    };

    await storeEmbedding({ projectId: "project-1", scope: "page:3", sourceId: "page-row-1", text: "Summary." }, failing);
    await expect(storeEmbedding({ projectId: "project-1", scope: "page:3", sourceId: "page-row-1", text: "Summary." }, failing)).resolves.toBeUndefined();

    expect(mocks.prisma.$executeRawUnsafe).toHaveBeenCalledTimes(2);
    // A guarded `DO UPDATE` that matches no row returns 0; it cannot raise the
    // unique violation a bare `INSERT` would.
    expect(String(mocks.prisma.$executeRawUnsafe.mock.calls[1]?.[0])).toContain("ON CONFLICT");
    expect(mocks.prisma.embedding.create).not.toHaveBeenCalled();
  });

  /**
   * The placeholder has to describe the page as it is *now*. This write was
   * `DO NOTHING`, so a page rewritten by a chat edit whose embedding failed a
   * second time kept the previous draft's summary under its scope — and a
   * vectorless row is deliberately still recallable, because
   * `retrieveLexicalEmbeddings` filters on `text` and never on the vector, so
   * `retrieveSemanticPageMemory` handed every later page
   * `Page 12: <text the edit removed>` as earlier continuity.
   */
  it("refreshes the placeholder when the page is rewritten and the embedding fails again", async () => {
    const rows = installEmbeddingRowStore(mocks.prisma.$executeRawUnsafe, []);
    const failing = {
      embed: async () => {
        throw new Error("provider down");
      }
    };

    await storeEmbedding({ projectId: "project-1", scope: "page:12", sourceId: "page-12", text: "The vault is sealed." }, failing);
    await storeEmbedding({ projectId: "project-1", scope: "page:12", sourceId: "page-12", text: "The vault stands open." }, failing);

    expect(rows.get("page:12")).toMatchObject({
      sourceId: "page-12",
      text: "The vault stands open.",
      vector: null
    });
  });

  /**
   * And the guard that makes the refresh safe. This write is only ever reached
   * *after* a provider or insert failure, so a row that holds a vector belongs
   * to a writer that succeeded — the page's own job landing its healthy row
   * between the failure and this fallback — and a vectorless placeholder must
   * never replace one.
   */
  it("leaves a row that already holds a vector untouched", async () => {
    const rows = installEmbeddingRowStore(mocks.prisma.$executeRawUnsafe, [
      { scope: "page:12", sourceId: "page-12", text: "Healthy summary.", vector: "[0.9000000]", metadata: { provider: "fake" } }
    ]);

    await storeEmbedding({ projectId: "project-1", scope: "page:12", sourceId: "page-12", text: "Rewritten summary." }, {
      embed: async () => {
        throw new Error("provider down");
      }
    });

    expect(rows.get("page:12")).toEqual({
      scope: "page:12",
      sourceId: "page-12",
      text: "Healthy summary.",
      vector: "[0.9000000]",
      metadata: { provider: "fake" }
    });
  });
});

/**
 * The placeholder half of the write, called directly, because the conflict
 * policy is the caller's and the two answers differ only in which row the
 * fallback is allowed to refresh.
 */
describe("writePreparedEmbedding degraded fallback", () => {
  beforeEach(() => vi.clearAllMocks());

  const refused = { vectorLiteral: null, error: "content filter rejected the summary" };

  it("keeps a prepared vector write on the supplied publication client", async () => {
    const client = { $executeRawUnsafe: vi.fn(async () => 1) };

    const outcome = await writePreparedEmbedding(
      { projectId: "project-1", scope: "page:12", sourceId: "p-x", text: "Page X summary." },
      { vectorLiteral: "[0.5]", error: null },
      client as never
    );

    expect(outcome).toBe("stored");
    expect(client.$executeRawUnsafe).toHaveBeenCalledTimes(1);
    expect(mocks.prisma.$executeRawUnsafe).not.toHaveBeenCalled();
  });

  /**
   * `"same-page"` reaches the fallback as well as the vector upsert: a
   * `page:<index>` scope names a position, `repointPageEmbeddings` hands
   * positions to other pages, and a re-point moves degraded rows as readily as
   * healthy ones — so the row this write finds may be another page's
   * placeholder, and refreshing it would put the target's summary on it.
   */
  it("refuses a scope another page holds under the same-page policy", async () => {
    const rows = installEmbeddingRowStore(mocks.prisma.$executeRawUnsafe, [
      { scope: "page:12", sourceId: "p-y", text: "Page Y summary.", vector: null, metadata: { vectorStored: false } }
    ]);

    const outcome = await writePreparedEmbedding(
      { projectId: "project-1", scope: "page:12", sourceId: "p-x", text: "Page X summary.", conflict: "same-page" },
      refused
    );

    expect(outcome).toBe("degraded");
    expect(rows.get("page:12")).toMatchObject({ sourceId: "p-y", text: "Page Y summary." });
  });

  /**
   * And the default must not take that guard. A caller here has just *written*
   * the page, so the row under its scope is its own to replace whatever
   * `sourceId` it carries — a structural insert gives page 12 a new `Page` row,
   * and refusing on the predecessor's id would leave the stale summary in place,
   * which is the whole failure this fallback was changed to fix.
   */
  it("claims the scope whatever page last held it under the default policy", async () => {
    const rows = installEmbeddingRowStore(mocks.prisma.$executeRawUnsafe, [
      { scope: "page:12", sourceId: "p-y", text: "Page Y summary.", vector: null, metadata: { vectorStored: false } }
    ]);

    const outcome = await writePreparedEmbedding({ projectId: "project-1", scope: "page:12", sourceId: "p-x", text: "Page X summary." }, refused);

    expect(outcome).toBe("degraded");
    expect(rows.get("page:12")).toMatchObject({ sourceId: "p-x", text: "Page X summary.", vector: null });
  });
});
