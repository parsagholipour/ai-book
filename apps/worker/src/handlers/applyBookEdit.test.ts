import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Job } from "bullmq";

const mocks = vi.hoisted(() => {
  const project = { update: vi.fn(), updateMany: vi.fn() };
  const page = { findMany: vi.fn(), update: vi.fn() };
  const pageEditSnapshot = { findMany: vi.fn(), createManyAndReturn: vi.fn(), update: vi.fn(), deleteMany: vi.fn() };
  const continuityNote = { createMany: vi.fn() };
  return ({
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
  assertTextEditLeaseTx: vi.fn(async (_tx: unknown, _operationId: string, _ownerToken: string) => ({
    status: "ACTIVE",
    classifier: {}
  })),
  completeTextEditLease: vi.fn(async () => true),
  waitForTextEditLease: vi.fn(
    async (): Promise<
      | { outcome: "acquired"; phase: "draft" | "tail" }
      | { outcome: "completed" }
      | { outcome: "settled" }
      | { outcome: "abandoned" }
    > => ({ outcome: "acquired", phase: "draft" })
  ),
  waitForTextEditLeaseCompletion: vi.fn(async () => "completed" as const),
  heartbeatAssertHeld: vi.fn(async () => undefined),
  heartbeatStop: vi.fn(async () => undefined),
  claimAppliedEditPublication: vi.fn(async () => true),
  restoreEditProjectStatus: vi.fn(async () => true),
  keeperStoryExtractForSave: vi.fn(async (): Promise<{ storyDelta: unknown } | null> => null),
  persistStoryExtract: vi.fn(async () => null),
  reviewAppliedBookEdit: vi.fn(),
  claimDurableEditCompletionTx: vi.fn(async () => true),
  settleDurableEditAttemptTx: vi.fn(async () => true),
  publishTextEditManuscript: vi.fn(async (options: { pages: Array<{ preparedEmbedding: unknown }> }) => ({
    identity: {
      projectId: "project-1",
      operationId: "op-1",
      planVersionId: "plan-1",
      publicationRevision: 8,
      fallbackStatus: "COMPLETE"
    },
    memory: options.pages.flatMap((page) => page.preparedEmbedding ? [page] : [])
  })),
  textEditPublicationCompletion: vi.fn(() => ({
    durableCompletionCommitted: true,
    lifecycleCompletionCommitted: true,
    retryFollowUpOnRedelivery: true,
    afterJobCompleted: vi.fn()
  })),
  textEditPublicationIdentity: vi.fn(() => null),
  adoptLegacyTextEditTail: vi.fn(async () => null)
  });
});

vi.mock("@book-maker/db", () => ({
  prisma: mocks.prisma,
  Prisma: {},
  MANUSCRIPT_PUBLICATION_TRANSACTION_OPTIONS: { timeout: 30_000, maxWait: 10_000 }
}));
vi.mock("../runtime/dispatch.js", () => ({ maybeEnqueueCompile: mocks.maybeEnqueueCompile }));
vi.mock("../runtime/jobLifecycle.js", () => ({ advanceJobStep: vi.fn() }));
vi.mock("../runtime/durableEditCompletion.js", () => ({
  claimDurableEditCompletionTx: mocks.claimDurableEditCompletionTx,
  settleDurableEditAttemptTx: mocks.settleDurableEditAttemptTx
}));
vi.mock("../runtime/config.js", () => ({ config: {} }));
vi.mock("../providers/loggedAdapters.js", () => ({ createLoggedProviders: () => ({ embedding: {} }) }));
// The fixture strategy is not sequential-pages, so edits skip the embedding.
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
  isTextEditLeaseLostError: (error: unknown) => error instanceof Error && error.name === "StructuralPageLeaseLostError",
  startTextEditLeaseHeartbeat: () => ({ assertHeld: mocks.heartbeatAssertHeld, stop: mocks.heartbeatStop }),
  waitForTextEditLease: mocks.waitForTextEditLease,
  waitForTextEditLeaseCompletion: mocks.waitForTextEditLeaseCompletion
}));
vi.mock("../generation/editProjectStatus.js", () => ({ claimAppliedEditPublication: mocks.claimAppliedEditPublication, restoreEditProjectStatus: mocks.restoreEditProjectStatus }));
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
    reviewAppliedBookEdit: mocks.reviewAppliedBookEdit
  };
});

