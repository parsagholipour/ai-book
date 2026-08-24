import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The rule behind `progress.pages.complete`: a kept FAILED_QA draft is a page of
 * the book exactly when nothing is still going to redraft it.
 *
 * `projectStatus.test.ts` measures that through the poll, which is where the
 * number becomes visible. These are the same rule asked directly, because the
 * question it now answers — *which fork* of an edit is in flight — has more
 * answers than a poll fixture per case would be readable at.
 */

const { mockPrisma } = vi.hoisted(() => ({
  mockPrisma: {
    generationJob: { findMany: vi.fn(async (_args?: unknown) => [] as unknown[]) },
    // The operation row an open `APPLY_BOOK_EDIT` names. A picture move and a
    // page rewrite are the same job type; this column is what tells them apart.
    bookEditOperation: { findMany: vi.fn(async (_args?: unknown) => [] as unknown[]) }
  }
}));

vi.mock("@book-maker/db", () => ({ prisma: mockPrisma, Prisma: { DbNull: "DbNull" } }));

import {
  EDIT_OPERATION_PAGE_REWRITE_SCOPE,
  countBookPages,
  pageRewriteScope,
  type PendingPageRewriteScope,
  type ProjectPageRow
} from "./projectPageCounts.js";

type OpenJobRow = { type: string; payload: unknown };

function openJob(type: string, payload: Record<string, unknown> = {}): OpenJobRow {
  return { type, payload };
}

/** An open `APPLY_BOOK_EDIT`, which is every chat edit whatever it does. */
function applyJob(operationId = "operation-1"): OpenJobRow {
  return openJob("APPLY_BOOK_EDIT", {
    planId: "plan-1",
    operationId,
    affectedPageIndexes: [2],
    request: "move the picture on page 2 down"
  });
}

/**
 * What the project has queued or running. The double applies the `where`'s own
 * type filter rather than handing every row back, because half of what that
 * read does is *not asking* about a job that cannot rewrite a page.
 */
function openJobs(rows: OpenJobRow[]): void {
  mockPrisma.generationJob.findMany.mockImplementation(async (args?: unknown) => {
    const where = (args as { where?: { type?: { in?: string[] }; status?: { in?: string[] } } } | undefined)?.where;
    const types = where?.type?.in;
    if (!Array.isArray(types) || !where?.status?.in?.includes("QUEUED")) {
      return [];
    }
    return rows.filter((row) => types.includes(row.type));
  });
}

/**
 * The `BookEditOperation` rows those applies name, keyed by the id their
 * payloads carry. Rows come back only for the ids actually asked for, so an id
 * with no entry is the missing-row case rather than a silent pass.
 */
function editOperations(
  operationById: Record<string, string | { kind: string; affectedPageIndexes: number[] }>
): void {
  mockPrisma.bookEditOperation.findMany.mockImplementation(async (args?: unknown) => {
    const ids = (args as { where?: { id?: { in?: string[] } } } | undefined)?.where?.id?.in ?? [];
    return ids.flatMap((id) => {
      const operation = operationById[id];
      if (!operation) {
        return [];
      }
      return [
        typeof operation === "string"
          ? { id, kind: operation, affectedPageIndexes: [2] }
          : { id, ...operation }
      ];
    });
  });
}

/** Every read of those rows, as the `where` asked for them. */
function editOperationReads(): Array<{ ids: string[]; select: Record<string, boolean> | undefined }> {
  return mockPrisma.bookEditOperation.findMany.mock.calls.map((entry) => {
    const args = entry[0] as { where?: { id?: { in?: string[] } }; select?: Record<string, boolean> } | undefined;
    return { ids: args?.where?.id?.in ?? [], select: args?.select };
  });
}

/** `enum BookEditOperationKind` as `schema.prisma` declares it. */
function editOperationKindsFromSchema(): string[] {
  const schema = readFileSync(new URL("../../../packages/db/prisma/schema.prisma", import.meta.url), "utf8");
  const block = /\nenum BookEditOperationKind \{\n([\s\S]*?)\n\}\n/.exec(schema);
  const body = block?.[1];
  if (!body) {
    throw new Error("`enum BookEditOperationKind` is not in packages/db/prisma/schema.prisma — this test is measuring nothing.");
  }
  return body.split("\n").flatMap((line) => {
    const value = /^\s{2}([A-Z_]+)\s*$/.exec(line);
    return value?.[1] ? [value[1]] : [];
  });
}

