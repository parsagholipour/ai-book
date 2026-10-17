import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@book-maker/db", async () => (await import("./testing/mobileApiMocks.js")).dbModuleMock());
vi.mock("@book-maker/db/billing", async () => (await import("./testing/mobileApiMocks.js")).billingModuleMock());
vi.mock("../queue.js", async () => (await import("./testing/mobileApiMocks.js")).queueModuleMock());
vi.mock("../projectStatus.js", async () => (await import("./testing/mobileApiMocks.js")).projectStatusModuleMock());

import { prisma } from "@book-maker/db";
import { commitCoverChange } from "./coverChange.js";
import { installManuscriptFakeDb, type ManuscriptFakeDb } from "./testing/manuscriptFakeDb.js";
import {
  buildMobileApp,
  detachedRepairJobRow,
  mockAccessTokens,
  mockPrisma,
  openJobRow,
  resetMobileHarness,
  teardownMobileHarness
} from "./testing/mobileApiHarness.js";
import { createStudioBook, publish, saveChapter, seedGeneratedBook, takeOver } from "./testing/manuscriptTestSupport.js";

let db: ManuscriptFakeDb;

beforeEach(() => {
  resetMobileHarness();
  db = installManuscriptFakeDb();
  mockAccessTokens({ "token-a": "user-a" });
});
afterEach(teardownMobileHarness);

/** A held connection cannot borrow another one from an exhausted pool. */
function separateJobClients(detached: boolean) {
  let inTransaction = false;
  const escapedRead = vi.fn();
  const transactionJobs = vi.fn(async () => [detached ? detachedRepairJobRow() : openJobRow()]);
  mockPrisma.generationJob.findMany.mockImplementation(async () => {
    if (inTransaction) {
      escapedRead();
      throw new Error("No spare pool connection while the transaction holds its connection");
    }
    return [];
  });
  const runTransaction = mockPrisma.$transaction.getMockImplementation()!;
  mockPrisma.$transaction.mockImplementation((operation, options) => {
    if (typeof operation !== "function") return runTransaction(operation, options);
    return runTransaction(async (tx: typeof mockPrisma) => {
      inTransaction = true;
      try {
        return await operation({ ...tx, generationJob: { ...tx.generationJob, findMany: transactionJobs } });
      } finally {
        inTransaction = false;
      }
    }, options);
  });
  return { transactionJobs, escapedRead };
}

function expectLockedJobRead(clients: ReturnType<typeof separateJobClients>, projectId: string) {
  expect(clients.escapedRead).not.toHaveBeenCalled();
  expect(clients.transactionJobs).toHaveBeenCalledExactlyOnceWith({
    where: {
      projectId,
      status: { in: ["QUEUED", "ACTIVE"] },
      type: { notIn: ["PREPARE_CHARACTER_CANDIDATES", "BUILD_CHARACTER_PERSONA", "RESEARCH", "WRITING_ASSIST", "PREPARE_COMPOSITION"] }
    },
    select: { payload: true }
  });
  const lockCall = mockPrisma.$queryRaw.mock.calls.findIndex((call) =>
    (call[0] as readonly string[]).join("?").includes('FROM "Project"') &&
    (call[0] as readonly string[]).join("?").includes("FOR UPDATE")
  );
  expect(lockCall).toBeGreaterThanOrEqual(0);
  expect(mockPrisma.$queryRaw.mock.invocationCallOrder[lockCall]!).toBeLessThan(clients.transactionJobs.mock.invocationCallOrder[0]!);
}

describe.each([
  { label: "an owning job", detached: false, status: 409 },
  { label: "a detached repair", detached: true, status: 200 }
])("open-work reads with $label", ({ detached, status }) => {
  it("uses the cover change transaction's connection and classification", async () => {
    seedGeneratedBook(db);
    const clients = separateJobClients(detached);
    const result = prisma.$transaction((tx) => commitCoverChange(tx, "project-gen", { authorName: "A. Writer" }));

    if (detached) {
      await expect(result).resolves.toMatchObject({ contentRevision: 4 });
    } else {
      await expect(result).rejects.toMatchObject({ code: "PROJECT_BUSY" });
      expect(db.enqueued).toHaveLength(0);
    }
    expectLockedJobRead(clients, "project-gen");
    expect(mockPrisma.generationJob.findMany).not.toHaveBeenCalled();
  });

  it("uses the publish transaction's connection and classification", async () => {
    const app = await buildMobileApp();
    const { body } = await createStudioBook(app);
    const projectId = body.project.id as string;
    await saveChapter(app, projectId, { id: body.chapter.id, revision: 1 }, "The harbour was quiet at dawn.");
    const clients = separateJobClients(detached);

    const response = await publish(app, projectId, "request-publish-connection");

    expect(response.statusCode).toBe(status);
    if (!detached) {
      expect(response.json().error.code).toBe("PROJECT_BUSY");
      expect(db.pages).toHaveLength(0);
      expect(db.enqueued).toHaveLength(0);
    }
    expectLockedJobRead(clients, projectId);
  });

  it("uses the takeover transaction's connection after the global preflight", async () => {
    const app = await buildMobileApp();
    seedGeneratedBook(db);
    const clients = separateJobClients(detached);

    const response = await takeOver(app, "project-gen");

    expect(response.statusCode).toBe(status);
    if (!detached) {
      expect(response.json().error.code).toBe("PROJECT_BUSY");
      expect(db.manuscripts).toHaveLength(0);
      expect(db.enqueued).toHaveLength(0);
    }
    expectLockedJobRead(clients, "project-gen");
    expect(mockPrisma.generationJob.findMany).toHaveBeenCalled();
  });
});
