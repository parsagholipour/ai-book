import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  class KnownRequestError extends Error {
    code = "P2002";
  }
  return {
    KnownRequestError,
    createdJob: null as Record<string, unknown> | null,
    queueAdd: vi.fn(),
    queueGetJob: vi.fn(),
    prisma: {
      project: { findUnique: vi.fn() },
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
vi.mock("../generation/projectInput.js", () => ({
  inputForPlanVersion: () => ({
    prompt: "A detailed field guide to backyard birds.",
    category: "SCIENCE",
    targetPages: 2,
    complexity: 5,
    temperature: 0.8,
    language: "en",
    mediaSettings: { coverArtSource: "ai", finalReview: true }
  })
}));

import { compilePublicationDedupeKey, compilePublicationPolicyFromPayload } from "@book-maker/core";
import type { Job } from "bullmq";
import { createHash } from "node:crypto";
import { maybeCompileAfterCompletedJob, maybeEnqueueCompile } from "./dispatch.js";

const completedPages = [
  { id: "page-1", index: 1, status: "COMPLETED", markdown: "One.", revision: 1 },
  { id: "page-2", index: 2, status: "COMPLETED", markdown: "Two.", revision: 1 }
];

beforeEach(() => {
  vi.clearAllMocks();
  mocks.createdJob = null;
  mocks.prisma.project.findUnique.mockResolvedValue({ status: "GENERATING", contentRevision: 7 });
  mocks.prisma.planVersion.findUnique.mockResolvedValue({ id: "plan-1", inputSnapshot: {} });
  mocks.prisma.page.findMany.mockResolvedValue(completedPages);
  mocks.prisma.imageAsset.count.mockResolvedValue(1);
  mocks.prisma.generationJob.count.mockResolvedValue(0);
  mocks.prisma.generationJob.findFirst.mockResolvedValue(null);
  mocks.prisma.bookEditOperation.findFirst.mockResolvedValue(null);
  mocks.prisma.generationJob.findMany.mockResolvedValue([]);
  mocks.prisma.generationJob.findUnique.mockImplementation(
    async ({ where }: { where: Record<string, unknown> }) => (where.id ? mocks.createdJob : null)
  );
  mocks.prisma.generationJob.create.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => {
    mocks.createdJob = {
      id: "gj-compile",
      status: "QUEUED",
      bullJobId: null,
      dispatchAttempts: 0,
      ...data
    };
    return mocks.createdJob;
  });
  mocks.prisma.generationJob.update.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({
    ...mocks.createdJob,
    ...data
  }));
  mocks.queueAdd.mockResolvedValue({ id: "bull-1" });
  mocks.queueGetJob.mockResolvedValue(undefined);
});

function createdCompile(): Record<string, unknown> {
  const call = mocks.prisma.generationJob.create.mock.calls.at(-1);
  expect(call).toBeDefined();
  return call![0].data;
}

