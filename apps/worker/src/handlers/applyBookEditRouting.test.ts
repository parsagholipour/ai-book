import type { Job } from "bullmq";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const project = { update: vi.fn(), updateMany: vi.fn() };
  const page = { findMany: vi.fn(), update: vi.fn() };
  const pageEditSnapshot = { findMany: vi.fn(), createManyAndReturn: vi.fn(), update: vi.fn(), deleteMany: vi.fn() };
  const continuityNote = { createMany: vi.fn() };
  return {
    prisma: {
      $transaction: vi.fn(),
      bookEditOperation: { findUnique: vi.fn(), update: vi.fn(), updateMany: vi.fn() },
      project,
      planVersion: { findUnique: vi.fn() },
      page,
      pageEditSnapshot,
      continuityNote
    },
    tx: {
      bookEditOperation: { update: vi.fn() },
      project,
      page,
      pageEditSnapshot,
      continuityNote,
      $executeRawUnsafe: vi.fn()
    },
    rewritePageForUserRequest: vi.fn(),
    loadQualityContext: vi.fn(async () => ({
      settings: {},
      tier: "balanced" as const,
      enabled: (_feature: string): boolean => false
    })),
    maybeEnqueueCompile: vi.fn(),
    storeEmbedding: vi.fn(),
    invalidateProjectExports: vi.fn(),
    getProjectOrThrow: vi.fn(),
    applyImageInsertion: vi.fn(),
    applyImageLayout: vi.fn(),
    restructurePages: vi.fn(),
    assertTextEditLeaseTx: vi.fn(async () => ({ status: "ACTIVE", classifier: {} })),
    completeTextEditLease: vi.fn(async () => true),
    waitForTextEditLease: vi.fn(async () => ({ outcome: "acquired", phase: "draft" } as const)),
    waitForTextEditLeaseCompletion: vi.fn(async () => "completed" as const),
    heartbeatAssertHeld: vi.fn(async () => undefined),
    heartbeatStop: vi.fn(async () => undefined),
    claimAppliedEditPublication: vi.fn(async () => true),
    restoreEditProjectStatus: vi.fn(async () => true),
    keeperStoryExtractForSave: vi.fn(async () => null),
    persistStoryExtract: vi.fn(async () => null),
    publishTextEditManuscript: vi.fn(async () => ({
      identity: {
        projectId: "project-1", operationId: "op-1", planVersionId: "plan-1",
        publicationRevision: 8, fallbackStatus: "COMPLETE"
      },
      memory: []
    })),
    textEditPublicationCompletion: vi.fn(() => ({
      durableCompletionCommitted: true,
      lifecycleCompletionCommitted: true,
      retryFollowUpOnRedelivery: true,
      afterJobCompleted: vi.fn()
    })),
    textEditPublicationIdentity: vi.fn(() => null),
    adoptLegacyTextEditTail: vi.fn(async () => null)
  };
});

