import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@book-maker/db", async () => (await import("./testing/mobileApiMocks.js")).dbModuleMock());
vi.mock("@book-maker/db/billing", async () => (await import("./testing/mobileApiMocks.js")).billingModuleMock());
vi.mock("../queue.js", async () => (await import("./testing/mobileApiMocks.js")).queueModuleMock());
vi.mock("../projectStatus.js", async () => (await import("./testing/mobileApiMocks.js")).projectStatusModuleMock());

import { enqueueGenerationJob } from "../queue.js";
import { bookEditCreditCost } from "./bookEditPricing.js";
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

type ProjectFixture = ReturnType<typeof projectRecord>;

function pages(count: number) {
  return Array.from({ length: count }, (_value, offset) => ({
    id: `page-${offset + 1}`,
    index: offset + 1,
    title: `Page ${offset + 1}`,
    markdown: `Mina crosses checkpoint ${offset + 1}.`,
    summary: `Checkpoint ${offset + 1}.`,
    imagePrompt: null,
    status: "COMPLETED"
  }));
}

function completeProject(pageCount: number, overrides: Record<string, unknown> = {}): ProjectFixture {
  return projectRecord({
    id: "project-1",
    status: "COMPLETE",
    currentPlanId: "plan-1",
    currentPlan: approvedPlanRecord(),
    pages: pages(pageCount),
    ...overrides
  });
}

/** Model page 1 is printed page 2 once the cover and contents are counted. */
function shiftedPrintedMap(pageCount: number, contentRevision: number) {
  return {
    version: 2,
    totalPdfPages: pageCount + 2,
    hasCoverPage: true,
    contentsStartPdfPage: 2,
    pages: Array.from({ length: pageCount }, (_value, offset) => ({
      index: offset + 1,
      startPdfPage: offset + 3,
      endPdfPage: offset + 3
    })),
    contentRevision
  };
}

function mediaSettingsAtTier(tier: "fast" | "premium") {
  return {
    fullIllustrations: true,
    illustrationCadence: "template-driven",
    includeCover: true,
    coverTemplate: "business",
    finalReview: true,
    toneProfile: "neutral",
    modelTier: tier,
    mobile: {
      bookType: "lead_magnet",
      lengthPreset: "short",
      qualityPreset: tier,
      imagesEnabled: true
    }
  };
}

