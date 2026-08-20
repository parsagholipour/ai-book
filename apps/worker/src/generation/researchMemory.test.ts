import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The write end of the `research:` scope: the `research:<sourceId>` rows
 * `embedResearchSourcesForProject` maintains. Kept apart from the page-scope
 * writes in `embeddingWrites.test.ts` and the backfill in
 * `embeddingRepair.test.ts` because the three share no fixture: this one needs a
 * `ResearchSource` list and a store that models the row *ids* the pass once
 * deleted by, and neither means anything to a page.
 */
const mocks = await vi.hoisted(async () => ({
  prisma: {
    researchSource: { findMany: vi.fn() },
    embedding: { create: vi.fn(), findMany: vi.fn(), delete: vi.fn() },
    $executeRawUnsafe: vi.fn()
  },
  /**
   * The shared degrade stand-in from `testing/degradeRetrievalArmFake.ts`. Two
   * callers reach it from under this mock — the degraded write behind
   * `storeEmbedding` and the retrieval below — and a laxer stand-in would
   * answer "the failure was handled" for a version that had stopped honouring
   * `rethrowIf`.
   */
  degradeRetrievalArm: (await import("./testing/degradeRetrievalArmFake.js")).createDegradeRetrievalArmFake()
}));

vi.mock("@book-maker/db", async () => ({
  prisma: mocks.prisma,
  retrieveSimilarEmbeddings: vi.fn(),
  degradeRetrievalArm: mocks.degradeRetrievalArm,
  // Restated rather than imported, for `dbScopeMocks`' reasons: reaching the
  // real `@book-maker/db` builds a PrismaClient for a run that is supposed to
  // need no database, and a factory that imports anything which transitively
  // imports a mocked module deadlocks vitest's registry. Keep it equal to
  // `embeddingIsDegraded` in `packages/db/src/embeddingRepairTargets.ts` —
  // whose answers, per metadata shape, are pinned in that package's own suites
  // against the SQL spelling of the same rule beside it.
  embeddingIsDegraded: (metadata: unknown) =>
    !!metadata &&
    typeof metadata === "object" &&
    !Array.isArray(metadata) &&
    (metadata as Record<string, unknown>).vectorStored === false,
  ...(await import("../testing/dbScopeMocks.js")).dbScopeMocks()
}));

import { StopRequestedError } from "../runtime/jobTypes.js";
import { embedResearchSourcesForProject, retrieveSemanticResearchNotes } from "./researchMemory.js";

type StoredResearchRow = {
  id: string;
  scope: string;
  sourceId: string | null;
  text: string;
  vector: string | null;
  metadata: unknown;
};

/**
 * A `research:` corner of the Embedding table, keyed by scope the way the
 * unique index keys it. Rows rather than call counts, because what this pass
 * has to be judged on is what a *stopped* run leaves behind — a question no
 * "which statements ran" assertion can ask.
 */
function installResearchStore(seed: StoredResearchRow[]) {
  const rows = new Map(seed.map((row) => [row.scope, row]));
  // The whole row, not the narrowed `select`: a mock cannot project, and
  // handing every column over is what lets these assertions fail against a
  // version that looks the row's id up to delete it.
  mocks.prisma.embedding.findMany.mockImplementation(async () =>
    [...rows.values()].map((row) => ({ id: row.id, scope: row.scope, sourceId: row.sourceId, metadata: row.metadata }))
  );
  mocks.prisma.embedding.delete.mockImplementation(async (args: { where: { id: string } }) => {
    for (const [scope, row] of rows) {
      if (row.id === args.where.id) {
        rows.delete(scope);
        return row;
      }
    }
    throw new Error("record not found");
  });
  // Parameters run `id, projectId, scope, sourceId, text[, vector], metadata`.
  mocks.prisma.$executeRawUnsafe.mockImplementation(async (sql: string, ...params: unknown[]) => {
    const scope = String(params[2]);
    const sourceId = String(params[3]);
    const text = String(params[4]);
    const existing = rows.get(scope);
    if (sql.includes("::vector")) {
      // `ON CONFLICT ("projectId", "scope") DO UPDATE`: the row keeps its id and
      // takes every other column from EXCLUDED.
      rows.set(scope, {
        id: existing?.id ?? String(params[0]),
        scope,
        sourceId,
        text,
        vector: String(params[5]),
        metadata: JSON.parse(String(params[6]))
      });
      return 1;
    }
    // `createDegradedEmbedding`: `DO UPDATE ... WHERE "Embedding"."vector" IS
    // NULL`, so it refreshes a placeholder in place and cannot touch a row a
    // successful write has already given a vector.
    if (existing?.vector) {
      return 0;
    }
    if (existing) {
      rows.set(scope, { ...existing, sourceId, text, metadata: JSON.parse(String(params[5])) });
      return 1;
    }
    rows.set(scope, { id: String(params[0]), scope, sourceId, text, vector: null, metadata: JSON.parse(String(params[5])) });
    return 1;
  });
  return rows;
}