function pageRow(row: Pick<ProjectPageRow, "status"> & Partial<ProjectPageRow>): ProjectPageRow {
  return {
    id: "p1",
    index: 1,
    revision: 1,
    hasQualityReport: false,
    hasMarkdown: row.status === "COMPLETED",
    ...row
  } as ProjectPageRow;
}

const ALL_REWRITES: PendingPageRewriteScope = { kind: "all" };
const NO_REWRITES: PendingPageRewriteScope = { kind: "page_indexes", pageIndexes: [] };

describe("pageRewriteScope", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Spelled out because `clearAllMocks` clears the calls and leaves the
    // implementations: without this, one test's open jobs are still answering
    // the next test's read.
    mockPrisma.generationJob.findMany.mockImplementation(async () => []);
    mockPrisma.bookEditOperation.findMany.mockImplementation(async () => []);
  });

  it("never reads anything for a book that is still being written", async () => {
    // A GENERATING book's kept drafts are owed a rewrite whatever is queued,
    // and this is the poll that runs every few seconds.
    openJobs([applyJob()]);
    editOperations({ "operation-1": "MOVE_IMAGE" });

    expect(await pageRewriteScope("project-1", "GENERATING")).toEqual(ALL_REWRITES);
    expect(mockPrisma.generationJob.findMany).not.toHaveBeenCalled();
    expect(editOperationReads()).toEqual([]);
  });

  it("settles a finished book with nothing open", async () => {
    expect(await pageRewriteScope("project-1", "COMPLETE")).toEqual(NO_REWRITES);
    expect(editOperationReads()).toEqual([]);
  });

  it("settles one while a picture is being moved", async () => {
    // The failure this predicate was reported for. Moving a picture is free and
    // is explicitly not a page edit; it rides `APPLY_BOOK_EDIT` all the same, so
    // a job type could only answer "yes, this rewrites pages" — and a delivered
    // book's kept drafts stopped counting for the length of the move, with a
    // stalled operation row holding it there for good.
    openJobs([applyJob()]);
    editOperations({ "operation-1": "MOVE_IMAGE" });

    expect(await pageRewriteScope("project-1", "COMPLETE")).toEqual(NO_REWRITES);
  });

  it("settles one for the other two presentation forks too", async () => {
    // `applyImageLayout` and `applyImageInsertion` write `markdown`, an
    // `imagePrompt` and a revision bump; neither touches `Page.status`, neither
    // goes through the review loop, and both recompile with `skipFinalReview`.
    for (const kind of ["REMOVE_IMAGE", "ADD_IMAGE"]) {
      openJobs([applyJob()]);
      editOperations({ "operation-1": kind });

      expect(await pageRewriteScope("project-1", "EDITING")).toEqual(NO_REWRITES);
    }
  });

  it("does not settle one while a page rewrite is in flight", async () => {
    // The fork that reaches the rewrite loop, through the identical job row.
    openJobs([applyJob()]);
    editOperations({ "operation-1": "PAGE_REWRITE" });

    expect(await pageRewriteScope("project-1", "COMPLETE")).toEqual({
      kind: "page_indexes",
      pageIndexes: [2]
    });
  });

  it("does not settle one while a structural insert is drafting", async () => {
    // `restructurePages` drafts the inserted pages through
    // `reviewAndSaveGeneratedPage` and queues its full-review recompile only
    // after the last one is written, so this window has no compile row to see.
    openJobs([applyJob()]);
    editOperations({ "operation-1": "RESTRUCTURE_PAGES" });

    expect(await pageRewriteScope("project-1", "EDITING")).toEqual(ALL_REWRITES);
  });

  it("lets one page-rewriting fork answer for a batch of presentation ones", async () => {
    openJobs([applyJob("operation-1"), applyJob("operation-2")]);
    editOperations({
      "operation-1": "MOVE_IMAGE",
      "operation-2": { kind: "PAGE_REWRITE", affectedPageIndexes: [4, 2, 4] }
    });

    expect(await pageRewriteScope("project-1", "EDITING")).toEqual({
      kind: "page_indexes",
      pageIndexes: [2, 4]
    });
    // One read, by primary key, for both of them.
    expect(editOperationReads()).toEqual([
      { ids: ["operation-1", "operation-2"], select: { id: true, kind: true, affectedPageIndexes: true } }
    ]);
  });

  it("asks nothing about a fork another open job has already answered", async () => {
    // A full-review recompile rewrites pages whatever the edit beside it was
    // doing, and the job read already knows that. The fork is a question only
    // where the answer still turns on it — which keeps the second read off the
    // one open row a delivered book always has, the `skipFinalReview` export
    // repair queued every five minutes.
    openJobs([applyJob(), openJob("COMPILE_EXPORT", { planId: "plan-2" })]);
    editOperations({ "operation-1": "MOVE_IMAGE" });

    expect(await pageRewriteScope("project-1", "COMPLETE")).toEqual(ALL_REWRITES);
    expect(editOperationReads()).toEqual([]);
  });

  it("still settles one whose open work cannot rewrite a page", async () => {
    // A narration, a library portrait and an export repair are open on plenty
    // of delivered books, and none of them can move a page. The type filter
    // keeps the first two out of the read entirely; `skipFinalReview` is what
    // answers for the third.
    openJobs([
      openJob("GENERATE_AUDIOBOOK", { narrationId: "narration-1" }),
      openJob("GENERATE_CHARACTER_PORTRAIT", { characterId: "character-1" }),
      openJob("COMPILE_EXPORT", { planId: "plan-1", skipFinalReview: true, detachedFromProjectLifecycle: true })
    ]);

    expect(await pageRewriteScope("project-1", "COMPLETE")).toEqual(NO_REWRITES);
    expect(editOperationReads()).toEqual([]);
  });

  it("does not settle one whose apply names no operation, and reads nothing", async () => {
    // A payload rebuilt without `operationId` is a job the handler cannot run
    // either — it throws "Book edit operation not found" — so there is no fork
    // to read and nothing to read it by. Unknown answers the safe way: a page
    // reported owed and then delivered, never delivered and then taken back.
    openJobs([openJob("APPLY_BOOK_EDIT", { planId: "plan-1" })]);

    expect(await pageRewriteScope("project-1", "EDITING")).toEqual(ALL_REWRITES);
    expect(editOperationReads()).toEqual([]);
  });

  it("does not settle one whose operation row is not there", async () => {
    openJobs([applyJob()]);
    editOperations({});

    expect(await pageRewriteScope("project-1", "EDITING")).toEqual(ALL_REWRITES);
  });

  it("does not settle one on a kind this build has never heard of", async () => {
    // `satisfies` makes a new `BookEditOperationKind` a compile error in the
    // table — but only once the client is regenerated, and the database is
    // migrated first. A kind this process cannot name is work it cannot rule
    // out, so the lookup's fallback is the safe direction rather than `false`.
    openJobs([applyJob()]);
    editOperations({ "operation-1": "REWRITE_EVERYTHING" });

    expect(await pageRewriteScope("project-1", "COMPLETE")).toEqual(ALL_REWRITES);
  });
});

