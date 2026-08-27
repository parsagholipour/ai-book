import { PAGE_REWRITING_JOB_TYPES } from "@book-maker/core";
import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * `progress.pages.complete` and `progress.quality.blockedPages` are two counts
 * of the same rows, and they used to be two reads of them: a `page.count` for
 * the complete predicate and a `page.findMany` for everything else. Between
 * those two snapshots the compile's repair pass flips FAILED_QA pages to
 * COMPLETED one at a time, so a poll could come back "5 complete, 1 blocked"
 * for a book with six pages and nothing blocked — two true states, reported as
 * one that never existed.
 *
 * These tests hold the fix: one read of the pages, every page number counted
 * off it, and the page body left in the database.
 */

const { mockPrisma } = vi.hoisted(() => ({
  mockPrisma: {
    project: { findUnique: vi.fn(async () => null as unknown) },
    // Kept on the double precisely so a test can prove neither is called: any
    // second read of the pages is a second snapshot.
    page: { count: vi.fn(async () => 0), findMany: vi.fn(async () => [] as unknown[]) },
    generationJob: {
      count: vi.fn(async () => 0),
      // Two different reads land here — the failed jobs behind `retryAvailable`
      // and the project's open compiles — so the double answers per query.
      findMany: vi.fn(async (_args?: unknown) => [] as unknown[]),
      findFirst: vi.fn(async () => null as unknown)
    },
    generationAttempt: { findMany: vi.fn(async () => [] as unknown[]) },
    // The fork an open `APPLY_BOOK_EDIT` took, which lives on the operation row
    // rather than on the job: a picture move and a page rewrite are the same
    // job type, and only one of them is going to redraft a page.
    bookEditOperation: { findMany: vi.fn(async (_args?: unknown) => [] as unknown[]) },
    imageAsset: { count: vi.fn(async () => 0), findMany: vi.fn(async () => [] as unknown[]) },
    providerCallLog: { findMany: vi.fn(async () => [] as unknown[]) },
    // Both raw doors, for the reason the typed pair above is here: a second
    // statement over these rows is a second snapshot, whichever one sends it.
    $queryRaw: vi.fn(async (..._args: unknown[]) => [] as unknown[]),
    $queryRawUnsafe: vi.fn(async (..._args: unknown[]) => [] as unknown[])
  }
}));

vi.mock("@book-maker/db", () => ({
  prisma: mockPrisma,
  Prisma: { DbNull: "DbNull" }
}));

import { buildProjectStatus } from "./projectStatus.js";

type PageRow = {
  id: string;
  index: number;
  status: string;
  revision: number;
  hasQualityReport: boolean;
  hasMarkdown: boolean;
};

function pageRow(row: Pick<PageRow, "id" | "index" | "status"> & Partial<PageRow>): PageRow {
  return {
    revision: 1,
    hasQualityReport: false,
    hasMarkdown: row.status === "COMPLETED",
    ...row
  };
}

type OpenJobRow = { type: string; payload: unknown };

/** One open `GenerationJob` row as the page-rewrite read selects it. */
function openJob(type: string, payload: Record<string, unknown> = {}): OpenJobRow {
  return { type, payload };
}

/**
 * What the project has queued or running, for the read that decides whether a
 * kept draft is still owed a rewrite.
 *
 * The double applies the `where`'s own type filter rather than handing every
 * row back, because half of what that read does is *not asking* about a job
 * that cannot rewrite a page: a narration this returned anyway would prove
 * nothing about the query. The other `findMany` in this handler — the failed
 * jobs behind `retryAvailable` — filters on a type list too, so the open
 * statuses are what tell the two apart.
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

/** Every read of the project's *open* jobs, in the order the handler sent them. */
function pageRewriteReadCalls(): Array<{ type?: { in?: string[] }; select?: Record<string, boolean> }> {
  return mockPrisma.generationJob.findMany.mock.calls.flatMap((entry) => {
    const args = entry[0] as
      | { where?: { type?: { in?: string[] }; status?: { in?: string[] } }; select?: Record<string, boolean> }
      | undefined;
    return args?.where?.status?.in?.includes("QUEUED") === true
      ? [{ ...(args.where?.type ? { type: args.where.type } : {}), ...(args.select ? { select: args.select } : {}) }]
      : [];
  });
}

/** The type list the page-rewrite read asked for, or null if it never ran. */
function pageRewriteReadTypes(): string[] | null {
  return pageRewriteReadCalls()[0]?.type?.in ?? null;
}

/** What each of those reads asked the database to hand back. */
function pageRewriteReadSelects(): Array<Record<string, boolean> | undefined> {
  return pageRewriteReadCalls().map((call) => call.select);
}

/**
 * The `BookEditOperation` rows the open applies name, keyed by the id their
 * payloads carry. Rows are handed back only for the ids actually asked for, so
 * an id with no entry is the missing-row case rather than a silent pass.
 */
function editOperations(kindById: Record<string, string>): void {
  mockPrisma.bookEditOperation.findMany.mockImplementation(async (args?: unknown) => {
    const ids = (args as { where?: { id?: { in?: string[] } } } | undefined)?.where?.id?.in ?? [];
    return ids.flatMap((id) => {
      const kind = kindById[id];
      return kind ? [{ id, kind, affectedPageIndexes: [3] }] : [];
    });
  });
}

