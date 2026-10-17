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
  loadProjectStoryState,
  rebuildProjectStoryState,
  rebuildRolledBackProjectStoryState
} from "./storyStateStore.js";
import { StopRequestedError } from "../runtime/jobTypes.js";

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

  it("reads the stored state, and seeds the plan's promises as open for a book that holds none", async () => {
    const stored = { promises: [], facts: [{ text: "Ada packed.", pageIndex: 2 }], entities: {}, unanswered: [] };
    mocks.prisma.project.findUnique.mockResolvedValueOnce({ storyState: stored });
    await expect(loadProjectStoryState("project-1", ["The lantern will be lit."])).resolves.toEqual(stored);
    mocks.prisma.project.findUnique.mockResolvedValueOnce({ storyState: null });
    await expect(loadProjectStoryState("project-1", ["The lantern will be lit."])).resolves.toMatchObject({
      promises: [{ id: "plan-1", text: "The lantern will be lit.", status: "open" }],
      facts: []
    });
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
});
