import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  class KnownRequestError extends Error {
    code = "P2002";
  }
  return {
    KnownRequestError,
    currentJob: null as Record<string, unknown> | null,
    recoveryJobs: [] as Record<string, unknown>[],
    editOperations: [] as Record<string, unknown>[],
    queueAdd: vi.fn(),
    queueGetJob: vi.fn(),
    prisma: {
      $queryRawUnsafe: vi.fn(),
      project: { findUnique: vi.fn(), findMany: vi.fn() },
      planVersion: { findUnique: vi.fn() },
      page: { findMany: vi.fn() },
      imageAsset: { count: vi.fn() },
      generationJob: {
        findUnique: vi.fn(),
        findFirst: vi.fn(),
        findMany: vi.fn(),
        create: vi.fn(),
        update: vi.fn(),
        count: vi.fn()
      },
      bookEditOperation: { findFirst: vi.fn() }
    }
  };
});

vi.mock("@book-maker/db", () => ({
  prisma: mocks.prisma,
  Prisma: { PrismaClientKnownRequestError: mocks.KnownRequestError }
}));
vi.mock("./queue.js", () => ({ queue: { add: mocks.queueAdd, getJob: mocks.queueGetJob } }));
vi.mock("./config.js", () => ({ config: { MAX_PARALLEL_PAGE_JOBS: 3 } }));
vi.mock("../generation/projectInput.js", () => ({ inputForPlanVersion: () => projectInput }));

import { reconcileStrandedGeneration } from "./dispatch.js";
import { compilePublicationDedupeKey, compilePublicationPolicyFromPayload } from "@book-maker/core";
import { createHash } from "node:crypto";

const projectInput = {
  prompt: "A detailed field guide to backyard birds.",
  category: "SCIENCE",
  targetPages: 2,
  complexity: 5,
  temperature: 0.8,
  language: "en",
  mediaSettings: {
    fullIllustrations: true,
    illustrationCadence: "template-driven",
    includeCover: true,
    coverTemplate: "auto",
    finalReview: true,
    toneProfile: "neutral"
  }
};

const pages = [
  { id: "page-1", index: 1, status: "COMPLETED", markdown: "One.", revision: 2 },
  { id: "page-2", index: 2, status: "COMPLETED", markdown: "Two.", revision: 1 }
];

beforeEach(() => {
  vi.clearAllMocks();
  mocks.currentJob = null;
  mocks.recoveryJobs = [];
  mocks.editOperations = [];
  mocks.prisma.$queryRawUnsafe.mockResolvedValue([]);
  mocks.prisma.project.findMany.mockResolvedValue([]);
  mocks.prisma.project.findUnique.mockResolvedValue({ status: "GENERATING", contentRevision: 4 });
  mocks.prisma.planVersion.findUnique.mockResolvedValue({ id: "plan-1", inputSnapshot: {} });
  mocks.prisma.page.findMany.mockResolvedValue(pages);
  mocks.prisma.imageAsset.count.mockResolvedValue(1);
  mocks.prisma.generationJob.count.mockResolvedValue(0);
  mocks.prisma.generationJob.findUnique.mockImplementation(async ({ where }: { where: Record<string, unknown> }) =>
    where.id ? mocks.currentJob : null
  );
  mocks.prisma.generationJob.findFirst.mockResolvedValue(null);
  mocks.prisma.generationJob.findMany.mockImplementation(
    async ({ where }: { where: { status?: unknown } }) => where.status ? [] : mocks.recoveryJobs
  );
  mocks.prisma.bookEditOperation.findFirst.mockImplementation(
    async ({ where }: {
      where: {
        status?: string | { in: string[] };
        appliedAt?: { gt?: Date; gte?: Date };
        createdAt?: { gt?: Date; gte?: Date };
        generationJob?: { projectId: string };
      }
    }) => {
      // The forked-publication lane asks for an operation filed against another
      // project whose successor job is on this one — a replan copy. Every
      // fixture here is a same-project edit, so it must answer nothing.
      if (where.generationJob) return null;
      const threshold = where.appliedAt?.gt ?? where.appliedAt?.gte ?? where.createdAt?.gt ?? where.createdAt?.gte;
      const boundary = threshold?.getTime() ?? Number.NEGATIVE_INFINITY;
      const inclusive = where.appliedAt?.gte !== undefined || where.createdAt?.gte !== undefined;
      const statuses = typeof where.status === "string" ? [where.status] : where.status?.in ?? [];
      return mocks.editOperations.find((operation) =>
        statuses.includes(operation.status as string) &&
        (where.appliedAt
          ? operation.appliedAt instanceof Date &&
            (inclusive ? operation.appliedAt.getTime() >= boundary : operation.appliedAt.getTime() > boundary)
          : operation.createdAt instanceof Date &&
            (inclusive ? operation.createdAt.getTime() >= boundary : operation.createdAt.getTime() > boundary))
      ) ?? null;
    }
  );
  mocks.prisma.generationJob.create.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => {
    mocks.currentJob = {
      id: "gj-compile",
      status: "QUEUED",
      bullJobId: null,
      dispatchAttempts: 0,
      ...data
    };
    return mocks.currentJob;
  });
  mocks.prisma.generationJob.update.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({
    ...mocks.currentJob,
    ...data
  }));
  mocks.queueAdd.mockResolvedValue({ id: "bull-1" });
  mocks.queueGetJob.mockResolvedValue(undefined);
});

