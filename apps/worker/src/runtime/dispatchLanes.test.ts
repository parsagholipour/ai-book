import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const lane = (name: string) => ({ name, add: vi.fn(), getJob: vi.fn() });
  return {
    long: lane("book-maker"),
    interactive: lane("book-maker-interactive"),
    images: lane("book-maker-images"),
    compile: lane("book-maker-compile"),
    background: lane("book-maker-background"),
    row: null as Record<string, unknown> | null,
    prisma: { generationJob: { findUnique: vi.fn(), update: vi.fn() } }
  };
});

vi.mock("@book-maker/db", () => ({ prisma: mocks.prisma, Prisma: {} }));
vi.mock("./queue.js", () => ({
  queue: mocks.long,
  queueNamed: (name: string) =>
    [mocks.long, mocks.interactive, mocks.images, mocks.compile, mocks.background].find((lane) => lane.name === name) ??
    mocks.long,
  allLaneQueues: [mocks.long, mocks.interactive, mocks.images, mocks.compile, mocks.background]
}));
vi.mock("./config.js", () => ({ config: { MAX_PARALLEL_PAGE_JOBS: 1 } }));

import { dispatchWorkerGenerationJob } from "./dispatch.js";

function row(type: string, payload: Record<string, unknown> = {}) {
  return {
    id: "gj-1",
    projectId: "project-1",
    attemptId: null,
    type,
    status: "QUEUED",
    bullJobId: null,
    dispatchAttempts: 0,
    payload
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.prisma.generationJob.findUnique.mockImplementation(async () => mocks.row);
  mocks.prisma.generationJob.update.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({ ...mocks.row, ...data }));
  for (const lane of [mocks.long, mocks.interactive, mocks.images, mocks.compile, mocks.background]) {
    lane.getJob.mockResolvedValue(undefined);
    lane.add.mockImplementation(async (_name: string, _data: unknown, opts: { jobId: string }) => ({ id: opts.jobId }));
  }
});

