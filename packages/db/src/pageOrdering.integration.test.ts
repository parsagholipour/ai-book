import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "./client.ts";
import {
  EMBEDDING_REPOINT_PARK_PREFIX,
  PageEmbeddingRepointCollisionError,
  pageEmbeddingRepointPasses,
  repointPageEmbeddings,
  runPageOrderingStatements,
  type PageOrderEntry
} from "./pageOrdering.ts";

/**
 * Opt-in integration suite for the one property of the embedding re-point that
 * only a real Postgres can settle: whether `@@unique([projectId, scope])`
 * actually raises `23505` where the two-pass split says it would.
 *
 * `src/pageOrdering.test.ts` runs both statement shapes against a stand-in that
 * refuses what the index refuses, which is a model of Postgres rather than
 * Postgres. The case below is exactly the one that model exists for, so it is
 * worth proving twice: the raw statements really do abort the transaction, and
 * the guard really does replace that with a diagnosis.
 *
 * Run with the dev container from `make up` (or any DATABASE_URL):
 *
 *   DB_INTEGRATION=true pnpm -F @book-maker/db exec vitest run src/pageOrdering.integration.test.ts
 *
 * The target must be migrated at least through `000056`, which is what turns
 * `(projectId, scope)` into a unique index; against a database still holding
 * the non-unique init index the first case below fails, because there is no
 * `23505` to raise.
 *
 * Without that variable `vitest.config.ts` keeps this file out of collection
 * entirely — the `prisma` import above builds a client and a pg pool the moment
 * the module is evaluated, in a run that is supposed to need no database. The
 * `skipIf` below is the second guard, for a runner that reaches this file under
 * some other config.
 */
const enabled = process.env.DB_INTEGRATION === "true";

const projectId = `repoint-integration-${randomUUID()}`;
const userId = `repoint-integration-user-${randomUUID()}`;
const pageId = (index: number) => `${projectId}-page-${index}`;

async function seedBook(pageCount: number): Promise<void> {
  await prisma.page.createMany({
    data: Array.from({ length: pageCount }, (_value, offset) => ({
      id: pageId(offset + 1),
      projectId,
      index: offset + 1,
      title: `Page ${offset + 1}`,
      markdown: `# Page ${offset + 1}`,
      summary: `Page ${offset + 1} summary`,
      status: "COMPLETED"
    }))
  });
  await prisma.embedding.createMany({
    data: Array.from({ length: pageCount }, (_value, offset) => ({
      projectId,
      scope: `page:${offset + 1}`,
      sourceId: pageId(offset + 1),
      text: `Page ${offset + 1} summary`,
      metadata: {}
    }))
  });
}

/** The book's page scopes, as `sourceId -> scope`, read back out of the database. */
async function scopes(): Promise<Record<string, string>> {
  const rows = await prisma.embedding.findMany({
    where: { projectId },
    select: { scope: true, sourceId: true },
    orderBy: { scope: "asc" }
  });
  return Object.fromEntries(rows.map((row) => [row.sourceId ?? "", row.scope]));
}

