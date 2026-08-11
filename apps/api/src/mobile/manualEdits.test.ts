import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@book-maker/db", async () => (await import("./testing/mobileApiMocks.js")).dbModuleMock());
vi.mock("@book-maker/db/billing", async () => (await import("./testing/mobileApiMocks.js")).billingModuleMock());
vi.mock("../queue.js", async () => (await import("./testing/mobileApiMocks.js")).queueModuleMock());
vi.mock("../projectStatus.js", async () => (await import("./testing/mobileApiMocks.js")).projectStatusModuleMock());

import { PRESENTATION_ONLY_RECOMPILE } from "@book-maker/core";
import { enqueueGenerationJob } from "../queue.js";
import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  appliedEditOperationRecord,
  bearer,
  buildMobileApp,
  detachedRepairJobRow,
  editablePages,
  jobRecord,
  mockAccessTokens,
  mockPrisma,
  openJobRow,
  projectRecord,
  resetMobileHarness,
  state,
  teardownMobileHarness,
  writeProjectFile
} from "./testing/mobileApiHarness.js";

describe("mobile editable book and manual edits", () => {
  beforeEach(resetMobileHarness);
  afterEach(teardownMobileHarness);

  it("returns full page markdown for the owner's editable book", async () => {
    mockAccessTokens({ "token-a": "user-a" });
    mockPrisma.project.findFirst.mockResolvedValue(
      projectRecord({
        id: "project-1",
        status: "COMPLETE",
        pages: editablePages().map(({ projectId, summary, ...page }) => page)
      })
    );
    const app = await buildMobileApp();

    const response = await app.inject({
      method: "GET",
      url: "/api/mobile/projects/project-1/book",
      headers: bearer("token-a")
    });
    const body = response.json();

    expect(response.statusCode).toBe(200);
    expect(body.book.projectId).toBe("project-1");
    expect(body.book.pages).toEqual([
      expect.objectContaining({
        id: "page-1",
        index: 1,
        markdown: "Rabbit runs ahead at the start of the race.",
        revision: 1
      }),
      expect.objectContaining({ id: "page-2", index: 2, revision: 1 })
    ]);
    await app.close();
  });

  it("refuses editable book content before generation completes", async () => {
    mockAccessTokens({ "token-a": "user-a" });
    mockPrisma.project.findFirst.mockResolvedValue(
      projectRecord({ id: "project-1", status: "GENERATING", pages: [] })
    );
    const app = await buildMobileApp();

    const response = await app.inject({
      method: "GET",
      url: "/api/mobile/projects/project-1/book",
      headers: bearer("token-a")
    });

    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe("BOOK_NOT_READY");
    await app.close();
  });

  it("saves a manual edit, snapshots pages, refreshes exports, and posts a saved-export message", async () => {
    mockAccessTokens({ "token-a": "user-a" });
    mockPrisma.project.findFirst.mockResolvedValue(
      projectRecord({ id: "project-1", status: "COMPLETE", currentPlanId: "plan-1" })
    );
    state.pages = editablePages();
    writeProjectFile(state.bookStorageDir, "project-1", "book.pdf", "%PDF-stale");
    vi.mocked(enqueueGenerationJob).mockResolvedValueOnce(jobRecord({ id: "job-compile", type: "COMPILE_EXPORT" }));
    const app = await buildMobileApp();

    const response = await app.inject({
      method: "POST",
      url: "/api/mobile/projects/project-1/manual-edits",
      headers: bearer("token-a"),
      payload: {
        pages: [
          {
            id: "page-1",
            title: "Rabbit Starts Fast",
            markdown: "Rabbit sprints ahead while Turtle takes one steady step.",
            baseRevision: 1
          }
        ]
      }
    });
    const body = response.json();

    expect(response.statusCode).toBe(200);
    expect(body.operation).toMatchObject({
      kind: "manual_edit",
      status: "applied",
      creditsCharged: 0,
      affectedPageIndexes: [1]
    });
    expect(body.savedExportMessage.role).toBe("assistant");
    expect(body.savedExportMessage.metadata.manualEdit).toMatchObject({
      pageIndexes: [1],
      editCount: 1
    });
    expect(state.pages.find((page) => page.id === "page-1")).toMatchObject({
      markdown: "Rabbit sprints ahead while Turtle takes one steady step.",
      revision: 2
    });
    expect(state.pageEditSnapshots).toEqual([
      expect.objectContaining({
        pageId: "page-1",
        markdownBefore: "Rabbit runs ahead at the start of the race.",
        markdownAfter: "Rabbit sprints ahead while Turtle takes one steady step.",
        revisionBefore: 1,
        revisionAfter: 2
      })
    ]);
    expect(existsSync(join(state.bookStorageDir!, "project-1", "book.pdf"))).toBe(false);
    expect(vi.mocked(enqueueGenerationJob)).toHaveBeenCalledWith(expect.objectContaining({
      projectId: "project-1",
      type: "COMPILE_EXPORT",
      payload: expect.objectContaining({ planId: "plan-1", skipFinalReview: true })
    }));
    // A manual edit rewrote the page, so this recompile keeps the verdict:
    // findings about the text the reader just replaced may not outlive it.
    // Only a presentation reprint of unchanged prose opts out.
    expect(vi.mocked(enqueueGenerationJob).mock.calls[0]?.[0].payload).not.toHaveProperty(
      PRESENTATION_ONLY_RECOMPILE
    );
    expect(mockPrisma.project.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: "project-1" },
      data: expect.objectContaining({ status: "EDITING" })
    }));
    expect(mockPrisma.project.update).not.toHaveBeenCalledWith({
      where: { id: "project-1" },
      data: { status: "COMPLETE" }
    });
    expect(mockPrisma.project.update.mock.invocationCallOrder[0]).toBeLessThan(
      mockPrisma.page.update.mock.invocationCallOrder[0] as number
    );
    await app.close();
  });

  it("reads an applied edit back as a page-by-page diff", async () => {
    mockAccessTokens({ "token-a": "user-a" });
    mockPrisma.project.findFirst.mockResolvedValue(projectRecord({ id: "project-1" }));
    state.bookEditOperations.push(appliedEditOperationRecord());
    state.pageEditSnapshots.push({
      id: "snapshot-1",
      projectId: "project-1",
      pageId: "page-1",
      operationId: "operation-applied",
      pageIndex: 1,
      titleBefore: "Night Falls",
      markdownBefore: "The city slept under a heavy night sky.",
      summaryBefore: "Night.",
      revisionBefore: 1,
      titleAfter: "Day Breaks",
      markdownAfter: "The city slept under a heavy day sky.",
      summaryAfter: "Day.",
      revisionAfter: 2
    });
    const app = await buildMobileApp();

    const response = await app.inject({
      method: "GET",
      url: "/api/mobile/projects/project-1/operations/operation-applied/changes",
      headers: bearer("token-a")
    });
    const changes = response.json().changes;

    expect(response.statusCode).toBe(200);
    expect(changes).toMatchObject({
      operationId: "operation-applied",
      status: "applied",
      undone: false,
      addedWords: 1,
      removedWords: 1
    });
    expect(changes.pages).toHaveLength(1);
    expect(changes.pages[0]).toMatchObject({
      pageIndex: 1,
      titleBefore: "Night Falls",
      titleAfter: "Day Breaks",
      titleChanged: true
    });
    // The word that moved, not the whole paragraph reprinted twice.
    expect(changes.pages[0].blocks).toEqual([
      {
        type: "changed",
        runs: [
          { type: "equal", text: "The city slept under a heavy " },
          { type: "delete", text: "night " },
          { type: "insert", text: "day " },
          { type: "equal", text: "sky." }
        ]
      }
    ]);
    await app.close();
  });

  it("omits pages an edit left untouched", async () => {
    mockAccessTokens({ "token-a": "user-a" });
    mockPrisma.project.findFirst.mockResolvedValue(projectRecord({ id: "project-1" }));
    state.bookEditOperations.push(appliedEditOperationRecord());
    state.pageEditSnapshots.push({
      id: "snapshot-1",
      projectId: "project-1",
      pageId: "page-1",
      operationId: "operation-applied",
      pageIndex: 1,
      titleBefore: "Same",
      markdownBefore: "Nothing moved on this page.",
      summaryBefore: "Same.",
      revisionBefore: 1,
      titleAfter: "Same",
      markdownAfter: "Nothing moved on this page.",
      summaryAfter: "Same.",
      revisionAfter: 2
    });
    const app = await buildMobileApp();

    const response = await app.inject({
      method: "GET",
      url: "/api/mobile/projects/project-1/operations/operation-applied/changes",
      headers: bearer("token-a")
    });

    expect(response.json().changes.pages).toEqual([]);
    await app.close();
  });

  it("does not read another user's edit", async () => {
    mockAccessTokens({ "token-a": "user-a" });
    mockPrisma.project.findFirst.mockResolvedValue(null);
    const app = await buildMobileApp();

    const response = await app.inject({
      method: "GET",
      url: "/api/mobile/projects/project-1/operations/operation-applied/changes",
      headers: bearer("token-a")
    });

    expect(response.statusCode).toBe(404);
    expect(response.json().error.code).toBe("PROJECT_NOT_FOUND");
    await app.close();
  });

  it("flags an edit as reviewable in the chat only once it has snapshots", async () => {
    mockAccessTokens({ "token-a": "user-a" });
    mockPrisma.project.findFirst.mockResolvedValue(projectRecord({ id: "project-1" }));
    state.bookEditOperations.push(appliedEditOperationRecord());
    const app = await buildMobileApp();

    const before = await app.inject({
      method: "GET",
      url: "/api/mobile/projects/project-1/chat",
      headers: bearer("token-a")
    });
    expect(before.json().operations[0]).toMatchObject({ changesAvailable: false });

    state.pageEditSnapshots.push({
      id: "snapshot-1",
      projectId: "project-1",
      pageId: "page-1",
      operationId: "operation-applied",
      pageIndex: 1,
      titleBefore: "Night Falls",
      markdownBefore: "Before.",
      summaryBefore: "",
      revisionBefore: 1,
      titleAfter: "Night Falls",
      markdownAfter: "After.",
      summaryAfter: "",
      revisionAfter: 2
    });
    const after = await app.inject({
      method: "GET",
      url: "/api/mobile/projects/project-1/chat",
      headers: bearer("token-a")
    });
    expect(after.json().operations[0]).toMatchObject({ changesAvailable: true });
    await app.close();
  });

  it("restores COMPLETE when the manual edit recompile cannot be queued", async () => {
    mockAccessTokens({ "token-a": "user-a" });
    mockPrisma.project.findFirst.mockResolvedValue(
      projectRecord({ id: "project-1", status: "COMPLETE", currentPlanId: "plan-1" })
    );
    state.pages = editablePages();
    writeProjectFile(state.bookStorageDir, "project-1", "book.pdf", "%PDF-stale");
    writeProjectFile(state.bookStorageDir, "project-1", "book.epub", "stale epub");
    mockPrisma.project.update.mockResolvedValue(projectRecord({ id: "project-1" }));
    vi.mocked(enqueueGenerationJob).mockRejectedValueOnce(new Error("queue offline"));
    const app = await buildMobileApp();

    const response = await app.inject({
      method: "POST",
      url: "/api/mobile/projects/project-1/manual-edits",
      headers: bearer("token-a"),
      payload: {
        pages: [
          { id: "page-1", title: "Rabbit Starts Fast", markdown: "New words entirely.", baseRevision: 1 }
        ]
      }
    });

    expect(response.statusCode).toBe(200);
    expect(mockPrisma.project.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: "project-1" },
      data: expect.objectContaining({ status: "EDITING" })
    }));
    expect(mockPrisma.project.updateMany).toHaveBeenCalledWith({
      where: { id: "project-1", status: "EDITING", contentRevision: 0 },
      data: { status: "COMPLETE" }
    });
    expect(existsSync(join(state.bookStorageDir!, "project-1", "book.pdf"))).toBe(false);
    expect(existsSync(join(state.bookStorageDir!, "project-1", "book.epub"))).toBe(false);
    await app.close();
  });

  it("updates the saved export message in place when the user edits it again", async () => {
    mockAccessTokens({ "token-a": "user-a" });
    mockPrisma.project.findFirst.mockResolvedValue(
      projectRecord({ id: "project-1", status: "COMPLETE", currentPlanId: "plan-1" })
    );
    state.pages = editablePages();
    state.projectChatMessages.push({
      id: "chat-saved-export",
      projectId: "project-1",
      parentId: null,
      role: "ASSISTANT",
      content: "You edited page 1 yourself in Edit Mode. The exports are refreshing with your changes.",
      operationId: "operation-old",
      metadata: {
        charged: false,
        manualEdit: { operationId: "operation-old", pageIndexes: [1], editCount: 1 }
      },
      isActiveChild: true,
      createdAt: new Date("2026-06-15T11:00:00.000Z")
    });
    const app = await buildMobileApp();

    const response = await app.inject({
      method: "POST",
      url: "/api/mobile/projects/project-1/manual-edits",
      headers: bearer("token-a"),
      payload: {
        savedExportMessageId: "chat-saved-export",
        pages: [
          { id: "page-2", title: "Rabbit Learns", markdown: "Rabbit cheers as Turtle crosses the line.", baseRevision: 1 }
        ]
      }
    });
    const body = response.json();

    expect(response.statusCode).toBe(200);
    expect(body.savedExportMessage.id).toBe("chat-saved-export");
    expect(body.savedExportMessage.metadata.manualEdit).toMatchObject({
      pageIndexes: [1, 2],
      editCount: 2
    });
    const savedExportMessages = state.projectChatMessages.filter((message) => message.metadata?.manualEdit);
    expect(savedExportMessages).toHaveLength(1);
    await app.close();
  });

  it("rejects manual edits when the book changed since the editor loaded", async () => {
    mockAccessTokens({ "token-a": "user-a" });
    mockPrisma.project.findFirst.mockResolvedValue(
      projectRecord({ id: "project-1", status: "COMPLETE", currentPlanId: "plan-1" })
    );
    state.pages = editablePages().map((page) => ({ ...page, revision: 3 }));
    const app = await buildMobileApp();

    const response = await app.inject({
      method: "POST",
      url: "/api/mobile/projects/project-1/manual-edits",
      headers: bearer("token-a"),
      payload: {
        pages: [{ id: "page-1", title: "Rabbit Starts Fast", markdown: "New words.", baseRevision: 1 }]
      }
    });

    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe("EDIT_CONFLICT");
    expect(mockPrisma.page.update).not.toHaveBeenCalled();
    await app.close();
  });

  it("blocks manual edits while other project work is running", async () => {
    mockAccessTokens({ "token-a": "user-a" });
    mockPrisma.project.findFirst.mockResolvedValue(
      projectRecord({ id: "project-1", status: "COMPLETE", currentPlanId: "plan-1" })
    );
    mockPrisma.generationJob.findMany.mockResolvedValueOnce([openJobRow()]);
    const app = await buildMobileApp();

    const response = await app.inject({
      method: "POST",
      url: "/api/mobile/projects/project-1/manual-edits",
      headers: bearer("token-a"),
      payload: {
        pages: [{ id: "page-1", title: "Rabbit Starts Fast", markdown: "New words.", baseRevision: 1 }]
      }
    });

    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe("PROJECT_BUSY");
    await app.close();
  });

  // The status read that drew this screen is what queued the repair, so
  // counting it would make looking at a book with a missing PDF the thing that
  // stops you editing it — on a project the app is showing as settled.
  it("saves a manual edit while an export repair rebuilds a missing file", async () => {
    mockAccessTokens({ "token-a": "user-a" });
    mockPrisma.project.findFirst.mockResolvedValue(
      projectRecord({ id: "project-1", status: "COMPLETE", currentPlanId: "plan-1" })
    );
    state.pages = editablePages();
    mockPrisma.generationJob.findMany.mockResolvedValueOnce([detachedRepairJobRow()]);
    const app = await buildMobileApp();

    const response = await app.inject({
      method: "POST",
      url: "/api/mobile/projects/project-1/manual-edits",
      headers: bearer("token-a"),
      payload: {
        pages: [
          {
            id: "page-1",
            title: "Rabbit Starts Fast",
            markdown: "Rabbit sprints ahead while Turtle takes one steady step.",
            baseRevision: 1
          }
        ]
      }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().operation).toMatchObject({ kind: "manual_edit", status: "applied" });
    await app.close();
  });

  it("rejects manual edit saves that change nothing", async () => {
    mockAccessTokens({ "token-a": "user-a" });
    mockPrisma.project.findFirst.mockResolvedValue(
      projectRecord({ id: "project-1", status: "COMPLETE", currentPlanId: "plan-1" })
    );
    state.pages = editablePages();
    const app = await buildMobileApp();

    const response = await app.inject({
      method: "POST",
      url: "/api/mobile/projects/project-1/manual-edits",
      headers: bearer("token-a"),
      payload: {
        pages: [
          {
            id: "page-1",
            title: "Rabbit Starts Fast",
            markdown: "Rabbit runs ahead at the start of the race.",
            baseRevision: 1
          }
        ]
      }
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe("NO_CHANGES");
    await app.close();
  });
});