describe("dispatchWorkerGenerationJob lanes", () => {
  it("starts a book in the long lane, behind work already under way", async () => {
    mocks.row = row("GENERATE_BOOK", { planId: "plan-1" });
    await dispatchWorkerGenerationJob("gj-1");
    expect(mocks.interactive.add).not.toHaveBeenCalled();
    expect(mocks.long.add).toHaveBeenCalledWith(
      "generate-book",
      expect.objectContaining({ generationJobId: "gj-1", projectId: "project-1" }),
      expect.objectContaining({ jobId: "gj-1", priority: 1, attempts: 2 })
    );
  });

  it("continues a run in the long lane with no priority, so it runs before any start", async () => {
    mocks.row = row("GENERATE_PAGE", { planId: "plan-1", pageId: "page-1" });
    await dispatchWorkerGenerationJob("gj-1");
    const options = mocks.long.add.mock.calls[0]![2] as Record<string, unknown>;
    expect(options).not.toHaveProperty("priority");
  });

  it("draws a generation's pictures and cover in the image lane, beside the book's text", async () => {
    mocks.row = row("GENERATE_IMAGE", { planId: "plan-1", pageId: "page-1", prompt: "a fox", keeperToken: "k" });
    await dispatchWorkerGenerationJob("gj-1");
    expect(mocks.long.add).not.toHaveBeenCalled();
    expect(mocks.images.add).toHaveBeenCalledWith("generate-image", expect.anything(), expect.objectContaining({ jobId: "gj-1" }));
    expect(mocks.images.add.mock.calls[0]![2] as Record<string, unknown>).not.toHaveProperty("priority");

    vi.clearAllMocks();
    mocks.row = row("GENERATE_IMAGE", { planId: "plan-1", assetType: "COVER" });
    await dispatchWorkerGenerationJob("gj-1");
    expect(mocks.images.add).toHaveBeenCalledTimes(1);
  });

  it("queues a generation's own compile in the compile lane, never behind the next book's run", async () => {
    mocks.row = row("COMPILE_EXPORT", { planId: "plan-1", exportPublicationProjectStatus: "GENERATING" });
    await dispatchWorkerGenerationJob("gj-1");
    expect(mocks.long.add).not.toHaveBeenCalled();
    expect(mocks.compile.add).toHaveBeenCalledWith("compile-export", expect.anything(), expect.objectContaining({ jobId: "gj-1" }));
    expect(mocks.compile.add.mock.calls[0]![2] as Record<string, unknown>).not.toHaveProperty("priority");
  });

  it("queues the speculative composition prep in the background lane, never in a slot a reader waits for", async () => {
    mocks.row = row("PREPARE_COMPOSITION", { planId: "plan-1" });
    await dispatchWorkerGenerationJob("gj-1");
    expect(mocks.interactive.add).not.toHaveBeenCalled();
    expect(mocks.long.add).not.toHaveBeenCalled();
    expect(mocks.background.add).toHaveBeenCalledWith(
      "prepare-composition",
      expect.objectContaining({ generationJobId: "gj-1", planId: "plan-1" }),
      expect.objectContaining({ jobId: "gj-1" })
    );
    expect(mocks.background.add.mock.calls[0]![2] as Record<string, unknown>).not.toHaveProperty("priority");
  });

  it("re-pushes a picture an older release queued in book-maker into the image lane only once that copy is gone", async () => {
    mocks.row = row("GENERATE_IMAGE", { planId: "plan-1", pageId: "page-1" });
    mocks.long.getJob.mockResolvedValue({ getState: async () => "waiting", remove: vi.fn() });
    await dispatchWorkerGenerationJob("gj-1");
    expect(mocks.images.add).not.toHaveBeenCalled();
  });

  it("re-pushes a row the API created for the interactive lane into the interactive lane", async () => {
    mocks.row = row("WRITING_ASSIST", { assistId: "assist-1" });
    await dispatchWorkerGenerationJob("gj-1");
    expect(mocks.long.add).not.toHaveBeenCalled();
    expect(mocks.interactive.add).toHaveBeenCalledWith("writing-assist", expect.anything(), expect.objectContaining({ jobId: "gj-1" }));
    const options = mocks.interactive.add.mock.calls[0]![2] as Record<string, unknown>;
    expect(options).not.toHaveProperty("priority");
  });

  it("re-pushes a whole-book edit into the long lane as a start, and a short one into the interactive lane", async () => {
    const wholeBook = Array.from({ length: 120 }, (_, index) => index + 1);
    mocks.row = row("APPLY_BOOK_EDIT", { operationId: "op-1", affectedPageIndexes: wholeBook });
    await dispatchWorkerGenerationJob("gj-1");
    expect(mocks.interactive.add).not.toHaveBeenCalled();
    expect(mocks.long.add).toHaveBeenCalledWith(
      "apply-book-edit",
      expect.objectContaining({ affectedPageIndexes: wholeBook }),
      expect.objectContaining({ jobId: "gj-1", priority: 1 })
    );

    vi.clearAllMocks();
    mocks.row = row("APPLY_BOOK_EDIT", { operationId: "op-1", affectedPageIndexes: [3, 4] });
    await dispatchWorkerGenerationJob("gj-1");
    expect(mocks.long.add).not.toHaveBeenCalled();
    expect(mocks.interactive.add).toHaveBeenCalledWith("apply-book-edit", expect.anything(), expect.objectContaining({ jobId: "gj-1" }));
  });

  it("waits while the row's previous delivery is still live in the other lane", async () => {
    // A previous release queued this edit in `book-maker`; it is still running there.
    mocks.row = row("APPLY_BOOK_EDIT", { operationId: "op-1" });
    mocks.long.getJob.mockResolvedValue({ getState: async () => "active", remove: vi.fn() });
    await dispatchWorkerGenerationJob("gj-1");
    expect(mocks.interactive.add).not.toHaveBeenCalled();
    expect(mocks.prisma.generationJob.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ message: "Waiting for the generation queue" }) })
    );
  });

  it("clears a finished copy in any lane before adding, so the add is not swallowed by its id", async () => {
    mocks.row = row("APPLY_BOOK_EDIT", { operationId: "op-1" });
    const finished = { getState: async () => "failed", remove: vi.fn(async () => undefined) };
    mocks.interactive.getJob.mockResolvedValue(finished);
    await dispatchWorkerGenerationJob("gj-1");
    expect(finished.remove).toHaveBeenCalledTimes(1);
    expect(mocks.interactive.add).toHaveBeenCalledTimes(1);
  });
});