vi.mock("@book-maker/db", () => ({
  prisma: mocks.prisma,
  Prisma: {},
  MANUSCRIPT_PUBLICATION_TRANSACTION_OPTIONS: { timeout: 30_000, maxWait: 10_000 }
}));
vi.mock("../runtime/dispatch.js", () => ({ maybeEnqueueCompile: mocks.maybeEnqueueCompile }));
vi.mock("../runtime/jobLifecycle.js", () => ({ advanceJobStep: vi.fn() }));
vi.mock("../runtime/durableEditCompletion.js", () => ({
  claimDurableEditCompletionTx: vi.fn(async () => true),
  settleDurableEditAttemptTx: vi.fn(async () => true)
}));
vi.mock("../runtime/config.js", () => ({ config: {} }));
vi.mock("../providers/loggedAdapters.js", () => ({ createLoggedProviders: () => ({ embedding: {} }) }));
vi.mock("../generation/embeddingWrites.js", () => ({
  storeEmbedding: mocks.storeEmbedding,
  strategyUsesSemanticMemory: () => false
}));
vi.mock("../generation/projectInput.js", () => ({ inputForPlanVersion: () => ({}) }));
vi.mock("../generation/bookHelpers.js", () => ({
  getProjectOrThrow: mocks.getProjectOrThrow,
  invalidateProjectExports: mocks.invalidateProjectExports,
  loadStyleLockPages: async () => [],
  strategyForInput: () => ({})
}));
vi.mock("./applyImageInsertion.js", () => ({ applyImageInsertion: mocks.applyImageInsertion }));
vi.mock("./applyImageLayout.js", () => ({ applyImageLayout: mocks.applyImageLayout }));
vi.mock("./restructurePages.js", () => ({ restructurePages: mocks.restructurePages }));
vi.mock("../generation/qualitySettings.js", () => ({
  loadQualityContext: mocks.loadQualityContext,
  applyPlanThinkingBoost: vi.fn()
}));
vi.mock("../generation/storyStateStore.js", () => ({
  rebuildProjectStoryState: vi.fn(),
  loadProjectStoryState: vi.fn(async () => ({ promises: [], facts: [], entities: {}, unanswered: [] }))
}));
vi.mock("../generation/qualityEnrichment.js", () => ({
  keeperStoryExtractForSave: mocks.keeperStoryExtractForSave,
  persistStoryExtract: mocks.persistStoryExtract
}));
vi.mock("../generation/textEditLease.js", () => ({
  assertTextEditLeaseTx: mocks.assertTextEditLeaseTx,
  completeTextEditLease: mocks.completeTextEditLease,
  isTextEditLeaseLostError: () => false,
  startTextEditLeaseHeartbeat: () => ({ assertHeld: mocks.heartbeatAssertHeld, stop: mocks.heartbeatStop }),
  waitForTextEditLease: mocks.waitForTextEditLease,
  waitForTextEditLeaseCompletion: mocks.waitForTextEditLeaseCompletion
}));
vi.mock("../generation/editProjectStatus.js", () => ({
  claimAppliedEditPublication: mocks.claimAppliedEditPublication,
  restoreEditProjectStatus: mocks.restoreEditProjectStatus
}));
vi.mock("../generation/textEditPublication.js", () => ({
  publishTextEditManuscript: mocks.publishTextEditManuscript,
  textEditPublicationCompletion: mocks.textEditPublicationCompletion,
  textEditPublicationIdentity: mocks.textEditPublicationIdentity,
  adoptLegacyTextEditTail: mocks.adoptLegacyTextEditTail
}));
vi.mock("../generation/textEditRewrite.js", async () => {
  const actual = await vi.importActual<typeof import("../generation/textEditRewrite.js")>(
    "../generation/textEditRewrite.js"
  );
  return { locallyPatchedPage: actual.locallyPatchedPage, rewritePageForUserRequest: mocks.rewritePageForUserRequest };
});
vi.mock("@book-maker/core", async () => {
  const actual = await vi.importActual<typeof import("@book-maker/core")>("@book-maker/core");
  return {
    ...actual,
    bookPlanSchema: { parse: () => ({}) },
    createProviders: () => ({}),
    reviewAppliedBookEdit: async () => ({
      satisfied: true,
      confidence: 1,
      missingRequirements: [],
      contradictions: [],
      pageIndexesToRevise: []
    })
  };
});

import { EDIT_ADHERENCE_FAILED } from "@book-maker/core/editFailure";
import { applyBookEdit } from "./applyBookEdit.js";

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

