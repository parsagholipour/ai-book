import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Prisma, prisma } from "./client.ts";
import { embeddingIsDegraded, findPageEmbeddingRepairTargets } from "./embeddingRepairTargets.ts";
import { EMBEDDING_REPOINT_PARK_PREFIX } from "./pageOrdering.ts";
import { DEGRADED_EMBEDDING_SHAPES } from "./testing/degradedEmbeddingShapes.ts";

/**
 * Opt-in integration suite for the one query that decides which pages have lost
 * their long-range memory. It is a hand-written `NOT EXISTS` anti-join with a
 * JSON metadata predicate, a whitespace regex and an ordering the `LIMIT`
 * depends on — none of which a mocked `$queryRawUnsafe` can vouch for.
 * `src/embeddingRepairTargets.test.ts` asserts the SQL's *shape*; this asserts
 * what Postgres does with it.
 *
 * The pass it feeds used to derive the same answer in memory, pulling every
 * COMPLETED page's summary and every `page:` embedding row of the project on
 * every page job past the recency window. Moving that into SQL is only safe if
 * the predicate means the same thing, which is what these cases pin down.
 *
 * Run with the dev container from `make up` (or any DATABASE_URL):
 *
 *   DB_INTEGRATION=true pnpm -F @book-maker/db exec vitest run src/embeddingRepairTargets.integration.test.ts
 *
 * Without that variable `vitest.config.ts` keeps this file out of collection
 * entirely. Skipping the bodies is not enough on its own: the `prisma` import
 * above builds a client and a pg pool the moment the module is evaluated, in a
 * run that is supposed to need no database. The `skipIf` below is the second
 * guard, for a runner that reaches this file under some other config.
 */
const enabled = process.env.DB_INTEGRATION === "true";

const projectId = `repair-integration-${randomUUID()}`;
const userId = `repair-integration-user-${randomUUID()}`;

/** A realistic page summary; the shape whose bulk the old in-memory pass shipped. */
function summaryFor(index: number): string {
  return `Page ${index}: Tomas crosses the observatory floor and counts the rivets on the vault door.`;
}

type PageSeed = { index: number; status?: string; summary?: string };

async function seedPages(seeds: readonly PageSeed[]) {
  await prisma.page.createMany({
    data: seeds.map((seed) => ({
      id: `${projectId}-page-${seed.index}`,
      projectId,
      index: seed.index,
      title: `Page ${seed.index}`,
      markdown: `# Page ${seed.index}`,
      summary: seed.summary ?? summaryFor(seed.index),
      status: seed.status ?? "COMPLETED"
    }))
  });
}

async function seedEmbedding(scope: string, metadata: unknown, options?: { sourceId?: string }) {
  await prisma.embedding.create({
    data: {
      projectId,
      scope,
      text: "stored summary",
      metadata: metadata as never,
      ...(options?.sourceId ? { sourceId: options.sourceId } : {})
    }
  });
}

const indexesOf = (targets: Awaited<ReturnType<typeof findPageEmbeddingRepairTargets>>) =>
  targets.map((target) => target.index);

