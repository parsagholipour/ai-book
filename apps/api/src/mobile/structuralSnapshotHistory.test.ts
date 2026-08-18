import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@book-maker/db", async () => (await import("./testing/mobileApiMocks.js")).dbModuleMock());
vi.mock("@book-maker/db/billing", async () => (await import("./testing/mobileApiMocks.js")).billingModuleMock());
vi.mock("../queue.js", async () => (await import("./testing/mobileApiMocks.js")).queueModuleMock());
vi.mock("../projectStatus.js", async () => (await import("./testing/mobileApiMocks.js")).projectStatusModuleMock());

import { revertStructuralPageChange } from "@book-maker/db";
import { operationCanUndo } from "./projectChat.js";
import {
  appliedEditOperationRecord,
  approvedPlanRecord,
  bearer,
  buildMobileApp,
  generatedPages,
  mockAccessTokens,
  mockPrisma,
  projectRecord,
  resetMobileHarness,
  state,
  teardownMobileHarness
} from "./testing/mobileApiHarness.js";

describe("page-edit history across a structural delete", () => {
  beforeEach(resetMobileHarness);
  afterEach(teardownMobileHarness);

  it("does not expose the surviving half of a multi-page edit as an Undo", () => {
    const partiallyArchived = appliedEditOperationRecord({
      _count: { snapshots: 1, archivedSnapshots: 1 }
    });

    expect(operationCanUndo(partiallyArchived as never)).toBe(false);
  });

  it("undoes the structural delete first, then the fully restored earlier edit", async () => {
    mockAccessTokens({ "token-a": "user-a" });
    const pageRows = generatedPages().map((page) => ({
      ...page,
      projectId: "project-1",
      revision: 2
    }));
    state.pages = pageRows;
    mockPrisma.project.findFirst.mockResolvedValue(
      projectRecord({
        id: "project-1",
        status: "COMPLETE",
        currentPlanId: "plan-2",
        currentPlan: approvedPlanRecord(),
        pages: pageRows
      })
    );

    const older = appliedEditOperationRecord({
      id: "operation-older",
      request: "Rewrite both pages.",
      _count: { archivedSnapshots: 1 },
      createdAt: new Date("2026-06-15T13:10:00.000Z"),
      appliedAt: new Date("2026-06-15T13:11:00.000Z")
    });
    const structural = appliedEditOperationRecord({
      id: "operation-delete",
      kind: "RESTRUCTURE_PAGES",
      request: "Delete page 2.",
      affectedPageIndexes: [2],
      creditsCharged: 0,
      createdAt: new Date("2026-06-15T13:20:00.000Z"),
      appliedAt: new Date("2026-06-15T13:21:00.000Z"),
      classifier: {
        structuralApplication: {
          action: "delete",
          pageOrderBefore: [
            { pageId: "page-1", index: 1 },
            { pageId: "page-2", index: 2 }
          ],
          removedPages: [],
          snapshotArchive: { key: "operation-delete", snapshotCount: 1 },
          basePlanVersionId: "plan-1",
          newPlanVersionId: "plan-2",
          previousTargetPages: 2,
          appliedAt: "2026-08-15T00:00:00.000Z"
        }
      }
    });
    state.bookEditOperations.push(older, structural);
    state.pageEditSnapshots.push(snapshotFor("snapshot-page-1", "page-1", 1));
    vi.mocked(revertStructuralPageChange).mockResolvedValue({ currentPlanId: "plan-1" });
    const app = await buildMobileApp();

    const first = await app.inject({
      method: "POST",
      url: "/api/mobile/projects/project-1/chat/edits/undo",
      headers: bearer("token-a"),
      payload: {}
    });

    expect(first.statusCode).toBe(200);
    expect(first.json().reply.content).toContain("put the deleted pages back");
    expect(vi.mocked(revertStructuralPageChange)).toHaveBeenCalledTimes(1);
    expect(mockPrisma.page.update).not.toHaveBeenCalled();

    // What the real DB revert commits atomically: the parked row is recreated
    // under its original operation and the archive disappears.
    (older as typeof older & { _count: { archivedSnapshots: number } })._count.archivedSnapshots = 0;
    state.pageEditSnapshots.push(snapshotFor("snapshot-page-2", "page-2", 2));
    vi.mocked(mockPrisma.page.update).mockClear();

    const second = await app.inject({
      method: "POST",
      url: "/api/mobile/projects/project-1/chat/edits/undo",
      headers: bearer("token-a"),
      payload: {}
    });

    expect(second.statusCode).toBe(200);
    expect(second.json().reply.content).toContain("Rewrite both pages.");
    expect(mockPrisma.page.update).toHaveBeenCalledTimes(2);
    expect(mockPrisma.page.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "page-1" } })
    );
    expect(mockPrisma.page.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "page-2" } })
    );
    await app.close();
  });
});

function snapshotFor(id: string, pageId: string, pageIndex: number) {
  return {
    id,
    projectId: "project-1",
    pageId,
    operationId: "operation-older",
    pageIndex,
    titleBefore: `Page ${pageIndex} before`,
    markdownBefore: `Page ${pageIndex} before body.`,
    summaryBefore: `Page ${pageIndex} before summary.`,
    revisionBefore: 1,
    storyDeltaBefore: null,
    titleAfter: `Page ${pageIndex} after`,
    markdownAfter: `Page ${pageIndex} after body.`,
    summaryAfter: `Page ${pageIndex} after summary.`,
    revisionAfter: 2,
    createdAt: new Date(`2026-06-15T13:0${pageIndex}:00.000Z`)
  };
}
