import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Job } from "bullmq";

const mocks = vi.hoisted(() => ({
  prisma: {
    bookEditOperation: { findUnique: vi.fn(), update: vi.fn() },
    project: { update: vi.fn(), updateMany: vi.fn() },
    planVersion: { findUnique: vi.fn() },
    page: { findMany: vi.fn(), update: vi.fn() },
    pageEditSnapshot: { create: vi.fn(), update: vi.fn(), deleteMany: vi.fn() },
    continuityNote: { createMany: vi.fn() }
  },
  rewritePageForUserRequest: vi.fn(),
  maybeEnqueueCompile: vi.fn(),
  storeEmbedding: vi.fn(),
  invalidateProjectExports: vi.fn()
}));

vi.mock("@book-maker/db", () => ({ prisma: mocks.prisma, Prisma: {} }));
vi.mock("../runtime/dispatch.js", () => ({ maybeEnqueueCompile: mocks.maybeEnqueueCompile }));
vi.mock("../runtime/jobLifecycle.js", () => ({ advanceJobStep: vi.fn() }));
vi.mock("../runtime/config.js", () => ({ config: {} }));
vi.mock("../providers/loggedAdapters.js", () => ({ createLoggedProviders: () => ({ embedding: {} }) }));
vi.mock("../generation/semanticMemory.js", () => ({
  storeEmbedding: mocks.storeEmbedding,
  // The fixture strategy is not sequential-pages, so edits skip the embedding.
  strategyUsesSemanticMemory: () => false
}));
vi.mock("../generation/projectInput.js", () => ({ inputForPlanVersion: () => ({}) }));
vi.mock("../generation/bookHelpers.js", () => ({
  getProjectOrThrow: async () => ({ id: "project-1", currentPlanId: "plan-1" }),
  invalidateProjectExports: mocks.invalidateProjectExports,
  strategyForInput: () => ({})
}));
vi.mock("./replanBook.js", async () => {
  const actual = await import("./replanBook.js");
  return { locallyPatchedPage: actual.locallyPatchedPage, rewritePageForUserRequest: mocks.rewritePageForUserRequest };
});
vi.mock("@book-maker/core", async () => {
  const actual = await vi.importActual<typeof import("@book-maker/core")>("@book-maker/core");
  return { ...actual, bookPlanSchema: { parse: () => ({}) }, createProviders: () => ({}) };
});

import { applyBookEdit } from "./applyBookEdit.js";
import { StopRequestedError } from "../runtime/jobTypes.js";

const page = (index: number, markdown: string) => ({
  id: `page-${index}`,
  index,
  title: `Page ${index}`,
  markdown,
  summary: "Summary.",
  imagePrompt: null,
  revision: 1,
  qualityReport: null,
  chapter: null
});

const job = (data: Record<string, unknown>) => ({ data, id: "job-1" }) as unknown as Job;

