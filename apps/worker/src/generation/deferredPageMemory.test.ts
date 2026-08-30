import { beforeEach, describe, expect, it, vi } from "vitest";
import { emptyStoryState } from "@book-maker/core";

const mocks = vi.hoisted(() => ({
  keeperStoryExtractForSave: vi.fn(),
  /**
   * The single-page seams the publication used to reach once per page. They
   * stay mocked so the batch can assert it no longer calls them: each was a
   * read-modify-write of `Project.storyState` and an embedding upsert of its
   * own, inside the caller's 30 s manuscript transaction.
   */
  persistStoryExtract: vi.fn(),
  writePreparedEmbedding: vi.fn(),
  prepareEmbedding: vi.fn(),
  updateEntityStateFromPage: vi.fn()
}));

vi.mock("./qualityEnrichment.js", () => ({
  keeperStoryExtractForSave: mocks.keeperStoryExtractForSave,
  persistStoryExtract: mocks.persistStoryExtract
}));
vi.mock("./embeddingWrites.js", () => ({
  strategyUsesSemanticMemory: (strategy: { executionMode: string }) => strategy.executionMode === "sequential-pages",
  prepareEmbedding: mocks.prepareEmbedding,
  writePreparedEmbedding: mocks.writePreparedEmbedding
}));
vi.mock("./entityState.js", () => ({ updateEntityStateFromPage: mocks.updateEntityStateFromPage }));
vi.mock("../runtime/config.js", () => ({ config: { MOCK_AI: true } }));

import {
  persistPreparedDeferredPageMemory,
  prepareDeferredPageMemory
} from "./deferredPageMemory.js";

const firstDraft = {
  title: "First",
  markdown: "Mara finds the red key.",
  summary: "Mara finds a key.",
  continuityNotes: ["Mara carries the red key."]
};
const secondDraft = {
  title: "Second",
  markdown: "Mara refuses to use it.",
  summary: "Mara refuses the key.",
  continuityNotes: ["Mara still refuses the red key."]
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.prepareEmbedding.mockResolvedValue({ vectorLiteral: "[0.1,0.2]", error: null });
  mocks.persistStoryExtract.mockResolvedValue(emptyStoryState());
  mocks.updateEntityStateFromPage.mockResolvedValue(undefined);
  mocks.writePreparedEmbedding.mockResolvedValue("stored");
});

describe("deferred page memory preparation", () => {
  it("extracts accepted story facts in page order and prepares embeddings outside publication", async () => {
    mocks.keeperStoryExtractForSave
      .mockResolvedValueOnce({ storyDelta: storyDelta("Mara has the red key."), contradictions: [] })
      .mockResolvedValueOnce({ storyDelta: storyDelta("Mara refused the key."), contradictions: [] });
    mocks.prepareEmbedding
      .mockResolvedValueOnce({ vectorLiteral: "[0.1,0.2]", error: null })
      .mockResolvedValueOnce({ vectorLiteral: null, error: "embedding provider unavailable" });

    const prepared = await prepareDeferredPageMemory({
      projectId: "project-1",
      input: { targetPages: 2 } as never,
      plan: { promises: [] } as never,
      providers: { text: {}, embedding: {} } as never,
      strategy: { executionMode: "sequential-pages" } as never,
      quality: { enabled: () => true },
      initialStoryState: emptyStoryState(),
      candidates: [
        { pageIndex: 1, draft: firstDraft },
        { pageIndex: 2, draft: secondDraft }
      ]
    });

    expect(mocks.keeperStoryExtractForSave).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        pageIndex: 2,
        currentState: expect.objectContaining({ facts: [{ text: "Mara has the red key.", pageIndex: 1 }] })
      })
    );
    expect(mocks.prepareEmbedding).toHaveBeenNthCalledWith(1, firstDraft.summary, expect.anything());
    expect(mocks.prepareEmbedding).toHaveBeenNthCalledWith(2, secondDraft.summary, expect.anything());
    expect(prepared).toEqual([
      expect.objectContaining({ pageIndex: 1, preparedEmbedding: expect.objectContaining({ vectorLiteral: "[0.1,0.2]" }) }),
      expect.objectContaining({
        pageIndex: 2,
        storyExtract: expect.any(Object),
        preparedEmbedding: { vectorLiteral: null, error: "embedding provider unavailable" }
      })
    ]);
  });
});

