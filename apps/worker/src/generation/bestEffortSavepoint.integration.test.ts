import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "@book-maker/db";

/**
 * Opt-in proof against PostgreSQL itself. The unit regression drives the full
 * handler with the same aborted-state machine; these cases prove the real
 * embedding helper, and any write that swallows its own statement error, leave
 * an interactive transaction in that state, and that the savepoint preserves
 * the lease-fenced manuscript commit.
 *
 *   DB_INTEGRATION=true pnpm -F @book-maker/worker exec vitest run \
 *     src/generation/bestEffortSavepoint.integration.test.ts
 */
const enabled = process.env.DB_INTEGRATION === "true";
const fixture = `page-memory-savepoint-${randomUUID()}`;
const userId = `${fixture}-user`;
const projectId = `${fixture}-project`;
const pageId = `${fixture}-page`;
const operationId = `${fixture}-operation`;
const ownerToken = `${fixture}-owner`;

let prisma: PrismaClient;
let Prisma: typeof import("@book-maker/db").Prisma;
let runBestEffortPageMemoryWrite: typeof import("./bestEffortSavepoint.js").runBestEffortPageMemoryWrite;
let writePreparedEmbedding: typeof import("./embeddingWrites.js").writePreparedEmbedding;
let assertTextEditLeaseTx: typeof import("./textEditLease.js").assertTextEditLeaseTx;

describe.skipIf(!enabled)("best-effort page memory savepoints against PostgreSQL (opt-in)", () => {
  beforeAll(async () => {
    ({ prisma, Prisma } = await import("@book-maker/db"));
    ({ runBestEffortPageMemoryWrite } = await import("./bestEffortSavepoint.js"));
    ({ writePreparedEmbedding } = await import("./embeddingWrites.js"));
    ({ assertTextEditLeaseTx } = await import("./textEditLease.js"));

    await prisma.user.create({ data: { id: userId, email: `${userId}@example.invalid` } });
    await prisma.project.create({
      data: {
        id: projectId,
        userId,
        title: "Savepoint fixture",
        prompt: "fixture",
        category: "STORY",
        targetPages: 1,
        complexity: 1,
        temperature: 0.5,
        mediaSettings: {}
      }
    });
    await prisma.page.create({
      data: { id: pageId, projectId, index: 1, title: "Page 1", markdown: "Before.", summary: "Before." }
    });
    await prisma.bookEditOperation.create({
      data: {
        id: operationId,
        projectId,
        kind: "PAGE_REWRITE",
        status: "ACTIVE",
        request: "Rewrite page 1",
        classifier: {},
        affectedPageIndexes: [1],
        structuralLeaseToken: ownerToken,
        structuralLeaseExpiresAt: new Date(Date.now() + 60_000)
      }
    });
  });

  beforeEach(async () => {
    await prisma.embedding.deleteMany({ where: { projectId } });
    await prisma.page.update({
      where: { id: pageId },
      data: { markdown: "Before.", summary: "Before.", storyDelta: Prisma.DbNull, revision: 1 }
    });
    await prisma.project.update({ where: { id: projectId }, data: { storyState: Prisma.DbNull } });
    await prisma.bookEditOperation.update({
      where: { id: operationId },
      data: {
        status: "ACTIVE",
        structuralLeaseToken: ownerToken,
        structuralLeaseExpiresAt: new Date(Date.now() + 60_000),
        structuralLeaseCompletedAt: null
      }
    });
  });

  afterAll(async () => {
    await prisma.project.deleteMany({ where: { id: projectId } });
    await prisma.user.deleteMany({ where: { id: userId } });
    await prisma.$disconnect();
  });

  it("rolls back an internally swallowed embedding failure and still commits the page", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      await prisma.$transaction(async (tx) => {
        await assertTextEditLeaseTx(tx, operationId, ownerToken);
        await tx.page.update({
          where: { id: pageId },
          data: { markdown: "Embedding failed; page committed.", summary: "New summary.", revision: { increment: 1 } }
        });
        await runBestEffortPageMemoryWrite(tx, () =>
          writePreparedEmbedding(
            { projectId, scope: "page:1", sourceId: pageId, text: "New summary." },
            { vectorLiteral: "[not-a-number]", error: null },
            tx
          )
        );
      });
    } finally {
      logged.mockRestore();
    }

    await expect(prisma.page.findUnique({ where: { id: pageId } })).resolves.toMatchObject({
      markdown: "Embedding failed; page committed.",
      revision: 2
    });
    await expect(prisma.embedding.count({ where: { projectId } })).resolves.toBe(0);
  });

  it("rolls back a later write's swallowed failure without undoing page or embedding", async () => {
    const logged = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      await prisma.$transaction(async (tx) => {
        await assertTextEditLeaseTx(tx, operationId, ownerToken);
        await tx.page.update({
          where: { id: pageId },
          data: { markdown: "Later write failed; page committed.", summary: "New summary.", revision: { increment: 1 } }
        });
        await runBestEffortPageMemoryWrite(tx, () =>
          writePreparedEmbedding(
            { projectId, scope: "page:1", sourceId: pageId, text: "New summary." },
            { vectorLiteral: `[${Array.from({ length: 768 }, () => "0.1").join(",")}]`, error: null },
            tx
          )
        );
        // A write that catches its own statement error, as the per-page memory
        // writers did, leaves the transaction aborted for everything after it.
        await runBestEffortPageMemoryWrite(tx, async () => {
          try {
            await tx.$executeRawUnsafe("SELECT 1 / 0");
          } catch {
            console.warn("swallowed");
          }
        });
      });
    } finally {
      logged.mockRestore();
    }

    await expect(prisma.page.findUnique({ where: { id: pageId } })).resolves.toMatchObject({
      markdown: "Later write failed; page committed.",
      revision: 2
    });
    await expect(prisma.embedding.findFirst({ where: { projectId, scope: "page:1" } })).resolves.toMatchObject({
      sourceId: pageId,
      text: "New summary."
    });
  });
});