describe("applyBookEdit in exact mode", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.prisma.bookEditOperation.findUnique.mockResolvedValue({ id: "op-1" });
    mocks.prisma.planVersion.findUnique.mockResolvedValue({ id: "plan-1", inputSnapshot: {}, planningPackage: {} });
    mocks.prisma.pageEditSnapshot.create.mockImplementation(async () => ({ id: "snap-1" }));
    mocks.prisma.page.update.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({
      ...data,
      revision: 2
    }));
    mocks.prisma.project.updateMany.mockResolvedValue({ count: 1 });
  });
  afterEach(() => vi.clearAllMocks());

  it("patches matching pages without calling the text model", async () => {
    mocks.prisma.page.findMany.mockResolvedValue([page(1, "Rabbit runs."), page(2, "Rabbit rests.")]);

    await applyBookEdit(
      job({
        projectId: "project-1",
        operationId: "op-1",
        request: "Replace rabbit with fly",
        affectedPageIndexes: [1, 2],
        planId: "plan-1",
        exactReplacement: { from: "rabbit", to: "fly", preserveCase: true },
        mode: "exact"
      })
    );

    expect(mocks.rewritePageForUserRequest).not.toHaveBeenCalled();
    expect(mocks.prisma.page.update).toHaveBeenCalledTimes(2);
    expect(mocks.prisma.page.update.mock.calls[0]?.[0].data.markdown).toBe("Fly runs.");
    // A mechanical edit must not drag the compile's whole-book QA repair pass
    // behind it - that would rewrite prose nobody asked to change.
    expect(mocks.maybeEnqueueCompile).toHaveBeenCalledWith("project-1", "plan-1", { skipFinalReview: true });
  });

  it("skips a page that no longer matches instead of regenerating it", async () => {
    mocks.prisma.page.findMany.mockResolvedValue([page(1, "Rabbit runs."), page(2, "Nothing to see here.")]);

    await applyBookEdit(
      job({
        projectId: "project-1",
        operationId: "op-1",
        request: "Replace rabbit with fly",
        affectedPageIndexes: [1, 2],
        planId: "plan-1",
        exactReplacement: { from: "rabbit", to: "fly", preserveCase: true },
        mode: "exact"
      })
    );

    // The page changed between the quote and the apply. Rewriting it is not
    // what was approved - and it was quoted at zero credits.
    expect(mocks.rewritePageForUserRequest).not.toHaveBeenCalled();
    expect(mocks.prisma.page.update).toHaveBeenCalledTimes(1);
    expect(mocks.prisma.bookEditOperation.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ affectedPageIndexes: [1] }) })
    );
    // Undo names every snapshot it restores, so the untouched page must not keep one.
    expect(mocks.prisma.pageEditSnapshot.deleteMany).toHaveBeenCalledWith({
      where: { operationId: "op-1", pageIndex: { in: [2] } }
    });
    // The queued reply promised page 2, so the operation records the skip for
    // the serializer to surface — silence here left the transcript claiming an
    // edit that never happened.
    expect(mocks.prisma.bookEditOperation.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ classifier: expect.objectContaining({ skippedPageIndexes: [2] }) })
      })
    );
  });

  it("patches a page whose only match is the title instead of skipping it", async () => {
    mocks.prisma.page.findMany.mockResolvedValue([{ ...page(1, "Nothing to see here."), title: "Rabbit Learns" }]);

    await applyBookEdit(
      job({
        projectId: "project-1",
        operationId: "op-1",
        request: "Replace rabbit with fly",
        affectedPageIndexes: [1],
        planId: "plan-1",
        exactReplacement: { from: "rabbit", to: "fly", preserveCase: true },
        mode: "exact"
      })
    );

    // The preview priced this page on its title match, so the apply must take
    // the free patch path rather than the skip branch.
    expect(mocks.rewritePageForUserRequest).not.toHaveBeenCalled();
    expect(mocks.prisma.page.update).toHaveBeenCalledTimes(1);
    expect(mocks.prisma.page.update.mock.calls[0]?.[0].data.title).toBe("Fly Learns");
  });

  it("hands the book back to the repair lane when no recompile was queued", async () => {
    mocks.prisma.page.findMany.mockResolvedValue([page(1, "Rabbit runs.")]);
    mocks.maybeEnqueueCompile.mockResolvedValue("not-ready");

    await applyBookEdit(
      job({
        projectId: "project-1",
        operationId: "op-1",
        request: "Replace rabbit with fly",
        affectedPageIndexes: [1],
        planId: "plan-1",
        exactReplacement: { from: "rabbit", to: "fly", preserveCase: true },
        mode: "exact"
      })
    );

    // Nothing else moves a project out of EDITING, and the exports are already
    // deleted — so leaving it there is a book no sweep and no route can reach.
    expect(mocks.prisma.project.updateMany).toHaveBeenCalledWith({
      where: { id: "project-1", status: "EDITING" },
      data: { status: "COMPLETE" }
    });
  });

  it("hands the applied edit to the repair lane when export enqueue fails", async () => {
    mocks.prisma.page.findMany.mockResolvedValue([page(1, "Rabbit runs.")]);
    mocks.maybeEnqueueCompile.mockRejectedValue(new Error("queue unavailable"));
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await expect(
      applyBookEdit(
        job({
          projectId: "project-1",
          operationId: "op-1",
          request: "Replace rabbit with fly",
          affectedPageIndexes: [1],
          planId: "plan-1",
          exactReplacement: { from: "rabbit", to: "fly", preserveCase: true },
          mode: "exact"
        })
      )
    ).resolves.toBeUndefined();

    expect(mocks.prisma.project.updateMany).toHaveBeenCalledWith({
      where: { id: "project-1", status: "EDITING" },
      data: { status: "COMPLETE" }
    });
    expect(logged).toHaveBeenCalled();
    logged.mockRestore();
  });

  it("leaves the project EDITING while a compile is on its way", async () => {
    mocks.prisma.page.findMany.mockResolvedValue([page(1, "Rabbit runs.")]);
    mocks.maybeEnqueueCompile.mockResolvedValue("compile");

    await applyBookEdit(
      job({
        projectId: "project-1",
        operationId: "op-1",
        request: "Replace rabbit with fly",
        affectedPageIndexes: [1],
        planId: "plan-1",
        exactReplacement: { from: "rabbit", to: "fly", preserveCase: true },
        mode: "exact"
      })
    );

    // The compile publishes the status; restoring COMPLETE here would retire
    // the app's edit progress while the book is still being rebuilt.
    expect(mocks.prisma.project.updateMany).not.toHaveBeenCalled();
  });

  it("still falls back to a rewrite when no exact mode was promised", async () => {
    mocks.prisma.page.findMany.mockResolvedValue([page(1, "Nothing to see here.")]);
    mocks.rewritePageForUserRequest.mockResolvedValue({
      title: "Page 1",
      markdown: "Rewritten.",
      summary: "Summary.",
      continuityNotes: [],
      qualityReport: { approved: true }
    });

    await applyBookEdit(
      job({
        projectId: "project-1",
        operationId: "op-1",
        request: "Make page 1 funnier",
        affectedPageIndexes: [1],
        planId: "plan-1"
      })
    );

    expect(mocks.rewritePageForUserRequest).toHaveBeenCalledTimes(1);
    // The rewrite was reviewed per page with the user's request in context;
    // the recompile never re-runs the whole-book QA pass for an edit.
    expect(mocks.maybeEnqueueCompile).toHaveBeenCalledWith("project-1", "plan-1", { skipFinalReview: true });
  });

  it("rebuilds the exports from half-applied pages when a mid-edit rewrite fails", async () => {
    mocks.prisma.page.findMany.mockResolvedValue([page(1, "First."), page(2, "Second.")]);
    mocks.rewritePageForUserRequest
      .mockResolvedValueOnce({
        title: "Page 1",
        markdown: "Rewritten.",
        summary: "Summary.",
        continuityNotes: [],
        qualityReport: { approved: true }
      })
      .mockRejectedValueOnce(new Error("model outage"));

    await expect(
      applyBookEdit(
        job({
          projectId: "project-1",
          operationId: "op-1",
          request: "Make it funnier",
          affectedPageIndexes: [1, 2],
          planId: "plan-1"
        })
      )
    ).rejects.toThrow("model outage");

    // Page 1 already holds the edit while book.pdf still holds the pre-edit
    // text: the failure path must invalidate the exports, bump the revision
    // and queue the recompile itself, or the restored COMPLETE book keeps
    // valid-looking exports of text the pages no longer say.
    expect(mocks.invalidateProjectExports).toHaveBeenCalledWith("project-1");
    expect(mocks.prisma.project.update).toHaveBeenCalledWith({
      where: { id: "project-1" },
      data: { contentRevision: { increment: 1 } }
    });
    // Detached: the failed edit's settlement must not cancel the rebuild, and
    // the rebuild's own failure must not fail or refund the book.
    expect(mocks.maybeEnqueueCompile).toHaveBeenCalledWith("project-1", "plan-1", {
      skipFinalReview: true,
      detached: true
    });
  });

  it("still rethrows a mid-edit stop after queueing the rebuild", async () => {
    mocks.prisma.page.findMany.mockResolvedValue([page(1, "First."), page(2, "Second.")]);
    const stop = new StopRequestedError();
    mocks.rewritePageForUserRequest
      .mockResolvedValueOnce({
        title: "Page 1",
        markdown: "Rewritten.",
        summary: "Summary.",
        continuityNotes: [],
        qualityReport: { approved: true }
      })
      .mockRejectedValueOnce(stop);

    // The same StopRequestedError instance must escape, so markStopped still
    // runs and the stop settles the operation and its charge.
    await expect(
      applyBookEdit(
        job({
          projectId: "project-1",
          operationId: "op-1",
          request: "Make it funnier",
          affectedPageIndexes: [1, 2],
          planId: "plan-1"
        })
      )
    ).rejects.toBe(stop);

    expect(mocks.invalidateProjectExports).toHaveBeenCalledWith("project-1");
    expect(mocks.maybeEnqueueCompile).toHaveBeenCalledWith("project-1", "plan-1", {
      skipFinalReview: true,
      detached: true
    });
  });

  it("leaves the exports alone when the edit fails before any page was saved", async () => {
    mocks.prisma.page.findMany.mockResolvedValue([page(1, "First.")]);
    mocks.rewritePageForUserRequest.mockRejectedValue(new Error("model outage"));

    await expect(
      applyBookEdit(
        job({
          projectId: "project-1",
          operationId: "op-1",
          request: "Make it funnier",
          affectedPageIndexes: [1],
          planId: "plan-1"
        })
      )
    ).rejects.toThrow("model outage");

    // Nothing was written, so the pre-edit exports still describe the book.
    expect(mocks.invalidateProjectExports).not.toHaveBeenCalled();
    expect(mocks.maybeEnqueueCompile).not.toHaveBeenCalled();
    expect(mocks.prisma.project.update).not.toHaveBeenCalledWith({
      where: { id: "project-1" },
      data: { contentRevision: { increment: 1 } }
    });
  });

  it("saves a rewrite whose best candidate still failed review as FAILED_QA", async () => {
    mocks.prisma.page.findMany.mockResolvedValue([page(1, "Nothing to see here.")]);
    mocks.rewritePageForUserRequest.mockResolvedValue({
      title: "Page 1",
      markdown: "Rewritten.",
      summary: "Summary.",
      continuityNotes: [],
      qualityReport: { approved: false, score: 40 }
    });

    await applyBookEdit(
      job({
        projectId: "project-1",
        operationId: "op-1",
        request: "Make page 1 funnier",
        affectedPageIndexes: [1],
        planId: "plan-1"
      })
    );

    const savedPage = mocks.prisma.page.update.mock.calls
      .map((call) => (call[0] as { data: Record<string, unknown> }).data)
      .find((data) => data.markdown === "Rewritten.");
    expect(savedPage).toMatchObject({ status: "FAILED_QA" });
  });
});
