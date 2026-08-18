import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  prisma: {
    project: { findUnique: vi.fn(), update: vi.fn(), updateMany: vi.fn() },
    page: { findMany: vi.fn(), updateMany: vi.fn() },
    planVersion: { findUnique: vi.fn() }
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

import {
  persistPageStoryDelta,
  rebuildProjectStoryState,
  rebuildRolledBackProjectStoryState
} from "./storyStateStore.js";
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

const plan = (promises: string[]) => ({
  title: "Book",
  premise: "Premise",
  audience: "Readers",
  writingComplexity: 5,
  voiceGuide: ["Clear"],
  antiAiRules: ["Specific"],
  chapters: [{ index: 1, title: "One", summary: "Summary", targetPages: 1 }],
  promises,
  illustrationPlan: { cadence: "none", globalStyle: "None" }
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

  it("rebuilds a rollback from the promises on the plan the revert left current", async () => {
    const rebuilt = { promises: [], facts: [], entities: {}, unanswered: [] };
    mocks.prisma.planVersion.findUnique.mockResolvedValue({ planningPackage: plan(["The later journey continues."]) });
    mocks.casRebuildProjectStoryState.mockResolvedValue(rebuilt);

    await expect(rebuildRolledBackProjectStoryState("project-1", "plan-3")).resolves.toBe(rebuilt);

    expect(mocks.casRebuildProjectStoryState).toHaveBeenCalledWith(
      "project-1",
      ["The later journey continues."],
      { currentPlanId: "plan-3" }
    );
  });

  it("guards a rollback rebuild on a project with no current plan", async () => {
    mocks.casRebuildProjectStoryState.mockResolvedValue({ promises: [], facts: [], entities: {}, unanswered: [] });

    await rebuildRolledBackProjectStoryState("project-1", null);

    expect(mocks.prisma.planVersion.findUnique).not.toHaveBeenCalled();
    expect(mocks.casRebuildProjectStoryState).toHaveBeenCalledWith("project-1", [], { currentPlanId: null });
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
