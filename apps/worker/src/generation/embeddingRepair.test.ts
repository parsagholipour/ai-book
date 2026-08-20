import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The backfill pass: which holes it fills, what it stops paying for, and what it
 * writes down when a provider refuses a summary. The statements themselves are
 * `embeddingWrites.ts`' and are asserted as statements in
 * `embeddingWrites.test.ts`; what is here is the *accumulation* across
 * successive page jobs, which no single-call assertion can see.
 */
const mocks = await vi.hoisted(async () => ({
  prisma: {
    // Never called by this pass any more; the "hole set is a query" test
    // asserts on that.
    page: { findMany: vi.fn() },
    embedding: { create: vi.fn(), findMany: vi.fn() },
    $executeRawUnsafe: vi.fn()
  },
  findPageEmbeddingRepairTargets: vi.fn(),
  /**
   * The shared degrade stand-in from `testing/degradeRetrievalArmFake.ts`: what
   * the policy does with a failed degraded write is `embeddingWrites.test.ts`',
   * but this pass reaches the same fallback, so it has to behave the same way
   * here — which is the whole reason the fake is one object and not three.
   */
  degradeRetrievalArm: (await import("./testing/degradeRetrievalArmFake.js")).createDegradeRetrievalArmFake()
}));

vi.mock("@book-maker/db", async () => ({
  prisma: mocks.prisma,
  findPageEmbeddingRepairTargets: mocks.findPageEmbeddingRepairTargets,
  degradeRetrievalArm: mocks.degradeRetrievalArm,
  ...(await import("../testing/dbScopeMocks.js")).dbScopeMocks()
}));

import { StopRequestedError } from "../runtime/jobTypes.js";
import { repairPageEmbeddings } from "./embeddingRepair.js";
import { guardsSourceId, installEmbeddingRowStore, type EmbeddingRowState } from "./testing/embeddingRowStore.js";

/**
 * A whole book's worth of the shared `Embedding` stand-in, plus the target query
 * and the provider that refuses some of its summaries, so a test can run the
 * repair over *successive page jobs* and watch what accumulates. Nothing else
 * measures the thing that was broken: one call always looked reasonable.
 */
function installFakeEmbeddingStore(options: {
  pageCount: number;
  /** Pages with no embedding row at all — the holes the repair pass exists for. */
  missingIndexes: number[];
  /** Pages whose summary the provider refuses, every time, forever. */
  poisonIndexes: number[];
}) {
  const pages = Array.from({ length: options.pageCount }, (_, offset) => ({
    id: `p${offset + 1}`,
    index: offset + 1,
    summary: `Summary ${offset + 1}.`
  }));
  const seed: EmbeddingRowState[] = pages
    .filter((page) => !options.missingIndexes.includes(page.index))
    .map((page) => ({
      scope: `page:${page.index}`,
      sourceId: page.id,
      text: page.summary,
      vector: "[0.1000000]",
      metadata: { provider: "fake" }
    }));
  // The table itself, with this pass's `ON CONFLICT` predicates enforced rather
  // than asserted on — the same stand-in `embeddingWrites.test.ts` drives from
  // the statement end.
  const rows = installEmbeddingRowStore(mocks.prisma.$executeRawUnsafe, seed);

  // Stands in for the SQL of `findPageEmbeddingRepairTargets`, transcribed
  // predicate for predicate: a hole is a page with no `page:<index>` row, or a
  // degraded one whose backoff has expired, and the limit is taken *after* that
  // filter. The real query is measured against Postgres in
  // `packages/db/src/embeddingRepairTargets.integration.test.ts`; what this
  // stands in for here is the *accumulation* across successive page jobs, which
  // no single-call assertion can see.
  mocks.findPageEmbeddingRepairTargets.mockImplementation(
    async (query: { beforeIndex: number; limit: number }) =>
      pages
        .filter((page) => {
          if (page.index >= query.beforeIndex || page.summary.trim().length === 0) {
            return false;
          }
          const metadata = rows.get(`page:${page.index}`)?.metadata as Record<string, unknown> | undefined;
          if (!metadata) {
            return true;
          }
          if (metadata.vectorStored !== false) {
            return false;
          }
          const retryFromIndex = metadata.repairRetryFromIndex;
          return query.beforeIndex >= (typeof retryFromIndex === "number" ? retryFromIndex : 0);
        })
        .slice(0, query.limit)
        .map((page) => {
          const attempts = (rows.get(`page:${page.index}`)?.metadata as Record<string, unknown> | undefined)
            ?.repairAttempts;
          return {
            pageId: page.id,
            index: page.index,
            summary: page.summary,
            attempts: typeof attempts === "number" ? attempts : 0
          };
        })
  );

  const embedCalls: string[] = [];
  const embedding = {
    embed: async (text: string) => {
      embedCalls.push(text);
      if (options.poisonIndexes.some((index) => text === `Summary ${index}.`)) {
        throw new Error("content filter rejected the summary");
      }
      return [0.1];
    }
  };
  const embedCallsFor = (index: number) => embedCalls.filter((text) => text === `Summary ${index}.`).length;
  return { rows, embedCalls, embedCallsFor, embedding };
}

