import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@book-maker/db", async () => (await import("./testing/mobileApiMocks.js")).dbModuleMock());
vi.mock("@book-maker/db/billing", async () => (await import("./testing/mobileApiMocks.js")).billingModuleMock());
vi.mock("../queue.js", async () => (await import("./testing/mobileApiMocks.js")).queueModuleMock());
vi.mock("../projectStatus.js", async () => (await import("./testing/mobileApiMocks.js")).projectStatusModuleMock());

import { PRESENTATION_ONLY_RECOMPILE } from "@book-maker/core";
import { reserveCredits } from "@book-maker/db/billing";

import { dispatchGenerationJob, enqueueGenerationJob } from "../queue.js";
import {
  approvedPlanRecord,
  bearer,
  buildMobileApp,
  generatedPages,
  jobRecord,
  mockAccessTokens,
  mockPrisma,
  openJobRow,
  projectRecord,
  resetMobileHarness,
  teardownMobileHarness
} from "./testing/mobileApiHarness.js";
import { mockTransactions } from "./testing/mobileApiMocks.js";

describe("mobile chapter heading edits", () => {
  beforeEach(() => {
    resetMobileHarness();
    mockPrisma.project.update.mockResolvedValue({
      contentRevision: 1,
      currentPlanId: "plan-1",
      mediaSettings: projectRecord().mediaSettings,
      status: "COMPLETE"
    });
  });
  afterEach(teardownMobileHarness);

  const completeProject = (mediaSettings?: Record<string, unknown>) =>
    projectRecord({
      id: "project-1",
      status: "COMPLETE",
      currentPlanId: "plan-1",
      currentPlan: approvedPlanRecord(),
      pages: generatedPages(),
      ...(mediaSettings ? { mediaSettings } : {})
    });

  it("restyles chapter headings as a free preference plus a recompile", async () => {
    mockAccessTokens({ "token-a": "user-a" });
    mockPrisma.project.findFirst.mockResolvedValue(completeProject());
    vi.mocked(enqueueGenerationJob).mockResolvedValueOnce(jobRecord({ id: "job-compile", type: "COMPILE_EXPORT" }));
    const app = await buildMobileApp();

    const response = await app.inject({
      method: "POST",
      url: "/api/mobile/projects/project-1/chat/messages",
      headers: bearer("token-a"),
      // The message that used to be quoted at 960 credits.
      payload: { message: 'I don\'t like that we have "Chapter x"\nWe should simply mention the Title' }
    });
    const body = response.json();

    expect(response.statusCode).toBe(200);
    // No proposal, no charge: the heading is built at export time, so nothing
    // is regenerated - only the export preference changes.
    expect(body.operation).toBeNull();
    expect(body.reply.metadata).toMatchObject({ charged: false, chapterHeading: { style: "title_only" } });
    expect(body.reply.metadata.editProposal).toBeUndefined();
    expect(body.reply.content).toMatch(/free/i);
    expect(vi.mocked(reserveCredits)).not.toHaveBeenCalled();
    expect(mockPrisma.project.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "project-1" },
        data: expect.objectContaining({
          mediaSettings: expect.objectContaining({ chapterHeadingStyle: "title_only", chapterHeadingLabel: null })
        })
      })
    );
    expect(vi.mocked(enqueueGenerationJob)).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: "project-1",
        type: "COMPILE_EXPORT",
        // skipFinalReview keeps a free edit from dragging a whole-book QA pass.
        // presentationOnly then stops the report it does write — deterministic
        // checks alone — standing in for the book's real QA verdict.
        payload: expect.objectContaining({
          planId: "plan-1",
          skipFinalReview: true,
          [PRESENTATION_ONLY_RECOMPILE]: true
        }),
        transaction: expect.anything(),
        dispatch: false
      })
    );
    expect(vi.mocked(dispatchGenerationJob)).toHaveBeenCalledWith("job-compile");
    expect(mockTransactions()).toHaveLength(1);
    expect(mockTransactions()[0]).toMatchObject({
      rolledBack: false,
      writes: [
        { model: "project", operation: "update", index: 0 },
        { model: "project", operation: "update", index: 1 }
      ]
    });
    await app.close();
  });

  it("saves the chapter-heading toggle behind an active ordinary book edit", async () => {
    mockAccessTokens({ "token-a": "user-a" });
    mockPrisma.project.findFirst.mockResolvedValue(completeProject());
    mockPrisma.generationJob.findMany.mockResolvedValueOnce([
      openJobRow({ operationId: "ordinary-edit", intentKind: "page_rewrite" })
    ]);
    mockPrisma.project.update.mockResolvedValueOnce({
      contentRevision: 8,
      currentPlanId: "plan-1",
      mediaSettings: projectRecord().mediaSettings,
      status: "EDITING"
    });
    const app = await buildMobileApp();

    const response = await app.inject({
      method: "POST",
      url: "/api/mobile/projects/project-1/chat/messages",
      headers: bearer("token-a"),
      payload: { message: 'Use only the title instead of "Chapter x"' }
    });
    const body = response.json();

    expect(response.statusCode).toBe(200);
    expect(body.operation).toBeNull();
    expect(body.reply.content).toContain("saved that request");
    expect(body.reply.content).toContain("I’ll run it");
    expect(body.reply.metadata).toMatchObject({
      blockedByActiveJob: true,
      pendingEdit: {
        request: 'Use only the title instead of "Chapter x"',
        clarification: "busy"
      }
    });
    expect(mockPrisma.project.update).not.toHaveBeenCalled();
    expect(vi.mocked(enqueueGenerationJob)).not.toHaveBeenCalled();
    await app.close();
  });

  it("commits the compile intent before dispatch, so a handoff crash is recoverable", async () => {
    mockAccessTokens({ "token-a": "user-a" });
    mockPrisma.project.findFirst.mockResolvedValue(completeProject());
    vi.mocked(enqueueGenerationJob).mockResolvedValueOnce(
      jobRecord({ id: "job-durable-compile", type: "COMPILE_EXPORT" })
    );
    vi.mocked(dispatchGenerationJob).mockRejectedValueOnce(new Error("process crashed before Redis handoff"));
    const app = await buildMobileApp();

    const response = await app.inject({
      method: "POST",
      url: "/api/mobile/projects/project-1/chat/messages",
      headers: bearer("token-a"),
      payload: { message: 'Use only the title instead of "Chapter x"' }
    });

    expect(response.statusCode).toBe(500);
    expect(mockTransactions()).toHaveLength(1);
    expect(mockTransactions()[0]!.rolledBack).toBe(false);
    expect(vi.mocked(enqueueGenerationJob)).toHaveBeenCalledWith(
      expect.objectContaining({
        transaction: expect.anything(),
        dispatch: false,
        dedupeKey: expect.stringContaining("revision-1:policy-r1v0seopc")
      })
    );
    expect(vi.mocked(enqueueGenerationJob).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(dispatchGenerationJob).mock.invocationCallOrder[0]!
    );
    await app.close();
  });

  it("rolls the preference back when its durable compile row cannot be written", async () => {
    mockAccessTokens({ "token-a": "user-a" });
    mockPrisma.project.findFirst.mockResolvedValue(completeProject());
    vi.mocked(enqueueGenerationJob).mockRejectedValueOnce(new Error("database unavailable"));
    const app = await buildMobileApp();

    const response = await app.inject({
      method: "POST",
      url: "/api/mobile/projects/project-1/chat/messages",
      headers: bearer("token-a"),
      payload: { message: 'Use only the title instead of "Chapter x"' }
    });

    expect(response.statusCode).toBe(500);
    expect(mockTransactions()).toHaveLength(1);
    expect(mockTransactions()[0]!.rolledBack).toBe(true);
    expect(vi.mocked(dispatchGenerationJob)).not.toHaveBeenCalled();
    await app.close();
  });

  it("says so instead of recompiling when the headings already read that way", async () => {
    mockAccessTokens({ "token-a": "user-a" });
    mockPrisma.project.findFirst.mockResolvedValue(completeProject({ chapterHeadingStyle: "title_only" }));
    const app = await buildMobileApp();

    const response = await app.inject({
      method: "POST",
      url: "/api/mobile/projects/project-1/chat/messages",
      headers: bearer("token-a"),
      payload: { message: 'I don\'t like that we have "Chapter x"\nWe should simply mention the Title' }
    });
    const body = response.json();

    expect(response.statusCode).toBe(200);
    expect(body.reply.content).toMatch(/already/i);
    expect(vi.mocked(enqueueGenerationJob)).not.toHaveBeenCalled();
    expect(vi.mocked(reserveCredits)).not.toHaveBeenCalled();
    await app.close();
  });
});
