import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "@book-maker/db";

/**
 * Opt-in proof against PostgreSQL itself. `$queryRawUnsafe` is a `vi.fn()` in
 * every other suite, so the one thing nothing could see is the rule that broke
 * this publication: all of a statement's `WITH` sub-statements run against a
 * single snapshot, so a sibling `UPDATE "PageEditSnapshot"` cannot see the rows
 * that same statement's `INSERT` produced. Folded into one statement, every
 * first delivery came back with `updatedSnapshotCount` 0 and rolled back.
 *
 *   DB_INTEGRATION=true pnpm -F @book-maker/worker exec vitest run \
 *     src/generation/textEditPublication.integration.test.ts
 *
 * It runs on temporary tables cloned from the live schema, inside a transaction
 * that always rolls back, so it reads and writes no project's rows.
 */
const enabled = process.env.DB_INTEGRATION === "true";

// The module reaches `runtime/dispatch.ts`, which opens a Redis connection at
// import time. Nothing here compiles or invalidates anything.
vi.mock("../runtime/dispatch.js", () => ({ maybeEnqueueCompile: vi.fn() }));
vi.mock("./bookHelpers.js", () => ({ invalidateProjectExports: vi.fn() }));

const projectId = "integration-project";
const operationId = "integration-operation";

type SnapshotRow = {
  id: string;
  pageId: string;
  pageIndex: number;
  revisionBefore: number;
  revisionAfter: number | null;
  titleAfter: string | null;
  markdownAfter: string | null;
  summaryAfter: string | null;
};

type PageRow = { id: string; revision: number; title: string; status: string };
type Observed = { snapshots: SnapshotRow[]; pages: PageRow[] };
type PagePayload = ReturnType<typeof pagePayload>;

function pagePayload(offset: number) {
  return {
    snapshot_id: `snapshot-${offset}`,
    page_id: `page-${offset}`,
    page_index: offset,
    revision_before: offset + 2,
    title_before: `Old ${offset}`,
    markdown_before: `Old markdown ${offset}`,
    summary_before: `Old summary ${offset}`,
    image_prompt_before: offset % 2 === 0 ? `Old image ${offset}` : null,
    quality_report_before: { score: 60 },
    story_delta_before: offset % 2 === 0 ? null : { factsAdded: [`old-${offset}`] },
    title_after: `New ${offset}`,
    markdown_after: `New markdown ${offset}`,
    summary_after: `New summary ${offset}`,
    image_prompt_after: offset % 2 === 0 ? `New image ${offset}` : null,
    quality_report_after: { score: 100 },
    story_delta_after: { factsAdded: [`new-${offset}`] },
    status_after: offset % 2 === 0 ? "FAILED_QA" : "COMPLETED"
  };
}

let prisma: PrismaClient;
let bulkPublishPages: typeof import("./textEditPublication.js").bulkPublishPages;

/** Carries the read-back out of a transaction that must never commit. */
class Rollback extends Error {
  constructor(readonly observed: Observed) {
    super("rollback");
  }
}

/**
 * Clones `Page` and `PageEditSnapshot` into this transaction's temporary
 * schema — which PostgreSQL searches ahead of `public` — seeds them, runs the
 * publication, reads both tables back, and then rolls the whole thing away.
 */
