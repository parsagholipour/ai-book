import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  queueAdd: vi.fn(),
  queueGetJob: vi.fn(),
  prisma: {
    generationJob: {
      updateMany: vi.fn(),
      findUnique: vi.fn(),
      update: vi.fn()
    }
  }
}));

vi.mock("@book-maker/db", () => ({
  prisma: mocks.prisma,
  Prisma: { PrismaClientKnownRequestError: class extends Error {} }
}));
vi.mock("./queue.js", () => ({ queue: { add: mocks.queueAdd, getJob: mocks.queueGetJob } }));
vi.mock("./config.js", () => ({ config: { MAX_PARALLEL_PAGE_JOBS: 3 } }));
vi.mock("../generation/projectInput.js", () => ({ inputForPlanVersion: vi.fn() }));

import { redeliverWorkerGenerationJob } from "./dispatch.js";

describe("replan successor redelivery payload", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.prisma.generationJob.updateMany.mockResolvedValue({ count: 1 });
    mocks.prisma.generationJob.findUnique.mockResolvedValue({
      id: "job-generate",
      projectId: "project-1",
      type: "GENERATE_BOOK",
      status: "QUEUED",
      bullJobId: null,
      attemptId: "attempt-1",
      dispatchAttempts: 0,
      payload: {
        planId: "plan-2",
        replanOperationId: "operation-1",
        sourceProjectId: "project-source",
        editInstruction: "Rewrite the ending so Mara refuses the red key.",
        request: "change the ending",
        characterContext: "Mentioned character profiles:\n- Mara: a careful navigator"
      }
    });
    mocks.prisma.generationJob.update.mockResolvedValue({});
    mocks.queueGetJob.mockResolvedValue(undefined);
    mocks.queueAdd.mockResolvedValue({ id: "job-generate" });
  });

  it("redelivers every recovery field from the durable GENERATE_BOOK row", async () => {
    await redeliverWorkerGenerationJob("job-generate");

    expect(mocks.queueAdd).toHaveBeenCalledWith(
      "generate-book",
      expect.objectContaining({
        generationJobId: "job-generate",
        attemptId: "attempt-1",
        editInstruction: "Rewrite the ending so Mara refuses the red key.",
        request: "change the ending",
        characterContext: "Mentioned character profiles:\n- Mara: a careful navigator"
      }),
      expect.objectContaining({ jobId: "job-generate" })
    );
  });
});
