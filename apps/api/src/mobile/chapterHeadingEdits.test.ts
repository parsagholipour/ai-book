import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@book-maker/db", async () => (await import("./testing/mobileApiMocks.js")).dbModuleMock());
vi.mock("@book-maker/db/billing", async () => (await import("./testing/mobileApiMocks.js")).billingModuleMock());
vi.mock("../queue.js", async () => (await import("./testing/mobileApiMocks.js")).queueModuleMock());
vi.mock("../projectStatus.js", async () => (await import("./testing/mobileApiMocks.js")).projectStatusModuleMock());

import { reserveCredits } from "@book-maker/db/billing";

import { enqueueGenerationJob } from "../queue.js";
import {
  approvedPlanRecord,
  bearer,
  buildMobileApp,
  generatedPages,
  jobRecord,
  mockAccessTokens,
  mockPrisma,
  projectRecord,
  resetMobileHarness,
  teardownMobileHarness
} from "./testing/mobileApiHarness.js";

describe("mobile chapter heading edits", () => {
  beforeEach(resetMobileHarness);
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
        payload: expect.objectContaining({ planId: "plan-1", skipFinalReview: true })
      })
    );
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