describe("structural Apply after the manuscript changes", () => {
  beforeEach(resetMobileHarness);
  afterEach(teardownMobileHarness);

  const send = async (app: Awaited<ReturnType<typeof buildMobileApp>>, message: string) =>
    app.inject({
      method: "POST",
      url: "/api/mobile/projects/project-1/chat/messages",
      headers: bearer("token-a"),
      payload: { message }
    });

  function serveLiveProject(initial: ProjectFixture) {
    let live = initial;
    mockPrisma.project.findFirst.mockImplementation(async () => live as never);
    return (next: ProjectFixture) => {
      live = next;
    };
  }

  it("re-proposes a same-cost printed-page coordinate change and queues only after the second approval", async () => {
    mockAccessTokens({ "token-a": "user-a" });
    const replaceLiveProject = serveLiveProject(completeProject(2));
    vi.mocked(enqueueGenerationJob).mockResolvedValue(jobRecord({ id: "job-1", type: "APPLY_BOOK_EDIT" }));
    const app = await buildMobileApp();

    const proposed = await send(app, "Add a page after page 1.");
    const firstProposal = proposed.json().reply.metadata.editProposal;
    expect(firstProposal.summary).toBe("Add 1 new page after page 1");

    replaceLiveProject(
      completeProject(2, {
        contentRevision: 8,
        pdfPageMap: shiftedPrintedMap(2, 8)
      })
    );
    const firstApply = await send(app, "apply it");
    const refreshed = firstApply.json().reply.metadata.editProposal;

    expect(firstApply.json().operation).toBeNull();
    expect(refreshed).toMatchObject({
      kind: "restructure_pages",
      credits: firstProposal.credits,
      summary: "Add 1 new page after page 2",
      structural: { placement: "after", afterReaderPage: 2 }
    });
    expect(firstApply.json().reply.metadata.pendingEdit).toMatchObject({
      clarification: "confirm",
      intent: { editInstruction: "Add 1 new page after page 2" }
    });
    expect(state.bookEditOperations).toHaveLength(0);
    expect(vi.mocked(enqueueGenerationJob)).not.toHaveBeenCalled();

    const secondApply = await send(app, "apply it");
    expect(secondApply.json().operation).toMatchObject({ kind: "restructure_pages" });
    expect(state.bookEditOperations).toHaveLength(1);
    expect(state.bookEditOperations[0]?.editInstruction).toBe("Add 1 new page after page 2");
    expect(vi.mocked(enqueueGenerationJob)).toHaveBeenCalledTimes(1);
    const payload = vi.mocked(enqueueGenerationJob).mock.calls[0]?.[0].payload as Record<string, unknown>;
    expect(payload.editInstruction).toBe("Add 1 new page after page 2");
    await app.close();
  });

  it("re-proposes a changed coordinate even when the live quote is lower", async () => {
    mockAccessTokens({ "token-a": "user-a" });
    const premium = completeProject(2, { mediaSettings: mediaSettingsAtTier("premium") });
    const replaceLiveProject = serveLiveProject(premium);
    const app = await buildMobileApp();

    const proposed = await send(app, "Add a page after page 1.");
    const quoted = proposed.json().reply.metadata.editProposal.credits as number;

    const fast = completeProject(2, {
      contentRevision: 9,
      pdfPageMap: shiftedPrintedMap(2, 9),
      mediaSettings: mediaSettingsAtTier("fast")
    });
    replaceLiveProject(fast);
    const firstApply = await send(app, "apply it");
    const refreshed = firstApply.json().reply.metadata.editProposal;

    expect(refreshed.summary).toBe("Add 1 new page after page 2");
    expect(refreshed.credits).toBe(bookEditCreditCost("restructure_pages", 1, fast as never));
    expect(refreshed.credits).toBeLessThan(quoted);
    expect(firstApply.json().operation).toBeNull();
    expect(vi.mocked(enqueueGenerationJob)).not.toHaveBeenCalled();
    await app.close();
  });

  it("re-proposes when a formerly clamped placement moves as the book grows", async () => {
    mockAccessTokens({ "token-a": "user-a" });
    const replaceLiveProject = serveLiveProject(completeProject(2));
    const app = await buildMobileApp();

    const proposed = await send(app, "Add a page after page 100.");
    expect(proposed.json().reply.metadata.editProposal.summary).toBe("Add 1 new page after page 2");

    replaceLiveProject(completeProject(3));
    const firstApply = await send(app, "apply it");

    expect(firstApply.json().operation).toBeNull();
    expect(firstApply.json().reply.metadata.editProposal).toMatchObject({
      summary: "Add 1 new page after page 3",
      structural: { placement: "after", afterReaderPage: 3, totalPages: 4 }
    });
    expect(vi.mocked(enqueueGenerationJob)).not.toHaveBeenCalled();
    await app.close();
  });

  it("re-proposes when deleting the approved anchor makes the live resolver clamp it", async () => {
    mockAccessTokens({ "token-a": "user-a" });
    const replaceLiveProject = serveLiveProject(completeProject(3));
    const app = await buildMobileApp();

    const proposed = await send(app, "Add a page after page 3.");
    expect(proposed.json().reply.metadata.editProposal.summary).toBe("Add 1 new page after page 3");

    replaceLiveProject(completeProject(2));
    const firstApply = await send(app, "apply it");

    expect(firstApply.json().operation).toBeNull();
    expect(firstApply.json().reply.metadata.editProposal.summary).toBe("Add 1 new page after page 2");
    expect(vi.mocked(enqueueGenerationJob)).not.toHaveBeenCalled();
    await app.close();
  });

  it("keeps the approved content clause while re-proposing the changed coordinate", async () => {
    mockAccessTokens({ "token-a": "user-a" });
    const replaceLiveProject = serveLiveProject(completeProject(2));
    const app = await buildMobileApp();

    const proposed = await send(
      app,
      "Add a page after page 100 about Mina finding the brass compass, keeping the tone suspenseful."
    );
    const approved = proposed.json().reply.metadata.intent.editInstruction as string;
    expect(approved).toContain("after page 2");
    expect(approved).toContain("Mina finding the brass compass");

    replaceLiveProject(completeProject(3));
    const firstApply = await send(app, "apply it");
    const refreshed = firstApply.json().reply.metadata.intent.editInstruction as string;

    expect(firstApply.json().operation).toBeNull();
    expect(refreshed).toContain("after page 3");
    expect(refreshed).toContain("Mina finding the brass compass");
    expect(refreshed.replace("after page 3", "after page 2")).toBe(approved);
    expect(vi.mocked(enqueueGenerationJob)).not.toHaveBeenCalled();
    await app.close();
  });

  it("executes without another proposal when live re-resolution leaves the canonical instruction identical", async () => {
    mockAccessTokens({ "token-a": "user-a" });
    const replaceLiveProject = serveLiveProject(completeProject(2));
    vi.mocked(enqueueGenerationJob).mockResolvedValue(jobRecord({ id: "job-1", type: "APPLY_BOOK_EDIT" }));
    const app = await buildMobileApp();

    const proposed = await send(app, "Add a page after page 1.");
    const approved = proposed.json().reply.metadata.intent.editInstruction;

    // The plan's total page count changes, but page 1 remains the same anchor
    // and therefore the approved canonical instruction is still exact.
    replaceLiveProject(completeProject(3));
    const applied = await send(app, "apply it");

    expect(applied.json().operation).not.toBeNull();
    expect(state.bookEditOperations[0]?.editInstruction).toBe(approved);
    expect(applied.json().reply.metadata.editProposal).toBeUndefined();
    expect(vi.mocked(enqueueGenerationJob)).toHaveBeenCalledTimes(1);
    await app.close();
  });
});
