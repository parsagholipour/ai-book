import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The one statement both vectorless writes issue, pinned as one statement.
 *
 * They used to be two: the degraded placeholder `writePreparedEmbedding` falls
 * back to, and the backoff stamp `repairPageEmbeddings` writes when a provider
 * refuses a summary. Identical columns, identical `ON CONFLICT`, identical `SET`
 * list — and, for a while, different guards, because the stamp was written
 * without the ownership predicate. Each statement read on its own looked right,
 * which is exactly why nothing caught it: what was wrong was the *difference*.
 * So the assertions here are equalities between the two emitted strings rather
 * than a checklist each satisfies separately. A guard, conflict target or `SET`
 * list changed on one write and not the other fails here whatever the change is.
 *
 * `embeddingWrites.test.ts` and `embeddingRepair.test.ts` hold what each write
 * *means* — which row it may land on, what it stamps, what it must not fail.
 */
const mocks = vi.hoisted(() => ({
  prisma: {
    page: { findMany: vi.fn() },
    embedding: { create: vi.fn(), findMany: vi.fn(), delete: vi.fn() },
    $executeRawUnsafe: vi.fn()
  },
  findPageEmbeddingRepairTargets: vi.fn(),
  degradeRetrievalArm: vi.fn()
}));

vi.mock("@book-maker/db", async () => ({
  prisma: mocks.prisma,
  findPageEmbeddingRepairTargets: mocks.findPageEmbeddingRepairTargets,
  degradeRetrievalArm: mocks.degradeRetrievalArm,
  ...(await import("../testing/dbScopeMocks.js")).dbScopeMocks()
}));

import { repairPageEmbeddings } from "./embeddingRepair.js";
import { writePreparedEmbedding } from "./embeddingWrites.js";

/** `SAME_PAGE_ROW_PREDICATE`, transcribed rather than imported: the point is to fail on a re-wording. */
const OWNERSHIP_PREDICATE = '"Embedding"."sourceId" = EXCLUDED."sourceId" OR "Embedding"."sourceId" IS NULL';
const CONFLICT_TARGET = 'ON CONFLICT ("projectId", "scope") DO UPDATE SET';
const refused = { vectorLiteral: null, error: "content filter rejected the summary" };

/**
 * The assignments between `DO UPDATE SET` and the guard, parsed out rather than
 * matched as substrings: `sql.includes('"sourceId" = EXCLUDED."sourceId"')` is
 * satisfied by the *ownership predicate* alone, so a `SET` list that had lost
 * its `sourceId` still passed. The two statements indent their clauses
 * differently, which is why this is a parse and not one string compare.
 */
function setAssignments(sql: string): string[] {
  const afterSet = sql.split("DO UPDATE SET")[1] ?? "";
  return (afterSet.split(/\n\s*WHERE /)[0] ?? "")
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
}

/** The last statement of a repair iteration whose provider refused the summary: the backoff stamp. */
async function backoffStamp(): Promise<unknown[]> {
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
  return mocks.prisma.$executeRawUnsafe.mock.calls.at(-1) ?? [];
}

/** The degraded placeholder, under whichever conflict policy the caller owns. */
async function degradedPlaceholder(conflict: "overwrite" | "same-page"): Promise<unknown[]> {
  mocks.prisma.$executeRawUnsafe.mockResolvedValue(1);
  await writePreparedEmbedding({ projectId: "project-1", scope: "page:7", sourceId: "p7", text: "Page seven summary.", conflict }, refused);
  return mocks.prisma.$executeRawUnsafe.mock.calls.at(-1) ?? [];
}

describe("the vectorless embedding upsert both failure writes share", () => {
  beforeEach(() => vi.clearAllMocks());

  it("is one and the same statement, differing only in the metadata each stamps", async () => {
    const [stampSql, , , , , , stampMetadata] = await backoffStamp();
    vi.clearAllMocks();
    const [placeholderSql, , , , , , placeholderMetadata] = await degradedPlaceholder("same-page");

    expect(String(stampSql)).toBe(String(placeholderSql));
    expect(JSON.parse(String(stampMetadata))).toEqual({
      vectorStored: false,
      error: "content filter rejected the summary",
      repairAttempts: 1,
      repairRetryFromIndex: 32
    });
    expect(JSON.parse(String(placeholderMetadata))).toEqual({
      vectorStored: false,
      error: "content filter rejected the summary"
    });
  });

  it("names those columns, that conflict target, that SET list and both guards", async () => {
    const sql = String((await backoffStamp())[0]);

    expect(sql).toContain('INSERT INTO "Embedding" ("id", "projectId", "scope", "sourceId", "text", "metadata")');
    expect(sql).toContain(CONFLICT_TARGET);
    expect(setAssignments(sql)).toEqual([
      '"sourceId" = EXCLUDED."sourceId"',
      '"text" = EXCLUDED."text"',
      '"metadata" = EXCLUDED."metadata"'
    ]);
    expect(sql).toContain(`WHERE "Embedding"."vector" IS NULL AND (${OWNERSHIP_PREDICATE})`);
    // The vector is neither inserted nor set, which is what leaves the row
    // degraded and so still a repair target.
    expect(sql).not.toContain("::vector");
    expect(sql).not.toContain('"vector" = ');
  });

  it("differs between the two conflict policies by the ownership predicate and nothing else", async () => {
    const samePage = String((await degradedPlaceholder("same-page"))[0]);
    vi.clearAllMocks();
    const overwrite = String((await degradedPlaceholder("overwrite"))[0]);

    expect(samePage).toBe(`${overwrite} AND (${OWNERSHIP_PREDICATE})`);
  });

  /**
   * And the predicate is shared with the vector upsert beside it, so it cannot
   * be re-worded for one write alone. That statement is deliberately *not*
   * unified with this one — it names `"vector"`, sets it, and carries no
   * `IS NULL` guard, because it is the write of a vector that succeeded — but
   * the two clauses it does share with this one are one constant each.
   */
  it("shares its conflict target, SET assignments and ownership predicate with the vector upsert", async () => {
    mocks.prisma.$executeRawUnsafe.mockResolvedValue(1);
    await writePreparedEmbedding(
      { projectId: "project-1", scope: "page:7", sourceId: "p7", text: "Page seven summary.", conflict: "same-page" },
      { vectorLiteral: "[0.5000000]", error: null }
    );
    const vectorSql = String(mocks.prisma.$executeRawUnsafe.mock.calls[0]?.[0]);
    vi.clearAllMocks();
    const stampSql = String((await backoffStamp())[0]);

    expect(vectorSql).toContain("::vector");
    for (const sql of [vectorSql, stampSql]) {
      expect(sql).toContain(CONFLICT_TARGET);
      expect(sql).toContain(OWNERSHIP_PREDICATE);
    }
    // The vector's own assignment is the whole of the difference between the
    // two `SET` lists, in the position it holds today.
    expect(setAssignments(vectorSql)).toEqual([
      ...setAssignments(stampSql).slice(0, 2),
      '"vector" = EXCLUDED."vector"',
      ...setAssignments(stampSql).slice(2)
    ]);
  });
});