/** The ids each read of those rows asked for, in the order it asked. */
function editOperationReadIds(): string[][] {
  return mockPrisma.bookEditOperation.findMany.mock.calls.map(
    (entry) => (entry[0] as { where?: { id?: { in?: string[] } } } | undefined)?.where?.id?.in ?? []
  );
}

function projectRecord(overrides: Record<string, unknown> = {}) {
  return {
    id: "project-1",
    status: "GENERATING",
    targetPages: 6,
    currentPlanId: "plan-1",
    currentPlan: { id: "plan-1", createdAt: new Date("2026-08-20T00:00:00.000Z") },
    jobs: [],
    _count: { pages: 6, images: 0, research: 0 },
    ...overrides
  };
}

/** A book part-drafted, part-flagged: the six rows both mixed-book tests read. */
function mixedBookRows(): PageRow[] {
  return [
    pageRow({ id: "p1", index: 1, status: "COMPLETED", hasQualityReport: true }),
    pageRow({ id: "p2", index: 2, status: "COMPLETED", revision: 2, hasQualityReport: true }),
    pageRow({ id: "p3", index: 3, status: "FAILED_QA", revision: 3, hasMarkdown: true, hasQualityReport: true }),
    pageRow({ id: "p4", index: 4, status: "FAILED_QA", hasMarkdown: false }),
    pageRow({ id: "p5", index: 5, status: "GENERATING" }),
    pageRow({ id: "p6", index: 6, status: "PENDING" })
  ];
}

/** Every page of a three-page book written, one of them out of QA budget. */
function draftedBookRows(): PageRow[] {
  return [
    pageRow({ id: "p1", index: 1, status: "COMPLETED", hasQualityReport: true }),
    pageRow({ id: "p2", index: 2, status: "COMPLETED", hasQualityReport: true }),
    pageRow({ id: "p3", index: 3, status: "FAILED_QA", revision: 3, hasMarkdown: true, hasQualityReport: true })
  ];
}

/** The statement the one page read actually sent. */
function pageReadSql(): string {
  const [sql] = mockPrisma.$queryRawUnsafe.mock.calls[0] as [string, ...unknown[]];
  return sql;
}

/** Every `"quoted"` identifier the statement names, in the order it names them. */
function pageReadIdentifiers(): string[] {
  return [...pageReadSql().matchAll(/"([^"]+)"/g)].map((match) => match[1] ?? "");
}

const SCALAR_FIELD_TYPES = new Set([
  "String",
  "Int",
  "Boolean",
  "DateTime",
  "Json",
  "Float",
  "BigInt",
  "Decimal",
  "Bytes"
]);

/**
 * `model Page` as `schema.prisma` declares it — the columns and the block they
 * were declared in.
 *
 * The `satisfies` in `projectPageCounts.ts` ties the statement's identifiers to the
 * *generated client*, which is a rename away from failing `tsc`. It cannot see
 * a `@map` / `@@map`, which renames a column while leaving the field alone and
 * would take the status endpoint down with a green suite behind it. This reads
 * the schema itself, so both halves of "a field name is a column name" are
 * measured rather than assumed.
 */
function pageModelFromSchema(): { columns: string[]; body: string } {
  const schema = readFileSync(new URL("../../../packages/db/prisma/schema.prisma", import.meta.url), "utf8");
  const model = /\nmodel Page \{\n([\s\S]*?)\n\}\n/.exec(schema);
  const body = model?.[1];
  if (!body) {
    throw new Error("`model Page` is not in packages/db/prisma/schema.prisma — this test is measuring nothing.");
  }
  const columns = body.split("\n").flatMap((line) => {
    const field = /^\s{2}(\w+)\s+(\w+)/.exec(line);
    const [, name, type] = field ?? [];
    return name && type && SCALAR_FIELD_TYPES.has(type) ? [name] : [];
  });
  return { columns, body };
}