describe("maybeEnqueueCompile publication-policy identity", () => {
  it.each([
    ["normal", { exportPublicationProjectStatus: "GENERATING" }],
    [
      "presentation",
      {
        skipFinalReview: true,
        exportPublicationProjectStatus: "EDITING",
        presentationOnlyRecompile: true,
        presentationRecompileFallbackStatus: "REVIEW_REQUIRED"
      }
    ],
    [
      "detached",
      {
        skipFinalReview: true,
        exportPublicationProjectStatus: "COMPLETE",
        detachedFromProjectLifecycle: true,
        exportRepairFormat: "pdf"
      }
    ],
    [
      "no-verdict",
      {
        skipFinalReview: true,
        exportPublicationProjectStatus: "EDITING",
        markdownRecompileWithoutVerdict: true
      }
    ]
  ])("treats an exact open %s policy as the same compile intent", async (_kind, payload) => {
    mocks.prisma.project.findUnique.mockResolvedValue({
      status: payload.exportPublicationProjectStatus,
      contentRevision: 7
    });
    mocks.prisma.generationJob.findMany.mockResolvedValue([{ contentRevision: 7, payload }]);

    await maybeEnqueueCompile(
      "project-1",
      "plan-1",
      compilePublicationPolicyFromPayload(payload),
      { contentRevision: 7 }
    );

    expect(mocks.prisma.generationJob.create).not.toHaveBeenCalled();
  });

  it("queues a successor for the same pages and revision when the policy differs", async () => {
    mocks.prisma.project.findUnique.mockResolvedValue({ status: "EDITING", contentRevision: 7 });
    mocks.prisma.generationJob.findMany.mockResolvedValue([
      {
        contentRevision: 7,
        payload: { skipFinalReview: true, exportPublicationProjectStatus: "EDITING" }
      }
    ]);
    const presentation = {
      skipFinalReview: true,
      exportPublicationProjectStatus: "EDITING",
      presentationOnlyRecompile: true,
      presentationRecompileFallbackStatus: "COMPLETE"
    };

    await maybeEnqueueCompile(
      "project-1",
      "plan-1",
      compilePublicationPolicyFromPayload(presentation)
    );

    expect(createdCompile().dedupeKey).toContain("policy-r1v0seopc");
  });

  it("queues exactly one successor behind a completed compile with the same ordinary dedupe identity", async () => {
    const policy = compilePublicationPolicyFromPayload({ exportPublicationProjectStatus: "GENERATING" });
    const contentFingerprint = createHash("sha256")
      .update(completedPages.map((page) => `${page.id}:${page.revision}`).sort().join("|"))
      .digest("hex").slice(0, 24);
    const baseDedupeKey = compilePublicationDedupeKey({
      projectId: "project-1", planId: "plan-1", contentRevision: 7,
      policy, projectStatus: "GENERATING", contentFingerprint
    });
    const predecessor = {
      id: "gj-terminal",
      projectId: "project-1",
      type: "COMPILE_EXPORT",
      status: "COMPLETED",
      bullJobId: "bull-terminal",
      dispatchAttempts: 0,
      attemptId: "attempt-1",
      contentRevision: 7,
      dedupeKey: `${baseDedupeKey}:attempt:attempt-1`,
      payload: { exportPublicationProjectStatus: "GENERATING" }
    };
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
    const scope = {
      contentRevision: 7,
      completedPredecessorId: "gj-terminal"
    };

    await maybeEnqueueCompile("project-1", "plan-1", policy, scope);
    await maybeEnqueueCompile("project-1", "plan-1", policy, scope);
    await maybeEnqueueCompile("project-1", "plan-1", policy);

    expect(mocks.prisma.generationJob.create).toHaveBeenCalledTimes(1);
    expect(mocks.queueAdd).toHaveBeenCalledTimes(1);
    expect(createdCompile()).toMatchObject({
      attemptId: "attempt-1",
      dedupeKey: expect.stringMatching(/:successor-of-gj-terminal:attempt:attempt-1$/)
    });
  });

  it("recovers the unpublished predecessor when image fan-in follows a waiting compile hook", async () => {
    const policy = compilePublicationPolicyFromPayload({ exportPublicationProjectStatus: "GENERATING" });
    const contentFingerprint = createHash("sha256")
      .update(completedPages.map((page) => `${page.id}:${page.revision}`).sort().join("|"))
      .digest("hex").slice(0, 24);
    const baseDedupeKey = compilePublicationDedupeKey({
      projectId: "project-1", planId: "plan-1", contentRevision: 7,
      policy, projectStatus: "GENERATING", contentFingerprint
    });
    const predecessor = {
      id: "gj-terminal",
      projectId: "project-1",
      type: "COMPILE_EXPORT",
      status: "COMPLETED",
      attemptId: "attempt-1",
      contentRevision: 7,
      dedupeKey: `${baseDedupeKey}:attempt:attempt-1`,
      payload: { exportPublicationProjectStatus: "GENERATING" }
    };
    const distractors = [
      {
        ...predecessor,
        id: "gj-published",
        payload: {
          ...predecessor.payload,
          exportPublicationCommittedAt: "2026-08-24T00:00:00.000Z"
        }
      },
      { ...predecessor, id: "gj-wrong-revision", contentRevision: 6 },
      {
        ...predecessor,
        id: "gj-detached",
        payload: {
          skipFinalReview: true,
          detachedFromProjectLifecycle: true,
          exportRepairFormat: "pdf",
          exportPublicationProjectStatus: "GENERATING"
        }
      }
    ];
    let openImageJobs = 1;
    let successor: Record<string, unknown> | null = null;
    mocks.prisma.generationJob.count.mockImplementation(
      async ({ where }: { where: { type: string } }) => where.type === "GENERATE_IMAGE" ? openImageJobs : 0
    );
    mocks.prisma.generationJob.findMany.mockImplementation(
      async ({ where }: { where: { status?: unknown } }) => where.status ? [] : [...distractors, predecessor]
    );
    mocks.prisma.generationJob.findUnique.mockImplementation(
      async ({ where }: { where: Record<string, unknown> }) => {
        if (where.id === predecessor.id) return predecessor;
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

    expect(await maybeEnqueueCompile("project-1", "plan-1", policy, {
      contentRevision: 7,
      completedPredecessorId: predecessor.id
    })).toBe("waiting");
    expect(mocks.prisma.generationJob.create).not.toHaveBeenCalled();

    openImageJobs = 0;
    const imageCompletion = {
      name: "generate-image",
      data: { projectId: "project-1", planId: "plan-1" }
    } as unknown as Job;
    await maybeCompileAfterCompletedJob(imageCompletion);
    await maybeCompileAfterCompletedJob(imageCompletion);

    expect(mocks.prisma.generationJob.create).toHaveBeenCalledTimes(1);
    expect(mocks.queueAdd).toHaveBeenCalledTimes(1);
    expect(createdCompile()).toMatchObject({
      attemptId: "attempt-1",
      dedupeKey: expect.stringMatching(/:successor-of-gj-terminal:attempt:attempt-1$/)
    });
  });

  it("lets a legacy null-revision row suppress only the policy it actually carries", async () => {
    mocks.prisma.generationJob.findMany.mockResolvedValue([{ contentRevision: null, payload: {} }]);

    await maybeEnqueueCompile("project-1", "plan-1");
    expect(mocks.prisma.generationJob.create).not.toHaveBeenCalled();

    await maybeEnqueueCompile(
      "project-1",
      "plan-1",
      compilePublicationPolicyFromPayload({
        skipFinalReview: true,
        detachedFromProjectLifecycle: true,
        exportRepairFormat: "epub",
        exportPublicationProjectStatus: "COMPLETE"
      })
    );
    expect(createdCompile()).toMatchObject({ contentRevision: 7, ownsQualityVerdict: false });
  });

  it("recovers the newer revision's policy when an image finishes before an older compile callback", async () => {
    // Revision 7's outcome compile observed a replacement image and returned a
    // post-completion callback carrying its full-review policy. Before that
    // callback runs, an ADD_IMAGE edit advances the book to revision 8 and its
    // image job finishes. The callback must now behave like revision 8 fan-in,
    // not upgrade that image-only edit into full QA.
    mocks.prisma.project.findUnique.mockResolvedValue({ status: "EDITING", contentRevision: 8 });
    mocks.prisma.bookEditOperation.findFirst.mockResolvedValue({ kind: "ADD_IMAGE", status: "APPLIED" });

    await maybeEnqueueCompile(
      "project-1",
      "plan-1",
      compilePublicationPolicyFromPayload({ exportPublicationProjectStatus: "GENERATING" }),
      { contentRevision: 7 }
    );

    expect(createdCompile().payload).toEqual({
      planId: "plan-1",
      contentRevision: 8,
      exportPublicationProjectStatus: "EDITING",
      skipFinalReview: true,
      markdownRecompileWithoutVerdict: true
    });
    expect(createdCompile().ownsQualityVerdict).toBe(false);
    expect(mocks.prisma.generationJob.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ projectId: "project-1", contentRevision: 8 })
      })
    );
    expect(mocks.prisma.bookEditOperation.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { projectId: "project-1", status: "APPLIED" } })
    );
  });

  it("never retargets an operation-owned publication tail to a newer revision", async () => {
    mocks.prisma.project.findUnique.mockResolvedValue({ status: "EDITING", contentRevision: 8 });

    await expect(
      maybeEnqueueCompile("project-1", "plan-1", undefined, {
        contentRevision: 7,
        requireContentRevisionMatch: true
      })
    ).resolves.toBe("settled");

    expect(mocks.prisma.generationJob.create).not.toHaveBeenCalled();
    expect(mocks.prisma.page.findMany).not.toHaveBeenCalled();
  });

  it.each([
    [
      "presentation",
      {
        skipFinalReview: true,
        presentationOnlyRecompile: true,
        presentationRecompileFallbackStatus: "REVIEW_REQUIRED",
        exportPublicationProjectStatus: "EDITING"
      },
      false
    ],
    [
      "image",
      {
        skipFinalReview: true,
        markdownRecompileWithoutVerdict: true,
        exportPublicationProjectStatus: "EDITING"
      },
      false
    ]
  ] as const)("recovers the current %s policy behind a newer detached row", async (_label, payload, ownsVerdict) => {
    mocks.prisma.project.findUnique.mockResolvedValue({ status: "EDITING", contentRevision: 7 });
    mocks.prisma.generationJob.findMany.mockImplementation(
      async ({ where }: { where: { status?: unknown } }) => where.status
        ? []
        : [
            {
              contentRevision: 7,
              payload: {
                skipFinalReview: true,
                detachedFromProjectLifecycle: true,
                exportRepairFormat: "pdf",
                exportPublicationProjectStatus: "COMPLETE"
              }
            },
            { contentRevision: 7, payload }
          ]
    );

    await maybeEnqueueCompile("project-1", "plan-1");

    expect(createdCompile()).toMatchObject({
      contentRevision: 7,
      ownsQualityVerdict: ownsVerdict,
      payload
    });
  });

  it("leaves unknown EDITING fan-in untouched when no compile policy can be recovered", async () => {
    mocks.prisma.project.findUnique.mockResolvedValue({ status: "EDITING", contentRevision: 7 });
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);

    try {
      expect(await maybeEnqueueCompile("project-1", "plan-1")).toBe("not-ready");
      expect(error).toHaveBeenCalledWith("Stranded edit compile policy could not be recovered", {
        projectId: "project-1",
        contentRevision: 7
      });
    } finally {
      error.mockRestore();
    }

    expect(mocks.prisma.generationJob.create).not.toHaveBeenCalled();
  });

  it.each(["ADD_IMAGE", "MOVE_IMAGE", "REMOVE_IMAGE"] as const)(
    "keeps the applied %s policy when a newer failed edit exists at image fan-in",
    async (kind) => {
      mocks.prisma.project.findUnique.mockResolvedValue({ status: "EDITING", contentRevision: 7 });
      mocks.prisma.generationJob.count.mockImplementation(
        async ({ where }: { where: { type: string } }) => (where.type === "GENERATE_IMAGE" ? 1 : 0)
      );

      expect(
        await maybeEnqueueCompile("project-1", "plan-1", {
          skipFinalReview: true,
          withoutQualityVerdict: true
        })
      ).toBe("waiting");
      expect(mocks.prisma.generationJob.create).not.toHaveBeenCalled();

      mocks.prisma.generationJob.count.mockResolvedValue(0);
      mocks.prisma.bookEditOperation.findFirst.mockImplementation(
        async ({ where }: { where: { status?: string } }) =>
          where.status === "APPLIED"
            ? { kind, status: "APPLIED" }
            : { kind: "PAGE_REWRITE", status: "FAILED" }
      );

      await maybeCompileAfterCompletedJob({
        name: "generate-image",
        data: { projectId: "project-1", planId: "plan-1" }
      } as unknown as Job);

      expect(createdCompile().payload).toMatchObject({
        skipFinalReview: true,
        markdownRecompileWithoutVerdict: true
      });
      expect(createdCompile().ownsQualityVerdict).toBe(false);
      expect(mocks.prisma.bookEditOperation.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({ where: { projectId: "project-1", status: "APPLIED" } })
      );
    }
  );
});
