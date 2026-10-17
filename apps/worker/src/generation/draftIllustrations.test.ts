import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BookGenerationStrategy, BookPlan, CreateProjectInput } from "@book-maker/core";

const mocks = vi.hoisted(() => ({
  prisma: { page: { findMany: vi.fn(), updateMany: vi.fn() }, continuityNote: { createMany: vi.fn() }, $transaction: vi.fn() },
  enqueueWorkerJob: vi.fn()
}));
vi.mock("@book-maker/db", async () => ({
  prisma: mocks.prisma,
  Prisma: {},
  ...(await import("../testing/dbScopeMocks.js")).dbScopeMocks()
}));
vi.mock("../runtime/dispatch.js", () => ({ enqueueWorkerJob: mocks.enqueueWorkerJob }));

import { enqueueDraftPageIllustrations } from "./draftIllustrations.js";
import { publishStagedGeneratedPage } from "./pagePublication.js";

/** A PENDING row exactly as `checkpointWholeBookDraftPages` writes it: revision 1, the draft's own fields. */
const row = (index: number, imagePrompt: string | null = `Scene ${index}`) => ({
  id: `page-${index}`, index, title: `Page ${index}`, markdown: `Page ${index} text.`, summary: `Summary ${index}.`, imagePrompt, revision: 1
});
const draft = (index: number) => ({ index, markdown: `Page ${index} text.`, imagePrompt: `Scene ${index}` });

function options(overrides: Partial<Parameters<typeof enqueueDraftPageIllustrations>[0]> = {}) {
  return {
    projectId: "project-1",
    planId: "plan-1",
    input: { targetPages: 4, mediaSettings: {} } as unknown as CreateProjectInput,
    plan: { chapters: [] } as unknown as BookPlan,
    strategy: { shouldIllustratePage: vi.fn(() => true) } as unknown as BookGenerationStrategy,
    pages: [1, 2, 3, 4].map(draft),
    ...overrides
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.prisma.page.findMany.mockImplementation(async ({ where }: { where: { index: { in: number[] } } }) =>
    where.index.in.map((index) => row(index)));
  mocks.enqueueWorkerJob.mockImplementation(async ({ dedupeKey }: { dedupeKey: string }) => ({ id: dedupeKey }));
  mocks.prisma.page.updateMany.mockResolvedValue({ count: 1 });
});

describe("enqueueDraftPageIllustrations", () => {
  it("queues every illustrated page's picture from its PENDING row, in page order", async () => {
    expect(await enqueueDraftPageIllustrations(options())).toBe(4);
    expect(mocks.prisma.page.findMany.mock.calls[0]![0]).toMatchObject({
      where: { projectId: "project-1", status: "PENDING", index: { in: [1, 2, 3, 4] } }, orderBy: { index: "asc" }
    });
    expect(mocks.enqueueWorkerJob.mock.calls.map(([job]) => job.payload.pageId)).toEqual(["page-1", "page-2", "page-3", "page-4"]);
    expect(mocks.enqueueWorkerJob.mock.calls[0]![0]).toEqual({
      projectId: "project-1",
      type: "GENERATE_IMAGE",
      payload: { pageId: "page-1", planId: "plan-1", prompt: "Scene 1", keeperToken: expect.stringMatching(/^v2-[0-9a-f]{24}$/) },
      dedupeKey: expect.stringMatching(/^generate-image:page-1:plan-1:1:v2-[0-9a-f]{24}$/)
    });
  });

  it("lands on the very job an unchanged page's publication queues, and on a new one when the keeper changed", async () => {
    await enqueueDraftPageIllustrations(options({ pages: [draft(1)] }));
    const early = mocks.enqueueWorkerJob.mock.calls[0]![0];
    const { id, revision, imagePrompt, ...fields } = row(1);
    const publish = (markdown: string) => publishStagedGeneratedPage({
      projectId: "project-1", planId: "plan-1", pageIndex: 1, draft: { ...fields, markdown, imagePrompt: imagePrompt!, continuityNotes: [] },
      stagedPage: { id, revision, updatedAt: new Date(1_000) }, willIllustrate: true, continuityTags: []
    });

    await publish(fields.markdown);
    expect(mocks.enqueueWorkerJob.mock.calls[1]![0]).toEqual(early);
    await publish("Page 1 text, polished.");
    const replacement = mocks.enqueueWorkerJob.mock.calls[2]![0];
    expect(replacement.dedupeKey).not.toBe(early.dedupeKey);
    expect(replacement.payload.keeperToken).not.toBe(early.payload.keeperToken);
  });

  it("reads nothing when no page will be illustrated from its draft", async () => {
    const strategy = { shouldIllustratePage: vi.fn((_input: unknown, _plan: unknown, index: number) => index === 2) };
    expect(await enqueueDraftPageIllustrations(options({
      strategy: strategy as unknown as BookGenerationStrategy, pages: [draft(1), { index: 2, markdown: "Page 2 text." }, draft(3)]
    }))).toBe(0);
    expect(mocks.prisma.page.findMany).not.toHaveBeenCalled();
    expect(mocks.enqueueWorkerJob).not.toHaveBeenCalled();
  });

  it("draws every illustrated page from its draft when the book asked for a final review, since no model reads a page first", async () => {
    // E4 (2026-10-16): no grouped review, and no page-time model review, on a short book. A page the
    // compile's final review later repairs gets a new keeper token and its own picture.
    const input = { targetPages: 4, mediaSettings: { finalReview: true } } as unknown as CreateProjectInput;
    expect(await enqueueDraftPageIllustrations(options({ input }))).toBe(4);
    expect(mocks.enqueueWorkerJob.mock.calls.map(([job]) => job.payload.pageId)).toEqual(["page-1", "page-2", "page-3", "page-4"]);
  });

  it("skips a row that has left PENDING or lost its prompt since the draft was read", async () => {
    mocks.prisma.page.findMany.mockResolvedValue([row(1), row(3, "   ")]);
    expect(await enqueueDraftPageIllustrations(options())).toBe(1);
    expect(mocks.enqueueWorkerJob).toHaveBeenCalledTimes(1);
  });

  it("stops at a project that declines work and survives a page whose enqueue throws", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    mocks.enqueueWorkerJob
      .mockRejectedValueOnce(new Error("generation job store unavailable"))
      .mockResolvedValueOnce({ id: "image-2" })
      .mockResolvedValueOnce(undefined);
    expect(await enqueueDraftPageIllustrations(options())).toBe(1);
    expect(mocks.enqueueWorkerJob).toHaveBeenCalledTimes(3);
    expect(warn).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ warning: "draft_illustration_enqueue_failed", pageIndex: 1 }));
    warn.mockRestore();
  });
});