describe("applyBookEdit operation routing", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.prisma.bookEditOperation.findUnique.mockResolvedValue({ id: "op-1" });
    mocks.prisma.bookEditOperation.updateMany.mockResolvedValue({ count: 1 });
    mocks.getProjectOrThrow.mockResolvedValue({ id: "project-1", currentPlanId: "plan-1" });
    mocks.prisma.planVersion.findUnique.mockResolvedValue({ id: "plan-1", inputSnapshot: {}, planningPackage: {} });
    mocks.prisma.pageEditSnapshot.findMany.mockResolvedValue([]);
    mocks.prisma.pageEditSnapshot.createManyAndReturn.mockImplementation(
      async ({ data }: { data: Array<Record<string, unknown>> }) =>
        data.map((snapshot) => ({ ...snapshot, id: `snap-${String(snapshot.pageId)}` }))
    );
    mocks.prisma.page.update.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({
      ...data,
      revision: 2
    }));
    mocks.prisma.$transaction.mockImplementation(async (callback: (tx: typeof mocks.tx) => Promise<unknown>) =>
      callback(mocks.tx)
    );
    mocks.prisma.project.updateMany.mockResolvedValue({ count: 1 });
    mocks.tx.project.update.mockResolvedValue({ contentRevision: 8 });
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

    expect(mocks.applyImageInsertion).toHaveBeenCalledTimes(1);
    expect(mocks.applyImageInsertion.mock.calls[0]?.[1]).toBe(operation);
    const forkedJob = mocks.applyImageInsertion.mock.calls[0]?.[0] as { data: unknown } | undefined;
    expect(forkedJob?.data).toMatchObject(payload);
    expect(mocks.prisma.bookEditOperation.update).not.toHaveBeenCalled();
    expect(mocks.prisma.project.update).not.toHaveBeenCalled();
    expect(mocks.prisma.page.findMany).not.toHaveBeenCalled();
    expect(mocks.rewritePageForUserRequest).not.toHaveBeenCalled();
    expect(mocks.maybeEnqueueCompile).not.toHaveBeenCalled();
  });

  it("forks a REMOVE_IMAGE operation before the ACTIVE and EDITING writes", async () => {
    const operation = { id: "op-1", kind: "REMOVE_IMAGE", status: "QUEUED", classifier: {} };
    mocks.prisma.bookEditOperation.findUnique.mockResolvedValue(operation);

    await applyBookEdit(job({
      projectId: "project-1",
      operationId: "op-1",
      request: "Remove the picture on page 1",
      affectedPageIndexes: [1],
      planId: "plan-1",
      intentKind: "remove_image",
      imageLayout: { action: "remove", source: { pageIndex: 1, replaceAssetId: "asset-1" } }
    }));

    expect(mocks.applyImageLayout).toHaveBeenCalledTimes(1);
    expect(mocks.applyImageLayout.mock.calls[0]?.[1]).toBe(operation);
    expect(mocks.applyImageInsertion).not.toHaveBeenCalled();
    expect(mocks.prisma.bookEditOperation.update).not.toHaveBeenCalled();
    expect(mocks.prisma.project.update).not.toHaveBeenCalled();
    expect(mocks.prisma.page.findMany).not.toHaveBeenCalled();
  });

  it("forks a RESTRUCTURE_PAGES operation whose payload lost its structuralEdit", async () => {
    const operation = {
      id: "op-1",
      kind: "RESTRUCTURE_PAGES",
      status: "QUEUED",
      classifier: { structuralEdit: { action: "insert", anchorPageIndex: 3, pageIndexes: [], pageCount: 2 } }
    };
    mocks.prisma.bookEditOperation.findUnique.mockResolvedValue(operation);

    await applyBookEdit(job({
      projectId: "project-1",
      operationId: "op-1",
      request: "Add 2 pages after page 3",
      affectedPageIndexes: [],
      planId: "plan-1",
      intentKind: "restructure_pages"
    }));

    expect(mocks.restructurePages).toHaveBeenCalledTimes(1);
    expect(mocks.restructurePages.mock.calls[0]?.[1]).toBe(operation);
    expect(mocks.prisma.bookEditOperation.update).not.toHaveBeenCalled();
    expect(mocks.prisma.project.update).not.toHaveBeenCalled();
    expect(mocks.rewritePageForUserRequest).not.toHaveBeenCalled();
  });

  it("forks an ADD_IMAGE operation whose payload lost its imageInsertion", async () => {
    const operation = {
      id: "op-1",
      kind: "ADD_IMAGE",
      status: "QUEUED",
      classifier: { kind: "add_image", imageEdit: { subject: "a dragon", placement: "end_of_book" } }
    };
    mocks.prisma.bookEditOperation.findUnique.mockResolvedValue(operation);

    await applyBookEdit(job({
      projectId: "project-1",
      operationId: "op-1",
      request: "Add a photo of a dragon at the end of the book",
      affectedPageIndexes: [5],
      planId: "plan-1",
      intentKind: "add_image"
    }));

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

    await applyBookEdit(job({
      projectId: "project-1",
      operationId: "op-1",
      request: "Move the picture to the end of the book",
      affectedPageIndexes: [1, 9],
      planId: "plan-1",
      intentKind: "move_image"
    }));

    expect(mocks.applyImageLayout).toHaveBeenCalledTimes(1);
    expect(mocks.applyImageLayout.mock.calls[0]?.[1]).toBe(operation);
    expect(mocks.prisma.bookEditOperation.update).not.toHaveBeenCalled();
    expect(mocks.prisma.project.update).not.toHaveBeenCalled();
    expect(mocks.rewritePageForUserRequest).not.toHaveBeenCalled();
  });

  it("keeps an operation of any other kind on the text-rewrite path", async () => {
    mocks.prisma.bookEditOperation.findUnique.mockResolvedValue({ id: "op-1", kind: "PAGE_REWRITE" });
    mocks.prisma.page.findMany.mockResolvedValue([page(1, "Rabbit runs.")]);

    await applyBookEdit(job({
      projectId: "project-1",
      operationId: "op-1",
      request: "Replace rabbit with fly",
      affectedPageIndexes: [1],
      planId: "plan-1",
      exactReplacement: { from: "rabbit", to: "fly", preserveCase: true },
      mode: "exact"
    }));

    expect(mocks.restructurePages).not.toHaveBeenCalled();
    expect(mocks.publishTextEditManuscript).toHaveBeenCalledTimes(1);
  });

  it("rejects an exact payload when the durable router terms disagree", async () => {
    mocks.prisma.bookEditOperation.findUnique.mockResolvedValue({
      id: "op-1",
      kind: "LOCAL_PATCH",
      status: "QUEUED",
      request: 'Replace "Rabbit" with "Fox".',
      editInstruction: 'Replace "Rabbit" with "Fox".',
      classifier: { exactReplacement: { from: "Rabbit", to: "Hare" } },
      affectedPageIndexes: [1]
    });
    mocks.prisma.page.findMany.mockResolvedValue([page(1, "Rabbit runs.")]);

    await expect(
      applyBookEdit(job({
        projectId: "project-1",
        operationId: "op-1",
        request: 'Replace "Rabbit" with "Fox".',
        editInstruction: 'Replace "Rabbit" with "Fox".',
        affectedPageIndexes: [1],
        planId: "plan-1",
        exactReplacement: { from: "Rabbit", to: "Fox" },
        mode: "exact"
      }))
    ).rejects.toThrow(EDIT_ADHERENCE_FAILED);

    // `mode: "exact"` is a promise the API made on the strength of a preview,
    // not a hint. The one answer a refused re-derivation may not give is a
    // charged model rewrite of every named page, which is the per-page
    // regeneration that promise exists to stop.
    expect(mocks.rewritePageForUserRequest).not.toHaveBeenCalled();
    expect(mocks.publishTextEditManuscript).not.toHaveBeenCalled();
  });

  it("never forks on the payload alone", async () => {
    mocks.prisma.bookEditOperation.findUnique.mockResolvedValue({ id: "op-1", kind: "PAGE_REWRITE", classifier: {} });
    mocks.prisma.page.findMany.mockResolvedValue([page(1, "Rabbit runs.")]);

    await applyBookEdit(job({
      projectId: "project-1",
      operationId: "op-1",
      request: "Replace rabbit with fly",
      affectedPageIndexes: [1],
      planId: "plan-1",
      exactReplacement: { from: "rabbit", to: "fly", preserveCase: true },
      mode: "exact",
      imageInsertion: { subject: "a dragon", placement: "end_of_book", targetPageIndex: 5 },
      imageLayout: { action: "remove", sources: [{ pageIndex: 1, replaceAssetId: "asset-1" }] }
    }));

    expect(mocks.applyImageInsertion).not.toHaveBeenCalled();
    expect(mocks.applyImageLayout).not.toHaveBeenCalled();
    expect(mocks.publishTextEditManuscript).toHaveBeenCalledTimes(1);
  });
});