describe("which forks of an edit rewrite pages", () => {
  it("answers every kind `schema.prisma` declares", () => {
    // The other half of `satisfies`, for the same reason the page read's column
    // list is measured against the schema: the compiler checks this table
    // against the *generated client*, which is a `pnpm db:generate` behind the
    // migration that added the kind. A kind missing here is one the lookup's
    // fallback has to carry, and that fallback is the conservative answer
    // rather than the right one.
    const declared = editOperationKindsFromSchema();

    expect(declared).toContain("MOVE_IMAGE");
    expect(Object.keys(EDIT_OPERATION_PAGE_REWRITE_SCOPE).sort()).toEqual([...declared].sort());
  });

  it("separates page-scoped, whole-book and presentation forks", () => {
    const grouped = Object.entries(EDIT_OPERATION_PAGE_REWRITE_SCOPE).reduce<Record<string, string[]>>(
      (result, [kind, scope]) => {
        (result[scope] ??= []).push(kind);
        return result;
      },
      {}
    );

    expect(grouped.none?.sort()).toEqual(["ADD_IMAGE", "MOVE_IMAGE", "REMOVE_IMAGE"]);
    expect(grouped.page_indexes?.sort()).toEqual([
      "CHAPTER_REGENERATE",
      "LOCAL_PATCH",
      "MANUAL_EDIT",
      "PAGE_REWRITE"
    ]);
    expect(grouped.all?.sort()).toEqual([
      "BOOK_REPLAN",
      "CONTINUE_BOOK",
      "PLAN_REVISION",
      "RESTRUCTURE_PAGES"
    ]);
  });

  it("fails an empty page-scoped operation safe to whole-book ownership", async () => {
    openJobs([applyJob()]);
    editOperations({
      "operation-1": { kind: "LOCAL_PATCH", affectedPageIndexes: [] }
    });

    expect(await pageRewriteScope("project-1", "COMPLETE")).toEqual(ALL_REWRITES);
  });

  it("fails a malformed page index safe to whole-book ownership", async () => {
    openJobs([applyJob()]);
    editOperations({
      "operation-1": { kind: "CHAPTER_REGENERATE", affectedPageIndexes: [2, -1] }
    });

    expect(await pageRewriteScope("project-1", "COMPLETE")).toEqual(ALL_REWRITES);
  });

  it("fails a page-scoped job with no payload targets safe to whole-book ownership", async () => {
    openJobs([openJob("APPLY_BOOK_EDIT", { operationId: "operation-1" })]);
    editOperations({
      "operation-1": { kind: "PAGE_REWRITE", affectedPageIndexes: [2] }
    });

    expect(await pageRewriteScope("project-1", "COMPLETE")).toEqual(ALL_REWRITES);
  });

  it("narrows every text-edit fork to its durable page indexes", async () => {
    const pageScopedKinds = Object.entries(EDIT_OPERATION_PAGE_REWRITE_SCOPE)
      .flatMap(([kind, scope]) => (scope === "page_indexes" ? [kind] : []))
      .sort();

    for (const kind of pageScopedKinds) {
      openJobs([applyJob()]);
      editOperations({
        "operation-1": { kind, affectedPageIndexes: [7, 2, 7] }
      });

      expect(await pageRewriteScope("project-1", "COMPLETE")).toEqual({
        kind: "page_indexes",
        pageIndexes: [2, 7]
      });
    }
  });
});

