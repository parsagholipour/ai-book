import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  prisma: {
    project: { findUnique: vi.fn() },
    page: { findMany: vi.fn() }
  },
  enqueueWorkerJob: vi.fn()
}));

vi.mock("@book-maker/db", () => ({ prisma: mocks.prisma }));
vi.mock("../runtime/dispatch.js", () => ({ enqueueWorkerJob: mocks.enqueueWorkerJob }));

import { enqueueRevisionOwnedReplanIllustrations } from "./replanPageIllustrationDispatch.js";

const pages = [1, 2, 3].map((index) => ({
  id: `page-${index}`,
  index,
  title: `Page ${index}`,
  markdown: `Prose ${index}.`,
  summary: `Summary ${index}.`,
  // Page 2 was drafted with no picture in mind, so it is not an illustrated
  // page and must not acquire an image dependency the compile then waits on.
  imagePrompt: index === 2 ? null : `Draw page ${index}.`,
  revision: 3
}));

function options(
  overrides: {
    illustrates?: (pageIndex: number) => boolean;
    assertLease?: () => Promise<void>;
  } = {}
) {
  return {
    projectId: "project-1",
    planVersionId: "plan-new",
    publicationRevision: 7,
    input: {} as never,
    plan: {} as never,
    strategy: {
      shouldIllustratePage: (_input: never, _plan: never, pageIndex: number) =>
        (overrides.illustrates ?? (() => true))(pageIndex)
    } as never,
    ...(overrides.assertLease ? { assertLease: overrides.assertLease } : {})
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.prisma.project.findUnique.mockResolvedValue({
    currentPlanId: "plan-new",
    contentRevision: 7,
    status: "EDITING"
  });
  mocks.prisma.page.findMany.mockResolvedValue(pages);
  mocks.enqueueWorkerJob.mockResolvedValue({ id: "image-job" });
});

describe("enqueueRevisionOwnedReplanIllustrations", () => {
  it("queues one keeper-tokened image job per illustrated page of the published manuscript", async () => {
    expect(await enqueueRevisionOwnedReplanIllustrations(options())).toBe(2);

    expect(mocks.enqueueWorkerJob).toHaveBeenCalledTimes(2);
    expect(mocks.enqueueWorkerJob).toHaveBeenNthCalledWith(1, {
      projectId: "project-1",
      type: "GENERATE_IMAGE",
      payload: {
        pageId: "page-1",
        planId: "plan-new",
        prompt: "Draw page 1.",
        keeperToken: expect.stringMatching(/^v2-[0-9a-f]{24}$/),
        contentRevision: 7,
        exportPublicationProjectStatus: "EDITING"
      },
      dedupeKey: expect.stringMatching(/^generate-image:page-1:plan-new:3:v2-[0-9a-f]{24}$/),
      contentRevision: 7
    });
    expect(mocks.enqueueWorkerJob.mock.calls.map(([job]) => job.payload.pageId)).toEqual(["page-1", "page-3"]);
  });

  /**
   * The docstring claims parity with `maybeEnqueueRevisionOwnedReplanCover`, and
   * the two `GENERATE_IMAGE` arms of `staleGenerationTargetReason` are the only
   * thing that makes the claim true past the dispatch instant. Both are keyed on
   * a non-null `exportPublicationProjectStatus`, and the revision one reads the
   * durable row's column rather than the payload — so the payload flag alone
   * arms neither.
   */
  it("arms both stale-guard arms the way the cover's durable fence does", async () => {
    await enqueueRevisionOwnedReplanIllustrations(options());

    for (const [job] of mocks.enqueueWorkerJob.mock.calls) {
      // The payload half: what `exportPublicationProjectStatusFromPayload` reads.
      expect(job.payload).toMatchObject({ exportPublicationProjectStatus: "EDITING", contentRevision: 7 });
      // The row half: what `GenerationJob.contentRevision` is written from.
      expect(job.contentRevision).toBe(7);
    }
  });

  it("asks the delivery's lease before each page, so a long fan-out hands over", async () => {
    const assertLease = vi.fn(async () => undefined);

    await enqueueRevisionOwnedReplanIllustrations(options({ assertLease }));

    expect(assertLease).toHaveBeenCalledTimes(2);
    expect(assertLease.mock.invocationCallOrder[0]!).toBeLessThan(
      mocks.enqueueWorkerJob.mock.invocationCallOrder[0]!
    );
  });

  it("stops at a declined enqueue instead of counting pages nothing will draw", async () => {
    // `enqueueWorkerJob` answers undefined only for a project that is gone or
    // FAILED, which stays true for every page behind this one.
    mocks.enqueueWorkerJob.mockResolvedValueOnce({ id: "image-job" }).mockResolvedValueOnce(undefined);

    expect(await enqueueRevisionOwnedReplanIllustrations(options())).toBe(1);

    expect(mocks.enqueueWorkerJob).toHaveBeenCalledTimes(2);
  });

  it("keeps the strategy's own illustration cadence as the gate", async () => {
    expect(await enqueueRevisionOwnedReplanIllustrations(options({ illustrates: (index) => index === 3 }))).toBe(1);

    expect(mocks.enqueueWorkerJob.mock.calls.map(([job]) => job.payload.pageId)).toEqual(["page-3"]);
  });

  it("replays to the same durable jobs, so a redelivered tail draws nothing twice", async () => {
    await enqueueRevisionOwnedReplanIllustrations(options());
    const first = mocks.enqueueWorkerJob.mock.calls.map(([job]) => job.dedupeKey);
    mocks.enqueueWorkerJob.mockClear();

    await enqueueRevisionOwnedReplanIllustrations(options());

    expect(mocks.enqueueWorkerJob.mock.calls.map(([job]) => job.dedupeKey)).toEqual(first);
  });

  it.each([
    { label: "plan", project: { currentPlanId: "plan-other", contentRevision: 7, status: "EDITING" } },
    { label: "revision", project: { currentPlanId: "plan-new", contentRevision: 8, status: "EDITING" } },
    { label: "status", project: { currentPlanId: "plan-new", contentRevision: 7, status: "COMPLETE" } },
    { label: "project", project: null }
  ])("queues nothing once the published $label has moved on", async ({ project }) => {
    mocks.prisma.project.findUnique.mockResolvedValue(project);

    expect(await enqueueRevisionOwnedReplanIllustrations(options())).toBe(0);

    expect(mocks.prisma.page.findMany).not.toHaveBeenCalled();
    expect(mocks.enqueueWorkerJob).not.toHaveBeenCalled();
  });
});