describe("buildProjectStatus page counts", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPrisma.project.findUnique.mockResolvedValue(projectRecord() as never);
    mockPrisma.$queryRawUnsafe.mockResolvedValue([] as never);
    // Spelled out because `clearAllMocks` clears the calls and leaves the
    // implementations: without this, one test's open compiles are still
    // answering the next test's read.
    mockPrisma.generationJob.findMany.mockImplementation(async () => []);
    mockPrisma.bookEditOperation.findMany.mockImplementation(async () => []);
  });

  it("counts a mixed COMPLETED/FAILED_QA/in-progress book off one snapshot", async () => {
    // A page that ran out of QA budget keeps its best draft, but the compile's
    // repair pass is still coming for it while the book is GENERATING, so it is
    // owed rather than done; one that never drafted is owed either way. Both
    // are flagged, which is what keeps the two numbers different but
    // consistent — one snapshot, no pair of them contradicting each other.
    mockPrisma.$queryRawUnsafe.mockResolvedValue(mixedBookRows() as never);

    const status = await buildProjectStatus("project-1");

    expect(status?.progress.pages).toEqual({ complete: 2, target: 6 });
    expect(status?.progress.quality).toEqual({ reviewedPages: 3, repairedPages: 2, blockedPages: 2 });
    // The pipeline's page detail is the same number, not a third count of it.
    expect(status?.progress.pipeline.find((step) => step.key === "pages")?.detail).toBe("2/6 pages");
  });

  it("counts the same book's kept draft once the pipeline is finished with it", async () => {
    // Identical rows, a finished project: the repair has had its turn and the
    // FAILED_QA page holds the prose the export shipped, so it is a page of the
    // book. A readable 200-page book must not report 197/200 forever. It is
    // still flagged — `blockedPages` is what the quality card reads.
    mockPrisma.project.findUnique.mockResolvedValue(projectRecord({ status: "REVIEW_REQUIRED" }) as never);
    mockPrisma.$queryRawUnsafe.mockResolvedValue(mixedBookRows() as never);

    const status = await buildProjectStatus("project-1");

    expect(status?.progress.pages).toEqual({ complete: 3, target: 6 });
    expect(status?.progress.quality).toEqual({ reviewedPages: 3, repairedPages: 2, blockedPages: 2 });
    expect(status?.progress.pipeline.find((step) => step.key === "pages")?.detail).toBe("3/6 pages");
  });

  it("counts the kept draft of a book being edited, whose recompile skips the repair", async () => {
    // An ordinary edit that ends FAILED_QA is settled the moment it is written:
    // its own recompile carries `skipFinalReview`, so no repair pass is coming
    // for that page. The shelf card and the book screen read this count for a
    // book in EDITING, and a page dropping off it mid-edit is a finished book
    // losing a page.
    mockPrisma.project.findUnique.mockResolvedValue(projectRecord({ status: "EDITING" }) as never);
    mockPrisma.$queryRawUnsafe.mockResolvedValue(mixedBookRows() as never);
    openJobs([openJob("COMPILE_EXPORT", { planId: "plan-1", skipFinalReview: true })]);

    const status = await buildProjectStatus("project-1");

    expect(status?.progress.pages.complete).toBe(3);
  });

  it("counts it for a finished book in EDITING with no compile owed at all", async () => {
    // The same book between edits: nothing queued, nothing running, and the
    // kept draft is simply the page the reader is holding.
    mockPrisma.project.findUnique.mockResolvedValue(projectRecord({ status: "EDITING" }) as never);
    mockPrisma.$queryRawUnsafe.mockResolvedValue(mixedBookRows() as never);

    const status = await buildProjectStatus("project-1");

    expect(status?.progress.pages.complete).toBe(3);
  });

  it("stops counting it while a structural edit's full-review recompile is owed", async () => {
    // `restructurePages` queues its recompile with no `skipFinalReview` — the
    // one edit that pays for the chapter-transition review — and that compile's
    // repair pass is handed *every* FAILED_QA page in the book. So the page is
    // owed a rewrite again, in a status the count used to read as finished —
    // the shape of "add 3 pages" answering 203/203 with three pages owed.
    mockPrisma.project.findUnique.mockResolvedValue(projectRecord({ status: "EDITING" }) as never);
    mockPrisma.$queryRawUnsafe.mockResolvedValue(mixedBookRows() as never);
    openJobs([openJob("COMPILE_EXPORT", { planId: "plan-2", contentRevision: 4 })]);

    const status = await buildProjectStatus("project-1");

    expect(status?.progress.pages.complete).toBe(2);
    // Still flagged, and still one snapshot: the two numbers move together.
    expect(status?.progress.quality.blockedPages).toBe(2);
    // Off the job index, not out of the 25 newest jobs of any type: churn
    // pushes the row that matters out of that window, and a count that changes
    // meaning when it does is the skew again with nothing to see.
    expect(mockPrisma.generationJob.findMany).toHaveBeenCalledWith({
      where: {
        projectId: "project-1",
        type: { in: expect.arrayContaining(["COMPILE_EXPORT"]) },
        status: { in: ["QUEUED", "ACTIVE"] }
      },
      select: { type: true, payload: true }
    });
  });

  it("stops counting it for a COMPLETE book whose continuation is still compiling", async () => {
    // `continueBook` sets the project COMPLETE and *then* queues its
    // full-review recompile, so the settled statuses are no safer than EDITING
    // was. Three pages written, one of them out of QA budget and queued for the
    // repair: two.
    mockPrisma.project.findUnique.mockResolvedValue(
      projectRecord({ targetPages: 3, status: "COMPLETE" }) as never
    );
    mockPrisma.$queryRawUnsafe.mockResolvedValue(draftedBookRows() as never);
    openJobs([openJob("COMPILE_EXPORT", { planId: "plan-2" })]);

    const status = await buildProjectStatus("project-1");

    expect(status?.progress.pages).toEqual({ complete: 2, target: 3 });
    // And the pages step does not call itself finished over a page the repair
    // is about to rewrite.
    expect(status?.progress.pipeline.find((step) => step.key === "pages")?.status).not.toBe("done");
  });

  it("reads one open compile's flag past another's", async () => {
    // An export repair sitting QUEUED behind the edit's recompile carries
    // `skipFinalReview` like every repair does. Asking only the first row would
    // answer with it and count the page.
    mockPrisma.project.findUnique.mockResolvedValue(projectRecord({ status: "EDITING" }) as never);
    mockPrisma.$queryRawUnsafe.mockResolvedValue(mixedBookRows() as never);
    openJobs([
      openJob("COMPILE_EXPORT", { planId: "plan-1", skipFinalReview: true, detachedFromProjectLifecycle: true }),
      openJob("COMPILE_EXPORT", { planId: "plan-2" })
    ]);

    const status = await buildProjectStatus("project-1");

    expect(status?.progress.pages.complete).toBe(2);
  });

  it("does not count a page the structural insert has only just flagged", async () => {
    // The window before the compile row exists. `restructurePages` sets the
    // project EDITING and drafts the inserted pages through
    // `reviewAndSaveGeneratedPage`; the full-review recompile is queued only
    // after the *last* page is written. A poll landing on page 2 of 3 sees a
    // settled status and no compile at all, and used to count a page the
    // drafting loop had flagged seconds earlier.
    mockPrisma.project.findUnique.mockResolvedValue(projectRecord({ status: "EDITING" }) as never);
    mockPrisma.$queryRawUnsafe.mockResolvedValue(mixedBookRows() as never);
    openJobs([
      openJob("APPLY_BOOK_EDIT", {
        planId: "plan-1",
        operationId: "operation-1",
        affectedPageIndexes: []
      })
    ]);
    editOperations({ "operation-1": "RESTRUCTURE_PAGES" });

    const status = await buildProjectStatus("project-1");

    expect(status?.progress.pages.complete).toBe(2);
    expect(status?.progress.quality.blockedPages).toBe(2);
  });

  it("keeps a delivered book's page count while a picture is being moved", async () => {
    // Moving a picture is free and is explicitly not a page edit, but it rides
    // `APPLY_BOOK_EDIT` like every chat edit does — so a job type could only
    // answer "yes, this rewrites pages", and a finished book with a kept draft
    // reported one page fewer for the length of the move, dropped `pagesDone`,
    // re-opened its Pages step and then snapped back. A stalled operation row
    // left it there for good. The fork is on the operation, so this asks it.
    mockPrisma.project.findUnique.mockResolvedValue(
      projectRecord({ targetPages: 3, status: "COMPLETE" }) as never
    );
    mockPrisma.$queryRawUnsafe.mockResolvedValue(draftedBookRows() as never);
    openJobs([openJob("APPLY_BOOK_EDIT", { planId: "plan-1", operationId: "operation-1" })]);
    editOperations({ "operation-1": "MOVE_IMAGE" });

    const status = await buildProjectStatus("project-1");

    expect(status?.progress.pages).toEqual({ complete: 3, target: 3 });
    expect(status?.progress.pipeline.find((step) => step.key === "pages")?.status).toBe("done");
    expect(editOperationReadIds()).toEqual([["operation-1"]]);
  });

  it("stops counting it while that same job type is rewriting a page", async () => {
    // The fork that reaches the rewrite loop, through the identical job row:
    // the two are told apart by the operation's `kind` and by nothing else on
    // the poll's side of the database.
    mockPrisma.project.findUnique.mockResolvedValue(
      projectRecord({ targetPages: 3, status: "COMPLETE" }) as never
    );
    mockPrisma.$queryRawUnsafe.mockResolvedValue(draftedBookRows() as never);
    openJobs([
      openJob("APPLY_BOOK_EDIT", {
        planId: "plan-1",
        operationId: "operation-1",
        affectedPageIndexes: [3]
      })
    ]);
    editOperations({ "operation-1": "PAGE_REWRITE" });

    const status = await buildProjectStatus("project-1");

    expect(status?.progress.pages).toEqual({ complete: 2, target: 3 });
  });

  it("keeps unrelated drafts counted while a page-scoped rewrite is open", async () => {
    mockPrisma.project.findUnique.mockResolvedValue(
      projectRecord({ targetPages: 3, status: "COMPLETE" }) as never
    );
    mockPrisma.$queryRawUnsafe.mockResolvedValue([
      pageRow({ id: "p1", index: 1, status: "COMPLETED", hasQualityReport: true }),
      pageRow({ id: "p2", index: 2, status: "FAILED_QA", hasMarkdown: true, hasQualityReport: true }),
      pageRow({ id: "p3", index: 3, status: "FAILED_QA", hasMarkdown: true, hasQualityReport: true })
    ] as never);
    openJobs([
      openJob("APPLY_BOOK_EDIT", {
        planId: "plan-1",
        operationId: "operation-1",
        affectedPageIndexes: [2]
      })
    ]);
    mockPrisma.bookEditOperation.findMany.mockResolvedValue([
      { id: "operation-1", kind: "PAGE_REWRITE", affectedPageIndexes: [2] }
    ] as never);

    const status = await buildProjectStatus("project-1");

    // Page 2 is still owed; page 3 is already the kept draft the book prints.
    expect(status?.progress.pages).toEqual({ complete: 2, target: 3 });
  });

  it("does not count one a replan is still redrafting either", async () => {
    // `replanBook` writes EDITING and then runs the same review loop over the
    // pages its new plan changed — the identical window, reached by the other
    // fork.
    mockPrisma.project.findUnique.mockResolvedValue(projectRecord({ status: "EDITING" }) as never);
    mockPrisma.$queryRawUnsafe.mockResolvedValue(mixedBookRows() as never);
    openJobs([openJob("REPLAN_BOOK", { planId: "plan-1", operationId: "operation-1" })]);

    const status = await buildProjectStatus("project-1");

    expect(status?.progress.pages.complete).toBe(2);
  });

  it("still counts every page of a finished book with work open that cannot rewrite one", async () => {
    // The other direction, and the one a bare "is anything open?" would get
    // wrong: a narration, a library portrait and an export repair are open on
    // plenty of delivered books, and none of them can move a page. A three-page
    // book reporting 2/3 for the hour its audiobook takes is the same skew
    // pointing the other way.
    mockPrisma.project.findUnique.mockResolvedValue(
      projectRecord({ targetPages: 3, status: "COMPLETE" }) as never
    );
    mockPrisma.$queryRawUnsafe.mockResolvedValue(draftedBookRows() as never);
    openJobs([
      openJob("GENERATE_AUDIOBOOK", { narrationId: "narration-1" }),
      openJob("GENERATE_CHARACTER_PORTRAIT", { characterId: "character-1" }),
      openJob("GENERATE_IMAGE", { pageId: "p2" }),
      // In the type list, but its payload takes the repair pass away.
      openJob("COMPILE_EXPORT", { planId: "plan-1", skipFinalReview: true, detachedFromProjectLifecycle: true })
    ]);

    const status = await buildProjectStatus("project-1");

    expect(status?.progress.pages).toEqual({ complete: 3, target: 3 });
    expect(status?.progress.pipeline.find((step) => step.key === "pages")?.status).toBe("done");
  });

  it("asks only about the job types that can rewrite a page", async () => {
    // The list is derived from `JOB_PAGE_REWRITE_SCOPE`, which is exhaustive
    // over `GenerationJobType` — a new job type is a compile error there until
    // someone answers the question. This is the other half: that the answers
    // given are the true ones, in both directions.
    mockPrisma.project.findUnique.mockResolvedValue(projectRecord({ status: "COMPLETE" }) as never);

    await buildProjectStatus("project-1");

    const types = pageRewriteReadTypes();
    expect(types).toEqual(
      expect.arrayContaining([
        "GENERATE_BOOK",
        "GENERATE_PAGE",
        "COMPILE_EXPORT",
        "APPLY_BOOK_EDIT",
        "REPLAN_BOOK",
        "IMPORT_BOOK",
        "CONTINUE_BOOK"
      ])
    );
    // Everything that writes something other than a page, or no project at all.
    expect(types).toEqual(
      expect.not.arrayContaining([
        "PLAN_BOOK",
        "REVISE_PLAN",
        "GENERATE_IMAGE",
        "PREPARE_CHARACTER_CANDIDATES",
        "BUILD_CHARACTER_PERSONA",
        "GENERATE_AUDIOBOOK",
        "GENERATE_CHARACTER_PORTRAIT"
      ])
    );
  });

  it("never sends the open-work read for a book that is still being written", async () => {
    // A GENERATING book's kept drafts are owed a rewrite whatever is queued,
    // and this is the poll that runs every few seconds.
    mockPrisma.$queryRawUnsafe.mockResolvedValue(mixedBookRows() as never);
    openJobs([openJob("COMPILE_EXPORT", { planId: "plan-1", skipFinalReview: true })]);

    const status = await buildProjectStatus("project-1");

    expect(status?.progress.pages.complete).toBe(2);
    expect(pageRewriteReadTypes()).toBeNull();
  });

  it("does not finish the pages step while the repair still owes a FAILED_QA page", async () => {
    // Every page of a three-page book is drafted and one of them ran out of QA
    // budget. `reviewAndSaveGeneratedPage` writes that row the moment the
    // rewrite loop is exhausted — long before COMPILE_EXPORT — so counting it
    // would report 3/3, flip `pagesDone`, mark Pages done and start the images
    // step while the final-QA repair is still rewriting the page.
    mockPrisma.project.findUnique.mockResolvedValue(projectRecord({ targetPages: 3 }) as never);
    mockPrisma.$queryRawUnsafe.mockResolvedValue(draftedBookRows() as never);

    const status = await buildProjectStatus("project-1");
    const step = (key: string) => status?.progress.pipeline.find((entry) => entry.key === key)?.status;

    expect(status?.progress.pages).toEqual({ complete: 2, target: 3 });
    expect(step("pages")).toBe("active");
    expect(step("images")).toBe("pending");
  });

  it("finishes the pages step on the same rows once the book is published", async () => {
    mockPrisma.project.findUnique.mockResolvedValue(
      projectRecord({ targetPages: 3, status: "COMPLETE" }) as never
    );
    mockPrisma.$queryRawUnsafe.mockResolvedValue(draftedBookRows() as never);

    const status = await buildProjectStatus("project-1");

    expect(status?.progress.pages).toEqual({ complete: 3, target: 3 });
    expect(status?.progress.pipeline.find((step) => step.key === "pages")?.status).toBe("done");
  });

  it("takes the complete count off the rows it reported blocked, not a second read", async () => {
    // The two reads the old code made, answering from two different moments of
    // the repair pass: the count from after it finished, the rows from before.
    // Either would be a true answer on its own; together they were the bug.
    mockPrisma.page.count.mockResolvedValue(6 as never);
    mockPrisma.page.findMany.mockResolvedValue(
      [1, 2, 3, 4, 5, 6].map((index) => pageRow({ id: `p${index}`, index, status: "COMPLETED" })) as never
    );
    mockPrisma.$queryRawUnsafe.mockResolvedValue([
      pageRow({ id: "p1", index: 1, status: "COMPLETED" }),
      pageRow({ id: "p2", index: 2, status: "COMPLETED" }),
      pageRow({ id: "p3", index: 3, status: "COMPLETED" }),
      pageRow({ id: "p4", index: 4, status: "COMPLETED" }),
      pageRow({ id: "p5", index: 5, status: "COMPLETED" }),
      pageRow({ id: "p6", index: 6, status: "FAILED_QA", hasMarkdown: false })
    ] as never);

    const status = await buildProjectStatus("project-1");

    expect(status?.progress.pages.complete).toBe(5);
    expect(status?.progress.quality.blockedPages).toBe(1);
    // One read of the pages, and no other, is what makes that pair impossible
    // to contradict. One *statement*, at that: two reads sharing a snapshot
    // would need an isolation level nothing here could check, and losing it
    // would bring the skew back without a symptom.
    expect(mockPrisma.$queryRawUnsafe).toHaveBeenCalledTimes(1);
    expect(mockPrisma.$queryRaw).not.toHaveBeenCalled();
    expect(mockPrisma.page.count).not.toHaveBeenCalled();
    expect(mockPrisma.page.findMany).not.toHaveBeenCalled();
  });

  it("asks the database whether the page body holds prose, never for the body", async () => {
    await buildProjectStatus("project-1");

    const sql = pageReadSql();
    // `COALESCE`, not the bare test: `NULL ~ …` is NULL rather than false —
    // measured against the dev Postgres — so were `markdown` ever to become
    // nullable, a bare test would hand back a third state instead of a boolean
    // and quietly stop counting every FAILED_QA page as written. That is the
    // undercount this whole read exists to prevent, and it would arrive with no
    // error behind it.
    expect(sql).toContain(`COALESCE("markdown", '') ~ '[^[:space:]]' AS "hasMarkdown"`);
    // And that COALESCE is the only place the body is named at all: selecting
    // `markdown` would carry every book through this handler on every poll.
    expect(sql.match(/"markdown"/g)).toHaveLength(1);
    // The project id is bound, not spliced into the statement.
    const [, ...bound] = mockPrisma.$queryRawUnsafe.mock.calls[0] as [string, ...unknown[]];
    expect(bound).toEqual(["project-1"]);
  });

  it("asks whether a page was reviewed, never for the report it was reviewed into", async () => {
    await buildProjectStatus("project-1");

    const sql = pageReadSql();
    // `reviewedPages` is one integer, and it is the only reader there has ever
    // been: selecting the column deserialized a JSON quality report per page —
    // 600 of them on a 600-page book — on every poll, to count them.
    expect(sql).toContain(`COALESCE(jsonb_typeof("qualityReport"), 'null') <> 'null' AS "hasQualityReport"`);
    expect(sql.match(/"qualityReport"/g)).toHaveLength(1);
  });

  it("counts a page as reviewed on the same rule the JS filter did", async () => {
    await buildProjectStatus("project-1");

    const sql = pageReadSql();
    // The predicate this statement replaced was `page.qualityReport !== null`,
    // and `IS NOT NULL` is not a translation of it. `Page.qualityReport` is
    // `Json?`: the column holds SQL NULL *or* the jsonb value `null`, Prisma
    // hands back JS `null` for both, and the JS filter therefore counted
    // neither — while `IS NOT NULL` is true for the second. Measured against
    // the dev Postgres: `'null'::jsonb IS NOT NULL` is true, so a page written
    // through `Prisma.JsonNull` reports as reviewed carrying no report at all.
    // Nothing writes one today (0 rows of 855 on that database) and
    // `NullableJsonNullValueInput` is one call away in the generated client.
    expect(sql).not.toContain(`"qualityReport" IS NOT NULL`);
    // Also measured there: `jsonb_typeof` is `'null'` for the jsonb value and
    // NULL for the absent column, which this `COALESCE` folds into one false —
    // the guard its sibling on `markdown` already carries, on the column that
    // is actually nullable. Not `<> 'null'::jsonb`, which is NULL rather than
    // false for a SQL NULL: the third state again, in the predicate written to
    // avoid it.
    expect(sql).toContain(`COALESCE(jsonb_typeof("qualityReport"), 'null')`);
    expect(sql).not.toContain(`<> 'null'::jsonb`);
  });

  it("names only columns `model Page` actually declares", async () => {
    await buildProjectStatus("project-1");

    const { columns } = pageModelFromSchema();
    const named = pageReadIdentifiers().filter(
      // The table, and the two names the statement invents rather than reads.
      (identifier) => !["Page", "hasMarkdown", "hasQualityReport"].includes(identifier)
    );

    expect(named).not.toHaveLength(0);
    expect(columns).toEqual(expect.arrayContaining(named));
    expect(named).toEqual(
      expect.arrayContaining(["id", "index", "status", "revision", "qualityReport", "markdown", "projectId"])
    );
    expect(pageReadSql()).toContain(`FROM "Page"`);
  });

  it("reads a schema where a field name still is a column name", () => {
    // Everything above rests on it: the `satisfies` in `projectPageCounts.ts` ties
    // the identifiers to the model's *fields*, and a `@map` would rename the
    // column out from under them with `tsc` none the wiser.
    const { body } = pageModelFromSchema();

    expect(body).not.toContain("@map(");
    expect(body).not.toContain("@@map(");
  });

  it("answers null for a project that is not there, without reading pages", async () => {
    mockPrisma.project.findUnique.mockResolvedValue(null as never);

    expect(await buildProjectStatus("project-gone")).toBeNull();
    expect(mockPrisma.$queryRawUnsafe).not.toHaveBeenCalled();
  });
});