describe("deferred page memory publication", () => {
  it("writes continuity, story/entity state, and embeddings against replacement page ids", async () => {
    const tx = publicationTx({ characters: ["Mara"] });
    await persistPreparedDeferredPageMemory({
      tx: tx as never,
      projectId: "project-1",
      plan: { promises: [] } as never,
      strategyId: "standard",
      pageIds: new Map([[1, "replacement-page-1"]]),
      prepared: [{
        pageIndex: 1,
        draft: firstDraft,
        preparedEmbedding: { vectorLiteral: "[0.1,0.2]", error: null },
        storyExtract: { storyDelta: storyDelta("Mara has the key."), contradictions: [] } as never
      }],
      tags: ["edit", "replan"]
    });

    expect(tx.continuityNote.createMany).toHaveBeenCalledWith({
      data: [{
        projectId: "project-1",
        pageId: "replacement-page-1",
        scope: "page:1",
        body: "Mara carries the red key.",
        tags: ["page", "1", "standard", "edit", "replan"]
      }]
    });
    expect(rawStatement(tx, "UPDATE \"Page\"")).toEqual([
      "project-1",
      JSON.stringify([{ page_id: "replacement-page-1", story_delta: storyDelta("Mara has the key.") }])
    ]);
    expect(tx.project.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      data: { storyState: expect.objectContaining({ facts: [{ text: "Mara has the key.", pageIndex: 1 }] }) }
    }));
    expect(mocks.updateEntityStateFromPage).toHaveBeenCalledWith(
      "project-1",
      1,
      firstDraft.continuityNotes,
      tx
    );
    const [projectId, provider, vectors] = rawStatement(tx, "INSERT INTO \"Embedding\"") ?? [];
    expect(projectId).toBe("project-1");
    expect(provider).toBe("fake");
    expect(JSON.parse(String(vectors))).toEqual([
      expect.objectContaining({
        page_id: "replacement-page-1",
        scope: "page:1",
        summary: firstDraft.summary,
        vector_literal: "[0.1,0.2]"
      })
    ]);
  });

  it("publishes a whole book in statements bounded by the cast, not by the page count", async () => {
    const tx = publicationTx({ characters: ["Mara"] });
    const pageCount = 60;
    const prepared = Array.from({ length: pageCount }, (_, offset) => ({
      pageIndex: offset + 1,
      draft: { ...firstDraft, continuityNotes: [`Mara reaches page ${offset + 1}.`] },
      preparedEmbedding: { vectorLiteral: "[0.1,0.2]", error: null },
      storyExtract: { storyDelta: storyDelta(`Mara reached ${offset + 1}.`), contradictions: [] } as never
    }));

    await persistPreparedDeferredPageMemory({
      tx: tx as never,
      projectId: "project-1",
      plan: { promises: [] } as never,
      strategyId: "standard",
      pageIds: new Map(prepared.map((page): [number, string] => [page.pageIndex, `page-${page.pageIndex}`])),
      prepared
    });

    // Four arms and their savepoints, whatever the book's length: the note
    // insert, the page-delta update, the story-state fold, the cast read and
    // the vector upsert. A per-page loop cost this many statements every three
    // or four pages, and the transaction it runs in is the caller's whole
    // manuscript publication.
    expect(tx.statements.length).toBeLessThanOrEqual(20);
    expect(tx.continuityNote.createMany).toHaveBeenCalledTimes(1);
    const [noteInsert] = tx.continuityNote.createMany.mock.calls;
    expect((noteInsert?.[0] as { data: unknown[] } | undefined)?.data).toHaveLength(pageCount);
    expect(tx.project.findUnique).toHaveBeenCalledTimes(1);
    expect(tx.project.updateMany).toHaveBeenCalledTimes(1);
    expect(tx.character.findMany).toHaveBeenCalledTimes(1);
    expect(mocks.updateEntityStateFromPage).toHaveBeenCalledTimes(1);
    expect(mocks.persistStoryExtract).not.toHaveBeenCalled();
    expect(mocks.writePreparedEmbedding).not.toHaveBeenCalled();
    expect(JSON.parse(String(rawStatement(tx, "INSERT INTO \"Embedding\"")?.[2]))).toHaveLength(pageCount);
  });

  it("stamps each entity with the last page that names it", async () => {
    const tx = publicationTx({ characters: ["Mara", "Tomas"] });
    const notes: Record<number, string[]> = {
      1: ["Mara finds the key."],
      2: ["Tomas locks the gate."],
      3: ["Mara sleeps at the gate."],
      4: ["The rain stops."]
    };

    await persistPreparedDeferredPageMemory({
      tx: tx as never,
      projectId: "project-1",
      plan: { promises: [] } as never,
      strategyId: "standard",
      pageIds: new Map([1, 2, 3, 4].map((index): [number, string] => [index, `page-${index}`])),
      prepared: [4, 2, 1, 3].map((index) => ({
        pageIndex: index,
        draft: { ...firstDraft, continuityNotes: notes[index]! },
        preparedEmbedding: null,
        storyExtract: null
      }))
    });

    // Tomas is last named on page 2 and Mara on page 3, so the batch is cut at
    // exactly those two indexes; page 4 names nobody and joins no group.
    expect(mocks.updateEntityStateFromPage.mock.calls).toEqual([
      ["project-1", 2, [...notes[1]!, ...notes[2]!], tx],
      ["project-1", 3, notes[3]!, tx]
    ]);
  });

  it("rolls back a failed optional embedding to its savepoint and leaves prose publication usable", async () => {
    const tx = publicationTx({ characters: [] });
    tx.$queryRawUnsafe.mockRejectedValueOnce(new Error("vector extension unavailable"));

    await expect(persistPreparedDeferredPageMemory({
      tx: tx as never,
      projectId: "project-1",
      plan: { promises: [] } as never,
      strategyId: "standard",
      pageIds: new Map([[1, "appended-page-1"]]),
      prepared: [{
        pageIndex: 1,
        draft: { ...firstDraft, continuityNotes: [] },
        preparedEmbedding: { vectorLiteral: "[0.1,0.2]", error: null },
        storyExtract: null
      }]
    })).resolves.toBeUndefined();
    await tx.page.update({ where: { id: "appended-page-1" }, data: { status: "COMPLETED" } });

    expect(tx.statements.filter((statement) => /SAVEPOINT/.test(statement))).toEqual([
      'SAVEPOINT "best_effort_page_memory"',
      'ROLLBACK TO SAVEPOINT "best_effort_page_memory"',
      'RELEASE SAVEPOINT "best_effort_page_memory"',
      'SAVEPOINT "best_effort_page_memory"',
      'RELEASE SAVEPOINT "best_effort_page_memory"'
    ]);
    // The vector never landed, so the page keeps a recallable degraded row.
    const degraded = JSON.parse(String(rawStatement(tx, "WITH input AS")?.[1]));
    expect(degraded).toEqual([
      expect.objectContaining({ scope: "page:1", error: "Bulk vector persistence unavailable" })
    ]);
    expect(tx.page.update).toHaveBeenCalledTimes(1);
  });
});

