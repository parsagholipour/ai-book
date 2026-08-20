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
  invalidateProjectExports: vi.fn(),
  applyImageInsertion: vi.fn(),
  applyImageLayout: vi.fn(),
  restructurePages: vi.fn()
}));

vi.mock("@book-maker/db", () => ({ prisma: mocks.prisma, Prisma: {} }));
vi.mock("../runtime/dispatch.js", () => ({ maybeEnqueueCompile: mocks.maybeEnqueueCompile }));
vi.mock("../runtime/jobLifecycle.js", () => ({ advanceJobStep: vi.fn() }));
vi.mock("../runtime/config.js", () => ({ config: {} }));
vi.mock("../providers/loggedAdapters.js", () => ({ createLoggedProviders: () => ({ embedding: {} }) }));
// The fixture strategy is not sequential-pages, so edits skip the embedding.
vi.mock("../generation/embeddingWrites.js", () => ({
  storeEmbedding: mocks.storeEmbedding,
  strategyUsesSemanticMemory: () => false
}));
vi.mock("../generation/projectInput.js", () => ({ inputForPlanVersion: () => ({}) }));
vi.mock("../generation/bookHelpers.js", () => ({
  getProjectOrThrow: async () => ({ id: "project-1", currentPlanId: "plan-1" }),
  invalidateProjectExports: mocks.invalidateProjectExports,
  strategyForInput: () => ({})
}));
vi.mock("./applyImageInsertion.js", () => ({ applyImageInsertion: mocks.applyImageInsertion }));
vi.mock("./applyImageLayout.js", () => ({ applyImageLayout: mocks.applyImageLayout }));
vi.mock("./restructurePages.js", () => ({ restructurePages: mocks.restructurePages }));
vi.mock("../generation/storyStateStore.js", () => ({
  rebuildProjectStoryState: vi.fn(),
  loadProjectStoryState: vi.fn(async () => ({ promises: [], facts: [], entities: {}, unanswered: [] }))
}));
vi.mock("../generation/qualityEnrichment.js", () => ({
  persistKeeperStoryDelta: vi.fn()
}));
vi.mock("./replanBook.js", async () => {
  const actual = await import("./replanBook.js");
  return { locallyPatchedPage: actual.locallyPatchedPage, rewritePageForUserRequest: mocks.rewritePageForUserRequest };
});
vi.mock("@book-maker/core", async () => {
  const actual = await vi.importActual<typeof import("@book-maker/core")>("@book-maker/core");
  return { ...actual, bookPlanSchema: { parse: () => ({}) }, createProviders: () => ({}) };
});

