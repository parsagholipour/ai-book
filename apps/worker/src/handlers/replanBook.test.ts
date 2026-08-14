import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Job } from "bullmq";

const mocks = vi.hoisted(() => ({
  prisma: {
    bookEditOperation: { update: vi.fn() },
    project: { update: vi.fn(), findUnique: vi.fn() },
    planVersion: { findUnique: vi.fn(), create: vi.fn(), update: vi.fn(), updateMany: vi.fn() },
    character: { deleteMany: vi.fn(), createMany: vi.fn() },
    location: { deleteMany: vi.fn(), createMany: vi.fn() },
    researchSource: { deleteMany: vi.fn(), createMany: vi.fn() },
    $transaction: vi.fn()
  },
  revisePlan: vi.fn(),
  enqueueWorkerJob: vi.fn(),
  nextPlanVersion: vi.fn()
}));

vi.mock("@book-maker/db", () => ({ prisma: mocks.prisma, Prisma: {} }));
vi.mock("../runtime/dispatch.js", () => ({ enqueueWorkerJob: mocks.enqueueWorkerJob }));
vi.mock("../runtime/jobLifecycle.js", () => ({ advanceJobStep: vi.fn() }));
vi.mock("../runtime/config.js", () => ({ config: {} }));
vi.mock("../providers/loggedAdapters.js", () => ({ createLoggedProviders: () => ({ text: {} }) }));
vi.mock("../generation/bookHelpers.js", () => ({
  getProjectOrThrow: async (id: string) => ({ id, currentPlanId: "plan-1", targetPages: 12 }),
  invalidateProjectExports: vi.fn(),
  nextPlanVersion: mocks.nextPlanVersion,
  parseChapterBrief: () => null,
  planInputSnapshot: (input: { targetPages: number }) => ({ targetPages: input.targetPages }),
  // The real deep clone, not a stub: the mediaSettings write-back is exactly
  // what these tests exist to observe.
  planMediaSettingsSnapshot: (input: { mediaSettings: unknown }) => JSON.parse(JSON.stringify(input.mediaSettings)),
  strategyForInput: () => ({ revisePlan: mocks.revisePlan }),
  toPriorPageContext: (page: unknown) => page
}));
vi.mock("../generation/storyStateStore.js", () => ({
  seedProjectStoryState: vi.fn()
}));
vi.mock("@book-maker/core", async () => {
  const actual = await vi.importActual<typeof import("@book-maker/core")>("@book-maker/core");
  return { ...actual, bookPlanSchema: { parse: () => ({ chapters: [] }) }, createProviders: () => ({}) };
});

import { seedProjectStoryState } from "../generation/storyStateStore.js";
import { replanBook } from "./replanBook.js";

const sourceSnapshot = {
  prompt: "A guide to budget shops with enough detail to parse correctly.",
  category: "BUSINESS",
  targetPages: 12,
  complexity: 5,
  temperature: 0.7,
  language: "en",
  mediaSettings: {
    fullIllustrations: true,
    illustrationCadence: "template-driven",
    includeCover: true,
    coverTemplate: "auto",
    finalReview: true,
    toneProfile: "neutral",
    mobile: { targetPages: 12, imagesEnabled: true }
  }
};

function replanJob(payload: Record<string, unknown>): Job {
  return {
    data: {
      projectId: "project-copy",
      operationId: "operation-1",
      request: "make it 3 pages",
      sourceProjectId: "project-1",
      sourcePlanId: "plan-1",
      ...payload
    }
  } as unknown as Job;
}

describe("replanBook page budget", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.prisma.planVersion.findUnique.mockResolvedValue({
      id: "plan-1",
      inputSnapshot: sourceSnapshot,
      planningPackage: {},
      messages: []
    });
    mocks.prisma.$transaction.mockImplementation(async (run: (tx: unknown) => Promise<void>) => {
      await run({
        planVersion: {
          updateMany: vi.fn(),
          update: vi.fn(),
          create: async () => ({ id: "plan-2" })
        },
        project: { update: mocks.prisma.project.update, findUnique: mocks.prisma.project.findUnique },
        character: mocks.prisma.character,
        location: mocks.prisma.location,
        researchSource: mocks.prisma.researchSource
      });
    });
    mocks.prisma.project.findUnique.mockResolvedValue({ mediaSettings: null });
    mocks.nextPlanVersion.mockResolvedValue(2);
    mocks.revisePlan.mockResolvedValue({ title: "Revised", chapters: [], characters: [], locations: [], researchNotes: [] });
    mocks.enqueueWorkerJob.mockResolvedValue({ id: "job-generate" });
  });
  afterEach(() => vi.clearAllMocks());

  it("plans against the requested page count rather than the source book's", async () => {
    await replanBook(replanJob({ targetPages: 3 }));

    // The plan is revised from the *source* book's input snapshot, which still
    // says 12. Left to it, the planner is instructed to hit 12 and
    // normalizePlanPageTargets pads the revised chapters back up to it — which
    // is how a three-chapter plan came out as an eight-page book.
    expect(mocks.revisePlan).toHaveBeenCalledWith(expect.objectContaining({ targetPages: 3 }));
    expect(seedProjectStoryState).toHaveBeenCalledWith("project-copy", []);
    // The row and the snapshot the next edit reads have to agree.
    expect(mocks.prisma.project.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ targetPages: 3 }) })
    );
  });

  it("keeps the source plan's page count when the replan named no length", async () => {
    await replanBook(replanJob({}));

    expect(mocks.revisePlan).toHaveBeenCalledWith(expect.objectContaining({ targetPages: 12 }));
  });

  const writtenMediaSettings = () =>
    mocks.prisma.project.update.mock.calls
      .map((call) => (call[0] as { data: Record<string, unknown> }).data.mediaSettings)
      .find((value) => value !== undefined) as Record<string, unknown>;

  it("writes the resize into the mobile metadata the app's settings sheet reads", async () => {
    await replanBook(replanJob({ targetPages: 3 }));

    expect(writtenMediaSettings().mobile).toMatchObject({ targetPages: 3, lengthPreset: "custom", pageCountMode: "custom" });
  });

  it("merges over the live row instead of replacing it", async () => {
    // The target row owns presentation preferences the plan snapshot has
    // schema-stripped, and — for a replan copy — its provenance markers.
    mocks.prisma.project.findUnique.mockResolvedValue({
      mediaSettings: {
        chapterHeadingStyle: "title_only",
        chapterHeadingLabel: "Part",
        includeSources: false,
        mobile: { revisionOfProjectId: "project-1", targetPages: 3 }
      }
    });

    await replanBook(replanJob({ targetPages: 3 }));

    const written = writtenMediaSettings();
    expect(written).toMatchObject({
      chapterHeadingStyle: "title_only",
      chapterHeadingLabel: "Part",
      includeSources: false,
      // The snapshot's generation settings still land.
      fullIllustrations: true
    });
    expect(written.mobile).toMatchObject({ revisionOfProjectId: "project-1", targetPages: 3 });
  });
});