/**
 * A transaction client that records every statement it is asked for, so a test
 * can assert the publication's round trips as well as its rows.
 */
function publicationTx(options: { characters: string[]; locations?: string[] }) {
  const statements: string[] = [];
  const record = <T>(name: string, result: T) =>
    vi.fn(async (...args: unknown[]) => {
      statements.push(typeof args[0] === "string" ? firstLine(args[0]) : name);
      return result;
    });
  return {
    statements,
    $executeRawUnsafe: record("$executeRawUnsafe", 1),
    $queryRawUnsafe: vi.fn(async (sql: string, ...params: unknown[]) => {
      statements.push(firstLine(sql));
      // The vector upsert answers with the rows it wrote; the publication
      // treats a short count as a refusal.
      const vectors = JSON.parse(String(params[2] ?? "[]")) as unknown[];
      return [{ count: vectors.length }];
    }),
    continuityNote: { createMany: record("continuityNote.createMany", { count: 1 }) },
    project: {
      findUnique: record("project.findUnique", { storyState: null }),
      updateMany: record("project.updateMany", { count: 1 })
    },
    character: {
      findMany: record("character.findMany", options.characters.map((name) => ({ name })))
    },
    location: {
      findMany: record("location.findMany", (options.locations ?? []).map((name) => ({ name })))
    },
    page: { update: vi.fn().mockResolvedValue({}) }
  };
}

/** The arguments the one raw statement matching `needle` was issued with. */
function rawStatement(tx: ReturnType<typeof publicationTx>, needle: string): unknown[] | undefined {
  const issued: unknown[][] = [...tx.$executeRawUnsafe.mock.calls, ...tx.$queryRawUnsafe.mock.calls];
  const call = issued.find(([sql]) => typeof sql === "string" && sql.includes(needle));
  return call?.slice(1);
}

function firstLine(sql: string): string {
  return sql.trim().split("\n")[0]!.trim();
}

function storyDelta(fact: string) {
  return {
    promisesOpened: [],
    promisesPaid: [],
    promisesBroken: [],
    factsAdded: [fact],
    entities: {},
    unansweredAdded: [],
    unansweredResolved: []
  };
}
