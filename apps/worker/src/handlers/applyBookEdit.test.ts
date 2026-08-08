import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Job } from "bullmq";

const mocks = vi.hoisted(() => ({
  prisma: {
    bookEditOperation: { findUnique: vi.fn(), update: vi.fn() },
    project: { update: vi.fn() },
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
vi.mock("../generation/semanticMemory.js", () => ({ storeEmbedding: mocks.storeEmbedding }));
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

  it("still falls back to a rewrite when no exact mode was promised", async () => {
    mocks.prisma.page.findMany.mockResolvedValue([page(1, "Nothing to see here.")]);
    mocks.rewritePageForUserRequest.mockResolvedValue({
      title: "Page 1",
      markdown: "Rewritten.",
      summary: "Summary.",
      continuityNotes: [],
      qualityReport: {}
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
    expect(mocks.maybeEnqueueCompile).toHaveBeenCalledWith("project-1", "plan-1", { skipFinalReview: false });
  });
});