import { keeperStoryExtractForSave } from "../generation/qualityEnrichment.js";
import { loadProjectStoryState } from "../generation/storyStateStore.js";
import { applyBookEdit } from "./applyBookEdit.js";
import { StopRequestedError } from "../runtime/jobTypes.js";
import {
  PRE_EDIT_PROJECT_STATUS
} from "@book-maker/core";

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
    mocks.prisma.bookEditOperation.updateMany.mockResolvedValue({ count: 1 });
    mocks.getProjectOrThrow.mockResolvedValue({ id: "project-1", currentPlanId: "plan-1" });
    mocks.prisma.planVersion.findUnique.mockResolvedValue({ id: "plan-1", inputSnapshot: {}, planningPackage: {} });
    mocks.prisma.pageEditSnapshot.findMany.mockResolvedValue([]);
    mocks.prisma.pageEditSnapshot.createManyAndReturn.mockImplementation(
      async ({ data }: { data: Array<Record<string, unknown>> }) =>
        data.map((snapshot) => ({ ...snapshot, id: `snap-${String(snapshot.pageId)}` }))
    );
    mocks.prisma.pageEditSnapshot.update.mockResolvedValue({});
    mocks.prisma.continuityNote.createMany.mockResolvedValue({ count: 0 });
    mocks.prisma.page.update.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({
      ...data,
      revision: 2
    }));
    mocks.prisma.$transaction.mockImplementation(async (callback: (tx: typeof mocks.tx) => Promise<unknown>) =>
      callback(mocks.tx)
    );
    mocks.prisma.project.updateMany.mockResolvedValue({ count: 1 });
    mocks.tx.project.update.mockResolvedValue({ contentRevision: 8 });
    mocks.waitForTextEditLease.mockResolvedValue({ outcome: "acquired", phase: "draft" });
    mocks.waitForTextEditLeaseCompletion.mockResolvedValue("completed");
    mocks.completeTextEditLease.mockResolvedValue(true);
    mocks.assertTextEditLeaseTx.mockResolvedValue({ status: "ACTIVE", classifier: {} });
    mocks.heartbeatAssertHeld.mockResolvedValue(undefined);
    mocks.heartbeatStop.mockResolvedValue(undefined);
    mocks.keeperStoryExtractForSave.mockResolvedValue(null);
    mocks.persistStoryExtract.mockResolvedValue(null);
    mocks.claimAppliedEditPublication.mockResolvedValue(true);
    mocks.restoreEditProjectStatus.mockResolvedValue(true);
    mocks.reviewAppliedBookEdit.mockReset().mockResolvedValue({
      basis: "reviewed",
      satisfied: true,
      confidence: 1,
      missingRequirements: [],
      contradictions: [],
      pageIndexesToRevise: []
    });
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
    expect(mocks.publishTextEditManuscript).toHaveBeenCalledTimes(1);
    const published = mocks.publishTextEditManuscript.mock.calls[0]?.[0] as unknown as {
      pages: Array<{ markdownAfter: string }>;
    };
    expect(published.pages.map((entry) => entry.markdownAfter)).toEqual(["Fly runs.", "Fly rests."]);
    expect(mocks.textEditPublicationCompletion).toHaveBeenCalledTimes(1);
    expect(loadProjectStoryState).toHaveBeenCalledTimes(1);
  });

  it("bulk-snapshots and publishes 120 pages atomically under the manuscript transaction budget", async () => {
    const pageCount = 120;
    const pages = Array.from({ length: pageCount }, (_, offset) => page(offset + 1, `Original ${offset + 1}.`));
    mocks.prisma.page.findMany.mockResolvedValue(pages);
    mocks.rewritePageForUserRequest.mockResolvedValue({
      title: "Rewritten page",
      markdown: "Rewritten prose.",
      summary: "Rewritten summary.",
      continuityNotes: ["Keep this detail."],
      qualityReport: { approved: true }
    });
    await applyBookEdit(
      job({
        projectId: "project-1",
        operationId: "op-1",
        generationJobId: "generation-job-1",
        request: "Rewrite the whole book.",
        affectedPageIndexes: pages.map(({ index }) => index),
        planId: "plan-1"
      })
    );

    expect(mocks.publishTextEditManuscript).toHaveBeenCalledTimes(1);
    const publication = mocks.publishTextEditManuscript.mock.calls[0]?.[0] as unknown as {
      pages: Array<{ continuityNotes: string[]; statusAfter: string }>;
    };
    expect(publication.pages).toHaveLength(pageCount);
    expect(publication.pages.every((entry) => entry.continuityNotes.length === 1)).toBe(true);
    // The publisher writes whatever verdict it is handed, so the handler is
    // what has to carry the rewrite loop's own answer for each page.
    expect(publication.pages.every((entry) => entry.statusAfter === "COMPLETED")).toBe(true);
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
    expect(mocks.publishTextEditManuscript).toHaveBeenCalledWith(
      expect.objectContaining({ skippedPageIndexes: [2], pages: [expect.objectContaining({ pageIndex: 1 })] })
    );
    expect(keeperStoryExtractForSave).toHaveBeenCalledTimes(1);
    expect(keeperStoryExtractForSave).toHaveBeenCalledWith(expect.objectContaining({ pageIndex: 1 }));
    // The queued reply promised page 2, so the operation records the skip for
    // the serializer to surface — silence here left the transcript claiming an
    // edit that never happened.
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
    expect(mocks.publishTextEditManuscript).toHaveBeenCalledTimes(1);
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
    expect(mocks.publishTextEditManuscript).toHaveBeenCalledWith(
      expect.objectContaining({ pages: [expect.objectContaining({ titleAfter: "Fly Learns" })] })
    );
  });

  it("returns a replayable publication tail for the repair lane", async () => {
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
        mode: "exact",
        [PRE_EDIT_PROJECT_STATUS]: "REVIEW_REQUIRED"
      })
    );

    expect(mocks.publishTextEditManuscript).toHaveBeenCalledWith(
      expect.objectContaining({ fallbackStatus: "REVIEW_REQUIRED" })
    );
    expect(mocks.textEditPublicationCompletion).toHaveBeenCalledTimes(1);
  });

  it("defers export enqueue failures to the replayable completion tail", async () => {
    mocks.prisma.page.findMany.mockResolvedValue([page(1, "Rabbit runs.")]);
    mocks.maybeEnqueueCompile.mockRejectedValue(new Error("queue unavailable"));
    await expect(
      applyBookEdit(
        job({
          projectId: "project-1",
          operationId: "op-1",
          request: "Replace rabbit with fly",
          affectedPageIndexes: [1],
          planId: "plan-1",
          exactReplacement: { from: "rabbit", to: "fly", preserveCase: true },
          mode: "exact",
          [PRE_EDIT_PROJECT_STATUS]: "REVIEW_REQUIRED"
        })
      )
    ).resolves.toMatchObject({
      durableCompletionCommitted: true,
      lifecycleCompletionCommitted: true,
      retryFollowUpOnRedelivery: true
    });
    expect(mocks.maybeEnqueueCompile).not.toHaveBeenCalled();
  });

  it.each(["compile", "waiting"])("leaves the project EDITING while a %s compile handoff is on its way", async (outcome) => {
    mocks.prisma.page.findMany.mockResolvedValue([page(1, "Rabbit runs.")]);
    mocks.maybeEnqueueCompile.mockResolvedValue(outcome);

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
    expect(mocks.publishTextEditManuscript).toHaveBeenCalledTimes(1);
    expect(keeperStoryExtractForSave).toHaveBeenCalledWith(
      expect.objectContaining({
        pageIndex: 1,
        previousExtract: null,
        keeperWasRevised: true,
        draft: expect.objectContaining({ markdown: "Rewritten." })
      })
    );
  });

  it("keeps the durable edit instruction authoritative over a stale queue payload", async () => {
    mocks.prisma.bookEditOperation.findUnique.mockResolvedValue({
      id: "op-1",
      editInstruction: "Use the approved durable instruction."
    });
    mocks.prisma.page.findMany.mockResolvedValue([page(1, "Original.")]);
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
        request: "Legacy request.",
        editInstruction: "Stale queue instruction.",
        affectedPageIndexes: [1],
        planId: "plan-1"
      })
    );

    expect(mocks.rewritePageForUserRequest).toHaveBeenCalledWith(
      expect.objectContaining({ request: "Use the approved durable instruction." })
    );
  });

  it("uses the queue instruction for a legacy operation with a blank durable value", async () => {
    mocks.prisma.bookEditOperation.findUnique.mockResolvedValue({ id: "op-1", editInstruction: "   " });
    mocks.prisma.page.findMany.mockResolvedValue([page(1, "Original.")]);
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
        request: "Old request fallback.",
        editInstruction: "Recovered queue instruction.",
        affectedPageIndexes: [1],
        planId: "plan-1"
      })
    );

    expect(mocks.rewritePageForUserRequest).toHaveBeenCalledWith(
      expect.objectContaining({ request: "Recovered queue instruction." })
    );
  });

  it("reads the operator's quality gates once for the whole edit", async () => {
    // `rewritePageForUserRequest` loaded its own per page and
    // `persistKeeperStoryDelta` loaded another behind it, so a three-page edit
    // spent six reads — and a Quality-tab save landing between two of them ran
    // the first pages of one edit under one gate configuration and the rest
    // under another, which is the split a compile already fixed by hoisting one
    // context above its passes.
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
        request: "Make it funnier",
        affectedPageIndexes: [1, 2, 3],
        planId: "plan-1"
      })
    );

    expect(mocks.loadQualityContext).toHaveBeenCalledTimes(1);
    const quality = await mocks.loadQualityContext.mock.results[0]!.value;
    const handedTo = [
      ...mocks.rewritePageForUserRequest.mock.calls.map((call) => call[0].quality),
      ...vi.mocked(keeperStoryExtractForSave).mock.calls.map((call) => (call[0] as { quality?: unknown }).quality)
    ];
    expect(handedTo).toHaveLength(6);
    for (const handed of handedTo) {
      expect(handed).toBe(quality);
    }
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

    expect(mocks.publishTextEditManuscript).toHaveBeenCalledWith(
      expect.objectContaining({
        pages: [expect.objectContaining({
          pageId: "page-1",
          markdownBefore: "Rabbit runs.",
          storyDeltaBefore
        })]
      })
    );
    expect(keeperStoryExtractForSave).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: "project-1",
        pageIndex: 1,
        previousExtract: null,
        keeperWasRevised: true,
        draft: expect.objectContaining({ markdown: "Fly runs." })
      })
    );
  });

  it("re-derives the published story state instead of folding onto the stored aggregate", async () => {
    const delta = (factsAdded: string[]) => ({
      promisesOpened: [],
      promisesPaid: [],
      promisesBroken: [],
      factsAdded,
      entities: {},
      unansweredAdded: [],
      unansweredResolved: []
    });
    // Page 2 is where the lantern fact was established, so the stored
    // aggregate carries it alongside page 1's.
    vi.mocked(loadProjectStoryState).mockResolvedValueOnce({
      promises: [],
      facts: [
        { text: "Rain fell.", pageIndex: 1 },
        { text: "The lantern is broken.", pageIndex: 2 }
      ],
      entities: {},
      unanswered: []
    });
    mocks.prisma.page.findMany.mockImplementation(async (args: { select?: unknown }) =>
      args.select
        ? [
            { index: 1, storyDelta: delta(["Rain fell."]) },
            { index: 2, storyDelta: delta(["The lantern is broken."]) }
          ]
        : [{ ...page(2, "The lantern is broken."), storyDelta: delta(["The lantern is broken."]) }]
    );
    mocks.rewritePageForUserRequest.mockResolvedValue({
      title: "Page 2",
      markdown: "The lantern is lit.",
      summary: "Summary.",
      continuityNotes: [],
      qualityReport: { approved: true }
    });
    // The edit takes the sentence out, so page 2's new extract no longer states it.
    mocks.keeperStoryExtractForSave.mockResolvedValue({ storyDelta: delta([]) });

    await applyBookEdit(
      job({
        projectId: "project-1",
        operationId: "op-1",
        request: "The lantern is not broken any more",
        affectedPageIndexes: [2],
        planId: "plan-1"
      })
    );

    const published = mocks.publishTextEditManuscript.mock.calls[0]?.[0] as unknown as {
      storyStateAfter: { facts: Array<{ text: string }> };
      pages: Array<{ storyDeltaAfter: unknown }>;
    };
    expect(published.pages[0]?.storyDeltaAfter).toEqual(delta([]));
    // Page 1's fact survives because its own delta still states it. Page 2's
    // does not, because the page the reader edited no longer does — a fold over
    // the loaded aggregate can only ever add, so it would keep both.
    expect(published.storyStateAfter.facts.map((fact) => fact.text)).toEqual(["Rain fell."]);
  });

  it("keeps every original page and export when a later candidate fails", async () => {
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

    expect(mocks.prisma.page.update).not.toHaveBeenCalled();
    expect(mocks.prisma.pageEditSnapshot.createManyAndReturn).not.toHaveBeenCalled();
    expect(mocks.invalidateProjectExports).not.toHaveBeenCalled();
    expect(mocks.maybeEnqueueCompile).not.toHaveBeenCalled();
  });

  it("still rethrows a mid-edit stop without publishing any candidate", async () => {
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

    expect(mocks.prisma.page.update).not.toHaveBeenCalled();
    expect(mocks.prisma.pageEditSnapshot.createManyAndReturn).not.toHaveBeenCalled();
    expect(mocks.invalidateProjectExports).not.toHaveBeenCalled();
    expect(mocks.maybeEnqueueCompile).not.toHaveBeenCalled();
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

    // Page QA still buys the repair rounds, and the audit still records that it
    // never passed. What it may not do is fail the edit: the gate is adherence
    // only, so the page publishes flagged for the next compile's repair pass
    // instead of a whole rewrite being discarded and refunded over one page.
    expect(mocks.rewritePageForUserRequest).toHaveBeenCalledTimes(3);
    expect(mocks.publishTextEditManuscript).toHaveBeenCalledWith(
      expect.objectContaining({
        audit: expect.objectContaining({ proseApproved: false }),
        pages: [expect.objectContaining({ markdownAfter: "Rewritten.", statusAfter: "FAILED_QA" })]
      })
    );
  });

  it("publishes a text edit when the adherence review never ran", async () => {
    mocks.prisma.page.findMany.mockResolvedValue([page(1, "Original prose.")]);
    mocks.rewritePageForUserRequest.mockResolvedValue({
      title: "Page 1",
      markdown: "Rewritten prose.",
      summary: "Summary.",
      continuityNotes: [],
      qualityReport: { approved: true, score: 90 }
    });
    mocks.reviewAppliedBookEdit.mockResolvedValue({
      basis: "unverified",
      satisfied: false,
      confidence: 0,
      missingRequirements: ["The complete edit could not be verified against the approved instruction."],
      contradictions: [],
      pageIndexesToRevise: [1]
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

    expect(mocks.reviewAppliedBookEdit).toHaveBeenCalledTimes(3);
    expect(mocks.rewritePageForUserRequest).toHaveBeenCalledTimes(1);
    expect(mocks.publishTextEditManuscript).toHaveBeenCalledWith(
      expect.objectContaining({
        audit: expect.objectContaining({
          attempts: 3,
          verdict: expect.objectContaining({ basis: "unverified", satisfied: false })
        }),
        pages: [expect.objectContaining({ markdownAfter: "Rewritten prose." })]
      })
    );
  });

});