describe("repairPageEmbeddings", () => {
  beforeEach(() => vi.clearAllMocks());

  it("repairs a missing row and a degraded one through the one shared upsert", async () => {
    // Page 1 has no row; page 2 has a degraded (vectorless) row one attempt in.
    mocks.findPageEmbeddingRepairTargets.mockResolvedValue([
      { pageId: "p1", index: 1, summary: "Page one summary.", attempts: 0 },
      { pageId: "p2", index: 2, summary: "Page two summary.", attempts: 1 }
    ]);
    mocks.prisma.$executeRawUnsafe.mockResolvedValue(1);

    await repairPageEmbeddings({ projectId: "project-1", embedding: { embed: async () => [0.1] }, beforeIndex: 30 });

    const statements = mocks.prisma.$executeRawUnsafe.mock.calls.map((call) => String(call[0]));
    expect(statements).toHaveLength(2);
    // Both go through `writePreparedEmbedding`: the upsert overwrites the
    // degraded placeholder in place, refreshing `sourceId` and clearing the
    // metadata that marked it degraded, so a repaired page stops looking like a
    // hole. A hand-rolled UPDATE beside it used to do the degraded half and
    // left `sourceId` pointing at whatever page owned the scope before.
    for (const sql of statements) {
      expect(sql).toContain('INSERT INTO "Embedding"');
      expect(sql).toContain('ON CONFLICT ("projectId", "scope") DO UPDATE');
      expect(sql).toContain('EXCLUDED."sourceId"');
      expect(sql).toContain("::vector");
    }
    expect(mocks.prisma.embedding.create).not.toHaveBeenCalled();
  });

  it("does nothing when beforeIndex leaves no settled pages", async () => {
    await repairPageEmbeddings({ projectId: "project-1", embedding: { embed: async () => [0.1] }, beforeIndex: 1 });

    expect(mocks.findPageEmbeddingRepairTargets).not.toHaveBeenCalled();
  });

  /**
   * The regression this guards. The hole set used to be derived in memory: every
   * COMPLETED page below `beforeIndex` with its full summary, plus every `page:`
   * embedding row of the project, on *every* page job past the recency window —
   * ~85 KB of manuscript and ~230 rows per job on a 300-page book, almost always
   * to discover there was nothing to repair. The derivation is one bounded query
   * now, and the two reads it replaced must not come back.
   */
  it("asks the database for the hole set instead of reading the manuscript back", async () => {
    mocks.findPageEmbeddingRepairTargets.mockResolvedValue([]);

    await repairPageEmbeddings({ projectId: "project-1", embedding: { embed: async () => [0.1] }, beforeIndex: 232 });

    expect(mocks.findPageEmbeddingRepairTargets).toHaveBeenCalledTimes(1);
    expect(mocks.findPageEmbeddingRepairTargets).toHaveBeenCalledWith({
      projectId: "project-1",
      beforeIndex: 232,
      // The repair budget travels *into* the query, so the `LIMIT` is what
      // bounds the rows read rather than a `slice` over everything.
      limit: 3
    });
    expect(mocks.prisma.page.findMany).not.toHaveBeenCalled();
    expect(mocks.prisma.embedding.findMany).not.toHaveBeenCalled();
    expect(mocks.prisma.$executeRawUnsafe).not.toHaveBeenCalled();
  });

  /**
   * The bug this bounds. A page whose summary a provider refuses is a hole the
   * repair can never fill, and the holes are taken lowest index first: the
   * failure path recorded nothing, so the scope never left the hole set and
   * every page job for the rest of the book spent an embedding call re-failing
   * on it — billed, logged, on the page critical path — while permanently
   * holding one of the three slots. Three such pages held all three, and page
   * 20's ordinary missing row was never repaired at all.
   */
  it("stops paying for pages the provider will never embed, and repairs the ordinary hole behind them", async () => {
    const store = installFakeEmbeddingStore({
      pageCount: 40,
      missingIndexes: [3, 5, 7, 20],
      poisonIndexes: [3, 5, 7]
    });

    // Forty successive page jobs, each a page further into the book.
    for (let beforeIndex = 2; beforeIndex <= 41; beforeIndex += 1) {
      await repairPageEmbeddings({ projectId: "project-1", embedding: store.embedding, beforeIndex });
    }

    // Doubling backoff: each poison page is attempted roughly at 2, 4, 8, 16
    // and 32 pages of manuscript apart, never once per job.
    for (const index of [3, 5, 7]) {
      expect(store.embedCallsFor(index)).toBeLessThanOrEqual(6);
      expect(store.rows.get(`page:${index}`)?.vector).toBeNull();
      expect(store.rows.get(`page:${index}`)?.metadata).toMatchObject({ vectorStored: false, repairAttempts: expect.any(Number) });
    }
    // The whole point of bounding them: the slots they were monopolising go to
    // the hole that can actually be filled.
    expect(store.rows.get("page:20")?.vector).toBe("[0.1000000]");
    expect(store.embedCallsFor(20)).toBe(1);
    // Under the old loop this was one call per poison page per job — over a
    // hundred across these forty jobs.
    expect(store.embedCalls.length).toBeLessThanOrEqual(20);
  });

  /**
   * Which pages are holes, and which are inside a backoff window, is now decided
   * by the query — `packages/db/src/embeddingRepairTargets.integration.test.ts`
   * holds those cases against a real Postgres. What is still this file's is that
   * the pass embeds exactly the rows it was handed, in the order it was handed
   * them, and writes each one back under the `pageId` the query resolved rather
   * than one it re-derived from the scope string.
   */
  it("embeds exactly the targets the query returned, in order", async () => {
    mocks.findPageEmbeddingRepairTargets.mockResolvedValue([
      { pageId: "p4", index: 4, summary: "Summary 4.", attempts: 0 },
      { pageId: "p5", index: 5, summary: "Summary 5.", attempts: 0 },
      { pageId: "p6", index: 6, summary: "Summary 6.", attempts: 0 }
    ]);
    mocks.prisma.$executeRawUnsafe.mockResolvedValue(1);
    const embedded: string[] = [];

    await repairPageEmbeddings({
      projectId: "project-1",
      embedding: {
        embed: async (text: string) => {
          embedded.push(text);
          return [0.1];
        }
      },
      beforeIndex: 30
    });

    expect(embedded).toEqual(["Summary 4.", "Summary 5.", "Summary 6."]);
    expect(
      mocks.prisma.$executeRawUnsafe.mock.calls.map((call) => [call[3], call[4]])
    ).toEqual([
      ["page:4", "p4"],
      ["page:5", "p5"],
      ["page:6", "p6"]
    ]);
  });

  it("writes a failed repair down as a placeholder that cannot overwrite a healthy row", async () => {
    mocks.findPageEmbeddingRepairTargets.mockResolvedValue([
      { pageId: "p7", index: 7, summary: "Page seven summary.", attempts: 0 }
    ]);
    mocks.prisma.$executeRawUnsafe.mockResolvedValue(1);

    await repairPageEmbeddings({
      projectId: "project-1",
      embedding: {
        embed: async () => {
          throw new Error("content filter rejected the summary");
        }
      },
      beforeIndex: 30
    });

    expect(mocks.prisma.$executeRawUnsafe).toHaveBeenCalledTimes(1);
    const [sql, , , scope, sourceId, text, metadata] = mocks.prisma.$executeRawUnsafe.mock.calls[0] ?? [];
    // The page's own job may have landed its healthy row between this pass's
    // read and this write; a vectorless placeholder must never win that race.
    expect(String(sql)).toContain('WHERE "Embedding"."vector" IS NULL');
    expect(String(sql)).not.toContain("::vector");
    expect(scope).toBe("page:7");
    expect(sourceId).toBe("p7");
    // The summary rides along: a scope with no row is invisible to both arms of
    // the retrieval, while a vectorless row is still recallable lexically.
    expect(text).toBe("Page seven summary.");
    expect(JSON.parse(String(metadata))).toEqual({
      vectorStored: false,
      error: "content filter rejected the summary",
      repairAttempts: 1,
      repairRetryFromIndex: 32
    });
  });

  /**
   * A stop is not a refusal, and this is the pass that pays for confusing the
   * two. The backoff exists to tell a summary the provider will never embed
   * from an outage that ends — so a cancellation recorded through it stamps
   * `repairAttempts` and a doubling `repairRetryFromIndex` onto a page whose
   * summary embeds perfectly well, deferring it exponentially for a reason that
   * has nothing to do with the provider. And the loop went on to spend the rest
   * of its batch, one aborted call per target, on a run already settling.
   */
  it("abandons the batch on a user stop instead of writing it down as a refusal", async () => {
    mocks.findPageEmbeddingRepairTargets.mockResolvedValue([
      { pageId: "p4", index: 4, summary: "Summary 4.", attempts: 0 },
      { pageId: "p5", index: 5, summary: "Summary 5.", attempts: 0 },
      { pageId: "p6", index: 6, summary: "Summary 6.", attempts: 0 }
    ]);
    mocks.prisma.$executeRawUnsafe.mockResolvedValue(1);
    const embedded: string[] = [];

    await expect(
      repairPageEmbeddings({
        projectId: "project-1",
        embedding: {
          embed: async (text: string) => {
            embedded.push(text);
            throw new StopRequestedError();
          }
        },
        beforeIndex: 30
      })
    ).rejects.toBeInstanceOf(StopRequestedError);

    // The rest of the batch is never attempted.
    expect(embedded).toEqual(["Summary 4."]);
    // No placeholder, no attempt count, no backoff stamp: page 4 stays an
    // ordinary hole the next run repairs on its first pass.
    expect(mocks.prisma.$executeRawUnsafe).not.toHaveBeenCalled();
  });

  /**
   * The window this pass opens by construction, and the hazard on the other
   * side of it. `findPageEmbeddingRepairTargets` resolves page X at index 12,
   * then a provider call takes seconds; a structural edit committing in that
   * gap moves page Y onto index 12, and `repointPageEmbeddings` carries Y's own
   * healthy row to `page:12` with it. The success write used to be an
   * unconditional `DO UPDATE SET "sourceId", "text", "vector", "metadata"`, so
   * it replaced a live page's summary and `sourceId` with another page's — the
   * "a page whose embedding describes a different page is a wrong answer
   * nothing detects" failure `deletePageEmbeddings` exists to prevent, arrived
   * at from the write side instead of the delete side.
   */
  it("refuses to overwrite a page scope a structural edit re-pointed to another page", async () => {
    mocks.findPageEmbeddingRepairTargets.mockResolvedValue([
      { pageId: "p-x", index: 12, summary: "Page X summary.", attempts: 0 }
    ]);
    const rows = installEmbeddingRowStore(mocks.prisma.$executeRawUnsafe, [
      {
        scope: "page:12",
        sourceId: "p-y",
        text: "Page Y summary.",
        vector: "[0.9000000]",
        metadata: { provider: "fake" }
      }
    ]);

    await repairPageEmbeddings({ projectId: "project-1", embedding: { embed: async () => [0.1] }, beforeIndex: 30 });

    expect(rows.get("page:12")).toEqual({
      scope: "page:12",
      sourceId: "p-y",
      text: "Page Y summary.",
      vector: "[0.9000000]",
      metadata: { provider: "fake" }
    });
    // One statement and nothing behind it. A write that matched no row is not a
    // refusal the page earned, so no backoff may be stamped for it — and the
    // placeholder that would carry that stamp lands by scope too, so writing it
    // would put page X's summary on page Y's row by the other door.
    expect(mocks.prisma.$executeRawUnsafe).toHaveBeenCalledTimes(1);
    expect(String(mocks.prisma.$executeRawUnsafe.mock.calls[0]?.[0])).toContain("::vector");
  });

  /**
   * And the predicate is the `sourceId`, not the missing vector. Re-pointing
   * moves whatever row a page owns, degraded ones included, so `vector IS NULL`
   * — the guard the *failure* write carries — would have let this one through
   * and overwritten page Y's placeholder, text, stamp and all.
   */
  it("guards the repair write on the row's page, not on the vector being absent", async () => {
    mocks.findPageEmbeddingRepairTargets.mockResolvedValue([
      { pageId: "p-x", index: 12, summary: "Page X summary.", attempts: 0 }
    ]);
    const rows = installEmbeddingRowStore(mocks.prisma.$executeRawUnsafe, [
      {
        scope: "page:12",
        sourceId: "p-y",
        text: "Page Y summary.",
        vector: null,
        metadata: { vectorStored: false, error: "content filter rejected the summary", repairAttempts: 2, repairRetryFromIndex: 4 }
      }
    ]);

    await repairPageEmbeddings({ projectId: "project-1", embedding: { embed: async () => [0.1] }, beforeIndex: 30 });

    expect(rows.get("page:12")).toMatchObject({ sourceId: "p-y", text: "Page Y summary.", vector: null });
    expect(rows.get("page:12")?.metadata).toMatchObject({ repairAttempts: 2, repairRetryFromIndex: 4 });
    expect(mocks.prisma.$executeRawUnsafe).toHaveBeenCalledTimes(1);
  });

  /**
   * The same window, reached through the *failure* write — the one the backoff
   * exists for. A refused summary never calls `writePreparedEmbedding`, so
   * `"superseded"` cannot fire and the stamp is the whole iteration. It lands
   * by scope too, and `vector IS NULL` is no defence: a re-point moves degraded
   * rows as readily as healthy ones, so it is true of exactly the row to refuse.
   */
  it("refuses to stamp a backoff onto a degraded row a re-point handed another page", async () => {
    mocks.findPageEmbeddingRepairTargets.mockResolvedValue([
      { pageId: "p-x", index: 12, summary: "Page X summary.", attempts: 0 }
    ]);
    const held = { scope: "page:12", sourceId: "p-y", text: "Page Y summary.", vector: null, metadata: { vectorStored: false } };
    const rows = installEmbeddingRowStore(mocks.prisma.$executeRawUnsafe, [held]);

    await repairPageEmbeddings({
      projectId: "project-1",
      embedding: {
        embed: async () => {
          throw new Error("content filter rejected the summary");
        }
      },
      beforeIndex: 30
    });

    // Page Y keeps its own summary, and no attempt count saying page X was
    // refused; the guard matched nothing and nothing was written around it.
    expect(rows.get("page:12")).toEqual(held);
    expect(mocks.prisma.$executeRawUnsafe).toHaveBeenCalledTimes(1);
    expect(guardsSourceId(String(mocks.prisma.$executeRawUnsafe.mock.calls[0]?.[0]))).toBe(true);
  });

  /**
   * Losing the race costs the page one call and nothing else. A renumber
   * carries every page's rows with it by `sourceId`, so a page that had no row
   * still has none under its new index — it is an ordinary hole there, the
   * query offers it again with the attempt count it always had, and the write
   * lands on a scope no other page holds. That self-healing is what makes the
   * silent no-op above the right answer rather than a lost repair.
   */
  it("repairs the moved page under the index it now holds, on a later pass", async () => {
    const rows = installEmbeddingRowStore(mocks.prisma.$executeRawUnsafe, [
      {
        scope: "page:12",
        sourceId: "p-y",
        text: "Page Y summary.",
        vector: "[0.9000000]",
        metadata: { provider: "fake" }
      }
    ]);

    mocks.findPageEmbeddingRepairTargets.mockResolvedValue([
      { pageId: "p-x", index: 12, summary: "Page X summary.", attempts: 0 }
    ]);
    await repairPageEmbeddings({ projectId: "project-1", embedding: { embed: async () => [0.1] }, beforeIndex: 30 });

    // `attempts: 0` is the assertion, not the setup: nothing was stamped, so
    // the page comes back unpenalised — at index 13, where the shift left it.
    mocks.findPageEmbeddingRepairTargets.mockResolvedValue([
      { pageId: "p-x", index: 13, summary: "Page X summary.", attempts: 0 }
    ]);
    await repairPageEmbeddings({ projectId: "project-1", embedding: { embed: async () => [0.1] }, beforeIndex: 30 });

    expect(rows.get("page:13")).toMatchObject({ sourceId: "p-x", text: "Page X summary.", vector: "[0.1000000]" });
    expect(rows.get("page:12")).toMatchObject({ sourceId: "p-y", text: "Page Y summary.", vector: "[0.9000000]" });
  });

  /**
   * A row with no `sourceId` is claimed by no page — nothing re-points it and
   * nothing deletes it — so the guard must let the repair land on it. Locking
   * it out would leave the page permanently unrepairable *and* permanently a
   * target, which is the starvation the backoff exists to prevent.
   */
  it("still repairs a row that names no page", async () => {
    mocks.findPageEmbeddingRepairTargets.mockResolvedValue([
      { pageId: "p-x", index: 12, summary: "Page X summary.", attempts: 1 }
    ]);
    const rows = installEmbeddingRowStore(mocks.prisma.$executeRawUnsafe, [
      {
        scope: "page:12",
        sourceId: null,
        text: "Page X summary.",
        vector: null,
        metadata: { vectorStored: false, error: "provider outage" }
      }
    ]);

    await repairPageEmbeddings({ projectId: "project-1", embedding: { embed: async () => [0.1] }, beforeIndex: 30 });

    expect(rows.get("page:12")).toMatchObject({ sourceId: "p-x", text: "Page X summary.", vector: "[0.1000000]" });
  });

  it("counts an attempt the provider answered but the insert refused", async () => {
    // A database with no pgvector spends the embedding call and stores nothing,
    // which is the same unbounded shape as a refused summary. Two attempts are
    // already on the row, and the query hands that count over.
    mocks.findPageEmbeddingRepairTargets.mockResolvedValue([
      { pageId: "p7", index: 7, summary: "Page seven summary.", attempts: 2 }
    ]);
    mocks.prisma.$executeRawUnsafe
      .mockRejectedValueOnce(new Error("type vector does not exist"))
      .mockResolvedValue(1);

    await repairPageEmbeddings({ projectId: "project-1", embedding: { embed: async () => [0.1] }, beforeIndex: 30 });

    const stamped = mocks.prisma.$executeRawUnsafe.mock.calls.at(-1) ?? [];
    expect(String(stamped[0])).toContain('WHERE "Embedding"."vector" IS NULL');
    expect(JSON.parse(String(stamped[6]))).toMatchObject({ repairAttempts: 3, repairRetryFromIndex: 38 });
  });
});
