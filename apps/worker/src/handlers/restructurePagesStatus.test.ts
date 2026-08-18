/**
 * Who writes the project's status, and when nobody is going to.
 *
 * Split out of `restructurePages.test.ts` because it is one question asked of
 * every fork: the success path leaves the book EDITING for its recompile, and
 * every path that walks away without one has to hand it back the settled status
 * it came in with. EDITING with no job is the state no sweep reaches.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Job } from "bullmq";

const mocks = vi.hoisted(() => ({
  // One mutable row, and it starts EDITING because that is what an ordinary
  // delivery meets: the Apply writes it in the same committed transaction as
  // the job row, so the project says EDITING before this handler runs a line.
  // The tests that start it settled are not reading a pre-edit status off it —
  // that rides the payload — they are modelling the one thing that can put a
  // book back down mid-delivery, which is another delivery of the same edit.
  projectRow: { id: "project-1", currentPlanId: "plan-1", status: "EDITING", targetPages: 6 },
  prisma: {
    bookEditOperation: { findUnique: vi.fn(), update: vi.fn(), updateMany: vi.fn() },
    project: { findUnique: vi.fn(), update: vi.fn(), updateMany: vi.fn() },
    planVersion: { findUnique: vi.fn() },
    page: { findMany: vi.fn(), findUnique: vi.fn(), createMany: vi.fn(), deleteMany: vi.fn(), count: vi.fn() },
    chapter: { updateMany: vi.fn() },
    imageAsset: { updateMany: vi.fn() },
    $transaction: vi.fn()
  },
  applyStructuralPageChange: vi.fn(),
  leaseClaim: { outcome: "acquired", phase: "tail", application: null } as Record<string, unknown>,
  waitForStructuralPageLease: vi.fn(async () => mocks.leaseClaim),
  waitForStructuralPageLeaseCompletion: vi.fn(),
  heartbeatAssertHeld: vi.fn(),
  heartbeatStop: vi.fn(),
  startStructuralPageLeaseHeartbeat: vi.fn(() => ({ assertHeld: mocks.heartbeatAssertHeld, stop: mocks.heartbeatStop })),
  completeStructuralPageLease: vi.fn(),
  markStructuralPageLeaseApplied: vi.fn(),
  renewStructuralPageLeaseTx: vi.fn(),
  reviewAndSaveGeneratedPage: vi.fn(),
  generatePageDraft: vi.fn(),
  maybeEnqueueCompile: vi.fn(),
  invalidateProjectExports: vi.fn(),
  revertStructuralPageChange: vi.fn(),
  rebuildProjectStoryState: vi.fn(),
  rebuildRolledBackProjectStoryState: vi.fn(),
  refundSkippedEditOperation: vi.fn(),
  refundUnwrittenEditPages: vi.fn()
}));

vi.mock("@book-maker/db", () => ({
  prisma: mocks.prisma,
  Prisma: { DbNull: Symbol("DbNull") },
  PAGE_RESTRUCTURE_TRANSACTION_OPTIONS: { timeout: 30_000, maxWait: 10_000 },
  revertStructuralPageChange: mocks.revertStructuralPageChange
}));
vi.mock("../generation/pageRestructure.js", () => ({
  applyStructuralPageChange: mocks.applyStructuralPageChange
}));
vi.mock("../generation/structuralPageLease.js", () => ({
  waitForStructuralPageLease: mocks.waitForStructuralPageLease,
  waitForStructuralPageLeaseCompletion: mocks.waitForStructuralPageLeaseCompletion,
  startStructuralPageLeaseHeartbeat: mocks.startStructuralPageLeaseHeartbeat,
  completeStructuralPageLease: mocks.completeStructuralPageLease,
  markStructuralPageLeaseApplied: mocks.markStructuralPageLeaseApplied,
  renewStructuralPageLeaseTx: mocks.renewStructuralPageLeaseTx,
  releaseStructuralPageLease: vi.fn(),
  isStructuralPageLeaseLostError: () => false
}));
vi.mock("../generation/pageReview.js", () => ({
  reviewAndSaveGeneratedPage: mocks.reviewAndSaveGeneratedPage
}));
vi.mock("../generation/bookHelpers.js", () => ({
  getProjectOrThrow: async () => ({ ...mocks.projectRow }),
  invalidateProjectExports: mocks.invalidateProjectExports,
  strategyForInput: () => ({ generatePageDraft: mocks.generatePageDraft }),
  toPriorPageContext: (page: { index: number; title: string; markdown: string; summary: string }) => ({
    index: page.index,
    title: page.title,
    markdown: page.markdown,
    summary: page.summary
  })
}));
vi.mock("../generation/generationContext.js", () => ({
  loadContinuityNotes: async () => [],
  loadResearchNotesForGeneration: async () => []
}));
vi.mock("../generation/projectInput.js", () => ({ inputForPlanVersion: () => ({ targetPages: 6 }) }));
vi.mock("../generation/storyStateStore.js", () => ({
  rebuildProjectStoryState: mocks.rebuildProjectStoryState,
  rebuildRolledBackProjectStoryState: mocks.rebuildRolledBackProjectStoryState
}));
vi.mock("../providers/loggedAdapters.js", () => ({ createLoggedProviders: () => ({ text: {} }) }));
vi.mock("../runtime/config.js", () => ({ config: {} }));
vi.mock("../runtime/dispatch.js", () => ({
  maybeEnqueueCompile: mocks.maybeEnqueueCompile,
  redeliverWorkerGenerationJob: vi.fn()
}));
vi.mock("../runtime/jobLifecycle.js", () => ({
  advanceJobStep: vi.fn(),
  refundSkippedEditOperation: mocks.refundSkippedEditOperation,
  refundUnwrittenEditPages: mocks.refundUnwrittenEditPages
}));
vi.mock("../runtime/serialization.js", () => ({ errorMessage: (error: unknown) => String(error) }));
vi.mock("@book-maker/core", async () => {
  // The resolver, the stamp parser and the request reader stay real: they are
  // what the fence is made of, and a mocked fence tests nothing.
  const actual = await vi.importActual<typeof import("@book-maker/core")>("@book-maker/core");
  return { ...actual, bookPlanSchema: { parse: () => ({ chapters: [], promises: [] }) }, createProviders: () => ({}) };
});

import { PRE_EDIT_PROJECT_STATUS } from "@book-maker/core";

import { restructurePages } from "./restructurePages.js";

const job = (data: Record<string, unknown>) => ({ data, id: "job-1" }) as unknown as Job;

const insertJob = (payload: Record<string, unknown> = {}) =>
  job({
    projectId: "project-1",
    operationId: "op-1",
    request: "Add 2 pages after page 3",
    planId: "plan-1",
    structuralEdit: { action: "insert", anchorPageIndex: 3, pageIndexes: [], pageCount: 2 },
    ...payload
  });

const pages = (count: number) =>
  Array.from({ length: count }, (_value, offset) => ({
    id: `page-${offset + 1}`,
    index: offset + 1,
    chapterId: null
  }));

const application = (overrides: Record<string, unknown> = {}) => ({
  action: "insert",
  pageOrderBefore: pages(6).map((page) => ({ pageId: page.id, index: page.index, chapterId: page.chapterId })),
  insertedPageIds: ["page-new-1", "page-new-2"],
  removedPages: [],
  basePlanVersionId: "plan-1",
  newPlanVersionId: "plan-2",
  previousTargetPages: 6,
  previousChapterTargetPages: {},
  appliedAt: "2026-08-15T00:00:00.000Z",
  ...overrides
});

/** Every status this delivery wrote, whichever write it used to write it. */
const statusWrites = () =>
  [...mocks.prisma.project.update.mock.calls, ...mocks.prisma.project.updateMany.mock.calls]
    .map((call) => (call[0] as { data: { status?: string } }).data.status)
    .filter((status): status is string => status !== undefined);