describe.skipIf(!enabled)("findPageEmbeddingRepairTargets (opt-in integration)", () => {
  beforeAll(async () => {
    await prisma.user.create({ data: { id: userId, email: `${userId}@example.invalid` } });
    await prisma.project.create({
      data: {
        id: projectId,
        userId,
        title: "Embedding repair fixture",
        prompt: "fixture",
        category: "STORY",
        targetPages: 20,
        complexity: 1,
        temperature: 0.5,
        mediaSettings: {}
      }
    });
  });

  beforeEach(async () => {
    await prisma.embedding.deleteMany({ where: { projectId } });
    await prisma.page.deleteMany({ where: { projectId } });
  });

  afterAll(async () => {
    // Explicit child-first deletes rather than trusting every FK in an
    // arbitrary DATABASE_URL target to cascade.
    await prisma.embedding.deleteMany({ where: { projectId } });
    await prisma.page.deleteMany({ where: { projectId } });
    await prisma.project.deleteMany({ where: { id: projectId } });
    await prisma.user.deleteMany({ where: { id: userId } });
    await prisma.$disconnect();
  });

  /**
   * The whole reason the query exists: on a finished stretch of manuscript it
   * returns nothing at all, having read no summaries out of the database.
   */
  it("returns nothing when every page already has a healthy row", async () => {
    await seedPages(Array.from({ length: 12 }, (_, offset) => ({ index: offset + 1 })));
    for (let index = 1; index <= 12; index += 1) {
      await seedEmbedding(`page:${index}`, { provider: "gemini" });
    }

    await expect(findPageEmbeddingRepairTargets({ projectId, beforeIndex: 30, limit: 3 })).resolves.toEqual([]);
  });

  it("returns a page with no row and a degraded page, lowest index first, with its attempt count", async () => {
    await seedPages([{ index: 1 }, { index: 2 }, { index: 3 }]);
    await seedEmbedding("page:2", { vectorStored: false, error: "outage", repairAttempts: 2, repairRetryFromIndex: 9 });
    await seedEmbedding("page:3", { provider: "gemini" });

    const targets = await findPageEmbeddingRepairTargets({ projectId, beforeIndex: 30, limit: 3 });

    expect(targets).toEqual([
      { pageId: `${projectId}-page-1`, index: 1, summary: summaryFor(1), attempts: 0 },
      { pageId: `${projectId}-page-2`, index: 2, summary: summaryFor(2), attempts: 2 }
    ]);
  });

  /**
   * A vectorless placeholder is still a hole. `LEFT JOIN ... IS NULL` alone
   * would call it repaired forever: it carries the page's real summary as `text`
   * and stays lexically recallable, but the cosine arm can never return it.
   *
   * **And this is where the two spellings of that rule are held together.**
   * `embeddingIsDegraded` reads a row Prisma handed back and
   * `degradedEmbeddingSql` reads the `jsonb` column, so they cannot share an
   * implementation — only a set of answers, which is
   * `testing/degradedEmbeddingShapes.ts`. Every page here *has* a row, so the
   * query calls it a hole exactly when it calls that row degraded: seeding every
   * shape and comparing the returned indexes against the function, shape by
   * shape, is the one place a change made to either expression and not the other
   * fails. The string `"false"` is why it is worth doing — a
   * `metadata->>'vectorStored' = 'false'` passes every other case in this file
   * and disagrees with the function about that one.
   */
  it("calls a row degraded exactly when embeddingIsDegraded calls it degraded", async () => {
    const shapes = [...DEGRADED_EMBEDDING_SHAPES];
    await seedPages(shapes.map((_, offset) => ({ index: offset + 1 })));
    for (const [offset, shape] of shapes.entries()) {
      // A JSON `null` is a value the column can hold; Prisma needs it named.
      await seedEmbedding(`page:${offset + 1}`, shape.metadata === null ? Prisma.JsonNull : shape.metadata);
    }
    // Past every seeded `repairRetryFromIndex`, so no backoff hides a row the
    // predicate does call degraded.
    const holes = indexesOf(
      await findPageEmbeddingRepairTargets({ projectId, beforeIndex: 1000, limit: shapes.length })
    );

    expect(holes).toEqual(shapes.flatMap((shape, offset) => (embeddingIsDegraded(shape.metadata) ? [offset + 1] : [])));
    // And against the table's own claim, so agreeing on the wrong answer is
    // still a failure rather than two implementations drifting together.
    expect(holes).toEqual(shapes.flatMap((shape, offset) => (shape.degraded ? [offset + 1] : [])));
  });

  it("hides a degraded scope until its backoff index is reached", async () => {
    await seedPages([{ index: 1 }]);
    await seedEmbedding("page:1", {
      vectorStored: false,
      error: "content filter",
      repairAttempts: 2,
      repairRetryFromIndex: 40
    });

    expect(indexesOf(await findPageEmbeddingRepairTargets({ projectId, beforeIndex: 39, limit: 3 }))).toEqual([]);
    // The wait is inclusive: `beforeIndex >= retryFromIndex` re-opens the scope.
    expect(indexesOf(await findPageEmbeddingRepairTargets({ projectId, beforeIndex: 40, limit: 3 }))).toEqual([1]);
  });

  /**
   * The anti-starvation ordering, against the engine. Three pages a provider
   * refuses sit at the front of the index order; the backoff has to be spent
   * before the `LIMIT`, or those three eat the batch on every page job for the
   * rest of the book and page 6's ordinary missing row is never repaired.
   */
  it("applies the limit after the backoff, so backed-off scopes hold no slots", async () => {
    await seedPages(Array.from({ length: 6 }, (_, offset) => ({ index: offset + 1 })));
    for (const index of [1, 2, 3]) {
      await seedEmbedding(`page:${index}`, {
        vectorStored: false,
        error: "content filter",
        repairAttempts: 2,
        repairRetryFromIndex: 40
      });
    }

    expect(indexesOf(await findPageEmbeddingRepairTargets({ projectId, beforeIndex: 30, limit: 3 }))).toEqual([4, 5, 6]);
  });

  it("takes the lowest indexes when there are more holes than slots", async () => {
    await seedPages(Array.from({ length: 8 }, (_, offset) => ({ index: offset + 1 })));

    expect(indexesOf(await findPageEmbeddingRepairTargets({ projectId, beforeIndex: 30, limit: 3 }))).toEqual([1, 2, 3]);
  });

  /**
   * A renumber parks a scope under {@link EMBEDDING_REPOINT_PARK_PREFIX} between
   * its two statements. The join is exact equality on `'page:' || index`, so a
   * parked row can never be read as a page's own — the same guarantee the
   * `LIKE 'page:%'` filters get from that prefix keeping its colon out of the
   * fifth position. (Parked rows only exist inside the re-point's transaction,
   * so no reader outside it observes one at all; this pins the predicate.)
   */
  it("cannot mistake a parked scope for a page's own row", async () => {
    await seedPages([{ index: 1 }, { index: 2 }]);
    await seedEmbedding(`${EMBEDDING_REPOINT_PARK_PREFIX}1`, { provider: "gemini" });
    await seedEmbedding(`${EMBEDDING_REPOINT_PARK_PREFIX}2`, {
      vectorStored: false,
      repairAttempts: 9,
      repairRetryFromIndex: 999
    });

    const targets = await findPageEmbeddingRepairTargets({ projectId, beforeIndex: 30, limit: 3 });

    // Both pages read as holes — neither parked row is healthy for page 1, nor
    // a backoff for page 2 — and no attempt count leaks off the parked metadata.
    expect(targets.map((target) => [target.index, target.attempts])).toEqual([
      [1, 0],
      [2, 0]
    ]);
  });

  it("ignores an unsettled page, a blank summary and everything at or past beforeIndex", async () => {
    await seedPages([
      { index: 1, status: "GENERATING" },
      { index: 2, summary: "   " },
      { index: 3, summary: "\n\t " },
      { index: 4 },
      { index: 5 }
    ]);

    expect(indexesOf(await findPageEmbeddingRepairTargets({ projectId, beforeIndex: 5, limit: 5 }))).toEqual([4]);
  });

  /**
   * The counters are read out of JSON written by another process, so the query
   * has to survive a value that is not a number. `jsonb_typeof` inside a `CASE`
   * is what makes that true — the same conjunction spelled as an `AND` beside the
   * cast may still reach `::numeric` and error, because Postgres does not promise
   * to evaluate `AND` left to right.
   */
  it("survives non-numeric repair counters instead of erroring the whole query", async () => {
    await seedPages([{ index: 1 }, { index: 2 }]);
    await seedEmbedding("page:1", {
      vectorStored: false,
      repairAttempts: "two",
      repairRetryFromIndex: "later"
    });
    await seedEmbedding("page:2", { vectorStored: false, repairAttempts: null });

    const targets = await findPageEmbeddingRepairTargets({ projectId, beforeIndex: 30, limit: 3 });

    expect(targets.map((target) => [target.index, target.attempts])).toEqual([
      [1, 0],
      [2, 0]
    ]);
  });

  it("scopes to one project", async () => {
    const otherProjectId = `${projectId}-other`;
    await prisma.project.create({
      data: {
        id: otherProjectId,
        userId,
        title: "Neighbouring book",
        prompt: "fixture",
        category: "STORY",
        targetPages: 5,
        complexity: 1,
        temperature: 0.5,
        mediaSettings: {}
      }
    });
    try {
      await seedPages([{ index: 1 }]);
      await prisma.page.create({
        data: {
          projectId: otherProjectId,
          index: 1,
          title: "Page 1",
          markdown: "# Page 1",
          summary: summaryFor(1),
          status: "COMPLETED"
        }
      });
      // A healthy row on the *other* project must not repair this project's hole.
      await prisma.embedding.create({
        data: { projectId: otherProjectId, scope: "page:1", text: "stored", metadata: { provider: "gemini" } }
      });

      expect(indexesOf(await findPageEmbeddingRepairTargets({ projectId, beforeIndex: 30, limit: 3 }))).toEqual([1]);
      expect(
        indexesOf(await findPageEmbeddingRepairTargets({ projectId: otherProjectId, beforeIndex: 30, limit: 3 }))
      ).toEqual([]);
    } finally {
      await prisma.embedding.deleteMany({ where: { projectId: otherProjectId } });
      await prisma.page.deleteMany({ where: { projectId: otherProjectId } });
      await prisma.project.deleteMany({ where: { id: otherProjectId } });
    }
  });
});
