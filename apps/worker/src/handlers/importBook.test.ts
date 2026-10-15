import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Job } from "bullmq";

const mocks = vi.hoisted(() => ({
  prisma: {
    bookImport: { findUnique: vi.fn(), update: vi.fn(), updateMany: vi.fn() },
    project: { update: vi.fn(), findUnique: vi.fn() },
    generationJob: { findUnique: vi.fn() },
    planVersion: { findFirst: vi.fn() },
    page: { findMany: vi.fn() },
    $transaction: vi.fn()
  },
  getProjectOrThrow: vi.fn(),
  maybeEnqueueCompile: vi.fn(),
  parseManuscript: vi.fn(),
  readFile: vi.fn()
}));

vi.mock("@book-maker/db", () => ({ prisma: mocks.prisma, Prisma: {} }));
vi.mock("../runtime/dispatch.js", () => ({ maybeEnqueueCompile: mocks.maybeEnqueueCompile }));
vi.mock("../runtime/jobLifecycle.js", () => ({ advanceJobStep: vi.fn() }));
vi.mock("../runtime/config.js", () => ({ config: { ATTACHMENT_STORAGE_DIR: "/tmp/test-attachments" } }));
vi.mock("../providers/loggedAdapters.js", () => ({ createLoggedProviders: () => ({ text: {} }) }));
vi.mock("../generation/embeddingWrites.js", () => ({ storeEmbedding: vi.fn(), strategyUsesSemanticMemory: () => false }));
vi.mock("../generation/projectInput.js", () => ({ inputFromProject: () => ({}) }));
vi.mock("../generation/bookHelpers.js", () => ({
  getProjectOrThrow: mocks.getProjectOrThrow,
  nextPlanVersion: vi.fn(),
  planInputSnapshot: (input: unknown) => input,
  strategyForInput: () => ({})
}));
vi.mock("@book-maker/core", async () => {
  const actual = await vi.importActual<typeof import("@book-maker/core")>("@book-maker/core");
  return {
    ...actual,
    analyzeManuscriptStyle: vi.fn(),
    createProviders: () => ({}),
    parseManuscript: mocks.parseManuscript,
    segmentManuscript: vi.fn(),
    synthesizeImportedBookPlan: vi.fn()
  };
});
vi.mock("node:fs/promises", () => ({ readFile: mocks.readFile }));

import { importBook } from "./importBook.js";

const job = (data: Record<string, unknown> = {}) =>
  ({ id: "job-1", data: { projectId: "project-1", importId: "import-1", ...data } }) as unknown as Job;

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getProjectOrThrow.mockResolvedValue({
    id: "project-1",
    currentPlanId: "plan-9",
    title: "Imported",
    mediaSettings: {},
    language: "en"
  });
  mocks.prisma.project.update.mockResolvedValue({});
  mocks.prisma.bookImport.update.mockResolvedValue({});
  mocks.prisma.bookImport.updateMany.mockResolvedValue({ count: 1 });
  mocks.prisma.project.findUnique.mockResolvedValue({ status: "GENERATING", currentPlanId: "plan-9", contentRevision: 1 });
  mocks.prisma.planVersion.findFirst.mockResolvedValue({ id: "plan-9" });
  mocks.prisma.generationJob.findUnique.mockResolvedValue({ status: "COMPLETED" });
});

describe("importBook redelivery", () => {
  it("short-circuits to success when the import already committed", async () => {
    // A crash between the import transaction committing and the durable
    // COMPLETED write redelivers the job; re-importing hits
    // @@unique(projectId, index) on chapter.create and marked a fully
    // committed book FAILED.
    mocks.prisma.bookImport.findUnique.mockResolvedValue({ id: "import-1", projectId: "project-1", status: "COMPLETE", format: "TXT" });

    const completion = await importBook(job());
    expect(mocks.maybeEnqueueCompile).not.toHaveBeenCalled();
    await completion.afterJobCompleted?.();

    expect(mocks.readFile).not.toHaveBeenCalled();
    expect(mocks.parseManuscript).not.toHaveBeenCalled();
    expect(mocks.prisma.$transaction).not.toHaveBeenCalled();
    expect(mocks.prisma.project.update).not.toHaveBeenCalled();
    expect(mocks.maybeEnqueueCompile).toHaveBeenCalledWith("project-1", "plan-9", undefined, { contentRevision: 1, requireContentRevisionMatch: true });
    // The committed import must not be re-marked PARSING or FAILED.
    expect(mocks.prisma.bookImport.update).not.toHaveBeenCalled();
  });

  it("still runs a fresh import when the row is not committed", async () => {
    mocks.prisma.bookImport.findUnique.mockResolvedValue({ id: "import-1", status: "UPLOADED", format: "TXT" });
    mocks.readFile.mockRejectedValue(new Error("gone"));

    await expect(importBook(job())).rejects.toThrow("The uploaded manuscript file is no longer available");

    expect(mocks.prisma.bookImport.updateMany).toHaveBeenCalledWith({
      where: { id: "import-1", status: { not: "COMPLETE" } },
      data: { status: "FAILED", error: expect.stringContaining("no longer available") }
    });
  });
});