describe("what counts as a page that got written", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPrisma.project.findUnique.mockResolvedValue(projectRecord() as never);
    mockPrisma.$queryRawUnsafe.mockResolvedValue([] as never);
    mockPrisma.generationJob.findMany.mockImplementation(async () => []);
    mockPrisma.bookEditOperation.findMany.mockImplementation(async () => []);
  });

  it("asks for a non-whitespace character, not for a non-empty string", async () => {
    await buildProjectStatus("project-1");

    const sql = pageReadSql();
    // A drafting failure that stores `"\n"` or `" "` leaves a FAILED_QA row
    // holding no prose at all, and `<> ''` read it as a written page: once
    // rewrite ownership settled, the shelf card and the book screen reported 200/200 for
    // a book with a blank printed page. `isBookPage`'s own docstring calls that
    // the case it guards.
    expect(sql).not.toContain(`<> ''`);
    expect(sql).toContain(`~ '[^[:space:]]'`);
    // And not `btrim`, whose default trim set is the space character alone:
    // measured against the dev Postgres, `btrim(E'\n') <> ''` is *true*, so the
    // obvious spelling of this fix leaves the newline case exactly where it was.
    expect(sql).not.toContain("btrim");
  });

  it("still names the body once, and still binds the project id", async () => {
    // The predicate got longer; what it must not do is start carrying the book
    // through this handler on every poll.
    await buildProjectStatus("project-1");

    expect(pageReadSql().match(/"markdown"/g)).toHaveLength(1);
    const [, ...bound] = mockPrisma.$queryRawUnsafe.mock.calls[0] as [string, ...unknown[]];
    expect(bound).toEqual(["project-1"]);
  });

  it("leaves a whitespace-only FAILED_QA page owed on a finished book", async () => {
    // The row the database now answers `hasMarkdown: false` for. A finished
    // three-page book with one blank page is 2/3, not 3/3 — the page is owed,
    // and the quality card is what names it.
    mockPrisma.project.findUnique.mockResolvedValue(
      projectRecord({ targetPages: 3, status: "COMPLETE" }) as never
    );
    mockPrisma.$queryRawUnsafe.mockResolvedValue([
      pageRow({ id: "p1", index: 1, status: "COMPLETED", hasQualityReport: true }),
      pageRow({ id: "p2", index: 2, status: "COMPLETED", hasQualityReport: true }),
      pageRow({ id: "p3", index: 3, status: "FAILED_QA", hasMarkdown: false, hasQualityReport: true })
    ] as never);

    const status = await buildProjectStatus("project-1");

    expect(status?.progress.pages).toEqual({ complete: 2, target: 3 });
    expect(status?.progress.quality.blockedPages).toBe(1);
  });
});

