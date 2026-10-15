import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@book-maker/db", async () => (await import("./testing/mobileApiMocks.js")).dbModuleMock());
vi.mock("@book-maker/db/billing", async () => (await import("./testing/mobileApiMocks.js")).billingModuleMock());
vi.mock("../queue.js", async () => (await import("./testing/mobileApiMocks.js")).queueModuleMock());
vi.mock("../projectStatus.js", async () => (await import("./testing/mobileApiMocks.js")).projectStatusModuleMock());

import { COVER_PURCHASE, COVER_RETYPESET } from "@book-maker/core";
import { prisma } from "@book-maker/db";
import { commitCoverChange, ManuscriptCoverRefusal, type CoverChange } from "./coverChange.js";
import { jobRecord, mockPrisma, mockQueue, openJobRow, resetMobileHarness, teardownMobileHarness } from "./testing/mobileApiHarness.js";
import { mockTransactions, rawStatementsMatching } from "./testing/mobileApiMocks.js";

/**
 * `commitCoverChange` itself — the one transaction every presentation change
 * of a finished book makes. The route suites (`bookMatterRoutes.test.ts`,
 * `bookTitleEdits.test.ts`) assert what they hand it; this asserts what it
 * then writes, which nothing else does.
 */

type Row = Record<string, any>;

let enqueued: Row[];

beforeEach(() => {
  resetMobileHarness();
  enqueued = [];
  mockPrisma.project.findUnique.mockResolvedValue({
    status: "COMPLETE",
    contentRevision: 3,
    currentPlanId: "plan-1",
    mediaSettings: { coverArtSource: "ai", includeCover: true }
  });
  mockPrisma.project.update.mockImplementation(async ({ data }: Row) => ({
    contentRevision: 3 + (data.contentRevision?.increment ?? 0)
  }));
  mockQueue.enqueueGenerationJob.mockImplementation(async (options: Row) => {
    enqueued.push(options);
    return jobRecord({ id: `job-${enqueued.length}`, projectId: options.projectId, type: options.type, payload: options.payload });
  });
});
afterEach(teardownMobileHarness);

function commit(change: CoverChange) {
  return prisma.$transaction((tx) => commitCoverChange(tx, "book-1", change));
}

function projectWrite(): Row {
  expect(mockPrisma.project.update).toHaveBeenCalledTimes(1);
  return mockPrisma.project.update.mock.calls[0]![0] as Row;
}

describe("commitCoverChange", () => {
  it("writes the byline and the matter onto the project in the commit that bumps the revision", async () => {
    const committed = await commit({ authorName: "Parsa Q.", bookMatter: { dedication: "For Sara", isbn: "978-0-00-000000-0" } });

    expect(projectWrite()).toEqual({
      where: { id: "book-1" },
      data: {
        status: "EDITING",
        contentRevision: { increment: 1 },
        authorName: "Parsa Q.",
        bookMatter: { dedication: "For Sara", isbn: "978-0-00-000000-0" }
      },
      select: { contentRevision: true }
    });
    // The byline and matter live on the row; the plan is not touched for them.
    expect(mockPrisma.planVersion.update).not.toHaveBeenCalled();
    // Under the row lock, taken before anything is read, and through the transaction's own client.
    const lockCall = mockPrisma.$queryRaw.mock.calls.findIndex((call) => (call[0] as readonly string[]).join("?").includes("FOR UPDATE"));
    expect(rawStatementsMatching("FOR UPDATE")).toHaveLength(1);
    expect(mockPrisma.$queryRaw.mock.invocationCallOrder[lockCall]!).toBeLessThan(mockPrisma.project.findUnique.mock.invocationCallOrder[0]!);
    expect(mockTransactions()[0]!.writes.map((write) => `${write.model}.${write.operation}`)).toEqual(["project.update"]);
    // One free reprint at the new revision, a row in this commit and dispatched after it.
    expect(enqueued).toHaveLength(1);
    expect(enqueued[0]).toMatchObject({ type: "COMPILE_EXPORT", contentRevision: 4, dispatch: false, payload: { planId: "plan-1", contentRevision: 4 } });
    expect(enqueued[0]!.transaction).toBeDefined();
    expect(committed).toEqual({ jobIds: ["job-1"], primaryJobId: "job-1", contentRevision: 4, restoreStatus: "COMPLETE" });
  });

  it("clears a byline on null, and leaves both alone when the change does not name them", async () => {
    await commit({ authorName: null, bookMatter: {} });
    expect(projectWrite().data).toMatchObject({ authorName: null, bookMatter: {} });

    mockPrisma.project.update.mockClear();
    await commit({ title: "The Last Lighthouse" });
    const data = projectWrite().data;
    expect(data).not.toHaveProperty("authorName");
    expect(data).not.toHaveProperty("bookMatter");
  });

  it("puts the re-set flag on the cover job a kept-artwork cover is given, and no purchase", async () => {
    const committed = await commit({ authorName: "Parsa Q.", drawCover: { purchase: false, retypeset: true } });

    expect(enqueued.map((job) => job.type)).toEqual(["COMPILE_EXPORT", "GENERATE_IMAGE"]);
    const cover = enqueued[1]!;
    expect(cover).toMatchObject({
      projectId: "book-1",
      contentRevision: 4,
      dispatch: false,
      dedupeKey: "generate-cover:book-1:plan-1:revision-4:status-EDITING"
    });
    expect(cover.payload).toEqual({
      planId: "plan-1",
      assetType: "COVER",
      contentRevision: 4,
      exportPublicationProjectStatus: "EDITING",
      [COVER_RETYPESET]: true
    });
    expect(cover.payload).not.toHaveProperty(COVER_PURCHASE);
    expect(cover).not.toHaveProperty("attemptId");
    expect(committed).toMatchObject({ jobIds: ["job-1", "job-2"], primaryJobId: "job-2" });
  });

  it("queues a design's retypeset without buying or drawing any artwork", async () => {
    await commit({ authorName: "Parsa Q.", coverArtSource: "design", drawCover: { purchase: false, retypeset: true } });

    expect(enqueued[1]!.payload).toHaveProperty(COVER_RETYPESET, true);
    expect(enqueued[1]!.payload).not.toHaveProperty(COVER_PURCHASE);
    expect(projectWrite().data.mediaSettings).toEqual({ coverArtSource: "design", includeCover: false });
  });

  it("refuses, and writes nothing, while another job owns the book", async () => {
    mockPrisma.generationJob.findMany.mockResolvedValue([openJobRow()]);

    await expect(commit({ authorName: "Parsa Q." })).rejects.toBeInstanceOf(ManuscriptCoverRefusal);
    expect(mockPrisma.project.update).not.toHaveBeenCalled();
    expect(enqueued).toEqual([]);
  });
});