async function publishAgainstTempTables(options: {
  pages: readonly PagePayload[];
  seed?: readonly PagePayload[] | undefined;
  existingSnapshotFor?: PagePayload | undefined;
}): Promise<Observed> {
  try {
    await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(
        `CREATE TEMP TABLE "Page" (LIKE public."Page" INCLUDING DEFAULTS) ON COMMIT DROP`
      );
      await tx.$executeRawUnsafe(
        `CREATE TEMP TABLE "PageEditSnapshot" (LIKE public."PageEditSnapshot" INCLUDING DEFAULTS) ON COMMIT DROP`
      );
      await tx.$executeRawUnsafe(
        `INSERT INTO "Page" (
           "id", "projectId", "index", "title", "markdown", "summary", "status", "revision",
           "createdAt", "updatedAt", "qualityReport", "storyDelta", "imagePrompt"
         )
         SELECT item.page_id, $1, item.page_index, item.title_before, item.markdown_before,
                item.summary_before, 'COMPLETED', item.revision_before,
                CURRENT_TIMESTAMP, CURRENT_TIMESTAMP,
                item.quality_report_before, item.story_delta_before, item.image_prompt_before
           FROM jsonb_to_recordset($2::jsonb) AS item(
             page_id text, page_index integer, revision_before integer,
             title_before text, markdown_before text, summary_before text,
             image_prompt_before text, quality_report_before jsonb, story_delta_before jsonb
           )`,
        projectId,
        JSON.stringify(options.seed ?? options.pages)
      );
      const existing = options.existingSnapshotFor;
      if (existing) {
        await tx.$executeRawUnsafe(
          `INSERT INTO "PageEditSnapshot" (
             "id", "projectId", "pageId", "operationId", "pageIndex",
             "titleBefore", "markdownBefore", "summaryBefore", "revisionBefore",
             "storyDeltaBefore", "createdAt"
           ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, CURRENT_TIMESTAMP)`,
          "already-standing",
          projectId,
          existing.page_id,
          operationId,
          existing.page_index,
          existing.title_before,
          existing.markdown_before,
          existing.summary_before,
          existing.revision_before,
          JSON.stringify(existing.story_delta_before)
        );
      }

      await bulkPublishPages(tx, projectId, operationId, options.pages);

      const observed: Observed = {
        snapshots: await tx.$queryRawUnsafe<SnapshotRow[]>(
          `SELECT "id", "pageId", "pageIndex", "revisionBefore", "revisionAfter",
                  "titleAfter", "markdownAfter", "summaryAfter"
             FROM "PageEditSnapshot" ORDER BY "pageIndex"`
        ),
        pages: await tx.$queryRawUnsafe<PageRow[]>(
          `SELECT "id", "revision", "title", "status" FROM "Page" ORDER BY "index"`
        )
      };
      // The temporary tables shadow the real ones; never committing is the
      // second guarantee behind that, so a clone that somehow did not shadow
      // still writes nothing.
      throw new Rollback(observed);
    });
  } catch (error) {
    if (error instanceof Rollback) return error.observed;
    throw error;
  }
  throw new Error("The publication never reached its read-back");
}

describe.skipIf(!enabled)("text edit bulk publication against PostgreSQL (opt-in)", () => {
  beforeAll(async () => {
    ({ prisma } = await import("@book-maker/db"));
    ({ bulkPublishPages } = await import("./textEditPublication.js"));
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("stamps the after-values on snapshots this publication had to create", async () => {
    const { snapshots, pages } = await publishAgainstTempTables({
      pages: [pagePayload(1), pagePayload(2)]
    });

    expect(snapshots).toEqual([
      {
        id: "snapshot-1",
        pageId: "page-1",
        pageIndex: 1,
        revisionBefore: 3,
        revisionAfter: 4,
        titleAfter: "New 1",
        markdownAfter: "New markdown 1",
        summaryAfter: "New summary 1"
      },
      {
        id: "snapshot-2",
        pageId: "page-2",
        pageIndex: 2,
        revisionBefore: 4,
        revisionAfter: 5,
        titleAfter: "New 2",
        markdownAfter: "New markdown 2",
        summaryAfter: "New summary 2"
      }
    ]);
    expect(pages).toEqual([
      { id: "page-1", revision: 4, title: "New 1", status: "COMPLETED" },
      { id: "page-2", revision: 5, title: "New 2", status: "FAILED_QA" }
    ]);
  });

  it("adopts a snapshot an earlier delivery already wrote instead of doubling it", async () => {
    const first = pagePayload(1);
    const { snapshots } = await publishAgainstTempTables({
      pages: [first, pagePayload(2)],
      existingSnapshotFor: first
    });

    // Undo replays these rows and nothing makes (operationId, pageId) unique,
    // so a second snapshot for one page would restore half an edit.
    expect(snapshots.map((snapshot) => snapshot.id)).toEqual(["already-standing", "snapshot-2"]);
    expect(snapshots[0]).toMatchObject({ revisionBefore: 3, revisionAfter: 4, titleAfter: "New 1" });
  });

  it("refuses the whole publication when a page moved under the edit", async () => {
    const seeded = pagePayload(1);

    await expect(
      publishAgainstTempTables({
        pages: [{ ...seeded, markdown_before: "Not what the page holds" }, pagePayload(2)],
        seed: [seeded, pagePayload(2)]
      })
    ).rejects.toThrow("did not update every exact page/snapshot pair");
  });
});
