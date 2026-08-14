import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  prisma: {
    project: { findUnique: vi.fn(), update: vi.fn(), updateMany: vi.fn() },
    page: { findMany: vi.fn(), updateMany: vi.fn() }
  },
  casRebuildProjectStoryState: vi.fn(),
  rebuildStoryStateFromPages: vi.fn()
}));

vi.mock("@book-maker/db", () => ({
  prisma: mocks.prisma,
  Prisma: { DbNull: "DbNull", JsonNull: "JsonNull" },
  casRebuildProjectStoryState: mocks.casRebuildProjectStoryState,
  rebuildStoryStateFromPages: mocks.rebuildStoryStateFromPages
}));

import { persistPageStoryDelta, rebuildProjectStoryState } from "./storyStateStore.js";
import { StopRequestedError } from "../runtime/jobTypes.js";
import type { StoryDelta } from "@book-maker/core";

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

describe("storyStateStore", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("rebuilds through the shared CAS helper", async () => {
    mocks.casRebuildProjectStoryState.mockResolvedValue({
      promises: [],
      facts: [{ text: "It is raining.", pageIndex: 1 }],
      entities: {},
      unanswered: []
    });

    const state = await rebuildProjectStoryState("project-1", ["The lantern will be lit."]);

    expect(mocks.casRebuildProjectStoryState).toHaveBeenCalledWith("project-1", ["The lantern will be lit."]);
    expect(state?.facts[0]).toEqual({ text: "It is raining.", pageIndex: 1 });
  });

  it("rethrows a stop request from the shared rebuild", async () => {
    mocks.casRebuildProjectStoryState.mockRejectedValue(new StopRequestedError());
    await expect(rebuildProjectStoryState("project-1")).rejects.toBeInstanceOf(StopRequestedError);
  });

  it("applies the page delta onto current project state without scanning every page", async () => {
    mocks.prisma.page.updateMany.mockResolvedValue({ count: 1 });
    mocks.prisma.project.findUnique.mockResolvedValue({
      storyState: {
        promises: [],
        facts: [{ text: "It is raining.", pageIndex: 1 }],
        entities: {},
        unanswered: []
      }
    });
    mocks.prisma.project.updateMany.mockResolvedValue({ count: 1 });

    const state = await persistPageStoryDelta({
      projectId: "project-1",
      pageIndex: 2,
      delta: emptyDelta({ factsAdded: ["Ada packed."] }),
      seedPromises: []
    });

    expect(mocks.casRebuildProjectStoryState).not.toHaveBeenCalled();
    expect(mocks.prisma.page.updateMany).toHaveBeenCalledTimes(1);
    expect(state?.facts.map((fact) => fact.text)).toEqual(["It is raining.", "Ada packed."]);
  });

  it("retries the project CAS when a sibling page wins the write", async () => {
    mocks.prisma.page.updateMany.mockResolvedValue({ count: 1 });
    mocks.prisma.project.findUnique
      .mockResolvedValueOnce({ storyState: null })
      .mockResolvedValueOnce({ storyState: { promises: [], facts: [], entities: {}, unanswered: [] } });
    mocks.prisma.project.updateMany.mockResolvedValueOnce({ count: 0 }).mockResolvedValueOnce({ count: 1 });

    const state = await persistPageStoryDelta({
      projectId: "project-1",
      pageIndex: 1,
      delta: emptyDelta({ factsAdded: ["Ada packed."] }),
      seedPromises: []
    });

    expect(mocks.casRebuildProjectStoryState).not.toHaveBeenCalled();
    expect(mocks.prisma.project.updateMany).toHaveBeenCalledTimes(2);
    expect(mocks.prisma.project.updateMany.mock.calls[0]?.[0].where).toEqual({
      id: "project-1",
      storyState: { equals: "DbNull" }
    });
    expect(state?.facts[0]?.text).toBe("Ada packed.");
  });

  it("falls back to an index-order rebuild when persist CAS retries are exhausted", async () => {
    mocks.prisma.page.updateMany.mockResolvedValue({ count: 1 });
    mocks.prisma.project.findUnique.mockResolvedValue({ storyState: null });
    mocks.prisma.project.updateMany.mockResolvedValue({ count: 0 });
    mocks.casRebuildProjectStoryState.mockResolvedValue({
      promises: [],
      facts: [{ text: "Ada packed.", pageIndex: 1 }],
      entities: {},
      unanswered: []
    });

    const state = await persistPageStoryDelta({
      projectId: "project-1",
      pageIndex: 1,
      delta: emptyDelta({ factsAdded: ["Ada packed."] }),
      seedPromises: []
    });

    expect(mocks.casRebuildProjectStoryState).toHaveBeenCalledWith("project-1", []);
    expect(state?.facts[0]?.text).toBe("Ada packed.");
  });
});