describe.skipIf(!enabled)("re-pointing page embeddings against a real Postgres (opt-in integration)", () => {
  beforeAll(async () => {
    await prisma.user.create({ data: { id: userId, email: `${userId}@example.invalid` } });
    await prisma.project.create({
      data: {
        id: projectId,
        userId,
        title: "Page re-point fixture",
        prompt: "fixture",
        category: "STORY",
        targetPages: 6,
        complexity: 1,
        temperature: 0.5,
        mediaSettings: {}
      }
    });
  });

  beforeEach(async () => {
    await prisma.embedding.deleteMany({ where: { projectId } });
    await prisma.page.deleteMany({ where: { projectId } });
    await seedBook(6);
  });

  afterAll(async () => {
    await prisma.embedding.deleteMany({ where: { projectId } });
    await prisma.page.deleteMany({ where: { projectId } });
    await prisma.project.deleteMany({ where: { id: projectId } });
    await prisma.user.deleteMany({ where: { id: userId } });
    await prisma.$disconnect();
  });

  it("really does raise a unique violation when a destination is still held", async () => {
    // The statements on their own, with no guard in front of them: page 4 is
    // re-pointed at 5 while page 5 still holds `page:5`, and pass two writes
    // one onto the other.
    //
    // Both passes have to be named to get here. They come back as a pair rather
    // than as the `PageOrderingStatement[]` `runPageOrderingStatements` takes,
    // precisely so this — park and land with no probe between them — is a thing
    // a caller says rather than a thing the signatures offer. This suite is the
    // one place that may say it, because the `23505` is what it measures.
    const passes = pageEmbeddingRepointPasses(projectId, [{ pageId: pageId(4), index: 5 }]);
    const failure = await prisma
      .$transaction(async (tx) => {
        await runPageOrderingStatements(tx, passes ? [passes.park, passes.land] : []);
      })
      .then(() => null)
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(Error);
    expect(String((failure as Error).message)).toMatch(/unique|23505|constraint/i);
    // And it took the whole transaction with it, which is the cost the guard
    // exists to name: in production this rolls back a renumbered book.
    expect(await scopes()).toMatchObject({ [pageId(4)]: "page:4", [pageId(5)]: "page:5" });
  });

  it("names the ordering instead, and leaves no parked row behind", async () => {
    const failure = await prisma
      .$transaction(async (tx) => {
        await repointPageEmbeddings(tx, projectId, [{ pageId: pageId(4), index: 5 }]);
      })
      .then(() => null)
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(PageEmbeddingRepointCollisionError);
    expect((failure as PageEmbeddingRepointCollisionError).collisions).toEqual([
      {
        parkedScope: `${EMBEDDING_REPOINT_PARK_PREFIX}5:page:4`,
        landingScope: "page:5",
        heldScope: "page:5",
        heldSourceId: pageId(5)
      }
    ]);
    const held = await scopes();
    expect(held).toMatchObject({ [pageId(4)]: "page:4", [pageId(5)]: "page:5" });
    expect(Object.values(held).some((scope) => scope.startsWith(EMBEDDING_REPOINT_PARK_PREFIX))).toBe(false);
  });

  it("parks one page's two page scopes apart, and names them instead of colliding", async () => {
    // `sourceId -> page:%` is one-to-many, so a page can hold two page scopes:
    // `repairPageEmbeddings` resolves the page at an index and only then spends
    // a provider call, and a page job lagging in BullMQ backoff writes its own
    // stale index. Keyed on the destination alone, pass one set both of these
    // rows to one `page-repoint:8` and Postgres raised `23505` on the statement
    // the park/land split exists to make safe. The park key carries the scope
    // each row came from now, so what answers is the probe.
    // Page 1 keeps a second row, on an index no live row holds — so the only
    // thing either parked row can meet is the other one.
    await prisma.embedding.create({
      data: {
        projectId,
        scope: "page:9",
        sourceId: pageId(1),
        text: "A scope page 1 kept after it moved",
        metadata: {}
      }
    });

    const failure = await prisma
      .$transaction(async (tx) => {
        await repointPageEmbeddings(tx, projectId, [{ pageId: pageId(1), index: 8 }]);
      })
      .then(() => null)
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(PageEmbeddingRepointCollisionError);
    // Both parked rows land on `page:8`, so each is reported against the other.
    expect((failure as PageEmbeddingRepointCollisionError).collisions).toEqual([
      {
        parkedScope: `${EMBEDDING_REPOINT_PARK_PREFIX}8:page:1`,
        landingScope: "page:8",
        heldScope: `${EMBEDDING_REPOINT_PARK_PREFIX}8:page:9`,
        heldSourceId: pageId(1)
      },
      {
        parkedScope: `${EMBEDDING_REPOINT_PARK_PREFIX}8:page:9`,
        landingScope: "page:8",
        heldScope: `${EMBEDDING_REPOINT_PARK_PREFIX}8:page:1`,
        heldSourceId: pageId(1)
      }
    ]);
    // Nothing survived the rollback: the book still holds its own six scopes
    // and the extra one, and no parked row is left behind.
    expect(Object.values(await scopes()).some((scope) => scope.startsWith(EMBEDDING_REPOINT_PARK_PREFIX))).toBe(
      false
    );
  });

  it("still lands an insert's tail-only ordering, which is the partial caller", async () => {
    // `movedPageOrder` names only the pages an insert shifted: 4..6 move to
    // 6..8 for two new pages, and the head is left out on purpose.
    const order: PageOrderEntry[] = [4, 5, 6].map((index) => ({ pageId: pageId(index), index: index + 2 }));

    await prisma.$transaction(async (tx) => {
      await repointPageEmbeddings(tx, projectId, order);
    });

    expect(await scopes()).toEqual({
      [pageId(1)]: "page:1",
      [pageId(2)]: "page:2",
      [pageId(3)]: "page:3",
      [pageId(4)]: "page:6",
      [pageId(5)]: "page:7",
      [pageId(6)]: "page:8"
    });
  });

  it("still lands a whole-book permutation, which is every other caller", async () => {
    const order: PageOrderEntry[] = Array.from({ length: 6 }, (_value, offset) => ({
      pageId: pageId(offset + 1),
      index: 6 - offset
    }));

    await prisma.$transaction(async (tx) => {
      await repointPageEmbeddings(tx, projectId, order);
    });

    expect(await scopes()).toEqual({
      [pageId(1)]: "page:6",
      [pageId(2)]: "page:5",
      [pageId(3)]: "page:4",
      [pageId(4)]: "page:3",
      [pageId(5)]: "page:2",
      [pageId(6)]: "page:1"
    });
  });
});
