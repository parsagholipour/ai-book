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

describe("mobile back matter edits", () => {
  beforeEach(resetMobileHarness);
  afterEach(teardownMobileHarness);

  it("removes the compiled sources list as a free preference plus a recompile", async () => {
    mockAccessTokens({ "token-a": "user-a" });
    mockPrisma.project.findFirst.mockResolvedValue(
      projectRecord({
        id: "project-1",
        status: "COMPLETE",
        currentPlanId: "plan-1",
        currentPlan: approvedPlanRecord(),
        pages: generatedPages(),
        research: [{ title: "Sleep research", url: "https://example.com/sleep", summary: "Background." }]
      })
    );
    vi.mocked(enqueueGenerationJob).mockResolvedValueOnce(jobRecord({ id: "job-compile", type: "COMPILE_EXPORT" }));
    const app = await buildMobileApp();

    const response = await app.inject({
      method: "POST",
      url: "/api/mobile/projects/project-1/chat/messages",
      headers: bearer("token-a"),
      payload: { message: "Remove the sources at the end of the book" }
    });
    const body = response.json();

    expect(response.statusCode).toBe(200);
    // No proposal, no charge: the section is not page text, so nothing is
    // regenerated - only the export preference changes.
    expect(body.operation).toBeNull();
    expect(body.reply.metadata).toMatchObject({ charged: false, backMatter: { includeSources: false } });
    expect(body.reply.metadata.editProposal).toBeUndefined();
    expect(body.reply.content).toMatch(/removed the sources list/i);
    expect(vi.mocked(reserveCredits)).not.toHaveBeenCalled();
    expect(mockPrisma.project.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "project-1" },
        data: expect.objectContaining({
          mediaSettings: expect.objectContaining({ includeSources: false })
        })
      })
    );
    expect(vi.mocked(enqueueGenerationJob)).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: "project-1",
        type: "COMPILE_EXPORT",
        payload: expect.objectContaining({ planId: "plan-1", skipFinalReview: true })
      })
    );
    await app.close();
  });

  it("says so instead of recompiling when the book has no sources list", async () => {
    mockAccessTokens({ "token-a": "user-a" });
    mockPrisma.project.findFirst.mockResolvedValue(
      projectRecord({
        id: "project-1",
        status: "COMPLETE",
        currentPlanId: "plan-1",
        currentPlan: approvedPlanRecord(),
        pages: generatedPages(),
        research: []
      })
    );
    const app = await buildMobileApp();

    const response = await app.inject({
      method: "POST",
      url: "/api/mobile/projects/project-1/chat/messages",
      headers: bearer("token-a"),
      payload: { message: "Remove the sources at the end of the book" }
    });
    const body = response.json();

    expect(response.statusCode).toBe(200);
    expect(body.reply.content).toMatch(/doesn’t have a sources list/i);
    expect(vi.mocked(enqueueGenerationJob)).not.toHaveBeenCalled();
    expect(vi.mocked(reserveCredits)).not.toHaveBeenCalled();
    await app.close();
  });
});