function strandedProject(overrides: Record<string, unknown> = {}) {
  return {
    id: "project-1",
    status: "EDITING",
    contentRevision: 7,
    currentPlanId: "plan-1",
    exportInvalidationRevision: null,
    mediaSettings: {},
    jobs: [],
    editOperations: [],
    ...overrides
  };
}

const PREDECESSOR_FINISHED_AT = new Date("2026-08-20T00:00:00.000Z");

function publishedPayload(
  payload: Record<string, unknown> = {},
  publishedAt = PREDECESSOR_FINISHED_AT
): Record<string, unknown> {
  return { ...payload, exportPublicationCommittedAt: publishedAt.toISOString() };
}

function queueStrandedProject(overrides: Record<string, unknown> = {}) {
  const candidate = strandedProject(overrides);
  const jobs = candidate.jobs as Record<string, unknown>[];
  const editOperations = candidate.editOperations as Record<string, unknown>[];
  mocks.recoveryJobs = jobs.map((job) => ({
    status: "COMPLETED",
    ownsQualityVerdict: false,
    qualityReport: null,
    finishedAt: PREDECESSOR_FINISHED_AT,
    ...job
  }));
  mocks.editOperations = editOperations;
  const { jobs: _jobs, editOperations: _editOperations, ...project } = candidate;
  mocks.prisma.project.findMany.mockResolvedValue([project]);
}

function createdCompile(): Record<string, unknown> {
  const call = mocks.prisma.generationJob.create.mock.calls.at(-1);
  expect(call).toBeDefined();
  return call![0].data;
}

