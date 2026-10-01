import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@book-maker/db", async () => (await import("./testing/mobileApiMocks.js")).dbModuleMock());
vi.mock("@book-maker/db/billing", async () => (await import("./testing/mobileApiMocks.js")).billingModuleMock());
vi.mock("../queue.js", async () => (await import("./testing/mobileApiMocks.js")).queueModuleMock());
vi.mock("../projectStatus.js", async () => (await import("./testing/mobileApiMocks.js")).projectStatusModuleMock());

import { allStoryPageDesigns, PRESENTATION_ONLY_RECOMPILE } from "@book-maker/core";
import { reserveCredits } from "@book-maker/db/billing";

import { dispatchGenerationJob, enqueueGenerationJob } from "../queue.js";
import {
  approvedPlanRecord,
  bearer,
  buildMobileApp,
  jobRecord,
  mockAccessTokens,
  mockPrisma,
  projectRecord,
  resetMobileHarness,
  state,
  teardownMobileHarness
} from "./testing/mobileApiHarness.js";

/** A finished five-page children's book printed one scene a sheet, with no pictures. */
function storyPages(markdown: (index: number) => string = (index) => `Rabbit hops along the path, scene ${index}.`) {
  return Array.from({ length: 5 }, (_, position) => ({
    id: `page-${position + 1}`,
    projectId: "project-1",
    index: position + 1,
    title: `Scene ${position + 1}`,
    summary: `Scene ${position + 1}.`,
    markdown: markdown(position + 1),
    status: "COMPLETED",
    revision: 1,
    chapter: { index: 1 }
  }));
}

function storyBook(overrides: Record<string, unknown> = {}) {
  return projectRecord({
    status: "COMPLETE",
    category: "KIDS",
    subcategory: "Picture Book",
    targetPages: 5,
    currentPlanId: "plan-1",
    currentPlan: approvedPlanRecord(),
    pages: storyPages(),
    ...overrides
  });
}

async function send(message: string) {
  const app = await buildMobileApp();
  const response = await app.inject({
    method: "POST",
    url: "/api/mobile/projects/project-1/chat/messages",
    headers: bearer("token-a"),
    payload: { message }
  });
  await app.close();
  return response;
}

/** The design the presentation write stored, if one was written. */
function writtenDesign(): unknown {
  const write = mockPrisma.project.update.mock.calls.find(
    (call: unknown[]) => (call[0] as { data?: { mediaSettings?: unknown } }).data?.mediaSettings
  );
  return (write?.[0] as { data: { mediaSettings: Record<string, unknown> } } | undefined)?.data.mediaSettings.storyPageDesign;
}

describe("mobile page design edits", () => {
  beforeEach(() => {
    resetMobileHarness();
    mockAccessTokens({ "token-a": "user-a" });
    state.pages = storyPages();
    mockPrisma.project.update.mockResolvedValue({
      contentRevision: 1,
      currentPlanId: "plan-1",
      mediaSettings: projectRecord().mediaSettings,
      status: "COMPLETE"
    });
  });
  afterEach(teardownMobileHarness);

  it("prints a picture book's pages in the design asked for, free, through the presentation recompile", async () => {
    mockPrisma.project.findFirst.mockResolvedValue(storyBook());
    vi.mocked(enqueueGenerationJob).mockResolvedValueOnce(jobRecord({ id: "job-compile", type: "COMPILE_EXPORT" }));

    const response = await send("Make the pages look like the night sky");
    const body = response.json();

    expect(response.statusCode).toBe(200);
    expect(body.operation).toBeNull();
    expect(body.reply.metadata).toMatchObject({ charged: false, pageDesign: { design: "night", applied: "night" } });
    expect(body.reply.metadata.editProposal).toBeUndefined();
    expect(body.reply.content).toContain("Night sky");
    expect(body.reply.content).toMatch(/free/i);
    expect(body.reply.content).not.toMatch(/\d+\s*credits?/i);
    expect(vi.mocked(reserveCredits)).not.toHaveBeenCalled();
    expect(writtenDesign()).toBe("night");
    expect(vi.mocked(enqueueGenerationJob)).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "COMPILE_EXPORT",
        payload: expect.objectContaining({ skipFinalReview: true, [PRESENTATION_ONLY_RECOMPILE]: true }),
        dispatch: false
      })
    );
    expect(vi.mocked(dispatchGenerationJob)).toHaveBeenCalledWith("job-compile");
  });

  it("answers a request for something different with a design the book does not wear yet", async () => {
    // A rabbit story with no choice of its own prints the garden meadow.
    mockPrisma.project.findFirst.mockResolvedValue(storyBook());
    vi.mocked(enqueueGenerationJob).mockResolvedValueOnce(jobRecord({ id: "job-compile", type: "COMPILE_EXPORT" }));

    const response = await send("change the design");
    const body = response.json();

    const design = writtenDesign();
    expect(response.statusCode).toBe(200);
    expect(allStoryPageDesigns().map((candidate) => candidate.id)).toContain(design);
    expect(design).not.toBe("meadow");
    expect(design).not.toBe("classic");
    expect(body.reply.content).toContain("Other designs:");
  });

  it("says so, and recompiles nothing, when the pages already wear that design", async () => {
    mockPrisma.project.findFirst.mockResolvedValue(
      storyBook({ mediaSettings: { ...projectRecord().mediaSettings, storyPageDesign: "ocean" } })
    );

    const body = (await send("use the ocean design")).json();

    expect(body.reply.content).toContain("already in the **Under the sea** design");
    expect(writtenDesign()).toBeUndefined();
    expect(vi.mocked(enqueueGenerationJob)).not.toHaveBeenCalled();
  });

  it("tells a book with pictures the truth instead of recompiling an identical book", async () => {
    state.pages = storyPages((index) => (index === 2 ? "![Rabbit](/assets/images/project-1/rabbit.png)\n\nRabbit waves." : "Rabbit hops."));
    mockPrisma.project.findFirst.mockResolvedValue(storyBook());

    const body = (await send("make the pages look like the night sky")).json();

    expect(body.reply.content).toContain("laid out around their pictures");
    expect(body.reply.content).toContain("Nothing was changed");
    expect(writtenDesign()).toBeUndefined();
    expect(vi.mocked(enqueueGenerationJob)).not.toHaveBeenCalled();
  });

  it("tells a book whose pages flow like a regular book's the same", async () => {
    // Twelve pages planned and two written: not the one-scene-a-sheet layout.
    mockPrisma.project.findFirst.mockResolvedValue(storyBook({ category: "BUSINESS", targetPages: 12 }));

    const body = (await send("make the pages look like the night sky")).json();

    expect(body.reply.content).toContain("flow like a regular book");
    expect(writtenDesign()).toBeUndefined();
    expect(vi.mocked(enqueueGenerationJob)).not.toHaveBeenCalled();
  });

  it("lists every design when asked which there are, and changes nothing", async () => {
    mockPrisma.project.findFirst.mockResolvedValue(storyBook());

    const body = (await send("What designs can I choose from?")).json();

    for (const design of allStoryPageDesigns()) {
      expect(body.reply.content).toContain(design.label);
    }
    expect(body.reply.content).toContain("**Garden meadow** (now)");
    expect(writtenDesign()).toBeUndefined();
    expect(vi.mocked(enqueueGenerationJob)).not.toHaveBeenCalled();
  });
});
