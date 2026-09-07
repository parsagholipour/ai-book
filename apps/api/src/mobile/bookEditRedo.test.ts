import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@book-maker/db", async () => (await import("./testing/mobileApiMocks.js")).dbModuleMock());
vi.mock("@book-maker/db/billing", async () => (await import("./testing/mobileApiMocks.js")).billingModuleMock());
vi.mock("../queue.js", async () => (await import("./testing/mobileApiMocks.js")).queueModuleMock());
vi.mock("../projectStatus.js", async () => (await import("./testing/mobileApiMocks.js")).projectStatusModuleMock());

import { casRebuildProjectStoryState } from "@book-maker/db";

import {
  bookEditRedoCandidate,
  canRedoBookEdit,
  classifierAfterRedo,
  pickRedoableBookEdit
} from "./bookEditRedo.js";
import {
  appliedEditOperationRecord,
  approvedPlanRecord,
  bearer,
  buildMobileApp,
  editablePages,
  generatedPages,
  mockAccessTokens,
  mockPrisma,
  projectRecord,
  resetMobileHarness,
  state,
  teardownMobileHarness
} from "./testing/mobileApiHarness.js";

const afterSnapshots = [
  {
    pageId: "page-1",
    pageIndex: 1,
    titleBefore: "Rabbit Starts Fast",
    markdownBefore: "Rabbit runs ahead at the start of the race.",
    summaryBefore: "Rabbit starts the race quickly.",
    revisionBefore: 1,
    titleAfter: "Rabbit Starts Faster",
    markdownAfter: "Rabbit sprints ahead at the start of the race.",
    summaryAfter: "Rabbit starts even faster.",
    revisionAfter: 2
  }
];

function textEdit(overrides: Record<string, unknown> = {}) {
  return appliedEditOperationRecord({
    userMessageId: null,
    assistantMessageId: null,
    snapshots: afterSnapshots,
    _count: { snapshots: 1, archivedSnapshots: 0 },
    ...overrides
  });
}

describe("canRedoBookEdit and pickRedoableBookEdit", () => {
  it("offers Redo only for an undone snapshot-backed edit", () => {
    expect(
      canRedoBookEdit(
        bookEditRedoCandidate(
          textEdit({
            classifier: { undoneAt: "2026-09-07T00:00:00.000Z", redoable: true }
          })
        )
      )
    ).toBe(true);
    expect(canRedoBookEdit(bookEditRedoCandidate(textEdit()))).toBe(false);
  });

  it("refuses a structural undo even when it carries undoneAt", () => {
    expect(
      canRedoBookEdit(
        bookEditRedoCandidate(
          appliedEditOperationRecord({
            kind: "RESTRUCTURE_PAGES",
            snapshots: [],
            _count: { snapshots: 0, archivedSnapshots: 0 },
            classifier: {
              undoneAt: "2026-09-07T00:00:00.000Z",
              redoable: false,
              structuralApplication: {
                action: "delete",
                pageOrderBefore: [{ pageId: "page-1", index: 1 }],
                previousTargetPages: 2,
                appliedAt: "2026-08-15T00:00:00.000Z"
              }
            }
          })
        )
      )
    ).toBe(false);
  });

  it("picks the most recently undone edit, not the newest applied one", () => {
    const older = bookEditRedoCandidate(
      textEdit({
        id: "operation-a",
        createdAt: new Date("2026-06-15T13:00:00.000Z"),
        appliedAt: new Date("2026-06-15T13:01:00.000Z"),
        classifier: { undoneAt: "2026-09-07T00:02:00.000Z", redoable: true }
      })
    );
    const newer = bookEditRedoCandidate(
      textEdit({
        id: "operation-b",
        createdAt: new Date("2026-06-15T13:10:00.000Z"),
        appliedAt: new Date("2026-06-15T13:11:00.000Z"),
        classifier: { undoneAt: "2026-09-07T00:01:00.000Z", redoable: true }
      })
    );
    expect(pickRedoableBookEdit([newer, older])?.id).toBe("operation-a");
  });

  it("drops Redo when a later not-undone edit exists", () => {
    const undone = bookEditRedoCandidate(
      textEdit({
        id: "operation-a",
        createdAt: new Date("2026-06-15T13:00:00.000Z"),
        appliedAt: new Date("2026-06-15T13:01:00.000Z"),
        classifier: { undoneAt: "2026-09-07T00:01:00.000Z", redoable: true }
      })
    );
    const later = bookEditRedoCandidate(
      textEdit({
        id: "operation-c",
        createdAt: new Date("2026-06-15T13:20:00.000Z"),
        appliedAt: new Date("2026-06-15T13:21:00.000Z")
      })
    );
    expect(pickRedoableBookEdit([later, undone])).toBeUndefined();
  });

  it("drops the after-delta stash with undoneAt so a later undo restamps", () => {
    expect(
      classifierAfterRedo({
        undoneAt: "2026-09-07T00:00:00.000Z",
        redoable: true,
        storyDeltasAfter: { "page-1": { factsAdded: ["Stale."] } },
        previousAsset: { id: "asset-1" }
      })
    ).toEqual({ previousAsset: { id: "asset-1" } });
  });
});

