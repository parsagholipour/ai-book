import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  prisma: {
    voiceCharacter: { count: vi.fn() },
    generationJob: { findFirst: vi.fn() }
  },
  dispatchWorkerGenerationJob: vi.fn(),
  enqueueWorkerJob: vi.fn()
}));

vi.mock("@book-maker/db", () => ({ prisma: mocks.prisma }));
vi.mock("../runtime/dispatch.js", () => ({
  dispatchWorkerGenerationJob: mocks.dispatchWorkerGenerationJob,
  enqueueWorkerJob: mocks.enqueueWorkerJob
}));
vi.mock("../runtime/config.js", () => ({ config: {} }));
vi.mock("../runtime/jobLifecycle.js", () => ({ advanceJobStep: vi.fn() }));
vi.mock("../providers/loggedAdapters.js", () => ({ createLoggedProviders: vi.fn() }));
vi.mock("../generation/projectInput.js", () => ({ inputForPlanVersion: vi.fn() }));
vi.mock("../generation/bookHelpers.js", () => ({
  getProjectOrThrow: vi.fn(),
  imageGenerationMetadata: vi.fn(),
  imageStorageMetadata: vi.fn(),
  strategyForInput: vi.fn()
}));

import { maybeEnqueueCharacterCandidatePreparation } from "./characters.js";

describe("maybeEnqueueCharacterCandidatePreparation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.prisma.voiceCharacter.count.mockResolvedValue(0);
    mocks.prisma.generationJob.findFirst.mockResolvedValue(null);
    mocks.dispatchWorkerGenerationJob.mockResolvedValue(undefined);
    mocks.enqueueWorkerJob.mockResolvedValue(undefined);
  });

  it("dispatches only the exact row persisted by export publication", async () => {
    mocks.prisma.generationJob.findFirst.mockResolvedValue({
      id: "character-job-1",
      status: "QUEUED",
      bullJobId: null
    });

    await maybeEnqueueCharacterCandidatePreparation("project-1", "plan-1", "character-job-1");

    expect(mocks.prisma.generationJob.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: "character-job-1", projectId: "project-1" })
      })
    );
    expect(mocks.dispatchWorkerGenerationJob).toHaveBeenCalledWith("character-job-1");
    expect(mocks.enqueueWorkerJob).not.toHaveBeenCalled();
    expect(mocks.prisma.voiceCharacter.count).not.toHaveBeenCalled();
  });

  it("does not create a replacement when the persisted publication row is absent", async () => {
    await maybeEnqueueCharacterCandidatePreparation("project-1", "plan-1", "missing-job");

    expect(mocks.dispatchWorkerGenerationJob).not.toHaveBeenCalled();
    expect(mocks.enqueueWorkerJob).not.toHaveBeenCalled();
  });

  it("redispatches an older queued-undispatched preparation row instead of returning early", async () => {
    mocks.prisma.generationJob.findFirst.mockResolvedValue({
      id: "stranded-job",
      status: "QUEUED",
      bullJobId: null
    });

    await maybeEnqueueCharacterCandidatePreparation("project-1", "plan-1");

    expect(mocks.dispatchWorkerGenerationJob).toHaveBeenCalledWith("stranded-job");
    expect(mocks.enqueueWorkerJob).not.toHaveBeenCalled();
  });

  it("keeps the original guarded create path when no character or open row exists", async () => {
    await maybeEnqueueCharacterCandidatePreparation("project-1", "plan-1");

    expect(mocks.enqueueWorkerJob).toHaveBeenCalledWith({
      projectId: "project-1",
      type: "PREPARE_CHARACTER_CANDIDATES",
      payload: { planId: "plan-1" },
      dedupeKey: "prepare-characters:project-1:plan-1"
    });
  });
});
