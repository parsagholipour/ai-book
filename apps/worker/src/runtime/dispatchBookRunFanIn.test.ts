import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Job } from "bullmq";

// A generation's compile waits for its book run, and the run's own completion
// fans in last. These tests drive `maybeEnqueueCompile` over a small stateful
// row store, because the property under test is about orderings: whichever of
// the run and its last unit writes COMPLETED second must be the one that
// queues the compile, and nothing may queue it while the run is still open.

type Row = Record<string, unknown> & { id: string; type: string; status: string; dedupeKey?: string };

const mocks = vi.hoisted(() => ({
  world: { bookRuns: 1, images: 0, pages: 0, coverAssets: 1, status: "GENERATING", rows: [] as Row[], createdWhileRunOpen: 0 },
  queueAdd: vi.fn(),
  prisma: {
    project: { findUnique: vi.fn(), findMany: vi.fn() },
    planVersion: { findUnique: vi.fn() },
    page: { findMany: vi.fn() },
    imageAsset: { count: vi.fn(), findFirst: vi.fn(async () => null) },
    generationJob: { findUnique: vi.fn(), findFirst: vi.fn(), findMany: vi.fn(), create: vi.fn(), update: vi.fn(), count: vi.fn() },
    bookEditOperation: { findFirst: vi.fn() }
  }
}));

vi.mock("@book-maker/db", () => ({ prisma: mocks.prisma, Prisma: { PrismaClientKnownRequestError: class extends Error {} } }));
vi.mock("./queue.js", () => {
  const queue = { add: mocks.queueAdd, getJob: vi.fn(async () => undefined) };
  return { queue, queueNamed: () => queue, allLaneQueues: [queue] };
});
vi.mock("./config.js", () => ({ config: { MAX_PARALLEL_PAGE_JOBS: 3 } }));
vi.mock("../generation/projectInput.js", () => ({
  inputForPlanVersion: () => ({
    prompt: "A detailed field guide to backyard birds.", category: "SCIENCE", targetPages: 2, complexity: 5,
    temperature: 0.8, language: "en", mediaSettings: { coverArtSource: "ai", finalReview: true }
  })
}));

import { maybeCompileAfterCompletedJob, maybeEnqueueCompile } from "./dispatch.js";

const { world } = mocks;
const data = { projectId: "project-1", planId: "plan-1", generationJobId: "gj-unit" };
const completed = (name: string) => maybeCompileAfterCompletedJob({ name, data } as unknown as Job);
const compiles = () => world.rows.filter((row) => row.type === "COMPILE_EXPORT");
const covers = () => world.rows.filter((row) => row.type === "GENERATE_IMAGE");

beforeEach(() => {
  vi.clearAllMocks();
  Object.assign(world, { bookRuns: 1, images: 0, pages: 0, coverAssets: 1, status: "GENERATING", rows: [], createdWhileRunOpen: 0 });
  mocks.prisma.project.findUnique.mockImplementation(async () => ({ status: world.status, contentRevision: 3 }));
  mocks.prisma.planVersion.findUnique.mockResolvedValue({ id: "plan-1", inputSnapshot: {} });
  mocks.prisma.page.findMany.mockResolvedValue([
    { id: "page-1", index: 1, status: "COMPLETED", markdown: "One.", revision: 1 },
    { id: "page-2", index: 2, status: "COMPLETED", markdown: "Two.", revision: 1 }
  ]);
  mocks.prisma.imageAsset.count.mockImplementation(async () => world.coverAssets);
  mocks.prisma.bookEditOperation.findFirst.mockResolvedValue(null);
  mocks.prisma.generationJob.findFirst.mockResolvedValue(null);
  mocks.prisma.generationJob.count.mockImplementation(async ({ where }: { where: { type: string } }) =>
    where.type === "GENERATE_BOOK" ? world.bookRuns : where.type === "GENERATE_IMAGE" ? world.images : where.type === "GENERATE_PAGE" ? world.pages : 0);
  mocks.prisma.generationJob.findMany.mockImplementation(async ({ where }: { where: { type?: string; status?: unknown } }) =>
    where.type === "COMPILE_EXPORT" && where.status ? compiles().map((row) => ({ contentRevision: row.contentRevision, payload: row.payload })) : []);
  mocks.prisma.generationJob.findUnique.mockImplementation(async ({ where }: { where: { id?: string; dedupeKey?: string } }) =>
    world.rows.find((row) => (where.id ? row.id === where.id : row.dedupeKey === where.dedupeKey)) ?? null);
  mocks.prisma.generationJob.create.mockImplementation(async ({ data: created }: { data: Record<string, unknown> }) => {
    const row = { id: `gj-${world.rows.length + 1}`, status: "QUEUED", bullJobId: null, dispatchAttempts: 0, ...created } as unknown as Row;
    if (row.type === "COMPILE_EXPORT" && world.bookRuns > 0) world.createdWhileRunOpen += 1;
    world.rows.push(row);
    return row;
  });
  mocks.prisma.generationJob.update.mockImplementation(async ({ where, data: patch }: { where: { id: string }; data: object }) =>
    Object.assign(world.rows.find((row) => row.id === where.id)!, patch));
  mocks.queueAdd.mockResolvedValue({ id: "bull-1" });
});

