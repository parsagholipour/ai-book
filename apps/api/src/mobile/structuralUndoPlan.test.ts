import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@book-maker/db", async () => (await import("./testing/mobileApiMocks.js")).dbModuleMock());
vi.mock("@book-maker/db/billing", async () => (await import("./testing/mobileApiMocks.js")).billingModuleMock());
vi.mock("../queue.js", async () => (await import("./testing/mobileApiMocks.js")).queueModuleMock());
vi.mock("../projectStatus.js", async () => (await import("./testing/mobileApiMocks.js")).projectStatusModuleMock());

import { revertStructuralPageChange } from "@book-maker/db";
import { enqueueGenerationJob } from "../queue.js";
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

describe("structural undo plan selection", () => {
  beforeEach(resetMobileHarness);
  afterEach(teardownMobileHarness);

  it("recompiles against a later continuation plan that the revert reconciled", async () => {
    mockAccessTokens({ "token-a": "user-a" });
    mockPrisma.project.findFirst.mockResolvedValue(
      projectRecord({
        id: "project-1",
        status: "COMPLETE",
        // P1 -> structural P2 -> continuation P3. The shared revert keeps P3
        // current while taking P2's page-target delta back out of it.
        currentPlanId: "plan-3",
        currentPlan: approvedPlanRecord({ id: "plan-3" }),
        pages: generatedPages()
      })
    );
    const undoneOperation = appliedEditOperationRecord({
      kind: "RESTRUCTURE_PAGES",
      request: "Add a page after page 1.",
      creditsCharged: 30,
      snapshots: [],
      classifier: {
        structuralApplication: {
          action: "insert",
          pageOrderBefore: [
            { pageId: "page-1", index: 1 },
            { pageId: "page-2", index: 2 }
          ],
          insertedPageIds: ["page-new"],
          removedPages: [],
          basePlanVersionId: "plan-1",
          newPlanVersionId: "plan-2",
          previousTargetPages: 2,
          previousChapterTargetPages: {},
          appliedAt: "2026-08-15T00:00:00.000Z"
        }
      }
    });
    state.bookEditOperations.push(undoneOperation);
    mockPrisma.bookEditOperation.findMany.mockResolvedValue([undoneOperation]);
    vi.mocked(revertStructuralPageChange).mockResolvedValue({ currentPlanId: "plan-3" });
    const app = await buildMobileApp();

    const response = await app.inject({
      method: "POST",
      url: "/api/mobile/projects/project-1/chat/edits/undo",
      headers: bearer("token-a"),
      payload: {}
    });

    expect(response.statusCode).toBe(200);
    const compile = vi
      .mocked(enqueueGenerationJob)
      .mock.calls.map((call) => call.at(0) as { type: string; dedupeKey: string; payload: Record<string, unknown> })
      .find((job) => job.type === "COMPILE_EXPORT");
    expect(compile?.payload.planId).toBe("plan-3");
    expect(compile?.dedupeKey).toContain("plan-3");
    await app.close();
  });

  /** The row the reader tapped Undo on: an applied insert, stamp and all. */
  const structuralInsertOperation = () =>
    appliedEditOperationRecord({
      id: "operation-structural",
      kind: "RESTRUCTURE_PAGES",
      request: "Add a page after page 1.",
      creditsCharged: 30,
      snapshots: [],
      classifier: {
        structuralApplication: {
          action: "insert",
          pageOrderBefore: [
            { pageId: "page-1", index: 1 },
            { pageId: "page-2", index: 2 }
          ],
          insertedPageIds: ["page-new"],
          removedPages: [],
          basePlanVersionId: "plan-1",
          newPlanVersionId: "plan-2",
          previousTargetPages: 2,
          previousChapterTargetPages: {},
          appliedAt: "2026-08-15T00:00:00.000Z"
        }
      }
    });

  const projectUnderARollback = () => {
    mockAccessTokens({ "token-a": "user-a" });
    mockPrisma.project.findFirst.mockResolvedValue(
      projectRecord({
        id: "project-1",
        status: "COMPLETE",
        currentPlanId: "plan-2",
        currentPlan: approvedPlanRecord({ id: "plan-2" }),
        pages: generatedPages()
      })
    );
    // Answering the way the old code's second revert would, so the assertions
    // below fail on the revert itself rather than on a destructured undefined.
    vi.mocked(revertStructuralPageChange).mockResolvedValue({ currentPlanId: "plan-1" });
  };

  /**
   * Lands the worker's rollback in the window the picker's read opened: the
   * stamp comes off, and `settledStatus` says whether the `updateMany` that
   * flips the row FAILED afterwards got through or was `.catch()`ed away.
   */
  const rollBackDuringTransaction = (
    row: { status: string; classifier: unknown },
    settledStatus: "FAILED" | "APPLIED"
  ) => {
    const runTransaction = mockPrisma.$transaction.getMockImplementation()!;
    mockPrisma.$transaction.mockImplementation(async (argument: unknown) => {
      if ((row.classifier as Record<string, unknown>).structuralApplication) {
        row.classifier = { structuralRolledBackAt: "2026-08-16T00:00:00.000Z" };
        row.status = settledStatus;
      }
      return runTransaction(argument);
    });
  };

  const undo = async (app: Awaited<ReturnType<typeof buildMobileApp>>) =>
    app.inject({
      method: "POST",
      url: "/api/mobile/projects/project-1/chat/edits/undo",
      headers: bearer("token-a"),
      payload: {}
    });

  /**
   * The reader taps Undo while the worker is still drafting the inserted pages,
   * so the picker's row is read with the stamp on it and the row moves
   * underneath: drafting dies, `rollbackStructuralChange` puts the pages back,
   * deletes `structuralApplication` and writes `structuralRolledBackAt`, and
   * `failEditOperation` flips the row FAILED.
   *
   * Both halves of the damage are asserted, because the write is what makes the
   * second revert possible again: reverting an already-restored book, and then
   * merging the pre-rollback classifier back over the rollback's own record —
   * the stamp reinstated, `structuralRolledBackAt` dropped — which puts the row
   * back in front of the reader as undoable.
   */
  it("refuses an undo the worker rolled back after the picker read the row", async () => {
    projectUnderARollback();
    const operation = structuralInsertOperation();
    state.bookEditOperations.push(operation);
    // The rollback's own settlement got through, so the row is no longer
    // APPLIED — which is what the claim opening the transaction notices.
    rollBackDuringTransaction(operation, "FAILED");
    const app = await buildMobileApp();

    const response = await undo(app);

    expect(response.statusCode).toBe(200);
    // The book is already back; running the revert again deletes a plan version
    // that is gone and re-approves the base plan.
    expect(vi.mocked(revertStructuralPageChange)).not.toHaveBeenCalled();
    // And the rollback's record stands: reinstating the stamp would offer Undo
    // on an edit that never landed.
    expect(operation.classifier).toEqual({ structuralRolledBackAt: "2026-08-16T00:00:00.000Z" });
    expect(operation.status).toBe("FAILED");
    expect(
      vi
        .mocked(enqueueGenerationJob)
        .mock.calls.map((call) => call.at(0) as { type: string })
        .some((job) => job.type === "COMPILE_EXPORT")
    ).toBe(false);
    expect(response.json().reply.content).toContain("no recent text edit I can undo");
    await app.close();
  });

  it("refuses it when the rollback's FAILED write was swallowed and only the stamp is gone", async () => {
    projectUnderARollback();
    // `rollbackStructuralChange` erases the stamp inside the revert's own
    // transaction and the `updateMany` flipping the row APPLIED -> FAILED
    // afterwards is `.catch()`ed, so the status can still say APPLIED. The
    // classifier re-read under the claim is the only thing that sees this one.
    const operation = structuralInsertOperation();
    state.bookEditOperations.push(operation);
    rollBackDuringTransaction(operation, "APPLIED");
    const app = await buildMobileApp();

    const response = await undo(app);

    expect(response.statusCode).toBe(200);
    expect(vi.mocked(revertStructuralPageChange)).not.toHaveBeenCalled();
    expect(operation.classifier).toEqual({ structuralRolledBackAt: "2026-08-16T00:00:00.000Z" });
    expect(response.json().reply.content).toContain("no recent text edit I can undo");
    await app.close();
  });
});
