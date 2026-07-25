import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@book-maker/db", async () => (await import("./testing/mobileApiMocks.js")).dbModuleMock());
vi.mock("@book-maker/db/billing", async () => (await import("./testing/mobileApiMocks.js")).billingModuleMock());
vi.mock("../queue.js", async () => (await import("./testing/mobileApiMocks.js")).queueModuleMock());
vi.mock("../projectStatus.js", async () => (await import("./testing/mobileApiMocks.js")).projectStatusModuleMock());

import { enqueueGenerationJob } from "../queue.js";
import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  bearer,
  buildMobileApp,
  editablePages,
  jobRecord,
  mockAccessTokens,
  mockPrisma,
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
    expect(mockPrisma.project.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: "project-1" },
      data: expect.objectContaining({ status: "EDITING" })
    }));
    expect(mockPrisma.project.update).not.toHaveBeenCalledWith({
      where: { id: "project-1" },
      data: { status: "COMPLETE" }
    });
    await app.close();
  });

  it("restores COMPLETE when the manual edit recompile cannot be queued", async () => {
    mockAccessTokens({ "token-a": "user-a" });
    mockPrisma.project.findFirst.mockResolvedValue(
      projectRecord({ id: "project-1", status: "COMPLETE", currentPlanId: "plan-1" })
    );
    state.pages = editablePages();
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
    expect(mockPrisma.project.update).toHaveBeenCalledWith({
      where: { id: "project-1" },
      data: { status: "COMPLETE" }
    });
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
    mockPrisma.generationJob.count.mockResolvedValueOnce(1);
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