describe("redoing an undone book edit", () => {
  beforeEach(resetMobileHarness);
  afterEach(teardownMobileHarness);

  const completeProject = () =>
    projectRecord({
      id: "project-1",
      status: "COMPLETE",
      currentPlanId: "plan-1",
      currentPlan: approvedPlanRecord(),
      pages: generatedPages()
    });

  it("restores after-snapshots and then offers Undo again", async () => {
    mockAccessTokens({ "token-a": "user-a" });
    mockPrisma.project.findFirst.mockResolvedValue(completeProject());
    state.pages = editablePages().map((page) =>
      page.id === "page-1"
        ? {
            ...page,
            title: "Rabbit Starts Faster",
            markdown: "Rabbit sprints ahead at the start of the race.",
            summary: "Rabbit starts even faster.",
            revision: 2
          }
        : page
    );
    state.bookEditOperations.push(textEdit());
    const app = await buildMobileApp();

    const undo = await app.inject({
      method: "POST",
      url: "/api/mobile/projects/project-1/chat/edits/undo",
      headers: bearer("token-a"),
      payload: {}
    });
    expect(undo.statusCode).toBe(200);
    expect(state.pages.find((page) => page.id === "page-1")?.markdown).toBe(
      "Rabbit runs ahead at the start of the race."
    );

    const afterUndo = await app.inject({
      method: "GET",
      url: "/api/mobile/projects/project-1/chat",
      headers: bearer("token-a")
    });
    const undoneCard = (afterUndo.json().operations as Array<{ id: string; canUndo: boolean; canRedo: boolean }>).find(
      (operation) => operation.id === "operation-applied"
    );
    expect(undoneCard).toMatchObject({ canUndo: false, canRedo: true });

    const redo = await app.inject({
      method: "POST",
      url: "/api/mobile/projects/project-1/chat/edits/redo",
      headers: bearer("token-a"),
      payload: {}
    });
    expect(redo.statusCode).toBe(200);
    expect(redo.json().reply.content).toContain("Redo is free");
    expect(redo.json().reply.operationId).toBe("operation-applied");
    expect(redo.json().reply.metadata.redo).toEqual({
      operationId: "operation-applied",
      restoredPageIndexes: [1]
    });
    expect(state.pages.find((page) => page.id === "page-1")?.markdown).toBe(
      "Rabbit sprints ahead at the start of the race."
    );

    const afterRedo = await app.inject({
      method: "GET",
      url: "/api/mobile/projects/project-1/chat",
      headers: bearer("token-a")
    });
    const restoredCard = (afterRedo.json().operations as Array<{ id: string; canUndo: boolean; canRedo: boolean }>).find(
      (operation) => operation.id === "operation-applied"
    );
    expect(restoredCard).toMatchObject({ canUndo: true, canRedo: false });
    await app.close();
  });

  it("answers that there is nothing to redo when no edit has been undone", async () => {
    mockAccessTokens({ "token-a": "user-a" });
    mockPrisma.project.findFirst.mockResolvedValue(completeProject());
    state.pages = editablePages();
    state.bookEditOperations.push(textEdit());
    const app = await buildMobileApp();

    const redo = await app.inject({
      method: "POST",
      url: "/api/mobile/projects/project-1/chat/edits/redo",
      headers: bearer("token-a"),
      payload: {}
    });
    expect(redo.statusCode).toBe(200);
    expect(redo.json().reply.content).toContain("no undone edit");
    expect(redo.json().reply.operationId).toBeNull();
    expect(redo.json().reply.metadata.redo).toBeUndefined();
    await app.close();
  });

  it("does not offer Redo for an undone structural edit", async () => {
    mockAccessTokens({ "token-a": "user-a" });
    mockPrisma.project.findFirst.mockResolvedValue(completeProject());
    state.bookEditOperations.push(
      appliedEditOperationRecord({
        id: "operation-structural",
        kind: "RESTRUCTURE_PAGES",
        request: "Delete page 2.",
        creditsCharged: 0,
        snapshots: [],
        _count: { snapshots: 0, archivedSnapshots: 0 },
        classifier: {
          undoneAt: "2026-09-07T00:00:00.000Z",
          redoable: false,
          structuralApplication: {
            action: "delete",
            pageOrderBefore: [{ pageId: "page-1", index: 1 }],
            previousTargetPages: 2,
            appliedAt: "2026-08-15T00:00:00.000Z"
          }
        }
      })
    );
    const app = await buildMobileApp();

    const chat = await app.inject({
      method: "GET",
      url: "/api/mobile/projects/project-1/chat",
      headers: bearer("token-a")
    });
    expect(
      (chat.json().operations as Array<{ id: string; canRedo: boolean }>).find(
        (operation) => operation.id === "operation-structural"
      )?.canRedo
    ).toBe(false);
    await app.close();
  });

  it("turns Redo off when a later edit has been applied", async () => {
    mockAccessTokens({ "token-a": "user-a" });
    mockPrisma.project.findFirst.mockResolvedValue(completeProject());
    state.bookEditOperations.push(
      textEdit({
        id: "operation-a",
        createdAt: new Date("2026-06-15T13:00:00.000Z"),
        appliedAt: new Date("2026-06-15T13:01:00.000Z"),
        classifier: { undoneAt: "2026-09-07T00:01:00.000Z", redoable: true }
      }),
      textEdit({
        id: "operation-c",
        createdAt: new Date("2026-06-15T13:20:00.000Z"),
        appliedAt: new Date("2026-06-15T13:21:00.000Z"),
        request: "Make page 1 warmer."
      })
    );
    const app = await buildMobileApp();

    const chat = await app.inject({
      method: "GET",
      url: "/api/mobile/projects/project-1/chat",
      headers: bearer("token-a")
    });
    const operations = chat.json().operations as Array<{ id: string; canUndo: boolean; canRedo: boolean }>;
    expect(operations.find((operation) => operation.id === "operation-a")).toMatchObject({
      canUndo: false,
      canRedo: false
    });
    expect(operations.find((operation) => operation.id === "operation-c")).toMatchObject({
      canUndo: true,
      canRedo: false
    });
    await app.close();
  });

  it("unlinks the demoted dest hero and restores dest's moved prompt on redo", async () => {
    mockAccessTokens({ "token-a": "user-a" });
    mockPrisma.project.findFirst.mockResolvedValue(completeProject());
    mockPrisma.imageAsset.updateMany.mockResolvedValue({ count: 1 });
    state.bookEditOperations.push(
      appliedEditOperationRecord({
        id: "op-move",
        kind: "MOVE_IMAGE",
        request: "Move the picture to page 2",
        creditsCharged: 0,
        classifier: {
          previousAsset: {
            id: "asset-moved",
            pageId: "page-1",
            destPageId: "page-2",
            path: "http://localhost:4001/assets/images/project-1/page-1.jpg",
            prompt: "a dragon",
            imagePrompt: "a dragon",
            destImagePrompt: "a fox"
          },
          demotedAsset: {
            id: "asset-dest",
            pageId: "page-2",
            path: "http://localhost:4001/assets/images/project-1/page-2.jpg",
            prompt: "a fox",
            imagePrompt: "a fox"
          }
        },
        snapshots: [
          {
            pageId: "page-1",
            pageIndex: 1,
            titleBefore: "One",
            markdownBefore: "Prose.",
            summaryBefore: "S",
            revisionBefore: 1,
            titleAfter: "One",
            markdownAfter: "Prose.",
            summaryAfter: "S",
            revisionAfter: 2
          },
          {
            pageId: "page-2",
            pageIndex: 2,
            titleBefore: "Two",
            markdownBefore: "Later.",
            summaryBefore: "T",
            revisionBefore: 1,
            titleAfter: "Two",
            markdownAfter: "Later.\n\n![a fox](/assets/images/project-1/page-2.jpg)",
            summaryAfter: "T",
            revisionAfter: 2
          }
        ],
        _count: { snapshots: 2, archivedSnapshots: 0 }
      })
    );
    state.pages.push(
      {
        id: "page-1",
        projectId: "project-1",
        index: 1,
        title: "One",
        markdown: "Prose.",
        summary: "S",
        imagePrompt: null,
        revision: 2,
        status: "COMPLETED"
      },
      {
        id: "page-2",
        projectId: "project-1",
        index: 2,
        title: "Two",
        markdown: "Later.\n\n![a fox](/assets/images/project-1/page-2.jpg)",
        summary: "T",
        imagePrompt: "a dragon",
        revision: 2,
        status: "COMPLETED"
      }
    );
    const app = await buildMobileApp();

    const undo = await app.inject({
      method: "POST",
      url: "/api/mobile/projects/project-1/chat/edits/undo",
      headers: bearer("token-a"),
      payload: {}
    });
    expect(undo.statusCode).toBe(200);
    mockPrisma.imageAsset.updateMany.mockClear();
    mockPrisma.imageAsset.updateMany.mockResolvedValue({ count: 1 });

    const redo = await app.inject({
      method: "POST",
      url: "/api/mobile/projects/project-1/chat/edits/redo",
      headers: bearer("token-a"),
      payload: {}
    });
    expect(redo.statusCode).toBe(200);
    expect(mockPrisma.imageAsset.updateMany).toHaveBeenCalledWith({
      where: { id: "asset-moved", projectId: "project-1" },
      data: expect.objectContaining({ pageId: "page-2" })
    });
    expect(mockPrisma.imageAsset.updateMany).toHaveBeenCalledWith({
      where: { id: "asset-dest", projectId: "project-1" },
      data: { pageId: null }
    });
    expect(state.pages.find((page) => page.id === "page-2")?.imagePrompt).toBe("a dragon");
    expect(state.pages.find((page) => page.id === "page-1")?.imagePrompt).toBeNull();
    await app.close();
  });

  it("restores the after storyDelta Redo stashed at undo, then rebuilds", async () => {
    mockAccessTokens({ "token-a": "user-a" });
    mockPrisma.project.findFirst.mockResolvedValue(completeProject());
    const storyDeltaBefore = { factsAdded: ["The lantern is green."] };
    const storyDeltaAfter = { factsAdded: ["The lantern is red."] };
    state.pages = editablePages().map((page) =>
      page.id === "page-1"
        ? {
            ...page,
            title: "Rabbit Starts Faster",
            markdown: "Rabbit sprints ahead at the start of the race.",
            summary: "Rabbit starts even faster.",
            revision: 2,
            storyDelta: storyDeltaAfter
          }
        : page
    );
    state.bookEditOperations.push(
      textEdit({
        snapshots: afterSnapshots.map((snapshot) =>
          snapshot.pageId === "page-1" ? { ...snapshot, storyDeltaBefore } : snapshot
        )
      })
    );
    const app = await buildMobileApp();

    const undo = await app.inject({
      method: "POST",
      url: "/api/mobile/projects/project-1/chat/edits/undo",
      headers: bearer("token-a"),
      payload: {}
    });
    expect(undo.statusCode).toBe(200);
    expect(state.pages.find((page) => page.id === "page-1")?.storyDelta).toEqual(storyDeltaBefore);
    expect(
      (state.bookEditOperations.find((operation) => operation.id === "operation-applied") as { classifier?: unknown })
        ?.classifier
    ).toEqual(
      expect.objectContaining({
        storyDeltasAfter: { "page-1": storyDeltaAfter }
      })
    );

    vi.mocked(casRebuildProjectStoryState).mockClear();
    const redo = await app.inject({
      method: "POST",
      url: "/api/mobile/projects/project-1/chat/edits/redo",
      headers: bearer("token-a"),
      payload: {}
    });
    expect(redo.statusCode).toBe(200);
    expect(state.pages.find((page) => page.id === "page-1")?.storyDelta).toEqual(storyDeltaAfter);
    expect(state.pages.find((page) => page.id === "page-1")?.storyDelta).not.toEqual(storyDeltaBefore);
    expect(casRebuildProjectStoryState).toHaveBeenCalledWith("project-1", expect.any(Array));
    expect(
      (state.bookEditOperations.find((operation) => operation.id === "operation-applied") as { classifier?: unknown })
        ?.classifier
    ).not.toHaveProperty("storyDeltasAfter");
    await app.close();
  });

  it("leaves page storyDelta alone when a legacy undo never stamped the after", async () => {
    mockAccessTokens({ "token-a": "user-a" });
    mockPrisma.project.findFirst.mockResolvedValue(completeProject());
    const storyDeltaBefore = { factsAdded: ["The lantern is green."] };
    state.pages = editablePages().map((page) =>
      page.id === "page-1"
        ? {
            ...page,
            title: "Rabbit Starts Fast",
            markdown: "Rabbit runs ahead at the start of the race.",
            summary: "Rabbit starts the race quickly.",
            revision: 2,
            storyDelta: storyDeltaBefore
          }
        : page
    );
    state.bookEditOperations.push(
      textEdit({
        classifier: { undoneAt: "2026-09-07T00:00:00.000Z", redoable: true },
        snapshots: afterSnapshots.map((snapshot) =>
          snapshot.pageId === "page-1" ? { ...snapshot, storyDeltaBefore } : snapshot
        )
      })
    );
    const app = await buildMobileApp();

    const redo = await app.inject({
      method: "POST",
      url: "/api/mobile/projects/project-1/chat/edits/redo",
      headers: bearer("token-a"),
      payload: {}
    });
    expect(redo.statusCode).toBe(200);
    expect(state.pages.find((page) => page.id === "page-1")?.markdown).toBe(
      "Rabbit sprints ahead at the start of the race."
    );
    expect(state.pages.find((page) => page.id === "page-1")?.storyDelta).toEqual(storyDeltaBefore);
    expect(mockPrisma.page.update).toHaveBeenCalledWith({
      where: { id: "page-1" },
      data: expect.not.objectContaining({ storyDelta: expect.anything() })
    });
    await app.close();
  });
});