describe("what the open-work read costs a finished book", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPrisma.project.findUnique.mockResolvedValue(
      projectRecord({ targetPages: 3, status: "COMPLETE" }) as never
    );
    mockPrisma.$queryRawUnsafe.mockResolvedValue(draftedBookRows() as never);
    mockPrisma.generationJob.findMany.mockImplementation(async () => []);
    mockPrisma.bookEditOperation.findMany.mockImplementation(async () => []);
  });

  it("sends one read for a finished book with nothing open", async () => {
    // The dominant caller, and the cheapest: one indexed read that finds no
    // row, so nothing is deserialized whatever the `select` names.
    const status = await buildProjectStatus("project-1");

    expect(status?.progress.pages).toEqual({ complete: 3, target: 3 });
    expect(pageRewriteReadSelects()).toEqual([{ type: true, payload: true }]);
  });

  it("answers a chat edit in flight off that one read and one primary-key read", async () => {
    // `APPLY_BOOK_EDIT` is `always` in the table, and the table is where the
    // job types stop being able to tell an edit apart: which fork the apply
    // took is on the `BookEditOperation` row. So the payload that came with the
    // job *is* consulted, for the one field that names that row, and the fork
    // costs one read by primary key. It is not a payload this handler saved by
    // asking for types alone either: `project.jobs` has already loaded and
    // parsed the whole row.
    mockPrisma.project.findUnique.mockResolvedValue(
      projectRecord({ targetPages: 3, status: "EDITING" }) as never
    );
    openJobs([
      openJob("APPLY_BOOK_EDIT", {
        planId: "plan-1",
        operationId: "operation-1",
        requestText: "please make chapter two funnier, and give the dog a name".repeat(20)
      })
    ]);
    editOperations({ "operation-1": "PAGE_REWRITE" });

    const status = await buildProjectStatus("project-1");

    expect(status?.progress.pages.complete).toBe(2);
    expect(pageRewriteReadSelects()).toEqual([{ type: true, payload: true }]);
    expect(editOperationReadIds()).toEqual([["operation-1"]]);
  });

  it("never reads a fork for the export repair every finished book carries", async () => {
    // The steady state of a delivered book is an open `skipFinalReview`
    // compile, and its answer is on its own payload. The second read exists for
    // an edit in flight, which is a moment rather than a state, so the poll
    // that recurs forever still costs exactly one statement.
    openJobs([
      openJob("COMPILE_EXPORT", { planId: "plan-1", skipFinalReview: true, detachedFromProjectLifecycle: true })
    ]);

    const status = await buildProjectStatus("project-1");

    expect(status?.progress.pages).toEqual({ complete: 3, target: 3 });
    expect(editOperationReadIds()).toEqual([]);
  });

  it("costs one round trip for the open compile the payload is read for", async () => {
    // `COMPILE_EXPORT` is the one type the table cannot answer alone —
    // `skipFinalReview` is the difference between a repair pass and a reprint.
    // It used to be the case that paid two statements: a probe over `type` that
    // could not settle it, then a re-read of the same rows for one more column.
    openJobs([openJob("COMPILE_EXPORT", { planId: "plan-2" })]);

    const status = await buildProjectStatus("project-1");

    expect(status?.progress.pages.complete).toBe(2);
    expect(pageRewriteReadSelects()).toEqual([{ type: true, payload: true }]);
  });

  it("costs one round trip for the export repair every finished book carries", async () => {
    // `ensureExportRepairQueued` puts a `skipFinalReview` compile on every
    // delivered book every five minutes, so this is the steady state of a
    // COMPLETE book rather than a corner: an open row of the one type whose
    // answer is on its payload. Two statements here was an extra round trip per
    // poll of every finished book on the box.
    openJobs([
      openJob("COMPILE_EXPORT", { planId: "plan-1", skipFinalReview: true, detachedFromProjectLifecycle: true })
    ]);

    const status = await buildProjectStatus("project-1");

    expect(status?.progress.pages).toEqual({ complete: 3, target: 3 });
    expect(pageRewriteReadSelects()).toEqual([{ type: true, payload: true }]);
  });

  it("asks that one read about every type, not only the compile", async () => {
    // One statement is one snapshot, so there is no window for a page job to be
    // queued into and missed — but the type list is still what decides whether
    // it can be seen at all, and narrowing it to COMPILE_EXPORT would look past
    // the drafting window this predicate exists to catch.
    openJobs([openJob("COMPILE_EXPORT", { planId: "plan-1", skipFinalReview: true })]);

    await buildProjectStatus("project-1");

    const [read, ...rest] = pageRewriteReadCalls();
    expect(rest).toEqual([]);
    expect(read?.type?.in).toEqual(expect.arrayContaining(["GENERATE_PAGE", "APPLY_BOOK_EDIT", "COMPILE_EXPORT"]));
  });

  it("hands the query its own copy of the frozen type list", async () => {
    // `PAGE_REWRITING_JOB_TYPES` is a frozen module singleton; a query builder
    // that normalised its arguments in place would throw on it, or rewrite what
    // every later poll asks about.
    openJobs([openJob("COMPILE_EXPORT", { planId: "plan-2" })]);

    await buildProjectStatus("project-1");

    const [read] = pageRewriteReadCalls();
    expect(Object.isFrozen(read?.type?.in)).toBe(false);
    expect(read?.type?.in).not.toBe(PAGE_REWRITING_JOB_TYPES);
    expect(read?.type?.in).toEqual([...PAGE_REWRITING_JOB_TYPES]);
  });
});