describe("countBookPages", () => {
  it("counts a kept draft only once the rewrites are settled", () => {
    // FAILED_QA is written at two moments that mean opposite things: when a
    // page's rewrite budget runs out, with the compile's repair still to come,
    // and again by that repair for the pages it could not fix. The second is
    // the book; the first is a page still owed.
    const pages = [
      pageRow({ id: "p1", index: 1, status: "COMPLETED" }),
      pageRow({ id: "p2", index: 2, status: "FAILED_QA", hasMarkdown: true })
    ];

    expect(countBookPages(pages, NO_REWRITES)).toBe(2);
    expect(countBookPages(pages, ALL_REWRITES)).toBe(1);
  });

  it("excludes only kept drafts whose page indexes are still owned", () => {
    const pages = [
      pageRow({ id: "p1", index: 1, status: "COMPLETED" }),
      pageRow({ id: "p2", index: 2, status: "FAILED_QA", hasMarkdown: true }),
      pageRow({ id: "p3", index: 3, status: "FAILED_QA", hasMarkdown: true })
    ];

    expect(countBookPages(pages, { kind: "page_indexes", pageIndexes: [2] })).toBe(2);
  });

  it("never counts a kept draft that holds no prose", () => {
    // A drafting failure that stored whitespace is a page that never got
    // written: owed, settled or not. The database answers `hasMarkdown` for it.
    const pages = [pageRow({ id: "p1", index: 1, status: "FAILED_QA", hasMarkdown: false })];

    expect(countBookPages(pages, NO_REWRITES)).toBe(0);
  });

  it("counts a completed page whatever the pipeline is doing", () => {
    const pages = [pageRow({ id: "p1", index: 1, status: "COMPLETED" })];

    expect(countBookPages(pages, ALL_REWRITES)).toBe(1);
  });
});