describe("reconcileStrandedGeneration compile policy", () => {
  it("retires an abandoned current-revision export barrier before queueing recovery", async () => {
    queueStrandedProject({
      exportInvalidationRevision: 7,
      jobs: [{ contentRevision: 7, payload: { skipFinalReview: true } }]
    });
    mocks.prisma.$queryRawUnsafe.mockResolvedValue([{ id: "project-1" }]);
    mocks.prisma.project.findUnique.mockResolvedValue({ status: "EDITING", contentRevision: 7 });

    await reconcileStrandedGeneration();

    expect(mocks.prisma.$queryRawUnsafe).toHaveBeenCalledWith(
      expect.stringContaining('UPDATE "Project" project'),
      "project-1",
      7
    );
    const retirementSql = String(mocks.prisma.$queryRawUnsafe.mock.calls[0]?.[0]);
    expect(retirementSql).toContain('operation."structuralLeaseExpiresAt" > CURRENT_TIMESTAMP');
    expect(retirementSql).toContain('operation."structuralLeaseCompletedAt" IS NULL');
    expect(retirementSql).toContain('operation."projectId" = project."id"');
    expect(createdCompile()).toMatchObject({ contentRevision: 7 });
  });

  it("preserves a replan copy barrier owned by the source operation's live tail", async () => {
    queueStrandedProject({
      exportInvalidationRevision: 7,
      jobs: [{ contentRevision: 7, payload: { skipFinalReview: true } }]
    });
    // Zero rows is the raw CAS saying either the project moved or an unexpired
    // APPLIED publication tail still owns this exact revision.
    mocks.prisma.$queryRawUnsafe.mockResolvedValue([]);

    await reconcileStrandedGeneration();

    expect(mocks.prisma.$queryRawUnsafe).toHaveBeenCalledWith(
      expect.stringContaining('UPDATE "Project" project'),
      "project-1",
      7
    );
    const retirementSql = String(mocks.prisma.$queryRawUnsafe.mock.calls[0]?.[0]);
    expect(retirementSql).toContain('operation."kind" = \'BOOK_REPLAN\'');
    expect(retirementSql).toContain('operation."projectId" <> project."id"');
    expect(retirementSql).toContain('operation."sourceProjectId" = operation."projectId"');
    expect(retirementSql).toContain('FROM "GenerationJob" job');
    expect(retirementSql).toContain('job."id" = operation."generationJobId"');
    expect(retirementSql).toContain('job."projectId" = project."id"');
    expect(retirementSql).toContain('job."type" = \'GENERATE_BOOK\'');
    expect(retirementSql).toContain('job."status" = \'COMPLETED\'');
    expect(mocks.prisma.generationJob.create).not.toHaveBeenCalled();
  });

  it("keeps GENERATING recovery on the ordinary full-review path", async () => {
    queueStrandedProject({ status: "GENERATING", contentRevision: 4 });

    await reconcileStrandedGeneration();

    expect(mocks.prisma.project.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          status: { in: ["GENERATING", "EDITING"] },
          jobs: { none: { status: { in: ["QUEUED", "ACTIVE"] } } }
        })
      })
    );
    const payload = createdCompile().payload;
    expect(payload).not.toHaveProperty("skipFinalReview");
    expect(payload).not.toHaveProperty("markdownRecompileWithoutVerdict");
  });

  it.each([
    [
      "GENERATING",
      {
        skipFinalReview: true,
        presentationOnlyRecompile: true,
        presentationRecompileFallbackStatus: "REVIEW_REQUIRED",
        exportPublicationProjectStatus: "EDITING"
      }
    ],
    [
      "EDITING",
      {
        skipFinalReview: true,
        detachedFromProjectLifecycle: true,
        exportRepairFormat: "pdf",
        exportPublicationProjectStatus: "COMPLETE"
      }
    ]
  ])("preserves the prior non-owning policy while recovering %s", async (status, payload) => {
    queueStrandedProject({ status, jobs: [{ contentRevision: 7, payload }] });
    mocks.prisma.project.findUnique.mockResolvedValue({ status, contentRevision: 7 });

    await reconcileStrandedGeneration();

    expect(createdCompile()).toMatchObject({
      payload,
      ownsQualityVerdict: false
    });
  });

  it("recovers image policy from the terminal compile for this content revision", async () => {
    queueStrandedProject({
      jobs: [
        { contentRevision: 7, payload: { skipFinalReview: true, markdownRecompileWithoutVerdict: true } }
      ],
      editOperations: [{
        kind: "PAGE_REWRITE",
        status: "APPLIED",
        appliedAt: new Date("2026-08-21T00:00:00.000Z")
      }]
    });
    mocks.prisma.project.findUnique.mockResolvedValue({ status: "EDITING", contentRevision: 7 });

    await reconcileStrandedGeneration();

    expect(createdCompile()).toMatchObject({
      contentRevision: 7,
      payload: { skipFinalReview: true, markdownRecompileWithoutVerdict: true },
      ownsQualityVerdict: false
    });
  });

  it("reconciles one stable successor for a completed current-revision stand-down", async () => {
    const payload = { skipFinalReview: true, markdownRecompileWithoutVerdict: true };
    const policy = compilePublicationPolicyFromPayload(payload);
    const contentFingerprint = createHash("sha256")
      .update(pages.map((page) => `${page.id}:${page.revision}`).sort().join("|"))
      .digest("hex").slice(0, 24);
    const baseDedupeKey = compilePublicationDedupeKey({
      projectId: "project-1", planId: "plan-1", contentRevision: 7,
      policy, projectStatus: "EDITING", contentFingerprint
    });
    const predecessor = {
      id: "gj-terminal",
      projectId: "project-1",
      type: "COMPILE_EXPORT",
      attemptId: "attempt-1",
      contentRevision: 7,
      dedupeKey: `${baseDedupeKey}:attempt:attempt-1`,
      status: "COMPLETED",
      payload
    };
    queueStrandedProject({ jobs: [predecessor] });
    mocks.prisma.project.findUnique.mockResolvedValue({ status: "EDITING", contentRevision: 7 });
    let successor: Record<string, unknown> | null = null;
    mocks.prisma.generationJob.findUnique.mockImplementation(
      async ({ where }: { where: Record<string, unknown> }) => {
        if (where.id === "gj-terminal") return predecessor;
        if (where.id) return successor;
        return String(where.dedupeKey).includes(":successor-of-gj-terminal") ? successor : predecessor;
      }
    );
    mocks.prisma.generationJob.create.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => {
      successor = { id: "gj-successor", status: "QUEUED", bullJobId: null, dispatchAttempts: 0, ...data };
      return successor;
    });
    mocks.prisma.generationJob.update.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => {
      successor = { ...successor, ...data };
      return successor;
    });

    await reconcileStrandedGeneration();
    await reconcileStrandedGeneration();

    expect(mocks.prisma.generationJob.create).toHaveBeenCalledTimes(1);
    expect(mocks.queueAdd).toHaveBeenCalledTimes(1);
    expect(createdCompile()).toMatchObject({
      attemptId: "attempt-1",
      dedupeKey: expect.stringMatching(/:successor-of-gj-terminal:attempt:attempt-1$/)
    });
  });

  it("recovers a current presentation compile with its exact durable policy", async () => {
    queueStrandedProject({
      jobs: [{
        contentRevision: 7,
        payload: {
          skipFinalReview: true,
          presentationOnlyRecompile: true,
          presentationRecompileFallbackStatus: "REVIEW_REQUIRED",
          exportPublicationProjectStatus: "EDITING"
        }
      }]
    });
    mocks.prisma.project.findUnique.mockResolvedValue({ status: "EDITING", contentRevision: 7 });

    await reconcileStrandedGeneration();

    expect(createdCompile()).toMatchObject({
      contentRevision: 7,
      ownsQualityVerdict: false,
      payload: {
        skipFinalReview: true,
        presentationOnlyRecompile: true,
        presentationRecompileFallbackStatus: "REVIEW_REQUIRED",
        exportPublicationProjectStatus: "EDITING"
      }
    });
  });

  it.each(["REVIEW_REQUIRED", "COMPLETE"] as const)(
    "recovers a historical presentation crash gap back to %s from its predecessor policy",
    async (fallbackStatus) => {
      queueStrandedProject({
        contentRevision: 8,
        jobs: [{
          contentRevision: 7,
          payload: {
            skipFinalReview: true,
            presentationOnlyRecompile: true,
            presentationRecompileFallbackStatus: fallbackStatus,
            exportPublicationProjectStatus: "EDITING"
          }
        }]
      });
      mocks.prisma.project.findUnique.mockResolvedValue({ status: "EDITING", contentRevision: 8 });

      await reconcileStrandedGeneration();

      expect(createdCompile()).toMatchObject({
        contentRevision: 8,
        ownsQualityVerdict: false,
        payload: {
          skipFinalReview: true,
          presentationOnlyRecompile: true,
          presentationRecompileFallbackStatus: fallbackStatus,
          exportPublicationProjectStatus: "EDITING"
        }
      });
    }
  );

  it.each([
    [
      "APPLIED PAGE_REWRITE",
      {
        kind: "PAGE_REWRITE",
        status: "APPLIED",
        appliedAt: new Date("2026-08-19T00:00:00.000Z"),
        createdAt: new Date("2026-08-19T00:00:00.000Z")
      }
    ],
    [
      "FAILED edit",
      {
        kind: "ADD_IMAGE",
        status: "FAILED",
        appliedAt: null,
        createdAt: new Date("2026-08-19T00:00:00.000Z")
      }
    ],
    [
      "undone edit",
      {
        kind: "RESTRUCTURE_PAGES",
        status: "APPLIED",
        classifier: { undoneAt: "2026-08-19T12:00:00.000Z" },
        appliedAt: new Date("2026-08-19T00:00:00.000Z"),
        createdAt: new Date("2026-08-19T00:00:00.000Z")
      }
    ]
  ])("does not let an old %s override a presentation crash gap", async (_label, operation) => {
    queueStrandedProject({
      contentRevision: 8,
      jobs: [{
        contentRevision: 7,
        payload: publishedPayload({
          skipFinalReview: true,
          presentationOnlyRecompile: true,
          presentationRecompileFallbackStatus: "COMPLETE",
          exportPublicationProjectStatus: "EDITING"
        })
      }],
      editOperations: [operation]
    });
    mocks.prisma.project.findUnique.mockResolvedValue({ status: "EDITING", contentRevision: 8 });

    await reconcileStrandedGeneration();

    expect(createdCompile()).toMatchObject({
      ownsQualityVerdict: false,
      payload: {
        skipFinalReview: true,
        presentationOnlyRecompile: true,
        presentationRecompileFallbackStatus: "COMPLETE",
        exportPublicationProjectStatus: "EDITING"
      }
    });
  });

  it("finds an exact presentation predecessor behind detached, null-revision, and newer rows", async () => {
    queueStrandedProject({
      contentRevision: 8,
      jobs: [
        { contentRevision: 9, payload: { skipFinalReview: true } },
        { contentRevision: null, payload: { skipFinalReview: true } },
        {
          contentRevision: 7,
          payload: {
            skipFinalReview: true,
            detachedFromProjectLifecycle: true,
            exportRepairFormat: "pdf",
            exportPublicationProjectStatus: "COMPLETE"
          }
        },
        {
          contentRevision: 7,
          payload: {
            skipFinalReview: true,
            presentationOnlyRecompile: true,
            presentationRecompileFallbackStatus: "REVIEW_REQUIRED",
            exportPublicationProjectStatus: "EDITING"
          }
        }
      ]
    });
    mocks.prisma.project.findUnique.mockResolvedValue({ status: "EDITING", contentRevision: 8 });

    await reconcileStrandedGeneration();

    expect(createdCompile()).toMatchObject({
      ownsQualityVerdict: false,
      payload: {
        presentationOnlyRecompile: true,
        presentationRecompileFallbackStatus: "REVIEW_REQUIRED"
      }
    });
    expect(mocks.prisma.generationJob.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ contentRevision: { in: [8, 7] } })
      })
    );
  });

  it("gives a current-revision compile precedence behind a detached row and over inference", async () => {
    queueStrandedProject({
      contentRevision: 8,
      jobs: [
        {
          contentRevision: 8,
          payload: {
            skipFinalReview: true,
            detachedFromProjectLifecycle: true,
            exportRepairFormat: "epub",
            exportPublicationProjectStatus: "COMPLETE"
          }
        },
        {
          contentRevision: 8,
          payload: {
            skipFinalReview: true,
            presentationOnlyRecompile: true,
            presentationRecompileFallbackStatus: "REVIEW_REQUIRED",
            exportPublicationProjectStatus: "EDITING"
          }
        },
        { contentRevision: 7, payload: {}, ownsQualityVerdict: true }
      ],
      editOperations: [{
        kind: "PAGE_REWRITE",
        status: "APPLIED",
        appliedAt: new Date("2026-08-21T00:00:00.000Z"),
        createdAt: new Date("2026-08-21T00:00:00.000Z")
      }]
    });
    mocks.prisma.project.findUnique.mockResolvedValue({ status: "EDITING", contentRevision: 8 });

    await reconcileStrandedGeneration();

    expect(createdCompile()).toMatchObject({
      ownsQualityVerdict: false,
      payload: {
        presentationOnlyRecompile: true,
        presentationRecompileFallbackStatus: "REVIEW_REQUIRED"
      }
    });
    expect(mocks.prisma.bookEditOperation.findFirst).not.toHaveBeenCalled();
  });

  it.each([
    ["REVIEW_REQUIRED", "blocked"],
    ["COMPLETE", "passed"]
  ] as const)(
    "recovers a first historical presentation crash gap back to %s from its published verdict",
    async (fallbackStatus, qualityState) => {
      queueStrandedProject({
        contentRevision: 8,
        mediaSettings: { includeSources: false },
        jobs: [{
          contentRevision: 7,
          payload: { exportPublicationProjectStatus: "GENERATING" },
          status: "COMPLETED",
          ownsQualityVerdict: true,
          qualityReport: { state: qualityState, issues: [] }
        }]
      });
      mocks.prisma.project.findUnique.mockResolvedValue({ status: "EDITING", contentRevision: 8 });

      await reconcileStrandedGeneration();

      expect(createdCompile()).toMatchObject({
        contentRevision: 8,
        ownsQualityVerdict: false,
        payload: {
          skipFinalReview: true,
          presentationOnlyRecompile: true,
          presentationRecompileFallbackStatus: fallbackStatus,
          exportPublicationProjectStatus: "EDITING"
        }
      });
    }
  );

  it("uses REVIEW_REQUIRED for a historical outcome predecessor whose settled verdict is unreadable", async () => {
    queueStrandedProject({
      contentRevision: 8,
      mediaSettings: { chapterHeadingStyle: "title_only" },
      jobs: [{
        contentRevision: 7,
        payload: { exportPublicationProjectStatus: "GENERATING" },
        status: "COMPLETED",
        ownsQualityVerdict: true,
        qualityReport: null
      }]
    });
    mocks.prisma.project.findUnique.mockResolvedValue({ status: "EDITING", contentRevision: 8 });

    await reconcileStrandedGeneration();

    expect(createdCompile()).toMatchObject({
      ownsQualityVerdict: false,
      payload: {
        skipFinalReview: true,
        presentationOnlyRecompile: true,
        presentationRecompileFallbackStatus: "REVIEW_REQUIRED",
        exportPublicationProjectStatus: "EDITING"
      }
    });
  });

  it("recovers text policy when a durable N-1 publication predates the latest APPLIED operation", async () => {
    queueStrandedProject({
      contentRevision: 8,
      jobs: [{ contentRevision: 7, payload: publishedPayload(), ownsQualityVerdict: true }],
      editOperations: [{
        kind: "PAGE_REWRITE",
        status: "APPLIED",
        appliedAt: new Date("2026-08-21T00:00:00.000Z")
      }]
    });
    mocks.prisma.project.findUnique.mockResolvedValue({ status: "EDITING", contentRevision: 8 });

    await reconcileStrandedGeneration();

    const compile = createdCompile();
    expect(compile.payload).toMatchObject({ skipFinalReview: true });
    expect(compile.payload).not.toHaveProperty("markdownRecompileWithoutVerdict");
    expect(compile.ownsQualityVerdict).toBe(true);
  });

  it("does not treat a completed N-1 stand-down as a publication boundary", async () => {
    queueStrandedProject({
      contentRevision: 8,
      jobs: [{
        contentRevision: 7,
        payload: {},
        status: "COMPLETED",
        ownsQualityVerdict: true,
        finishedAt: new Date("2026-08-22T00:00:00.000Z")
      }],
      editOperations: [{
        kind: "PAGE_REWRITE",
        status: "APPLIED",
        appliedAt: new Date("2026-08-21T00:00:00.000Z"),
        createdAt: new Date("2026-08-21T00:00:00.000Z")
      }]
    });
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);

    try {
      await reconcileStrandedGeneration();
    } finally {
      error.mockRestore();
    }

    expect(mocks.prisma.generationJob.create).not.toHaveBeenCalled();
  });

  it("uses the actual N-1 publication instead of a later superseded compile as the edit boundary", async () => {
    const editAppliedAt = new Date("2026-08-21T00:00:00.000Z");
    queueStrandedProject({
      contentRevision: 8,
      jobs: [
        {
          contentRevision: 7,
          payload: {},
          ownsQualityVerdict: true,
          finishedAt: new Date("2026-08-22T00:00:00.000Z")
        },
        {
          contentRevision: 7,
          payload: publishedPayload(),
          ownsQualityVerdict: true,
          finishedAt: PREDECESSOR_FINISHED_AT
        }
      ],
      editOperations: [{
        kind: "PAGE_REWRITE",
        status: "APPLIED",
        appliedAt: editAppliedAt,
        createdAt: editAppliedAt
      }]
    });
    mocks.prisma.project.findUnique.mockResolvedValue({ status: "EDITING", contentRevision: 8 });

    await reconcileStrandedGeneration();

    expect(createdCompile().payload).toMatchObject({
      contentRevision: 8,
      skipFinalReview: true,
      exportPublicationProjectStatus: "EDITING"
    });
  });

  it("re-recovers policy when the project revision changes after the sweep selected it", async () => {
    queueStrandedProject({
      contentRevision: 7,
      jobs: [{
        contentRevision: 7,
        payload: {
          skipFinalReview: true,
          presentationOnlyRecompile: true,
          presentationRecompileFallbackStatus: "REVIEW_REQUIRED",
          exportPublicationProjectStatus: "EDITING"
        }
      }],
      editOperations: [{
        kind: "ADD_IMAGE",
        status: "APPLIED",
        appliedAt: new Date("2026-08-22T00:00:00.000Z"),
        createdAt: new Date("2026-08-22T00:00:00.000Z")
      }]
    });
    mocks.prisma.project.findUnique.mockResolvedValue({ status: "EDITING", contentRevision: 8 });

    await reconcileStrandedGeneration();

    expect(createdCompile()).toMatchObject({
      contentRevision: 8,
      ownsQualityVerdict: false,
      payload: {
        contentRevision: 8,
        skipFinalReview: true,
        markdownRecompileWithoutVerdict: true,
        exportPublicationProjectStatus: "EDITING"
      }
    });
  });

  it("keeps structural recovery on the full-review path", async () => {
    queueStrandedProject({
      jobs: [{ contentRevision: 6, payload: publishedPayload(), ownsQualityVerdict: true }],
      editOperations: [{
        kind: "RESTRUCTURE_PAGES",
        status: "APPLIED",
        appliedAt: new Date("2026-08-21T00:00:00.000Z")
      }]
    });

    await reconcileStrandedGeneration();

    const payload = createdCompile().payload;
    expect(payload).not.toHaveProperty("skipFinalReview");
    expect(payload).not.toHaveProperty("markdownRecompileWithoutVerdict");
  });

  it("does not reuse an older policy while the newest edit is not APPLIED", async () => {
    queueStrandedProject({
      contentRevision: 8,
      mediaSettings: { includeSources: false },
      jobs: [{
        contentRevision: 7,
        payload: { exportPublicationProjectStatus: "GENERATING" },
        status: "COMPLETED",
        ownsQualityVerdict: true,
        qualityReport: { state: "passed" }
      }],
      editOperations: [{
        kind: "ADD_IMAGE",
        status: "ACTIVE",
        appliedAt: new Date("2026-08-21T00:00:00.000Z"),
        createdAt: new Date("2026-08-21T00:00:00.000Z")
      }]
    });
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);

    try {
      await reconcileStrandedGeneration();
    } finally {
      error.mockRestore();
    }

    expect(mocks.prisma.project.findUnique).not.toHaveBeenCalled();
    expect(mocks.prisma.generationJob.create).not.toHaveBeenCalled();
  });

  it("leaves an edit on an ambiguous revision-boundary timestamp untouched", async () => {
    queueStrandedProject({
      contentRevision: 8,
      jobs: [{
        contentRevision: 7,
        payload: publishedPayload({
          skipFinalReview: true,
          presentationOnlyRecompile: true,
          presentationRecompileFallbackStatus: "COMPLETE",
          exportPublicationProjectStatus: "EDITING"
        })
      }],
      editOperations: [{
        kind: "PAGE_REWRITE",
        status: "APPLIED",
        appliedAt: PREDECESSOR_FINISHED_AT,
        createdAt: PREDECESSOR_FINISHED_AT
      }]
    });
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);

    try {
      await reconcileStrandedGeneration();
    } finally {
      error.mockRestore();
    }

    expect(mocks.prisma.project.findUnique).not.toHaveBeenCalled();
    expect(mocks.prisma.generationJob.create).not.toHaveBeenCalled();
  });

  it("does not reinterpret an unknown EDITING revision from an outcome-owning predecessor", async () => {
    queueStrandedProject({
      contentRevision: 8,
      mediaSettings: { includeSources: false },
      jobs: [{
        contentRevision: 7,
        payload: { exportPublicationProjectStatus: "EDITING" },
        status: "FAILED",
        ownsQualityVerdict: true,
        qualityReport: { state: "passed" },
        finishedAt: new Date("2026-08-20T00:00:00.000Z")
      }]
    });
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);

    try {
      await reconcileStrandedGeneration();
    } finally {
      error.mockRestore();
    }

    expect(mocks.prisma.project.findUnique).not.toHaveBeenCalled();
    expect(mocks.prisma.generationJob.create).not.toHaveBeenCalled();
  });
});
