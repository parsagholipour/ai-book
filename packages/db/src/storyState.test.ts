import { beforeEach, describe, expect, it, vi } from "vitest";
import type { StoryDelta } from "@book-maker/core";

const mocks = vi.hoisted(() => ({
  prisma: {
    project: { findUnique: vi.fn(), updateMany: vi.fn() },
    page: { findMany: vi.fn() }
  }
}));

vi.mock("./client.ts", () => ({
  prisma: mocks.prisma,
  Prisma: { DbNull: "DbNull", JsonNull: "JsonNull" }
}));

const { casRebuildProjectStoryState, rebuildStoryStateFromPages } = await import("./storyState.ts");

const emptyDelta = (overrides: Partial<StoryDelta> = {}): StoryDelta => ({
  promisesOpened: [],
  promisesPaid: [],
  promisesBroken: [],
  factsAdded: [],
  entities: {},
  unansweredAdded: [],
  unansweredResolved: [],
  ...overrides
});

describe("rebuildStoryStateFromPages", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("rebuilds from page deltas in index order", async () => {
    mocks.prisma.page.findMany.mockResolvedValue([
      { index: 2, storyDelta: emptyDelta({ promisesPaid: ["The lantern will be lit."] }) },
      { index: 1, storyDelta: emptyDelta({ factsAdded: ["It is raining."] }) }
    ]);

    const state = await rebuildStoryStateFromPages("project-1", ["The lantern will be lit."]);

    expect(state.promises[0]?.status).toBe("paid");
    expect(state.facts[0]).toEqual({ text: "It is raining.", pageIndex: 1 });
  });
});

describe("casRebuildProjectStoryState", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("writes the rebuilt pack when the CAS claim succeeds", async () => {
    mocks.prisma.project.findUnique.mockResolvedValue({ storyState: null });
    mocks.prisma.project.updateMany.mockResolvedValue({ count: 1 });
    mocks.prisma.page.findMany.mockResolvedValue([
      { index: 1, storyDelta: emptyDelta({ factsAdded: ["Ada packed."] }) }
    ]);

    const state = await casRebuildProjectStoryState("project-1", []);

    expect(mocks.prisma.project.updateMany).toHaveBeenCalledTimes(1);
    expect(state?.facts[0]?.text).toBe("Ada packed.");
  });

  it("retries the project CAS when a sibling write wins", async () => {
    mocks.prisma.project.findUnique
      .mockResolvedValueOnce({ storyState: null })
      .mockResolvedValueOnce({ storyState: { promises: [], facts: [], entities: {}, unanswered: [] } });
    mocks.prisma.project.updateMany.mockResolvedValueOnce({ count: 0 }).mockResolvedValueOnce({ count: 1 });
    mocks.prisma.page.findMany.mockResolvedValue([
      { index: 1, storyDelta: emptyDelta({ factsAdded: ["Ada packed."] }) }
    ]);

    const state = await casRebuildProjectStoryState("project-1", []);

    expect(mocks.prisma.project.updateMany).toHaveBeenCalledTimes(2);
    expect(mocks.prisma.project.updateMany.mock.calls[0]?.[0].where).toEqual({
      id: "project-1",
      storyState: { equals: "DbNull" }
    });
    expect(state?.facts[0]?.text).toBe("Ada packed.");
  });

  it("does not publish a guarded rebuild after the project advances to another plan", async () => {
    mocks.prisma.project.findUnique
      .mockResolvedValueOnce({ storyState: null, currentPlanId: "plan-1" })
      .mockResolvedValueOnce({ storyState: null, currentPlanId: "plan-3" });
    mocks.prisma.project.updateMany.mockResolvedValue({ count: 0 });
    mocks.prisma.page.findMany.mockResolvedValue([]);

    const state = await casRebuildProjectStoryState("project-1", ["Old promise"], {
      currentPlanId: "plan-1"
    });

    expect(state).toBeNull();
    expect(mocks.prisma.page.findMany).toHaveBeenCalledTimes(1);
    expect(mocks.prisma.project.updateMany).toHaveBeenCalledTimes(1);
  });

  it("includes the restored plan in the same CAS that publishes story state", async () => {
    mocks.prisma.project.findUnique.mockResolvedValue({ storyState: null, currentPlanId: "plan-1" });
    mocks.prisma.project.updateMany.mockResolvedValue({ count: 1 });
    mocks.prisma.page.findMany.mockResolvedValue([]);

    await casRebuildProjectStoryState("project-1", [], { currentPlanId: "plan-1" });

    expect(mocks.prisma.project.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "project-1", currentPlanId: "plan-1", storyState: { equals: "DbNull" } }
      })
    );
  });
});