import { persistKeeperStoryDelta } from "../generation/qualityEnrichment.js";
import { loadProjectStoryState, rebuildProjectStoryState } from "../generation/storyStateStore.js";
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
    expect(loadProjectStoryState).toHaveBeenCalledTimes(1);
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
    expect(persistKeeperStoryDelta).toHaveBeenCalledTimes(1);
    expect(persistKeeperStoryDelta).toHaveBeenCalledWith(expect.objectContaining({ pageIndex: 1 }));
    // The queued reply promised page 2, so the operation records the skip for
    // the serializer to surface — silence here left the transcript claiming an
    // edit that never happened.
    expect(mocks.prisma.bookEditOperation.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ classifier: expect.objectContaining({ skippedPageIndexes: [2] }) })
      })
    );
  });

  it("skips the guaranteed-null plan lookup when the payload carries no planId", async () => {
    mocks.prisma.page.findMany.mockResolvedValue([page(1, "Rabbit runs.")]);

    await applyBookEdit(
      job({
        projectId: "project-1",
        operationId: "op-1",
        request: "Replace rabbit with fly",
        affectedPageIndexes: [1],
        exactReplacement: { from: "rabbit", to: "fly", preserveCase: true },
        mode: "exact"
      })
    );

    // Only the project's current plan is looked up — never `{ id: "" }`.
    const lookedUp = mocks.prisma.planVersion.findUnique.mock.calls.map(
      (call) => (call[0] as { where: { id: string } }).where.id
    );
    expect(lookedUp).toEqual(["plan-1"]);
    expect(mocks.prisma.page.update).toHaveBeenCalledTimes(1);
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
    expect(persistKeeperStoryDelta).toHaveBeenCalledWith(
      expect.objectContaining({
        pageIndex: 1,
        previousExtract: null,
        keeperWasRevised: true,
        draft: expect.objectContaining({ markdown: "Rewritten." })
      })
    );
    expect(rebuildProjectStoryState).toHaveBeenCalledWith("project-1", []);
  });

  it("gives each named page its own instruction and the rest the whole request", async () => {
    mocks.prisma.page.findMany.mockResolvedValue([page(1, "One."), page(2, "Two."), page(3, "Three.")]);
    mocks.rewritePageForUserRequest.mockResolvedValue({
      title: "Page",
      markdown: "Rewritten.",
      summary: "Summary.",
      continuityNotes: [],
      qualityReport: { approved: true }
    });

    await applyBookEdit(
      job({
        projectId: "project-1",
        operationId: "op-1",
        request: "Make page 1 funnier and page 3 shorter",
        affectedPageIndexes: [1, 2, 3],
        planId: "plan-1",
        perPageInstructions: [
          { pageIndex: 1, instruction: "Make it funnier." },
          { pageIndex: 3, instruction: "Make it shorter." }
        ]
      })
    );

    const requests = mocks.rewritePageForUserRequest.mock.calls.map((call) => call[0].request);
    // Page 2 has no entry, so it still gets the whole request — the field can
    // only narrow what a named page is told, never drop a page that was paid for.
    expect(requests).toEqual([
      "Make it funnier.",
      "Make page 1 funnier and page 3 shorter",
      "Make it shorter."
    ]);
  });

  it("keeps the mentioned character's sheet on a page rewritten from its own instruction", async () => {
    mocks.prisma.page.findMany.mockResolvedValue([page(1, "One."), page(2, "Two.")]);
    mocks.rewritePageForUserRequest.mockResolvedValue({
      title: "Page",
      markdown: "Rewritten.",
      summary: "Summary.",
      continuityNotes: [],
      qualityReport: { approved: true }
    });
    const sheet = "Mentioned character profiles (the user's own library characters; treat as authoritative canon):\nLuna — a brave night-flying rabbit.";

    await applyBookEdit(
      job({
        projectId: "project-1",
        operationId: "op-1",
        request: `Make page 1 funnier and page 2 shorter, and put @Luna in both.\n\n${sheet}`,
        affectedPageIndexes: [1, 2],
        planId: "plan-1",
        perPageInstructions: [
          { pageIndex: 1, instruction: `Make it funnier.\n\n${sheet}` },
          { pageIndex: 2, instruction: `Make it shorter.\n\n${sheet}` }
        ]
      })
    );

    // An instruction *replaces* the request for its page, so the sheet has to
    // ride the instruction too — the API composes both, and this loop hands
    // each string on untouched.
    const requests = mocks.rewritePageForUserRequest.mock.calls.map((call) => call[0].request as string);
    expect(requests).toHaveLength(2);
    for (const request of requests) {
      expect(request).toContain("night-flying");
    }
    expect(requests[0]!.startsWith("Make it funnier.")).toBe(true);
    expect(requests[1]!.startsWith("Make it shorter.")).toBe(true);
  });

  it("snapshots storyDelta before the rewrite and re-extracts saved pages", async () => {
    const storyDeltaBefore = {
      promisesOpened: [],
      promisesPaid: ["The lantern will be lit."],
      promisesBroken: [],
      factsAdded: ["It is raining."],
      entities: {},
      unansweredAdded: [],
      unansweredResolved: []
    };
    mocks.prisma.page.findMany.mockResolvedValue([{ ...page(1, "Rabbit runs."), storyDelta: storyDeltaBefore }]);

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

    expect(mocks.prisma.pageEditSnapshot.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        pageId: "page-1",
        markdownBefore: "Rabbit runs.",
        storyDeltaBefore
      })
    });
    expect(persistKeeperStoryDelta).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: "project-1",
        pageIndex: 1,
        previousExtract: null,
        keeperWasRevised: true,
        draft: expect.objectContaining({ markdown: "Fly runs." })
      })
    );
    expect(rebuildProjectStoryState).toHaveBeenCalledWith("project-1", []);
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

  it("forks an ADD_IMAGE operation before the ACTIVE and EDITING writes", async () => {
    const operation = { id: "op-1", kind: "ADD_IMAGE", status: "QUEUED", classifier: {} };
    mocks.prisma.bookEditOperation.findUnique.mockResolvedValue(operation);
    const payload = {
      projectId: "project-1",
      operationId: "op-1",
      request: "Add a photo of a dragon at the end of the book",
      affectedPageIndexes: [5],
      planId: "plan-1",
      intentKind: "add_image",
      imageInsertion: { subject: "a dragon", placement: "end_of_book", targetPageIndex: 5 }
    };

    await applyBookEdit(job(payload));

    // The insertion runs its own redelivery fence against the operation's
    // pre-write status, so the fork must hand over the record as read — before
    // the unconditional op-ACTIVE and project-EDITING writes.
    expect(mocks.applyImageInsertion).toHaveBeenCalledTimes(1);
    expect(mocks.applyImageInsertion.mock.calls[0]?.[1]).toBe(operation);
    const forkedJob = mocks.applyImageInsertion.mock.calls[0]?.[0] as { data: unknown } | undefined;
    expect(forkedJob?.data).toMatchObject(payload);
    expect(mocks.prisma.bookEditOperation.update).not.toHaveBeenCalled();
    expect(mocks.prisma.project.update).not.toHaveBeenCalled();
    // Nothing of the text-rewrite path runs.
    expect(mocks.prisma.page.findMany).not.toHaveBeenCalled();
    expect(mocks.rewritePageForUserRequest).not.toHaveBeenCalled();
    expect(mocks.maybeEnqueueCompile).not.toHaveBeenCalled();
  });

  it("forks a REMOVE_IMAGE operation before the ACTIVE and EDITING writes", async () => {
    const operation = { id: "op-1", kind: "REMOVE_IMAGE", status: "QUEUED", classifier: {} };
    mocks.prisma.bookEditOperation.findUnique.mockResolvedValue(operation);
    const payload = {
      projectId: "project-1",
      operationId: "op-1",
      request: "Remove the picture on page 1",
      affectedPageIndexes: [1],
      planId: "plan-1",
      intentKind: "remove_image",
      imageLayout: { action: "remove", source: { pageIndex: 1, replaceAssetId: "asset-1" } }
    };

    await applyBookEdit(job(payload));

    expect(mocks.applyImageLayout).toHaveBeenCalledTimes(1);
    expect(mocks.applyImageLayout.mock.calls[0]?.[1]).toBe(operation);
    expect(mocks.applyImageInsertion).not.toHaveBeenCalled();
    expect(mocks.prisma.bookEditOperation.update).not.toHaveBeenCalled();
    expect(mocks.prisma.project.update).not.toHaveBeenCalled();
    expect(mocks.prisma.page.findMany).not.toHaveBeenCalled();
  });

  it("forks a RESTRUCTURE_PAGES operation whose payload lost its structuralEdit", async () => {
    // The fork is decided by the operation's own column, so a payload rebuilt
    // without `structuralEdit` still reaches the structural handler — which
    // reads the request back off the classifier the Apply wrote it to. Gated on
    // the payload instead, this job took the rewrite loop with an empty
    // `affectedPageIndexes` (the only value this kind ever has), claimed the
    // operation ACTIVE outside the structural fence, and died on "No matching
    // pages found for this edit".
    const operation = {
      id: "op-1",
      kind: "RESTRUCTURE_PAGES",
      status: "QUEUED",
      classifier: { structuralEdit: { action: "insert", anchorPageIndex: 3, pageIndexes: [], pageCount: 2 } }
    };
    mocks.prisma.bookEditOperation.findUnique.mockResolvedValue(operation);
    mocks.prisma.page.findMany.mockResolvedValue([]);

    await applyBookEdit(
      job({
        projectId: "project-1",
        operationId: "op-1",
        request: "Add 2 pages after page 3",
        affectedPageIndexes: [],
        planId: "plan-1",
        intentKind: "restructure_pages"
      })
    );

    expect(mocks.restructurePages).toHaveBeenCalledTimes(1);
    expect(mocks.restructurePages.mock.calls[0]?.[1]).toBe(operation);
    // Handed over before the unconditional ACTIVE and EDITING writes, so the
    // handler's own redelivery fence still runs against the pre-write status.
    expect(mocks.prisma.bookEditOperation.update).not.toHaveBeenCalled();
    expect(mocks.prisma.project.update).not.toHaveBeenCalled();
    expect(mocks.rewritePageForUserRequest).not.toHaveBeenCalled();
  });

  it("forks an ADD_IMAGE operation whose payload lost its imageInsertion", async () => {
    // The same column rule as the structural fork, and the same failure behind
    // it — except that an image payload's `affectedPageIndexes` is *not* empty,
    // so the rewrite loop did not die: it found page 5 and spent two model calls
    // rewriting the prose the reader wanted a picture beside, then marked the
    // operation APPLIED — all of it outside the insertion's own redelivery
    // fence, because the ACTIVE and EDITING writes come first.
    const operation = {
      id: "op-1",
      kind: "ADD_IMAGE",
      status: "QUEUED",
      classifier: { kind: "add_image", imageEdit: { subject: "a dragon", placement: "end_of_book" } }
    };
    mocks.prisma.bookEditOperation.findUnique.mockResolvedValue(operation);
    mocks.prisma.page.findMany.mockResolvedValue([page(5, "The dragon sleeps.")]);

    await applyBookEdit(
      job({
        projectId: "project-1",
        operationId: "op-1",
        request: "Add a photo of a dragon at the end of the book",
        affectedPageIndexes: [5],
        planId: "plan-1",
        intentKind: "add_image"
      })
    );

    expect(mocks.applyImageInsertion).toHaveBeenCalledTimes(1);
    expect(mocks.applyImageInsertion.mock.calls[0]?.[1]).toBe(operation);
    expect(mocks.prisma.bookEditOperation.update).not.toHaveBeenCalled();
    expect(mocks.prisma.project.update).not.toHaveBeenCalled();
    expect(mocks.prisma.page.update).not.toHaveBeenCalled();
    expect(mocks.rewritePageForUserRequest).not.toHaveBeenCalled();
  });

  it("forks a MOVE_IMAGE operation whose payload lost its imageLayout", async () => {
    const operation = {
      id: "op-1",
      kind: "MOVE_IMAGE",
      status: "QUEUED",
      classifier: {
        kind: "move_image",
        imageLayout: { action: "move", targets: [{ operationId: "op-old", pageIndex: 1 }], destPlacement: "end_of_book" }
      }
    };
    mocks.prisma.bookEditOperation.findUnique.mockResolvedValue(operation);
    mocks.prisma.page.findMany.mockResolvedValue([page(1, "Prose.")]);

    await applyBookEdit(
      job({
        projectId: "project-1",
        operationId: "op-1",
        request: "Move the picture to the end of the book",
        affectedPageIndexes: [1, 9],
        planId: "plan-1",
        intentKind: "move_image"
      })
    );

    // A move is free, so the rewrite loop would have charged nothing and spent
    // a page of prose anyway.
    expect(mocks.applyImageLayout).toHaveBeenCalledTimes(1);
    expect(mocks.applyImageLayout.mock.calls[0]?.[1]).toBe(operation);
    expect(mocks.prisma.bookEditOperation.update).not.toHaveBeenCalled();
    expect(mocks.prisma.project.update).not.toHaveBeenCalled();
    expect(mocks.rewritePageForUserRequest).not.toHaveBeenCalled();
  });

  it("keeps an operation of any other kind on the text-rewrite path", async () => {
    mocks.prisma.bookEditOperation.findUnique.mockResolvedValue({ id: "op-1", kind: "PAGE_REWRITE" });
    mocks.prisma.page.findMany.mockResolvedValue([page(1, "Rabbit runs.")]);

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

    expect(mocks.restructurePages).not.toHaveBeenCalled();
    expect(mocks.prisma.page.update).toHaveBeenCalledTimes(1);
  });

  it("never forks on the payload alone", async () => {
    // The column is the whole rule. `BookEditOperation.kind` is written once at
    // creation and touched by nothing afterwards; the payload is JSON any
    // requeue can rebuild, so it decides nothing here in either direction.
    mocks.prisma.bookEditOperation.findUnique.mockResolvedValue({ id: "op-1", kind: "PAGE_REWRITE", classifier: {} });
    mocks.prisma.page.findMany.mockResolvedValue([page(1, "Rabbit runs.")]);

    await applyBookEdit(
      job({
        projectId: "project-1",
        operationId: "op-1",
        request: "Replace rabbit with fly",
        affectedPageIndexes: [1],
        planId: "plan-1",
        exactReplacement: { from: "rabbit", to: "fly", preserveCase: true },
        mode: "exact",
        imageInsertion: { subject: "a dragon", placement: "end_of_book", targetPageIndex: 5 },
        imageLayout: { action: "remove", sources: [{ pageIndex: 1, replaceAssetId: "asset-1" }] }
      })
    );

    expect(mocks.applyImageInsertion).not.toHaveBeenCalled();
    expect(mocks.applyImageLayout).not.toHaveBeenCalled();
    expect(mocks.prisma.page.update).toHaveBeenCalledTimes(1);
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