describe("restructurePages project status", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.projectRow.status = "EDITING";
    // The status write is applied to the row, so every read after it answers
    // what the handler just wrote — which is the whole point.
    mocks.prisma.project.update.mockImplementation(async ({ data }: { data: { status?: string } }) => {
      if (typeof data.status === "string") {
        mocks.projectRow.status = data.status;
      }
      return { ...mocks.projectRow };
    });
    mocks.prisma.project.findUnique.mockImplementation(async () => ({ ...mocks.projectRow }));
    mocks.prisma.$transaction.mockImplementation(async (run: (tx: unknown) => Promise<unknown>) =>
      run(mocks.prisma)
    );
    mocks.prisma.bookEditOperation.updateMany.mockResolvedValue({ count: 1 });
    mocks.prisma.bookEditOperation.findUnique.mockResolvedValue({ id: "op-1", status: "ACTIVE", classifier: {} });
    mocks.prisma.planVersion.findUnique.mockResolvedValue({
      id: "plan-1",
      inputSnapshot: {},
      planningPackage: {}
    });
    mocks.prisma.page.findMany.mockResolvedValue(pages(6));
    mocks.prisma.page.count.mockResolvedValue(2);
    mocks.prisma.page.findUnique.mockResolvedValue({
      id: "page-new-1",
      index: 4,
      chapterId: null,
      chapter: null
    });
    mocks.applyStructuralPageChange.mockResolvedValue({
      outcome: "applied",
      application: application()
    });
    mocks.leaseClaim = { outcome: "acquired", phase: "tail", application: null };
    mocks.completeStructuralPageLease.mockResolvedValue(true);
    mocks.markStructuralPageLeaseApplied.mockImplementation(async ({ affectedPageIndexes }) => {
      await mocks.prisma.bookEditOperation.update({
        where: { id: "op-1" },
        data: { status: "APPLIED", affectedPageIndexes, appliedAt: new Date() }
      });
      return true;
    });
    mocks.renewStructuralPageLeaseTx.mockResolvedValue({
      status: "ACTIVE",
      classifier: { structuralApplication: application() }
    });
    mocks.generatePageDraft.mockResolvedValue({ title: "New", markdown: "Body.", summary: "S.", continuityNotes: [] });
    mocks.reviewAndSaveGeneratedPage.mockResolvedValue({ index: 4, title: "New", markdown: "Body.", summary: "S." });
    mocks.maybeEnqueueCompile.mockResolvedValue("compile");
    mocks.revertStructuralPageChange.mockResolvedValue({ currentPlanId: "plan-1" });
    mocks.rebuildProjectStoryState.mockResolvedValue({});
    mocks.rebuildRolledBackProjectStoryState.mockResolvedValue({});
    // Honours its `where`, because the count is load-bearing now: the handler
    // claims EDITING conditionally, and that count is the only thing telling an
    // abandoning delivery whether it is the one that moved the book.
    mocks.prisma.project.updateMany.mockImplementation(
      async ({ where, data }: { where: { status?: string | { not: string } }; data: { status?: string } }) => {
        const wanted = where.status;
        const matches =
          wanted === undefined
            ? true
            : typeof wanted === "string"
              ? mocks.projectRow.status === wanted
              : mocks.projectRow.status !== wanted.not;
        if (!matches) return { count: 0 };
        if (typeof data.status === "string") {
          mocks.projectRow.status = data.status;
        }
        return { count: 1 };
      }
    );
    mocks.refundSkippedEditOperation.mockResolvedValue(undefined);
    mocks.refundUnwrittenEditPages.mockResolvedValue(undefined);
  });
  afterEach(() => vi.clearAllMocks());

  it("stays EDITING until the recompile publishes, so the re-pointed page map stands", async () => {
    // The status is what `bookPageMapForProject` reads as "the reader is still
    // looking at the PDF this map was measured from". Retiring EDITING here
    // refused the map the shift had just re-pointed, and the reader's next
    // "page 12" fell back to a model index while printed page 12 was on screen.
    await restructurePages(insertJob(), { id: "op-1", status: "QUEUED", classifier: {} });

    expect(statusWrites()).toEqual(["EDITING"]);
  });

  it("takes the book out of EDITING when the dispatch queues nothing at all", async () => {
    // The one outcome with no compile coming to write the status: EDITING with
    // no job is the state no sweep reaches, while COMPLETE with its files gone
    // is precisely what ensureExportRepairQueued rebuilds.
    mocks.maybeEnqueueCompile.mockResolvedValue("not-ready");

    await restructurePages(insertJob(), { id: "op-1", status: "QUEUED", classifier: {} });

    expect(mocks.prisma.project.updateMany).toHaveBeenCalledWith({
      where: { id: "project-1", status: "EDITING" },
      data: { status: "COMPLETE" }
    });
  });

  it("hands a book that was still asking for attention back as REVIEW_REQUIRED", async () => {
    // The status a restore returns to rides the payload, stamped by the Apply
    // from the row it was about to move. Reading it here — before or after this
    // handler's own EDITING write — answers EDITING either way, which made the
    // REVIEW_REQUIRED branch dead code and sent a book with open quality
    // findings out of any restructure looking finished.
    mocks.maybeEnqueueCompile.mockResolvedValue("not-ready");

    await restructurePages(insertJob({ [PRE_EDIT_PROJECT_STATUS]: "REVIEW_REQUIRED" }), {
      id: "op-1",
      status: "QUEUED",
      classifier: {}
    });

    expect(mocks.prisma.project.updateMany).toHaveBeenCalledWith({
      where: { id: "project-1", status: "EDITING" },
      data: { status: "REVIEW_REQUIRED" }
    });
  });

  it("keeps REVIEW_REQUIRED when a redelivery of a finished restructure queues nothing", async () => {
    // The replay has even less to read than the main path: the first delivery
    // left the project EDITING deliberately, so the payload is the only record
    // of what the book was before the edit.
    mocks.maybeEnqueueCompile.mockResolvedValue("not-ready");

    await restructurePages(insertJob({ [PRE_EDIT_PROJECT_STATUS]: "REVIEW_REQUIRED" }), {
      id: "op-1",
      status: "APPLIED",
      classifier: {}
    });

    expect(mocks.prisma.project.updateMany).toHaveBeenCalledWith({
      where: { id: "project-1", status: "EDITING" },
      data: { status: "REVIEW_REQUIRED" }
    });
  });

  it("leaves the status to the compile when one is queued or still fanning in", async () => {
    mocks.maybeEnqueueCompile.mockResolvedValue("waiting");

    await restructurePages(insertJob(), { id: "op-1", status: "QUEUED", classifier: {} });

    expect(statusWrites()).toEqual(["EDITING"]);
  });

  it("puts a book a racing settlement already finished back where it found it", async () => {
    // The window the ACTIVE claim cannot fence: this delivery claimed the row
    // ACTIVE, and before its own EDITING write the first one settled a resolver
    // refusal — the operation APPLIED, the book back down as COMPLETE. The
    // write then lifted a finished book into EDITING, the shift's own claim
    // answered `completed`, and the delivery returned with nothing behind it to
    // lower the status again. EDITING with no job is terminal: it is neither
    // what `reconcileStrandedGeneration` sweeps (GENERATING) nor what
    // `ensureExportRepairQueued` rebuilds (COMPLETE/REVIEW_REQUIRED), so the
    // book said "preparing" forever.
    mocks.projectRow.status = "COMPLETE";
    mocks.prisma.bookEditOperation.findUnique.mockResolvedValue({
      id: "op-1",
      status: "APPLIED",
      classifier: { structuralSkipped: "unknown_pages" }
    });
    mocks.applyStructuralPageChange.mockResolvedValue({ outcome: "completed" });

    await restructurePages(insertJob(), { id: "op-1", status: "QUEUED", classifier: {} });

    expect(mocks.reviewAndSaveGeneratedPage).not.toHaveBeenCalled();
    expect(mocks.maybeEnqueueCompile).not.toHaveBeenCalled();
    expect(mocks.prisma.project.updateMany).toHaveBeenCalledWith({
      where: { id: "project-1", status: "EDITING" },
      data: { status: "COMPLETE" }
    });
    expect(mocks.projectRow.status).toBe("COMPLETE");
  });

  it("puts the book back when the shift's claim finds a delivered no-op instead", async () => {
    // The same stranding through the `settled` door, where the row went APPLIED
    // while this delivery was resolving its plan. A skipped row owes no tail, so
    // this path does nothing at all — and doing nothing has to include the
    // EDITING write it made on the way in.
    mocks.projectRow.status = "COMPLETE";
    mocks.applyStructuralPageChange.mockResolvedValue({ outcome: "settled" });
    mocks.prisma.bookEditOperation.findUnique
      .mockResolvedValueOnce({ id: "op-1", status: "ACTIVE", classifier: {} })
      .mockResolvedValue({
        id: "op-1",
        status: "APPLIED",
        classifier: { structuralSkipped: "unknown_pages" }
      });

    await restructurePages(insertJob(), { id: "op-1", status: "QUEUED", classifier: {} });

    expect(mocks.invalidateProjectExports).not.toHaveBeenCalled();
    expect(mocks.maybeEnqueueCompile).not.toHaveBeenCalled();
    expect(mocks.projectRow.status).toBe("COMPLETE");
  });

  it("hands a book still asking for attention back when the lease it waited for was finished", async () => {
    // The third door: the shift reports `already-applied`, and the lease this
    // delivery then waits for comes back completed. What it restores rides the
    // payload like every other fork's, so a book with open quality findings is
    // not quietly finished on its way out.
    mocks.projectRow.status = "REVIEW_REQUIRED";
    mocks.applyStructuralPageChange.mockResolvedValue({
      outcome: "already-applied",
      application: application(),
      retryAt: new Date("2026-08-18T00:03:00.000Z")
    });
    mocks.leaseClaim = { outcome: "completed" };

    await restructurePages(insertJob({ [PRE_EDIT_PROJECT_STATUS]: "REVIEW_REQUIRED" }), {
      id: "op-1",
      status: "ACTIVE",
      classifier: {}
    });

    expect(mocks.reviewAndSaveGeneratedPage).not.toHaveBeenCalled();
    expect(mocks.prisma.project.updateMany).toHaveBeenCalledWith({
      where: { id: "project-1", status: "EDITING" },
      data: { status: "REVIEW_REQUIRED" }
    });
    expect(mocks.projectRow.status).toBe("REVIEW_REQUIRED");
  });

  it("does not finish a live insert's job when the lease wait gives up", async () => {
    // A stalled redelivery that already sees the stamp. Returning here is
    // markCompleted on the shared GenerationJob while the owner is still in
    // draftInsertedPages — after which its markFailed misses.
    mocks.prisma.bookEditOperation.findUnique.mockResolvedValue({
      id: "op-1",
      status: "ACTIVE",
      classifier: { structuralApplication: application() }
    });
    mocks.leaseClaim = { outcome: "abandoned" };

    await expect(
      restructurePages(insertJob(), { id: "op-1", status: "ACTIVE", classifier: {} })
    ).rejects.toThrow("Structural page edit wait gave up without owning the delivery");

    expect(mocks.reviewAndSaveGeneratedPage).not.toHaveBeenCalled();
    expect(mocks.maybeEnqueueCompile).not.toHaveBeenCalled();
    expect(mocks.markStructuralPageLeaseApplied).not.toHaveBeenCalled();
    expect(statusWrites()).toEqual(["EDITING"]);
  });

  it("does not replay the export tail when an APPLIED wait gives up on a live owner", async () => {
    mocks.leaseClaim = { outcome: "abandoned" };

    await expect(
      restructurePages(insertJob(), { id: "op-1", status: "APPLIED", classifier: {} })
    ).rejects.toThrow("Structural page edit wait gave up without owning the delivery");

    expect(mocks.invalidateProjectExports).not.toHaveBeenCalled();
    expect(mocks.maybeEnqueueCompile).not.toHaveBeenCalled();
  });

  it("leaves EDITING standing when the delivery it stood down for still owes a compile", async () => {
    // The other half of the rule, and the reason the restore is conditional on
    // this delivery being the one that moved the book: the winner applied the
    // shift and queued the recompile, so EDITING is where the book belongs
    // until that compile publishes — `bookPageMapForProject` keeps the map the
    // shift re-pointed in force for exactly that window. This delivery moved
    // nothing, so it puts nothing back.
    mocks.applyStructuralPageChange.mockResolvedValue({ outcome: "completed" });

    await restructurePages(insertJob(), { id: "op-1", status: "QUEUED", classifier: {} });

    expect(statusWrites()).toEqual(["EDITING"]);
    expect(mocks.projectRow.status).toBe("EDITING");
  });

});