describe("a generation's compile and its book run", () => {
  it("holds the compile while the run is open, its own in-handler call included", async () => {
    // A text-only book: nothing but the run itself is open when it asks.
    expect(await maybeEnqueueCompile("project-1", "plan-1")).toBe("waiting");
    expect(compiles()).toHaveLength(0);
    expect(mocks.prisma.generationJob.count).toHaveBeenCalledWith({
      where: { projectId: "project-1", type: "GENERATE_BOOK", status: { in: ["QUEUED", "ACTIVE"] } }
    });

    world.bookRuns = 0;
    await completed("generate-book");
    expect(compiles()).toHaveLength(1);
    expect(compiles()[0]!.payload).toMatchObject({ planId: "plan-1", contentRevision: 3, exportPublicationProjectStatus: "GENERATING" });
  });

  it("still queues a missing cover while the run is open, so the picture is not held for the run's tail", async () => {
    world.coverAssets = 0;
    expect(await maybeEnqueueCompile("project-1", "plan-1")).toBe("waiting");
    expect(covers()).toHaveLength(1);
    expect(compiles()).toHaveLength(0);
  });

  // Every order the two terminal writes and their two fan-ins can interleave in,
  // with each unit's fan-in after its own COMPLETED write (`processJob`'s order).
  const orders = [
    ["run-done", "run-fan", "unit-done", "unit-fan"],
    ["run-done", "unit-done", "run-fan", "unit-fan"],
    ["run-done", "unit-done", "unit-fan", "run-fan"],
    ["unit-done", "unit-fan", "run-done", "run-fan"],
    ["unit-done", "run-done", "unit-fan", "run-fan"],
    ["unit-done", "run-done", "run-fan", "unit-fan"]
  ];
  describe.each([
    ["the last picture or the cover", "generate-image", "images"],
    ["a sequential run's last page job", "generate-page", "pages"]
  ] as const)("against %s", (_label, unit, counter) => {
    it.each(orders.map((order) => [order.join(" → "), order]))("queues exactly one compile, never while the run is open: %s", async (_name, order) => {
      world[counter] = 1;
      for (const step of order as string[]) {
        if (step === "run-done") world.bookRuns = 0;
        else if (step === "unit-done") world[counter] = 0;
        else await completed(step === "run-fan" ? "generate-book" : unit);
      }
      expect(compiles()).toHaveLength(1);
      expect(world.createdWhileRunOpen).toBe(0);
    });
  });

  it("is the race the gate closes: a unit finishing first no longer compiles under a run still writing", async () => {
    // Before the gate, this fan-in queued the compile while the run was still
    // writing its story deltas, and the compile found no grouped-review snapshot
    // (it reads only a COMPLETED generate-book) and checked coverage against
    // promises the deltas had not yet paid.
    world.images = 0;
    await completed("generate-image");
    expect(compiles()).toHaveLength(0);
  });

  it("does not hold a compile that no book run owns", async () => {
    // Edits, continuations, imports and replans queue their compiles with no
    // generate-book row open on the project.
    world.bookRuns = 0;
    world.status = "EDITING";
    expect(await maybeEnqueueCompile("project-1", "plan-1", { skipFinalReview: true }, { contentRevision: 3 })).toBe("compile");
    expect(compiles()).toHaveLength(1);
  });
});