describe("buildProjectStatus recovery attempts", () => {
  it("selects operation so an initial-plan retry can skip confirmation", async () => {
    vi.clearAllMocks();
    mockPrisma.project.findUnique.mockResolvedValue(
      projectRecord({ status: "FAILED", currentPlanId: null, currentPlan: null }) as never
    );
    mockPrisma.$queryRawUnsafe.mockResolvedValue([] as never);
    mockPrisma.generationJob.findMany.mockImplementation(async (args?: unknown) =>
      (args as { where?: { status?: string } } | undefined)?.where?.status === "FAILED"
        ? [{ type: "PLAN_BOOK", payload: {}, createdAt: new Date("2026-08-20T01:00:00.000Z"), attemptId: "attempt-plan" }]
        : []
    );
    mockPrisma.generationAttempt.findMany.mockResolvedValueOnce([
      {
        id: "attempt-plan",
        commandKey: "mobile:creation-build:draft:req",
        status: "FAILED",
        operation: "PLAN_GENERATION",
        quotedCredits: 40,
        refundPending: false,
        retryAttempt: null
      }
    ]);

    const status = await buildProjectStatus("project-1");

    expect(mockPrisma.generationAttempt.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ select: expect.objectContaining({ operation: true }) })
    );
    expect(status?.project.generationAttempts).toEqual([
      expect.objectContaining({ id: "attempt-plan", operation: "PLAN_GENERATION" })
    ]);
  });
});