describe("embedResearchSourcesForProject", () => {
  beforeEach(() => vi.clearAllMocks());

  /**
   * The re-embed used to `delete` the placeholder first, so that a retried
   * source ended with one row rather than two. `(projectId, scope)` is unique
   * now and every write path upserts on it, so the delete bought nothing — it
   * only had to leave the row exactly as a delete-then-insert would.
   */
  it("re-embeds a degraded research row in place, refreshing text, sourceId, vector and metadata", async () => {
    mocks.prisma.researchSource.findMany.mockResolvedValue([{ id: "s1", title: "T1", summary: "S1" }]);
    // Deliberately the worst placeholder a legacy or partial write could have
    // left: stale text and no `sourceId` at all. A `DO UPDATE` that omitted a
    // column would strand one of them here — the same shape as the hand-rolled
    // repair UPDATE that never refreshed `sourceId`.
    const rows = installResearchStore([
      {
        id: "e1",
        scope: "research:s1",
        sourceId: null,
        text: "stale text",
        vector: null,
        metadata: { vectorStored: false, error: "outage" }
      }
    ]);

    await embedResearchSourcesForProject("project-1", { embed: async () => [0.2] });

    expect(mocks.prisma.embedding.delete).not.toHaveBeenCalled();
    // One usable row, which is what the delete was there for.
    expect([...rows.keys()]).toEqual(["research:s1"]);
    const stored = rows.get("research:s1");
    expect(stored).toMatchObject({ id: "e1", sourceId: "s1", text: "T1: S1", vector: "[0.2000000]" });
    // The degraded marker is gone, or `embeddingIsDegraded` would call the
    // repaired row a hole forever and re-embed it on every pass.
    expect(stored?.metadata).not.toHaveProperty("vectorStored");
    expect(stored?.metadata).toHaveProperty("provider");
    const sql = String(mocks.prisma.$executeRawUnsafe.mock.calls[0]?.[0]);
    expect(sql).toContain('ON CONFLICT ("projectId", "scope") DO UPDATE');
    for (const column of ["sourceId", "text", "vector", "metadata"]) {
      expect(sql).toContain(`EXCLUDED."${column}"`);
    }
  });

  /**
   * The regression the delete opened. It ran *before* the embedding call — the
   * long, interruptible half — so between the two the source had no row at all,
   * and a stop or a crash in that window destroyed the only stored record of
   * the source's text. The embed observes the store mid-flight because the
   * final state cannot tell the two versions apart: a failure the process
   * survived re-inserted an equivalent placeholder on the way out, and only a
   * run that died inside the window lost the row for good.
   */
  it("leaves the placeholder in place across the embedding call, so an interrupted run keeps its text", async () => {
    mocks.prisma.researchSource.findMany.mockResolvedValue([{ id: "s1", title: "T1", summary: "S1" }]);
    const rows = installResearchStore([
      {
        id: "e1",
        scope: "research:s1",
        sourceId: "s1",
        text: "T1: S1",
        vector: null,
        metadata: { vectorStored: false, error: "outage" }
      }
    ]);
    let rowPresentDuringEmbed: boolean | undefined;

    await embedResearchSourcesForProject("project-1", {
      embed: async () => {
        rowPresentDuringEmbed = rows.has("research:s1");
        throw new Error("worker stopped mid-embed");
      }
    });

    expect(rowPresentDuringEmbed).toBe(true);
    expect(mocks.prisma.embedding.delete).not.toHaveBeenCalled();
    expect(rows.get("research:s1")).toMatchObject({ text: "T1: S1", vector: null });
  });

  it("skips a research source that already has a usable embedding", async () => {
    mocks.prisma.researchSource.findMany.mockResolvedValue([{ id: "s1", title: "T1", summary: "S1" }]);
    mocks.prisma.embedding.findMany.mockResolvedValue([{ sourceId: "s1", metadata: { provider: "gemini" } }]);

    await embedResearchSourcesForProject("project-1", { embed: async () => [0.2] });

    expect(mocks.prisma.embedding.delete).not.toHaveBeenCalled();
    expect(mocks.prisma.$executeRawUnsafe).not.toHaveBeenCalled();
  });
});

describe("retrieveSemanticResearchNotes", () => {
  beforeEach(() => vi.clearAllMocks());

  /**
   * The embedding call is inside the same `try` as the search, so a reader
   * stopping the run arrives here as an ordinary rejection. Degrading it would
   * hand the page an empty research list — exactly what a provider outage
   * produces — and the job would go on drafting a run that is already settling.
   */
  it("lets a stopped run out instead of degrading it to no research notes", async () => {
    const stop = new StopRequestedError();

    await expect(
      retrieveSemanticResearchNotes({
        projectId: "project-1",
        queryText: "backyard birds",
        embedding: {
          embed: async () => {
            throw stop;
          }
        },
        topK: 4
      })
    ).rejects.toBe(stop);
  });

  it("hands an ordinary failure to the shared degrade policy and answers with no notes", async () => {
    const failure = new Error("type \"vector\" does not exist");

    const notes = await retrieveSemanticResearchNotes({
      projectId: "project-1",
      queryText: "backyard birds",
      embedding: {
        embed: async () => {
          throw failure;
        }
      },
      topK: 4
    });

    expect(notes).toEqual([]);
    expect(mocks.degradeRetrievalArm).toHaveBeenCalledWith({
      arm: "Semantic research retrieval",
      projectId: "project-1",
      error: failure,
      fallback: [],
      rethrowIf: expect.any(Function)
    });
  });
});
